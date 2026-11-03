import { defineTool, z } from "../../../../src/index.ts";

export default defineTool({
  description: "Fails the way some libraries do: by throwing a string.",
  input: z.object({}),
  ack: false,
  execute() {
    throw "the library said no";
  },
});
