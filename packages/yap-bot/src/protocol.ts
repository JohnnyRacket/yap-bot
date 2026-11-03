// The device protocol: one WebSocket per device. Control messages are JSON text frames; audio
// travels in binary frames whose first byte says what they carry.

/** Mic audio, client → server: PCM s16le, 16 kHz, mono. */
export const MIC_SAMPLE_RATE = 16000;
/** Speech audio, server → client: PCM s16le, 24 kHz, mono (Kokoro's native rate). */
export const TTS_SAMPLE_RATE = 24000;

export const BinaryKind = {
  /** [1][pcm…] */
  Mic: 1,
  /** [2][chunkId u32 LE][pcm…] */
  Tts: 2,
} as const;

/** How a device starts a turn. */
export type ListenMode =
  /** Hold to talk: the client says when speech starts and ends. */
  | "push"
  /** Always listening; turn detection decides when you're done. */
  | "open"
  /** Listens for the wake word, then for a follow-up window after each reply. */
  | "wake";

export type SessionState = "idle" | "listening" | "thinking" | "speaking";

/**
 * How wake mode notices the wake word. On the server: Nemotron's transcript, the keyword spotter, or
 * either; the device streams all its audio. "device": the device runs the keyword spotter itself and
 * streams nothing while asleep (it sends "wake", then audio until it's told it's asleep again).
 */
export type WakeDetector = "transcript" | "keyword" | "both" | "device";

/** What a device needs to spot the wake word itself: the keyword spotter's settings and model. */
export interface DeviceWakeConfig {
  /** Keywords as the model's BPE tokens, as in sherpa-onnx keyword files. */
  keywords: string[];
  boost: number;
  threshold: number;
  /** The model's files are at `${modelUrl}/{encoder,decoder,joiner}.onnx` and `tokens.txt`. */
  modelUrl: string;
  /** Changes when the model files do (for caching them). */
  modelVersion: string;
}

/**
 * Audio a device sends with its "wake", from before the moment it spotted the keyword: the spotter
 * fires partway into the next word, so this catches it (the server's own spotter reaches back as far).
 */
export const WAKE_PREROLL_MS = 800;

// --- client → server -----------------------------------------------------------------------

export type ClientMessage =
  | { type: "hello"; deviceId: string; room?: string; mode: ListenMode; interruptions?: boolean; wakeDetector?: WakeDetector }
  | { type: "mode"; mode: ListenMode; interruptions?: boolean; wakeDetector?: WakeDetector }
  /** wakeDetector "device": the device heard the wake word. Audio follows, starting WAKE_PREROLL_MS before it. */
  | { type: "wake"; keyword: string }
  /** Push-to-talk pressed / released. */
  | { type: "push"; down: boolean }
  /** Played back so far: whole chunks up to chunkId are done when done is true. */
  | { type: "playback"; chunkId: number; playedMs: number; done: boolean }
  /** A typed turn, as if spoken. */
  | { type: "text"; text: string }
  /** Stop speaking and drop the current turn. */
  | { type: "interrupt" }
  /** Forget this device's conversation. */
  | { type: "reset" };

// --- server → client -----------------------------------------------------------------------

export interface TimelineMark {
  /** e.g. speech_end, turn_end, stt_final, llm_request, llm_first_token, first_sentence, tts_first_audio */
  name: string;
  /** Milliseconds since the epoch (server clock). */
  at: number;
  detail?: string;
}

export interface AgentSummary {
  tools: string[];
  skills: string[];
  fastpaths: string[];
  schedules: string[];
  triggers: string[];
}

export type ServerMessage =
  | {
      type: "welcome";
      deviceId: string;
      room: string;
      agent: string;
      /** How to show the agent: its title and an emoji, and whether to show tool calls and timings by default. */
      ui: { title: string; icon: string; details?: boolean };
      wakeWord: string;
      /** Absent when the agent has no keywords or the server has no keyword spotter model. */
      deviceWake?: DeviceWakeConfig;
      followUpMs: number;
      serverTime: number;
      capabilities: AgentSummary;
    }
  /** awake: wake mode only. A device spotting the wake word itself streams audio while it's true. */
  | { type: "state"; state: SessionState; awake?: boolean }
  | { type: "transcript"; turnId: number; text: string; final: boolean }
  | { type: "assistant"; turnId: number; chunkId: number; text: string }
  /** All audio for a chunk has been sent. */
  | { type: "tts_end"; chunkId: number; durationMs: number }
  /** Drop queued and playing audio now. */
  | { type: "stop" }
  /** Someone started talking over the reply: hold playback where it is… */
  | { type: "pause" }
  /** …and carry on, when it turned out not to be an interruption. */
  | { type: "resume" }
  | { type: "tool"; turnId: number; name: string; input: unknown; output?: unknown; error?: string; ms?: number }
  | { type: "announce"; text: string; source: string }
  /** Wake mode, while asleep: what was heard, and whether (and how) it woke. Also the answer to a device's "wake". */
  | { type: "heard"; text: string; woke: boolean; by?: "transcript" | "keyword" | "device" }
  | { type: "turn_done"; turnId: number; interrupted: boolean; spoken: string }
  | { type: "metrics"; turnId: number; marks: TimelineMark[]; llm?: LlmStats }
  | { type: "error"; message: string }
  | ({ type: "agent_reloaded" } & AgentSummary);

export interface LlmStats {
  rounds: number;
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
  promptMs?: number;
  generationTps?: number;
}

// --- binary helpers ------------------------------------------------------------------------

export function encodeMic(pcm: Int16Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(1 + pcm.byteLength);
  out[0] = BinaryKind.Mic;
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 1);
  return out;
}

export function encodeTts(chunkId: number, pcm: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(5 + pcm.byteLength);
  out[0] = BinaryKind.Tts;
  new DataView(out.buffer).setUint32(1, chunkId, true);
  out.set(pcm, 5);
  return out;
}

export type DecodedBinary =
  | { kind: "mic"; pcm: Int16Array }
  | { kind: "tts"; chunkId: number; pcm: Int16Array };

/** Copies the PCM out of the frame: aligned, and its own buffer (Node's Buffer.slice shares memory). */
function pcmFrom(bytes: Uint8Array, offset: number): Int16Array {
  const out = new Int16Array((bytes.byteLength - offset) >> 1);
  new Uint8Array(out.buffer).set(bytes.subarray(offset, offset + out.byteLength));
  return out;
}

export function decodeBinary(data: ArrayBuffer | Uint8Array): DecodedBinary | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 1) return null;
  if (bytes[0] === BinaryKind.Mic) return { kind: "mic", pcm: pcmFrom(bytes, 1) };
  if (bytes[0] === BinaryKind.Tts && bytes.length >= 5) {
    const chunkId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, true);
    return { kind: "tts", chunkId, pcm: pcmFrom(bytes, 5) };
  }
  return null;
}
