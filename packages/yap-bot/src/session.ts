// One connected device: hearing in, turns through the agent, speech out, interruptions.
//
//   idle ─wake/press─▶ listening ─turn end─▶ thinking ─first audio─▶ speaking ─played─▶ listening
//                          ▲                     │                       │
//                          └──── talking over it (interruption) ◀────────┘
import type { WebSocket } from "ws";
import {
  decodeBinary,
  encodeTts,
  type ClientMessage,
  type ListenMode,
  type ServerMessage,
  type SessionState,
  type WakeDetector,
  type TimelineMark,
  type LlmStats,
} from "./protocol.ts";
import type { Device, FastpathDefinition } from "./define.ts";
import type { HearingEvent } from "./hearing/hearing.ts";
import type { Hub } from "./hub.ts";
import { prefill, runLoop } from "./agent/loop.ts";
import { LOAD_SKILL, trimHistory, userMessage } from "./agent/prompt.ts";
import { summarize } from "./agent/loader.ts";
import { Priority } from "./llm/client.ts";
import { SentenceSplitter } from "./speech/splitter.ts";
import { log } from "./log.ts";

interface Chunk {
  id: number;
  text: string;
  synthesized: boolean;
  durationMs: number;
  playedMs: number;
  done: boolean;
}

interface Turn {
  id: number;
  kind: "turn" | "announce";
  userText: string;
  /** Went through the model, so its reply belongs in the history. */
  usedLlm: boolean;
  abort: AbortController;
  marks: TimelineMark[];
  chunks: Chunk[];
  queue: { text: string; speed?: number }[];
  synthesizing: boolean;
  /** No more text will be added to the queue. */
  textDone: boolean;
  finalText: string;
  stats?: LlmStats;
  finished: boolean;
  safety?: NodeJS.Timeout;
  /** An ack was said for a tool call; the reply's own "OK," is then dropped. */
  acked: boolean;
  leadChecked: boolean;
  /** The conversation is over: go back to sleep (wake mode) instead of the follow-up window. */
  sleep: boolean;
}

/** How many of the latest acks a new one avoids repeating (when the tool has others to pick). */
const RECENT_ACKS = 4;

const normalize = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
const wordCount = (t: string) => normalize(t).split(" ").filter(Boolean).length;

/** "OK, I've set…" → "I've set…" (after an ack already said it); "Okay." → "". */
export function dropLeadingAck(text: string): string {
  const rest = text.replace(/^\s*(?:ok(?:ay)?|sure(?: thing)?|alright|all right|(?:you )?got it|on it|will do)\b[\s,.!-]*/i, "");
  return rest === text ? text : rest.charAt(0).toUpperCase() + rest.slice(1);
}

function matchFastpath(def: FastpathDefinition, text: string): RegExpMatchArray | null | false {
  const m = def.match;
  if (typeof m === "string") return text === normalize(m) ? null : false;
  if (Array.isArray(m)) return m.some((p) => text === normalize(p)) ? null : false;
  if (m instanceof RegExp) return text.match(m) ?? false;
  return m(text) ? null : false;
}

export class Session {
  readonly sid: string;
  device: Device;
  private mode: ListenMode;
  private interruptions: boolean;
  private detector: WakeDetector;
  /** When the current utterance started, and when the keyword spotter last woke us. */
  private speechStartAt = 0;
  private keywordAt = 0;
  /** Smart Turn's verdicts on this utterance's pauses, for the turn's timeline. */
  private judgedMarks: TimelineMark[] = [];
  /** Playback held because someone started talking over the reply. */
  private paused = false;
  private pauseTimer?: NodeJS.Timeout;
  /** Reading the prompt during speech: the request in flight, the text it read, the newest text. */
  private prefilling: AbortController | null = null;
  private prefilled = "";
  private prefillNext = "";
  private prefillCount = 0;
  private state: SessionState = "idle";
  private awake = false;
  private followUp?: NodeJS.Timeout;
  private turnSeq = 0;
  private chunkSeq = 0;
  /** Acks said lately, newest last, so the next one isn't a repeat. */
  private recentAcks: string[] = [];
  private turn: Turn | null = null;
  private pending: { text: string; source: string }[] = [];
  private hub: Hub;
  private ws: WebSocket;

