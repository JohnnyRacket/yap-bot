// The device: socket, mic and speaker, wake word spotting and the conversation, without any UI.
// React reads it through useClient() (a snapshot that changes on every update) and the mic level
// through onLevel (every audio block, so it stays out of React's state).
import { decodeBinary, encodeMic, type AgentSummary, type ClientMessage, type DeviceWakeConfig, type ListenMode, type LlmStats, type ServerMessage, type SessionState, type TimelineMark, type WakeDetector } from "yap-bot/protocol";
import { Audio } from "./audio.ts";
import { DeviceSpotter } from "./wake/spotter.ts";
import { setAgentColors } from "./theme.ts";

const clock = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
export const touch = matchMedia("(pointer: coarse)").matches;

// --- what the UI shows --------------------------------------------------------------------------

export interface Settings {
  deviceId: string;
  room: string;
  mode: ListenMode;
  interruptions: boolean;
  echo: boolean;
  detector: WakeDetector;
  /** Tool calls, timings and wake word settings: for whoever builds the agent. */
  details: boolean;
  /** Picked from the agent's voices; empty: the agent's default. */
  voice: string;
}

export type ChunkStatus = "pending" | "playing" | "played" | "unheard";

export type Item =
  | { kind: "user"; id: number; text: string; live: boolean }
  | { kind: "bot"; id: number; turnId: number; chunks: { id: number; text: string; status: ChunkStatus }[]; interrupted: boolean; firstSoundMs?: number }
  | { kind: "tool"; id: number; turnId: number; name: string; input: unknown; output: unknown; error?: string; ms?: number }
  | { kind: "announce"; id: number; text: string; source: string }
  | { kind: "system"; id: number; text: string }
  | { kind: "error"; id: number; text: string };

type NewItem = Item extends infer I ? (I extends Item ? Omit<I, "id"> : never) : never;

export interface Heard {
  tone: "woke" | "miss" | "asleep";
  label: string;
  text: string;
  at: string;
}

export interface Timeline {
  rows: { label: string; detail?: string; t: number }[];
  span: number;
  firstSound: number;
  from: string;
  llm?: LlmStats;
}

export interface Snapshot {
  conn: { text: string; tone: "ok" | "bad" | "pending" };
  /** icon: the agent's emoji, if it has one. */
  brand: { title: string; icon?: string };
  agent?: string;
  settings: Settings;
  state: SessionState;
  awake: boolean;
  pushing: boolean;
  micOn: boolean;
  wakeWord: string;
  hint: string;
  /** Details mode, wake mode: where the wake word is listened for. */
  spotterNote: string;
  heard?: Heard;
  items: Item[];
  timeline?: Timeline;
  voices: { id: string; label: string }[];
  capabilities?: AgentSummary;
  /** Speech arrived before the page could make sound: a tap unlocks it. */
  needsTap: boolean;
  /** The agent wants its access code. */
  needsToken: boolean;
}

export const LABELS: Record<string, string> = {
  speech_end: "you stopped",
  judged: "smart turn",
  turn_end: "turn decided",
  stt_final: "transcript final",
  fastpath: "fastpath",
  llm_request: "sent to model",
  llm_first_token: "model's first token",
  ack: "ack",
  tool_start: "tool",
  first_sentence: "first sentence",
  tts_first_audio: "first audio",
  playback_start: "playing",
  paused: "paused (talked over)",
  prefilled: "prompt read during speech",
};

// --- the client -----------------------------------------------------------------------------------

const debugParam = new URLSearchParams(location.search).has("debug");

export class Client {
  private audio = new Audio();
  private spotter = new DeviceSpotter();
  private ws: WebSocket | null = null;
  private deviceWake?: DeviceWakeConfig;
  /** Sent "wake", no answer yet: stream, and don't take an older "asleep" for the answer. */
  private wakePending = false;
  /** The device hasn't chosen: the agent's default (ui.details) applies. */
  private detailsChosen: boolean;
  private nextId = 1;
  private listeners = new Set<() => void>();
  private levelListeners = new Set<(peak: number) => void>();
  private wakeLock: { release(): Promise<void> } | null = null;
  snap: Snapshot;

