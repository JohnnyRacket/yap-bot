// End-of-turn detection with Pipecat's Smart Turn v3: judges from the audio (intonation, pacing)
// whether a pause ends the turn. Runs in the turn worker.
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as ort from "onnxruntime-node";
import { lastEightSeconds, whisperLogMel, N_FRAMES } from "./whisper-features.ts";
import type { TurnFactory } from "./types.ts";

export interface SmartTurnOptions {
  /** The model file under the models directory. */
  model: string;
}

const create: TurnFactory<SmartTurnOptions> = async (o, env) => {
  const file = join(env.modelsDir, o.model);
  if (!existsSync(file)) throw new Error(`missing ${file} (run yap-bot models)`);
  const session = await ort.InferenceSession.create(file, {
    executionMode: "sequential",
    interOpNumThreads: 1,
    intraOpNumThreads: 1,
    graphOptimizationLevel: "all",
    extra: { session: { intra_op: { allow_spinning: "0" }, inter_op: { allow_spinning: "0" } } },
  });
  const judge = async (audio: Float32Array) => {
    const features = whisperLogMel(lastEightSeconds(audio));
    const out = await session.run({ input_features: new ort.Tensor("float32", features, [1, 80, N_FRAMES]) });
    return (out.logits.data as Float32Array)[0];
  };
  // warm up, so the first real judgement isn't slow
  await judge(new Float32Array(env.sampleRate * 8));
  return { judge };
};

export default create;
