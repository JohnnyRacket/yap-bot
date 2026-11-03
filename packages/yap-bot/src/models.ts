// Downloads the model files engines need into the models directory, skipping ones already there.
// Nothing appears under its final name until it's complete: an interrupted download leaves only
// temporary files, so it's fetched again next time instead of looking done.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, globSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ModelDownload } from "./engines/types.ts";
import { log } from "./log.ts";

export function missingModels(modelsDir: string, downloads: ModelDownload[]): ModelDownload[] {
  const seen = new Set<string>();
  return downloads.filter((d) => {
    if (seen.has(d.path)) return false;
    seen.add(d.path);
    return !existsSync(join(modelsDir, d.path));
  });
}

/** Counts bytes going through, logging every 10% of a big download. */
function progress(name: string, total: number) {
  let seen = 0;
  let shown = 0;
  return new Transform({
    transform(chunk: Buffer, _, done) {
      seen += chunk.length;
      const pct = Math.floor((seen / total) * 10) * 10;
      if (total > 20e6 && pct > shown && pct < 100) {
        shown = pct;
        log.info(`  ${name}: ${pct}% of ${Math.round(total / 1e6)} MB`);
      }
      done(null, chunk);
    },
  });
}

export async function downloadModels(modelsDir: string, downloads: ModelDownload[]) {
  const missing = missingModels(modelsDir, downloads);
  if (!missing.length) return;
  mkdirSync(modelsDir, { recursive: true });
  for (const d of missing) {
    const t0 = performance.now();
    log.info(`downloading ${d.url}`);
    const res = await fetch(d.url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`${d.url}: ${res.status} ${res.statusText}`);
    const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
    const counted = progress(d.path, Number(res.headers.get("content-length") ?? 0));
    // unique per process: two downloads at once (yap-bot models and dev) don't write one file
    const tmp = join(modelsDir, `.download-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    try {
      if (d.extract) {
        mkdirSync(tmp);
        const flag = /\.(tgz|tar\.gz)$/.test(d.url) ? "xz" : "xj";
        const tar = spawn("tar", [flag, "-C", tmp], { stdio: ["pipe", "inherit", "inherit"] });
        const exited = new Promise<void>((resolve, reject) => {
          tar.on("error", reject);
          tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code} unpacking ${d.url}`))));
        });
        await Promise.all([pipeline(body, counted, tar.stdin), exited]);
        for (const p of d.prune ?? []) for (const f of globSync(p, { cwd: tmp })) rmSync(join(tmp, f), { recursive: true, force: true });
        if (!existsSync(join(tmp, d.path))) throw new Error(`${d.url} didn't unpack to ${d.path}`);
        mkdirSync(dirname(join(modelsDir, d.path)), { recursive: true });
        renameSync(join(tmp, d.path), join(modelsDir, d.path));
      } else {
        const file = join(modelsDir, d.path);
        mkdirSync(dirname(file), { recursive: true });
        await pipeline(body, counted, createWriteStream(tmp));
        renameSync(tmp, file);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    log.info(`  ${d.path} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }
}
