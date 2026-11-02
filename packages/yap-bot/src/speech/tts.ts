// Speech out: whichever engine the voice names, behind a cache of ready-made short phrases, with its
// audio resampled to the protocol's 24 kHz when the engine makes another rate.
import { TTS_SAMPLE_RATE } from "../protocol.ts";
import type { SynthesizeOptions, TtsEngine } from "../engines/types.ts";
import { log } from "../log.ts";

const PIECE = TTS_SAMPLE_RATE / 10;

/** Phrases up to this long are kept once spoken ("Okay.", "Done."), besides the ones warmed up. */
const SHORT = 24;
const MAX_CACHED = 128;

/**
 * Keeps short phrases as ready-made audio with the silence around them trimmed, so acks and
 * other short replies play at once instead of after a synthesis.
 */
export class CachedTts implements TtsEngine {
  readonly name: string;
  readonly ready: Promise<void>;
  private engine: TtsEngine;
  private clips = new Map<string, Int16Array>();
  private warming = new Set<string>();

  constructor(engine: TtsEngine) {
    this.engine = engine.sampleRate && engine.sampleRate !== TTS_SAMPLE_RATE ? new Resampled(engine, engine.sampleRate) : engine;
    this.name = this.engine.name;
    this.ready = engine.ready;
  }

  private key(text: string, voice: string, speed: number) {
    return `${voice}|${speed}|${text.trim().toLowerCase()}`;
  }

  async synthesize(text: string, o: SynthesizeOptions): Promise<number> {
    const key = this.key(text, o.voice, o.speed);
    const clip = this.clips.get(key);
    if (clip) {
      o.signal?.throwIfAborted();
      // most recently used last, so the oldest go first when it's full
      this.clips.delete(key);
      this.clips.set(key, clip);
      return play(clip, o.onAudio);
    }
    if (text.trim().length > SHORT) return this.engine.synthesize(text, o);
    const pieces: Uint8Array[] = [];
    const ms = await this.engine.synthesize(text, { ...o, onAudio: (pcm) => (pieces.push(pcm.slice()), o.onAudio(pcm)) });
    this.keep(key, pieces);
    return ms;
  }

  /** Synthesizes phrases ahead of time (in the background; already kept ones are skipped). */
  async warm(phrases: string[], voice: string, speed: number) {
    await this.ready;
    for (const text of new Set(phrases.map((p) => p.trim()).filter(Boolean))) {
      const key = this.key(text, voice, speed);
      if (this.clips.has(key) || this.warming.has(key)) continue;
      this.warming.add(key);
      try {
        const pieces: Uint8Array[] = [];
        await this.engine.synthesize(text, { voice, speed, onAudio: (pcm) => pieces.push(pcm.slice()) });
        this.keep(key, pieces);
      } catch (e) {
        log.warn(`couldn't prepare "${text}": ${(e as Error).message}`);
      } finally {
        this.warming.delete(key);
      }
    }
  }

  private keep(key: string, pieces: Uint8Array[]) {
    const bytes = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of pieces) bytes.set(p, (at += p.length) - p.length);
    this.clips.set(key, trimSilence(new Int16Array(bytes.buffer, 0, bytes.length >> 1)));
    if (this.clips.size > MAX_CACHED) this.clips.delete(this.clips.keys().next().value!);
  }
}

function play(clip: Int16Array, onAudio: (pcm: Uint8Array) => void): number {
  for (let i = 0; i < clip.length; i += PIECE) {
    const part = clip.subarray(i, i + PIECE);
    onAudio(new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
  }
  return Math.round((clip.length / TTS_SAMPLE_RATE) * 1000);
}

/** Cuts the quiet before and after speech, keeping a short lead-in and tail so it isn't clipped. */
export function trimSilence(pcm: Int16Array, threshold = 500): Int16Array {
  let start = 0;
  let end = pcm.length;
  while (start < end && Math.abs(pcm[start]) < threshold) start++;
  while (end > start && Math.abs(pcm[end - 1]) < threshold) end--;
  if (start >= end) return pcm;
  const lead = Math.round(TTS_SAMPLE_RATE * 0.03);
  const tail = Math.round(TTS_SAMPLE_RATE * 0.12);
  return pcm.slice(Math.max(0, start - lead), Math.min(pcm.length, end + tail));
}

/** Linear resampling of an engine's PCM to TTS_SAMPLE_RATE, as it streams. */
class Resampled implements TtsEngine {
  readonly name: string;
  readonly ready: Promise<void>;
  readonly sampleRate = TTS_SAMPLE_RATE;
  private engine: TtsEngine;
  private ratio: number;

  constructor(engine: TtsEngine, from: number) {
    this.engine = engine;
    this.name = `${engine.name}, ${from} Hz resampled`;
    this.ready = engine.ready;
    this.ratio = from / TTS_SAMPLE_RATE;
  }

  async synthesize(text: string, o: SynthesizeOptions): Promise<number> {
    let carry = new Int16Array(0);
    let pos = 0;
    let samples = 0;
    await this.engine.synthesize(text, {
      ...o,
      onAudio: (bytes) => {
        const pcm = new Int16Array(carry.length + (bytes.byteLength >> 1));
        pcm.set(carry);
        pcm.set(new Int16Array(bytes.slice().buffer, 0, bytes.byteLength >> 1), carry.length);
        const out: number[] = [];
        for (; pos + 1 < pcm.length; pos += this.ratio) {
          const i = Math.floor(pos);
          out.push(Math.round(pcm[i] * (1 - (pos - i)) + pcm[i + 1] * (pos - i)));
        }
        const keep = Math.floor(pos);
        carry = pcm.slice(keep);
        pos -= keep;
        if (!out.length) return;
        samples += out.length;
        o.onAudio(new Uint8Array(Int16Array.from(out).buffer));
      },
    });
    return Math.round((samples / TTS_SAMPLE_RATE) * 1000);
  }
}
