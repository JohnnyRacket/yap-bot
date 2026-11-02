// Tool-choice eval: does the model call the right tool with the right arguments for things people
// say? Sends each case to the model with the agent's real prompt and tools and checks the first
// call. Tools are never run, so nothing changes.
//
//   yap-bot eval                                 ./agent with ./evals/cases.ts
//   yap-bot eval other/agent --cases my-cases.ts --reps 3 --only list
import { loadAgent } from "../agent/loader.ts";
import { toolSpecs, systemPrompt, userMessage } from "../agent/prompt.ts";
import { chat } from "../llm/client.ts";

export type EvalArgs = Record<string, any>;
type Check = (a: EvalArgs) => boolean;

/**
 * Something people say and the tool call that should follow. `expect` lists every acceptable tool
 * with a check on its arguments, so one case works for different tool designs; "none" accepts an
 * answer without a tool. The part of `name` before ":" groups the results.
 */
export interface EvalCase {
  name: string;
  say: string;
  expect: Record<string, Check>;
  /** Skip the case when the agent has none of these tools. */
  needs?: string[];
  /** An exchange just before: what was said, and the assistant's reply. */
  prior?: [string, string];
}

export async function runEval(o: { agentDir: string; cases: EvalCase[]; reps?: number; only?: string }) {
  const reg = await loadAgent(o.agentDir);
  const have = new Set(reg.tools.map((t) => t.name));
  const tools = toolSpecs(reg);
  const device = { id: "eval", room: "kitchen" };
  const reps = o.reps ?? 1;

  console.log(`${o.agentDir}: ${reg.tools.length} tools, model ${reg.agent.model.id}\n`);
  let passed = 0;
  let total = 0;
  let skipped = 0;
  const ms: number[] = [];
  const byArea = new Map<string, { pass: number; total: number }>();

  for (const c of o.cases) {
    if (o.only && !c.name.includes(o.only)) continue;
    if (c.needs && !c.needs.some((t) => have.has(t))) {
      skipped++;
      continue;
    }
    for (let rep = 0; rep < reps; rep++) {
      const t0 = performance.now();
      const res = await chat(reg.agent.model, {
        messages: [
          { role: "system", content: systemPrompt(reg) },
          ...(c.prior ? [userMessage(reg, device, c.prior[0]), { role: "assistant" as const, content: c.prior[1] }] : []),
          userMessage(reg, device, c.say),
        ],
        tools,
      });
      ms.push(performance.now() - t0);
      const call = res.toolCalls[0];
      let args: EvalArgs = {};
      try {
        args = call?.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {}
      const check = call ? c.expect[call.function.name] : c.expect.none;
      const ok = typeof check === "function" ? check(args) : false;
      const area = c.name.split(":")[0];
      const a = byArea.get(area) ?? { pass: 0, total: 0 };
      a.total++;
      if (ok) a.pass++;
      byArea.set(area, a);
      total++;
      if (ok) passed++;
      const got = call ? `${call.function.name}(${call.function.arguments})` : `(no tool) "${res.text.slice(0, 60)}"`;
      console.log(`${ok ? "✓" : "✗"} ${c.name.padEnd(30)} "${c.say}"${ok ? "" : `\n    got ${got}`}`);
    }
  }

  console.log(`\n${passed}/${total} passed (${Math.round((100 * passed) / Math.max(1, total))}%)${skipped ? `, ${skipped} skipped (tools not in this agent)` : ""}`);
  for (const [area, a] of byArea) console.log(`  ${area.padEnd(10)} ${a.pass}/${a.total}`);
  ms.sort((a, b) => a - b);
  if (ms.length) console.log(`median ${Math.round(ms[Math.floor(ms.length / 2)])} ms per case`);
  return { passed, total, skipped };
}
