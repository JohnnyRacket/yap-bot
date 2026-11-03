import { defineVoice } from "../../../src/index.ts";
import { silentTts } from "../engines/silent-tts.ts";

const engine = (name: string, options: object) => ({ name, module: new URL(`../engines/${name}.ts`, import.meta.url).href, options });

export default defineVoice({
  stt: engine("script-stt", { lines: JSON.parse(process.env.TEST_STT_LINES ?? "[]"), finalDelayMs: 150 }),
  vad: engine("energy-vad", {}),
  turn: { detector: false, pauseMs: 200, incompleteWaitMs: 400 },
  wake: { spotter: false },
  tts: { engine: silentTts(), voice: "test", speed: 1 },
  interruptions: { minWords: 2 },
  acks: { tool: ["Okay."] },
});
