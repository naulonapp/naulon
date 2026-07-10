/**
 * Tollgate — an x402 reverse proxy that sits in front of any publisher's
 * article routes.
 *
 *   Human  -> pass through to the origin, untouched, free.
 *   Agent, no payment      -> 402 with a PaymentRequirement (price + payees).
 *   Agent, valid payment   -> verify via Gateway, serve content, log the event.
 *   Agent, invalid payment -> 402 again with the error.
 *
 * Publisher-agnostic and single-tenant: each request resolves to one publisher's
 * config through a `PublisherResolver`. The gate talks to the protected site only
 * over HTTP (the publisher's `originUrl`) and resolves authors through its
 * `CreditsResolver`. Nothing about a specific product is baked in — the reference
 * resolver (`envPublisherResolver`) builds one publisher from env and serves it for
 * every request.
 *
 * `createApp(resolver)` is the embedding seam: a downstream service can front a
 * different publisher by injecting its own resolver without forking this core.
 * `index.ts` (node) and `api/index.ts` (Vercel) import the default `app`
 * (= `createApp()`). Keeping the app free of any server boot is what lets every
 * entry import it without one of them starting a listener.
 */
import { randomUUID } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono } from "hono";
import type { Context } from "hono";
import { logger } from "hono/logger";
import {
  botAuthDirectoryBody,
  botAuthKeyFromSeed,
  BOT_AUTH_DIRECTORY_CONTENT_TYPE,
  BOT_AUTH_DIRECTORY_PATH,
  getConfig,
  signBotAuthDirectory,
  usdc,
  type ObservationVerdict,
  type PublisherResolver,
  type TollKind,
  type Usdc,
} from "@naulon/shared";
import {
  decide,
  LICENSE_HEADER,
  type DecideObs,
} from "./decide.ts";
import {
  buildX402Manifest,
  PAYMENT_LINK_HEADER,
  X402_MANIFEST_PATH,
} from "./discoverability.ts";
import { get as getEvent } from "./eventLog.ts";
import { licensing } from "./license.ts";
import { observe } from "./observationLog.ts";
import { quote } from "./pricing.ts";
import { rateLimit } from "./rateLimit.ts";
import { revocations } from "./revocation.ts";
import { settleAndAttribute } from "./settle.ts";
import { envPublisherResolver } from "./publisher.ts";

// Re-exported for downstream embedding: a host that injects its own resolver via
// `createApp` can run the settlement drain over a chosen scope (secret/origin) —
// the optional parameter the single-tenant default never needs. See settlementSink.
export { drainSettlements, type DrainScope } from "./settlementSink.ts";
// The deferred extra-leg drain (O5/O1): a downstream fleet runs this per-publisher to
// settle the buyer-authorized extra legs the gate verified-but-deferred on the request
// path. Scoped by `publisherId` for multi-tenant isolation. See pendingLegs / x402.
export { drainPendingLegs, type DrainLegScope, type DrainLegResult } from "./x402.ts";
// The runtime-agnostic decision surface (app.ts is the package's public entry).
// `@naulon/tollgate/enforce`'s in-app middleware reaches the SAME verdict from a
// web Request; the private control plane consumes the settle primitives + the
// shared settlement tail (`settleAndAttribute`) for its hosted /verify.
export { decide, LICENSE_HEADER } from "./decide.ts";
export type { Decision, DecideInput, DecideObs } from "./decide.ts";
export { settleAndAttribute, type SettleResult, type SettleArgs } from "./settle.ts";
// The gate's pricing — the hosted /quote prices a resource with the SAME resolver
// the gate uses (custody-free: a Quote carries payTo addresses, never a key).
export { quote as resolveQuote } from "./pricing.ts";
export type { Quote } from "./pricing.ts";
export {
  verifyAndSettle,
  build402,
  PAYMENT_SIGNATURE_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  type PaymentRequirements,
  type SettlementLegReq,
  type VerifyResult,
} from "./x402.ts";
export type { TollKind } from "@naulon/shared";
import { PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER } from "./x402.ts";

// Global license POLICY (online check) + settlement network coordinates are
// gate-operator settings, read where they're used (here for /licenses + the
// bot-auth key; in settle.ts for the mint). Only per-publisher facts live on the
// resolved PublisherConfig.
const cfg = getConfig();

