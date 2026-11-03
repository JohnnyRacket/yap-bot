// Builds what the model sees, ordered from never-changing to per-turn so llama.cpp can reuse the
// cached prefix: instructions → skills index → tools → history → per-turn context + words.
import { z } from "zod";
import { defaultTurnContext, type Device } from "../define.ts";
import { errorMessage } from "../errors.ts";
import { log } from "../log.ts";
import type { ChatMessage, ToolSpec } from "../llm/client.ts";
import type { Registry, Skill } from "./loader.ts";

export const LOAD_SKILL = "load_skill";

export function systemPrompt(reg: Registry): string {
  const parts = [reg.instructions];
  if (reg.agent.prompt.voiceRules) parts.push(reg.agent.prompt.voiceRules);
  if (reg.skills.length) {
    parts.push(
      `Skills: procedures you can load with ${LOAD_SKILL} when a request matches one.\n` +
        reg.skills.map((s) => `- ${s.name}: ${s.description}`).join("\n"),
    );
  }
  return parts.join("\n\n");
}

export function toolSpecs(reg: Registry): ToolSpec[] {
  const specs: ToolSpec[] = reg.tools.map(({ name, def }) => {
    const schema = z.toJSONSchema(def.input, { target: "draft-7" }) as Record<string, unknown>;
    delete schema.$schema;
    return { type: "function", function: { name, description: def.description, parameters: schema } };
  });
  if (reg.skills.length) {
    specs.push({
      type: "function",
      function: {
        name: LOAD_SKILL,
        description: "Load a skill's instructions by name.",
        parameters: { type: "object", properties: { name: { type: "string", enum: reg.skills.map((s) => s.name) } }, required: ["name"] },
      },
    });
  }
  return specs;
}

/** Skills whose keywords appear in the text, loaded up front to save a round trip. */
export function matchedSkills(reg: Registry, text: string): Skill[] {
  const t = text.toLowerCase();
  return reg.skills.filter((s) => s.keywords.some((k) => t.includes(k)));
}

export function userMessage(reg: Registry, device: Device, text: string): ChatMessage {
  let context: string;
  try {
    context = reg.agent.prompt.context(device, new Date(), reg.agent.timezone);
  } catch (e) {
    log.error(`prompt.context threw: ${errorMessage(e)}`);
    context = defaultTurnContext(device, new Date(), reg.agent.timezone);
  }
  let content = context ? `${context}\n${text}` : text;
  for (const s of matchedSkills(reg, text)) content += `\n\n<skill name="${s.name}">\n${s.content}\n</skill>`;
  return { role: "user", content };
}

const size = (m: ChatMessage) => (m.content?.length ?? 0) + ("tool_calls" in m && m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);

/**
 * Past `max` messages or `maxChars` characters (tool results add up), drops back to half of each,
 * starting at a user message so tool calls stay paired. Dropping in big steps instead of one message
 * per turn keeps the cached prefix valid between trims.
 */
export function trimHistory(history: ChatMessage[], max: number, maxChars = Infinity): ChatMessage[] {
  let chars = 0;
  for (const m of history) chars += size(m);
  if (history.length <= max && chars <= maxChars) return history;
  let start = history.length;
  let kept = 0;
  while (start > 0 && history.length - start < Math.floor(max / 2) && kept + size(history[start - 1]) <= maxChars / 2) kept += size(history[--start]);
  while (start < history.length && history[start].role !== "user") start++;
  return history.slice(start);
}
