import { defineFastpath } from "../../../../src/index.ts";

export default defineFastpath({ match: "ping", run: () => "Pong." });
