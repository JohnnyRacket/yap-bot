// The declarative API agent files use. Every define* returns a plain tagged object the loader
// recognizes; nothing runs until the runtime calls it.
import type { z } from "zod";
import type { EngineSpec, KwsSpec, TtsSpec } from "./engines/types.ts";
import { kokoro, nemotron, sherpaKws, silero, smartTurn, type VoiceChoice } from "./engines/index.ts";
import type { ModelConfig } from "./llm/client.ts";
import * as acks from "./acks.ts";

export interface Device {
  id: string;
  room: string;
}

export interface Timer {
  id: string;
  name: string;
  deviceId: string;
  room: string;
  endsAt: number;
  createdAt: number;
}

export interface Timers {
  start(opts: { seconds: number; name?: string }, device: Device): Timer;
  list(device?: Device): Timer[];
  /** Cancels by id or name; returns the cancelled timers. */
  cancel(idOrName: string, device?: Device): Timer[];
}

/** A small persistent key-value store, one per tool, schedule or fastpath name. */
export interface Store {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  all(): Record<string, unknown>;
}

export interface AnnounceOptions {
  /** A room name, or "all". Default: the current device. */
  room?: string;
}

interface BaseContext {
  device: Device;
  /** The agent's timezone (IANA). */
  timezone: string;
  timers: Timers;
  store: Store;
  /** Speaks into a room (or everywhere), outside the current conversation. */
  announce(text: string, opts?: AnnounceOptions): void;
  log(...args: unknown[]): void;
}

export interface ToolContext extends BaseContext {
  /** Aborted when the user interrupts. */
  signal: AbortSignal;
  /** Speaks right away, in the middle of the turn ("Let me check…"). */
  say(text: string): void;
  /** In wake mode, go back to waiting for the wake word after this turn instead of listening on. */
  sleep(): void;
}

// --- agent ---------------------------------------------------------------------------------

export interface WakeWord {
  /** Said to wake it in wake mode; shown on devices. */
  word: string;
  /** For the transcript detector: matched against the start of what was heard. Default: the word, spaces optional. */
  match?: RegExp;
  /**
   * For the keyword spotter: the wake word as the model's BPE tokens, one spelling per entry, e.g.
   * "▁COMP U TER". Without them only the transcript detector wakes it. Get them with:
   *   uv run --with sentencepiece python -c "import sentencepiece as s; print(' '.join(
   *     s.SentencePieceProcessor(model_file='models/sherpa-onnx-kws-…/bpe.model').encode('HEY JARVIS', out_type=str)))"
   */
  keywords?: string[];
  /** Spotter boost (higher finds more) and trigger threshold (lower finds more). */
  keywordBoost?: number;
  keywordThreshold?: number;
}

export interface AgentDefinition {
  kind: "agent";
  name: string;
  model: ModelConfig;
  wake: WakeWord;
  /** How long it keeps listening after a reply without the wake word. */
  followUpMs: number;
  timezone: string;
  /** Conversation messages kept per device. */
  historyMessages: number;
  /** …and characters (about 4 per token): long tool results fill a small model's context fast. */
  historyChars: number;
  /** Model rounds per turn (each one may call tools) before it gives up. */
  maxToolRounds: number;
  prompt: {
    /** How to talk out loud, added after the instructions; false to leave it to the instructions. */
    voiceRules: string | false;
    /** The line in front of each user message: the date and time, and the room by default. */
    context(device: Device, at: Date, timezone: string): string;
  };
  /** How devices show the agent. details: show tool calls and timings on devices that haven't chosen (Settings → Show details). */
  ui: { title: string; icon: string; details?: boolean };
  /** Bearer token for POST /api/ask; unset, it refuses every request. Default: $YAP_API_SECRET. */
  apiSecret?: string;
  /**
   * Devices must present this to connect (the web page asks once and remembers it, or open it as
   * https://host:8450/#token=…). Unset, anyone who can reach the server can talk to the agent and so
   * run its tools. Default: $YAP_DEVICE_TOKEN.
   */
  deviceToken?: string;
}

export const DEFAULT_VOICE_RULES = `You are talking out loud: everything you write is spoken by a speaker.
- Reply in short, natural spoken sentences. One to three sentences unless asked for more.
- No markdown, lists, headings, emoji, code or links.
- Say numbers, times and units the way a person says them.
- When a tool can do it or knows it, call the tool instead of guessing.
- Only offer to do things your tools can do. When a tool says something needs setting up, say so; don't offer to do it.
- The transcript may have small mistakes; go with the most likely meaning.`;

