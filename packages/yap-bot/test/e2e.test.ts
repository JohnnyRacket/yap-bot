// A whole server on the test agent: fake speech engines (no models), a mock LLM, a headless device.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../src/protocol.ts";
import { TestClient } from "../src/testing/client.ts";
import { start, type Running } from "../src/start.ts";
import { startMockLlm, type MockLlm } from "./fixtures/mock-llm.ts";

let llm: MockLlm;
let server: Running;
let url: string;
const clients: TestClient[] = [];

before(async () => {
  llm = await startMockLlm();
  process.env.TEST_LLM_URL = llm.url;
  // one line per spoken utterance, in the order the tests speak them
  process.env.TEST_STT_LINES = JSON.stringify(["hello out there", "okay stop that please"]);
  server = await start({
    agentDir: join(import.meta.dirname, "fixtures/agent"),
    dataDir: mkdtempSync(join(tmpdir(), "yap-test-")),
    modelsDir: mkdtempSync(join(tmpdir(), "yap-models-")),
    port: 0,
    tls: "off",
    watch: false,
    download: false,
    handleSignals: false,
  });
  url = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  for (const c of clients) c.close();
  await server?.close();
  await llm?.close();
});

async function device(mode: "push" | "open" = "push") {
  const c = new TestClient();
  await c.connect(`ws://127.0.0.1:${server.port}/ws`, `test-${clients.length}`, mode);
  clients.push(c);
  return c;
}

/** Everything the server sends from now until the turn is done (and its metrics are in). */
async function untilDone(c: TestClient, timeoutMs = 20_000): Promise<ServerMessage[]> {
  const from = c.events.length;
  // metrics come right after turn_done, in the same breath
  await c.waitFor((m) => m.type === "metrics", timeoutMs);
  return c.events.slice(from).map((e) => e.msg);
}

const said = (msgs: ServerMessage[]) => msgs.flatMap((m) => (m.type === "assistant" ? [m.text] : []));

/** 16 kHz: a loud stretch (speech, to the test VAD) then quiet. */
function utterance(speechMs: number, silenceMs: number): Int16Array {
  const pcm = new Int16Array(((speechMs + silenceMs) * 16000) / 1000);
  for (let i = 0; i < (speechMs * 16000) / 1000; i++) pcm[i] = Math.round(8000 * Math.sin(i / 5));
  return pcm;
}

