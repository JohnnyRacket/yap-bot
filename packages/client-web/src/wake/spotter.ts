// Spotting the wake word on this device: the mic's 16 kHz audio goes to the spotter worker while
// asleep, and the last couple of seconds are kept so a wake can send what came just before it.
import { MIC_SAMPLE_RATE, WAKE_PREROLL_MS, type DeviceWakeConfig } from "yap-bot/protocol";
import type { FromSpotter, ToSpotter } from "./messages.ts";

const RING = MIC_SAMPLE_RATE * 2;
const PREROLL = Math.round((MIC_SAMPLE_RATE * WAKE_PREROLL_MS) / 1000);

export class DeviceSpotter {
  private worker: Worker | null = null;
  private loading: Promise<void> | null = null;
  private version = "";
  ready = false;
  error = "";
  /** Share of one core spent spotting, lately. */
  load = 0;
  private ring = new Int16Array(RING);
  /** Samples heard since the mic started. */
  private heard = 0;
  private spotting = false;
  /** The wake word, with the audio from WAKE_PREROLL_MS before it was spotted up to now. */
  onWake?: (keyword: string, audio: Int16Array) => void;
  onChange?: () => void;

  /** Loads the spotter (once per model version); resolves when it's ready, rejects if it can't run here. */
  start(config: DeviceWakeConfig): Promise<void> {
    if (this.loading && this.version === config.modelVersion) return this.loading;
    this.worker?.terminate();
    this.ready = false;
    this.error = "";
    this.version = config.modelVersion;
    const worker = new Worker(new URL("./kws-worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    this.loading = new Promise((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<FromSpotter>) => {
        const m = e.data;
        if (m.type === "ready") {
          this.ready = true;
          console.info(`wake word spotter ready in ${m.loadMs} ms (downloads ${m.fetchMs} ms)`);
          resolve();
        } else if (m.type === "keyword") {
          if (this.spotting) this.onWake?.(m.keyword, this.since(m.end - PREROLL));
        } else if (m.type === "load") {
          this.load = m.share;
        } else {
          this.error = m.message;
          reject(new Error(m.message));
        }
        this.onChange?.();
      };
      worker.onerror = (e) => {
        this.error = e.message || "the spotter worker failed to start";
        this.onChange?.();
        reject(new Error(this.error));
      };
    });
    this.post({ type: "init", config });
    return this.loading;
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
    this.loading = null;
    this.ready = false;
    this.spotting = false;
  }

  /** Spot the wake word in what's heard from now on (asleep), or stop (awake: the server is listening). */
  spot(on: boolean) {
    if (on === this.spotting) return;
    this.spotting = on;
    if (on) this.post({ type: "reset" });
  }

  /** Every block of mic audio, asleep or not, so the ring always holds the latest. */
  push(pcm: Int16Array) {
    for (let i = 0; i < pcm.length; i++) this.ring[(this.heard + i) % RING] = pcm[i];
    this.heard += pcm.length;
    if (!this.spotting || !this.ready) return;
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
    this.post({ type: "audio", samples, end: this.heard }, [samples.buffer]);
  }

  /** The audio from sample `from` (bounded by what the ring still holds) up to now. */
  private since(from: number): Int16Array {
    const start = Math.max(from, this.heard - RING, 0);
    const out = new Int16Array(this.heard - start);
    for (let i = 0; i < out.length; i++) out[i] = this.ring[(start + i) % RING];
    return out;
  }

  private post(m: ToSpotter, transfer: Transferable[] = []) {
    this.worker?.postMessage(m, transfer);
  }
}
