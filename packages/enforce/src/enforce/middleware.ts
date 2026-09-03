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
import { externalUrl, getConfig, type JwkSet } from "@naulon/shared";
import type { QuoteSource } from "./quote-source.ts";
import type { PublisherConfigSource, PublisherEnforcementConfig } from "./config-source.ts";
import type { DecideObs } from "../decide.ts";
import type { ObservationReport, ObservationReporter, ReportableVerdict } from "./observation-sink.ts";

export interface NaulonMiddlewareOptionsBase {
  /**
   * The site's toll config in `PublisherConfig` shape — `decide()` reads
   * `articlePrefixes` (or `gateScope`), `licenseIdentity`, `seoAllowlist`,
   * and `crawlerPolicy` from it.
   *
   * A LITERAL here is a second copy of state the control plane already owns, and it
   * cannot track a dashboard edit. Prefer `config` (below) and pass this only for a
   * self-hosted gate that has no control plane to ask. When both are given, the
   * control plane wins field by field and this is the cold-start floor.
   */
  publisher?: unknown;
  /**
   * Where the enforcement config comes from — `httpPublisherConfigSource(...)` for a
   * hosted tenant. Cached with stale-if-error, so this is not a per-request fetch.
   *
   * This is the difference between "the dashboard says charge OAI-SearchBot" and the
   * site actually charging it.
   */
  config?: PublisherConfigSource;
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
  /**
   * Audit plane: report each decision this runtime witnessed (`httpObservationSink`, or
   * your own function). Optional — omit it and the middleware behaves exactly as before.
   *
   * Only the four verdicts nobody else can see are reported: served-free, agent-reread,
   * denied, blocked. The money verdicts belong to the hosted `/verify`, which writes them
   * from the settle outcome — so a paid read shows up on the Audit page whether or not
   * this is wired, and no integration can report earnings it did not settle.
   *
   * Fire-and-forget: never awaited, so it cannot delay or fail a reader's response.
   */
  observe?: ObservationReporter;
}

/**
 * At least one source of publisher config is required, and the compiler enforces it:
 * a mount with neither can only ever pass every request through untolled, which is a
 * silently-disabled toll and exactly the class of failure this module exists to end.
 */
export type NaulonMiddlewareOptions = NaulonMiddlewareOptionsBase &
  ({ config: PublisherConfigSource } | { publisher: unknown });

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

/**
 * The classifier's read of the caller, in the shape both audit hand-offs use — the
 * `/observe` report and the `agent` block on the `/verify` body. One builder, because
 * two copies of "how identity is spelled on the wire" is how they drift apart.
 * Absent fields are omitted rather than sent as `null`: the receiver treats absence as
 * "not observed", which is true, while `null` reads as "observed to be nothing".
 */
function agentOf(obs: DecideObs): NonNullable<ObservationReport["agent"]> {
  return {
    ...(obs.agentUa !== undefined ? { ua: obs.agentUa } : {}),
    classifyReason: obs.classifyReason,
    ...(obs.verified !== undefined ? { verified: obs.verified } : {}),
    ...(obs.verifiedAgent !== undefined ? { verifiedAgent: obs.verifiedAgent } : {}),
    ...(obs.sigInvalid !== undefined ? { sigInvalid: obs.sigInvalid } : {}),
  };
}

/**
 * The config actually in force: the control plane's document over the local floor,
 * field by field.
 *
 * Remote wins because it is the copy a human can edit — the local object is a literal
 * in a deployed bundle, and a bundle is not a control plane. The merge is per FIELD
 * rather than all-or-nothing so a tenant that has set no `crawlerPolicy` still gets the
 * local one, instead of a partial document silently blanking it. `undefined` values are
 * stripped by the source for the same reason.
 *
 * Returns `undefined` when neither side supplied anything — the caller passes through.
 */
export function resolvePublisher(
  local: unknown,
  remote: PublisherEnforcementConfig | undefined,
): unknown {
  const hasLocal = typeof local === "object" && local !== null;
  const hasRemote = remote !== undefined && Object.keys(remote).length > 0;
  if (!hasLocal && !hasRemote) return undefined;
  if (!hasRemote) return local;
  return { ...(hasLocal ? (local as object) : {}), ...remote };
}