  constructor() {
    const saved = JSON.parse(localStorage.getItem("yap-bot") ?? "{}");
    this.detailsChosen = saved.details !== undefined || debugParam;
    this.snap = {
      conn: { text: "connecting…", tone: "pending" },
      brand: { title: "yap-bot" },
      settings: {
        deviceId: saved.deviceId ?? `web-${Math.random().toString(36).slice(2, 6)}`,
        room: saved.room ?? "home",
        mode: saved.mode ?? "wake",
        interruptions: saved.interruptions ?? true,
        echo: saved.echo ?? true,
        detector: saved.detector ?? "device",
        details: saved.details ?? debugParam,
        voice: saved.voice ?? "",
      },
      state: "idle",
      awake: false,
      pushing: false,
      micOn: false,
      wakeWord: "computer",
      hint: "",
      spotterNote: "",
      items: [],
      voices: [],
      needsTap: false,
      needsToken: false,
    };
    // a new device keeps the name it was given
    this.save();

    // Browsers only let a page make sound after a tap. Speech that comes before (an announcement after
    // a reload) waits, and the page asks for the tap.
    this.audio.onNeedsTap = () => !this.audio.ready && this.set({ needsTap: true });
    this.audio.onMic = (pcm) => {
      if (this.spottingHere()) this.spotter.push(pcm);
      if (this.streaming() && this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeMic(pcm));
    };
    this.audio.onLevel = (peak) => this.levelListeners.forEach((l) => l(peak));
    this.audio.onProgress = (chunkId, playedMs, done) => {
      this.send({ type: "playback", chunkId, playedMs, done });
      this.markChunk(chunkId, done ? "played" : "playing");
    };

    this.spotter.onWake = (keyword, pcm) => {
      if (!this.spottingHere() || this.detector() !== "device" || this.snap.awake || this.wakePending) return;
      this.wakePending = true;
      this.updateSpotting();
      this.send({ type: "wake", keyword });
      // the wake word's tail and what came right after it, ahead of the live audio
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeMic(pcm));
      this.set({ heard: { tone: "woke", label: "woke", text: "on this device", at: clock() } });
    };
    this.spotter.onChange = () => this.refresh();

    // the screen stays on while listening (a sleeping phone stops the mic); the lock goes when the
    // page is hidden, so take it again on coming back
    document.addEventListener("visibilitychange", () => {
      this.wakeLock = null;
      if (document.visibilityState === "visible") void this.keepScreenOn(this.audio.micOn);
    });

