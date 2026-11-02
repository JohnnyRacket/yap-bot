// The wake word spotter on the device: the same keyword spotter the server runs (sherpa-onnx's
// zipformer KWS, same model and settings), as WebAssembly in a worker.
import { createKws, createModule, type Kws, type KwsStream } from "virtual:sherpa-kws";
import wasmUrl from "sherpa-onnx/sherpa-onnx-wasm-nodejs.wasm?url";
import type { DeviceWakeConfig } from "yap-bot/protocol";
import type { FromSpotter, ToSpotter } from "./messages.ts";

const SR = 16000;
const send = (m: FromSpotter) => postMessage(m);

let kws: Kws | null = null;
let stream: KwsStream | null = null;
// how hard it works: decode time against audio time, reported every few seconds of audio
let busyMs = 0;
let audioMs = 0;

/** From the Cache API when there is one, so the wasm (~15 MB) and model (~5 MB) download once. */
async function cached(url: string): Promise<Uint8Array> {
  const cache = await caches?.open("yap-bot-kws").catch(() => null);
  let res = await cache?.match(url);
  if (!res) {
    res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    await cache?.put(url, res.clone()).catch(() => {});
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function init(c: DeviceWakeConfig) {
  const t0 = performance.now();
  const model = (f: string) => `${c.modelUrl}/${f}?v=${c.modelVersion}`;
  const [wasm, encoder, decoder, joiner, tokens] = await Promise.all([wasmUrl, model("encoder.onnx"), model("decoder.onnx"), model("joiner.onnx"), model("tokens.txt")].map(cached));
  const fetchedMs = performance.now() - t0;
  const Module = await createModule({ wasmBinary: wasm, print: () => {}, printErr: (s) => console.warn("sherpa-onnx:", s) });
  Module.FS.mkdir("/kws");
  for (const [name, data] of Object.entries({ "encoder.onnx": encoder, "decoder.onnx": decoder, "joiner.onnx": joiner, "tokens.txt": tokens })) Module.FS.writeFile(`/kws/${name}`, data);
  const keywords = c.keywords.map((k) => `${k.trim()} :${c.boost} #${c.threshold} @wake`).join("\n") + "\n";
  kws = createKws(Module, {
    featConfig: { samplingRate: SR, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: "/kws/encoder.onnx", decoder: "/kws/decoder.onnx", joiner: "/kws/joiner.onnx" },
      tokens: "/kws/tokens.txt",
      provider: "cpu",
      modelType: "",
      numThreads: 1,
      debug: 0,
      modelingUnit: "",
      bpeVocab: "",
    },
    maxActivePaths: 4,
    numTrailingBlanks: 1,
    keywordsScore: c.boost,
    keywordsThreshold: c.threshold,
    keywords: "",
    keywordsBuf: keywords,
    keywordsBufSize: new TextEncoder().encode(keywords).length,
  });
  stream = kws.createStream();
  send({ type: "ready", loadMs: Math.round(performance.now() - t0), fetchMs: Math.round(fetchedMs) });
}

function onAudio(samples: Float32Array, end: number) {
  if (!kws || !stream) return;
  const t0 = performance.now();
  stream.acceptWaveform(SR, samples);
  while (kws.isReady(stream)) {
    kws.decode(stream);
    const r = kws.getResult(stream);
    if (r.keyword) {
      kws.reset(stream);
      send({ type: "keyword", keyword: r.keyword, end });
    }
  }
  busyMs += performance.now() - t0;
  audioMs += (samples.length / SR) * 1000;
  if (audioMs >= 5000) {
    send({ type: "load", share: busyMs / audioMs });
    busyMs = audioMs = 0;
  }
}

onmessage = (e: MessageEvent<ToSpotter>) => {
  const m = e.data;
  try {
    if (m.type === "init") void init(m.config).catch((err) => send({ type: "error", message: (err as Error).message }));
    else if (m.type === "audio") onAudio(m.samples, m.end);
    // starting over (after being awake): not from the middle of a word it last heard seconds ago
    else if (m.type === "reset" && kws && stream) kws.reset(stream);
  } catch (err) {
    send({ type: "error", message: (err as Error).message });
  }
};
