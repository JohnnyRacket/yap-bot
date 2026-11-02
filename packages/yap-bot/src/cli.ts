// yap-bot <command>: run an agent, fetch its models, talk to it, test it, start a new one.
import { cpSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const HELP = `yap-bot: declarative voice agents

  yap-bot init <dir> [--name N]    a new agent project
  yap-bot dev [agentDir]           run it, reloading when agent files change (default ./agent)
  yap-bot start [agentDir]         run it
  yap-bot models [agentDir]        download the model files its voice needs
  yap-bot models --defaults        …or the default engines' (without an agent; for Docker layers)
  yap-bot say "text" ["more"…]     typed turns to a running server (--url wss://host:8450/ws)
  yap-bot eval [agentDir]          tool-choice eval (--cases evals/cases.ts --reps 1 --only area)

Environment: PORT (8450), AGENT_DIR, DATA_DIR (./data), MODELS_DIR (./models if present, else
~/.cache/yap-bot/models), TLS=off, TLS_CERT/TLS_KEY, TLS_NAMES, WATCH=0, YAP_DOWNLOAD=0,
LLM_URL, LLM_MODEL, LLM_API_KEY, YAP_API_SECRET (POST /api/ask), TZ.`;

const PKG_ROOT = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", PKG_ROOT), "utf8")) as { version: string };

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "dev":
  case "start": {
    const { positionals } = parseArgs({ args: rest, allowPositionals: true });
    const { start } = await import("./start.ts");
    await start({ agentDir: positionals[0], watch: command === "dev" ? undefined : false });
    break;
  }
  case "models": {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { defaults: { type: "boolean" } } });
    const { downloadModels, missingModels } = await import("./models.ts");
    const { defaultModelsDir } = await import("./start.ts");
    const modelsDir = defaultModelsDir();
    let downloads;
    if (values.defaults) {
      const { defaultEngines } = await import("./engines/index.ts");
      downloads = Object.values(defaultEngines()).flatMap((e) => e.downloads ?? []);
    } else {
      const { loadAgent } = await import("./agent/loader.ts");
      const { voiceDownloads } = await import("./hub.ts");
      downloads = voiceDownloads(await loadAgent(resolve(positionals[0] ?? process.env.AGENT_DIR ?? "agent")));
    }
    const missing = missingModels(modelsDir, downloads);
    console.log(`models: ${modelsDir} (${downloads.length - missing.length} of ${downloads.length} already there)`);
    await downloadModels(modelsDir, downloads);
    break;
  }
  case "say": {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { url: { type: "string" }, room: { type: "string" } } });
    if (!positionals.length) fail('usage: yap-bot say "first turn" ["second turn" …]');
    await say(values.url ?? process.env.YAP_URL ?? `wss://localhost:${process.env.PORT || 8450}/ws`, positionals, values.room);
    break;
  }
  case "eval": {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { cases: { type: "string", default: "evals/cases.ts" }, reps: { type: "string", default: "1" }, only: { type: "string" } },
    });
    const file = resolve(values.cases!);
    if (!existsSync(file)) fail(`no cases at ${file} (export const cases: EvalCase[] = […])`);
    const { cases } = await import(pathToFileURL(file).href);
    const { runEval } = await import("./testing/eval.ts");
    await runEval({ agentDir: resolve(positionals[0] ?? process.env.AGENT_DIR ?? "agent"), cases, reps: Number(values.reps), only: values.only });
    break;
  }
  case "init": {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { name: { type: "string" } } });
    if (!positionals[0]) fail("usage: yap-bot init <dir> [--name N]");
    init(resolve(positionals[0]), values.name);
    break;
  }
  case "--version":
  case "-v":
    console.log(pkg.version);
    break;
  case undefined:
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  default:
    fail(`unknown command ${command}\n\n${HELP}`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function say(url: string, turns: string[], room?: string) {
  const { TestClient, formatMarks } = await import("./testing/client.ts");
  const c = new TestClient();
  c.onEvent = ({ msg }) => {
    if (msg.type === "assistant") console.log(`  🔊 ${msg.text}`);
    if (msg.type === "tool" && (msg.output !== undefined || msg.error)) console.log(`  🔧 ${msg.name}(${JSON.stringify(msg.input)}) → ${JSON.stringify(msg.error ?? msg.output)} [${msg.ms} ms]`);
    if (msg.type === "announce") console.log(`  📣 ${msg.text}`);
    if (msg.type === "error") console.log(`  ⚠️  ${msg.message}`);
    if (msg.type === "metrics") {
      console.log(`  ⏱  ${formatMarks(msg.marks)}`);
      if (msg.llm) console.log(`  🧠 ${JSON.stringify(msg.llm)}`);
    }
  };
  await c.connect(url, `cli-${process.pid}`, "push", room);
  for (const text of turns) {
    console.log(`> ${text}`);
    c.send({ type: "text", text });
    await c.waitFor((m) => m.type === "turn_done", 120_000);
    await c.waitFor((m) => m.type === "metrics");
  }
  c.close();
}

function init(dir: string, name = basename(dir)) {
  if (existsSync(dir) && readdirSync(dir).length) fail(`${dir} isn't empty`);
  cpSync(new URL("template/", PKG_ROOT), dir, { recursive: true });
  const fill = (file: string) => writeFileSync(join(dir, file), readFileSync(join(dir, file), "utf8").replaceAll("Yappy", name));
  for (const f of ["agent/agent.ts", "agent/instructions.md", "README.md", "deploy/Dockerfile"]) fill(f);
  // npm leaves .gitignore files out of packages, so the template's goes without the dot
  renameSync(join(dir, "gitignore"), join(dir, ".gitignore"));
  const npmName = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  const projectPkg = {
    name: npmName,
    private: true,
    type: "module",
    engines: { node: ">=24" },
    scripts: { dev: "yap-bot dev", start: "yap-bot start", models: "yap-bot models", say: "yap-bot say", eval: "yap-bot eval", typecheck: "tsc" },
    dependencies: { "yap-bot": `^${pkg.version}` },
    devDependencies: { "@types/node": "^26.6.6", typescript: "^7.0.2" },
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(projectPkg, null, 2) + "\n");
  console.log(`created ${dir}\n\n  cd ${dir}\n  npm install\n  LLM_URL=http://localhost:8080/v1 LLM_MODEL=your-model npm run dev\n\nthen open https://localhost:8450`);
}
