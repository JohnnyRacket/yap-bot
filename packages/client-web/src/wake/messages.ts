import type { DeviceWakeConfig } from "yap-bot/protocol";

export type ToSpotter =
  | { type: "init"; config: DeviceWakeConfig }
  /** 16 kHz audio; end: how many samples the device had heard when this block ended. */
  | { type: "audio"; samples: Float32Array; end: number }
  | { type: "reset" };

export type FromSpotter =
  | { type: "ready"; loadMs: number; fetchMs: number }
  /** end: the end of the block it was spotted in, as in "audio". */
  | { type: "keyword"; keyword: string; end: number }
  /** Share of the audio's duration spent spotting (0.05 = 5% of one core). */
  | { type: "load"; share: number }
  | { type: "error"; message: string };
