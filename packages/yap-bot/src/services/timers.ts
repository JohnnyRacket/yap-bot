import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Device, Timer, Timers } from "../define.ts";
import { readJson, writeJson } from "./store.ts";

/** Timers that go off on the device (or in the room) that set them, and survive restarts. */
export class TimerService implements Timers {
  private file: string;
  private timers: Timer[];
  private handles = new Map<string, NodeJS.Timeout>();
  private onFire: (timer: Timer) => void;

  constructor(dataDir: string, onFire: (timer: Timer) => void) {
    this.file = join(dataDir, "timers.json");
    this.onFire = onFire;
    this.timers = readJson<Timer[]>(this.file, []);
    for (const t of this.timers) this.arm(t);
  }

  start({ seconds, name }: { seconds: number; name?: string }, device: Device): Timer {
    const now = Date.now();
    const timer: Timer = {
      id: randomUUID().slice(0, 8),
      name: (name ?? "").trim() || "timer",
      deviceId: device.id,
      room: device.room,
      createdAt: now,
      endsAt: now + Math.max(1, seconds) * 1000,
    };
    this.timers.push(timer);
    this.save();
    this.arm(timer);
    return timer;
  }

  /** Stops counting down (the timers stay saved, and start again with the next TimerService). */
  stop() {
    for (const h of this.handles.values()) clearTimeout(h);
    this.handles.clear();
  }

  list(device?: Device): Timer[] {
    const all = [...this.timers].sort((a, b) => a.endsAt - b.endsAt);
    if (!device) return all;
    const mine = all.filter((t) => t.deviceId === device.id || t.room === device.room);
    return mine.length ? mine : all;
  }

  cancel(idOrName: string, device?: Device): Timer[] {
    const key = idOrName.trim().toLowerCase();
    const candidates = this.list(device);
    let hit = candidates.filter((t) => t.id === key || t.name.toLowerCase() === key);
    if (!hit.length) hit = candidates.filter((t) => t.name.toLowerCase().includes(key) || key.includes(t.name.toLowerCase()));
    if (!hit.length && (key === "all" || key === "everything")) hit = candidates;
    for (const t of hit) this.remove(t.id);
    return hit;
  }

  private arm(t: Timer) {
    const delay = Math.max(0, t.endsAt - Date.now());
    // setTimeout tops out at ~24.8 days; re-arm in steps for anything longer
    const step = Math.min(delay, 2 ** 31 - 1);
    this.handles.set(
      t.id,
      setTimeout(() => {
        if (Date.now() < t.endsAt) return this.arm(t);
        this.remove(t.id);
        this.onFire(t);
      }, step),
    );
  }

  private remove(id: string) {
    clearTimeout(this.handles.get(id));
    this.handles.delete(id);
    this.timers = this.timers.filter((t) => t.id !== id);
    this.save();
  }

  private save() {
    writeJson(this.file, this.timers);
  }
}

/** "9 minutes 30 seconds" for speech. */
export function spokenDuration(ms: number): string {
  let s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} hour${h === 1 ? "" : "s"}`);
  if (m) parts.push(`${m} minute${m === 1 ? "" : "s"}`);
  if (s && !h) parts.push(`${s} second${s === 1 ? "" : "s"}`);
  return parts.join(" ") || "0 seconds";
}