/** "[Monday, November 2, 2026 at 5:30 PM CST · room: kitchen]" */
export function defaultTurnContext(device: Device, at: Date, timezone: string): string {
  const when = at.toLocaleString("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return `[${when} · room: ${device.room}]`;
}

/** "computer", with the keyword spotter's tokens and settings that caught 14/14 and woke on 6 of 140 everyday sentences. */
export const DEFAULT_WAKE: WakeWord = {
  word: "computer",
  match: /^\s*(?:hey[\s,]+|ok(?:ay)?[\s,]+)?computer\b/i,
  keywords: ["▁COMP U TER"],
  keywordBoost: 1.5,
  keywordThreshold: 0.25,
};

export interface AgentInput {
  name: string;
  /** Default: $LLM_URL, $LLM_MODEL and $LLM_API_KEY. */
  model?: Partial<ModelConfig>;
  /** Default: "computer" (DEFAULT_WAKE). A wake word of your own needs its own keywords for the spotter. */
  wake?: WakeWord;
  /** Default 8000. */
  followUpMs?: number;
  /** Default: $TZ, else the system's. */
  timezone?: string;
  /** Default 40. */
  historyMessages?: number;
  /** Default 24000 (about 6000 tokens). */
  historyChars?: number;
  /** Default 6. */
  maxToolRounds?: number;
  prompt?: Partial<AgentDefinition["prompt"]>;
  /** Default: the name and 🗣️. */
  ui?: Partial<AgentDefinition["ui"]>;
  apiSecret?: string;
  deviceToken?: string;
}

export function defineAgent(def: AgentInput): AgentDefinition {
  return {
    kind: "agent",
    name: def.name,
    model: {
      baseUrl: process.env.LLM_URL ?? "http://localhost:8080/v1",
      id: process.env.LLM_MODEL ?? "",
      apiKey: process.env.LLM_API_KEY || undefined,
      // a model that never stops would otherwise hold the queue until it runs out of context
      maxTokens: 1024,
      ...def.model,
    },
    wake: def.wake ?? DEFAULT_WAKE,
    followUpMs: def.followUpMs ?? 8000,
    timezone: def.timezone ?? process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    historyMessages: def.historyMessages ?? 40,
    historyChars: def.historyChars ?? 24_000,
    maxToolRounds: def.maxToolRounds ?? 6,
    prompt: { voiceRules: DEFAULT_VOICE_RULES, context: defaultTurnContext, ...def.prompt },
    ui: { title: def.name, icon: "🗣️", ...def.ui },
    apiSecret: def.apiSecret ?? (process.env.YAP_API_SECRET || undefined),
    deviceToken: def.deviceToken ?? (process.env.YAP_DEVICE_TOKEN || undefined),
  };
}

// --- voice ---------------------------------------------------------------------------------

export interface TurnInfo {
  turnId: number;
  device: Device;
  text: string;
  spoken: string;
  interrupted: boolean;
}

export interface VoiceDefinition {
  kind: "voice";
  /** Speech to text (default: Nemotron 160 ms, 2 threads). */
  stt: EngineSpec;
  /** Voice activity detection (default: Silero). */
  vad: EngineSpec;
  turn: {
    /** Judges pauses (default: Smart Turn v3); false: a turn ends after incompleteWaitMs of silence. */
    detector: EngineSpec | false;
    /** Probability at which a pause counts as the end of the turn. */
    threshold: number;
    /** Silence before a pause is judged at all. */
    pauseMs: number;
    /** Longest wait after a pause judged incomplete. */
    incompleteWaitMs: number;
  };
  wake: {
    /** Spots the agent's wake keywords (default: sherpa-onnx zipformer); false for the transcript alone. */
    spotter: KwsSpec | false;
  };
  tts: {
    /** Default: Kokoro in process, 4 threads. */
    engine: TtsSpec;
    /** The voice devices get unless they pick another. */
    voice: string;
    /**
     * Voices a device can pick in its Settings, in the order shown (e.g. kokoroVoiceChoices(), best
     * first). The default voice is always among them. Each is downloaded at start.
     */
    voices: VoiceChoice[];
    speed: number;
    /** Speed for tool acks ("One sec."), which are there to fill time. Default: speed. */
    ackSpeed?: number;
  };
  interruptions: {
    /** Words heard before talking over the assistant interrupts it. */
    minWords: number;
    /** Pause playback the moment speech is heard, until it's confirmed (or not) as an interruption. */
    pauseOnSpeech: boolean;
  };
  acks: {
    /** The default ack for a tool call (a tool can set its own): picked at random, skipping the last few said. */
    tool: string[];
    /** More phrases to keep as ready-made audio. Tool acks are always kept. */
    cache: string[];
  };
  /** What it says on its own. */
  phrases: {
    /** A turn failed. */
    error: string;
    /** The model used tools but ended with nothing to say. */
    noAnswer: string;
    /** A timer went off (a timer_done trigger replaces this). */
    timerDone(timer: Timer): string;
  };
  /**
   * Have the model read the prompt while the user is still talking, so the reply starts sooner.
   * Off by default: it only helps if the server can reuse a cache whose end differs, which llama.cpp
   * can't for sliding-window models like Gemma unless it runs with --swa-full.
   */
  prefill: boolean;
  hooks: {
    /** Rewrite a finished user turn, or return null to drop it. */
    beforeTurn?(text: string, device: Device): string | null | void;
    afterTurn?(info: TurnInfo): void;
  };
}

export interface VoiceInput {
  stt?: EngineSpec;
  vad?: EngineSpec;
  turn?: Partial<VoiceDefinition["turn"]>;
  wake?: Partial<VoiceDefinition["wake"]>;
  /** voices: voice ids, or { id, label } to name them in Settings. */
  tts?: Partial<Omit<VoiceDefinition["tts"], "voices">> & { voices?: (string | VoiceChoice)[] };
  interruptions?: Partial<VoiceDefinition["interruptions"]>;
  acks?: Partial<VoiceDefinition["acks"]>;
  phrases?: Partial<VoiceDefinition["phrases"]>;
  prefill?: boolean;
  hooks?: VoiceDefinition["hooks"];
}

/** tts.voices as choices, with the default voice among them (first, when it wasn't listed). */
function voiceList(tts: Omit<VoiceDefinition["tts"], "voices"> & { voices?: (string | VoiceChoice)[] }): VoiceDefinition["tts"] {
  const voices = (tts.voices ?? []).map((v) => (typeof v === "string" ? { id: v, label: v } : v));
  if (!voices.some((v) => v.id === tts.voice)) voices.unshift({ id: tts.voice, label: tts.voice });
  return { ...tts, voices };
}

export function defaultTimerDone(t: Timer): string {
  return `${t.name === "timer" ? "Your timer" : `Your ${t.name.replace(/\s*timer$/i, "")} timer`} is done.`;
}

/** Every setting has a default: defineVoice({}) is Nemotron, Silero, Smart Turn, the zipformer spotter and Kokoro's af_heart. */
export function defineVoice(def: VoiceInput = {}): VoiceDefinition {
  return {
    kind: "voice",
    stt: def.stt ?? nemotron(),
    vad: def.vad ?? silero(),
    turn: { detector: smartTurn(), threshold: 0.5, pauseMs: 200, incompleteWaitMs: 1500, ...def.turn },
    wake: { spotter: sherpaKws(), ...def.wake },
    tts: voiceList({ engine: kokoro(), voice: "af_heart", speed: 1.3, ackSpeed: 1.1, ...def.tts }),
    interruptions: { minWords: 2, pauseOnSpeech: true, ...def.interruptions },
    acks: { tool: acks.action, cache: [], ...def.acks },
    phrases: { error: "Sorry, something went wrong.", noAnswer: "Sorry, I couldn't find an answer to that.", timerDone: defaultTimerDone, ...def.phrases },
    prefill: def.prefill ?? false,
    hooks: { ...def.hooks },
  };
}

// --- tools ---------------------------------------------------------------------------------

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  kind: "tool";
  description: string;
  input: S;
  execute(input: z.infer<S>, ctx: ToolContext): unknown | Promise<unknown>;
  /**
   * Said the moment the model starts calling this tool (while it's still writing the arguments),
   * if nothing has been said yet this turn: one phrase, or several to pick from at random.
   * Default: the voice's acks.tool; false for none. Kept as ready-made audio, so it plays at once.
   */
  ack?: string | string[] | false;
  /** The turn ends after this tool instead of going back to the model (when it's the only kind called). */
  final?: boolean;
  /** How long it may run before the model is told it timed out (default 20 s). ctx.signal is aborted then too. */
  timeoutMs?: number;
}

