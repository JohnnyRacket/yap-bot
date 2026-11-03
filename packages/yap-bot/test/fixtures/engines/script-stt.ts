// Test STT: each utterance is transcribed as the next line of a script (options.lines), one more word
// of it per `wordEvery` samples heard, and the final text arrives after `finalDelayMs` (like a remote
// service). Lines run out → "".
import type { SttFactory } from "../../../src/engines/types.ts";

const create: SttFactory<{ lines: string[]; wordEvery?: number; finalDelayMs?: number }> = (o) => {
  let next = 0;
  return {
    createStream() {
      const line = o.lines[next++] ?? "";
      const words = line.split(" ").filter(Boolean);
      let heard = 0;
      const text = () => words.slice(0, Math.min(words.length, Math.floor(heard / (o.wordEvery ?? 3200)))).join(" ");
      return {
        accept: (w) => void (heard += w.length),
        text,
        finish: () => (o.finalDelayMs ? new Promise((r) => setTimeout(() => r(line), o.finalDelayMs)) : line),
      };
    },
  };
};

export default create;
