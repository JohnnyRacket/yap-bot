// Wake-word latency: synthetic speech through a real-time fake mic, the way the browser streams it,
// and how long after the speech ends the turn is decided and the first sound plays.
//   node scripts/wake-latency.ts "Computer, what's the weather tomorrow?" [runs] [open]
// YAP_URL=wss://host:8450/ws to aim it elsewhere. Runs are 11 s apart so each one wakes by
// the keyword rather than inside the previous turn's follow-up window.
import { TestClient, speech } from "yap-bot/testing";

const url = process.env.YAP_URL ?? "wss://localhost:8450/ws";
const [text = "Computer, what's the weather tomorrow?", runs = "3", open] = process.argv.slice(2);
const mode = open === "open" ? "open" : "wake";
const FRAME = 320; // 20 ms at 16 kHz

const c = new TestClient();
await c.connect(url, `wake-latency-${process.pid}`, mode);
if (mode === "wake") c.send({ type: "mode", mode: "wake", wakeDetector: "keyword" });

const clip = await speech(text);
let last = clip.length - 1;
while (last > 0 && Math.abs(clip[last]) < 500) last--;
const speechMs = (last / 16000) * 1000;

// the mic: the clip when queued, silence otherwise, on a real-time clock
let queued = null as Int16Array | null;
let pos = 0;
let clipStart = 0;
let running = true;
void (async () => {
  const t0 = performance.now();
  for (let n = 0; running; n++) {
    const wait = t0 + (n + 1) * 20 - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (!queued) {
      c.sendAudio(new Int16Array(FRAME));
      continue;
    }
    if (pos === 0) clipStart = Date.now();
    c.sendAudio(queued.subarray(pos, pos + FRAME));
    pos += FRAME;
    if (pos >= queued.length) [queued, pos] = [null, 0];
  }
})();

await new Promise((r) => setTimeout(r, 1500));
for (let i = 0; i < Number(runs); i++) {
  const metrics = c.waitFor((m) => m.type === "metrics", 60_000);
  queued = clip;
  const m = (await metrics) as unknown as { marks: { name: string; at: number; detail?: string }[] };
  const ended = clipStart + speechMs;
  const mark = (name: string) => m.marks.find((x) => x.name === name);
  const after = (name: string) => (mark(name) ? `${((mark(name)!.at - ended) / 1000).toFixed(2)}s` : "-");
  const heard = c.events.filter((e) => e.msg.type === "transcript" && e.msg.final).at(-1);
  console.log(
    `run ${i + 1}: decided ${after("turn_end")} (${mark("turn_end")?.detail}), ${mark("stt_final")?.detail}, ` +
      `first sound ${after("tts_first_audio")}  heard "${(heard?.msg as { text?: string })?.text}"`,
  );
  await new Promise((r) => setTimeout(r, 11_000));
}
running = false;
c.close();
process.exit(0);
