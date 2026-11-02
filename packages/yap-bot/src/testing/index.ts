// Tools for testing an agent: a headless device, synthetic speech, and the tool-choice eval.
export { TestClient, speech, streamAudio, formatMarks, type Event } from "./client.ts";
export { runEval, type EvalCase, type EvalArgs } from "./eval.ts";
