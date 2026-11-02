// HTTPS (browsers only give a page the microphone on a secure origin) + the device WebSocket +
// the built web client.
import { createServer as createHttps } from "node:https";
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { networkInterfaces, hostname } from "node:os";
import { WebSocketServer } from "ws";
import { generate } from "selfsigned";
import type { Hub } from "./hub.ts";
import { log } from "./log.ts";
import { writeJson, readJson } from "./services/store.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

export interface ServerOptions {
  port: number;
  webDir: string;
  dataDir: string;
  /** "self-signed" (default), "off", or explicit cert/key files. */
  tls: "self-signed" | "off" | { cert: string; key: string };
  tlsNames: string[];
}

/** A self-signed certificate, kept in the data dir so the browser exception survives restarts. */
async function selfSigned(dataDir: string, names: string[]) {
  const file = join(dataDir, "tls.json");
  const saved = readJson<{ names: string[]; cert: string; key: string } | null>(file, null);
  if (saved && JSON.stringify(saved.names) === JSON.stringify(names)) return saved;
  const altNames = names.map((n) => (/^[\d.]+$|:/.test(n) ? { type: 7 as const, ip: n } : { type: 2 as const, value: n }));
  const pems = await generate([{ name: "commonName", value: names[0] }], {
    keySize: 2048,
    algorithm: "sha256",
    notAfterDate: new Date(Date.now() + 3650 * 86400_000),
    extensions: [{ name: "subjectAltName", altNames }],
  });
  const out = { names, cert: pems.cert, key: pems.private };
  writeJson(file, out);
  return out;
}

export function defaultTlsNames(): string[] {
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i!.address);
  return ["localhost", hostname(), `${hostname()}.localdomain`, "127.0.0.1", ...ips];
}

/** GET /models/kws/<file>: the keyword spotter, for devices that spot the wake word themselves. */
function serveKwsModel(hub: Hub, req: IncomingMessage, res: ServerResponse) {
  const name = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname.slice("/models/kws/".length));
  const file = hub.kwsModel?.files[name];
  if (!file) return void res.writeHead(404).end("no such model file");
  res.writeHead(200, {
    "Content-Type": name.endsWith(".txt") ? "text/plain; charset=utf-8" : "application/octet-stream",
    // devices ask with ?v=<modelVersion>, so a new model is a new URL
    "Cache-Control": "max-age=31536000, immutable",
  });
  res.end(readFileSync(file));
}

function serveStatic(webDir: string, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(webDir, path);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(webDir, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404).end("no web client here (WEB_DIR)");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": file.endsWith("index.html") ? "no-cache" : "max-age=3600" });
  res.end(readFileSync(file));
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString("utf8");
}

/** POST (or GET) /hooks/<name> → the webhook trigger of that name. */
async function webhook(hub: Hub, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const name = decodeURIComponent(url.pathname.slice("/hooks/".length));
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST" && req.method !== "GET") return reply(405, { error: "use POST" });
  let payload: unknown = null;
  try {
    const raw = req.method === "POST" ? await readBody(req) : "";
    payload = raw && (req.headers["content-type"] ?? "").includes("json") ? JSON.parse(raw) : raw || null;
  } catch (e) {
    return reply(400, { error: (e as Error).message });
  }
  const r = hub.triggers.webhook(name, payload, Object.fromEntries(url.searchParams), req.headers.authorization);
  reply(r.status, r.body);
}

/**
 * POST /api/ask {"text": "...", "room": "kitchen"}: one typed turn through the agent (tools run for
 * real), answered with the reply and the tool calls. Needs "Authorization: Bearer <apiSecret>" (the agent's
 * apiSecret, default $YAP_API_SECRET).
 */
async function ask(hub: Hub, req: IncomingMessage, res: ServerResponse) {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body, null, 2));
  };
  if (req.method !== "POST") return reply(405, { error: "use POST" });
  const secret = hub.reg.agent.apiSecret;
  if (!secret) return reply(401, { error: "the agent has no apiSecret (or YAP_API_SECRET), so /api/ask refuses every request" });
  const given = Buffer.from(req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "");
  if (given.length !== secret.length || !timingSafeEqual(given, Buffer.from(secret))) return reply(401, { error: "bad or missing token" });
  let body: { text?: unknown; room?: unknown };
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return reply(400, { error: 'send JSON: {"text": "..."}' });
  }
  if (typeof body.text !== "string" || !body.text.trim()) return reply(400, { error: 'send JSON: {"text": "..."}' });
  const tools: { name: string; input: unknown; output?: unknown; error?: string; ms: number }[] = [];
  const t0 = performance.now();
  try {
    const text = await hub.ask(body.text, typeof body.room === "string" ? body.room : "api", {
      onToolEnd: (name, input, r) => void tools.push({ name, input, ...r }),
    });
    reply(200, { reply: text, tools, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    reply(500, { error: (e as Error).message, tools });
  }
}

export async function startServer(hub: Hub, o: ServerOptions) {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.startsWith("/hooks/")) return void webhook(hub, req, res);
    if (req.url === "/api/ask") return void ask(hub, req, res);
    if (req.url?.startsWith("/models/kws/")) return serveKwsModel(hub, req, res);
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, agent: hub.reg.agent.name, devices: [...hub.sessions.values()].map((s) => s.device) }));
      return;
    }
    serveStatic(o.webDir, req, res);
  };
  let server;
  if (o.tls === "off") server = createHttp(handler);
  else {
    const { cert, key } = o.tls === "self-signed" ? await selfSigned(o.dataDir, o.tlsNames) : { cert: readFileSync(o.tls.cert, "utf8"), key: readFileSync(o.tls.key, "utf8") };
    server = createHttps({ cert, key }, handler);
  }
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4 * 1024 * 1024 });
  wss.on("connection", (ws) => hub.attach(ws));
  await new Promise<void>((resolve) => server.listen(o.port, resolve));
  log.info(`listening on ${o.tls === "off" ? "http" : "https"}://0.0.0.0:${o.port}`);
}
