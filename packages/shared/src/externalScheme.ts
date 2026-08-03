/**
 * What scheme is this request on, as the OUTSIDE WORLD sees it?
 *
 * The gate almost never terminates TLS itself. In every real deployment something
 * (Caddy, a CDN, a serverless edge) ends TLS and speaks plain HTTP to the process,
 * so `req.url` — the scheme the socket observed — says `http:` for a request the
 * buyer made over `https:`. That is fine for routing and wrong for anything the gate
 * PUBLISHES, because a published URL is a claim about how to reach the resource.
 *
 * It matters most in the 402: `resource.url` is the identifier inside a signed
 * payment quote. A buyer that canonicalises on it, or a receipt consumer comparing
 * it against the URL actually fetched, sees a scheme mismatch it has no way to
 * resolve. Every quote this fleet issued advertised `http://` until this existed.
 *
 * Sibling of `clientIdentity.ts`, and deliberately the same shape of answer:
 *
 *   - It is gated on the SAME `TRUST_PROXY` switch. There is one question — "is the
 *     thing in front of me mine?" — and it must not have two answers. An operator who
 *     has already said yes for the client IP has said yes for the scheme.
 *   - The trail is read from the RIGHT, for the same reason. `X-Forwarded-Proto` is
 *     appended hop by hop just like `X-Forwarded-For`, so a caller who prepends
 *     `https` sits at the left and is ignored; the entry our own trusted hop wrote is
 *     at the right, `TRUST_PROXY_HOPS` in.
 *   - Default-off degrades to the truth, never to a guess: with `TRUST_PROXY=false`
 *     a directly-exposed gate keeps advertising exactly the scheme it is serving on.
 *
 * The one thing this does NOT inherit is tolerance for a weird value. The result is
 * spliced into a URL that gets signed, so anything other than the two schemes we
 * actually serve is discarded in favour of what the socket saw.
 *
 * Framework-free, like the rest of this package: it takes facts, not a request
 * object — except `externalUrl`, the one-line adapter for callers that hold a
 * standard `Request`.
 */

import { forwardedFor } from "./clientIdentity.ts";

/** The only schemes a naulon deployment serves. Anything else is not a scheme we wrote. */
const SERVED_SCHEMES = new Set(["http", "https"]);

export interface ExternalSchemeInput {
  /** Raw `X-Forwarded-Proto` value, if any. Only consulted when `trustProxy`. */
  xfp: string | undefined;
  /** The scheme the server itself observed, without the colon (`new URL(req.url).protocol`). */
  observed: string;
  /** Is there a trusted proxy in front that sets/appends the header? (`TRUST_PROXY`) */
  trustProxy: boolean;
  /** How many trusted hops sit in front, counted outward (`TRUST_PROXY_HOPS`). */
  hops?: number;
}

/**
 * The externally-visible scheme: `"http"` or `"https"`, never anything else.
 *
 * Falls back to `observed` whenever the forwarded value is absent, untrusted, or not
 * a scheme we serve — so the worst case is the pre-existing behaviour, never a
 * scheme an attacker chose.
 */
export function externalScheme({ xfp, observed, trustProxy, hops = 1 }: ExternalSchemeInput): string {
  if (!trustProxy || !xfp) return observed;
  const claimed = forwardedFor(xfp, Math.max(1, hops))?.trim().toLowerCase();
  return claimed && SERVED_SCHEMES.has(claimed) ? claimed : observed;
}

/** How a caller holding a `Request` asks either question. */
export interface ExternalSchemeOpts {
  trustProxy: boolean;
  hops?: number;
}

/**
 * `externalScheme` for callers that hold a standard `Request`.
 *
 * Exists so the "read the header, pass the observed scheme, thread the two config
 * values" adapter is written once. It was open-coded at three call sites (the quote,
 * the upstream forward headers, the Bot-Auth signature base) and three copies of a
 * trust decision is how one of them ends up trusting something the others don't.
 */
export function externalSchemeOf(req: Request, opts: ExternalSchemeOpts): string {
  return externalScheme({
    xfp: req.headers.get("x-forwarded-proto") ?? undefined,
    observed: new URL(req.url).protocol.replace(":", ""),
    trustProxy: opts.trustProxy,
    ...(opts.hops === undefined ? {} : { hops: opts.hops }),
  });
}

/**
 * The request's URL as the outside world sees it — scheme corrected, everything else
 * untouched.
 *
 * Returns a string rather than a `URL` because every caller is about to embed it in a
 * payload. The fragment is dropped explicitly: a fragment is never sent to a server,
 * so it was never part of the resource being tolled, and a signed identifier should
 * not carry a component the wire cannot have produced. (A live request cannot reach
 * here with one — this only bites synthetic callers — but the parser does preserve it,
 * so leaving it to chance would be a guess.)
 */
export function externalUrl(req: Request, opts: ExternalSchemeOpts): string {
  const url = new URL(req.url);
  url.hash = "";
  url.protocol = `${externalSchemeOf(req, opts)}:`;
  return url.toString();
}
