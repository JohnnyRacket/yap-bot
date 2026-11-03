import { defineTool, z } from "../../../../src/index.ts";

/** Waits until its signal says stop: for the tool timeout test. */
export const seen = { aborted: false };

export default defineTool({
  description: "A lookup that takes too long.",
  input: z.object({}),
  timeoutMs: Number(process.env.TEST_SLOW_TIMEOUT_MS ?? 300),
  ack: false,
  execute: (_, { signal }) =>
    new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        seen.aborted = true;
        resolve({ late: true });
      });
    }),
});
