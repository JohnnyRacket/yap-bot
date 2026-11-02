// Streaming speech to text with a sherpa-onnx online transducer (default: Nemotron Speech
// Streaming 0.6B, 160 ms chunks). Runs in the hearing worker.
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { SttFactory } from "./types.ts";

const require = createRequire(import.meta.url);

export interface SherpaSttOptions {
  /** The model's directory under the models directory. */
  model: string;
  /** Feature dimension the model was trained with: 128 for Nemotron, 80 for most zipformers. */
  featureDim: number;
  threads: number;
  /** Silence fed after the last speech so the final chunk is decoded (≥ one chunk plus a little). */
  padMs: number;
}

/** encoder*.onnx etc., preferring the int8 files. */
export function modelFile(dir: string, part: string): string {
  const entries = readdirSync(dir).filter((f) => f.startsWith(part) && f.endsWith(".onnx")).sort();
  const f = entries.find((x) => x.endsWith(".int8.onnx")) ?? entries[0];
  if (!f) throw new Error(`no ${part}*.onnx in ${dir}`);
  return join(dir, f);
}

const create: SttFactory<SherpaSttOptions> = (o, env) => {
  const sherpa = require("sherpa-onnx-node");
  const d = join(env.modelsDir, o.model);
  if (!existsSync(d)) throw new Error(`no speech model ${d} (run yap-bot models)`);
  const recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: env.sampleRate, featureDim: o.featureDim },
    modelConfig: {
      transducer: { encoder: modelFile(d, "encoder"), decoder: modelFile(d, "decoder"), joiner: modelFile(d, "joiner") },
      tokens: join(d, "tokens.txt"),
      numThreads: o.threads,
      provider: "cpu",
      debug: 0,
    },
    decodingMethod: "greedy_search",
  });
  const pad = Math.round((env.sampleRate * o.padMs) / 1000);
  return {
    createStream() {
      const stream = recognizer.createStream();
      const decode = () => {
        while (recognizer.isReady(stream)) recognizer.decode(stream);
      };
      return {
        accept(samples) {
          stream.acceptWaveform({ samples, sampleRate: env.sampleRate });
          decode();
        },
        text: () => recognizer.getResult(stream).text.trim(),
        finish(trailingSilence) {
          // a pause has already fed some real silence, so it only needs the rest
          const more = Math.max(0, pad - trailingSilence);
          if (more) stream.acceptWaveform({ samples: new Float32Array(more), sampleRate: env.sampleRate });
          stream.inputFinished();
          decode();
          return recognizer.getResult(stream).text.trim();
        },
      };
    },
  };
};

export default create;
