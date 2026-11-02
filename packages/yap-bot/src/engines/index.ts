// The built-in engines, as specs for defineVoice. Each one lists the model files it needs, which
// `yap-bot models` (and starting the server) download into the models directory.
//
//   defineVoice({
//     stt: nemotron({ threads: 2 }),
//     vad: silero(),
//     turn: { detector: smartTurn() },
//     wake: { spotter: sherpaKws() },
//     tts: { engine: kokoro({ threads: 4 }), voice: "af_heart", speed: 1.2 },
//   })
//
// Speech in and out can also come from services elsewhere: openaiTranscription(), wyomingStt() and
// sherpaWebsocket() for speech to text, openaiSpeech() and wyomingTts() for speech.
import type { EngineSpec, KwsSpec, ModelDownload, TtsSpec } from "./types.ts";
import type { SherpaSttOptions } from "./sherpa-stt.ts";
import type { SileroVadOptions } from "./silero-vad.ts";
import type { SmartTurnOptions } from "./smart-turn.ts";
import type { SherpaKwsOptions } from "./sherpa-kws.ts";
import { KokoroLocal } from "../speech/kokoro.ts";
import { OpenAiSpeech, type OpenAiSpeechOptions } from "../speech/openai-speech.ts";
import { WyomingSpeech, type WyomingSpeechOptions } from "../speech/wyoming-speech.ts";
import type { OpenAiSttOptions } from "./openai-stt.ts";
import type { WyomingSttOptions } from "./wyoming-stt.ts";
import type { SherpaWsSttOptions } from "./sherpa-ws-stt.ts";

export type * from "./types.ts";
export type { SherpaSttOptions, SileroVadOptions, SmartTurnOptions, SherpaKwsOptions, OpenAiSpeechOptions, OpenAiSttOptions, WyomingSttOptions, SherpaWsSttOptions, WyomingSpeechOptions };
export { WyomingClient, type WyomingEvent } from "./wyoming.ts";

