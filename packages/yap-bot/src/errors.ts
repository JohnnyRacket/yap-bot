/** A readable message from anything thrown: an Error, a string, a Response, an object. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  if (typeof Response !== "undefined" && e instanceof Response) return `HTTP ${e.status} ${e.statusText}`.trim();
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}
