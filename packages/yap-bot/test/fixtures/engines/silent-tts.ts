// Test TTS: 20 ms of near-silence per character, at 16 kHz (so the resampler is exercised too).
import type { TtsEngine, TtsSpec } from "../../../src/engines/types.ts";

export const synthesized: string[] = [];

export function silentTts(): TtsSpec {
  return {
    name: "silent",
    create: (): TtsEngine => ({
      name: "silent",
      sampleRate: 16000,
      ready: Promise.resolve(),
      async synthesize(text, o) {
        synthesized.push(text);
        const pcm = new Int16Array(text.length * 320).fill(1);
        o.onAudio(new Uint8Array(pcm.buffer));
        return text.length * 20;
      },
    }),
  };
}
