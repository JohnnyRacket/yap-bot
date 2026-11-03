// Kokoro 82M via onnxruntime in a worker thread, with kokoro-js's pronunciation.
import { Worker } from "node:worker_threads";
import type { SynthesizeOptions, TtsEngine } from "../engines/types.ts";
import { log } from "../log.ts";

const SAMPLE_RATE = 24000;
const PIECE = SAMPLE_RATE / 10;

export class KokoroLocal implements TtsEngine {
  readonly name = "kokoro (in process)";
  readonly sampleRate = SAMPLE_RATE;
  readonly ready: Promise<void>;
  readonly worker: Worker;
  private seq = 0;
  private pending = new Map<number, (r: { audio?: Float32Array; error?: string; ms?: number }) => void>();

  /** warmVoice: a voice that's been downloaded, for the warm-up run. */
  constructor(modelsDir: string, threads: number, warmVoice = "af_heart") {
    const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    this.worker = new Worker(new URL(`./kokoro-worker${ext}`, import.meta.url), { workerData: { modelsDir, threads, warmVoice } });
    this.ready = new Promise((resolve, reject) => {
      const t0 = performance.now();
      this.worker.on("message", (m) => {
        if (m.type === "ready") {
          log.info(`kokoro ready in ${Math.round(performance.now() - t0)} ms (${threads} threads)`);
          resolve();
        } else this.pending.get(m.id)?.(m);
      });
      this.worker.on("error", (e) => {
        log.error("kokoro worker crashed", e);
        reject(e);
      });
      // whatever was waiting on it fails now rather than hanging the turn
      this.worker.on("exit", (code) => {
        for (const settle of this.pending.values()) settle({ error: `the kokoro worker exited (${code})` });
        this.pending.clear();
      });
    });
  }

  async close() {
    await this.worker.terminate();
  }

  async synthesize(text: string, o: SynthesizeOptions): Promise<number> {
    const id = ++this.seq;
    let timer: NodeJS.Timeout | undefined;
    const r = await new Promise<{ audio?: Float32Array; error?: string }>((resolve) => {
      const settle = (m: { audio?: Float32Array; error?: string }) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(m);
      };
      this.pending.set(id, settle);
      timer = setTimeout(() => settle({ error: "no audio after 30 s" }), 30_000);
      this.worker.postMessage({ id, text, voice: o.voice, speed: o.speed });
    });
    // the model can't be stopped mid-sentence; an interrupted turn just drops the result
    o.signal?.throwIfAborted();
    if (r.error || !r.audio) throw new Error(`kokoro: ${r.error}`);
    const pcm = new Int16Array(r.audio.length);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(r.audio[i] * 32767)));
    for (let i = 0; i < pcm.length; i += PIECE) {
      const part = pcm.subarray(i, i + PIECE);
      o.onAudio(new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
    }
    return Math.round((pcm.length / SAMPLE_RATE) * 1000);
  }
}
