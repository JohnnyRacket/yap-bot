import { defineAgent } from "yap-bot";

export default defineAgent({
  name: "Yappy",
  model: {
    // any OpenAI-compatible server: llama.cpp / llama-swap, vLLM, Ollama, OpenAI, OpenRouter…
    baseUrl: process.env.LLM_URL ?? "http://localhost:8080/v1",
    id: process.env.LLM_MODEL ?? "",
    // lower is more reliable at calling tools instead of just saying it did
    temperature: 0.5,
    // the longest reply, in tokens: raise it for an agent that reads out long lists
    maxTokens: 400,
    // for llama.cpp thinking models: a voice can't wait for it to think
    thinking: false,
  },
  // the default wake word is "computer"; your own needs the keyword spotter's tokens (see WakeWord)
  // wake: { word: "jarvis", keywords: ["▁J AR VI S"], keywordBoost: 1.5, keywordThreshold: 0.25 },
  // colors: any CSS colors, one set or { light, dark }; devices can change them in Settings → Appearance
  // ui: { title: "Yappy", colors: { accent: "#0d9488", userBubble: "#0d9488", botBubble: "#e6f2f0", background: "#f6faf9" } },
  ui: { title: "Yappy" },
});
