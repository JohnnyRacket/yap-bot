// What people say and the tool call that should follow: `npm run eval` (nothing runs; it only
// checks the model's first call). Add a case whenever you add a tool.
import type { EvalCase } from "yap-bot/testing";

export const cases: EvalCase[] = [
  { name: "timer: basic", say: "set a timer for ten minutes", expect: { set_timer: (a) => a.minutes === 10 } },
  { name: "timer: named", say: "pasta timer, eight minutes", expect: { set_timer: (a) => a.minutes === 8 && /pasta/i.test(a.name ?? "") } },
  { name: "timer: cancel", say: "cancel the pasta timer", expect: { cancel_timer: (a) => /pasta/i.test(a.name) } },
  { name: "coin: flip", say: "flip a coin", expect: { flip_coin: (a) => !a.dice } },
  { name: "coin: dice", say: "roll two dice", expect: { flip_coin: (a) => a.dice === 2 } },
  { name: "end: thanks", say: "okay thanks, that's all", expect: { end_conversation: () => true } },
  { name: "chat: joke", say: "tell me a joke", expect: { none: () => true } },
];
