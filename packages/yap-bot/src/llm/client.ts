// A small streaming client for OpenAI-compatible chat completions (llama.cpp / llama-swap, vLLM,
// Ollama, OpenAI, OpenRouter…), with tool calls, cancellation, and llama.cpp's timing and cache
// numbers. An agent can bring its own instead (ModelConfig.complete).

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

/** The model an agent talks to (AgentDefinition.model). */
export interface ModelConfig {
  /** OpenAI-compatible base URL, e.g. http://localhost:8080/v1. Default: $LLM_URL. */
  baseUrl: string;
  /** Default: $LLM_MODEL. */
  id: string;
  /** Sent as a bearer token. Default: $LLM_API_KEY. */
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * Sent as chat_template_kwargs.enable_thinking (llama.cpp, vLLM), when set. Turn it off for
   * thinking models: a voice can't wait for them to think.
   */
  thinking?: boolean;
  /** Merged into every request body. */
  extraBody?: Record<string, unknown>;
  /** Replaces the built-in client: for providers that aren't OpenAI-compatible. */
  complete?(req: CompletionRequest): Promise<CompletionResult>;
}

export interface CompletionRequest {
  baseUrl: string;
  model: string;
  apiKey?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  thinking?: boolean;
  extraBody?: Record<string, unknown>;
  signal?: AbortSignal;
  onText?(delta: string): void;
  /** A tool call's name as it streams in, before its arguments are written. */
  onToolName?(name: string): void;
}

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
  firstTokenAt?: number;
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
  promptMs?: number;
  generationTps?: number;
}

/** One request to the agent's model, through its own complete() when it has one. */
export function chat(model: ModelConfig, req: Omit<CompletionRequest, "baseUrl" | "model" | "apiKey" | "thinking" | "extraBody">): Promise<CompletionResult> {
  const full: CompletionRequest = {
    baseUrl: model.baseUrl,
    model: model.id,
    apiKey: model.apiKey,
    temperature: model.temperature,
    maxTokens: model.maxTokens,
    thinking: model.thinking,
    extraBody: model.extraBody,
    ...req,
  };
  return (model.complete ?? complete)(full);
}

export async function complete(req: CompletionRequest): Promise<CompletionResult> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: true,
    // llama.cpp caches the prompt by default. Don't send cache_prompt: with streaming, ik_llama.cpp
    // then stops emitting tool calls (the model answers in text instead).
    temperature: req.temperature,
    max_tokens: req.maxTokens,
    ...req.extraBody,
  };
  if (req.thinking !== undefined) body.chat_template_kwargs = { ...(body.chat_template_kwargs as object), enable_thinking: req.thinking };
  if (req.tools?.length) body.tools = req.tools;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (req.apiKey) headers.Authorization = `Bearer ${req.apiKey}`;

  const res = await fetch(`${req.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!res.ok || !res.body) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const result: CompletionResult = { text: "", toolCalls: [] };
  const calls = new Map<number, ToolCall>();
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      const msg = JSON.parse(data);
      if (msg.timings) {
        result.promptTokens = msg.timings.prompt_n;
        result.cachedTokens = msg.timings.cache_n;
        result.completionTokens = msg.timings.predicted_n;
        result.promptMs = msg.timings.prompt_ms;
        result.generationTps = msg.timings.predicted_per_second;
      }
      const delta = msg.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        result.firstTokenAt ??= Date.now();
        result.text += delta.content;
        req.onText?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        result.firstTokenAt ??= Date.now();
        let call = calls.get(tc.index);
        if (!call) {
          call = { id: tc.id || `call_${tc.index}_${Date.now()}`, type: "function", function: { name: "", arguments: "" } };
          calls.set(tc.index, call);
        }
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) {
          call.function.name += tc.function.name;
          req.onToolName?.(call.function.name);
        }
        if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
      }
    }
  }
  result.toolCalls = [...calls.values()].filter((c) => c.function.name);
  return result;
}

/** One request at a time to the model, conversation turns first. */
export class LlmQueue {
  private queue: { priority: number; seq: number; start: () => void }[] = [];
  private busy = false;
  private seq = 0;

  async run<T>(priority: number, fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((start) => {
      this.queue.push({ priority, seq: this.seq++, start });
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      this.next();
    });
    try {
      return await fn();
    } finally {
      this.busy = false;
      this.next();
    }
  }

  private next() {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    job.start();
  }
}

export const Priority = { Conversation: 0, Prefill: 5, Background: 10 } as const;
