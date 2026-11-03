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
import { voices as ttsVoices } from "./fixtures/engines/silent-tts.ts";

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

test("a device picks its voice from the agent's", async () => {
  const c = await device();
  const welcome = c.events.find((e) => e.msg.type === "welcome")?.msg;
  assert.ok(welcome?.type === "welcome");
  // the default voice joins the list (first), the offered one follows
  assert.deepEqual(welcome.voices.map((v) => v.id), ["test", "other"]);
  assert.equal(welcome.voice, "test");
  // the voices synthesized during a turn (short phrases come from the cache once made, so none at all is possible)
  const voicesOfTurn = async (text: string) => {
    const from = ttsVoices.length;
    c.send({ type: "text", text });
    await untilDone(c);
    return new Set(ttsVoices.slice(from).map((v) => v.voice));
  };
  c.send({ type: "voice", voice: "other" });
  assert.deepEqual([...(await voicesOfTurn("hello"))], ["other"]);
  // a voice the agent doesn't offer falls back to the default
  c.send({ type: "voice", voice: "nope" });
  assert.ok(!(await voicesOfTurn("hello again")).has("other"));
});

test("end_conversation ends the turn without another model round", async () => {
  const c = await device();
  // only this turn's requests: an earlier test's device can still be finishing a turn of its own
  // (a second round would carry "okay bye" too, followed by the tool result)
  const mine = () => llm.requests.filter((r) => r.messages.some((m) => m.role === "user" && JSON.stringify(m.content ?? "").includes("okay bye"))).length;
  c.send({ type: "text", text: "okay bye" });
  const msgs = await untilDone(c);
  assert.equal(mine(), 1);
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

test("a webhook with respond waits and answers with the result", async () => {
  const post = (body: unknown) => fetch(`${url}/hooks/sum`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const ok = await post({ a: 2, b: 3 });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, trigger: "sum", result: { sum: 5 } });
  const failed = await post({ a: -1, b: 3 });
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).error, "no negatives");
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
    // a client turned away hears why at once, not after a timeout
    const refused = new TestClient();
    const t0 = Date.now();
    await assert.rejects(refused.connect(`ws://127.0.0.1:${server.port}/ws?token=nope`, "no-token", "push"), /device token needed/);
    assert.ok(Date.now() - t0 < 2000);
    const c = new TestClient();
    await c.connect(`ws://127.0.0.1:${server.port}/ws?token=letmein`, "with-token", "push");
    clients.push(c);
    const h = (await (await fetch(`${url}/health`)).json()) as { devices?: unknown };
    assert.equal(h.devices, undefined, "health doesn't list devices to strangers");
  } finally {
    server.hub.reg.agent.deviceToken = undefined;
  }
});

/** The roles of the last request's conversation, and whether every tool call in it was answered. */
function lastConversation() {
  const msgs = llm.requests[llm.requests.length - 1].messages.filter((m) => m.role !== "system");
  const ids = msgs.flatMap((m) => (m.role === "assistant" && m.tool_calls ? m.tool_calls.map((c) => c.id) : []));
  const answered = new Set(msgs.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : [])));
  return { roles: msgs.map((m) => m.role), unanswered: ids.filter((id) => !answered.has(id)) };
}

test("interrupted during a tool: the calls after it don't run, and the history stays valid", async () => {
  const c = await device();
  const timersBefore = server.hub.timers.list().length;
  c.send({ type: "text", text: "place the hold twice" });
  await c.waitFor((m) => m.type === "tool" && m.name === "slow_lookup" && m.output === undefined && m.error === undefined);
  c.send({ type: "interrupt" });
  await c.waitFor((m) => m.type === "turn_done");
  await new Promise((r) => setTimeout(r, 500)); // past the slow tool's own timeout
  assert.equal(server.hub.timers.list().length, timersBefore, "the second call (a timer) never ran");
  c.send({ type: "text", text: "hi" });
  await untilDone(c);
  const { roles, unanswered } = lastConversation();
  assert.deepEqual(unanswered, [], "every tool call in the history has a result");
  assert.deepEqual(roles, ["user", "assistant", "tool", "tool", "assistant", "user"]);
});

test("a device that disconnects mid-turn leaves a valid history behind", async () => {
  const c = await device();
  c.send({ type: "text", text: "tell me a story" });
  await c.waitFor((m) => m.type === "state" && m.state === "speaking", 10_000);
  c.close();
  await new Promise((r) => setTimeout(r, 200));
  const again = new TestClient();
  await again.connect(`ws://127.0.0.1:${server.port}/ws`, `test-${clients.indexOf(c)}`, "push");
  clients.push(again);
  again.send({ type: "text", text: "hi" });
  await untilDone(again);
  assert.deepEqual(lastConversation().roles, ["user", "assistant", "user"]);
});

test("a tool that throws a string is reported as failed, not as done", async () => {
  const c = await device();
  c.send({ type: "text", text: "throw a string" });
  const msgs = await untilDone(c);
  const tool = msgs.find((m) => m.type === "tool" && m.error !== undefined);
  assert.equal(tool?.type === "tool" && tool.error, "the library said no");
  assert.deepEqual(said(msgs), ["That didn't work."]);
});

test("text before a tool call is a sentence of its own", async () => {
  const c = await device();
  c.send({ type: "text", text: "how many are my holds" });
  assert.deepEqual(said(await untilDone(c)), ["Let me check that", "She has three holds."]);
});

test("a model that stalls is given up on, and the turn says so", async () => {
  const c = await device();
  c.send({ type: "text", text: "please stall" });
  const msgs = await untilDone(c, 10_000);
  const err = msgs.find((m) => m.type === "error");
  assert.match(err?.type === "error" ? err.message : "", /stalled after 0.6 s/);
  assert.equal(said(msgs).at(-1), "Sorry, something went wrong.");
  // and the next turn isn't stuck behind it
  c.send({ type: "text", text: "hi" });
  assert.deepEqual(said(await untilDone(c)), ["Hello there.", "How can I help?"]);
});

test("health", async () => {
  const h = (await (await fetch(`${url}/health`)).json()) as { ok: boolean; agent: string };
  assert.deepEqual([h.ok, h.agent], [true, "Test agent"]);
});
