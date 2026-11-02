// Voice activity detection with Silero VAD (via sherpa-onnx). Runs in the hearing worker.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { VadFactory } from "./types.ts";

const require = createRequire(import.meta.url);

export interface SileroVadOptions {
  /** The model file under the models directory. */
  model: string;
  threshold: number;
  minSpeechMs: number;
}

const WINDOW = 512;

const create: VadFactory<SileroVadOptions> = (o, env) => {
  const sherpa = require("sherpa-onnx-node");
  const model = join(env.modelsDir, o.model);
  if (!existsSync(model)) throw new Error(`missing ${model} (run yap-bot models)`);
  return {
    windowSize: WINDOW,
    createStream({ minSilenceMs }) {
      const vad = new sherpa.Vad(
        {
          sileroVad: {
            model,
            threshold: o.threshold,
            minSilenceDuration: minSilenceMs / 1000,
            minSpeechDuration: o.minSpeechMs / 1000,
            windowSize: WINDOW,
            maxSpeechDuration: 30,
          },
          sampleRate: env.sampleRate,
          numThreads: 1,
          debug: 0,
        },
        30,
      );
      return {
        accept(window) {
          vad.acceptWaveform(window);
          const speaking = vad.isDetected();
          while (!vad.isEmpty()) vad.pop();
          return speaking;
        },
        reset: () => vad.reset(),
      };
    },
  };
};

export default create;
