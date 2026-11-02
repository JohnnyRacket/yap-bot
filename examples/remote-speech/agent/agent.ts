import { defineAgent } from "yap-bot";

export default defineAgent({
  name: "Remote speech",
  model: { temperature: 0.5, maxTokens: 400, thinking: false },
  ui: { title: "Remote speech", icon: "📡" },
});
