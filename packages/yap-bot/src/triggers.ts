// Triggers: webhooks, periodic checks and the runtime's own events that make the agent act or speak.
import { timingSafeEqual } from "node:crypto";
import type { TriggerDefinition, TriggerEventName, TriggerInput } from "./define.ts";
import type { Hub } from "./hub.ts";
import { log } from "./log.ts";

/** "30s", "5m", "1.5h", "500ms" → ms */
export function parseDuration(s: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)\s*$/.exec(s);
  if (!m) throw new Error(`bad duration "${s}" (use e.g. 30s, 5m, 1h)`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"];
}

/** Fills {{payload}}, {{payload.field}}, {{timer.name}}, {{device.room}}… from the trigger input. */
export function fill(template: string, input: TriggerInput): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    let v: unknown = input;
    for (const key of path.split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined;
    if (v === undefined || v === null) return "";
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

function sameSecret(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class Triggers {
  private hub: Hub;
  private intervals: NodeJS.Timeout[] = [];
  private running = new Set<string>();

  constructor(hub: Hub) {
    this.hub = hub;
  }

  private get list() {
    return this.hub.reg.triggers;
  }

  /** (Re)starts the periodic ones; called on load and on every agent reload. */
  start() {
    this.stop();
    for (const { name, def } of this.list) {
      if (!def.on.every) continue;
      const ms = parseDuration(def.on.every);
      this.intervals.push(setInterval(() => void this.fire(name, def, { source: "every" }), Math.max(1000, ms)));
    }
  }

  stop() {
    for (const i of this.intervals) clearInterval(i);
    this.intervals = [];
  }

  handles(event: TriggerEventName) {
    return this.list.some((t) => t.def.on.event === event);
  }

  /** Runs every trigger for an event; true when at least one exists. */
  event(input: Extract<TriggerInput, { source: "event" }>): boolean {
    const matching = this.list.filter((t) => t.def.on.event === input.event);
    for (const { name, def } of matching) void this.fire(name, def, input);
    return matching.length > 0;
  }

  /** POST /hooks/<name>. Responds before the trigger finishes running. */
  webhook(name: string, payload: unknown, query: Record<string, string>, authorization?: string): { status: number; body: unknown } {
    const t = this.list.find((x) => x.name === name && x.def.on.webhook);
    if (!t) return { status: 404, body: { error: `no webhook trigger named ${name}` } };
    const hook = t.def.on.webhook;
    if (typeof hook === "object" && "secret" in hook) {
      const secret = hook.secret;
      if (!secret) return { status: 401, body: { error: "this webhook's secret isn't configured" } };
      const given = authorization?.replace(/^Bearer\s+/i, "") ?? query.token ?? "";
      if (!sameSecret(given, secret)) return { status: 401, body: { error: "bad or missing token" } };
    }
    void this.fire(name, t.def, { source: "webhook", payload, query });
    return { status: 202, body: { ok: true, trigger: name } };
  }

  private async fire(name: string, def: TriggerDefinition, input: TriggerInput) {
    // a periodic check that's still running isn't started again
    if (input.source === "every" && this.running.has(name)) return;
    this.running.add(name);
    const hub = this.hub;
    const source = `trigger:${name}`;
    const room = def.room ?? "all";
    try {
      // periodic checks tick quietly; what they announce is logged anyway
      (input.source === "every" ? log.debug : log.info)(`trigger ${name} (${input.source === "event" ? input.event : input.source})`);
      if (def.run) {
        await def.run(
          {
            timezone: hub.reg.agent.timezone,
            timers: hub.timers,
            store: hub.storeFor(`trigger-${name}`),
            announce: (t, o) => hub.announce(t, { room: o?.room ?? "all" }, source),
            ask: (p) => hub.ask(p),
            devices: () => [...hub.sessions.values()].map((s) => s.device),
            log: (...a) => log.info(`[trigger ${name}]`, ...a),
          },
          input,
        );
      } else if (def.announce) {
        hub.announce(fill(def.announce, input), { room }, source);
      } else if (def.prompt) {
        const reply = await hub.ask(fill(def.prompt, input), room);
        if (reply) hub.announce(reply, { room }, source);
      }
    } catch (e) {
      log.error(`trigger ${name} failed`, e);
    } finally {
      this.running.delete(name);
    }
  }
}
