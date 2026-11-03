// local time (TZ), as people read logs against their own clock; toISOString would be UTC
const ts = () => {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

export const log = {
  info: (...a: unknown[]) => console.log(ts(), ...a),
  warn: (...a: unknown[]) => console.warn(ts(), "WARN", ...a),
  error: (...a: unknown[]) => console.error(ts(), "ERROR", ...a),
  debug: (...a: unknown[]) => {
    if (process.env.DEBUG) console.log(ts(), "debug", ...a);
  },
};
