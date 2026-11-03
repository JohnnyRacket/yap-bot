import { decodeBinary, encodeMic, type ClientMessage, type DeviceWakeConfig, type ListenMode, type WakeDetector, type ServerMessage, type SessionState, type TimelineMark, type LlmStats } from "yap-bot/protocol";
import { Audio } from "./audio.ts";
import { DeviceSpotter } from "./wake/spotter.ts";
import "./style.css";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const clock = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// --- settings ---------------------------------------------------------------------------------

const saved = JSON.parse(localStorage.getItem("yap-bot") ?? "{}");
const settings = {
  deviceId: saved.deviceId ?? `web-${Math.random().toString(36).slice(2, 6)}`,
  room: saved.room ?? "home",
  mode: (saved.mode ?? "push") as ListenMode,
  interruptions: saved.interruptions ?? true,
  echo: saved.echo ?? true,
  detector: (saved.detector ?? "device") as WakeDetector,
  /** Tool calls, timings and wake word settings: for whoever builds the agent. */
  details: saved.details ?? new URLSearchParams(location.search).has("debug"),
};
const save = () => localStorage.setItem("yap-bot", JSON.stringify(settings));
$<HTMLInputElement>("deviceId").value = settings.deviceId;
$<HTMLInputElement>("room").value = settings.room;
$<HTMLInputElement>("interruptions").checked = settings.interruptions;
$<HTMLInputElement>("echo").checked = settings.echo;
$<HTMLSelectElement>("detector").value = settings.detector;
$<HTMLInputElement>("details").checked = settings.details;
document.body.classList.toggle("details", settings.details);
$<HTMLInputElement>("details").addEventListener("change", () => {
  settings.details = $<HTMLInputElement>("details").checked;
  document.body.classList.toggle("details", settings.details);
  save();
});
const touch = matchMedia("(pointer: coarse)").matches;

/** The agent's own name and emoji, from the server. */
function brand(ui: { title: string; icon: string }) {
  document.title = ui.title;
  $("brandName").textContent = ui.title;
  for (const el of document.querySelectorAll(".logo, .empty .big")) el.textContent = ui.icon;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">${ui.icon}</text></svg>`;
  $<HTMLLinkElement>("favicon").href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  $("wakeHint").textContent = `wake word waits for “${wakeWord}”`;
}

// --- connection -------------------------------------------------------------------------------

const audio = new Audio();

// --- sound needs a tap ------------------------------------------------------------------------
// Browsers only let a page make sound after a tap. Speech that comes before (an announcement after a
// reload) waits, and this asks for the tap.

function askForTap() {
  if (!audio.ready) $("start").hidden = false;
}
audio.onNeedsTap = askForTap;
$("startBtn").addEventListener("click", () => {
  $("start").hidden = true;
  void audio.unlock();
});

// --- the screen stays on while listening (a sleeping phone stops the mic) --------------------------

let wakeLock: { release(): Promise<void> } | null = null;
async function keepScreenOn(on: boolean) {
  const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } };
  if (on && !wakeLock && nav.wakeLock && document.visibilityState === "visible") wakeLock = await nav.wakeLock.request("screen").catch(() => null);
  if (!on && wakeLock) {
    void wakeLock.release();
    wakeLock = null;
  }
}
// the lock goes when the page is hidden; take it again on coming back
document.addEventListener("visibilitychange", () => {
  wakeLock = null;
  if (document.visibilityState === "visible") void keepScreenOn(audio.micOn);
});

let ws: WebSocket | null = null;
let wakeWord = "computer";
let state: SessionState = "idle";
let awake = false;
let pushing = false;

