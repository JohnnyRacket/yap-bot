const ts = () => new Date().toISOString().slice(11, 23);

export const log = {
  info: (...a: unknown[]) => console.log(ts(), ...a),
  warn: (...a: unknown[]) => console.warn(ts(), "WARN", ...a),
  error: (...a: unknown[]) => console.error(ts(), "ERROR", ...a),
  debug: (...a: unknown[]) => {
    if (process.env.DEBUG) console.log(ts(), "debug", ...a);
  },
};