export function naulonMiddleware(
  opts: NaulonMiddlewareOptions,
): (req: Request) => Promise<MiddlewareResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const clock = opts.now ?? Date.now;
  const cfg = getConfig();

  // API-mode license verification: a cached fetcher for the minting gate's JWKS. Built
  // once; each request reuses the cached keys until the TTL lapses, then refetches. On a
  // refetch failure the last-good JWKS is kept (stale-if-error) so a gate hiccup never
  // turns a paid re-read into a 402. Absent option ⇒ resolver is undefined (proxy mode).
  const resolveVerification = (() => {
    const lv = opts.licenseVerification;
    if (!lv) return undefined;
    const jwksUrl = lv.jwksUrl ?? `${new URL(opts.verifyUrl).origin}/.well-known/naulon-jwks.json`;
    const ttl = lv.cacheTtlMs ?? 600_000;
    let cached: JwkSet | undefined;
    let fetchedAt = 0;
    // `issuer` is resolved PER REQUEST from the config actually in force, not read once
    // from a literal at mount time. Pinning iss/aud to a hand-written constant is how a
    // licence stops verifying the day the control plane restyles what it stamps — and the
    // symptom is a paid reader being charged twice, which nobody reports as a bug.
    return async (issuer: string | undefined): Promise<LicenseVerification | undefined> => {
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

  // Build one report from the facts `decide()` already carried back. `DecideObs` exists
  // for exactly this (the gate builds its observation from the same fields) — the in-app
  // path simply never used it, which is why an in-app site's audit page was empty.
  const report = (
    obs: DecideObs,
    verdict: ReportableVerdict,
    resource: string,
    extra?: { kind?: "read" | "citation"; priceUsdc?: number },
  ): void => {
    if (!opts.observe) return;
    const r: ObservationReport = {
      resource,
      slug: obs.slug,
      verdict,
      classifiedAs: obs.classifiedAs,
      at: clock(),
      agent: agentOf(obs),
    };
    if (extra?.kind !== undefined) r.kind = extra.kind;
    // Whole USDC → integer micro-USDC on the wire. Rounded, never floored: the figure is
    // "what this request would have paid", and a sub-micro price is a real toll.
    if (extra?.priceUsdc !== undefined) r.priceMicro = Math.round(extra.priceUsdc * 1_000_000);
    opts.observe(r);
  };

  return async (req: Request): Promise<MiddlewareResult> => {
    const url = new URL(req.url);
    // ONE resource identifier per request, computed once. It reaches four different
    // consumers — the price lookup, every observation, the settle call to the cloud,
    // and (via decide → build402) the signed 402 — and they must agree byte for byte:
    // the cloud joins the settle's `resource` to the observation it already wrote.
    // `req.url` was used at each site independently, which meant a TLS-terminating
    // proxy in front made all four say `http://` for an `https://` read.
    const resource = externalUrl(req, {
      trustProxy: cfg.TRUST_PROXY,
      hops: cfg.TRUST_PROXY_HOPS,
    });
    // Only resolve the gate JWKS when this request actually presents a license — a
    // human read or a first-time agent 402 carries none, so the hot path never fetches.
    // The enforcement config in force for THIS request. Cached per host with
    // stale-if-error inside the source, so a warm hit costs a map lookup.
    const remote = opts.config ? (await opts.config.load({ resource }))?.enforcement : undefined;
    const publisher = resolvePublisher(opts.publisher, remote);
    if (!publisher) {
      // Neither a control-plane document nor a local floor: nothing is in scope, so there
      // is nothing to decide. Pass rather than throw — a lookup failure on our side must
      // never 500 the publisher's site. The source has already reported it, loudly.
      return { response: null };
    }
    const licenseVerification =
      resolveVerification && req.headers.get(LICENSE_HEADER)
        ? await resolveVerification((publisher as { licenseIdentity?: string }).licenseIdentity)
        : undefined;
    const d = await decide({
      raw: req,
      host: url.host,
      path: url.pathname + url.search,
      publisher: publisher as never,
      now: clock(),
      quote: (publisher, slug, kind, path) => opts.quote.quote(publisher, slug, kind, { resource, path }),
      ...(licenseVerification ? { licenseVerification } : {}),
    });

    switch (d.kind) {
      // Not a gated route at all (non-article / unknown article) — the gate emits no
      // observation here either, and inventing one would put every asset request into
      // the publisher's traffic figures.
      case "passthrough":
        return { response: null };

      // Human, or a free re-read on a license already paid for: the app renders locally.
      case "free":
        report(d.obs, "served-free", resource);
        return { response: null };

      case "reread":
        report(d.obs, "agent-reread", resource, { kind: d.tollKind });
        return { response: null };

      case "blocked":
        report(d.obs, "blocked", resource);
        return { response: new Response("This crawler is refused by the publisher.", { status: 403 }) };

      case "payment-required":
        report(d.obs, "denied", resource, { kind: d.tollKind, priceUsdc: d.quote.price });
        return {
          response: new Response(null, {
            status: 402,
            headers: { [PAYMENT_REQUIRED_HEADER]: d.header, Link: PAYMENT_LINK_HEADER },
          }),
        };

      case "payment-presented": {
        // No `report(...)` on this branch, deliberately: the hosted /verify writes the
        // `paid` / `payment-failed` observation itself, from the settle outcome it owns.
        // Reporting it here too would double-count, and a client that can assert "paid"
        // is a client that can inflate its own earnings.
        //
        // The one uncovered case is /verify being UNREACHABLE below: no settle happened,
        // so the cloud writes nothing, and this runtime has no verdict it is allowed to
        // report. That request is missing from the audit page by design — it is an
        // outage symptom, which the enforcement-status plane is where you read.
        //
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
            // `agent` is telemetry, not authorization: it lets the cloud attribute the
            // `paid` observation it writes from this settle to the agent that actually
            // paid, instead of "(unknown agent)". An older control plane ignores it.
            body: JSON.stringify({
              payment: d.payment,
              legs: d.legs,
              quote: d.quote,
              resource,
              agent: agentOf(d.obs),
            }),
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