function send(msg: ClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// --- wake word on this device -------------------------------------------------------------------
// With the "device" detector, the wake word is spotted here and nothing is sent while asleep. Until the
// spotter has loaded (or if it can't run here), the server's spotter listens instead.

const spotter = new DeviceSpotter();
let deviceWake: DeviceWakeConfig | undefined;
/** Sent "wake", no answer yet: stream, and don't take an older "asleep" for the answer. */
let wakePending = false;

const spottingHere = () => settings.mode === "wake" && settings.detector === "device";

/** What the server is told: "device" once the spotter here is ready, its own spotter until then. */
function detector(): WakeDetector {
  if (settings.detector !== "device") return settings.detector;
  return spotter.ready ? "device" : "keyword";
}

function sendMode() {
  send({ type: "mode", mode: settings.mode, interruptions: settings.interruptions, wakeDetector: detector() });
}

/** Mic audio goes to the server unless the wake word is spotted here and it's asleep. */
const streaming = () => !(settings.mode === "wake" && detector() === "device") || awake || wakePending;

function updateSpotting() {
  spotter.spot(spottingHere() && spotter.ready && audio.micOn && !awake && !wakePending);
}

function loadSpotter() {
  // failed once: the server's spotter stands in until the page is reloaded
  if (!spottingHere() || !deviceWake || spotter.error) return;
  spotter.start(deviceWake).then(
    () => {
      sendMode();
      updateSpotting();
      updateHint();
    },
    (e) => {
      bubble("error", `⚠️ wake word spotter can't run here (${esc((e as Error).message)}); the server listens for the wake word instead`);
      updateHint();
    },
  );
}

spotter.onWake = (keyword, pcm) => {
  if (!spottingHere() || detector() !== "device" || awake || wakePending) return;
  wakePending = true;
  updateSpotting();
  send({ type: "wake", keyword });
  // the wake word's tail and what came right after it, ahead of the live audio
  if (ws?.readyState === WebSocket.OPEN) ws.send(encodeMic(pcm));
  $("heard").innerHTML = `<span class="woke">woke</span> on this device <span class="muted">${clock()}</span>`;
};
spotter.onChange = () => updateHint();

// The agent's device token, when it has one: from a link (#token=…) once, then remembered here.
const linkToken = new URLSearchParams(location.hash.slice(1)).get("token");
if (linkToken) {
  localStorage.setItem("yap-bot-token", linkToken);
  history.replaceState(null, "", location.pathname + location.search);
}

function connect() {
  ws?.close();
  const token = localStorage.getItem("yap-bot-token");
  const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`);
  sock.binaryType = "arraybuffer";
  ws = sock;
  setConn("connecting…", "");
  sock.onopen = () => {
    setConn("connected", "ok");
    wakePending = false;
    send({ type: "hello", deviceId: settings.deviceId, room: settings.room, mode: settings.mode, interruptions: settings.interruptions, wakeDetector: detector() });
  };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    // the agent wants its access token (or a different one)
    if (e.code === 4401) {
      const given = prompt("This assistant needs its access code:");
      if (!given) return setConn("needs the access code (reload to enter it)", "bad");
      localStorage.setItem("yap-bot-token", given.trim());
      return connect();
    }
    setConn("disconnected, retrying…", "bad");
    setTimeout(() => ws === sock && connect(), 1500);
  };
  sock.onmessage = (e) => {
    if (typeof e.data !== "string") {
      const b = decodeBinary(e.data as ArrayBuffer);
      if (b?.kind === "tts") audio.play(b.chunkId, b.pcm);
      return;
    }
    onMessage(JSON.parse(e.data) as ServerMessage);
  };
}

function setConn(text: string, cls: string) {
  $("conn").textContent = text;
  $("conn").className = `pill ${cls}`;
}

audio.onMic = (pcm) => {
  if (spottingHere()) spotter.push(pcm);
  if (streaming() && ws?.readyState === WebSocket.OPEN) ws.send(encodeMic(pcm));
};
audio.onLevel = (peak) => ($("level").style.width = `${Math.min(100, peak * 160)}%`);
audio.onProgress = (chunkId, playedMs, done) => {
  send({ type: "playback", chunkId, playedMs, done });
  markChunk(chunkId, done ? "played" : "playing");
};

// --- conversation view ------------------------------------------------------------------------

const messages = $("messages");
const turns = new Map<number, HTMLElement>(); // turnId → assistant bubble
let liveUser: HTMLElement | null = null;

function scroll() {
  messages.scrollTop = messages.scrollHeight;
}

function bubble(cls: string, html: string): HTMLElement {
  $("empty")?.remove();
  const el = document.createElement("div");
  el.className = `msg ${cls}`;
  el.innerHTML = html;
  messages.appendChild(el);
  scroll();
  return el;
}

function userLine(text: string, final: boolean) {
  if (!liveUser) liveUser = bubble("user live", "");
  liveUser.textContent = text || "…";
  liveUser.classList.toggle("live", !final);
  if (final) liveUser = null;
  scroll();
}

function assistantBubble(turnId: number): HTMLElement {
  let el = turns.get(turnId);
  if (!el) {
    el = bubble("bot", "");
    turns.set(turnId, el);
  }
  return el;
}

function markChunk(chunkId: number, cls: "playing" | "played") {
  const span = messages.querySelector<HTMLElement>(`[data-chunk="${chunkId}"]`);
  if (!span) return;
  if (cls === "played") span.classList.remove("playing");
  span.classList.add(cls);
}

function onMessage(m: ServerMessage) {
  switch (m.type) {
    case "welcome":
      wakeWord = m.wakeWord;
      brand(m.ui);
      deviceWake = m.deviceWake;
      loadSpotter();
      $("agentInfo").textContent = `· ${m.agent} · ${m.room}`;
      renderAgent(m.capabilities);
      updateHint();
      break;
    case "state":
      state = m.state;
      // falling back asleep: the wake line now says since when, not when it last woke
      // a wake sent from here isn't answered yet: an "asleep" now was sent before the server had it
      if (!(wakePending && !m.awake)) {
        if (awake && !m.awake && settings.mode === "wake") $("heard").innerHTML = `asleep since <span class="muted">${clock()}</span>`;
        awake = !!m.awake;
      }
      updateSpotting();
      $("state").textContent = m.state === "listening" && settings.mode === "wake" && awake ? "listening (awake)" : m.state;
      $("state").className = `state ${m.state}`;
      updateHint();
      break;
    case "transcript":
      if (m.text || !m.final) userLine(m.text, m.final);
      break;
    case "assistant": {
      const el = assistantBubble(m.turnId);
      const span = document.createElement("span");
      span.dataset.chunk = String(m.chunkId);
      span.textContent = m.text + " ";
      el.appendChild(span);
      scroll();
      break;
    }
    case "tts_end":
      audio.endChunk(m.chunkId);
      break;
    case "stop":
      audio.flush();
      break;
    case "pause":
      audio.pause(true);
      break;
    case "resume":
      audio.pause(false);
      break;
    case "tool": {
      if (m.output === undefined && !m.error) break;
      const el = bubble("tool", `🔧 <b>${esc(m.name)}</b> <code>${esc(JSON.stringify(m.input))}</code> → <code>${esc(JSON.stringify(m.error ?? m.output)).slice(0, 400)}</code> <span class="muted">${m.ms} ms</span>`);
      // keep tool chips above the reply they led to
      const reply = turns.get(m.turnId);
      if (reply) messages.insertBefore(el, reply);
      break;
    }
    case "heard": {
      const when = clock();
      if (wakePending) {
        // the answer to this device's wake: refused (busy) means asleep, so spot again
        wakePending = false;
        if (!m.woke) {
          awake = false;
          $("heard").innerHTML = `<span class="miss">woke</span> on this device, but it was busy <span class="muted">${when}</span>`;
        }
        updateSpotting();
        updateHint();
        break;
      }
      $("heard").innerHTML = m.woke
        ? `<span class="woke">woke</span> by ${m.by === "keyword" ? "keyword spotter" : m.by === "device" ? "this device" : `transcript: “${esc(m.text)}”`} <span class="muted">${when}</span>`
        : `<span class="miss">heard</span> “${esc(m.text)}” — not the wake word <span class="muted">${when}</span>`;
      break;
    }
    case "announce":
      bubble("announce", `📣 ${esc(m.text)} <span class="muted">${esc(m.source)}</span>`);
      break;
    case "turn_done": {
      const el = turns.get(m.turnId);
      if (el && m.interrupted) {
        el.classList.add("interrupted");
        el.querySelectorAll("span[data-chunk]:not(.played)").forEach((s) => s.classList.add("unheard"));
      }
      break;
    }
    case "metrics":
      showTimeline(m.marks, m.llm);
      break;
    case "agent_reloaded":
      bubble("system", `Agent reloaded: ${m.tools.length} tools, ${m.skills.length} skills, ${m.fastpaths.length} fastpaths, ${m.schedules.length} schedules, ${m.triggers.length} triggers`);
      renderAgent(m);
      break;
    case "error":
      bubble("error", `⚠️ ${esc(m.message)}`);
      break;
  }
}

function renderAgent(a: { tools: string[]; skills: string[]; fastpaths: string[]; schedules: string[]; triggers: string[] }) {
  const row = (label: string, xs: string[]) => `<div><b>${label}</b> ${xs.length ? xs.map(esc).join(", ") : "—"}</div>`;
  $("agentDetails").innerHTML = row("Tools", a.tools) + row("Skills", a.skills) + row("Fastpaths", a.fastpaths) + row("Schedules", a.schedules) + row("Triggers", a.triggers);
}

// --- timeline ---------------------------------------------------------------------------------

const LABELS: Record<string, string> = {
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

function showTimeline(marks: TimelineMark[], llm?: LlmStats) {
  const sorted = [...marks].sort((a, b) => a.at - b.at);
  if (!sorted.length) return;
  const t0 = sorted[0].at;
  const end = sorted[sorted.length - 1].at;
  const span = Math.max(1, end - t0);
  $("timeline").innerHTML =
    sorted
      .map((m) => {
        const t = m.at - t0;
        return `<div class="tl-row"><span class="tl-label">${esc(LABELS[m.name] ?? m.name)}${m.detail ? ` <span class="muted">${esc(m.detail)}</span>` : ""}</span>
          <span class="tl-bar"><span style="width:${(t / span) * 100}%"></span></span><span class="tl-t">${(t / 1000).toFixed(2)}s</span></div>`;
      })
      .join("") + `<div class="tl-total">first sound <b>${((sorted.find((m) => m.name === "playback_start")?.at ?? end) - t0) / 1000}s</b> after ${esc(LABELS[sorted[0].name] ?? sorted[0].name)}</div>`;
  $("llmStats").innerHTML = llm
    ? `<span>rounds <b>${llm.rounds}</b></span><span>prompt <b>${llm.promptTokens ?? "?"}</b> new tokens, ${Math.round(llm.promptMs ?? 0)} ms</span><span><b>${Math.round(llm.generationTps ?? 0)}</b> tok/s</span>`
    : "";
}

// --- controls ---------------------------------------------------------------------------------

function updateHint() {
  const mic = audio.micOn;
  const hints: Record<ListenMode, string> = {
    push: touch ? "Hold the mic button while you talk." : "Hold the mic button (or the space bar) while you talk.",
    open: mic ? "Listening all the time: just talk." : `${touch ? "Tap" : "Click"} the mic to start listening.`,
    wake: mic ? (awake ? "Awake: go ahead (follow-ups need no wake word for a few seconds)." : `Say “${wakeWord}” to wake it.`) : `${touch ? "Tap" : "Click"} the mic to start listening for the wake word.`,
  };
  let where = "";
  if (spottingHere()) {
    if (spotter.ready) where = ` Listening on this device: nothing is sent until then (spotter at ${Math.round(spotter.load * 100)}% of a core).`;
    else if (spotter.error) where = ` The server listens (this device's spotter failed: ${spotter.error}).`;
    else if (deviceWake) where = " The server listens until this device's spotter has loaded…";
    else where = " The server listens (it offers no spotter for devices).";
  }
  $("hint").textContent = hints[settings.mode] + (settings.mode === "wake" && !awake && settings.details ? where : "");
  void keepScreenOn(mic);
  $("mic").classList.toggle("on", mic && (settings.mode !== "push" || pushing));
  $("mic").classList.toggle("armed", mic && settings.mode === "push" && !pushing);
}

function renderMode() {
  for (const b of $("mode").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.mode === settings.mode));
  $("detector").style.display = settings.mode === "wake" ? "" : "none";
  $("heard").style.display = settings.mode === "wake" ? "" : "none";
  updateHint();
}

