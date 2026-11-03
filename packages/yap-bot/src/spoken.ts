// Text that reads well aloud.

/**
 * A code, PIN or number read digit by digit, in groups: "5 2 5 4, 1 4 7 0". Return this from a tool
 * rather than "52541470", which speech reads as fifty-two million… The model passes it on as is.
 */
export function spokenDigits(code: string | number, group = 4): string {
  const digits = String(code).replace(/\D/g, "");
  const groups: string[] = [];
  for (let i = 0; i < digits.length; i += group) groups.push([...digits.slice(i, i + group)].join(" "));
  return groups.join(", ");
}
