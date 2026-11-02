// Kokoro 82M in its own thread: phonemize, tokenize, pick the voice style, run the model.
import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ort from "onnxruntime-node";
import { phonemize } from "./phonemize.ts";

const STYLE_DIM = 256;
const MAX_TOKENS = 510; // the model's context, including the two padding tokens

const { modelsDir, threads, warmVoice } = workerData as { modelsDir: string; threads: number; warmVoice: string };
const dir = join(modelsDir, "kokoro");
const vocab: Record<string, number> = JSON.parse(readFileSync(join(dir, "tokenizer.json"), "utf8")).model.vocab;
const session = await ort.InferenceSession.create(join(dir, "model.onnx"), {
  executionMode: "sequential",
  interOpNumThreads: 1,
  intraOpNumThreads: threads,
  graphOptimizationLevel: "all",
  // don't busy-wait between jobs: the spinning threads would starve hearing on the same cores
  extra: { session: { intra_op: { allow_spinning: "0" }, inter_op: { allow_spinning: "0" } } },
});
const voices = new Map<string, Float32Array>();

function voice(name: string): Float32Array {
  let v = voices.get(name);
  if (!v) {
    const buf = readFileSync(join(dir, "voices", `${name}.bin`));
    v = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    voices.set(name, v);
  }
  return v;
}

/** One id per phoneme character (unknown ones dropped), padded with "$" (0) at both ends. */
function tokenize(phonemes: string): BigInt64Array {
  const ids = [0];
  for (const ch of phonemes) {
    const id = vocab[ch];
    if (id !== undefined && ids.length < MAX_TOKENS - 1) ids.push(id);
  }
  ids.push(0);
  return BigInt64Array.from(ids, BigInt);
}

async function synthesize(text: string, voiceName: string, speed: number) {
  const t0 = performance.now();
  const phonemes = await phonemize(text, voiceName.startsWith("b") ? "b" : "a");
  const ids = tokenize(phonemes);
  const styles = voice(voiceName);
  // the style vector depends on the length of the utterance
  const n = Math.min(Math.max(ids.length - 2, 0), 509);
  const style = styles.slice(n * STYLE_DIM, (n + 1) * STYLE_DIM);
  const out = await session.run({
    input_ids: new ort.Tensor("int64", ids, [1, ids.length]),
    style: new ort.Tensor("float32", style, [1, STYLE_DIM]),
    speed: new ort.Tensor("float32", new Float32Array([speed]), [1]),
  });
  return { audio: out.waveform.data as Float32Array, phonemes, ms: performance.now() - t0 };
}

// warm up: the first run is much slower
await synthesize("Hello.", warmVoice, 1);
parentPort!.postMessage({ type: "ready" });

parentPort!.on("message", async ({ id, text, voice: v, speed }: { id: number; text: string; voice: string; speed: number }) => {
  try {
    const r = await synthesize(text, v, speed);
    parentPort!.postMessage({ type: "result", id, audio: r.audio, phonemes: r.phonemes, ms: r.ms }, [r.audio.buffer as ArrayBuffer]);
  } catch (e) {
    parentPort!.postMessage({ type: "result", id, error: (e as Error).message });
  }
});