$<HTMLSelectElement>("detector").addEventListener("change", () => {
  settings.detector = $<HTMLSelectElement>("detector").value as WakeDetector;
  save();
  sendMode();
  loadSpotter();
  updateSpotting();
  updateHint();
});

$("mode").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b) return;
  settings.mode = b.dataset.mode as ListenMode;
  save();
  sendMode();
  loadSpotter();
  updateSpotting();
  renderMode();
});

async function micOn() {
  try {
    await audio.startMic(settings.echo);
  } catch (e) {
    bubble("error", `⚠️ microphone: ${esc((e as Error).message)}`);
  }
  updateSpotting();
  updateHint();
}

async function pushDown() {
  if (pushing) return;
  await micOn();
  pushing = true;
  send({ type: "push", down: true });
  updateHint();
}

function pushUp() {
  if (!pushing) return;
  pushing = false;
  send({ type: "push", down: false });
  updateHint();
}

const micBtn = $("mic");
micBtn.addEventListener("pointerdown", (e) => {
  if (settings.mode !== "push") return;
  e.preventDefault();
  micBtn.setPointerCapture(e.pointerId);
  void pushDown();
});
micBtn.addEventListener("pointerup", () => settings.mode === "push" && pushUp());
micBtn.addEventListener("pointercancel", () => settings.mode === "push" && pushUp());
micBtn.addEventListener("click", async () => {
  await audio.init();
  if (settings.mode === "push") return;
  if (audio.micOn) audio.stopMic();
  else await micOn();
  updateSpotting();
  updateHint();
});

