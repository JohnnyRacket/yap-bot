// A headless device for tests and scripts: connects, sends text or audio, "plays" received speech
// in real time (reports playback like a real client), and collects every event.
import WebSocket from "ws";
import { decodeBinary, encodeMic, TTS_SAMPLE_RATE, type ClientMessage, type ListenMode, type ServerMessage } from "../protocol.ts";
import { KokoroLocal } from "../speech/kokoro.ts";
import { defaultModelsDir } from "../start.ts";

export interface Event {
  at: number;
  msg: ServerMessage;
}

export class TestClient {
  ws!: WebSocket;
  events: Event[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void; reject: (e: Error) => void }[] = [];
  /** Why the server closed the connection, once it has. */
  closed?: string;
  /** chunkId → samples received, and the playback clock */
  private chunks = new Map<number, { samples: number; ended: boolean; durationMs?: number }>();
  private order: number[] = [];
  private playTimer?: NodeJS.Timeout;
  private playing: { id: number; startedAt: number } | null = null;
  private paused = false;
  onEvent?: (e: Event) => void;

  async connect(url: string, deviceId: string, mode: ListenMode, room = "test") {
    this.ws = new WebSocket(url, { rejectUnauthorized: false });
    await new Promise((res, rej) => {
      this.ws.once("open", res);
      this.ws.once("error", rej);
    });
    // a refusal (wrong device token) or a server going away fails what's waiting at once, with why
    this.ws.on("close", (code, reason) => {
      this.closed = reason.toString() || `closed (${code})`;
      for (const w of this.waiters.splice(0)) w.reject(new Error(`the server closed the connection: ${this.closed}`));
    });
    this.ws.on("message", (data: Buffer, isBinary) => {
      if (isBinary) {
        const b = decodeBinary(data);
        if (b?.kind === "tts") this.onAudio(b.chunkId, b.pcm.length);
        return;
      }
      const msg = JSON.parse(data.toString()) as ServerMessage;
      const e = { at: Date.now(), msg };
      this.events.push(e);
      this.onEvent?.(e);
      if (msg.type === "tts_end") {
        const c = this.chunks.get(msg.chunkId);
        if (c) {
          c.ended = true;
          c.durationMs = msg.durationMs;
        }
      }
      if (msg.type === "stop") this.stopPlayback();
      if (msg.type === "pause") this.paused = true;
      if (msg.type === "resume") this.paused = false;
      for (const w of [...this.waiters]) if (w.pred(msg)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    });
    this.send({ type: "hello", deviceId, room, mode });
    await this.waitFor((m) => m.type === "welcome");
  }

  send(msg: ClientMessage) {
    this.ws.send(JSON.stringify(msg));
  }

  sendAudio(pcm16k: Int16Array) {
    this.ws.send(encodeMic(pcm16k));
  }

  waitFor(pred: (m: ServerMessage) => boolean, timeoutMs = 60_000): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      if (this.closed !== undefined) return reject(new Error(`the server closed the connection: ${this.closed}`));
      const t = setTimeout(() => reject(new Error("timed out waiting")), timeoutMs);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)), reject: (e) => (clearTimeout(t), reject(e)) });
    });
  }

  private onAudio(chunkId: number, samples: number) {
    let c = this.chunks.get(chunkId);
    if (!c) {
      c = { samples: 0, ended: false };
      this.chunks.set(chunkId, c);
      this.order.push(chunkId);
    }
    c.samples += samples;
    if (!this.playing) this.playNext();
  }

  // plays chunks back to back on a wall clock, reporting progress like a real speaker would
  private playNext() {
    const id = this.order.shift();
    if (id === undefined) return void (this.playing = null);
    this.playing = { id, startedAt: Date.now() };
    const tick = () => {
      if (this.paused) {
        this.playing!.startedAt += 100; // hold the playback clock
        this.playTimer = setTimeout(tick, 100);
        return;
      }
      const c = this.chunks.get(id)!;
      const playedMs = Date.now() - this.playing!.startedAt;
      const totalMs = (c.samples / TTS_SAMPLE_RATE) * 1000;
      if (c.ended && playedMs >= totalMs) {
        this.send({ type: "playback", chunkId: id, playedMs: Math.round(totalMs), done: true });
        return this.playNext();
      }
      this.send({ type: "playback", chunkId: id, playedMs: Math.round(Math.min(playedMs, totalMs)), done: false });
      this.playTimer = setTimeout(tick, 100);
    };
    tick();
  }

  private stopPlayback() {
    clearTimeout(this.playTimer);
    this.playing = null;
    this.order = [];
  }

  close() {
    clearTimeout(this.playTimer);
    this.ws.close();
  }
}

let kokoro: KokoroLocal | null = null;

/** Speech for tests, from Kokoro in process (its models must be downloaded), resampled to 16 kHz. Speed 1.0. */
export async function speech(text: string, voice = "am_michael"): Promise<Int16Array> {
  if (!kokoro) {
    kokoro = new KokoroLocal(defaultModelsDir(), 2, voice);
    kokoro.worker.unref();
  }
  // referenced only while working, so a finished script can still exit
  kokoro.worker.ref();
  const parts: Uint8Array[] = [];
  try {
    await kokoro.ready;
    await kokoro.synthesize(text, { voice, speed: 1, onAudio: (p) => parts.push(p.slice()) });
  } finally {
    kokoro.worker.unref();
  }
  const b = new Int16Array(Buffer.concat(parts).buffer.slice(0));
  const out = new Int16Array(Math.floor((b.length * 2) / 3));
  for (let i = 0; i < out.length; i++) {
    const p = i * 1.5;
    const j = Math.floor(p);
    out[i] = Math.round(b[j] * (1 - (p - j)) + (b[j + 1] ?? 0) * (p - j));
  }
  return out;
}

/** Streams audio in real time, 20 ms frames. */
export async function streamAudio(c: TestClient, pcm: Int16Array) {
  const frame = 320;
  const t0 = performance.now();
  for (let i = 0; i < pcm.length; i += frame) {
    const wait = t0 + ((i + frame) / 16000) * 1000 - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    c.sendAudio(pcm.subarray(i, i + frame));
  }
}

/** A readable timeline: each mark relative to when the user stopped talking. */
export function formatMarks(marks: { name: string; at: number; detail?: string }[]): string {
  const base = marks.find((m) => m.name === "speech_end")?.at ?? marks[0]?.at ?? 0;
  return marks
    .slice()
    .sort((a, b) => a.at - b.at)
    .map((m) => `${m.name}=${((m.at - base) / 1000).toFixed(2)}s${m.detail ? `(${m.detail})` : ""}`)
    .join("  ");
}
