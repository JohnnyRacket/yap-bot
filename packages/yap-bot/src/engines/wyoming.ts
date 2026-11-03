// The Wyoming protocol (Home Assistant's voice services: wyoming-faster-whisper, wyoming-piper, …):
// over TCP, each event is a JSON line { type, data_length?, payload_length? }, then that many bytes
// of JSON data, then that many bytes of payload (audio).
import { connect, type Socket } from "node:net";

export interface WyomingEvent {
  type: string;
  data: Record<string, any>;
  payload?: Buffer;
}

export class WyomingClient {
  private socket: Socket;
  private buf: Buffer = Buffer.alloc(0);
  private waiting: ((e: WyomingEvent | null) => void)[] = [];
  private queued: (WyomingEvent | null)[] = [];
  readonly ready: Promise<void>;
  error: Error | null = null;

  constructor(host: string, port: number, timeoutMs = 5000) {
    this.socket = connect({ host, port });
    this.socket.setNoDelay(true);
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.socket.destroy(new Error(`wyoming ${host}:${port}: no connection after ${timeoutMs} ms`)), timeoutMs);
      this.socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    // a failed connection rejects ready; reading waits on events instead
    this.ready.catch(() => {});
    this.socket.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      // not a Wyoming server (a wrong port answering HTTP, say): this connection fails, nothing else
      try {
        this.parse();
      } catch (e) {
        this.error = new Error(`wyoming ${host}:${port}: not a Wyoming reply (${(e as Error).message}); is that the right port?`);
        this.socket.destroy();
        this.push(null);
      }
    });
    this.socket.on("error", (e) => {
      this.error = e;
      this.push(null);
    });
    this.socket.on("close", () => this.push(null));
  }

  send(type: string, data?: Record<string, unknown>, payload?: Uint8Array) {
    const header: Record<string, unknown> = { type, version: "1.5.2" };
    const dataBytes = data && Object.keys(data).length ? Buffer.from(JSON.stringify(data)) : null;
    if (dataBytes) header.data_length = dataBytes.length;
    if (payload?.length) header.payload_length = payload.length;
    const parts: Uint8Array[] = [Buffer.from(JSON.stringify(header) + "\n")];
    if (dataBytes) parts.push(dataBytes);
    if (payload?.length) parts.push(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength));
    this.socket.write(Buffer.concat(parts));
  }

  /** The next event; null once the connection has closed. */
  next(): Promise<WyomingEvent | null> {
    if (this.queued.length) return Promise.resolve(this.queued.shift()!);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  close() {
    this.socket.destroy();
  }

  private push(e: WyomingEvent | null) {
    const w = this.waiting.shift();
    if (w) w(e);
    else this.queued.push(e);
  }

  private parse() {
    for (;;) {
      const nl = this.buf.indexOf(10);
      if (nl < 0) {
        if (this.buf.length > 64 * 1024) throw new Error("no event header in 64 KB");
        return;
      }
      const header = JSON.parse(this.buf.subarray(0, nl).toString("utf8"));
      const dataLength: number = header.data_length ?? 0;
      const payloadLength: number = header.payload_length ?? 0;
      if (this.buf.length < nl + 1 + dataLength + payloadLength) return;
      let at = nl + 1;
      const data = { ...header.data, ...(dataLength ? JSON.parse(this.buf.subarray(at, at + dataLength).toString("utf8")) : {}) };
      at += dataLength;
      const payload = payloadLength ? Buffer.from(this.buf.subarray(at, at + payloadLength)) : undefined;
      this.buf = this.buf.subarray(at + payloadLength);
      this.push({ type: header.type, data, payload });
    }
  }
}

/** -1…1 floats → PCM s16le. */
export function toPcm16(samples: Float32Array): Uint8Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
  return new Uint8Array(pcm.buffer);
}