/**
 * Headers we never forward upstream. Hop-by-hop headers are connection-scoped
 * (RFC 7230 §6.1) and meaningless to the origin; the naulon/x402 headers are our
 * internal protocol; the forwarding headers we re-derive ourselves so a client
 * can't spoof its origin IP/host to the backend.
 */
const STRIP_HEADERS = new Set([
  // hop-by-hop
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // our internal protocol
  "payment-signature",
  "payment-required",
  "payment-response",
  "x-naulon-agent",
  "x-naulon-kind",
  "x-naulon-verdict",
  "x-naulon-license",
  "x-naulon-proof",
  // fleet→origin auth: gate-injected only (see proxyToOrigin), never smuggled inbound
  "x-naulon-origin-auth",
  // gate-controlled forwarding facts (set below, never trusted from the client)
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
]);

/**
 * Build the header set to send upstream: the client's headers minus everything
 * in STRIP_HEADERS, plus gate-controlled forwarding facts and the origin's Host.
 */
function forwardHeaders(req: Request, clientIp: string, originHost: string): Headers {
  const out = new Headers();
  for (const [k, v] of req.headers) {
    if (!STRIP_HEADERS.has(k.toLowerCase())) out.set(k, v);
  }
  const proto = new URL(req.url).protocol.replace(":", "");
  out.set("x-forwarded-for", clientIp);
  out.set("x-forwarded-proto", proto);
  out.set("x-forwarded-host", req.headers.get("host") ?? originHost);
  out.set("host", originHost); // origin may vhost on Host
  return out;
}

/**
 * X-Naulon-Verdict values can embed config-derived text (block/charge/allow
 * fragments, classifier reasons that quote them). Fleet-written configs are
 * control-char-rejected at the write path, but a self-hosted, hand-written config
 * is not — and a CR/LF smuggled into a header value is a response-splitting
 * primitive (or, in runtimes that validate header values, an exception that turns
 * a served request into a 500). Strip C0 controls + DEL at the one place the text
 * meets the wire. Exported for direct testing — a live request can't smuggle
 * CR/LF through header parsing, so the guard is only observable as a unit.
 */
export function headerSafe(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    out += c < 32 || c === 127 ? " " : ch;
  }
  return out;
}

/**
 * Cache discipline for gateable-route decisions. Every response on a gateable
 * route is User-Agent-dependent — the same URL yields a human 200, an agent 402,
 * or a blocked 403 — so a shared cache keying on URL alone could serve a human's
 * 200 to an agent (a free read) or an agent's 402/403 to a human (a paywall on
 * the open web, the exact failure the classifier is biased against).
 * `Vary: User-Agent` partitions any compliant cache; it is MERGED into an
 * origin-set Vary, never clobbering one. Money-bearing states (402 quotes carry
 * a fresh validity window, 403 blocks, licensed rereads, paid content) also get
 * `Cache-Control: no-store` — they are per-request artifacts, not documents. The
 * human free read keeps the origin's own Cache-Control: page cacheability
 * belongs to the publisher, and Vary alone keeps agents out of that cache entry.
 * Passthrough routes (suspended, non-article, unknown-article) are untouched —
 * they serve the same bytes to every caller.
 */
function stampGateCacheHeaders(res: Response, opts: { noStore: boolean }): Response {
  const vary = res.headers.get("vary");
  const hasUa =
    vary
      ?.split(",")
      .some((v) => v.trim() === "*" || v.trim().toLowerCase() === "user-agent") ?? false;
  if (!hasUa) res.headers.set("Vary", vary ? `${vary}, User-Agent` : "User-Agent");
  if (opts.noStore) res.headers.set("Cache-Control", "no-store");
  return res;
}

/**
 * The outcome of one upstream proxy fetch — status + an optional mitigation
 * marker (the first present of `x-vercel-mitigated` / `cf-mitigated`). Purely
 * advisory telemetry: the gate itself does nothing with it beyond firing
 * `onUpstreamOutcome`. See `createApp`'s options.
 */
export interface UpstreamOutcome {
  status: number;
  marker?: string;
}

