// Running from a checkout (src/ as TypeScript), "yap-bot" imports must resolve to the same source
// files, not the built dist/ (which may not exist, and would be a second copy of the runtime). The CLI
// sets this up for the main thread; worker threads (hearing, which loads engine modules) call it too.
import { registerHooks } from "node:module";

let done = false;

export function useSourceConditions() {
  if (done || !import.meta.url.endsWith(".ts")) return;
  done = true;
  registerHooks({
    resolve: (specifier, context, next) => next(specifier, { ...context, conditions: [...context.conditions, "yap-bot-src"] }),
  });
}
