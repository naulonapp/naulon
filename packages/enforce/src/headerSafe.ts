/**
 * `headerSafe` — the one place diagnostic text meets a header value.
 *
 * Lives in `enforce` rather than `tollgate` because BOTH emitters set `X-Naulon-Verdict`:
 * the hosted gate and the in-app middleware. The middleware cannot import tollgate (the
 * dependency points enforce ← tollgate), so the alternative was a second copy of a
 * security control — which is how two copies drift and one of them stops stripping.
 */
export function headerSafe(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 32 || c >= 127 ? " " : ch;
  }
  return out;
}
