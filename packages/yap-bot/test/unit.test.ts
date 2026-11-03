import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { parseFrontmatter } from "../src/agent/loader.ts";
import { trimHistory } from "../src/agent/prompt.ts";
import { dropLeadingAck } from "../src/session.ts";
import { fill, parseDuration } from "../src/triggers.ts";
import { SentenceSplitter } from "../src/speech/splitter.ts";
import { pcmResampler, trimSilence } from "../src/speech/tts.ts";
import { spokenDuration } from "../src/services/timers.ts";
import { WyomingClient } from "../src/engines/wyoming.ts";
import { defineAgent, defineVoice, defineTrigger } from "../src/define.ts";
import type { ChatMessage } from "../src/llm/client.ts";

test("frontmatter: values, inline lists and dash lists", () => {
  const { data, body } = parseFrontmatter("---\ncron: '0 7 * * *'\nkeywords: [a, b]\nrooms:\n  - kitchen\n  - office\n---\nThe body.\n");
  assert.deepEqual(data, { cron: "0 7 * * *", keywords: ["a", "b"], rooms: ["kitchen", "office"] });
  assert.equal(body, "The body.");
  assert.deepEqual(parseFrontmatter("no frontmatter").data, {});
});

test("trimHistory drops back to half, starting at a user message", () => {
  const h: ChatMessage[] = [];
  for (let i = 0; i < 10; i++) h.push({ role: "user", content: `u${i}` }, { role: "assistant", content: `a${i}` });
  const t = trimHistory(h, 8);
  assert.equal(t[0].role, "user");
  assert.ok(t.length <= 4);
  assert.equal(trimHistory(h.slice(0, 4), 8).length, 4);
});

test("dropLeadingAck removes a repeated okay", () => {
  assert.equal(dropLeadingAck("OK, I've set it."), "I've set it.");
  assert.equal(dropLeadingAck("Okay."), "");
  assert.equal(dropLeadingAck("Okra is a vegetable."), "Okra is a vegetable.");
});

test("trigger templates and durations", () => {
  assert.equal(fill("{{payload.who}} at {{payload.where}}", { source: "webhook", payload: { who: "Sam", where: "door" }, query: {} }), "Sam at door");
  assert.equal(fill("{{payload}}", { source: "webhook", payload: { a: 1 }, query: {} }), '{"a":1}');
  assert.equal(parseDuration("5m"), 300_000);
  assert.equal(parseDuration("1.5h"), 5_400_000);
  assert.throws(() => parseDuration("5 minutes"));
});

test("sentence splitter cuts at sentence ends", () => {
  const out: string[] = [];
  const s = new SentenceSplitter((p) => out.push(p));
  for (const piece of ["Hello there. It is 3.5 deg", "rees today! What", " now"]) s.push(piece);
  s.flush();
  assert.ok(out.length >= 2, JSON.stringify(out));
  assert.equal(out.join(" ").replace(/\s+/g, " "), "Hello there. It is 3.5 degrees today! What now");
});

test("sentence splitter keeps names and titles in one piece", () => {
  const split = (pieces: string[]) => {
    const out: string[] = [];
    const s = new SentenceSplitter((p) => out.push(p));
    for (const p of pieces) s.push(p);
    s.flush();
    return out;
  };
  // the cases that cut a sentence in two: an initial, an abbreviation, a title ending in "!"
  assert.deepEqual(split(["Thornhedge is by T. Kingfisher, and it's short."]), ["Thornhedge is by T. Kingfisher, and it's short."]);
  assert.deepEqual(split(["The Hobbit is by J.R.R. Tolkien. It's ", "a classic."]), ["The Hobbit is by J.R.R. Tolkien.", "It's a classic."]);
  assert.deepEqual(split(["Ask Dr. Seuss. He knows."]), ["Ask Dr. Seuss.", "He knows."]);
  assert.deepEqual(split(["You can borrow Last Chance Live!", " as an audiobook. Want it?"]), ["You can borrow Last Chance Live! as an audiobook.", "Want it?"]);
  // a sentence end at the end of what's streamed so far waits for the next word, then cuts
  const out: string[] = [];
  const s = new SentenceSplitter((p) => out.push(p));
  s.push("It's due Friday. ");
  assert.equal(out.length, 0);
  s.push("Want to renew it?");
  assert.deepEqual(out, ["It's due Friday."]);
});

test("a store reads its file again when something else changed it", async () => {
  const { storeFor } = await import("../src/services/store.ts");
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "yap-store-"));
  const st = storeFor(dir, "linked");
  st.set("a", 1);
  // another process (a link script) writes the file; mtime resolution can be coarse, so step it
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(join(dir, "store", "linked.json"), JSON.stringify({ a: 1, token: "abc" }));
  assert.equal(st.get("token"), "abc");
  st.set("b", 2);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "store", "linked.json"), "utf8")), { a: 1, token: "abc", b: 2 }, "a later write keeps what the other process wrote");
});

test("resampler keeps the length in proportion, across pieces", () => {
  const r = pcmResampler(16000, 24000);
  let samples = 0;
  for (let i = 0; i < 10; i++) samples += r(new Uint8Array(new Int16Array(1600).fill(1000).buffer)).byteLength / 2;
  assert.ok(Math.abs(samples - 24000) < 4, `${samples}`);
});

