// The hearing worker: voice detection, streaming speech to text and end-of-turn detection, off
// the main thread. Each is an engine (see engines/types.ts; defaults Silero, Nemotron 160 ms and
// Smart Turn v3). One recognizer is shared by every device; each device gets its own streams.
import { parentPort, Worker } from "node:worker_threads";
import type { ListenMode } from "../protocol.ts";
import type { EngineEnv, EngineSpec, KwsEngine, KwsStream, SttEngine, SttStream, VadEngine, VadStream } from "../engines/types.ts";
import type { FromHearing, HearingConfig, ToHearing, TurnReason } from "./messages.ts";
import { useSourceConditions } from "../source-conditions.ts";

// engine modules may import "yap-bot"
useSourceConditions();

const SR = 16000;
// Recent audio kept so a new utterance doesn't clip its first word: 0.5 s when the speech detector
// starts one, 1.5 s when the wake word does (the spotter fires after the word, and speech may follow).
const PREROLL_SAMPLES = Math.round(SR * 1.5);
const SPEECH_PREROLL = SR / 2;
// Reaches back past the wake word to the start of the next one (the spotter fires partway into it;
// 0.7 s caught "when's" right after "computer" in tests). Decoding it all at once puts transcription
// behind for a moment (~0.6 s here), which the inbox below keeps from delaying turn decisions.
const KEYWORD_PREROLL = Math.round(SR * 0.8);
const MAX_UTTERANCE_SAMPLES = SR * 30;

const port = parentPort!;
const send = (msg: FromHearing) => port.postMessage(msg);
const now = () => performance.timeOrigin + performance.now();

let config: HearingConfig;
let stt: SttEngine;
let vadEngine: VadEngine;
let turnWorker: Worker | null = null;
let judgeId = 0;
const judgements = new Map<number, (r: { probability?: number; error?: string; ms: number }) => void>();
let spotter: KwsEngine | null = null;

interface Utterance {
  stream: SttStream;
  /** All audio of the utterance (bounded by MAX_UTTERANCE_SAMPLES), for the turn detector. */
  audio: Float32Array[];
  samples: number;
  lastText: string;
  /** Samples of silence since the pause began; null while speaking. */
  silence: number | null;
  speechEndAt: number;
  judging: boolean;
  probability?: number;
  maxLag: number;
}

interface Session {
  sid: string;
  mode: ListenMode;
  vad: VadStream;
  pending: Float32Array; // samples not yet a full VAD window
  /** When the audio being processed arrived; behind now() when the worker lags. */
  audioAt: number;
  preroll: Float32Array; // ring of the most recent audio
  prerollPos: number;
  prerollFull: boolean;
  utt: Utterance | null;
  pushDown: boolean;
  /** Keyword spotter stream, while this device is in wake mode with the spotter on. */
  kws: KwsStream | null;
  /** Transcribe only while awake (the spotter alone decides when to wake). */
  gate: boolean;
  awake: boolean;
}

const sessions = new Map<string, Session>();

async function load<T>(spec: EngineSpec, env: EngineEnv): Promise<T> {
  const factory = (await import(spec.module)).default;
  if (typeof factory !== "function") throw new Error(`engine ${spec.name}: ${spec.module} has no default export to create it`);
  return factory(spec.options, env);
}

async function init(c: HearingConfig) {
  config = c;
  const t0 = now();
  const env = (name: string): EngineEnv => ({ modelsDir: c.modelsDir, sampleRate: SR, log: (m) => send({ type: "error", message: `${name}: ${m}` }) });
  [stt, vadEngine] = await Promise.all([load<SttEngine>(c.stt, env(c.stt.name)), load<VadEngine>(c.vad, env(c.vad.name))]);
  if (c.turnDetector) {
    const w = new Worker(new URL(`./turn-worker${EXT}`, import.meta.url), { workerData: { spec: c.turnDetector, modelsDir: c.modelsDir } });
    await new Promise<void>((resolve, reject) => {
      w.on("message", (m) => {
        if (m.type === "ready") resolve();
        else judgements.get(m.id)?.(m);
      });
      w.on("error", reject);
    });
    turnWorker = w;
  }
  if (c.kws) {
    try {
      spotter = await load<KwsEngine>(c.kws, env(c.kws.name));
    } catch (e) {
      send({ type: "error", message: `keyword spotter: ${(e as Error).message}; wake keywords are off` });
    }
  }
  send({ type: "ready", loadMs: Math.round(now() - t0) });
}

/** .ts from source, .js once built. */
const EXT = import.meta.url.endsWith(".ts") ? ".ts" : ".js";

function open(sid: string, mode: ListenMode, kws: boolean, gate: boolean) {
  sessions.set(sid, {
    kws: kws && spotter ? spotter.createStream() : null,
    gate,
    awake: false,
    sid,
    mode,
    vad: vadEngine.createStream({ minSilenceMs: config.pauseMs }),
    pending: new Float32Array(0),
    audioAt: 0,
    preroll: new Float32Array(PREROLL_SAMPLES),
    prerollPos: 0,
    prerollFull: false,
    utt: null,
    pushDown: false,
  });
}

