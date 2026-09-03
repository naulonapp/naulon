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
  activeNetwork,
  botAuthDirectoryBody,
  botAuthKeyFromSeed,
  BOT_AUTH_DIRECTORY_CONTENT_TYPE,
  BOT_AUTH_DIRECTORY_PATH,
  externalSchemeOf,
  getConfig,
  getNetwork,
  mintCitationRecord,
  networkForEvent,
  signBotAuth,
  signBotAuthDirectory,
  type BotAuthKey,
  usdc,
  type ObservationVerdict,
  type PaymentFailureReason,
  classifyPaymentFailure,
  type PublisherConfig,
  type PublisherResolver,
  type TollKind,
  type Usdc,
} from "@naulon/shared";
import {
  decide,
  LICENSE_HEADER,
  type DecideObs,
  buildX402Manifest,
  PAYMENT_LINK_HEADER,
  X402_MANIFEST_PATH,
  licensing,
  quote,
  revocations,
} from "@naulon/enforce";
import { get as getEvent } from "./eventLog.ts";
import { observe } from "./observationLog.ts";
import { rateLimit } from "./rateLimit.ts";
import { settleAndAttribute } from "./settle.ts";
import { envPublisherResolver } from "./publisher.ts";

// The origin-mirror seams (`drainSettlements`/`DrainScope` and the whole
// `settlementDelivery` delivery-state surface) were exported here until WH-1 P3. They are gone:
// a settled toll is reported once, as a webhook (`webhookSink.ts`), and the delivery state that
// needs an operator's attention lives in the unified webhook delivery store — which a downstream
// fleet already reads and revives per delivery. Two engines for one fact is what this removes.
// The deferred extra-leg drain (O5/O1): a downstream fleet runs this per-publisher to
// settle the buyer-authorized extra legs the gate verified-but-deferred on the request
// path. Scoped by `publisherId` for multi-tenant isolation. See pendingLegs / x402.
export { drainPendingLegs, type DrainLegScope, type DrainLegResult } from "./x402.ts";
// The runtime-agnostic decision surface (app.ts is the package's public entry).
// `@naulon/enforce`'s in-app middleware (re-exported as `@naulon/sdk/enforce`)
// reaches the SAME verdict from a web Request; the private control plane consumes
// the settle primitives + the
// shared settlement tail (`settleAndAttribute`) for its hosted /verify.
export { decide, LICENSE_HEADER } from "@naulon/enforce";
export type { Decision, DecideInput, DecideObs } from "@naulon/enforce";
export { settleAndAttribute, type SettleResult, type SettleArgs } from "./settle.ts";
// The gate's pricing — the hosted /quote prices a resource with the SAME resolver
// the gate uses (custody-free: a Quote carries payTo addresses, never a key).
export { quote as resolveQuote } from "@naulon/enforce";
export type { Quote } from "@naulon/enforce";
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
// Cloudflare's pay-per-crawl vocabulary, emitted alongside the x402 headers. Purely
// advertisement: a crawler fluent in `crawler-price` learns what this costs without
// decoding the base64 x402 payload, and still settles over x402/USDC. Nothing here
// charges anyone or changes who is charged.
import {
  CRAWLER_CHARGED_HEADER,
  CRAWLER_EXACT_PRICE_HEADER,
  CRAWLER_MAX_PRICE_HEADER,
  CRAWLER_PRICE_HEADER,
  crawlerBudgetVerdict,
  declaredCrawlerBudget,
  formatCrawlerPrice,
  settledChargedMicro,
  totalChargedMicro,
} from "@naulon/enforce";

// Global license POLICY (online check) + settlement network coordinates are
// gate-operator settings, read where they're used (here for /licenses + the
// bot-auth key; in settle.ts for the mint). Only per-publisher facts live on the
// resolved PublisherConfig.
const cfg = getConfig();

// When this gate process booted. The credits resolver reads its fixture file once
// at boot (fixtureResolverFromFile), so the operator dashboard compares this to the
// credits.json mtime to tell whether an edit is live yet or needs a gate restart.
const BOOT_AT = new Date().toISOString();

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

/** Statuses the Fetch spec forbids a body on — `new Response(bytes, { status })` THROWS for these,
 *  so the paid path must not try to re-wrap one. There are no bytes at risk on any of them either,
 *  which is why skipping them costs the guarantee below nothing. */
const NULL_BODY_STATUS = new Set([204, 205, 304]);

