// The keyword spotter's model files, as served to devices that spot the wake word themselves.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface DeviceKwsModel {
  /** encoder.onnx, decoder.onnx, joiner.onnx, tokens.txt → the file on disk. */
  files: Record<string, string>;
  /** Changes when the files do. */
  version: string;
}

/** dir: a sherpa-onnx zipformer keyword spotter's directory under the models directory. */
export function findDeviceKwsModel(modelsDir: string, dir: string): DeviceKwsModel | null {
  const d = join(modelsDir, dir);
  if (!existsSync(d)) return null;
  const entries = readdirSync(d);
  const files: Record<string, string> = { "tokens.txt": join(d, "tokens.txt") };
  for (const part of ["encoder", "decoder", "joiner"]) {
    const f = entries.find((x) => x.startsWith(part) && x.endsWith(".int8.onnx"));
    if (!f) return null;
    files[`${part}.onnx`] = join(d, f);
  }
  if (!existsSync(files["tokens.txt"])) return null;
  const stats = Object.values(files).map((f) => statSync(f));
  const version = stats.reduce((h, s) => (h * 31 + s.size + Math.round(s.mtimeMs)) % 2 ** 32, 7).toString(36);
  return { files, version };
}