export function defineTool<S extends z.ZodType>(def: Omit<ToolDefinition<S>, "kind">): ToolDefinition<S> {
  return { kind: "tool", ...def };
}

// --- fastpaths -----------------------------------------------------------------------------

export interface FastpathContext extends BaseContext {
  /** The normalized transcript: lowercase, no punctuation. */
  text: string;
  /** The transcript as heard. */
  raw: string;
  /** The regex match, for RegExp matchers. */
  match: RegExpMatchArray | null;
  /** In wake mode, go back to waiting for the wake word after this turn instead of listening on. */
  sleep(): void;
}

export interface FastpathDefinition {
  kind: "fastpath";
  /** Exact phrase(s) after normalization, a RegExp tested on the normalized text, or a predicate. */
  match: string | string[] | RegExp | ((text: string) => boolean);
  /** Returns what to say, or nothing to stay quiet. */
  run(ctx: FastpathContext): string | void | Promise<string | void>;
}

export function defineFastpath(def: Omit<FastpathDefinition, "kind">): FastpathDefinition {
  return { kind: "fastpath", ...def };
}

// --- schedules -----------------------------------------------------------------------------

export interface ScheduleContext extends Omit<BaseContext, "device"> {
  /** Runs the agent on a prompt (with its tools) and returns the reply text. */
  ask(prompt: string): Promise<string>;
}

