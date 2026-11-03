import { defineTool, z } from "../../../../src/index.ts";

export default defineTool({
  description: "Count the user's library holds.",
  input: z.object({}),
  ack: false,
  execute: () => ({ holds: 3 }),
});