/** Connection and framing headers that must NOT survive re-wrapping a buffered body. They describe
 *  the ORIGIN's connection (RFC 7230 §6.1) and its chunked framing, and undici really does expose
 *  them on a fetch Response. Replaying `transfer-encoding: chunked` over a fixed in-memory buffer
 *  declares a framing the response no longer has: the server emits a self-contradicting message and
 *  the buyer's fetch dies mid-read with a bare "fetch failed". `content-length` goes too, so the
 *  runtime recomputes it for the bytes actually being sent. (Measured 2026-08-11 — an in-process
 *  `app.request()` never crosses a socket, so no unit test can see this; only a real listener can.) */
const CONNECTION_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

/** Ceiling on a prefetched body. Orders of magnitude above any article; a response past it is not
 *  something a citation toll should hold in memory, and refusing to SELL it beats settling against
 *  bytes we might never finish receiving. */
const MAX_PREFETCH_BYTES = 8 * 1024 * 1024;
/** Deadline for having the WHOLE body in hand. An origin that cannot finish inside this has not
 *  delivered, and the buyer must not be charged for waiting on it. It also bounds the gate: without
 *  it, one origin that opens a body and never closes it would pin a paid request open forever. */
const PREFETCH_BODY_TIMEOUT_MS = 15_000;

/**
 * Drain an origin response into memory, bounded by {@link MAX_PREFETCH_BYTES} and
 * {@link PREFETCH_BODY_TIMEOUT_MS}, and hand back a replayable Response over those exact bytes.
 *
 * Returns `null` when the body could not be fully read — too large, too slow, or the socket died
 * mid-stream. The paid path treats that identically to an origin that could not serve: refused, and
 * never charged. Truncation is never reported as success, which is why the deadline sets a flag
 * instead of trusting the cancelled read: `reader.cancel()` makes a pending `read()` resolve
 * `{done: true}`, and believing that would return a HALF body as if it were whole.
 */
async function materializeBody(res: Response): Promise<Response | null> {
  if (!res.body || NULL_BODY_STATUS.has(res.status)) return res;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, PREFETCH_BODY_TIMEOUT_MS);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_PREFETCH_BYTES) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null; // socket reset mid-body, or the deadline cancelled us
  } finally {
    clearTimeout(deadline);
  }
  if (timedOut) return null;
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const headers = new Headers();
  for (const [key, value] of res.headers) {
    if (!CONNECTION_HEADERS.has(key.toLowerCase())) headers.append(key, value);
  }
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Build the header set to send upstream: the client's headers minus everything
 * in STRIP_HEADERS, plus gate-controlled forwarding facts and the origin's Host.
 */
