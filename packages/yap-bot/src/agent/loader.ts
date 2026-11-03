// Loads the declarative agent folder: the path is the name, the folder is the kind.
//
//   agent/agent.ts            defineAgent(...)            required
//   agent/instructions.md     the always-on prompt        required (or instructions/*.md)
//   agent/voice.ts            defineVoice(...)            optional (every setting has a default)
//   agent/tools/*.ts          defineTool(...)             name = file name
//   agent/skills/*.md         markdown (+ frontmatter)    or skills/<name>/SKILL.md
//   agent/fastpaths/*.ts      defineFastpath(...)
//   agent/schedules/*.md|ts   cron frontmatter + prompt, or defineSchedule(...)
//   agent/triggers/*.md|ts    webhook / every / event frontmatter + prompt, or defineTrigger(...)
import { existsSync, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { z } from "zod";
import { defineVoice, type AgentDefinition, type FastpathDefinition, type ScheduleDefinition, type ToolDefinition, type TriggerDefinition, type TriggerEventName, type VoiceDefinition } from "../define.ts";
import { log } from "../log.ts";

export interface Skill {
  name: string;
  description: string;
  keywords: string[];
  content: string;
}

export interface Registry {
  agent: AgentDefinition;
  voice: VoiceDefinition;
  instructions: string;
  /** Sorted by name, so the prompt is identical on every load. */
  tools: { name: string; def: ToolDefinition }[];
  skills: Skill[];
  fastpaths: { name: string; def: FastpathDefinition }[];
  schedules: { name: string; def: ScheduleDefinition }[];
  triggers: { name: string; def: TriggerDefinition }[];
}

export function summarize(r: Registry) {
  return {
    tools: r.tools.map((t) => t.name),
    skills: r.skills.map((s) => s.name),
    fastpaths: r.fastpaths.map((f) => f.name),
    schedules: r.schedules.map((s) => s.name),
    triggers: r.triggers.map((t) => t.name),
  };
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A small frontmatter reader: `key: value`, `key: [a, b]`, and `- item` lists. */
export function parseFrontmatter(src: string): { data: Record<string, string | string[]>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { data: {}, body: src.trim() };
  const data: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (data[listKey] as string[]).push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value === "") {
      data[key] = [];
      listKey = key;
    } else if (/^\[.*\]$/.test(value)) {
      data[key] = value.slice(1, -1).split(",").map((v) => unquote(v.trim())).filter(Boolean);
      listKey = null;
    } else {
      data[key] = unquote(value);
      listKey = null;
    }
  }
  return { data, body: src.slice(m[0].length).trim() };
}

const unquote = (v: string) => v.replace(/^(["'])(.*)\1$/, "$2");
const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(", ") : v);
const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

// Reloading re-imports agent files with ?v=N. This hook passes the parent's ?v=N on to anything it
// imports from inside the agent folder (agent/lib/…), so helpers reload too instead of staying cached.
let hookedDir: string | null = null;
function versionAgentImports(dir: string) {
  if (hookedDir) return;
  hookedDir = pathToFileURL(dir).href + "/";
  registerHooks({
    resolve(specifier, context, next) {
      const r = next(specifier, context);
      const v = context.parentURL?.match(/[?&]v=(\d+)/)?.[1];
      if (v && r.url.startsWith(hookedDir!) && !r.url.includes("?")) return { ...r, url: `${r.url}?v=${v}` };
      return r;
    },
  });
}

async function importDefault(file: string, version: number): Promise<any> {
  try {
    const mod = await import(`${pathToFileURL(file).href}?v=${version}`);
    return mod.default;
  } catch (e) {
    // say which file (a syntax error otherwise names nothing), and where in it when the stack says
    const name = basename(file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const where = (e as Error).stack?.match(new RegExp(`${name}(?:\\?v=\\d+)?(:\\d+(?::\\d+)?)`))?.[1] ?? "";
    throw new Error(`${relative(process.cwd(), file)}${where}: ${(e as Error).message}`);
  }
}

function files(dir: string, exts: string[]): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(p, exts));
    else if (exts.includes(extname(entry.name))) out.push(p);
  }
  return out.sort();
}

/** "schedules/billing/sweep.ts" → "billing/sweep" */
function nameOf(dir: string, file: string): string {
  const rel = relative(dir, file).replace(/\\/g, "/");
  return rel.slice(0, rel.length - extname(rel).length);
}

function expectKind(def: any, kind: string, file: string) {
  if (!def || def.kind !== kind) throw new Error(`${file}: default export must come from define${kind[0].toUpperCase()}${kind.slice(1)}()`);
}

function parseEvery(every: string, name: string) {
  if (!/^\s*\d+(?:\.\d+)?\s*(ms|s|m|h)\s*$/.test(every)) throw new Error(`trigger ${name}: bad every "${every}" (use e.g. 30s, 5m, 1h)`);
}

let version = 0;

