// Test VAD: speech is any window louder than a threshold; silence once minSilenceMs of quiet has passed.
import type { VadFactory } from "../../../src/engines/types.ts";

const create: VadFactory<{ threshold?: number }> = (o, env) => ({
  windowSize: 512,
  createStream({ minSilenceMs }) {
    const quietWindows = Math.ceil(((minSilenceMs / 1000) * env.sampleRate) / 512);
    let quiet = Infinity;
    return {
      accept(w) {
        let peak = 0;
        for (const s of w) peak = Math.max(peak, Math.abs(s));
        quiet = peak > (o.threshold ?? 0.05) ? 0 : quiet + 1;
        return quiet < quietWindows;
      },
      reset: () => void (quiet = Infinity),
    };
  },
});

export default create;