    // The agent's device token, when it has one: from a link (#token=…) once, then remembered here.
    const linkToken = new URLSearchParams(location.hash.slice(1)).get("token");
    if (linkToken) {
      localStorage.setItem("yap-bot-token", linkToken);
      history.replaceState(null, "", location.pathname + location.search);
    }
    this.refresh();
  }

  // --- store plumbing -------------------------------------------------------------------------

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  getSnapshot = () => this.snap;
  onLevel(l: (peak: number) => void) {
    this.levelListeners.add(l);
    return () => void this.levelListeners.delete(l);
  }

  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }

  private setItems(fn: (items: Item[]) => Item[]) {
    this.set({ items: fn(this.snap.items) });
  }

  private add(item: NewItem): Item {
    const it = { ...item, id: this.nextId++ } as Item;
    this.setItems((xs) => [...xs, it]);
    return it;
  }

  private save() {
    const s = this.snap.settings;
    // details only once chosen here, so the agent's default keeps applying until then
    localStorage.setItem("yap-bot", JSON.stringify({ ...s, details: this.detailsChosen ? s.details : undefined }));
  }

  private setSettings(patch: Partial<Settings>) {
    this.set({ settings: { ...this.snap.settings, ...patch } });
    this.save();
  }

  // --- socket ---------------------------------------------------------------------------------

  private send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  connect() {
    this.ws?.close();
    const token = localStorage.getItem("yap-bot-token");
    const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`);
    sock.binaryType = "arraybuffer";
    this.ws = sock;
    this.set({ conn: { text: "connecting…", tone: "pending" } });
    sock.onopen = () => {
      this.set({ conn: { text: "connected", tone: "ok" } });
      this.wakePending = false;
      const s = this.snap.settings;
      this.send({ type: "hello", deviceId: s.deviceId, room: s.room, mode: s.mode, interruptions: s.interruptions, wakeDetector: this.detector(), voice: s.voice || undefined });
    };
    sock.onclose = (e) => {
      if (this.ws !== sock) return;
      // the agent wants its access token (or a different one)
      if (e.code === 4401) return this.set({ needsToken: true, conn: { text: "needs its access code", tone: "bad" } });
      this.set({ conn: { text: "reconnecting…", tone: "bad" } });
      setTimeout(() => this.ws === sock && this.connect(), 1500);
    };
    sock.onmessage = (e) => {
      if (typeof e.data !== "string") {
        const b = decodeBinary(e.data as ArrayBuffer);
        if (b?.kind === "tts") this.audio.play(b.chunkId, b.pcm);
        return;
      }
      this.onMessage(JSON.parse(e.data) as ServerMessage);
    };
  }

  /** The access code from the dialog; empty: leave it disconnected. */
  giveToken(code: string) {
    this.set({ needsToken: false });
    if (!code.trim()) return;
    localStorage.setItem("yap-bot-token", code.trim());
    this.connect();
  }

  // --- wake word on this device -----------------------------------------------------------------
  // With the "device" detector, the wake word is spotted here and nothing is sent while asleep. Until
  // the spotter has loaded (or if it can't run here), the server's spotter listens instead.

  private spottingHere = () => this.snap.settings.mode === "wake" && this.snap.settings.detector === "device";

  /** What the server is told: "device" once the spotter here is ready, its own spotter until then. */
  private detector(): WakeDetector {
    const d = this.snap.settings.detector;
    if (d !== "device") return d;
    return this.spotter.ready ? "device" : "keyword";
  }

  private sendMode() {
    const s = this.snap.settings;
    this.send({ type: "mode", mode: s.mode, interruptions: s.interruptions, wakeDetector: this.detector() });
  }

  /** Mic audio goes to the server unless the wake word is spotted here and it's asleep. */
  private streaming = () => !(this.snap.settings.mode === "wake" && this.detector() === "device") || this.snap.awake || this.wakePending;

  private updateSpotting() {
    this.spotter.spot(this.spottingHere() && this.spotter.ready && this.audio.micOn && !this.snap.awake && !this.wakePending);
  }

  private loadSpotter() {
    // failed once: the server's spotter stands in until the page is reloaded
    if (!this.spottingHere() || !this.deviceWake || this.spotter.error) return;
    this.spotter.start(this.deviceWake).then(
      () => {
        this.sendMode();
        this.updateSpotting();
        this.refresh();
      },
      (e) => {
        this.add({ kind: "error", text: `The wake word spotter can't run here (${(e as Error).message}); the server listens for the wake word instead.` });
        this.refresh();
      },
    );
  }

  // --- messages ---------------------------------------------------------------------------------

  private userLine(text: string, final: boolean) {
    const items = this.snap.items;
    const last = [...items].reverse().find((i) => i.kind === "user" && i.live);
    if (last) this.setItems((xs) => xs.map((i) => (i === last ? { ...last, text: text || "…", live: !final } : i)));
    else this.add({ kind: "user", text: text || "…", live: !final });
  }

  private updateBot(turnId: number, fn: (b: Extract<Item, { kind: "bot" }>) => Extract<Item, { kind: "bot" }>) {
    this.setItems((xs) => xs.map((i) => (i.kind === "bot" && i.turnId === turnId ? fn(i) : i)));
  }

  private markChunk(chunkId: number, status: "playing" | "played") {
    const bot = this.snap.items.find((i) => i.kind === "bot" && i.chunks.some((c) => c.id === chunkId)) as Extract<Item, { kind: "bot" }> | undefined;
    const chunk = bot?.chunks.find((c) => c.id === chunkId);
    if (!bot || !chunk || chunk.status === status || chunk.status === "played") return;
    this.updateBot(bot.turnId, (b) => ({ ...b, chunks: b.chunks.map((c) => (c.id === chunkId ? { ...c, status } : c)) }));
  }

  private onMessage(m: ServerMessage) {
    switch (m.type) {
      case "welcome":
        this.deviceWake = m.deviceWake;
        setAgentColors(m.ui.colors);
        if (!this.detailsChosen && m.ui.details !== undefined) this.set({ settings: { ...this.snap.settings, details: m.ui.details } });
        this.set({ wakeWord: m.wakeWord, brand: { title: m.ui.title, icon: m.ui.icon }, agent: m.agent === m.ui.title ? `Room: ${m.room}` : `${m.agent} · ${m.room}`, voices: m.voices, capabilities: m.capabilities, settings: { ...this.snap.settings, voice: m.voice } });
        this.loadSpotter();
        this.refresh();
        break;
      case "voices":
        this.set({ voices: m.voices, settings: { ...this.snap.settings, voice: m.voice } });
        break;
      case "state": {
        let { awake, heard } = this.snap;
        // a wake sent from here isn't answered yet: an "asleep" now was sent before the server had it
        if (!(this.wakePending && !m.awake)) {
          // falling back asleep: the wake line now says since when, not when it last woke
          if (awake && !m.awake && this.snap.settings.mode === "wake") heard = { tone: "asleep", label: "asleep", text: "since", at: clock() };
          awake = !!m.awake;
        }
        this.set({ state: m.state, awake, heard });
        this.updateSpotting();
        this.refresh();
        break;
      }
      case "transcript":
        if (m.text || !m.final) this.userLine(m.text, m.final);
        break;
      case "assistant": {
        const chunk = { id: m.chunkId, text: m.text, status: "pending" as const };
        if (this.snap.items.some((i) => i.kind === "bot" && i.turnId === m.turnId)) this.updateBot(m.turnId, (b) => ({ ...b, chunks: [...b.chunks, chunk] }));
        else this.add({ kind: "bot", turnId: m.turnId, chunks: [chunk], interrupted: false });
        break;
      }
      case "tts_end":
        this.audio.endChunk(m.chunkId);
        break;
      case "stop":
        this.audio.flush();
        break;
      case "pause":
        this.audio.pause(true);
        break;
      case "resume":
        this.audio.pause(false);
        break;
      case "tool": {
        if (m.output === undefined && !m.error) break;
        const tool: Item = { kind: "tool", id: this.nextId++, turnId: m.turnId, name: m.name, input: m.input, output: m.output, error: m.error, ms: m.ms };
        // keep tool calls above the reply they led to
        this.setItems((xs) => {
          const at = xs.findIndex((i) => i.kind === "bot" && i.turnId === m.turnId);
          return at < 0 ? [...xs, tool] : [...xs.slice(0, at), tool, ...xs.slice(at)];
        });
        break;
      }
      case "heard": {
        const at = clock();
        if (this.wakePending) {
          // the answer to this device's wake: refused (busy) means asleep, so spot again
          this.wakePending = false;
          if (!m.woke) this.set({ awake: false, heard: { tone: "miss", label: "woke", text: "on this device, but it was busy", at } });
          this.updateSpotting();
          this.refresh();
          break;
        }
        this.set({
          heard: m.woke
            ? { tone: "woke", label: "woke", text: `by ${m.by === "keyword" ? "the keyword spotter" : m.by === "device" ? "this device" : `transcript “${m.text}”`}`, at }
            : { tone: "miss", label: "heard", text: `“${m.text}”, not the wake word`, at },
        });
        break;
      }
      case "announce":
        this.add({ kind: "announce", text: m.text, source: m.source });
        break;
      case "turn_done":
        if (m.interrupted) this.updateBot(m.turnId, (b) => ({ ...b, interrupted: true, chunks: b.chunks.map((c) => (c.status === "played" ? c : { ...c, status: "unheard" })) }));
        break;
      case "metrics":
        this.showTimeline(m.turnId, m.marks, m.llm);
        break;
      case "agent_reloaded":
        setAgentColors(m.ui.colors);
        this.set({ brand: { title: m.ui.title, icon: m.ui.icon } });
        this.add({ kind: "system", text: `Agent reloaded: ${m.tools.length} tools, ${m.skills.length} skills, ${m.fastpaths.length} fastpaths, ${m.schedules.length} schedules, ${m.triggers.length} triggers` });
        this.set({ capabilities: { tools: m.tools, skills: m.skills, fastpaths: m.fastpaths, schedules: m.schedules, triggers: m.triggers } });
        break;
      case "error":
        this.add({ kind: "error", text: m.message });
        break;
    }
  }

  private showTimeline(turnId: number, marks: TimelineMark[], llm?: LlmStats) {
    const sorted = [...marks].sort((a, b) => a.at - b.at);
    if (!sorted.length) return;
    const t0 = sorted[0].at;
    const end = sorted[sorted.length - 1].at;
    const firstSound = (sorted.find((m) => m.name === "playback_start")?.at ?? end) - t0;
    this.set({
      timeline: {
        rows: sorted.map((m) => ({ label: LABELS[m.name] ?? m.name, detail: m.detail, t: m.at - t0 })),
        span: Math.max(1, end - t0),
        firstSound,
        from: LABELS[sorted[0].name] ?? sorted[0].name,
        llm,
      },
    });
    this.updateBot(turnId, (b) => ({ ...b, firstSoundMs: firstSound }));
  }

  // --- hint, mic state, screen lock ----------------------------------------------------------------

  private refresh() {
    const mic = this.audio.micOn;
    const { settings: s, awake, wakeWord } = this.snap;
    const hints: Record<ListenMode, string> = {
      push: touch ? "Hold the mic while you talk." : "Hold the mic (or the space bar) while you talk.",
      open: mic ? "Listening all the time: just talk." : `${touch ? "Tap" : "Click"} the mic to start listening.`,
      wake: mic ? (awake ? "Awake: go ahead. Follow-ups need no wake word for a few seconds." : `Say “${wakeWord}” to wake it.`) : `${touch ? "Tap" : "Click"} the mic to listen for “${wakeWord}”.`,
    };
    let note = "";
    if (this.spottingHere()) {
      if (this.spotter.ready) note = `Listening on this device: nothing is sent until it hears the wake word (spotter at ${Math.round(this.spotter.load * 100)}% of a core).`;
      else if (this.spotter.error) note = `The server listens (this device's spotter failed: ${this.spotter.error}).`;
      else if (this.deviceWake) note = "The server listens until this device's spotter has loaded…";
      else note = "The server listens (it offers no spotter for devices).";
    }
    void this.keepScreenOn(mic);
    this.set({ hint: hints[s.mode], spotterNote: s.mode === "wake" && !awake ? note : "", micOn: mic });
  }

  private async keepScreenOn(on: boolean) {
    const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } };
    if (on && !this.wakeLock && nav.wakeLock && document.visibilityState === "visible") this.wakeLock = await nav.wakeLock.request("screen").catch(() => null);
    if (!on && this.wakeLock) {
      void this.wakeLock.release();
      this.wakeLock = null;
    }
  }

  // --- actions from the UI ------------------------------------------------------------------------

  /** The tap that lets the page make sound: whatever was held plays now. */
  unlock() {
    this.set({ needsTap: false });
    void this.audio.unlock();
  }

  setMode(mode: ListenMode) {
    this.setSettings({ mode });
    this.sendMode();
    this.loadSpotter();
    this.updateSpotting();
    this.refresh();
  }

  setDetector(detector: WakeDetector) {
    this.setSettings({ detector });
    this.sendMode();
    this.loadSpotter();
    this.updateSpotting();
    this.refresh();
  }

  setDetails(details: boolean) {
    this.detailsChosen = true;
    this.setSettings({ details });
  }

  setVoice(voice: string) {
    this.setSettings({ voice });
    this.send({ type: "voice", voice });
  }

  setInterruptions(interruptions: boolean) {
    this.setSettings({ interruptions });
    this.send({ type: "mode", mode: this.snap.settings.mode, interruptions });
  }

  /** Device name, room and echo cancellation take a reconnect (and the mic restarting, for echo). */
  apply(patch: { deviceId: string; room: string; echo: boolean }) {
    const s = this.snap.settings;
    const echoChanged = s.echo !== patch.echo;
    this.setSettings({ deviceId: patch.deviceId.trim() || s.deviceId, room: patch.room.trim() || s.room, echo: patch.echo });
    if (echoChanged && this.audio.micOn) {
      this.audio.stopMic();
      void this.micOn();
    }
    this.connect();
  }

  private async micOn() {
    try {
      await this.audio.startMic(this.snap.settings.echo);
    } catch (e) {
      this.add({ kind: "error", text: `Microphone: ${(e as Error).message}` });
    }
    this.updateSpotting();
    this.refresh();
  }

  /** A click on the mic: toggles it in open and wake mode (push mode uses pushDown/pushUp). */
  async toggleMic() {
    await this.audio.init();
    if (this.snap.settings.mode === "push") return;
    if (this.audio.micOn) this.audio.stopMic();
    else await this.micOn();
    this.updateSpotting();
    this.refresh();
  }

  async pushDown() {
    if (this.snap.pushing) return;
    await this.audio.init();
    await this.micOn();
    this.set({ pushing: true });
    this.send({ type: "push", down: true });
  }

  pushUp() {
    if (!this.snap.pushing) return;
    this.set({ pushing: false });
    this.send({ type: "push", down: false });
  }

  async sendText(text: string) {
    if (!text.trim()) return;
    await this.audio.init();
    this.send({ type: "text", text: text.trim() }); // the server echoes it back as the turn's transcript
  }

  interrupt() {
    this.send({ type: "interrupt" });
  }

  reset() {
    this.send({ type: "reset" });
    this.set({ items: [], timeline: undefined });
    this.add({ kind: "system", text: "Conversation forgotten." });
  }
}

export const client = new Client();
