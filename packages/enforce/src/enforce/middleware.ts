/**
 * `naulonMiddleware` — the framework-agnostic core of in-app toll enforcement.
 *
 * A tolled site on a per-IP rate-limiting edge (Vercel Free's 429) can't route
 * through the fleet's single egress IP without tripping the limit. This runs the
 * SAME `decide()` the gate runs, IN the publisher's own runtime, so the agent's
 * own IP reaches the origin — no fleet hop, no shared-IP 429. The control plane
 * still owns the money (hosted `/verify`) and the catalog (hosted `/quote`).
 *
 * The core takes a web `Request` and returns `{ response, setHeaders }`:
 *   - `response: Response` → SEND it, short-circuit the app (402 / 403).
 *   - `response: null` → PASS: let the app render locally. `setHeaders` (if any)
 *     must be applied to the app's OUTGOING response — a paid-OK request renders
 *     normally but still carries its `PAYMENT-RESPONSE` + license headers.
 *
 * Custody-free: the payment leg POSTs the buyer's signature to the hosted
 * `/verify`, which settles buyer→author directly. This middleware never holds USDC.
 */
import {
  decide,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_LINK_HEADER,
  LICENSE_HEADER,
  type LicenseVerification,
} from "../decide.ts";
import type { JwkSet } from "@naulon/shared";
import type { QuoteSource } from "./quote-source.ts";

export interface NaulonMiddlewareOptions {
  /**
   * The site's toll config in `PublisherConfig` shape — `decide()` reads
   * `id`, `articlePrefixes` (or `gateScope`), `licenseIdentity`, `seoAllowlist`,
   * and `crawlerPolicy` from it.
   */
  publisher: unknown;
  /** Price + payees source: `localQuoteSource` (own data) or `httpQuoteSource` (cloud). */
  quote: QuoteSource;
  /** The hosted `POST /verify` URL (settles the presented payment, custody-free). */
  verifyUrl: string;
  /** The publisher's `nln_live_` key — bearer-auth to `/verify` (and the cloud quote). */
  apiKey: string;
  /** Injectable fetch (tests); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (tests); defaults to `Date.now`. */
  now?: () => number;
  /**
   * Enable API-mode license re-read verification. REQUIRED for a free re-read
   * (`naulon_read_held`) to work in API mode: the license is minted+signed by the
   * hosted gate, so this in-app enforcer must verify it against the GATE's published
   * JWKS — not its own (absent) signing key. Without this, `decide()` cannot verify a
   * gate-minted license and every licensed re-read 402s (re-charging a paid reader).
   * Pass `{}` to enable with defaults (JWKS URL derived from `verifyUrl`, issuer from
   * `publisher.licenseIdentity`). Absent ⇒ proxy-mode behavior, unchanged.
   */
  licenseVerification?: {
    /** The gate's JWKS URL. Default: `${new URL(verifyUrl).origin}/.well-known/naulon-jwks.json`. */
    jwksUrl?: string;
    /** The `iss`/`aud` the gate stamps for this publisher. Default: `publisher.licenseIdentity`. */
    issuer?: string;
    /** Cache TTL for the fetched JWKS (ms). Default 10 min. The gate rotates rarely; a
     *  stale JWKS is served if a refetch fails (stale-if-error), so a gate hiccup never
     *  turns a paid re-read into a 402. */
    cacheTtlMs?: number;
  };
}

export interface MiddlewareResult {
  /** A Response to send (short-circuit), or `null` to pass to the app. */
  response: Response | null;
  /** Headers to attach to the app's outgoing response on a pass (paid-OK receipt). */
  setHeaders?: Record<string, string>;
}

/** The hosted `/verify` success/refusal envelope. */
interface VerifyResponse {
  ok?: boolean;
  error?: string;
  settlementRef?: string;
  payer?: string;
  responseHeader?: string;
  licenseJws?: string;
}