test("trimSilence keeps the speech", () => {
  const pcm = new Int16Array(24000);
  pcm.fill(5000, 10000, 12000);
  const t = trimSilence(pcm);
  assert.ok(t.length < pcm.length && t.length >= 2000);
});

test("voices: graded best first, the default always offered", async () => {
  const { kokoroVoiceChoices } = await import("../src/engines/index.ts");
  const all = kokoroVoiceChoices();
  assert.equal(all[0].id, "af_heart");
  assert.equal(all.at(-1)!.id, "am_adam");
  const men = kokoroVoiceChoices({ gender: "man", minGrade: "C" });
  assert.deepEqual(men.map((v) => v.id), ["am_michael", "am_fenrir", "am_puck", "bm_george", "bm_fable"]);
  assert.equal(men[0].label, "Michael · American man · C+");
  // the default joins the list when it isn't on it, first
  const v = defineVoice({ tts: { voice: "bm_lewis", voices: men } });
  assert.equal(v.tts.voices[0].id, "bm_lewis");
  assert.equal(v.tts.voices.length, 6);
  assert.deepEqual(defineVoice().tts.voices, [{ id: "af_heart", label: "af_heart" }]);
});

test("atStart goes with every", () => {
  assert.throws(() => defineTrigger({ on: { atStart: true, webhook: true }, announce: "x" }));
  assert.equal(defineTrigger({ on: { every: "1h", atStart: true }, announce: "x" }).on.atStart, true);
});

test("spokenDigits", async () => {
  const { spokenDigits } = await import("../src/spoken.ts");
  assert.equal(spokenDigits("52541470"), "5 2 5 4, 1 4 7 0");
  assert.equal(spokenDigits(123456, 3), "1 2 3, 4 5 6");
});

test("spokenDuration", () => {
  assert.equal(spokenDuration(90_000), "1 minute 30 seconds");
  assert.equal(spokenDuration(3_660_000), "1 hour 1 minute");
});

test("defaults: defineAgent and defineVoice", () => {
  const a = defineAgent({ name: "x", model: { id: "m" } });
  assert.equal(a.wake.word, "computer");
  assert.equal(a.ui.title, "x");
  const custom = defineAgent({ name: "x", wake: { word: "jarvis" } });
  assert.equal(custom.wake.keywords, undefined, "a custom wake word doesn't inherit computer's spotter tokens");
  const v = defineVoice();
  assert.equal(v.tts.voice, "af_heart");
  assert.ok(v.turn.detector);
  assert.throws(() => defineTrigger({ on: {}, announce: "x" }));
});

test("kokoro fetches the voice that's picked", async () => {
  const { kokoro } = await import("../src/engines/index.ts");
  const spec = kokoro({ voices: ["af_heart"] });
  assert.deepEqual(spec.downloadsFor?.("am_puck").map((d) => d.path), ["kokoro/voices/am_puck.bin"]);
  assert.deepEqual(spec.downloadsFor?.("not a voice"), []);
});

test("shared() makes a value once per server", async () => {
  const { shared } = await import("../src/shared.ts");
  let made = 0;
  const a = shared("test-thing", () => ({ n: ++made }));
  const b = shared("test-thing", () => ({ n: ++made }));
  assert.equal(a, b);
  assert.equal(made, 1);
});

test("a wrong port answering HTTP fails the Wyoming connection, not the process", async () => {
  const server = createServer((sock) => sock.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const client = new WyomingClient("127.0.0.1", (server.address() as { port: number }).port);
  client.send("describe");
  assert.equal(await client.next(), null);
  assert.match(String(client.error?.message), /not a Wyoming reply/);
  server.close();
});

test("trimHistory also trims by size", () => {
  const big = "x".repeat(5000);
  const h: ChatMessage[] = [];
  for (let i = 0; i < 6; i++) h.push({ role: "user", content: `q${i}` }, { role: "assistant", content: big });
  const t = trimHistory(h, 40, 12_000);
  assert.ok(t.reduce((n, m) => n + (m.content?.length ?? 0), 0) <= 6000 + 10);
  assert.equal(t[0].role, "user");
});

test("wyoming events: split data and payload, in pieces", async () => {
  const server = createServer((sock) => {
    sock.on("data", () => {
      const data = Buffer.from(JSON.stringify({ rate: 16000, width: 2, channels: 1 }));
      const header = Buffer.from(JSON.stringify({ type: "audio-chunk", data_length: data.length, payload_length: 4 }) + "\n");
      const all = Buffer.concat([header, data, Buffer.from([1, 0, 2, 0]), Buffer.from('{"type":"audio-stop"}\n')]);
      // byte by byte: the parser must wait for whole events
      for (let i = 0; i < all.length; i++) sock.write(all.subarray(i, i + 1));
      sock.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const client = new WyomingClient("127.0.0.1", (server.address() as { port: number }).port);
  client.send("synthesize", { text: "hi" });
  const e1 = await client.next();
  assert.equal(e1?.type, "audio-chunk");
  assert.equal(e1?.data.rate, 16000);
  assert.deepEqual([...(e1?.payload ?? [])], [1, 0, 2, 0]);
  assert.equal((await client.next())?.type, "audio-stop");
  assert.equal(await client.next(), null);
  client.close();
  server.close();
});