  constructor(hub: Hub, ws: WebSocket, sid: string, hello: Extract<ClientMessage, { type: "hello" }>) {
    this.hub = hub;
    this.ws = ws;
    this.sid = sid;
    this.device = { id: hello.deviceId, room: hello.room?.trim() || "default" };
    this.mode = hello.mode;
    this.interruptions = hello.interruptions ?? true;
    this.detector = hello.wakeDetector ?? "both";
    hub.hearing.open(sid, this.mode, this.spotting(), this.gated(), (ev) => this.onHearing(ev));
    const { agent } = hub.reg;
    this.send({
      type: "welcome",
      deviceId: this.device.id,
      room: this.device.room,
      agent: agent.name,
      ui: agent.ui,
      wakeWord: agent.wake.word,
      deviceWake: hub.deviceWake,
      followUpMs: agent.followUpMs,
      serverTime: Date.now(),
      capabilities: summarize(hub.reg),
    });
    this.setState(this.mode === "wake" ? "idle" : "listening");
  }

  // --- transport -------------------------------------------------------------------------

  send(msg: ServerMessage) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private sendAudio(chunkId: number, pcm: Uint8Array) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(encodeTts(chunkId, pcm));
  }

  onBinary(data: Buffer) {
    const msg = decodeBinary(data);
    if (msg?.kind === "mic") this.hub.hearing.audio(this.sid, msg.pcm);
  }

  onMessage(msg: ClientMessage) {
    switch (msg.type) {
      case "mode":
        this.mode = msg.mode;
        if (msg.interruptions !== undefined) this.interruptions = msg.interruptions;
        if (msg.wakeDetector) this.detector = msg.wakeDetector;
        this.hub.hearing.mode(this.sid, msg.mode, this.spotting(), this.gated());
        this.setAwake(false);
        clearTimeout(this.followUp);
        if (!this.turn) this.setState(msg.mode === "wake" ? "idle" : "listening");
        break;
      case "wake":
        this.onDeviceWake(msg.keyword);
        break;
      case "push":
        if (msg.down && this.turn) this.interrupt();
        this.hub.hearing.push(this.sid, msg.down);
        if (msg.down) this.setState("listening");
        break;
      case "playback":
        this.onPlayback(msg.chunkId, msg.playedMs, msg.done);
        break;
      case "text":
        if (this.turn) this.interrupt();
        if (msg.text.trim()) this.startTurn(msg.text.trim(), []);
        break;
      case "interrupt":
        this.interrupt();
        break;
      case "reset":
        this.interrupt();
        this.hub.histories.set(this.device.id, []);
        break;
    }
  }

  close() {
    this.turn?.abort.abort();
    this.stopPrefill();
    clearTimeout(this.followUp);
    this.hub.hearing.close(this.sid);
  }

  private setState(state: SessionState) {
    this.state = state;
    this.send({ type: "state", state, awake: this.mode === "wake" ? this.awake : undefined });
  }

  // --- hearing ---------------------------------------------------------------------------

  /** The server's keyword spotter listens to this device's audio. */
  private spotting() {
    return this.mode === "wake" && (this.detector === "keyword" || this.detector === "both");
  }

  /** A spotter (here or on the device) alone decides when to wake, so nothing needs transcribing until then. */
  private gated() {
    return this.mode === "wake" && (this.detector === "keyword" || this.detector === "device");
  }

  /** Asleep, a transcript that starts with the wake word wakes it. */
  private transcriptWakes() {
    return this.detector === "transcript" || this.detector === "both";
  }

  /** listen: the device woke itself and sends its audio from just before the wake word. */
  private setAwake(awake: boolean, listen = false) {
    if (this.awake === awake) return;
    this.awake = awake;
    this.hub.hearing.awake(this.sid, awake, listen);
  }

  private accepting(text = ""): boolean {
    return this.mode !== "wake" || this.awake || (this.transcriptWakes() && this.wakeMatch(text) !== null);
  }

  /** The device spotted the wake word itself. The answer ("heard") tells it whether to stream. */
  private onDeviceWake(keyword: string) {
    if (this.mode !== "wake" || this.detector !== "device" || this.awake || this.turn) {
      // already awake: carry on as it is (the device streams while the state says awake)
      this.send({ type: "heard", text: keyword, woke: this.awake });
      if (!this.awake) this.setState(this.state);
      return;
    }
    this.keywordAt = Date.now();
    this.wakeUp("device", keyword, true);
    clearTimeout(this.followUp);
    this.setState("listening");
  }

  private wakeUp(by: "transcript" | "keyword" | "device", heard: string, listen = false) {
    this.setAwake(true, listen);
    this.send({ type: "heard", text: heard, woke: true, by });
    log.info(`[${this.device.id}] woke by ${by}: "${heard}"`);
  }

  /** anchored: as configured (usually the start of the text); otherwise anywhere in the first words. */
  private wakeMatch(text: string, anchored = true): RegExpExecArray | null {
    const { word, match } = this.hub.reg.agent.wake;
    const re = match ?? new RegExp(word.split("").join("[\\s-]*"), "i");
    const source = anchored ? re.source : re.source.replace(/^\^(\\s\*)?/, "");
    const m = new RegExp(source, re.flags.replace("g", "")).exec(text);
    return m && (anchored || wordCount(text.slice(0, m.index)) <= 4) ? m : null;
  }

  private onHearing(ev: HearingEvent) {
    switch (ev.type) {
      case "speech_start":
        this.speechStartAt = ev.at;
        this.judgedMarks = [];
        if (this.awake) clearTimeout(this.followUp);
        this.maybePause();
        break;
      case "keyword":
        if (this.mode !== "wake" || this.awake || this.turn) break;
        this.keywordAt = ev.at;
        this.wakeUp("keyword", "(keyword spotter)");
        clearTimeout(this.followUp);
        this.setState("listening");
        break;
      case "partial": {
        if (this.turn && this.interruptions && this.accepting(ev.text) && wordCount(ev.text) >= this.hub.reg.voice.interruptions.minWords) {
          log.info(`[${this.device.id}] interrupted by "${ev.text}"`);
          this.interrupt();
        }
        if (!this.turn && this.accepting(ev.text)) {
          this.send({ type: "transcript", turnId: this.turnSeq + 1, text: ev.text, final: false });
          this.prefill(ev.text);
        }
        break;
      }
      case "judged":
        this.judgedMarks.push({ name: "judged", at: ev.at, detail: `p=${ev.probability?.toFixed(2)} in ${ev.ms} ms` });
        break;
      case "turn": {
        let text = ev.text;
        // an engine without live words (a batch service) only now says what was said over the reply
        if (this.turn && text && this.interruptions && this.accepting(text) && wordCount(text) >= this.hub.reg.voice.interruptions.minWords) {
          log.info(`[${this.device.id}] interrupted by "${text}" (once it was transcribed)`);
          this.interrupt();
        }
        // still answering: talk over it that didn't interrupt (too short, or interruptions off) is dropped
        if (this.turn || !text) {
          if (this.turn) this.resume();
          else this.afterTurnState();
          return;
        }
        if (this.mode === "wake") {
          const m = this.wakeMatch(text);
          // the spotter woke us during this utterance: it holds the wake word, maybe misheard
          // (when the spotter starts the utterance itself, speech_start comes just after the keyword)
          const spotted = this.keywordAt > 0 && this.speechStartAt - this.keywordAt < 1500;
          if (!this.awake) {
            if (!m || !this.transcriptWakes()) {
              this.send({ type: "heard", text, woke: false });
              return;
            }
            this.wakeUp("transcript", text);
          }
          // with the spotter, the transcript starts from buffered audio: the wake word may sit after a few
          // earlier words, so look for it anywhere near the start
          const w = m ?? (spotted ? this.wakeMatch(text, false) : null);
          if (w) text = text.slice(w.index + w[0].length).replace(/^[\s,.!?;:-]+/, "");
          else if (spotted && wordCount(text) <= 2) text = ""; // just the wake word, transcribed as something else
          this.keywordAt = 0;
          if (!text) {
            this.send({ type: "transcript", turnId: this.turnSeq + 1, text: "", final: false });
            this.afterTurnState();
            return;
          }
        }
        const marks: TimelineMark[] = [
          ...this.judgedMarks,
          { name: "speech_end", at: ev.speechEndAt },
          { name: "turn_end", at: ev.turnEndAt, detail: `${ev.reason}${ev.probability !== undefined ? ` p=${ev.probability.toFixed(2)}` : ""}` },
          { name: "stt_final", at: ev.finalAt, detail: `max lag ${ev.lagMs} ms` },
        ];
        this.startTurn(text, marks);
        break;
      }
    }
  }

  // --- turns -----------------------------------------------------------------------------

  private newTurn(kind: Turn["kind"], userText: string, marks: TimelineMark[]): Turn {
    const turn: Turn = {
      id: ++this.turnSeq,
      kind,
      userText,
      usedLlm: false,
      abort: new AbortController(),
      marks,
      chunks: [],
      queue: [],
      synthesizing: false,
      textDone: false,
      finalText: "",
      finished: false,
      acked: false,
      leadChecked: false,
      sleep: false,
    };
    this.turn = turn;
    return turn;
  }

  private startTurn(raw: string, marks: TimelineMark[]) {
    const reg = this.hub.reg;
    const hooked = reg.voice.hooks.beforeTurn?.(raw, this.device);
    if (hooked === null) return;
    const text = typeof hooked === "string" ? hooked : raw;

    const prefills = this.prefillCount;
    this.stopPrefill();
    const turn = this.newTurn("turn", text, marks);
    if (prefills) turn.marks.push({ name: "prefilled", at: Date.now(), detail: `${prefills} reads during speech` });
    this.send({ type: "transcript", turnId: turn.id, text, final: true });
    this.setState("thinking");
    void this.runTurn(turn).catch((e) => {
      if (turn.abort.signal.aborted) return;
      log.error(`[${this.device.id}] turn ${turn.id} failed`, e);
      this.send({ type: "error", message: (e as Error).message });
      this.say(turn, reg.voice.phrases.error);
      this.endText(turn);
    });
  }

  private toolContext(turn: Turn) {
    return {
      device: this.device,
      timezone: this.hub.reg.agent.timezone,
      timers: this.hub.timers,
      signal: turn.abort.signal,
      say: (t: string) => this.say(turn, t),
      sleep: () => void (turn.sleep = true),
      announce: (t: string, o?: { room?: string }) => this.hub.announce(t, { room: o?.room, deviceId: o?.room ? undefined : this.device.id }, "tool"),
      log: (...a: unknown[]) => log.info(`[${this.device.id}]`, ...a),
    };
  }

  private async runTurn(turn: Turn) {
    const reg = this.hub.reg;
    const ntext = normalize(turn.userText);

    for (const { name, def } of reg.fastpaths) {
      const match = matchFastpath(def, ntext);
      if (match === false) continue;
      this.mark(turn, "fastpath", name);
      const reply = await def.run({ ...this.toolContext(turn), store: this.hub.storeFor(`fastpath-${name}`), text: ntext, raw: turn.userText, match });
      if (reply) {
        turn.finalText = reply;
        this.say(turn, reply);
      }
      this.endText(turn);
      return;
    }

    turn.usedLlm = true;
    const history = this.history();
    history.push(userMessage(reg, this.device, turn.userText));
    const splitter = new SentenceSplitter((piece) => {
      if (turn.acked && !turn.leadChecked) {
        turn.leadChecked = true;
        piece = dropLeadingAck(piece);
        if (!piece.trim()) return;
      }
      if (!turn.chunks.length && !turn.queue.length) this.mark(turn, "first_sentence");
      this.say(turn, piece);
    });
    this.mark(turn, "llm_request");
    const result = await runLoop({
      reg,
      llm: this.hub.llm,
      priority: Priority.Conversation,
      history: [...history],
      ctx: this.toolContext(turn),
      storeFor: (name) => this.hub.storeFor(name),
      events: {
        onText: (d) => splitter.push(d),
        onFirstToken: (at) => turn.marks.push({ name: "llm_first_token", at }),
        onToolCalling: (name) => this.ack(turn, name),
        onToolStart: (name, input) => this.mark(turn, "tool_start", name) && this.send({ type: "tool", turnId: turn.id, name, input }),
        onToolEnd: (name, input, r) => this.send({ type: "tool", turnId: turn.id, name, input, output: r.output, error: r.error, ms: r.ms }),
        onMessage: (m) => history.push(m),
      },
    });
    if (turn.abort.signal.aborted) return;
    splitter.flush();
    // the model sometimes ends with nothing to say (e.g. searches that didn't have the answer);
    // silence after an ack sounds broken, so say so
    const saidOnlyAck = turn.chunks.length + turn.queue.length <= (turn.acked ? 1 : 0);
    if (!result.text.trim() && result.stats.rounds > 1 && saidOnlyAck && !turn.sleep) {
      result.text = reg.voice.phrases.noAnswer;
      this.say(turn, result.text);
    }
    turn.finalText = result.text;
    turn.stats = result.stats;
    this.endText(turn);
  }

  /** The model started calling a tool: say its ack now, unless something was said already. */
  private ack(turn: Turn, name: string) {
    if (turn.acked || turn.chunks.length || turn.queue.length) return;
    const reg = this.hub.reg;
    const tool = reg.tools.find((t) => t.name === name);
    // the name may still be streaming in ("set_" before "set_timer"); wait for a whole one
    if (!tool && name !== LOAD_SKILL) return;
    const ack = tool?.def.ack ?? reg.voice.acks.tool;
    if (ack === false) return;
    const choices = [ack].flat();
    if (!choices.length) return;
    const fresh = choices.filter((c) => !this.recentAcks.includes(c));
    const pool = fresh.length ? fresh : choices;
    const said = pool[Math.floor(Math.random() * pool.length)];
    this.recentAcks = [...this.recentAcks.filter((c) => c !== said), said].slice(-RECENT_ACKS);
    turn.acked = true;
    this.mark(turn, "ack", name);
    this.say(turn, said, reg.voice.tts.ackSpeed);
  }

  private mark(turn: Turn, name: string, detail?: string) {
    turn.marks.push({ name, at: Date.now(), detail });
    return true;
  }

  private history() {
    let h = this.hub.histories.get(this.device.id) ?? [];
    h = trimHistory(h, this.hub.reg.agent.historyMessages);
    this.hub.histories.set(this.device.id, h);
    return h;
  }

  // --- speech ----------------------------------------------------------------------------

  private say(turn: Turn, text: string, speed?: number) {
    if (turn.finished || turn.abort.signal.aborted) return;
    turn.queue.push({ text, speed });
    void this.pump(turn);
  }

  private endText(turn: Turn) {
    turn.textDone = true;
    this.checkDone(turn);
  }

  private async pump(turn: Turn) {
    if (turn.synthesizing) return;
    // someone is talking over the reply: leave the CPU to hearing until it's settled
    if (this.paused && this.turn === turn) return;
    const next = turn.queue.shift();
    if (next === undefined) return this.checkDone(turn);
    const { text } = next;
    turn.synthesizing = true;
    const chunk: Chunk = { id: ++this.chunkSeq, text, synthesized: false, durationMs: 0, playedMs: 0, done: false };
    turn.chunks.push(chunk);
    this.send({ type: "assistant", turnId: turn.id, chunkId: chunk.id, text });
    const { voice } = this.hub.reg.voice.tts;
    const speed = next.speed ?? this.hub.reg.voice.tts.speed;
    let first = turn.chunks.length === 1;
    try {
      chunk.durationMs = await this.hub.tts.synthesize(text, {
        voice,
        speed,
        signal: turn.abort.signal,
        onAudio: (pcm) => {
          if (turn.abort.signal.aborted) return;
          if (first) {
            first = false;
            this.mark(turn, "tts_first_audio");
            this.setState("speaking");
          }
          this.sendAudio(chunk.id, pcm);
        },
      });
      chunk.synthesized = true;
      this.send({ type: "tts_end", chunkId: chunk.id, durationMs: chunk.durationMs });
    } catch (e) {
      if (turn.abort.signal.aborted) return;
      log.error(`[${this.device.id}] tts failed`, e);
      chunk.synthesized = true;
      chunk.done = true;
    } finally {
      turn.synthesizing = false;
    }
    void this.pump(turn);
  }

  private onPlayback(chunkId: number, playedMs: number, done: boolean) {
    const turn = this.turn;
    const chunk = turn?.chunks.find((c) => c.id === chunkId);
    if (!turn || !chunk) return;
    if (!turn.marks.some((m) => m.name === "playback_start")) this.mark(turn, "playback_start");
    chunk.playedMs = Math.max(chunk.playedMs, playedMs);
    if (done) {
      chunk.done = true;
      // chunks finish in order
      for (const c of turn.chunks) {
        if (c.id >= chunkId) break;
        c.done = true;
      }
    }
    this.checkDone(turn);
  }

  private checkDone(turn: Turn) {
    if (turn.finished || !turn.textDone || turn.synthesizing || turn.queue.length) return;
    if (turn.chunks.every((c) => c.done)) return this.finish(turn, false);
    // a client that never reports playback mustn't hold the turn forever
    if (!turn.safety && !this.paused) {
      const left = turn.chunks.reduce((ms, c) => ms + (c.done ? 0 : c.durationMs - c.playedMs), 0);
      turn.safety = setTimeout(() => this.finish(turn, false), left + 3000);
    }
  }

  /** What was actually heard: whole played chunks, plus the played share of a cut-off one. */
  private spoken(turn: Turn): string {
    const parts: string[] = [];
    for (const c of turn.chunks) {
      if (c.done) parts.push(c.text);
      else if (c.playedMs > 0 && c.durationMs > 0) {
        const words = c.text.split(/\s+/);
        const n = Math.round(words.length * Math.min(1, c.playedMs / c.durationMs));
        if (n > 0) parts.push(words.slice(0, n).join(" ") + "…");
        break;
      } else break;
    }
    return parts.join(" ");
  }

  interrupt() {
    const turn = this.turn;
    if (!turn) return;
    this.clearPause();
    turn.abort.abort();
    this.send({ type: "stop" });
    this.finish(turn, true);
  }

  private finish(turn: Turn, interrupted: boolean) {
    if (turn.finished) return;
    turn.finished = true;
    if (this.turn === turn) this.clearPause();
    clearTimeout(turn.safety);
    const spoken = this.spoken(turn);
    if (turn.usedLlm) {
      // roles must alternate for some chat templates, so a reply is always recorded
      this.history().push({ role: "assistant", content: spoken || (interrupted ? "(interrupted)" : turn.finalText || "(no reply)") });
    }
    this.send({ type: "turn_done", turnId: turn.id, interrupted, spoken });
    this.send({ type: "metrics", turnId: turn.id, marks: turn.marks, llm: turn.stats });
    if (this.turn === turn) this.turn = null;
    if (turn.kind === "turn") {
      this.hub.reg.voice.hooks.afterTurn?.({ turnId: turn.id, device: this.device, text: turn.userText, spoken, interrupted });
    }
    this.afterTurnState(turn.sleep);
    this.nextAnnouncement();
  }

  private afterTurnState(sleep = false) {
    if (this.turn) return;
    if (this.mode !== "wake") return this.setState("listening");
    if (sleep && this.awake) {
      clearTimeout(this.followUp);
      this.setAwake(false);
      log.info(`[${this.device.id}] conversation over, back to sleep`);
    }
    if (!this.awake) return this.setState("idle");
    this.setState("listening");
    clearTimeout(this.followUp);
    this.followUp = setTimeout(() => {
      this.setAwake(false);
      if (!this.turn) this.setState("idle");
    }, this.hub.reg.agent.followUpMs);
  }

  // --- talking over a reply ---------------------------------------------------------------

  private maybePause() {
    const turn = this.turn;
    const v = this.hub.reg.voice.interruptions;
    if (!turn || this.paused || this.state !== "speaking" || !this.interruptions || !v.pauseOnSpeech) return;
    if (this.mode === "wake" && !this.awake) return;
    this.paused = true;
    clearTimeout(turn.safety);
    turn.safety = undefined;
    this.send({ type: "pause" });
    turn.marks.push({ name: "paused", at: Date.now() });
    // not confirmed as an interruption in time: carry on
    this.pauseTimer = setTimeout(() => this.resume(), 4000);
  }

  private resume() {
    if (!this.paused) return;
    this.clearPause();
    this.send({ type: "resume" });
    if (this.turn) void this.pump(this.turn);
  }

  private clearPause() {
    this.paused = false;
    clearTimeout(this.pauseTimer);
  }

  // --- reading the prompt during speech ----------------------------------------------------

  private prefill(text: string) {
    if (!this.hub.reg.voice.prefill || this.turn || !text) return;
    this.prefillNext = text;
    if (this.prefilling || text === this.prefilled) return;
    const reg = this.hub.reg;
    const abort = new AbortController();
    this.prefilling = abort;
    this.prefilled = text;
    this.prefillCount++;
    const history = [...this.history(), userMessage(reg, this.device, text)];
    prefill(reg, this.hub.llm, history, abort.signal)
      .catch((e) => {
        if (!abort.signal.aborted) log.warn(`[${this.device.id}] prefill failed: ${(e as Error).message}`);
      })
      .finally(() => {
        if (this.prefilling !== abort) return;
        this.prefilling = null;
        // more words arrived while it was reading: read again
        if (this.prefillNext !== this.prefilled) this.prefill(this.prefillNext);
      });
  }

  private stopPrefill() {
    this.prefilling?.abort();
    this.prefilling = null;
    this.prefilled = this.prefillNext = "";
    this.prefillCount = 0;
  }

  // --- announcements ---------------------------------------------------------------------

  announce(text: string, source: string) {
    this.pending.push({ text, source });
    if (!this.turn) this.nextAnnouncement();
  }

  private nextAnnouncement() {
    const next = this.pending.shift();
    if (!next || this.turn) return;
    const turn = this.newTurn("announce", "", []);
    this.send({ type: "announce", text: next.text, source: next.source });
    this.setState("thinking");
    this.say(turn, next.text);
    this.endText(turn);
  }
}
