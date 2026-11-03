// Everything shared between devices: the loaded agent, hearing, the model queue, timers,
// schedules, conversation histories and announcement routing.
import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { WebSocket } from "ws";
import type { ClientMessage, DeviceWakeConfig } from "./protocol.ts";
import type { Store, Timer } from "./define.ts";
import type { KwsOptions, KwsSpec, ModelDownload } from "./engines/types.ts";
import { Hearing } from "./hearing/hearing.ts";
import { findDeviceKwsModel, type DeviceKwsModel } from "./engines/device-kws.ts";
import { downloadModels } from "./models.ts";
import { loadAgent, summarize, watchAgent, type Registry } from "./agent/loader.ts";
import { runLoop, type LoopEvents } from "./agent/loop.ts";
import { userMessage } from "./agent/prompt.ts";
import { LlmQueue, Priority, type ChatMessage } from "./llm/client.ts";
import { TimerService } from "./services/timers.ts";
import { CachedTts } from "./speech/tts.ts";
import { setDataDir, storeFor } from "./services/store.ts";
import { Session } from "./session.ts";
import { Triggers } from "./triggers.ts";
import { log } from "./log.ts";

export interface HubOptions {
  agentDir: string;
  dataDir: string;
  modelsDir: string;
  watch: boolean;
  /** Fetch model files the voice needs that aren't there yet (default true). */
  download?: boolean;
}

/** Everything the voice's engines need downloaded. */
export function voiceDownloads(reg: Registry): ModelDownload[] {
  const v = reg.voice;
  return [
    ...[v.stt, v.vad, v.turn.detector, v.wake.spotter, v.tts.engine].flatMap((e) => (e ? (e.downloads ?? []) : [])),
    ...v.tts.voices.flatMap((c) => v.tts.engine.downloadsFor?.(c.id) ?? []),
  ];
}

export class Hub {
  reg!: Registry;
  hearing!: Hearing;
  tts!: CachedTts;
  readonly llm = new LlmQueue();
  timers!: TimerService;
  readonly sessions = new Map<string, Session>();
  /** Per device id, so a reconnecting device keeps its conversation. */
  readonly histories = new Map<string, ChatMessage[]>();
  readonly triggers = new Triggers(this);
  /** The keyword spotter's model, for devices that spot the wake word themselves. */
  kwsModel: DeviceKwsModel | null = null;
  /** What those devices need; absent without keywords or a model. */
  deviceWake?: DeviceWakeConfig;
  private crons: Cron[] = [];
  private stopWatching?: () => void;
  /** Hearing died after starting: nothing will be heard again. start() exits so a supervisor restarts it. */
  onFatal?: (e: Error) => void;
  private opts: HubOptions;

  private constructor(opts: HubOptions) {
    this.opts = opts;
  }

  static async create(opts: HubOptions): Promise<Hub> {
    const hub = new Hub(opts);
    setDataDir(opts.dataDir);
    hub.reg = await loadAgent(opts.agentDir);
    hub.logAgent();
    const voice = hub.reg.voice;
    if (opts.download !== false) await downloadModels(opts.modelsDir, voiceDownloads(hub.reg));
    const { wake } = hub.reg.agent;
    const kws: KwsSpec<KwsOptions> | undefined =
      voice.wake.spotter && wake.keywords?.length
        ? { ...voice.wake.spotter, options: { ...voice.wake.spotter.options, keywords: wake.keywords, boost: wake.keywordBoost ?? 3, threshold: wake.keywordThreshold ?? 0.05 } }
        : undefined;
    const { detector, ...turn } = voice.turn;
    hub.hearing = new Hearing({ modelsDir: opts.modelsDir, stt: voice.stt, vad: voice.vad, turnDetector: detector || null, ...turn, kws });
    hub.hearing.onCrash = (e) => {
      log.error(`${e.message}: no device can be heard until a restart`);
      for (const s of hub.sessions.values()) s.send({ type: "error", message: "hearing stopped working; the server needs a restart" });
      hub.onFatal?.(e);
    };
    // same keywords and settings as the server's spotter (both apply after a restart)
    hub.kwsModel = kws?.deviceModel ? findDeviceKwsModel(opts.modelsDir, kws.deviceModel) : null;
    if (kws && hub.kwsModel) {
      const { keywords, boost, threshold } = kws.options;
      hub.deviceWake = { keywords, boost, threshold, modelUrl: "/models/kws", modelVersion: hub.kwsModel.version };
    }
    hub.tts = new CachedTts(voice.tts.engine.create({ modelsDir: opts.modelsDir, log: (m) => log.info(`[${voice.tts.engine.name}] ${m}`) }));
    hub.timers = new TimerService(opts.dataDir, (t) => hub.timerDone(t));
    hub.startSchedules();
    hub.triggers.start();
    if (opts.watch) hub.stopWatching = watchAgent(opts.agentDir, () => void hub.reload());
    await Promise.all([hub.hearing.ready, hub.tts.ready]);
    log.info(`speech: ${hub.tts.name}`);
    void hub.warmAcks();
    return hub;
  }

