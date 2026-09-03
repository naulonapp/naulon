/**
 * The proof link — where a reader goes to see that the author was paid.
 *
 * Every paid read mints a Citation License whose `jti` is the settlement event id, and the
 * gate can mint a permanent citation record from that same row at `/licenses/:jti/record`.
 * Until these helpers existed, nothing an agent produced carried a URL to either: a research
 * answer cited `licensed 🎫 07e4a7de` and a reader could do nothing with it.
 *
 * Two URLs, two audiences:
 *   - `proofPageUrl` — the HUMAN page. It names the publisher (`host`) and the settlement
 *     (`jti`); the page fetches the record from the issuer and checks the signature in the
 *     visitor's browser against the issuer's published keys. naulon is never asked whether the
 *     licence is valid, which is the property being sold.
 *   - `recordUrl` — the MACHINE document, the gate's own record route. It carries a `host`
 *     hint when the gate fronts publishers other than itself, because a publisher serving
 *     their own site through the SDK has no record route on their origin, and a browser cannot
 *     set `Host` (the edge answers a spoofed one with 403).
 *
 * The shape is decided HERE, once. Emitters call these rather than spelling a query string.
 */

/** A licence identity is `naulon:<host>`; this is `<host>`, lower-cased, or nothing. */
export function issuerHost(identity: string | undefined): string | undefined {
  if (!identity) return undefined;
  const m = /^naulon:(.+)$/i.exec(identity.trim());
  const host = m?.[1]?.trim().toLowerCase();
  // A host, possibly with a port — never a path, a query, or a scheme. Anything else would
  // put an attacker-shaped string into a URL a reader is told to trust.
  if (!host || !/^[a-z0-9.-]+(:\d+)?$/.test(host)) return undefined;
  return host;
}

/** The page a reader opens. `verifyUrl` may already carry a query; the two params are added to it. */
export function proofPageUrl(input: { verifyUrl: string; host: string; jti: string }): string {
  const u = new URL(input.verifyUrl);
  u.searchParams.set("host", input.host);
  u.searchParams.set("jti", input.jti);
  return u.toString();
}

/**
 * The gate's record route for a settlement. The hint is appended only when the gate's own host
 * is not the publisher's, so a single-tenant gate's URL is unchanged by this existing.
 */
export function recordUrl(input: { gateOrigin: string; host: string; jti: string }): string {
  let origin: URL;
  try {
    origin = new URL(input.gateOrigin);
  } catch {
    throw new Error(`recordUrl: gateOrigin is not a URL: ${input.gateOrigin}`);
  }
  const u = new URL(`/licenses/${encodeURIComponent(input.jti)}/record`, origin.origin);
  if (origin.host.toLowerCase() !== input.host.toLowerCase()) u.searchParams.set("host", input.host);
  return u.toString();
}
