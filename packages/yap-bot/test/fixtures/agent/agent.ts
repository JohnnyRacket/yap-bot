import { defineAgent } from "../../../src/index.ts";

export default defineAgent({
  name: "Test agent",
  model: { baseUrl: process.env.TEST_LLM_URL ?? "http://127.0.0.1:1/v1", id: "mock", timeouts: { firstByteMs: 2000, idleMs: 600 } },
  wake: { word: "computer" },
  followUpMs: 2000,
  timezone: "America/Chicago",
  apiSecret: "test-secret",
});
