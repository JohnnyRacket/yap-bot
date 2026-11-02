// Streaming speech to text from a sherpa-onnx WebSocket server (sherpa-onnx-online-websocket-server,
// or python-api-examples/streaming_server.py): the same kind of model as the built-in engine, on
// another machine, with live words. Each utterance gets a connection of its own. Runs in the
// hearing worker.
import type { SttFactory, SttStream } from "./types.ts";

export interface SherpaWsSttOptions {
  /** e.g. ws://asr.lan:6006 */
  url: string;
  /** Silence sent after the last speech so the server decodes its final chunk. */
  padMs: number;
  timeoutMs: number;
}

const create: SttFactory<SherpaWsSttOptions> = (o, env) => ({
  createStream(): SttStream {
    const ws = new WebSocket(o.url);
    ws.binaryType = "arraybuffer";
    const queued: (ArrayBuffer | string)[] = [];
    // the server numbers its segments (it splits long speech at pauses); the text is all of them
    const segments = new Map<number, string>();
    const text = () => [...segments.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t.trim()).filter(Boolean).join(" ");
    const send = (m: ArrayBuffer | string) => (ws.readyState === WebSocket.OPEN ? ws.send(m) : queued.push(m));
    ws.onopen = () => {
      for (const m of queued.splice(0)) ws.send(m);
    };
    const done = new Promise<string>((resolve, reject) => {
      ws.onmessage = (ev) => {
        if (ev.data === "Done!") return resolve(text());
        try {
          const m = JSON.parse(String(ev.data)) as { text?: string; segment?: number };
          segments.set(m.segment ?? 0, m.text ?? "");
        } catch {}
      };
      ws.onerror = () => reject(new Error(`${o.url}: connection failed`));
      ws.onclose = () => resolve(text());
    });
    done.catch(() => {}); // reported by finish()
    return {
      accept(w) {
        send(w.slice().buffer);
      },
      text,
      async finish(trailingSilence) {
        const pad = Math.max(0, Math.round((o.padMs / 1000) * env.sampleRate) - trailingSilence);
        if (pad) send(new Float32Array(pad).buffer);
        send("Done");
        let timer: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([done, new Promise<string>((resolve) => (timer = setTimeout(() => resolve(text()), o.timeoutMs)))]);
        } finally {
          clearTimeout(timer);
          ws.close();
        }
      },
      close: () => ws.close(),
    };
  },
});

export default create;