export function naulonMiddleware(
  opts: NaulonMiddlewareOptions,
): (req: Request) => Promise<MiddlewareResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const clock = opts.now ?? Date.now;

  // API-mode license verification: a cached fetcher for the minting gate's JWKS. Built
  // once; each request reuses the cached keys until the TTL lapses, then refetches. On a
  // refetch failure the last-good JWKS is kept (stale-if-error) so a gate hiccup never
  // turns a paid re-read into a 402. Absent option ⇒ resolver is undefined (proxy mode).
  const resolveVerification = (() => {
    const lv = opts.licenseVerification;
    if (!lv) return undefined;
    const issuer = lv.issuer ?? (opts.publisher as { licenseIdentity?: string }).licenseIdentity;
    const jwksUrl = lv.jwksUrl ?? `${new URL(opts.verifyUrl).origin}/.well-known/naulon-jwks.json`;
    const ttl = lv.cacheTtlMs ?? 600_000;
    let cached: JwkSet | undefined;
    let fetchedAt = 0;
    return async (): Promise<LicenseVerification | undefined> => {
      // Without an issuer we cannot pin iss/aud, so verification would be unsafe — skip
      // (the re-read falls through to the normal 402 path, same as an unconfigured mount).
      if (!issuer) return undefined;
      const fresh = cached && clock() - fetchedAt < ttl;
      if (!fresh) {
        try {
          const res = await doFetch(jwksUrl, { headers: { accept: "application/json" } });
          if (res.ok) {
            cached = (await res.json()) as JwkSet;
            fetchedAt = clock();
          }
        } catch {
          // keep `cached` (stale-if-error); if there was never a good fetch, cached stays undefined.
        }
      }
      return cached ? { jwks: cached, issuer } : undefined;
    };
  })();

  return async (req: Request): Promise<MiddlewareResult> => {
    const url = new URL(req.url);
    // Only resolve the gate JWKS when this request actually presents a license — a
    // human read or a first-time agent 402 carries none, so the hot path never fetches.
    const licenseVerification =
      resolveVerification && req.headers.get(LICENSE_HEADER) ? await resolveVerification() : undefined;
    const d = await decide({
      raw: req,
      host: url.host,
      path: url.pathname + url.search,
      publisher: opts.publisher as never,
      now: clock(),
      quote: (publisher, slug, kind) => opts.quote.quote(publisher, slug, kind, { resource: req.url }),
      ...(licenseVerification ? { licenseVerification } : {}),
    });

    switch (d.kind) {
      // Human, free re-read, unknown/non-article: let the app render locally.
      case "passthrough":
      case "free":
      case "reread":
        return { response: null };

      case "blocked":
        return { response: new Response("This crawler is refused by the publisher.", { status: 403 }) };

      case "payment-required":
        return {
          response: new Response(null, {
            status: 402,
            headers: { [PAYMENT_REQUIRED_HEADER]: d.header, Link: PAYMENT_LINK_HEADER },
          }),
        };

      case "payment-presented": {
        // Custody-free settlement: the buyer's signature goes to the hosted
        // /verify, which settles buyer→author and mints the receipt.
        let body: VerifyResponse;
        let status: number;
        try {
          const res = await doFetch(opts.verifyUrl, {
            method: "POST",
            headers: {
              authorization: `Bearer ${opts.apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ payment: d.payment, legs: d.legs, quote: d.quote, resource: req.url }),
          });
          status = res.status;
          body = (await res.json().catch(() => ({}))) as VerifyResponse;
        } catch {
          // /verify unreachable → refuse this paid attempt (fail-closed on the
          // payment leg: we can't confirm settlement, so we can't serve paid).
          return { response: new Response(JSON.stringify({ error: "verify unreachable" }), { status: 402, headers: { "content-type": "application/json" } }) };
        }

        if (status === 200 && body.ok) {
          const setHeaders: Record<string, string> = {};
          if (body.responseHeader) setHeaders[PAYMENT_RESPONSE_HEADER] = body.responseHeader;
          if (body.licenseJws) setHeaders[LICENSE_HEADER] = body.licenseJws;
          return { response: null, setHeaders };
        }
        return {
          response: new Response(JSON.stringify({ error: body.error ?? "payment rejected" }), {
            status: 402,
            headers: { "content-type": "application/json" },
          }),
        };
      }
    }
  };
}
