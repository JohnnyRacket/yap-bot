// An OpenAI-compatible chat endpoint for tests: streams a scripted answer chosen from the
// conversation, the way llama.cpp streams (text deltas, tool call name then arguments).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChatMessage } from "../../src/llm/client.ts";

export interface MockLlm {
  url: string;
  /** Every request's messages, in order. */
  requests: { messages: ChatMessage[]; tools?: { function: { name: string } }[] }[];
  close(): Promise<void>;
}

const STORY = "Once upon a time there was a cat. She wanted to visit the moon. She built a rocket from boxes. It flew higher than any bird. At the top she found a sea of milk. She drank until the sun came up. Then she flew home for breakfast.";

type Reply = { text: string } | { tool: string; args: object };

function answer(messages: ChatMessage[]): Reply {
  const last = messages[messages.length - 1];
  if (last.role === "tool") return { text: last.content.includes("timed out") ? "That took too long." : "OK, done. Your timer is running." };
  const said = String(last.content ?? "").toLowerCase();
  if (said.includes("slow")) return { tool: "slow_lookup", args: {} };
  if (said.includes("timer")) return { tool: "set_timer", args: { minutes: 5, name: "tea" } };
  if (said.includes("bye")) return { tool: "end_conversation", args: {} };
  if (said.includes("story")) return { text: STORY };
  if (said.includes("broken")) throw new Error("scripted failure");
  return { text: "Hello there. How can I help?" };
}

export async function startMockLlm(): Promise<MockLlm> {
  const requests: MockLlm["requests"] = [];
  const server: Server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = JSON.parse(body);
    requests.push({ messages: json.messages, tools: json.tools });
    let reply: Reply;
    try {
      reply = answer(json.messages);
    } catch (e) {
      res.writeHead(500).end((e as Error).message);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta: object) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
    if ("text" in reply) {
      for (const word of reply.text.split(/(?<= )/)) {
        send({ content: word });
        await new Promise((r) => setTimeout(r, 2));
      }
    } else {
      send({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: reply.tool, arguments: "" } }] });
      send({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.args) } }] });
    }
    res.write(`data: ${JSON.stringify({ choices: [], timings: { prompt_n: 10, cache_n: 0, predicted_n: 5 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
