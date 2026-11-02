// A tool of your own: the file name is the tool's name, the description and input are what the
// model sees, and whatever execute returns goes back to it as JSON.
import { defineTool, z } from "yap-bot";

export default defineTool({
  description: "Flip a coin, or roll dice.",
  input: z.object({
    dice: z.number().int().min(1).max(10).optional().describe("How many dice to roll; leave out to flip a coin"),
  }),
  // said while it runs (if nothing else was said yet); false for nothing
  ack: false,
  execute({ dice }) {
    if (!dice) return { coin: Math.random() < 0.5 ? "heads" : "tails" };
    return { dice: Array.from({ length: dice }, () => 1 + Math.floor(Math.random() * 6)) };
  },
});