export interface ScheduleDefinition {
  kind: "schedule";
  /** Standard 5-field cron, in the agent's timezone. */
  cron: string;
  /** Fire-and-forget: run the agent on this prompt and announce the reply to `room`. */
  prompt?: string;
  run?(ctx: ScheduleContext): void | Promise<void>;
  /** Where a prompt schedule's reply is spoken; "all" by default. Ignored by run(). */
  room?: string;
  /** Speak a prompt schedule's reply (default true). */
  speak?: boolean;
}

export function defineSchedule(def: Omit<ScheduleDefinition, "kind">): ScheduleDefinition {
  if (!def.prompt === !def.run) throw new Error("defineSchedule needs exactly one of prompt or run");
  return { kind: "schedule", ...def };
}

// --- triggers ------------------------------------------------------------------------------

/** The runtime's own events a trigger can react to. */
export type TriggerEventName = "timer_done" | "device_connected" | "device_disconnected";

export type TriggerInput =
  | { source: "webhook"; payload: unknown; query: Record<string, string> }
  | { source: "every" }
  | { source: "event"; event: "timer_done"; timer: Timer }
  | { source: "event"; event: "device_connected" | "device_disconnected"; device: Device };

export interface TriggerContext extends ScheduleContext {
  /** Devices connected right now. */
  devices(): Device[];
}

export interface TriggerDefinition {
  kind: "trigger";
  on: {
    /**
     * POST /hooks/<name>. With a secret, callers must send "Authorization: Bearer <secret>" or
     * ?token=<secret>; an empty secret refuses every request. With respond, the request waits for
     * the trigger and gets back what run() returned (or, for a prompt, the reply instead of it being
     * announced); without, it's answered at once with 202.
     */
    webhook?: boolean | { secret?: string; respond?: boolean };
    /** Run periodically: "30s", "5m", "1h". */
    every?: string;
    /** With every: also run once when the server starts (not again on reloads), instead of first after one interval. */
    atStart?: boolean;
    event?: TriggerEventName;
  };
  /** Code to run. What it returns is the response of a webhook with respond. */
  run?(ctx: TriggerContext, input: TriggerInput): unknown | Promise<unknown>;
  /**
   * Or: a prompt for the agent; the reply is announced. {{payload}} (JSON) and {{payload.field}}
   * are filled in from a webhook, {{timer.name}} / {{device.room}} from events.
   */
  prompt?: string;
  /** Or: fixed text to announce, with the same placeholders. */
  announce?: string;
  /** Where prompt/announce speak: a room, or "all" (default). Ignored by run(). */
  room?: string;
}

export function defineTrigger(def: Omit<TriggerDefinition, "kind">): TriggerDefinition {
  const actions = [def.run, def.prompt, def.announce].filter((a) => a !== undefined).length;
  if (actions !== 1) throw new Error("defineTrigger needs exactly one of run, prompt or announce");
  if (def.on.atStart && !def.on.every) throw new Error("defineTrigger's atStart goes with every");
  const kinds = [def.on.webhook, def.on.every, def.on.event].filter((k) => k !== undefined && k !== false).length;
  if (kinds !== 1) throw new Error("defineTrigger's on needs exactly one of webhook, every or event");
  return { kind: "trigger", ...def };
}
