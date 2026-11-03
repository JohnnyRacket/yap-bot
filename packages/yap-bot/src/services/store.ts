import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Store } from "../define.ts";
import { log } from "../log.ts";

/** Writes JSON atomically (temp file + rename). */
export function writeJson(file: string, value: unknown) {
  writeText(file, JSON.stringify(value, null, 2));
}

function writeText(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** The file's JSON, or fallback when there's none. A file that can't be read is set aside (never overwritten) and logged. */
export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (e) {
    const aside = `${file}.corrupt-${Date.now()}`;
    renameSync(file, aside);
    log.error(`${file} couldn't be read (${(e as Error).message}); moved it to ${aside} and started empty`);
    return fallback;
  }
}

const stores = new Map<string, Store>();

/** The file's modification time, 0 when there's none. */
const mtime = (file: string) => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * One JSON file per namespace under data/store/. Kept in memory, but read again when the file
 * changes underneath (a script, an edit by hand, a second process), so those aren't lost or
 * overwritten.
 */
export function storeFor(dataDir: string, namespace: string): Store {
  const file = join(dataDir, "store", `${namespace.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  let store = stores.get(file);
  if (!store) {
    let data: Record<string, unknown> = readJson(file, {});
    let seen = mtime(file);
    const fresh = () => {
      const now = mtime(file);
      if (now !== seen) {
        data = readJson(file, {});
        seen = now;
      }
      return data;
    };
    const save = (text: string) => {
      writeText(file, text);
      seen = mtime(file);
    };
    store = {
      get: <T>(key: string) => fresh()[key] as T | undefined,
      set: (key, value) => {
        // serialized first: a value that can't be (a cycle, a BigInt) changes nothing
        const next = JSON.stringify({ ...fresh(), [key]: value }, null, 2);
        data[key] = JSON.parse(next)[key];
        save(next);
      },
      delete: (key) => {
        delete fresh()[key];
        save(JSON.stringify(data, null, 2));
      },
      all: () => ({ ...fresh() }),
    };
    stores.set(file, store);
  }
  return store;
}

let dataDir = process.env.DATA_DIR ?? "data";
export function setDataDir(dir: string) {
  dataDir = dir;
}

/** A named store shared by whoever asks for the same name (e.g. several list tools). */
export function store(namespace: string): Store {
  const s = () => storeFor(dataDir, namespace);
  return {
    get: (key) => s().get(key),
    set: (key, value) => s().set(key, value),
    delete: (key) => s().delete(key),
    all: () => s().all(),
  };
}