/** A module next to this one: .ts from source, .js once built. */
const builtin = (name: string) => new URL(`./${name}${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url).href;

const SHERPA_RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

/** A sherpa-onnx release archive that unpacks into a directory of the same name. */
function sherpaArchive(kind: "asr-models" | "kws-models", dir: string, prune: string[] = []): ModelDownload {
  return { path: dir, url: `${SHERPA_RELEASES}/${kind}/${dir}.tar.bz2`, extract: true, prune: [`${dir}/test_wavs`, ...prune.map((p) => `${dir}/${p}`)] };
}

// --- speech to text ------------------------------------------------------------------------------

const NEMOTRON = "sherpa-onnx-nemotron-speech-streaming-en-0.6b-160ms-int8-2026-04-25";

/** Nemotron Speech Streaming 0.6B (English), 160 ms chunks: the default. */
export function nemotron(o: { threads?: number } = {}): EngineSpec<SherpaSttOptions> {
  return sherpaStt({ model: NEMOTRON, featureDim: 128, threads: o.threads ?? 2, padMs: 300, download: sherpaArchive("asr-models", NEMOTRON) });
}

/**
 * Any sherpa-onnx streaming transducer (zipformer, Nemotron…) from
 * https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/ — e.g. other languages.
 * `model` is its directory name; `download` defaults to sherpa-onnx's release of that name.
 */
export function sherpaStt(o: { model: string; featureDim?: number; threads?: number; padMs?: number; download?: ModelDownload | false }): EngineSpec<SherpaSttOptions> {
  const download = o.download === false ? undefined : (o.download ?? sherpaArchive("asr-models", o.model));
  return {
    name: `sherpa-stt ${o.model}`,
    module: builtin("sherpa-stt"),
    options: { model: o.model, featureDim: o.featureDim ?? 80, threads: o.threads ?? 2, padMs: o.padMs ?? 300 },
    downloads: download ? [download] : [],
  };
}

/** "tcp://host:10300" or "host:10300" → host and port. */
function hostPort(uri: string): { host: string; port: number } {
  const m = /^(?:tcp:\/\/)?\[?([^\]]+?)\]?:(\d+)\/?$/.exec(uri.trim());
  if (!m) throw new Error(`expected host:port (or tcp://host:port), got "${uri}"`);
  return { host: m[1], port: Number(m[2]) };
}

/**
 * A service elsewhere with an OpenAI-compatible transcription endpoint: OpenAI, Groq,
 * faster-whisper-server / speaches, LocalAI… The final text comes when the utterance ends, so
 * talking over a reply interrupts it then, unless `partialEveryMs` also transcribes the audio so
 * far that often for live words (more requests).
 */
export function openaiTranscription(o: Partial<OpenAiSttOptions> & Pick<OpenAiSttOptions, "baseUrl" | "model">): EngineSpec<OpenAiSttOptions> {
  return {
    name: `openai-transcription ${o.model} (${o.baseUrl})`,
    module: builtin("openai-stt"),
    options: { partialEveryMs: 0, timeoutMs: 15_000, ...o },
  };
}

/**
 * A Wyoming speech to text server (wyoming-faster-whisper and others Home Assistant uses):
 * `wyomingStt({ uri: "tcp://whisper.lan:10300" })`. Audio streams as you talk; the text comes
 * when the utterance ends (live words if the server streams them).
 */
export function wyomingStt(o: { uri: string; language?: string; timeoutMs?: number }): EngineSpec<WyomingSttOptions> {
  return { name: `wyoming-stt ${o.uri}`, module: builtin("wyoming-stt"), options: { ...hostPort(o.uri), language: o.language, timeoutMs: o.timeoutMs ?? 15_000 } };
}

/** A sherpa-onnx streaming WebSocket server, with live words: `sherpaWebsocket({ url: "ws://asr.lan:6006" })`. */
export function sherpaWebsocket(o: { url: string; padMs?: number; timeoutMs?: number }): EngineSpec<SherpaWsSttOptions> {
  return { name: `sherpa-websocket ${o.url}`, module: builtin("sherpa-ws-stt"), options: { url: o.url, padMs: o.padMs ?? 300, timeoutMs: o.timeoutMs ?? 5000 } };
}

// --- voice activity ------------------------------------------------------------------------------

export function silero(o: { threshold?: number; minSpeechMs?: number } = {}): EngineSpec<SileroVadOptions> {
  return {
    name: "silero-vad",
    module: builtin("silero-vad"),
    options: { model: "silero_vad.onnx", threshold: o.threshold ?? 0.5, minSpeechMs: o.minSpeechMs ?? 150 },
    downloads: [{ path: "silero_vad.onnx", url: `${SHERPA_RELEASES}/asr-models/silero_vad.onnx` }],
  };
}

// --- end of turn ---------------------------------------------------------------------------------

/** Pipecat's Smart Turn v3.2 (CPU build): judges from the audio whether a pause ends the turn. */
export function smartTurn(): EngineSpec<SmartTurnOptions> {
  const model = "smart-turn-v3.2-cpu.onnx";
  return {
    name: "smart-turn-v3.2",
    module: builtin("smart-turn"),
    options: { model },
    downloads: [{ path: model, url: `https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/${model}` }],
  };
}

// --- keyword spotting ----------------------------------------------------------------------------

const GIGASPEECH_KWS = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";

/**
 * A sherpa-onnx zipformer keyword spotter (default: GigaSpeech English, 3.3M params). Devices that
 * can (the web client) download it and spot the wake word themselves.
 */
export function sherpaKws(o: { model?: string; download?: ModelDownload | false } = {}): KwsSpec<SherpaKwsOptions> {
  const model = o.model ?? GIGASPEECH_KWS;
  const download =
    o.download === false ? undefined : (o.download ?? sherpaArchive("kws-models", model, model === GIGASPEECH_KWS ? ["*epoch-12-avg-2-chunk-16-left-64.onnx"] : []));
  return { name: `sherpa-kws ${model}`, module: builtin("sherpa-kws"), options: { model }, downloads: download ? [download] : [], deviceModel: model };
}

// --- text to speech ------------------------------------------------------------------------------

const KOKORO = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main";

/** Voices fetched by default; any of Kokoro's others can be listed in `voices`. */
export const KOKORO_VOICES = ["af_heart", "af_bella", "af_nicole", "am_michael", "am_fenrir", "bf_emma", "bm_george"];

/**
 * Kokoro 82M v1.0 in process (onnxruntime, its own thread), with kokoro-js's pronunciation: the
 * default. American (a…) and British (b…) English voices.
 */
export function kokoro(o: { threads?: number; voices?: string[] } = {}): TtsSpec {
  const threads = o.threads ?? 4;
  const voices = o.voices ?? KOKORO_VOICES;
  return {
    name: "kokoro",
    key: `kokoro:${threads}`,
    create: (env) => new KokoroLocal(env.modelsDir, threads, voices[0]),
    downloads: [
      { path: "kokoro/model.onnx", url: `${KOKORO}/onnx/model.onnx` },
      { path: "kokoro/tokenizer.json", url: `${KOKORO}/tokenizer.json` },
      ...voices.map((v) => ({ path: `kokoro/voices/${v}.bin`, url: `${KOKORO}/voices/${v}.bin` })),
    ],
  };
}

/**
 * An OpenAI-compatible speech endpoint that streams PCM: Kokoro-FastAPI (the defaults), OpenAI
 * (`{ baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-tts", apiKey }`), and the like.
 */
export function openaiSpeech(o: Partial<OpenAiSpeechOptions> & Pick<OpenAiSpeechOptions, "baseUrl">): TtsSpec {
  const options: OpenAiSpeechOptions = { model: "kokoro", sampleRate: 24000, ...o };
  return { name: "openai-speech", key: `openai-speech:${options.baseUrl}:${options.model}`, create: () => new OpenAiSpeech(options) };
}

/**
 * A Wyoming speech server (wyoming-piper and others Home Assistant uses):
 * `wyomingTts({ uri: "tcp://piper.lan:10200" })`, with tts.voice (or `voice` here) the server's voice
 * name. Speed is the server's to set (piper's --length-scale): tts.speed doesn't apply.
 */
export function wyomingTts(o: { uri: string; voice?: string; speaker?: string; timeoutMs?: number }): TtsSpec {
  const options: WyomingSpeechOptions = { ...hostPort(o.uri), voice: o.voice, speaker: o.speaker, timeoutMs: o.timeoutMs ?? 30_000 };
  return { name: "wyoming-tts", key: `wyoming-tts:${o.uri}`, create: () => new WyomingSpeech(options) };
}

/** Every built-in engine's default spec, for `yap-bot models --defaults`. */
export function defaultEngines() {
  return { stt: nemotron(), vad: silero(), turn: smartTurn(), kws: sherpaKws(), tts: kokoro() };
}