document.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).matches("input, textarea")) return;
  if (e.code === "Space" && settings.mode === "push" && !e.repeat) {
    e.preventDefault();
    void audio.init().then(pushDown);
  }
  if (e.code === "Escape") {
    if (document.body.classList.contains("panel-open")) setPanel(false);
    else send({ type: "interrupt" });
  }
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && settings.mode === "push") {
    e.preventDefault();
    pushUp();
  }
});

$<HTMLFormElement>("textForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("text");
  const text = input.value.trim();
  if (!text) return;
  await audio.init();
  input.value = "";
  send({ type: "text", text }); // the server echoes it back as the turn's transcript
});

$("stop").addEventListener("click", () => send({ type: "interrupt" }));
$("reset").addEventListener("click", () => {
  send({ type: "reset" });
  bubble("system", "Conversation forgotten.");
});
$("apply").addEventListener("click", () => {
  settings.deviceId = $<HTMLInputElement>("deviceId").value.trim() || settings.deviceId;
  settings.room = $<HTMLInputElement>("room").value.trim() || settings.room;
  settings.interruptions = $<HTMLInputElement>("interruptions").checked;
  const echoChanged = settings.echo !== $<HTMLInputElement>("echo").checked;
  settings.echo = $<HTMLInputElement>("echo").checked;
  save();
  if (echoChanged && audio.micOn) {
    audio.stopMic();
    void micOn();
  }
  connect();
});
$<HTMLInputElement>("interruptions").addEventListener("change", () => {
  settings.interruptions = $<HTMLInputElement>("interruptions").checked;
  save();
  send({ type: "mode", mode: settings.mode, interruptions: settings.interruptions });
});

// On narrow screens the timings and settings are a sheet over the chat.
function setPanel(open: boolean) {
  document.body.classList.toggle("panel-open", open);
  $("panelToggle").setAttribute("aria-expanded", String(open));
}
$("panelToggle").addEventListener("click", () => setPanel(!document.body.classList.contains("panel-open")));
$("backdrop").addEventListener("click", () => setPanel(false));

renderMode();
connect();
