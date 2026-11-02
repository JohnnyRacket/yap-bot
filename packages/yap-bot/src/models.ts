// Downloads the model files engines need into the models directory, skipping ones already there.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, globSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
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

export async function downloadModels(modelsDir: string, downloads: ModelDownload[]) {
  const missing = missingModels(modelsDir, downloads);
  if (!missing.length) return;
  mkdirSync(modelsDir, { recursive: true });
  for (const d of missing) {
    const t0 = performance.now();
    log.info(`downloading ${d.url}`);
    const res = await fetch(d.url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`${d.url}: ${res.status}`);
    const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
    if (d.extract) {
      const flag = /\.(tgz|tar\.gz)$/.test(d.url) ? "xz" : "xj";
      const tar = spawn("tar", [flag, "-C", modelsDir], { stdio: ["pipe", "inherit", "inherit"] });
      const exited = new Promise<void>((resolve, reject) => {
        tar.on("error", reject);
        tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code} unpacking ${d.url}`))));
      });
      await pipeline(body, tar.stdin);
      await exited;
      for (const p of d.prune ?? []) for (const f of globSync(p, { cwd: modelsDir })) rmSync(join(modelsDir, f), { recursive: true, force: true });
      if (!existsSync(join(modelsDir, d.path))) throw new Error(`${d.url} didn't unpack to ${d.path}`);
    } else {
      const file = join(modelsDir, d.path);
      mkdirSync(dirname(file), { recursive: true });
      await pipeline(body, createWriteStream(`${file}.part`));
      renameSync(`${file}.part`, file);
    }
    log.info(`  ${d.path} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }
}