/**
 * Response headers a fronting edge (Vercel, Cloudflare) sets when it mitigated
 * a request (rate-limited, challenged) rather than passing it through cleanly.
 * Checked in order; the first present header's NAME (not value) is the marker —
 * a downstream host cares that mitigation happened, not the edge-specific detail.
 */
const MITIGATION_MARKERS = ["x-vercel-mitigated", "cf-mitigated"] as const;

/** Proxy a request to the publisher's origin and return its response verbatim. */
async function proxyToOrigin(
  req: Request,
  path: string,
  clientIp: string,
  originUrl: string,
  originAuthSecret: string | undefined,
  publisherId: string,
  onUpstreamOutcome: ((publisherId: string, outcome: UpstreamOutcome) => void) | undefined,
): Promise<Response> {
  const origin = new URL(originUrl);
  const target = new URL(path, originUrl);
  // `path` is the raw request target (pathname+search). A request line beginning
  // `//host`, `/\host`, or `///host` is parsed protocol-relative by `new URL()`
  // and SWAPS the authority — turning the gate into an unauthenticated open proxy
  // / SSRF (e.g. `//169.254.169.254/…` reaches cloud metadata, `//evil.com/…` is
  // laundered through the gate). Pin the resolved target to the publisher's own
  // origin; anything else is a hostile/malformed target, not a real route → 400,
  // fetch nothing. This is the one choke point every proxied path flows through.
  if (target.origin !== origin.origin) {
    return new Response("Bad request.", { status: 400 });
  }
  const outHeaders = forwardHeaders(req, clientIp, new URL(originUrl).host);
  // Authenticated origin pull: present the per-tenant secret so an origin behind its
  // own bot/rate edge recognizes fleet traffic. https only — never leak a bearer over
  // cleartext. The header was stripped from the inbound request (STRIP_HEADERS), so
  // this is the only place it can be set: a client can't spoof it.
  if (originAuthSecret && origin.protocol === "https:") outHeaders.set("x-naulon-origin-auth", originAuthSecret);
  const upstream = await fetch(target, {
    method: req.method,
    headers: outHeaders,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer(),
    redirect: "manual",
  });
  if (onUpstreamOutcome) {
    const marker = MITIGATION_MARKERS.find((h) => upstream.headers.has(h));
    // Never let a telemetry callback throw into the proxy path — it's advisory
    // only, and a bug in a downstream host's handler must not turn a served
    // response into a 500.
    try {
      onUpstreamOutcome(publisherId, { status: upstream.status, marker });
    } catch {
      /* advisory only */
    }
  }
  // Clone into a fresh, mutable Headers (fetch's are immutable once attached to
  // a Response) and drop encoding/length — fetch already decoded the body.
  const headers = new Headers(upstream.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(upstream.body, { status: upstream.status, headers });
}


/**
 * No publisher answers this Host. The reference resolver never gets here (it
 * answers every host); an injected resolver returns undefined for a host it
 * doesn't recognize. Fail closed: refuse with a generic 502 and leak nothing about
 * which hosts ARE served. Don't proxy a request we can't attribute — a misrouted
 * read would settle to the wrong author or to no one. A resolver that recognizes
 * more hosts can return a branded page or a redirect instead of this default.
 */
function handleUnknownHost(c: Context, _host: string): Response {
  return c.text("This host is not served by the naulon gate.", 502);
}

/**
 * Build the tollgate Hono app over a publisher resolver. This core is
 * single-tenant: the default `envPublisherResolver` serves one publisher (from env)
 * for every request, which is what the standalone gate and both entrypoints
 * (`index.ts`, `api/index.ts`) run. `createApp` accepts a resolver only as a clean
 * embedding seam — a downstream service can front a different publisher by
 * injecting its own resolver, without forking this core. Operating many publishers
 * from one gate (onboarding, isolation, per-publisher drains) is out of scope here.
 */
export interface CreateAppOptions {
  /**
   * Optional telemetry seam: fired after every upstream proxy fetch with the
   * resolved publisher id + `UpstreamOutcome`. The gate does nothing with this
   * itself — it's for a downstream host (e.g. a multi-tenant control plane) to
   * observe throttle/mitigation signals per publisher. Never throws into the
   * proxy path (wrapped in try/catch at the call site). Omitting it is
   * byte-identical to before this option existed.
   */
  onUpstreamOutcome?: (publisherId: string, outcome: UpstreamOutcome) => void;
}

export function createApp(
  resolver: PublisherResolver = envPublisherResolver(),
  opts?: CreateAppOptions,
): Hono {
  const onUpstreamOutcome = opts?.onUpstreamOutcome;
  const app = new Hono();
  app.use("*", logger());
  app.use("*", rateLimit());

  // Fail-open error boundary. Any unhandled throw on a route — a down origin, a
  // resolver/store blip, an unexpected bug — must never reach a caller as a raw
  // 500 with a stack. Humans read free; a naulon-side fault must not turn a free
  // read into an error page. Return a branded, body-stable 503 (transient, safe to
  // retry) that leaks nothing about what failed. This is only for *unexpected*
  // faults: the toll's deliberate refusals (unknown/suspended host) fail closed on
  // their own paths and never reach here.
  app.onError((err, c) => {
    console.error(`[tollgate] unhandled error on ${c.req.method} ${c.req.path}:`, err);
    return c.text("naulon is temporarily unavailable — please retry shortly.", 503, {
      "retry-after": "30",
    });
  });

  app.get("/healthz", (c) => c.json({ ok: true, service: "tollgate" }));

  // Public key set for offline CLT verification. Registered BEFORE the catch-all
  // so it's served by the gate, never proxied. Empty when disabled.
  app.get("/.well-known/naulon-jwks.json", (c) => c.json(licensing ? licensing.jwks : { keys: [] }));

  // Edge-identity probe: a host-independent 200 that ONLY a naulon gate serves. It lets a
  // caller confirm a custom domain actually ROUTES through the gate — not merely that its
  // owner proved control. This matters because routing can't be verified by DNS inspection
  // when the gate is fronted by a SaaS edge (e.g. Cloudflare for SaaS): an apex points via a
  // flattened CNAME onto the edge's SHARED anycast IPs, indistinguishable from the customer
  // proxying through their own account. Only an actual request that returns this naulon marker
  // is definitive. Resolver-free and registered BEFORE the catch-all (like /healthz): reaching
  // this route means traffic reached THIS gate. `host` echoes the Host the gate saw, so the
  // caller can confirm it probed the intended domain (and not, say, the bare gate).
  app.get("/.well-known/naulon-edge", (c) => {
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    return c.json({ gate: "naulon", host });
  });

  // Web Bot Auth key directory — OUR signing identity (WBA slice 3). When the
  // operator configures a signing key, any Web-Bot-Auth verifier (including
  // this gate's own botAuth.ts — the dogfood loop) can resolve the wayfarer's
  // Signature-Agent to these keys. The response is itself signed
  // (tag="http-message-signatures-directory"), the spec's binding of the keys
  // to the serving host. Gate-level, not per-publisher: this is the OPERATOR's
  // identity, so no Host resolution — an unknown host still serves it.
  // Key materialized at boot: a malformed seed fails loud here, never at
  // request time (config discipline). /.well-known/* is never tolled/proxied.
  const botAuthKey = cfg.BOT_AUTH_SIGNING_KEY ? botAuthKeyFromSeed(cfg.BOT_AUTH_SIGNING_KEY) : null;
  app.get(BOT_AUTH_DIRECTORY_PATH, (c) => {
    if (!botAuthKey) return c.json({ error: "this gate publishes no key directory" }, 404);
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    const sig = signBotAuthDirectory(botAuthKey, host);
    return c.body(botAuthDirectoryBody(botAuthKey), 200, {
      "content-type": BOT_AUTH_DIRECTORY_CONTENT_TYPE,
      "signature-input": sig["signature-input"],
      signature: sig.signature,
      // Verifiers cache directories themselves (this gate: 6h positive TTL);
      // mirror that so intermediary caches agree with verifier behavior.
      "cache-control": "public, max-age=21600",
    });
  });

  // Self-describing toll: a machine-readable manifest of this publisher's terms
  // (prefixes, price, Arc/USDC, license). Lets an agent discover the gate instead
  // of being told the endpoint out of band. Resolved per Host like the gate; an
  // unknown host gets 404 (no toll here) rather than leaking another's config.
  app.get(X402_MANIFEST_PATH, async (c) => {
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    const publisher = await resolver.resolve(host);
    if (!publisher) return c.json({ error: "no toll for this host" }, 404);
    return c.json(buildX402Manifest(publisher));
  });

  // Online verify tier: confirm a license's event is real and (optionally) not
  // revoked. Primary-key lookup via EventSink.get — never readAll(). Rate-limited
  // by the global middleware. Registered BEFORE the catch-all.
  app.get("/licenses/:jti", async (c) => {
    const jti = c.req.param("jti");
    // Resolve the publisher from Host, same as the toll and manifest paths, and
    // scope the lookup to it. Without this the route is a global jti→event read:
    // a multi-tenant embedder fronting many publishers from one gate would let a
    // holder of publisher B's jti read B's event (payees, amount, settlementRef)
    // via publisher A's host. Unknown host → 404, leaking nothing (fail-closed,
    // matches the manifest route).
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    const publisher = await resolver.resolve(host);
    if (!publisher) return c.json({ jti, found: false }, 404);

    const event = await getEvent(jti);
    // Scope by attributed publisher. A stamped event whose publisherId doesn't
    // match the resolved publisher is invisible here — the SAME 404 as not-found,
    // so the route never confirms a jti exists under another tenant. Single-tenant
    // is a no-op: events stamp "default" and envPublisherResolver resolves
    // "default". Legacy rows predating publisherId stamping (undefined) stay
    // readable so existing single-tenant ledgers keep verifying; a multi-tenant
    // resolver never returns "default", so stamped events isolate cleanly.
    if (!event || (event.publisherId !== undefined && event.publisherId !== publisher.id)) {
      return c.json({ jti, found: false }, 404);
    }
    const revoked = cfg.LICENSE_ONLINE_CHECK ? await revocations.isRevoked(jti) : false;
    return c.json({ jti, found: true, revoked, event });
  });

  // Everything else flows through the gate.
  app.all("*", async (c) => {
    const path = new URL(c.req.url).pathname + new URL(c.req.url).search;
    // getConnInfo needs a node socket; under a serverless adapter (Vercel) it
    // throws — fall back rather than 500 the request.
    let clientIp = "unknown";
    try {
      clientIp = getConnInfo(c).remote.address ?? "unknown";
    } catch {
      /* serverless / no socket */
    }

    // Resolve the publisher this Host fronts. Every downstream decision (proxy
    // target, price, payees, license identity, settlement) reads from here.
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    const publisher = await resolver.resolve(host);
    if (!publisher) return handleUnknownHost(c, host);

    // Suspended ≠ dead. A paused publisher (billing lapse upstream) serves its
    // origin straight through, free and untolled — suspension must never dark a
    // live site or turn its readers away. The gate just stops earning until it's
    // lifted. (Unknown host already failed closed above; this is a KNOWN host.)
    if (publisher.suspended) {
      const res = await proxyToOrigin(c.req.raw, path, clientIp, publisher.originUrl, publisher.originAuthSecret, publisher.id, onUpstreamOutcome);
      res.headers.set("X-Naulon-Verdict", "suspended (degraded passthrough)");
      return res;
    }

    // One decision path — the SAME verdict the `@naulon/sdk` in-app middleware
    // reaches from a web Request. `decide()` is side-effect-free: it classifies,
    // checks Bot-Auth + a presented license, prices, and (for a machine) builds the
    // 402 legs/header — but never observes, proxies, or settles. The gate owns
    // those effects here. `now` is computed ONCE and threaded through decide()'s
    // build402 AND the settle/event/mint tail, so the advertised validity window
    // and the settled payment share one timestamp.
    const now = Date.now();
    const d = await decide({
      raw: c.req.raw,
      host,
      path,
      publisher,
      now,
      quote,
      botAuthOpts: { allowInsecureHttp: cfg.BOT_AUTH_ALLOW_HTTP },
    });

    // Audit plane: one observation per gated-route decision, built from the facts
    // decide() carried back (telemetry only, never gates). Default sink off → no-op.
    // `at` is stamped per emit, exactly as before the extraction.
    const emitObs = (obs: DecideObs, v: ObservationVerdict, extra?: { kind?: TollKind; price?: Usdc }): void =>
      observe({
        id: randomUUID(),
        publisherId: publisher.id,
        host,
        slug: obs.slug,
        kind: extra?.kind,
        verdict: v,
        classifiedAs: obs.classifiedAs,
        classifyReason: obs.classifyReason,
        agentUa: obs.agentUa,
        verified: obs.verified,
        verifiedAgent: obs.verifiedAgent,
        sigInvalid: obs.sigInvalid,
        price: extra?.price,
        at: Date.now(),
      });

    switch (d.kind) {
      // Non-article OR unknown-article: pure passthrough, no observation.
      case "passthrough":
        return proxyToOrigin(c.req.raw, path, clientIp, publisher.originUrl, publisher.originAuthSecret, publisher.id, onUpstreamOutcome);

      // Publisher-refused crawler: 403 before any content leaves.
      case "blocked": {
        emitObs(d.obs, "blocked");
        const res = c.text("This crawler is refused by the publisher.", 403);
        res.headers.set("X-Naulon-Verdict", headerSafe(`blocked ("${d.frag}")`));
        return stampGateCacheHeaders(res, { noStore: true });
      }

      // Humans read free, forever. Set the verdict on the proxied Response itself
      // (a fresh Response from proxyToOrigin doesn't inherit c.header()).
      case "free": {
        emitObs(d.obs, "served-free");
        const res = await proxyToOrigin(c.req.raw, path, clientIp, publisher.originUrl, publisher.originAuthSecret, publisher.id, onUpstreamOutcome);
        res.headers.set("X-Naulon-Verdict", headerSafe(d.verdict));
        return stampGateCacheHeaders(res, { noStore: false });
      }

      // A valid license scoped to this slug+kind re-reads free.
      case "reread": {
        emitObs(d.obs, "agent-reread", { kind: d.tollKind });
        const res = await proxyToOrigin(c.req.raw, path, clientIp, publisher.originUrl, publisher.originAuthSecret, publisher.id, onUpstreamOutcome);
        res.headers.set("X-Naulon-Verdict", "agent reread (license)");
        return stampGateCacheHeaders(res, { noStore: true });
      }

      // Machine, no payment: 402 with the requirement in the PAYMENT-REQUIRED
      // header. Link points an agent at the toll manifest (discoverability).
      case "payment-required":
        emitObs(d.obs, "denied", { kind: d.tollKind, price: usdc(d.quote.price) });
        return stampGateCacheHeaders(
          c.body(null, 402, {
            [PAYMENT_REQUIRED_HEADER]: d.header,
            Link: PAYMENT_LINK_HEADER,
            "X-Naulon-Verdict": headerSafe(`agent (${d.obs.classifyReason})`),
          }),
          { noStore: true },
        );

      // Machine WITH a payment: verify + settle (custody-free), then serve.
      case "payment-presented": {
        // The settlement tail — the exact same code path the hosted /verify runs.
        const settled = await settleAndAttribute({ payment: d.payment, legs: d.legs, quote: d.quote, publisher, now });
        if (!settled.ok) {
          emitObs(d.obs, "payment-failed", { kind: d.tollKind, price: usdc(d.quote.price) });
          return stampGateCacheHeaders(
            c.json({ error: settled.error }, 402, {
              [PAYMENT_REQUIRED_HEADER]: d.header,
              Link: PAYMENT_LINK_HEADER,
            }),
            { noStore: true },
          );
        }

        // Audit plane: the paid outcome on the same timeline as denials/free reads.
        emitObs(d.obs, "paid", { kind: d.quote.kind, price: usdc(d.quote.price) });

        const res = await proxyToOrigin(c.req.raw, path, clientIp, publisher.originUrl, publisher.originAuthSecret, publisher.id, onUpstreamOutcome);
        if (settled.responseHeader) res.headers.set(PAYMENT_RESPONSE_HEADER, settled.responseHeader);
        if (settled.licenseJws) res.headers.set(LICENSE_HEADER, settled.licenseJws);
        res.headers.set("X-Naulon-Verdict", headerSafe(`agent paid (${d.obs.classifyReason})`));
        return stampGateCacheHeaders(res, { noStore: true });
      }
    }
  });

  return app;
}

/**
 * The default, single-tenant app instance. The runtime entrypoints wrap this:
 * `index.ts` runs it under @hono/node-server, `api/index.ts` adapts it to a
 * Vercel function. A downstream embedder builds its own via `createApp(resolver)`.
 */
export const app = createApp();
