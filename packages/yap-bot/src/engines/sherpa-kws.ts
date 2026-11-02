// Wake word spotting with a sherpa-onnx zipformer keyword spotter. Runs in the hearing worker. The
// web client runs the same model in WebAssembly (see KwsSpec.deviceModel).
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelFile } from "./sherpa-stt.ts";
import type { KwsFactory } from "./types.ts";

const require = createRequire(import.meta.url);

export interface SherpaKwsOptions {
  /** The model's directory under the models directory. */
  model: string;
}

const create: KwsFactory<SherpaKwsOptions> = (o, env) => {
  const sherpa = require("sherpa-onnx-node");
  const d = join(env.modelsDir, o.model);
  if (!existsSync(d)) throw new Error(`no keyword spotter ${d} (run yap-bot models)`);
  const file = join(tmpdir(), `yap-bot-keywords-${process.pid}.txt`);
  writeFileSync(file, o.keywords.map((k) => `${k.trim()} :${o.boost} #${o.threshold} @wake`).join("\n") + "\n");
  const spotter = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: env.sampleRate, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: modelFile(d, "encoder"), decoder: modelFile(d, "decoder"), joiner: modelFile(d, "joiner") },
      tokens: join(d, "tokens.txt"),
      numThreads: 1,
      provider: "cpu",
      debug: 0,
    },
    keywordsFile: file,
  });
  return {
    createStream() {
      const stream = spotter.createStream();
      return {
        accept(samples) {
          stream.acceptWaveform({ samples, sampleRate: env.sampleRate });
          while (spotter.isReady(stream)) {
            spotter.decode(stream);
            const r = spotter.getResult(stream);
            if (r.keyword) {
              spotter.reset(stream);
              return r.keyword as string;
            }
          }
          return null;
        },
        reset: () => spotter.reset(stream),
      };
    },
  };
};

export default create;
