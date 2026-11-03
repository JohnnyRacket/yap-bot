// Values that outlive a reload of the agent's files: a logged-in session, a cookie jar, a cache, a
// client with a connection pool. Editing a file re-imports the agent folder, so anything kept in a
// module of its own starts over each time; what's made through shared() is made once per server.
//
//   // agent/lib/library.ts
//   import { shared } from "yap-bot";
//   export const session = shared("library-session", () => ({ cookie: "", loggedInAt: 0 }));

const KEY = Symbol.for("yap-bot.shared");
const values: Map<string, unknown> = ((globalThis as Record<symbol, unknown>)[KEY] ??= new Map()) as Map<string, unknown>;

/** The value made for this name, made with init the first time it's asked for. */
export function shared<T>(name: string, init: () => T): T {
  if (!values.has(name)) values.set(name, init());
  return values.get(name) as T;
}
