#!/usr/bin/env node
// From a checkout (src/ present) the TypeScript runs as is, and "yap-bot" imports resolve to the
// same source files; from the published package, the built dist/.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

const src = new URL("../src/cli.ts", import.meta.url);
if (existsSync(src)) {
  registerHooks({
    resolve: (specifier, context, next) => next(specifier, { ...context, conditions: [...context.conditions, "yap-bot-src"] }),
  });
  await import(src.href);
} else {
  await import(new URL("../dist/cli.js", import.meta.url).href);
}
