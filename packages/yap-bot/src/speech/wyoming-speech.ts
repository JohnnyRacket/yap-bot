// Speech from a Wyoming server (wyoming-piper and the like, as Home Assistant uses). The server says
// its sample rate per reply, so the audio is resampled to the protocol's rate here. Wyoming has no
// speed setting: the voice's speed is set on the server (piper's --length-scale).
import { TTS_SAMPLE_RATE } from "../protocol.ts";
import { WyomingClient } from "../engines/wyoming.ts";
import type { SynthesizeOptions, TtsEngine } from "../engines/types.ts";
import { pcmResampler } from "./tts.ts";

export interface WyomingSpeechOptions {
  host: string;
  port: number;
  /** The server's voice name (e.g. en_US-lessac-medium); default: the voice's tts.voice. */
  voice?: string;
  /** For voices with several speakers. */
  speaker?: string;
  timeoutMs: number;
}

export class WyomingSpeech implements TtsEngine {
  readonly name: string;
  readonly ready = Promise.resolve();
  readonly sampleRate = TTS_SAMPLE_RATE;
  private o: WyomingSpeechOptions;

  constructor(o: WyomingSpeechOptions) {
    this.o = o;
    this.name = `wyoming tts (${o.host}:${o.port})`;
  }

  async synthesize(text: string, so: SynthesizeOptions): Promise<number> {
    const client = new WyomingClient(this.o.host, this.o.port);
    const stop = () => client.close();
    so.signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, this.o.timeoutMs);
    try {
      const voice: Record<string, string> = { name: this.o.voice ?? so.voice };
      if (this.o.speaker) voice.speaker = this.o.speaker;
      client.send("synthesize", { text, voice });
      let resample: ((pcm: Uint8Array) => Uint8Array) | null = null;
      let channels = 1;
      let bytes = 0;
      for (;;) {
        const e = await client.next();
        so.signal?.throwIfAborted();
        if (!e) throw client.error ?? new Error(`${this.name}: closed before the audio ended`);
        if (e.type === "error") throw new Error(`${this.name}: ${e.data.text ?? "error"}`);
        if (e.type === "audio-start") {
          if (e.data.width !== 2) throw new Error(`${this.name}: ${e.data.width * 8}-bit audio isn't supported`);
          channels = e.data.channels ?? 1;
          resample = pcmResampler(e.data.rate, TTS_SAMPLE_RATE);
        } else if (e.type === "audio-chunk" && e.payload) {
          resample ??= pcmResampler(e.data.rate ?? 22050, TTS_SAMPLE_RATE);
          const out = resample(channels === 1 ? e.payload : firstChannel(e.payload, channels));
          if (out.byteLength) {
            bytes += out.byteLength;
            so.onAudio(out);
          }
        } else if (e.type === "audio-stop") break;
      }
      return Math.round((bytes / 2 / TTS_SAMPLE_RATE) * 1000);
    } finally {
      clearTimeout(timer);
      so.signal?.removeEventListener("abort", stop);
      client.close();
    }
  }
}

function firstChannel(pcm: Uint8Array, channels: number): Uint8Array {
  const all = new Int16Array(pcm.slice().buffer);
  const out = new Int16Array(Math.floor(all.length / channels));
  for (let i = 0; i < out.length; i++) out[i] = all[i * channels];
  return new Uint8Array(out.buffer);
}
