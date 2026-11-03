import { defineTrigger } from "yap-bot";

// a webhook that answers: the caller gets what run returns
export default defineTrigger({
  on: { webhook: { respond: true } },
  run(_, input) {
    const p = input.source === "webhook" ? (input.payload as { a: number; b: number }) : { a: 0, b: 0 };
    if (p.a < 0) throw new Error("no negatives");
    return { sum: p.a + p.b };
  },
});
