// Does the wake word wake it, and only it? Synthetic speech through a real-time fake mic in wake mode
// (keyword spotter on the server), one fresh device per sentence, in several voices. A sentence
// "wakes" when the server says it's awake within a few seconds of it.
//   node scripts/wake-check.ts "Bookworm, what's next?" "I booked a table" …
// YAP_URL=wss://host:8450/ws to aim it elsewhere, YAP_DEVICE_TOKEN for an agent that needs one.
import { TestClient, speech } from "yap-bot/testing";

const url = process.env.YAP_URL ?? "wss://localhost:8450/ws";
const token = process.env.YAP_DEVICE_TOKEN;
const voices = ["af_heart", "am_michael", "bf_emma"];
const FRAME = 320; // 20 ms at 16 kHz

async function wakes(text: string, voice: string): Promise<boolean> {
  const c = new TestClient();
  await c.connect(token ? `${url}?token=${encodeURIComponent(token)}` : url, `wake-check-${process.pid}-${Math.random().toString(36).slice(2, 6)}`, "wake");
  c.send({ type: "mode", mode: "wake", wakeDetector: "keyword" });
  const clip = await speech(text, voice);
  const audio = new Int16Array(clip.length + 16000 * 3); // the clip, then 3 s of silence
  audio.set(clip);
  const t0 = performance.now();
  for (let n = 0; n * FRAME < audio.length; n++) {
    const wait = t0 + n * 20 - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    c.sendAudio(audio.subarray(n * FRAME, (n + 1) * FRAME));
  }
  const woke = c.events.some((e) => e.msg.type === "state" && e.msg.awake === true);
  c.close();
  return woke;
}

const sentences = process.argv.slice(2);
for (const text of sentences) {
  const woke: string[] = [];
  for (const v of voices) if (await wakes(text, v)) woke.push(v);
  const others = voices.filter((v) => !woke.includes(v));
  console.log(`${woke.length}/${voices.length} woke  "${text}"${woke.length && others.length ? `  (not ${others.join(", ")})` : ""}`);
}
process.exit(0);
