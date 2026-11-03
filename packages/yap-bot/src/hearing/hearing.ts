import { Worker } from "node:worker_threads";
import type { ListenMode } from "../protocol.ts";
import type { FromHearing, HearingConfig, ToHearing } from "./messages.ts";
import { log } from "../log.ts";

export type HearingEvent = Exclude<FromHearing, { type: "ready" } | { type: "error" }>;

/** Main-thread handle on the hearing worker. */
export class Hearing {
  private worker: Worker;
  private listeners = new Map<string, (ev: HearingEvent) => void>();
  readonly ready: Promise<void>;

  constructor(config: HearingConfig) {
    this.worker = new Worker(new URL(`./worker${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url));
    this.ready = new Promise((resolve, reject) => {
      this.worker.on("message", (msg: FromHearing) => {
        if (msg.type === "ready") {
          log.info(`hearing ready in ${msg.loadMs} ms`);
          resolve();
        } else if (msg.type === "error") {
          log.error(`hearing: ${msg.message}`);
        } else {
          this.listeners.get(msg.sid)?.(msg);
        }
      });
      this.worker.on("error", (e) => {
        log.error("hearing worker crashed", e);
        reject(e);
      });
    });
    this.post({ type: "init", config });
  }

  private post(msg: ToHearing, transfer?: ArrayBuffer[]) {
    this.worker.postMessage(msg, transfer);
  }

  /** kws: run the keyword spotter on this device's audio. gate: transcribe only while awake. */
  open(sid: string, mode: ListenMode, kws: boolean, gate: boolean, listener: (ev: HearingEvent) => void) {
    this.listeners.set(sid, listener);
    this.post({ type: "open", sid, mode, kws, gate });
  }

  mode(sid: string, mode: ListenMode, kws: boolean, gate: boolean) {
    this.post({ type: "mode", sid, mode, kws, gate });
  }

  /** listen: woken by the device's own spotter, which sends the audio from just before the wake word. */
  awake(sid: string, awake: boolean, listen = false) {
    this.post({ type: "awake", sid, awake, listen });
  }

  /** Takes ownership of pcm: its buffer is transferred to the worker. */
  audio(sid: string, pcm: Int16Array) {
    this.post({ type: "audio", sid, pcm, sentAt: Date.now() }, [pcm.buffer as ArrayBuffer]);
  }

  push(sid: string, down: boolean) {
    this.post({ type: "push", sid, down });
  }

  /** Stops the worker (and the turn detector's, inside it). */
  terminate() {
    return this.worker.terminate();
  }

  close(sid: string) {
    this.listeners.delete(sid);
    this.post({ type: "close", sid });
  }
}
