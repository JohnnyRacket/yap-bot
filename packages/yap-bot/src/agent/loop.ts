// The model ↔ tools loop, shared by spoken turns and schedules.
import type { LlmStats } from "../protocol.ts";
import type { Store, ToolContext } from "../define.ts";
import { chat, LlmQueue, Priority, type ChatMessage, type ToolCall } from "../llm/client.ts";
import type { Registry } from "./loader.ts";
import { LOAD_SKILL, systemPrompt, toolSpecs } from "./prompt.ts";
import { errorMessage } from "../errors.ts";

const TOOL_TIMEOUT_MS = 20_000;

export interface LoopEvents {
  onText?(delta: string): void;
  onFirstToken?(at: number): void;
  /** The model has started calling a tool (its name has streamed in; may be called with partial names). */
  onToolCalling?(name: string): void;
  onToolStart?(name: string, input: unknown): void;
  onToolEnd?(name: string, input: unknown, result: { output?: unknown; error?: string; ms: number }): void;
  /** Each assistant tool-call message and tool result, as it happens (tool results are kept even if the turn is interrupted). */
  onMessage?(msg: ChatMessage): void;
}

export interface LoopResult {
  /** Text of the final round (what the turn says last). */
  text: string;
  stats: LlmStats;
}

/** Reads a prompt without answering (max 1 token), so the next request finds it cached. */
export async function prefill(reg: Registry, llm: LlmQueue, history: ChatMessage[], signal: AbortSignal) {
  return llm.run(Priority.Prefill, () =>
    chat(reg.agent.model, {
      maxTokens: 1,
      messages: [{ role: "system", content: systemPrompt(reg) }, ...history],
      tools: toolSpecs(reg),
      signal,
    }),
  );
}

export async function runLoop(opts: {
  reg: Registry;
  llm: LlmQueue;
  priority: number;
  history: ChatMessage[];
  /** Shared by every tool call; each tool gets its own store from storeFor. */
  ctx: Omit<ToolContext, "store">;
  storeFor(name: string): Store;
  events?: LoopEvents;
}): Promise<LoopResult> {
  const { reg, ctx, storeFor, events = {} } = opts;
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt(reg) }, ...opts.history];
  const tools = toolSpecs(reg);
  const stats: LlmStats = { rounds: 0 };
  let firstTokenSeen = false;

  for (let round = 0; round < reg.agent.maxToolRounds; round++) {
    ctx.signal.throwIfAborted();
    stats.rounds++;
    const res = await opts.llm.run(opts.priority, () =>
      chat(reg.agent.model, {
        messages,
        tools,
        signal: ctx.signal,
        onText: events.onText,
        onToolName: events.onToolCalling,
      }),
    );
    if (res.firstTokenAt && !firstTokenSeen) {
      firstTokenSeen = true;
      events.onFirstToken?.(res.firstTokenAt);
    }
    if (round === 0) {
      stats.promptTokens = res.promptTokens;
      stats.cachedTokens = res.cachedTokens;
      stats.promptMs = res.promptMs;
    }
    stats.completionTokens = (stats.completionTokens ?? 0) + (res.completionTokens ?? 0);
    stats.generationTps = res.generationTps;

    if (!res.toolCalls.length) return { text: res.text, stats };

    const assistant: ChatMessage = { role: "assistant", content: res.text || null, tool_calls: res.toolCalls };
    messages.push(assistant);
    events.onMessage?.(assistant);
    for (const call of res.toolCalls) {
      // interrupted: the calls still to come don't run (the turn records them as interrupted)
      ctx.signal.throwIfAborted();
      const content = await runTool(reg, call, ctx, storeFor, events);
      ctx.signal.throwIfAborted();
      const toolMsg: ChatMessage = { role: "tool", tool_call_id: call.id, content };
      messages.push(toolMsg);
      events.onMessage?.(toolMsg);
    }
    if (res.toolCalls.every((c) => reg.tools.find((t) => t.name === c.function.name)?.def.final)) return { text: res.text, stats };
  }
  return { text: "", stats };
}

async function runTool(
  reg: Registry,
  call: ToolCall,
  ctx: Omit<ToolContext, "store">,
  storeFor: (name: string) => Store,
  events: LoopEvents,
): Promise<string> {
  const name = call.function.name;
  let input: unknown;
  try {
    input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return JSON.stringify({ error: "arguments were not valid JSON" });
  }
  events.onToolStart?.(name, input);
  const t0 = performance.now();
  const done = (r: { output?: unknown; error?: string }) => {
    events.onToolEnd?.(name, input, { ...r, ms: Math.round(performance.now() - t0) });
    return JSON.stringify(r.error !== undefined ? { error: r.error } : (r.output ?? { ok: true }));
  };

  if (name === LOAD_SKILL) {
    const skill = reg.skills.find((s) => s.name === (input as { name?: string })?.name);
    return skill ? done({ output: { skill: skill.name, instructions: skill.content } }) : done({ error: "no such skill" });
  }
  const tool = reg.tools.find((t) => t.name === name)?.def;
  if (!tool) return done({ error: `no tool named ${name}` });
  const parsed = tool.input.safeParse(input);
  if (!parsed.success) return done({ error: `invalid input: ${parsed.error.message}` });

  let timeout: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  // the tool's own signal: the turn's, plus its timeout, so a fetch inside it stops too
  const timedOut = new AbortController();
  const signal = AbortSignal.any([ctx.signal, timedOut.signal]);
  try {
    const output = await Promise.race([
      // a tool that throws synchronously rejects here too
      new Promise((resolve) => resolve(tool.execute(parsed.data, { ...ctx, signal, store: storeFor(name) }))),
      // interrupted: stop waiting for the tool (it's told through its signal)
      new Promise((_, reject) => {
        onAbort = () => reject(new Error("interrupted"));
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener("abort", onAbort, { once: true });
      }),
      new Promise((_, reject) =>
        (timeout = setTimeout(() => {
          // the timeout first: a tool that answers as soon as it's aborted mustn't count as done
          reject(new Error(`timed out after ${(tool.timeoutMs ?? TOOL_TIMEOUT_MS) / 1000} s`));
          timedOut.abort(new Error("timed out"));
        }, tool.timeoutMs ?? TOOL_TIMEOUT_MS)),
      ),
    ]);
    return done({ output });
  } catch (e) {
    return done({ error: errorMessage(e) });
  } finally {
    clearTimeout(timeout);
    if (onAbort) ctx.signal.removeEventListener("abort", onAbort);
  }
}