function forwardHeaders(req: Request, clientIp: string, originHost: string): Headers {
  const out = new Headers();
  for (const [k, v] of req.headers) {
    if (!STRIP_HEADERS.has(k.toLowerCase())) out.set(k, v);
  }
  // The scheme the BUYER used, not the one this socket saw. The inbound header is
  // stripped above as untrusted, then re-derived here — but "what the socket saw" is
  // plain HTTP behind a TLS-terminating edge, so the origin was being told `http` for
  // an `https` read. An origin that builds absolute URLs (canonical tags, redirects,
  // its own credits links) from this header would build them wrong.
  const proto = externalSchemeOf(req, { trustProxy: cfg.TRUST_PROXY, hops: cfg.TRUST_PROXY_HOPS });
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
 *
 * It also strips everything ABOVE ASCII, which the control-char version did not, and that gap was
 * live: a header value is a ByteString, so `Headers.set` THROWS on any code point > 255 ("cannot
 * convert argument to a ByteString"). The throw lands in the fail-open error boundary and the
 * request a publisher was serving becomes a 503 — the exact "turns a served request into a 500"
 * outcome this function's own docstring exists to prevent, entered through a different door. Caught
 * 2026-08-04 by an em-dash in a new verdict string, which 503'd every response on that branch;
 * `d.frag` (a publisher-written crawler-policy fragment) reaches here the same way and is not
 * control-char-rejected on a self-hosted config.
 *
 * 128–255 are stripped rather than passed: they are legal in a ByteString but their meaning is
 * charset-dependent on the wire, and a verdict header is diagnostic text nobody should be decoding.
 * ASCII-or-space keeps it unambiguous.
 */
export function headerSafe(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 32 || c >= 127 ? " " : ch;
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

/** The gate's outbound Web Bot Auth identity for the origin pull: the operator's
 *  boot-materialized signing key paired with the Signature-Agent it advertises.
 *  Gate-global (the OPERATOR's identity), not per-publisher. See proxyToOrigin. */
type ProxySigningIdentity = { key: BotAuthKey; agent: string };

/** Proxy a request to the publisher's origin and return its response verbatim. */
async function proxyToOrigin(
  req: Request,
  path: string,
  clientIp: string,
  originUrl: string,
  originAuthSecret: string | undefined,
  publisherId: string,
  onUpstreamOutcome: ((publisherId: string, outcome: UpstreamOutcome) => void) | undefined,
  proxySigning: ProxySigningIdentity | null,
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
  // Web Bot Auth (RFC 9421): additionally sign the pull as our operator identity when
  // configured, so a Cloudflare/Vercel-verified publisher recognizes fleet traffic
  // without a pasted bypass rule. https only (mirrors the secret guard — never sign
  // over cleartext); signed per call for a fresh ~1-minute validity window. The secret
  // header still rides alongside, so nothing depends solely on WBA mid-migration.
  // Unconfigured (proxySigning null) ⇒ byte-identical, unsigned — the standing bar.
  if (proxySigning && origin.protocol === "https:") {
    const signed = signBotAuth({ key: proxySigning.key, authority: origin.host, tag: "web-bot-auth", agent: proxySigning.agent });
    for (const [k, v] of Object.entries(signed)) outHeaders.set(k, v);
  }
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

  /**
   * Optional identity seam: resolve the publisher that OWNS a host the resolver does not ROUTE.
   *
   * `PublisherResolver.resolve` answers "the publisher this host routes to", which is the only
   * question the gate needs to serve a toll. But a host can be served by the publisher's own runtime
   * (the `@naulon/enforce` SDK in front of their app) instead of being proxied here — such a host is
   * legitimately absent from the resolver's routing set, so `resolve` returns undefined for it.
   * A downstream control plane that knows those publishers by some other proof of ownership supplies
   * this; the single-tenant default has no such distinction and omits it, which is byte-identical to
   * before the option existed.
   *
   * Consumed ONLY by `GET /licenses/:jti`, which asks an identity question rather than a routing one
   * and was answering "no such licence" for every self-served publisher. It must not be given a
   * function that prices, routes or settles: a host nothing routes must not become routable by being
   * verifiable. It does not widen what may be READ either — the route still refuses an event whose
   * `publisherId` is not the resolved publisher's.
   */
  resolveInAppConfig?: (host: string) => Promise<PublisherConfig | undefined>;
}

export function createApp(
  resolver: PublisherResolver = envPublisherResolver(),
  opts?: CreateAppOptions,
): Hono {
  const onUpstreamOutcome = opts?.onUpstreamOutcome;
  const resolveInAppConfig = opts?.resolveInAppConfig;
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

  app.get("/healthz", (c) => c.json({ ok: true, service: "tollgate", startedAt: BOOT_AT }));

  // Public key set for offline CLT verification. Registered BEFORE the catch-all
  // so it's served by the gate, never proxied. Empty when disabled.
  /**
   * The public key set, and it must be readable FROM A BROWSER.
   *
   * A Citation License is worth what it is because a stranger can check it against these
   * keys without asking us. That story is Node-only without CORS: the same-origin policy
   * blocks every browser-based verifier — including naulon's own public verify page — at
   * the fetch, before any signature is checked.
   *
   * `*` is the correct value, not a lax one. A key set is world-readable by definition,
   * and anything narrower would be us deciding which origins are allowed to check our
   * signatures, which is the opposite of the property being sold. It is scoped to THIS
   * route: no tolled path becomes cross-origin readable, which `jwks-cors.test.ts` pins.
   */
  const JWKS_CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "cache-control": "public, max-age=3600",
  } as const;
  app.get("/.well-known/naulon-jwks.json", (c) =>
    c.json(licensing ? licensing.jwks : { keys: [] }, 200, { ...JWKS_CORS }),
  );
  app.options("/.well-known/naulon-jwks.json", (c) => c.body(null, 204, { ...JWKS_CORS }));

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
  // The gate's outbound origin-pull identity: the SAME boot-materialized operator key
  // the directory publishes (never re-derived per request), paired with the advertised
  // Signature-Agent. null unless both are configured ⇒ the pull stays unsigned. Consumed
  // by every proxyToOrigin call below.
  const proxySigning = botAuthKey && cfg.BOT_AUTH_SIGNATURE_AGENT ? { key: botAuthKey, agent: cfg.BOT_AUTH_SIGNATURE_AGENT } : null;
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
    // Pinned to the TENANT's chain, not the fleet default. The 402 this host emits already
    // resolves per tenant (`quote.network` → `buildRequirements`); the manifest did not, so a
    // publisher settling on another chain published terms naming ours. An agent that reads the
    // manifest, prepares a payment on that chain and then meets a 402 for a different one reads
    // it as our bug — correctly.
    return c.json(buildX402Manifest(publisher, publisher.settlementNetwork ? getNetwork(publisher.settlementNetwork) : activeNetwork()));
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
    // ROUTING first, then OWNERSHIP. `resolve` answers "the publisher this host routes to" and is
    // the common case; `resolveOwner` (optional, and absent on the single-tenant default) answers
    // "the publisher that owns this host", which is the only question that has an answer for a host
    // served by the publisher's OWN runtime rather than proxied by this gate. Such a host is
    // legitimately absent from the routing set, so verification of its licences used to 404 every
    // time — measured against a live multi-tenant deploy on 2026-09-02, where every settlement of
    // every self-served publisher reported "not on the ledger" while sitting in the ledger.
    //
    // This widens WHO CAN BE RESOLVED, never what they may read: the publisherId check below is
    // unchanged, so an event attributed to another publisher is still the same fail-closed 404.
    const publisher = (await resolver.resolve(host)) ?? (await resolveInAppConfig?.(host));
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

  /**
   * The CITATION RECORD for a settled toll: permanent, third-party verifiable, and it
   * grants nothing.
   *
   * The Citation License a payment mints is an ACCESS token — `LICENSE_TTL_SECONDS`
   * defaults to 600s and is capped at 3600 because it is an unrevocable bearer credential
   * on the offline tier, so its expiry is the only kill switch it has. That is the wrong
   * object for a citation: a researcher cites a source and a reader checks it months
   * later, long after any access window closed. This route mints the other object from
   * the SAME ledger row — same `jti`, same amount, same payees, same settlementRef — with
   * `grant: "none"` and no `exp`. It is safe to be permanent precisely because presenting
   * one buys nothing (`licenseEntitlesRead` refuses any grant that is not "read").
   *
   * Host-scoped and publisher-checked exactly like `/licenses/:jti` above: minting must
   * disclose no more than reading did.
   *
   * The record names the resource by `slug`, not by title — the ledger row carries no
   * title, and inventing one here would put an unverifiable string inside a document
   * whose entire value is that a stranger can check it.
   */
  // A record is opened FROM A BROWSER by whoever holds its link, so it carries the same
  // cross-origin headers the key set does — on every status, because "not here" (a 404) and
  // "unreachable" (a fetch the same-origin policy blocked) are different answers a verifier
  // must be able to tell apart, and only one of them says anything about the document.
  //
  // `?host=` lets a browser name the publisher, which `Host` cannot do for it: a publisher
  // serving their own site through the SDK has no record route on their origin, and the fleet
  // edge answers a spoofed `Host` with 403 — measured 2026-09-02, so from a browser there was
  // no way at all to ask about such a publisher's record. The hint only chooses WHO is
  // resolved; the `publisherId` ownership check below is untouched, so it discloses nothing a
  // `curl` with a chosen `Host` could not already ask for. A malformed hint (a scheme, a path,
  // a query) is ignored rather than cleaned — it falls through to `Host` exactly as before.
  const RECORD_CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
  } as const;
  app.options("/licenses/:jti/record", (c) => c.body(null, 204, { ...RECORD_CORS }));
  app.get("/licenses/:jti/record", async (c) => {
    const jti = c.req.param("jti");
    const notFound = () => c.json({ jti, found: false }, 404, { ...RECORD_CORS, "cache-control": "no-store" });
    if (!licensing) return notFound();
    const host = publisherHostHint(c.req.query("host")) ?? c.req.header("host") ?? new URL(c.req.url).host;
    const publisher = (await resolver.resolve(host)) ?? (await resolveInAppConfig?.(host));
    if (!publisher) return notFound();

    const event = await getEvent(jti);
    if (!event || (event.publisherId !== undefined && event.publisherId !== publisher.id)) {
      return notFound();
    }
    // The chain the money actually moved on, recovered from the row — one owner in shared,
    // because the control plane re-issues an access token from this same row and both
    // projections must name the same chain.
    const net = networkForEvent(event, publisher);
    const record = mintCitationRecord(
      {
        event,
        issuer: publisher.licenseIdentity,
        audience: publisher.licenseIdentity,
        // Unused by the record (it carries no exp) but required by MintInput; the value
        // is deliberately the configured one so nothing here invents a term.
        ttlSeconds: cfg.LICENSE_TTL_SECONDS,
        payeesMode: cfg.LICENSE_PAYEES_MODE,
        tieBreak: cfg.PRIMARY_PAYEE_TIEBREAK,
        title: event.slug,
        network: { chainId: net.chainId, usdc: net.usdc, gateway: net.gatewayWallet },
        // What a SALE bought, replayed from the row rather than re-derived. Absent on a toll, so
        // its record is byte-identical to what this route emitted before sales existed.
        //
        // Spread individually rather than as one object: `MintInput` takes these four flat, and
        // the record is the ONLY place a buyer's scope, terms and period become permanently
        // checkable. Passing the row's facts through unchanged is what makes the record and the
        // access licence two projections of one row instead of two documents that agree by habit.
        ...(event.licence?.scope ? { scope: event.licence.scope } : {}),
        ...(event.licence?.terms ? { terms: event.licence.terms } : {}),
        ...(event.licence?.period ? { period: event.licence.period } : {}),
        ...(event.licence?.subject ? { subject: event.licence.subject } : {}),
      },
      licensing.key,
      Date.now(),
    );
    // The record is permanent, so anyone may cache it; each mint carries a fresh `iat` and a
    // fresh signature, and every one of them is valid.
    return c.json({ jti, found: true, record }, 200, { ...RECORD_CORS, "cache-control": "public, max-age=3600" });
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
      const res = await proxyToOrigin(c.req.raw, path, clientIp, publisher.originUrl, publisher.originAuthSecret, publisher.id, onUpstreamOutcome, proxySigning);
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
    const emitObs = (obs: DecideObs, v: ObservationVerdict, extra?: { kind?: TollKind; price?: Usdc; failureReason?: PaymentFailureReason }): void =>
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
        // Only ever set on `payment-failed` — the other verdicts have no failure to explain.
        failureReason: extra?.failureReason,
        at: Date.now(),
      });

    switch (d.kind) {
      // Non-article OR unknown-article: pure passthrough, no observation.
      case "passthrough":
        return proxyToOrigin(c.req.raw, path, clientIp, publisher.originUrl, publisher.originAuthSecret, publisher.id, onUpstreamOutcome, proxySigning);

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
        const res = await proxyToOrigin(c.req.raw, path, clientIp, publisher.originUrl, publisher.originAuthSecret, publisher.id, onUpstreamOutcome, proxySigning);
        res.headers.set("X-Naulon-Verdict", headerSafe(d.verdict));
        return stampGateCacheHeaders(res, { noStore: false });
      }

      // A valid license scoped to this slug+kind re-reads free.
      case "reread": {
        emitObs(d.obs, "agent-reread", { kind: d.tollKind });
        const res = await proxyToOrigin(c.req.raw, path, clientIp, publisher.originUrl, publisher.originAuthSecret, publisher.id, onUpstreamOutcome, proxySigning);
        res.headers.set("X-Naulon-Verdict", "agent reread (license)");
        return stampGateCacheHeaders(res, { noStore: true });
      }

      // Machine, no payment: 402 with the requirement in the PAYMENT-REQUIRED
      // header. Link points an agent at the toll manifest (discoverability).
      case "payment-required": {
        emitObs(d.obs, "denied", { kind: d.tollKind, price: usdc(d.quote.price) });
        const askMicro = totalChargedMicro(d.legs);
        // A Cloudflare-trained crawler states its ceiling on the request. Reading it
        // does NOT change the answer — a 402 either way, because naulon settles over
        // x402/USDC and cannot auto-charge the way a Cloudflare-proxied origin does.
        // It changes what is VISIBLE: whether the buyer that arrived would have paid.
        // Without this the interop cannot be measured at all, only assumed.
        const budget = crawlerBudgetVerdict(
          declaredCrawlerBudget({
            maxPrice: c.req.header(CRAWLER_MAX_PRICE_HEADER),
            exactPrice: c.req.header(CRAWLER_EXACT_PRICE_HEADER),
          }),
          askMicro,
        );
        return stampGateCacheHeaders(
          c.body(null, 402, {
            [PAYMENT_REQUIRED_HEADER]: d.header,
            [CRAWLER_PRICE_HEADER]: formatCrawlerPrice(askMicro),
            Link: PAYMENT_LINK_HEADER,
            "X-Naulon-Verdict": headerSafe(
              `agent (${d.obs.classifyReason})${budget ? `; ${budget} crawler budget` : ""}`,
            ),
          }),
          { noStore: true },
        );
      }

      // Machine WITH a payment: fetch what we sold, verify + settle (custody-free), then serve.
      case "payment-presented": {
        // FETCH BEFORE SETTLE — never move money for a read the origin will not deliver.
        //
        // This used to settle first and proxy afterwards, so an origin that answered 404 left the
        // buyer charged with nothing to show for it, and custody-free means there is no refund
        // path: the money went buyer → author directly. Found live on 2026-08-04 —
        // `fleetorigin.naulon.app` had moved its articles to `.html` suffixes while the catalog
        // still declared the extensionless slugs (slug extraction strips the suffix, so BOTH URLs
        // priced, and only one was servable). GPTBot was quoted 5000 micro-USDC on a URL the origin
        // could not serve, and "GPTBot gets a 402" — the fleet walk's own success criterion —
        // passed the whole time.
        //
        // Ordering, not an extra request: the proxy fetch already happened on this path, one line
        // below the settle. Doing it first costs nothing and makes "money moved" imply "content was
        // in hand". The unread body is held across the settle; article payloads are small and the
        // settle is ~1s, so the upstream connection is not meaningfully strained.
        //
        // SAFE METHODS ONLY. The gated route is `app.all("*")`, so a non-GET could reach here, and
        // reordering would let the origin perform a side effect for a request that never pays. A
        // GET/HEAD is idempotent and side-effect-free, which is the entire article-read surface
        // this defect lives on; anything else keeps the original settle-then-proxy order.
        const safeMethod = c.req.method === "GET" || c.req.method === "HEAD";
        let prefetched: Response | undefined;
        if (safeMethod) {
          prefetched = await proxyToOrigin(c.req.raw, path, clientIp, publisher.originUrl, publisher.originAuthSecret, publisher.id, onUpstreamOutcome, proxySigning);
          // The bytes must be IN HAND before the money moves, and until now "prefetched" only ever
          // meant the HEADERS arrived. `proxyToOrigin` hands back a STREAMING response, and an
          // article origin answers chunked (no content-length), so nothing is necessarily buffered
          // at this point. Holding that unread stream across `settleAndAttribute` below — an
          // on-chain settle, ~1s and sometimes several — lets the upstream connection be recycled,
          // closed, or time out inside the window, and the body then reads as ZERO BYTES on the
          // client: status 200, a minted license, a real settlementRef, and nothing to read.
          //
          // Measured on the local rig 2026-08-11 — roughly 40% of paid reads returned
          // `ok=true license=true contentLen=0`, and the /ask agent above cited those empty sources
          // as though it had read them. Money moved, no content, nobody told.
          //
          // Reading the body here is what makes the ordering note above true as written: "money
          // moved" now implies the bytes were in hand, not merely promised. The cost is one article
          // body held in memory per in-flight paid read — precisely what that note already assumed
          // when it said article payloads are small.
          if (prefetched.ok) {
            const materialized = await materializeBody(prefetched);
            if (!materialized) {
              // The read failed BEFORE anything settled, which is the whole point of doing it here:
              // the buyer's signed authorization is untouched and reusable, exactly as in the
              // non-2xx branch below. An origin that cannot deliver its own bytes is an origin that
              // could not serve, and we bill only for delivered content.
              emitObs(d.obs, "unservable", { kind: d.tollKind, price: usdc(d.quote.price) });
              return stampGateCacheHeaders(
                new Response("origin body could not be read", {
                  status: 502,
                  headers: {
                    "X-Naulon-Verdict": headerSafe("agent not charged: origin body could not be read"),
                  },
                }),
                { noStore: true },
              );
            }
            prefetched = materialized;
          }
          // Anything outside 2xx, not just 404 — and each non-2xx family is correct to refuse on:
          // a 3xx means the content moved and the agent should pay at wherever it went; a 304 means
          // they already hold it and there is no body to sell; a 5xx means the origin is broken,
          // which is the publisher's outage to fix and not a sale. The rule is simply that we bill
          // for delivered content, so "did the origin deliver" is the only question asked.
          //
          // The body an unpaid agent sees here is the origin's own error page — the same bytes a
          // human reading free would get on that URL, so refusing the charge exposes nothing new.
          if (!prefetched.ok) {
            // The payment is untouched — no nonce consumed, no leg settled — so the buyer's signed
            // authorization stays valid and reusable. They get the origin's own status, unpaid.
            emitObs(d.obs, "unservable", { kind: d.tollKind, price: usdc(d.quote.price) });
            prefetched.headers.set(
              "X-Naulon-Verdict",
              headerSafe(`agent not charged: origin could not serve (${prefetched.status})`),
            );
            return stampGateCacheHeaders(prefetched, { noStore: true });
          }
        }

        // The settlement tail — the exact same code path the hosted /verify runs.
        const settled = await settleAndAttribute({ payment: d.payment, legs: d.legs, quote: d.quote, publisher, host, now });
        if (!settled.ok) {
          // Let the origin's body go. This is the ONE branch that prefetches and then does not
          // serve what it fetched: the success path below hands `prefetched` to the client, and the
          // `!prefetched.ok` branch above returns the response itself. Here we return a fresh 402
          // and the fetched body would simply fall out of scope — and an unread undici body holds
          // its socket out of the pool until GC finalises it, so a run of failing payments leaks one
          // connection each against the publisher's own origin.
          //
          // Failure is ignored on purpose: the body may already be errored or the peer gone, and
          // nothing about releasing it should change what the buyer is told about their payment.
          await prefetched?.body?.cancel().catch(() => {});
          // Carry WHY, classified. `settled.error` goes to the buyer in the 402 body below (they are
          // entitled to the detail); the publisher's audit row gets the closed-set reason, so a
          // counterparty address or leg amount can never reach it.
          emitObs(d.obs, "payment-failed", {
            kind: d.tollKind,
            price: usdc(d.quote.price),
            failureReason: classifyPaymentFailure(settled.error),
          });
          return stampGateCacheHeaders(
            c.json({ error: settled.error }, 402, {
              [PAYMENT_REQUIRED_HEADER]: d.header,
              // Still the ASK, not a charge — settlement failed, so nothing was taken.
              [CRAWLER_PRICE_HEADER]: formatCrawlerPrice(totalChargedMicro(d.legs)),
              Link: PAYMENT_LINK_HEADER,
            }),
            { noStore: true },
          );
        }

        // Audit plane: the paid outcome on the same timeline as denials/free reads.
        emitObs(d.obs, "paid", { kind: d.quote.kind, price: usdc(d.quote.price) });

        // Reuse the response we already hold on the safe-method path; only a non-GET reaches the
        // origin here (see the ordering note above).
        const res =
          prefetched ??
          (await proxyToOrigin(c.req.raw, path, clientIp, publisher.originUrl, publisher.originAuthSecret, publisher.id, onUpstreamOutcome, proxySigning));
        if (settled.responseHeader) res.headers.set(PAYMENT_RESPONSE_HEADER, settled.responseHeader);
        if (settled.licenseJws) res.headers.set(LICENSE_HEADER, settled.licenseJws);
        // Only on the settled path: `crawler-charged` is a claim that money moved, so
        // it is set after settleAndAttribute succeeded and never on a 402. It is the SETTLED
        // total, not the ask: a stock x402 payer (naulon#73) signs `accepts[0]` alone, so the
        // operator fee and any co-author cut never left their wallet and must not be billed to
        // them here. `crawler-price` on the 402 above still carries the full ask.
        res.headers.set(CRAWLER_CHARGED_HEADER, formatCrawlerPrice(settledChargedMicro(d.legs, settled.forgoneLegs)));
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

/**
 * A `?host=` hint on the record route is a host with an optional port, or nothing. A scheme, a
 * path or a query is refused outright (never "cleaned" into a host), because the value becomes
 * the `iss` of a document a stranger is told to trust.
 */
function publisherHostHint(raw: string | undefined): string | undefined {
  const h = raw?.trim().toLowerCase();
  return h && /^[a-z0-9.-]+(:\d+)?$/.test(h) ? h : undefined;
}
