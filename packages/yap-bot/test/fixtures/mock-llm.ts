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

type Call = { tool: string; args: object };
type Reply = { text?: string; calls?: Call[]; stall?: boolean };

function answer(messages: ChatMessage[]): Reply {
  const last = messages[messages.length - 1];
  if (last.role === "tool") {
    const c = last.content;
    if (c.includes("timed out")) return { text: "That took too long." };
    if (c.includes("error")) return { text: "That didn't work." };
    if (c.includes("holds")) return { text: "She has three holds." };
    return { text: "OK, done. Your timer is running." };
  }
  const said = String(last.content ?? "").toLowerCase();
  if (said.includes("stall")) return { stall: true };
  if (said.includes("hold twice")) return { calls: [{ tool: "slow_lookup", args: {} }, { tool: "set_timer", args: { minutes: 1, name: "second" } }] };
  if (said.includes("my holds")) return { text: "Let me check that", calls: [{ tool: "count_holds", args: {} }] };
  if (said.includes("string")) return { calls: [{ tool: "throws_string", args: {} }] };
  if (said.includes("slow")) return { calls: [{ tool: "slow_lookup", args: {} }] };
  if (said.includes("timer")) return { calls: [{ tool: "set_timer", args: { minutes: 5, name: "tea" } }] };
  if (said.includes("bye")) return { calls: [{ tool: "end_conversation", args: {} }] };
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
    if (reply.stall) {
      // a first piece, then nothing: the client's stall timeout has to end it
      send({ content: "Hmm" });
      return;
    }
    for (const word of reply.text?.split(/(?<= )/) ?? []) {
      send({ content: word });
      await new Promise((r) => setTimeout(r, 2));
    }
    (reply.calls ?? []).forEach((c, i) => {
      send({ tool_calls: [{ index: i, id: `call_${requests.length}_${i}`, type: "function", function: { name: c.tool, arguments: "" } }] });
      send({ tool_calls: [{ index: i, function: { arguments: JSON.stringify(c.args) } }] });
    });
    res.write(`data: ${JSON.stringify({ choices: [], timings: { prompt_n: 10, cache_n: 0, predicted_n: 5 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