function prerollAudio(s: Session): Float32Array {
  if (!s.prerollFull) return s.preroll.slice(0, s.prerollPos);
  const out = new Float32Array(PREROLL_SAMPLES);
  out.set(s.preroll.subarray(s.prerollPos), 0);
  out.set(s.preroll.subarray(0, s.prerollPos), PREROLL_SAMPLES - s.prerollPos);
  return out;
}

function remember(s: Session, w: Float32Array) {
  for (let i = 0; i < w.length; i++) {
    s.preroll[s.prerollPos++] = w[i];
    if (s.prerollPos === PREROLL_SAMPLES) {
      s.prerollPos = 0;
      s.prerollFull = true;
    }
  }
}

function startUtterance(s: Session, prerollSamples = SPEECH_PREROLL) {
  const stream = stt.createStream();
  const pre = prerollAudio(s);
  const head = pre.subarray(Math.max(0, pre.length - prerollSamples));
  s.utt = { stream, audio: [], samples: 0, lastText: "", silence: null, speechEndAt: 0, judging: false, maxLag: 0 };
  if (head.length) feed(s, head);
  send({ type: "speech_start", sid: s.sid, at: now() });
}

function feed(s: Session, samples: Float32Array) {
  const u = s.utt!;
  u.stream.accept(samples);
  if (u.samples < MAX_UTTERANCE_SAMPLES) {
    u.audio.push(samples.slice());
    u.samples += samples.length;
  }
  const text = u.stream.text();
  if (text !== u.lastText) {
    u.lastText = text;
    send({ type: "partial", sid: s.sid, text, at: now() });
  }
}

