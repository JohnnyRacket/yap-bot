// Speech to text from a Wyoming server (wyoming-faster-whisper and the like, as Home Assistant
// uses). Each utterance gets a connection of its own, opened as it starts, so the audio streams
// while you talk. Servers that stream their text (transcript-chunk) give live words. Runs in the
// hearing worker.
import { toPcm16, WyomingClient } from "./wyoming.ts";
import type { SttFactory, SttStream } from "./types.ts";

export interface WyomingSttOptions {
  host: string;
  port: number;
  /** e.g. "en"; the server's default when unset. */
  language?: string;
  timeoutMs: number;
}

/** About 100 ms per audio-chunk event. */
const CHUNK = 1600;

const create: SttFactory<WyomingSttOptions> = (o, env) => ({
  createStream(): SttStream {
    const client = new WyomingClient(o.host, o.port, Math.min(o.timeoutMs, 5000));
    const format = { rate: env.sampleRate, width: 2, channels: 1 };
    client.send("transcribe", o.language ? { language: o.language } : {});
    client.send("audio-start", format);
    let pending: Float32Array[] = [];
    let pendingSamples = 0;
    let partial = "";
    const flush = () => {
      if (!pendingSamples) return;
      const all = new Float32Array(pendingSamples);
      let at = 0;
      for (const p of pending) all.set(p, (at += p.length) - p.length);
      client.send("audio-chunk", format, toPcm16(all));
      pending = [];
      pendingSamples = 0;
    };
    const final = (async () => {
      for (;;) {
        const e = await client.next();
        if (!e) throw client.error ?? new Error(`wyoming ${o.host}:${o.port} closed without a transcript`);
        if (e.type === "transcript-chunk") partial += e.data.text ?? "";
        else if (e.type === "transcript") return String(e.data.text ?? "");
        else if (e.type === "error") throw new Error(`wyoming: ${e.data.text ?? "error"}`);
      }
    })();
    final.catch(() => {}); // reported by finish()
    return {
      accept(w) {
        pending.push(w.slice());
        pendingSamples += w.length;
        if (pendingSamples >= CHUNK) flush();
      },
      text: () => partial.trim(),
      async finish() {
        flush();
        client.send("audio-stop");
        let timer: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([
            final,
            new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`wyoming ${o.host}:${o.port}: no transcript after ${o.timeoutMs} ms`)), o.timeoutMs))),
          ]);
        } finally {
          clearTimeout(timer);
          client.close();
        }
      },
      close: () => client.close(),
    };
  },
});

export default create;
