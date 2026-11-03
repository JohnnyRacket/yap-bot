import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig, type Plugin } from "vite";

const require = createRequire(import.meta.url);

/**
 * `virtual:sherpa-kws`: sherpa-onnx's WebAssembly build (the npm package, made for Node) as an ES
 * module that runs in a browser worker, with its keyword spotter wrapper. The build keeps files in
 * Node's filesystem (NODERAWFS); these patches leave it the in-memory one instead. Each patch must
 * apply exactly once, so a sherpa-onnx update that changes the code fails the build here.
 */
function sherpaKws(): Plugin {
  const id = "virtual:sherpa-kws";
  const patch = (code: string, from: string, to: string) => {
    const n = code.split(from).length - 1;
    if (n !== 1) throw new Error(`sherpa-kws: expected one ${JSON.stringify(from.slice(0, 60))} in sherpa-onnx's glue, found ${n}`);
    return code.replace(from, () => to);
  };
  return {
    name: "sherpa-kws",
    resolveId: (s) => (s === id ? `\0${id}` : undefined),
    load(s) {
      if (s !== `\0${id}`) return;
      const dir = dirname(require.resolve("sherpa-onnx/package.json"));
      let glue = readFileSync(join(dir, "sherpa-onnx-wasm-nodejs.js"), "utf8");
      glue = patch(glue, `if(!ENVIRONMENT_IS_NODE){throw new Error("NODERAWFS is currently only supported on Node.js environment.")}`, "");
      glue = patch(glue, "for(var _key in NODERAWFS){", "if(ENVIRONMENT_IS_NODE)for(var _key in NODERAWFS){");
      glue = patch(glue, `if(typeof exports==="object"&&typeof module==="object"){module.exports=Module;module.exports.default=Module}else if(typeof define==="function"&&define["amd"])define([],()=>Module);`, "");
      // its Node export (behind a check that fails in browsers) is the only CommonJS left
      const kws = patch(readFileSync(join(dir, "sherpa-onnx-kws.js"), "utf8"), "module.exports = {", "void {");
      return [
        `import nodePath from "path-browserify";`,
        // the glue's paths go through Node's path module (posix here); fs and crypto only under Node
        `const require = (m) => { if (m === "path") return { ...nodePath, posix: nodePath }; throw new Error("sherpa-kws: no " + m + " in a browser"); };`,
        glue,
        kws,
        "export { Module as createModule, createKws };",
      ].join("\n");
    },
  };
}

// `npm run dev:web` serves the client with hot reload and proxies the device socket to the runtime
// (npm run dev at the repo root, on https://localhost:8450).
export default defineConfig({
  plugins: [react(), tailwindcss(), sherpaKws()],
  resolve: {
    // the protocol from source: nothing to build first
    conditions: ["yap-bot-src", ...defaultClientConditions],
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  worker: { format: "es", plugins: () => [sherpaKws()] },
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/ws": { target: "wss://localhost:8450", ws: true, secure: false },
      "/models": { target: "https://localhost:8450", secure: false },
    },
  },
  // served by the yap-bot package, which publishes it
  build: { outDir: "../yap-bot/web", emptyOutDir: true, target: "es2022" },
});