function utteranceAudio(u: Utterance): Float32Array {
  const out = new Float32Array(u.samples);
  let o = 0;
  for (const a of u.audio) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

function finalize(s: Session, reason: TurnReason) {
  const u = s.utt;
  if (!u) return;
  s.utt = null;
  const turnEndAt = now();
  const done = (text: string) =>
    send({
      type: "turn",
      sid: s.sid,
      text: text.trim(),
      reason,
      probability: u.probability,
      audioMs: Math.round((u.samples / SR) * 1000),
      lagMs: Math.round(u.maxLag),
      speechEndAt: u.speechEndAt || turnEndAt,
      turnEndAt,
      finalAt: now(),
    });
  // what was heard so far stands in when the final text can't be had
  const failed = (e: unknown) => {
    send({ type: "error", message: `speech to text: ${(e as Error).message ?? e}` });
    done(u.lastText);
  };
  let text: string | Promise<string>;
  try {
    text = u.stream.finish(u.silence ?? 0);
  } catch (e) {
    return failed(e);
  }
  // a remote service answers later; the next utterance carries on meanwhile
  if (typeof text === "string") done(text);
  else text.then(done, failed);
}

/** Drops an utterance without finishing it. */
function drop(s: Session) {
  s.utt?.stream.close?.();
  s.utt = null;
}

function askTurnDetector(audio: Float32Array): Promise<{ probability?: number; error?: string; ms: number }> {
  const id = ++judgeId;
  return new Promise((resolve) => {
    judgements.set(id, (r) => {
      judgements.delete(id);
      resolve(r);
    });
    turnWorker!.postMessage({ id, audio }, [audio.buffer as ArrayBuffer]);
  });
}

async function judge(s: Session, u: Utterance) {
  u.judging = true;
  const r = await askTurnDetector(utteranceAudio(u).slice(-SR * 8));
  u.judging = false;
  if (r.error !== undefined || r.probability === undefined) {
    send({ type: "error", message: `turn detector: ${r.error}` });
    return;
  }
  u.probability = r.probability;
  send({ type: "judged", sid: s.sid, probability: r.probability, ms: Math.round(r.ms), at: now() });
  // still the same utterance, and still paused: a complete turn ends here; an incomplete one whose
  // wait ran out while the verdict was coming ends now too
  if (s.utt === u && u.silence !== null) {
    if (r.probability >= config.threshold) finalize(s, "smart_turn");
    else if (u.silence >= (config.incompleteWaitMs / 1000) * SR) finalize(s, "silence");
  }
}

function spot(s: Session, w: Float32Array) {
  const keyword = s.kws!.accept(w);
  if (!keyword) return;
  send({ type: "keyword", sid: s.sid, keyword, at: now() });
  // gated: start transcribing right after the wake word, so "computer, what time is it" is heard
  if (s.gate && !s.awake) {
    s.awake = true;
    if (!s.utt && s.mode !== "push") startUtterance(s, KEYWORD_PREROLL);
  }
}

function onWindow(s: Session, w: Float32Array) {
  // awake, a keyword changes nothing; spotting on top of transcribing would keep this worker behind
  if (s.kws && !s.awake) spot(s, w);
  const speaking = s.vad.accept(w);

  if (s.mode === "push") {
    if (s.utt) feed(s, w);
    remember(s, w);
    return;
  }

  if (!s.utt) {
    if (speaking && (!s.gate || s.awake)) {
      startUtterance(s);
      feed(s, w);
    }
    remember(s, w);
    return;
  }

  const u = s.utt;
  feed(s, w);
  remember(s, w);
  if (speaking) {
    u.silence = null; // speech resumed: an incomplete pause is forgotten
  } else if (u.silence === null) {
    // the detector reports silence only after pauseMs of it
    u.silence = Math.round((config.pauseMs / 1000) * SR);
    u.speechEndAt = s.audioAt - config.pauseMs;
    if (turnWorker && !u.judging) void judge(s, u);
  } else {
    u.silence += w.length;
    // a verdict on its way decides instead (it can sit behind queued audio when the worker lags);
    // twice the wait caps a check that never comes back
    const waited = u.silence >= (config.incompleteWaitMs / 1000) * SR;
    if (waited && (!u.judging || u.silence >= (2 * config.incompleteWaitMs / 1000) * SR)) finalize(s, "silence");
  }
  if (s.utt === u && u.samples >= MAX_UTTERANCE_SAMPLES) finalize(s, "max_length");
}

function onAudio(s: Session, pcm: Int16Array, sentAt: number) {
  s.audioAt = sentAt;
  if (s.utt) s.utt.maxLag = Math.max(s.utt.maxLag, Date.now() - sentAt);
  const f = new Float32Array(s.pending.length + pcm.length);
  f.set(s.pending);
  for (let i = 0; i < pcm.length; i++) f[s.pending.length + i] = pcm[i] / 32768;
  let o = 0;
  const n = vadEngine.windowSize;
  for (; o + n <= f.length; o += n) onWindow(s, f.subarray(o, o + n));
  s.pending = f.slice(o);
}

// Messages are queued and worked through in short slices that yield in between. Node hands a port's
// whole backlog (up to 1000 messages) to the handler before any other port gets a turn, so while
// transcription was behind, Smart Turn's verdicts waited behind every queued audio frame: the turn
// then ended on the silence timeout, a second or more late. Queuing everything (not just audio)
// keeps push, awake and mode changes in order with the audio around them.
const inbox: ToHearing[] = [];
let draining = false;

port.on("message", (msg: ToHearing) => {
  if (msg.type === "init") return void init(msg.config).catch((e) => send({ type: "error", message: (e as Error).stack ?? String(e) }));
  inbox.push(msg);
  if (!draining) {
    draining = true;
    setImmediate(drain);
  }
});

function drain() {
  const start = performance.now();
  // about one audio frame's worth of work, then let other messages (verdicts) in
  while (inbox.length && performance.now() - start < 15) handle(inbox.shift()!);
  if (inbox.length) setImmediate(drain);
  else draining = false;
}

function handle(msg: ToHearing) {
  try {
    if (msg.type === "init") return;
    if (msg.type === "open") return open(msg.sid, msg.mode, msg.kws, msg.gate);
    const s = sessions.get(msg.sid);
    if (!s) return;
    switch (msg.type) {
      case "audio":
        onAudio(s, msg.pcm, msg.sentAt);
        break;
      case "awake":
        // back to sleep: the spotter starts fresh rather than from audio it skipped mid-word
        if (!msg.awake && s.awake && s.kws) s.kws.reset();
        // the device spots the wake word itself and stops sending audio when asleep: what was left
        // of an utterance won't be finished, and what came before the wake is from another time
        if (s.gate && !s.kws && (msg.listen || !msg.awake)) {
          drop(s);
          s.pending = new Float32Array(0);
          s.prerollPos = 0;
          s.prerollFull = false;
          s.vad.reset();
        }
        s.awake = msg.awake;
        // its first audio is the wake word's tail and whatever follows: all of it is the utterance
        if (msg.listen && msg.awake && s.mode !== "push") startUtterance(s, 0);
        break;
      case "mode":
        if (s.utt && msg.mode !== s.mode) drop(s);
        s.mode = msg.mode;
        if (msg.kws && spotter && !s.kws) s.kws = spotter.createStream();
        if (!msg.kws) s.kws = null;
        s.gate = msg.gate;
        break;
      case "push":
        if (s.mode !== "push") break;
        if (msg.down && !s.utt) startUtterance(s, SR / 5);
        if (!msg.down && s.utt) {
          s.utt.speechEndAt = now();
          finalize(s, "push");
        }
        s.pushDown = msg.down;
        break;
      case "close":
        drop(s);
        sessions.delete(msg.sid);
        break;
    }
  } catch (e) {
    send({ type: "error", message: (e as Error).stack ?? String(e) });
  }
}
