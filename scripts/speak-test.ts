// End-to-end voice test: a fake microphone streams silence and synthetic speech into the server in
// real time (open mic mode), "plays" the replies, and reports the timeline. Then it talks over a
// long reply to test interrupting.
//   npm run speak-test            YAP_URL=wss://host:8450/ws to aim it elsewhere
import { TestClient, formatMarks, speech } from "yap-bot/testing";

const url = process.env.YAP_URL ?? "wss://localhost:8450/ws";
const FRAME = 320; // 20 ms at 16 kHz

/** Sends 20 ms frames on a real-time clock: queued speech when there is some, silence otherwise. */
class Mic {
  private queue: { pcm: Int16Array; done: () => void }[] = [];
  private pos = 0;
  private running = true;
  private c: TestClient;
  constructor(c: TestClient) {
    this.c = c;
    void this.run();
  }
  say(pcm: Int16Array): Promise<void> {
    return new Promise((done) => this.queue.push({ pcm, done }));
  }
  stop() {
    this.running = false;
  }
  private async run() {
    const t0 = performance.now();
    for (let n = 0; this.running; n++) {
      const wait = t0 + (n + 1) * 20 - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const cur = this.queue[0];
      if (!cur) {
        this.c.sendAudio(new Int16Array(FRAME));
        continue;
      }
      this.c.sendAudio(cur.pcm.subarray(this.pos, this.pos + FRAME));
      this.pos += FRAME;
      if (this.pos >= cur.pcm.length) {
        this.queue.shift();
        this.pos = 0;
        cur.done();
      }
    }
  }
}

const c = new TestClient();
c.onEvent = ({ msg }) => {
  if (msg.type === "transcript" && msg.final) console.log(`  🎤 "${msg.text}"`);
  if (msg.type === "assistant") console.log(`  🔊 ${msg.text}`);
  if (msg.type === "tool" && (msg.output !== undefined || msg.error)) console.log(`  🔧 ${msg.name}(${JSON.stringify(msg.input)})`);
  if (msg.type === "stop") console.log(`  ⏹  stop`);
  if (msg.type === "turn_done") console.log(`  ✅ turn ${msg.turnId} done${msg.interrupted ? `, INTERRUPTED; heard so far: "${msg.spoken}"` : ""}`);
  if (msg.type === "metrics") console.log(`  ⏱  ${formatMarks(msg.marks)}`);
};
await c.connect(url, `speak-test-${process.pid}`, "open");
const mic = new Mic(c);
const metricsCount = () => c.events.filter((e) => e.msg.type === "metrics").length;
const waitMetrics = (n: number) => c.waitFor(() => metricsCount() >= n, 60_000).catch(() => {});

console.log("1) a question");
await mic.say(await speech("What's the weather going to be like tomorrow?"));
await waitMetrics(1);

console.log("\n2) a long answer, talked over ~2 s into it");
await mic.say(await speech("Tell me a story about a cat who goes to the moon."));
await c.waitFor((m) => m.type === "state" && m.state === "speaking", 60_000);
const interruptAt = Date.now() + 2000;
// a read-only ask: this runs against the real server, where a timer would later ring in every room
const words = await speech("Okay stop. What's the weather today instead?");
await new Promise((r) => setTimeout(r, Math.max(0, interruptAt - Date.now())));
const spokeAt = Date.now();
const stopped = c.waitFor((m) => m.type === "stop", 10_000).then(() => Date.now());
void mic.say(words);
console.log(`  (stop arrived ${(await stopped) - spokeAt} ms after the interruption started)`);
await waitMetrics(3);

mic.stop();
c.close();
process.exit(0);
