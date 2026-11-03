// Mic capture (→ 16 kHz PCM) and speech playback (24 kHz PCM chunks, with progress reports),
// both on AudioWorklets in one AudioContext.
import { MIC_SAMPLE_RATE, TTS_SAMPLE_RATE } from "yap-bot/protocol";

const worklets = /* js */ `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.on = true; this.port.onmessage = (e) => { this.on = e.data.on; }; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && this.on) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("capture", Capture);

// Plays queued chunks back to back; reports progress per chunk.
class Player extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = []; // { id, bufs: Float32Array[], off, ended, played }
    this.sinceReport = 0;
    this.paused = false;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "audio") {
        let c = this.chunks.find((x) => x.id === m.id);
        if (!c) { c = { id: m.id, bufs: [], off: 0, ended: false, played: 0 }; this.chunks.push(c); }
        c.bufs.push(m.samples);
      } else if (m.type === "end") {
        const c = this.chunks.find((x) => x.id === m.id);
        if (c) c.ended = true; else this.chunks.push({ id: m.id, bufs: [], off: 0, ended: true, played: 0 });
      } else if (m.type === "flush") {
        this.chunks = [];
        this.paused = false;
      } else if (m.type === "pause") {
        this.paused = true;
      } else if (m.type === "resume") {
        this.paused = false;
      }
    };
  }
  report(c, done) {
    this.port.postMessage({ type: "progress", id: c.id, playedMs: Math.round((c.played / sampleRate) * 1000), done });
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    let i = 0;
    while (!this.paused && i < out.length && this.chunks.length) {
      const c = this.chunks[0];
      const buf = c.bufs[0];
      if (!buf) {
        if (c.ended) { this.report(c, true); this.chunks.shift(); continue; }
        break; // waiting for more audio
      }
      const n = Math.min(out.length - i, buf.length - c.off);
      out.set(buf.subarray(c.off, c.off + n), i);
      i += n; c.off += n; c.played += n; this.sinceReport += n;
      if (c.off >= buf.length) { c.bufs.shift(); c.off = 0; }
    }
    for (; i < out.length; i++) out[i] = 0;
    for (let k = 1; k < outputs[0].length; k++) outputs[0][k].set(out);
    if (this.chunks.length && this.sinceReport >= sampleRate / 10) { this.sinceReport = 0; this.report(this.chunks[0], false); }
    return true;
  }
}
registerProcessor("player", Player);
`;

/** Streaming linear resampler that carries its position across blocks. */
class Resampler {
  private carry = new Float32Array(0);
  private pos = 0;
  private ratio: number;
  constructor(from: number, to: number) {
    this.ratio = from / to;
  }
  push(input: Float32Array): Float32Array {
    const buf = new Float32Array(this.carry.length + input.length);
    buf.set(this.carry);
    buf.set(input, this.carry.length);
    const out: number[] = [];
    let pos = this.pos;
    // average over the step when downsampling (cheap anti-aliasing), interpolate when upsampling
    const win = Math.max(1, Math.floor(this.ratio));
    while (pos + win < buf.length) {
      const j = Math.floor(pos);
      if (win > 1) {
        let s = 0;
        for (let k = 0; k < win; k++) s += buf[j + k];
        out.push(s / win);
      } else {
        const f = pos - j;
        out.push(buf[j] * (1 - f) + buf[j + 1] * f);
      }
      pos += this.ratio;
    }
    const keep = Math.floor(pos);
    this.carry = buf.slice(keep);
    this.pos = pos - keep;
    return Float32Array.from(out);
  }
}

export class Audio {
  ctx!: AudioContext;
  private capture?: AudioWorkletNode;
  private player!: AudioWorkletNode;
  private stream?: MediaStream;
  private micResampler?: Resampler;
  private ttsResamplers = new Map<number, Resampler>();
  private pending: number[] = [];
  private outEl = new window.Audio();
  onMic?: (pcm: Int16Array) => void;
  onLevel?: (peak: number) => void;
  onProgress?: (chunkId: number, playedMs: number, done: boolean) => void;

