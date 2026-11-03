import type { ListenMode } from "../protocol.ts";
import type { EngineSpec, KwsOptions, KwsSpec } from "../engines/types.ts";

export interface HearingConfig {
  modelsDir: string;
  stt: EngineSpec;
  vad: EngineSpec;
  /** Judges pauses; without one a turn ends after incompleteWaitMs of silence. */
  turnDetector: EngineSpec | null;
  threshold: number;
  pauseMs: number;
  incompleteWaitMs: number;
  /** Keyword spotter for wake words (its options carry the keywords); off when absent. */
  kws?: KwsSpec<KwsOptions>;
}

export type ToHearing =
  | { type: "init"; config: HearingConfig }
  /** gate: transcribe only while awake (wake mode with the keyword spotter alone). */
  | { type: "open"; sid: string; mode: ListenMode; kws: boolean; gate: boolean }
  | { type: "mode"; sid: string; mode: ListenMode; kws: boolean; gate: boolean }
  /**
   * listen: the device spotted the wake word itself; the audio that follows starts before it
   * (WAKE_PREROLL_MS), so transcribe it all as a new utterance.
   */
  | { type: "awake"; sid: string; awake: boolean; listen?: boolean }
  | { type: "audio"; sid: string; pcm: Int16Array; sentAt: number }
  | { type: "push"; sid: string; down: boolean }
  | { type: "close"; sid: string };

export type TurnReason = "smart_turn" | "silence" | "push" | "max_length";

export type FromHearing =
  | { type: "ready"; loadMs: number }
  | { type: "speech_start"; sid: string; at: number }
  | { type: "partial"; sid: string; text: string; at: number }
  | {
      type: "turn";
      sid: string;
      text: string;
      reason: TurnReason;
      /** The turn detector's probability at the deciding pause, if it was asked. */
      probability?: number;
      audioMs: number;
      /** Worst delay between audio arriving and being processed during the utterance. */
      lagMs: number;
      speechEndAt: number;
      turnEndAt: number;
      finalAt: number;
    }
  | { type: "judged"; sid: string; probability: number; ms: number; at: number }
  | { type: "keyword"; sid: string; keyword: string; at: number }
  | { type: "error"; message: string }
  /** Hearing couldn't start (a model missing or broken): nothing will be heard. */
  | { type: "fatal"; message: string };
