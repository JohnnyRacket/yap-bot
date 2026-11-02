declare module "*.css";
declare module "*?url" {
  const url: string;
  export default url;
}

/** sherpa-onnx's WebAssembly build with its keyword spotter wrapper (vite.config.ts). */
declare module "virtual:sherpa-kws" {
  export interface SherpaModule {
    FS: { mkdir(path: string): void; writeFile(path: string, data: Uint8Array | string): void };
  }
  export interface KwsStream {
    acceptWaveform(sampleRate: number, samples: Float32Array): void;
    free(): void;
  }
  export interface Kws {
    createStream(): KwsStream;
    isReady(stream: KwsStream): boolean;
    decode(stream: KwsStream): void;
    reset(stream: KwsStream): void;
    getResult(stream: KwsStream): { keyword: string };
  }
  export function createModule(options: { wasmBinary?: Uint8Array; locateFile?: (path: string) => string; print?: (s: string) => void; printErr?: (s: string) => void }): Promise<SherpaModule>;
  export function createKws(module: SherpaModule, config: unknown): Kws;
}
