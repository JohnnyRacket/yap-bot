// Starting a yap-bot server from code; the CLI's `dev` and `start` call this.
//
//   import { start } from "yap-bot/server";
//   await start({ agentDir: "./agent", port: 8450 });
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hub } from "./hub.ts";
import { defaultTlsNames, startServer } from "./server.ts";
import { log } from "./log.ts";

export interface StartOptions {
  /** The agent folder. Default: $AGENT_DIR, else ./agent. */
  agentDir?: string;
  /** Stores, timers, the self-signed certificate. Default: $DATA_DIR, else ./data. */
  dataDir?: string;
  /** Model files, shared by every agent on the machine. Default: $MODELS_DIR, else ./models if there is one, else ~/.cache/yap-bot/models. */
  modelsDir?: string;
  /** The device web client. Default: $WEB_DIR, else the one built into yap-bot. */
  webDir?: string;
  /** Default: $PORT, else 8450. */
  port?: number;
  /** "self-signed" (default; browsers only give a page the microphone over HTTPS), "off", or cert/key files. Env: TLS=off, TLS_CERT, TLS_KEY. */
  tls?: "self-signed" | "off" | { cert: string; key: string };
  /** Names (and IPs) the self-signed certificate is for. Env: TLS_NAMES=host1,1.2.3.4. Default: this machine's. */
  tlsNames?: string[];
  /** Reload the agent when its files change. Env: WATCH=0 turns it off. */
  watch?: boolean;
  /** Fetch missing model files on start (default true; env YAP_DOWNLOAD=0 turns it off). */
  download?: boolean;
}

export function defaultModelsDir(): string {
  if (process.env.MODELS_DIR) return resolve(process.env.MODELS_DIR);
  if (existsSync("models")) return resolve("models");
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "yap-bot", "models");
}

/** The web client built into this package (web/, next to src/ and dist/). */
export const BUILTIN_WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));

export async function start(o: StartOptions = {}) {
  const env = process.env;
  const dataDir = resolve(o.dataDir ?? env.DATA_DIR ?? "data");
  const hub = await Hub.create({
    agentDir: resolve(o.agentDir ?? env.AGENT_DIR ?? "agent"),
    dataDir,
    modelsDir: o.modelsDir ? resolve(o.modelsDir) : defaultModelsDir(),
    watch: o.watch ?? env.WATCH !== "0",
    download: o.download ?? env.YAP_DOWNLOAD !== "0",
  });
  const tls = o.tls ?? (env.TLS_CERT && env.TLS_KEY ? { cert: env.TLS_CERT, key: env.TLS_KEY } : env.TLS === "off" ? "off" : "self-signed");
  await startServer(hub, {
    port: o.port ?? Number(env.PORT || 8450),
    webDir: resolve(o.webDir ?? env.WEB_DIR ?? BUILTIN_WEB_DIR),
    dataDir,
    tls,
    tlsNames: o.tlsNames ?? (env.TLS_NAMES ? env.TLS_NAMES.split(",").map((s) => s.trim()) : defaultTlsNames()),
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log.info(`${sig}: bye`);
      process.exit(0);
    });
  }
  return hub;
}
