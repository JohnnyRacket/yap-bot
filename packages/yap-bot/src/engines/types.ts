// The swappable parts of hearing and speaking. Hearing engines (speech to text, voice activity,
// end of turn, keyword spotting) run inside worker threads, so an agent names them by module rather
// than passing objects: an EngineSpec says which module to load and with what (JSON) options, and the
// module's default export builds the engine there. Speech out runs on the main thread and is created
// from a TtsSpec.
//
//   // agent/engines/my-stt.ts
//   import type { SttFactory } from "yap-bot/engines";
//   const create: SttFactory<{ url: string }> = async (options, env) => ({ createStream() { … } });
//   export default create;
//
//   // agent/voice.ts
//   defineVoice({ stt: { name: "my-stt", module: new URL("./engines/my-stt.ts", import.meta.url).href, options: { url } } })

/** A file the engine needs under the models directory, fetched by `yap-bot models` (and on start). */
export interface ModelDownload {
  /** Relative to the models directory; present means already downloaded. */
  path: string;
  url: string;
  /** A .tar.bz2 / .tar.gz archive, unpacked into the models directory (it should hold `path`). */
  extract?: boolean;
  /** Removed after unpacking, relative to the models directory (test files, unused variants). */
  prune?: string[];
}

export interface EngineEnv {
  modelsDir: string;
  /** Mic audio is always 16 kHz mono. */
  sampleRate: 16000;
  log(message: string): void;
}

/** Names a hearing engine: the module whose default export creates it, and its options. */
export interface EngineSpec<O extends object = object> {
  /** For logs, and to tell when a change needs a restart. */
  name: string;
  /** A file:// URL (or anything import() takes). */
  module: string;
  /** Passed to the module's factory; must survive structured cloning. */
  options: O;
  downloads?: ModelDownload[];
}

// --- speech to text ------------------------------------------------------------------------------

/** One utterance being transcribed. */
export interface SttStream {
  /** More audio (16 kHz mono, -1…1). Called every 32 ms or so, so keep it quick. */
  accept(samples: Float32Array): void;
  /**
   * The words so far. A streaming engine updates this as audio arrives: interruptions, the
   * transcript wake word and live captions depend on it. Others can return "" until finish().
   */
  text(): string;
  /**
   * The utterance is over: the final text. trailingSilence: samples of silence already at the
   * end of what was accepted (some models need a little more to decode their last chunk).
   */
  finish(trailingSilence: number): string;
}

export interface SttEngine {
  createStream(): SttStream;
}

export type SttFactory<O = any> = (options: O, env: EngineEnv) => SttEngine | Promise<SttEngine>;

// --- voice activity ------------------------------------------------------------------------------

export interface VadStream {
  /** One window of windowSize samples; true while speech is going on. */
  accept(window: Float32Array): boolean;
  reset(): void;
}

export interface VadEngine {
  /** Samples per accept() call. */
  windowSize: number;
  /** minSilenceMs: how long speech must stop before accept() says it has. */
  createStream(o: { minSilenceMs: number }): VadStream;
}

export type VadFactory<O = any> = (options: O, env: EngineEnv) => VadEngine | Promise<VadEngine>;

// --- end of turn ---------------------------------------------------------------------------------

/** Judges a pause: is the speaker done? Runs in a thread of its own, so it never waits behind decoding. */
export interface TurnEngine {
  /** The utterance's audio, up to its last 8 seconds; the probability that the turn is complete. */
  judge(audio: Float32Array): number | Promise<number>;
}

export type TurnFactory<O = any> = (options: O, env: EngineEnv) => TurnEngine | Promise<TurnEngine>;

// --- keyword spotting (wake words) ---------------------------------------------------------------

export interface KwsStream {
  /** More audio; the keyword when one was just spotted. */
  accept(samples: Float32Array): string | null;
  reset(): void;
}

export interface KwsEngine {
  createStream(): KwsStream;
}

/** Keyword spotter options always include the agent's wake keywords. */
export interface KwsOptions {
  keywords: string[];
  boost: number;
  threshold: number;
}

export type KwsFactory<O = any> = (options: O & KwsOptions, env: EngineEnv) => KwsEngine | Promise<KwsEngine>;

export interface KwsSpec<O extends object = object> extends EngineSpec<O> {
  /**
   * A sherpa-onnx zipformer keyword spotter's directory under the models directory. Set, devices
   * can download it and spot the wake word themselves (the web client does, in WebAssembly).
   */
  deviceModel?: string;
}

// --- text to speech ------------------------------------------------------------------------------

export interface SynthesizeOptions {
  voice: string;
  speed: number;
  signal?: AbortSignal;
  /** PCM s16le mono at the engine's sampleRate, a whole number of samples per call. */
  onAudio(pcm: Uint8Array): void;
}

export interface TtsEngine {
  readonly name: string;
  readonly ready: Promise<void>;
  /** Of the PCM it produces; resampled to the protocol's 24 kHz when different. Default 24000. */
  readonly sampleRate?: number;
  /** Resolves with the audio length in ms. */
  synthesize(text: string, o: SynthesizeOptions): Promise<number>;
}

export interface TtsSpec {
  name: string;
  /** Called once at startup. */
  create(env: Omit<EngineEnv, "sampleRate">): TtsEngine;
  downloads?: ModelDownload[];
  /** Changes when a restart is needed for new settings to apply (default: name). */
  key?: string;
}