  async init() {
    if (this.ctx) return;
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    await this.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([worklets], { type: "text/javascript" })));
    this.player = new AudioWorkletNode(this.ctx, "player", { numberOfInputs: 0, outputChannelCount: [1] });
    this.player.port.onmessage = (e) => {
      if (e.data.type === "progress") this.onProgress?.(e.data.id, e.data.playedMs, e.data.done);
    };
    // Played through an <audio> element so the browser's echo canceller knows what we're playing.
    const dest = this.ctx.createMediaStreamDestination();
    this.player.connect(dest);
    this.outEl.srcObject = dest.stream;
    await this.outEl.play().catch(() => {});
  }

  async startMic(echoCancellation: boolean) {
    await this.init();
    await this.ctx.resume();
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation, noiseSuppression: true, autoGainControl: true },
    });
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.capture = new AudioWorkletNode(this.ctx, "capture");
    this.micResampler = new Resampler(this.ctx.sampleRate, MIC_SAMPLE_RATE);
    this.capture.port.onmessage = (e) => this.onCapture(e.data as Float32Array);
    src.connect(this.capture);
  }

  stopMic() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.capture?.disconnect();
    this.capture = undefined;
    this.onLevel?.(0);
  }

  get micOn() {
    return !!this.stream;
  }

  private onCapture(block: Float32Array) {
    let peak = 0;
    for (const v of block) peak = Math.max(peak, Math.abs(v));
    this.onLevel?.(peak);
    for (const v of this.micResampler!.push(block)) this.pending.push(v);
    if (this.pending.length >= MIC_SAMPLE_RATE / 25) {
      // ~40 ms per message
      const pcm = new Int16Array(this.pending.length);
      for (let i = 0; i < pcm.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(this.pending[i] * 32767)));
      this.pending = [];
      this.onMic?.(pcm);
    }
  }

  /** Speech that came before the page could play sound (a browser needs a tap first), played after it. */
  private held: { chunkId: number; pcm?: Int16Array }[] = [];
  /** Something arrived to play, but the page can't make sound yet: ask for a tap. */
  onNeedsTap?: () => void;

  get ready() {
    return !!this.player;
  }

  /** After the tap: whatever was held plays now. */
  async unlock() {
    await this.init();
    await this.ctx.resume();
    const held = this.held;
    this.held = [];
    for (const h of held) (h.pcm ? this.play(h.chunkId, h.pcm) : this.endChunk(h.chunkId));
  }

  /** Synchronous so audio and the chunk's end marker reach the worklet in order. Needs init() first (a click). */
  play(chunkId: number, pcm: Int16Array) {
    if (!this.player) {
      // up to a minute of it (24 kHz)
      if (this.held.reduce((n, h) => n + (h.pcm?.length ?? 0), 0) < 24000 * 60) this.held.push({ chunkId, pcm });
      this.onNeedsTap?.();
      return;
    }
    if (this.ctx.state !== "running") void this.ctx.resume();
    let r = this.ttsResamplers.get(chunkId);
    if (!r) {
      r = new Resampler(TTS_SAMPLE_RATE, this.ctx.sampleRate);
      this.ttsResamplers.set(chunkId, r);
    }
    const f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
    const samples = r.push(f);
    this.player.port.postMessage({ type: "audio", id: chunkId, samples }, [samples.buffer]);
  }

  endChunk(chunkId: number) {
    if (!this.player) return void this.held.push({ chunkId });
    this.ttsResamplers.delete(chunkId);
    this.player?.port.postMessage({ type: "end", id: chunkId });
  }

  flush() {
    this.held = [];
    this.ttsResamplers.clear();
    this.player?.port.postMessage({ type: "flush" });
  }

  pause(paused: boolean) {
    this.player?.port.postMessage({ type: paused ? "pause" : "resume" });
  }
}
