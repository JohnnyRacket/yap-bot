import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Store } from "../define.ts";

/** Writes JSON atomically (temp file + rename). */
export function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

const stores = new Map<string, Store>();

/** One JSON file per namespace under data/store/. */
export function storeFor(dataDir: string, namespace: string): Store {
  const file = join(dataDir, "store", `${namespace.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  let store = stores.get(file);
  if (!store) {
    const data: Record<string, unknown> = readJson(file, {});
    store = {
      get: <T>(key: string) => data[key] as T | undefined,
      set: (key, value) => {
        data[key] = value;
        writeJson(file, data);
      },
      delete: (key) => {
        delete data[key];
        writeJson(file, data);
      },
      all: () => ({ ...data }),
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