/** requireModel: false for commands that never call the model (yap-bot models, e.g. while building an image). */
export async function loadAgent(dir: string, o: { requireModel?: boolean } = {}): Promise<Registry> {
  versionAgentImports(dir);
  const v = ++version;
  const agentFile = join(dir, "agent.ts");
  const voiceFile = join(dir, "voice.ts");
  if (!existsSync(agentFile)) throw new Error(`missing ${agentFile}`);
  const agent: AgentDefinition = await importDefault(agentFile, v);
  expectKind(agent, "agent", agentFile);
  if (o.requireModel !== false && !agent.model.id && !agent.model.complete) throw new Error(`no model: set LLM_MODEL (in .env) or model.id in ${agentFile}`);
  let voice: VoiceDefinition = defineVoice();
  if (existsSync(voiceFile)) {
    voice = await importDefault(voiceFile, v);
    expectKind(voice, "voice", voiceFile);
  }

  let instructions = "";
  if (existsSync(join(dir, "instructions.md"))) instructions = readFileSync(join(dir, "instructions.md"), "utf8").trim();
  else instructions = files(join(dir, "instructions"), [".md"]).map((f) => readFileSync(f, "utf8").trim()).join("\n\n");
  if (!instructions) throw new Error(`${dir}: instructions.md is required`);

  const tools: Registry["tools"] = [];
  for (const f of files(join(dir, "tools"), [".ts"])) {
    const name = basename(f, ".ts");
    if (!NAME.test(name)) throw new Error(`${f}: tool names use letters, digits, _ and -`);
    if (tools.some((t) => t.name === name)) throw new Error(`${f}: there's already a tool named ${name} (a tool's name is its file name, folders aside)`);
    const def = await importDefault(f, v);
    expectKind(def, "tool", f);
    // checked now rather than failing every turn once the model sees the tool list
    try {
      if (typeof def.input?.safeParse !== "function") throw new Error("not a zod schema");
      z.toJSONSchema(def.input);
    } catch (e) {
      throw new Error(`${f}: input must be z.object({ … }) (${(e as Error).message})`);
    }
    if (typeof def.execute !== "function") throw new Error(`${f}: execute must be a function`);
    tools.push({ name, def });
  }

  const skills: Skill[] = [];
  const skillsDir = join(dir, "skills");
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir).sort()) {
      const p = join(skillsDir, entry);
      const packaged = statSync(p).isDirectory();
      const file = packaged ? join(p, "SKILL.md") : p;
      if (!file.endsWith(".md") || !existsSync(file)) continue;
      const name = packaged ? entry : basename(entry, ".md");
      if (!NAME.test(name)) throw new Error(`${file}: skill names use letters, digits, _ and -`);
      const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
      const description = str(data.description) ?? "";
      if (packaged && !description) throw new Error(`${file}: a packaged skill needs a description`);
      skills.push({ name, description: description || body.split("\n")[0].slice(0, 120), keywords: list(data.keywords).map((k) => k.toLowerCase()), content: body });
    }
  }

  const fastpaths: Registry["fastpaths"] = [];
  const fpDir = join(dir, "fastpaths");
  for (const f of files(fpDir, [".ts"])) {
    const def = await importDefault(f, v);
    expectKind(def, "fastpath", f);
    fastpaths.push({ name: nameOf(fpDir, f), def });
  }

  const schedules: Registry["schedules"] = [];
  const schedDir = join(dir, "schedules");
  for (const f of files(schedDir, [".md", ".ts"])) {
    const name = nameOf(schedDir, f);
    if (f.endsWith(".md")) {
      const { data, body } = parseFrontmatter(readFileSync(f, "utf8"));
      const cron = str(data.cron);
      if (!cron) throw new Error(`${f}: a markdown schedule needs cron in its frontmatter`);
      schedules.push({ name, def: { kind: "schedule", cron, prompt: body, room: str(data.room), speak: str(data.speak) !== "false" } });
    } else {
      const def = await importDefault(f, v);
      expectKind(def, "schedule", f);
      schedules.push({ name, def });
    }
  }

  const triggers: Registry["triggers"] = [];
  const trigDir = join(dir, "triggers");
  for (const f of files(trigDir, [".md", ".ts"])) {
    const name = nameOf(trigDir, f);
    if (f.endsWith(".md")) {
      // frontmatter: webhook: true | every: 5m | event: timer_done, plus room, secret_env, announce: true
      const { data, body } = parseFrontmatter(readFileSync(f, "utf8"));
      const secretEnv = str(data.secret_env);
      const on: TriggerDefinition["on"] = {};
      if (str(data.webhook) === "true") {
        // a named secret that isn't set locks the webhook rather than leaving it open
        if (secretEnv && !process.env[secretEnv]) log.warn(`trigger ${name}: ${secretEnv} is not set, so its webhook refuses every request`);
        on.webhook = secretEnv ? { secret: process.env[secretEnv] ?? "" } : true;
      }
      if (data.every) on.every = str(data.every);
      if (data.event) on.event = str(data.event) as TriggerEventName;
      if (Object.keys(on).length !== 1) throw new Error(`${f}: a markdown trigger needs exactly one of webhook: true, every or event`);
      if (!body) throw new Error(`${f}: the body is the prompt (or the text, with announce: true)`);
      const action = str(data.announce) === "true" ? { announce: body } : { prompt: body };
      triggers.push({ name, def: { kind: "trigger", on, room: str(data.room), ...action } });
    } else {
      const def = await importDefault(f, v);
      expectKind(def, "trigger", f);
      triggers.push({ name, def });
    }
  }

  for (const { name, def } of triggers) {
    if (def.on.every) parseEvery(def.on.every, name);
    // its payload goes into a prompt that can call every tool
    if (def.on.webhook === true && def.prompt) log.warn(`trigger ${name}: a webhook anyone on the network can call puts its payload in a prompt with your tools; give it a secret (secret_env)`);
  }

  if (tools.length > 15) log.warn(`${tools.length} tools: a small model chooses worse past ~15`);
  return { agent, voice, instructions, tools, skills, fastpaths, schedules, triggers };
}

/** Calls onChange (debounced) whenever anything under dir changes; returns a function that stops watching. */
export function watchAgent(dir: string, onChange: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(dir, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 250);
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