async function speak(c: TestClient, pcm: Int16Array) {
  for (let i = 0; i < pcm.length; i += 320) {
    c.sendAudio(pcm.slice(i, i + 320));
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("welcome carries the agent's name and look", async () => {
  const c = new TestClient();
  const welcome = new Promise<ServerMessage>((resolve) => (c.onEvent = ({ msg }) => msg.type === "welcome" && resolve(msg)));
  await c.connect(`ws://127.0.0.1:${server.port}/ws`, "welcome-test", "push");
  clients.push(c);
  const w = await welcome;
  assert.equal(w.type === "welcome" && w.agent, "Test agent");
  assert.equal(w.type === "welcome" && w.ui.icon, "🗣️");
});

test("a typed turn calls a tool: ack first, then the reply without its own okay", async () => {
  const c = await device();
  c.send({ type: "text", text: "set a tea timer for five minutes" });
  const msgs = await untilDone(c);
  const tool = msgs.find((m) => m.type === "tool" && m.output !== undefined);
  assert.ok(tool && tool.type === "tool");
  assert.equal(tool.name, "set_timer");
  assert.deepEqual(tool.output, { name: "tea", length: "5 minutes" });
  assert.deepEqual(said(msgs), ["Okay.", "Done.", "Your timer is running."]);
  assert.equal(server.hub.timers.list().length, 1);
  // the model saw the turn context and the tool's result
  const last = llm.requests[llm.requests.length - 1].messages;
  assert.match(String(last.find((m) => m.role === "user")?.content), /^\[.+ · room: test\]\nset a tea timer/);
  assert.equal(last[last.length - 1].role, "tool");
});

test("a fastpath answers without the model", async () => {
  const c = await device();
  const before = llm.requests.length;
  c.send({ type: "text", text: "Ping!" });
  assert.deepEqual(said(await untilDone(c)), ["Pong."]);
  assert.equal(llm.requests.length, before);
});

test("history carries over between turns on a device", async () => {
  const c = await device();
  c.send({ type: "text", text: "hi" });
  await untilDone(c);
  c.send({ type: "text", text: "hi again" });
  await untilDone(c);
  const msgs = llm.requests[llm.requests.length - 1].messages;
  assert.deepEqual(
    msgs.filter((m) => m.role !== "system").map((m) => m.role),
    ["user", "assistant", "user"],
  );
});

test("a model failure is said, not swallowed", async () => {
  const c = await device();
  c.send({ type: "text", text: "this is broken" });
  const msgs = await untilDone(c);
  assert.ok(msgs.some((m) => m.type === "error"));
  assert.deepEqual(said(msgs), ["Sorry, something went wrong."]);
});

test("a spoken turn: voice activity, the engine's final text (async), the reply", async () => {
  const c = await device("open");
  const done = untilDone(c);
  await speak(c, utterance(600, 800));
  const msgs = await done;
  const final = msgs.find((m) => m.type === "transcript" && m.final);
  assert.equal(final?.type === "transcript" && final.text, "hello out there");
  assert.deepEqual(said(msgs), ["Hello there.", "How can I help?"]);
});

test("talking over a long reply interrupts it", async () => {
  const c = await device("open");
  c.send({ type: "text", text: "tell me a story" });
  await c.waitFor((m) => m.type === "state" && m.state === "speaking", 10_000);
  const done = c.waitFor((m) => m.type === "turn_done", 15_000);
  const stopped = c.waitFor((m) => m.type === "stop", 15_000);
  await speak(c, utterance(900, 600));
  await stopped;
  const d = await done;
  assert.ok(d.type === "turn_done" && d.interrupted);
  assert.ok(d.type === "turn_done" && d.spoken.length < 200, "only what was heard is kept");
});

test("end_conversation ends the turn without another model round", async () => {
  const c = await device();
  const before = llm.requests.length;
  c.send({ type: "text", text: "okay bye" });
  const msgs = await untilDone(c);
  assert.equal(llm.requests.length, before + 1);
  assert.deepEqual(said(msgs), []);
});

test("a webhook trigger announces on connected devices", async () => {
  const c = await device();
  const announced = c.waitFor((m) => m.type === "announce", 5000);
  const res = await fetch(`${url}/hooks/door`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ who: "Sam" }) });
  assert.equal(res.status, 202);
  const a = await announced;
  assert.equal(a.type === "announce" && a.text, "Someone is at the door: Sam.");
  assert.equal((await fetch(`${url}/hooks/nope`, { method: "POST" })).status, 404);
});

test("/api/ask needs the secret and runs tools", async () => {
  const ask = (auth?: string) =>
    fetch(`${url}/api/ask`, { method: "POST", headers: auth ? { Authorization: `Bearer ${auth}` } : {}, body: JSON.stringify({ text: "set a timer" }) });
  assert.equal((await ask()).status, 401);
  assert.equal((await ask("wrong")).status, 401);
  const res = await ask("test-secret");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { reply: string; tools: { name: string }[] };
  assert.equal(body.tools[0].name, "set_timer");
  assert.match(body.reply, /timer is running/);
});

test("a slow tool times out: the model is told, and the tool's signal is aborted", async () => {
  const c = await device();
  c.send({ type: "text", text: "do the slow lookup" });
  const msgs = await untilDone(c);
  const tool = msgs.find((m) => m.type === "tool" && m.error !== undefined);
  assert.match(tool?.type === "tool" ? String(tool.error) : "", /timed out after 0.3 s/);
  assert.deepEqual(said(msgs), ["That took too long."]);
});

test("a device token keeps out devices without it", async () => {
  server.hub.reg.agent.deviceToken = "letmein";
  try {
    const closed = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=nope`);
      ws.onclose = (e) => resolve(e.code);
    });
    assert.equal(closed, 4401);
    const c = new TestClient();
    await c.connect(`ws://127.0.0.1:${server.port}/ws?token=letmein`, "with-token", "push");
    clients.push(c);
    const h = (await (await fetch(`${url}/health`)).json()) as { devices?: unknown };
    assert.equal(h.devices, undefined, "health doesn't list devices to strangers");
  } finally {
    server.hub.reg.agent.deviceToken = undefined;
  }
});

test("health", async () => {
  const h = (await (await fetch(`${url}/health`)).json()) as { ok: boolean; agent: string };
  assert.deepEqual([h.ok, h.agent], [true, "Test agent"]);
});