  /** Stops everything it started: schedules, triggers, timers, the file watcher, sessions and the engines. */
  async close() {
    for (const c of this.crons) c.stop();
    this.crons = [];
    this.triggers.stop();
    this.timers.stop();
    this.stopWatching?.();
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
    await Promise.all([this.hearing.terminate(), this.tts.close()]);
  }

  storeFor(name: string): Store {
    return storeFor(this.opts.dataDir, name);
  }

  private logAgent() {
    const r = this.reg;
    log.info(
      `agent "${r.agent.name}": ${r.tools.length} tools [${r.tools.map((t) => t.name).join(", ")}], ` +
        `${r.skills.length} skills, ${r.fastpaths.length} fastpaths, ${r.schedules.length} schedules, ${r.triggers.length} triggers`,
    );
  }

  async reload() {
    try {
      const voiceKey = (r: Registry) =>
        JSON.stringify([r.voice.stt, r.voice.vad, r.voice.turn, r.voice.wake, r.voice.tts.engine.key ?? r.voice.tts.engine.name, r.agent.wake.keywords, r.agent.wake.keywordBoost, r.agent.wake.keywordThreshold]);
      const prevVoice = voiceKey(this.reg);
      const reg = await loadAgent(this.opts.agentDir);
      // a voice picked since (tts.voice applies live) may need fetching first
      if (this.opts.download !== false) await downloadModels(this.opts.modelsDir, voiceDownloads(reg));
      this.reg = reg;
      this.logAgent();
      if (voiceKey(this.reg) !== prevVoice) log.warn("voice engines, turn or wake keyword settings changed: they apply after a restart (tts voice and speed apply now)");
      this.startSchedules();
      this.triggers.start();
      void this.warmAcks();
      for (const s of this.sessions.values()) {
        s.send({ type: "agent_reloaded", ui: this.reg.agent.ui, ...summarize(this.reg) });
        s.voice = this.voiceFor(s.voice);
        s.send({ type: "voices", voices: this.reg.voice.tts.voices, voice: s.voice });
      }
    } catch (e) {
      log.error(`agent reload failed, keeping the previous version: ${(e as Error).message}`);
      for (const s of this.sessions.values()) s.send({ type: "error", message: `agent reload failed: ${(e as Error).message}` });
    }
  }

  /**
   * Every ack phrase the agent can say, as ready-made audio: in the default voice first, then in the
   * voices devices have picked (the rest are made the first time a device picks one).
   */
  private async warmAcks() {
    const voices = [this.reg.voice.tts.voice, ...new Set([...this.sessions.values()].map((s) => s.voice))];
    for (const voice of new Set(voices)) await this.warmAcksFor(voice);
  }

  async warmAcksFor(voice: string) {
    const { acks, tts } = this.reg.voice;
    const toolAcks = [...acks.tool, ...this.reg.tools.flatMap(({ def }) => (def.ack === false || def.ack === undefined ? [] : [def.ack].flat()))];
    const t0 = performance.now();
    await this.tts.warm(toolAcks, voice, tts.ackSpeed ?? tts.speed);
    await this.tts.warm(acks.cache, voice, tts.speed);
    log.info(`acks ready in ${voice}: ${new Set([...toolAcks, ...acks.cache]).size} phrases in ${Math.round(performance.now() - t0)} ms`);
  }

