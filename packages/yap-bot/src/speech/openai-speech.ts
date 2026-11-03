// Any OpenAI-compatible speech endpoint that can stream raw PCM: Kokoro-FastAPI, OpenAI itself,
// and most local TTS servers that copy its API.
import type { SynthesizeOptions, TtsEngine } from "../engines/types.ts";

export interface OpenAiSpeechOptions {
  /** e.g. http://localhost:8880/v1 (Kokoro-FastAPI) or https://api.openai.com/v1 */
  baseUrl: string;
  /** Sent as "model": "kokoro" for Kokoro-FastAPI, "gpt-4o-mini-tts" for OpenAI. */
  model: string;
  apiKey?: string;
  /** The PCM it returns: 24000 for Kokoro-FastAPI and OpenAI. */
  sampleRate: number;
  /** Merged into the request body. */
  extraBody?: Record<string, unknown>;
  /** Give up after this long without audio (default 30 s). */
  timeoutMs?: number;
}

export class OpenAiSpeech implements TtsEngine {
  readonly name: string;
  readonly ready = Promise.resolve();
  readonly sampleRate: number;
  private o: OpenAiSpeechOptions;

  constructor(o: OpenAiSpeechOptions) {
    this.o = o;
    this.sampleRate = o.sampleRate;
    this.name = `${o.model} (${o.baseUrl})`;
  }

  /** Streams the speech; resolves with its length in ms. */
  async synthesize(text: string, o: SynthesizeOptions): Promise<number> {
    // a server that stops sending mustn't hold the turn: the timer restarts with every piece
    const stalled = new AbortController();
    const ms = this.o.timeoutMs ?? 30_000;
    let timer = setTimeout(() => stalled.abort(new Error(`no audio for ${ms / 1000} s`)), ms);
    const alive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stalled.abort(new Error(`no audio for ${ms / 1000} s`)), ms);
    };
    try {
      return await this.stream(text, o, o.signal ? AbortSignal.any([o.signal, stalled.signal]) : stalled.signal, alive);
    } catch (e) {
      if (stalled.signal.aborted && !o.signal?.aborted) throw new Error(`${this.name}: ${(stalled.signal.reason as Error).message}`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private async stream(text: string, o: SynthesizeOptions, signal: AbortSignal, alive: () => void): Promise<number> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.o.apiKey) headers.Authorization = `Bearer ${this.o.apiKey}`;
    const res = await fetch(`${this.o.baseUrl.replace(/\/$/, "")}/audio/speech`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.o.model, input: text, voice: o.voice, speed: o.speed, response_format: "pcm", stream: true, ...this.o.extraBody }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
    let bytes = 0;
    let carry: number | null = null;
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      alive();
      let chunk = part;
      if (carry !== null) {
        const joined = new Uint8Array(chunk.length + 1);
        joined[0] = carry;
        joined.set(chunk, 1);
        chunk = joined;
        carry = null;
      }
      // whole samples only
      if (chunk.length % 2) {
        carry = chunk[chunk.length - 1];
        chunk = chunk.subarray(0, chunk.length - 1);
      }
      if (chunk.length) {
        bytes += chunk.length;
        o.onAudio(chunk);
      }
    }
    return Math.round((bytes / 2 / this.sampleRate) * 1000);
  }
}
