// The end-of-turn engine in its own thread, so judging a pause never waits behind speech decoding.
import { parentPort, workerData } from "node:worker_threads";
import type { EngineSpec, TurnEngine, TurnFactory } from "../engines/types.ts";
import { useSourceConditions } from "../source-conditions.ts";

useSourceConditions();

const port = parentPort!;
const { spec, modelsDir } = workerData as { spec: EngineSpec; modelsDir: string };
const factory = (await import(spec.module)).default as TurnFactory;
const engine: TurnEngine = await factory(spec.options, { modelsDir, sampleRate: 16000, log: (m) => console.log(`[${spec.name}] ${m}`) });
port.postMessage({ type: "ready" });

port.on("message", async ({ id, audio }: { id: number; audio: Float32Array }) => {
  const t0 = performance.now();
  try {
    const probability = await engine.judge(audio);
    port.postMessage({ type: "result", id, probability, ms: performance.now() - t0 });
  } catch (e) {
    port.postMessage({ type: "result", id, error: (e as Error).message, ms: performance.now() - t0 });
  }
});