  /** The voice a device asked for, when the agent offers it; else the default. */
  voiceFor(asked: string | undefined): string {
    const { voice, voices } = this.reg.voice.tts;
    return asked && voices.some((v) => v.id === asked) ? asked : voice;
  }

  attach(ws: WebSocket) {
    let session: Session | null = null;
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      try {
        if (isBinary) return session?.onBinary(data);
        const msg = JSON.parse(data.toString()) as ClientMessage;
        if (msg.type === "hello") {
          if (session) {
            session.close();
            this.sessions.delete(session.sid);
          }
          // two tabs (or a stale one) with one device id share a history; worth knowing
          if ([...this.sessions.values()].some((s) => s.device.id === msg.deviceId)) log.warn(`device ${msg.deviceId} is connected twice: both share one conversation`);
          session = new Session(this, ws, randomUUID(), msg);
          this.sessions.set(session.sid, session);
          log.info(`device ${msg.deviceId} (${session.device.room}) connected, mode ${msg.mode}`);
          this.triggers.event({ source: "event", event: "device_connected", device: session.device });
        } else session?.onMessage(msg);
      } catch (e) {
        log.error("bad message", e);
      }
    });
    ws.on("close", () => {
      if (!session) return;
      log.info(`device ${session.device.id} disconnected`);
      session.close();
      this.sessions.delete(session.sid);
      this.triggers.event({ source: "event", event: "device_disconnected", device: session.device });
    });
  }

  /** Speaks on a device, a room, or everywhere ("all"); falls back to every device. */
  announce(text: string, to: { room?: string; deviceId?: string }, source: string) {
    const all = [...this.sessions.values()];
    let targets = to.room === "all" ? all : [];
    if (!targets.length && to.deviceId) targets = all.filter((s) => s.device.id === to.deviceId);
    if (!targets.length && to.room) targets = all.filter((s) => s.device.room === to.room);
    if (!targets.length) targets = all;
    if (!targets.length) return log.warn(`announcement with no device connected: "${text}"`);
    for (const s of targets) s.announce(text, source);
  }

  private timerDone(t: Timer) {
    // a timer_done trigger replaces the built-in announcement
    if (this.triggers.event({ source: "event", event: "timer_done", timer: t })) return;
    this.announce(this.reg.voice.phrases.timerDone(t), { deviceId: t.deviceId, room: t.room }, "timer");
  }

  /** Runs the agent on a prompt outside any conversation (schedules, triggers, POST /api/ask). */
  async ask(prompt: string, room = "all", events?: LoopEvents): Promise<string> {
    const device = { id: "schedule", room };
    const abort = new AbortController();
    const result = await runLoop({
      reg: this.reg,
      llm: this.llm,
      priority: Priority.Background,
      history: [userMessage(this.reg, device, prompt)],
      ctx: {
        device,
        timezone: this.reg.agent.timezone,
        timers: this.timers,
        signal: abort.signal,
        say: () => {},
        sleep: () => {},
        announce: (t, o) => this.announce(t, { room: o?.room ?? room }, "schedule"),
        log: (...a) => log.info("[schedule]", ...a),
      },
      storeFor: (name) => this.storeFor(name),
      events,
    });
    return result.text.trim();
  }

  private startSchedules() {
    for (const c of this.crons) c.stop();
    this.crons = [];
    for (const { name, def } of this.reg.schedules) {
      const job = async () => {
        log.info(`schedule ${name} firing`);
        try {
          if (def.prompt) {
            const reply = await this.ask(def.prompt, def.room ?? "all");
            if (reply && def.speak !== false) this.announce(reply, { room: def.room ?? "all" }, `schedule:${name}`);
          } else {
            await def.run!({
              timezone: this.reg.agent.timezone,
              timers: this.timers,
              store: this.storeFor(`schedule-${name}`),
              announce: (t, o) => this.announce(t, { room: o?.room ?? "all" }, `schedule:${name}`),
              ask: (p) => this.ask(p),
              log: (...a) => log.info(`[schedule ${name}]`, ...a),
            });
          }
        } catch (e) {
          log.error(`schedule ${name} failed`, e);
        }
      };
      this.crons.push(new Cron(def.cron, { timezone: this.reg.agent.timezone, protect: true }, job));
    }
  }
}
