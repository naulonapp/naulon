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
import { createHash, randomUUID } from "node:crypto";
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
  createRateLimiter,
  isBareHostname,
  type PublisherConfig,
  type PublisherResolver,
  type TollKind,
  type Usdc,
  type EventMandate,
  type LicenceAuthority,
  type LicenceVerdict,
  parseLicenceAuthorization,
  referrerHost,
} from "@naulon/shared";
import {
  decide,
  LICENSE_HEADER,
  type Decision,
  type DecideObs,
  buildX402Manifest,
  paymentLinkHeader,
  type MachineUrlBase,
  X402_MANIFEST_PATH,
  licensing,
  quote,
  revocations,
} from "@naulon/enforce";
import { get as getEvent } from "./eventLog.ts";
import { observe } from "./observationLog.ts";
import { clientKeyOf, rateLimit } from "./rateLimit.ts";
import { admitIngress, edgeSecretDigest, isIngressHost, namedSiteOf, privateToIngress, siteHostOf, type IngressAdmission, type IngressOptions } from "./ingress.ts";
import { DEFAULT_TOLL_TERMS, settleAndAttribute } from "./settle.ts";
import { deliverForAgent, varyOnAccept, type Delivered } from "./deliver.ts";
import { prefersMarkdown } from "@naulon/extract";
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
// What a buyer has already authorized but the drain has NOT yet burned. A funding guard that reads
// only the on-chain/Gateway balance lets a buyer spend money these legs are owed — the author leg
// settles synchronously and leaves the balance, every other leg does not. Exported so a control
// plane's guard can subtract it from what it thinks is spendable, reading the SAME sink the drain
// settles from rather than keeping a second tally that could drift out of step with it.
export { outstandingLegMicro, legPayer } from "./pendingLegs.ts";
// The runtime-agnostic decision surface (app.ts is the package's public entry).
// `@naulon/enforce`'s in-app middleware (re-exported as `@naulon/sdk/enforce`)
// reaches the SAME verdict from a web Request; the private control plane consumes
// the settle primitives + the
// shared settlement tail (`settleAndAttribute`) for its hosted /verify.
export { decide, LICENSE_HEADER } from "@naulon/enforce";
export type { Decision, DecideInput, DecideObs } from "@naulon/enforce";
export { settleAndAttribute, type SettleResult, type SettleArgs } from "./settle.ts";
// The ingress host rules, for an embedder serving its own routes on the ingress host.
export { isIngressHost, siteHostOf } from "./ingress.ts";
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
  PAYMENT_BODY_CONTENT_TYPE,
  paymentRequiredBodyText,
  headerSafe,
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
  // the publisher a signed pull is for: gate-injected only, and covered by the signature
  "x-naulon-publisher",
  // CDN→ingress auth: consumed by the ingress, never forwarded to an origin
  "x-naulon-edge-auth",
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
    const name = k.toLowerCase();
    if (STRIP_HEADERS.has(name)) continue;
    // A licence token is the buyer's bearer credential, and the origin is the payee. Handing it over
    // would let the origin present it here on URLs the buyer never read. Any other Authorization
    // scheme is the origin's own business and passes through.
    if (name === "authorization" && parseLicenceAuthorization(v) !== null) continue;
    out.set(k, v);
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

// `headerSafe` lives in `@naulon/enforce` now: the in-app middleware sets the same verdict
// header and cannot import tollgate (the dependency runs enforce ← tollgate, never back).
// Re-exported here because it is part of this module's published surface.
export { headerSafe };

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
/** The delivery half of a `paid` or `agent-reread` observation. */
function deliveryFacts(d: Delivered | undefined): { extraction?: "gate" | "passthrough" | "raw"; servedBytes?: number; sourceBytes?: number } {
  if (!d) return {};
  return { ...(d.extraction ? { extraction: d.extraction } : {}), servedBytes: d.bytes.byteLength, sourceBytes: d.sourceBytes };
}

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
  // A publisher runtime running beside a crawler route serves a pull it verifies as ours without
  // charging again, so the signature is the witness that this read was decided under THIS
  // publisher's policy. It covers `@path`, so it cannot be replayed on another page, and the
  // publisher id, because any tenant can name any site as its origin: without it, a tenant whose
  // origin is someone else's site could make the gate fetch that site's pages under a valid
  // signature, on its own (possibly free) terms.
  if (proxySigning && origin.protocol === "https:") {
    outHeaders.set("x-naulon-publisher", publisherId);
    const signed = signBotAuth({
      key: proxySigning.key,
      authority: origin.host,
      path: target.pathname,
      headers: { "x-naulon-publisher": publisherId },
      tag: "web-bot-auth",
      agent: proxySigning.agent,
    });
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
 * The self-host ingress from `INGRESS_HOST` + `EDGE_SECRET`, or undefined when both are unset. One
 * without the other is a half-configured route that would otherwise run as no route at all, so it
 * stops the boot instead.
 */
function envIngress(resolver: PublisherResolver): IngressOptions | undefined {
  if (!cfg.INGRESS_HOST && !cfg.EDGE_SECRET) return undefined;
  if (!cfg.INGRESS_HOST || !cfg.EDGE_SECRET) {
    throw new Error("INGRESS_HOST and EDGE_SECRET configure the crawler route together: set both, or neither.");
  }
  const digests = [edgeSecretDigest(cfg.EDGE_SECRET)];
  return {
    host: cfg.INGRESS_HOST,
    async resolve(siteHost) {
      const config = await resolver.resolve(siteHost);
      return config ? { config, edgeSecretDigests: digests } : undefined;
    },
  };
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

  /**
   * Optional licence seam: who charges a read presented with `Authorization: License <token>`.
   *
   * The gate hands it the 402 it would have answered with and settles whatever payment it returns,
   * through the same prefetch, hash and settle path a buyer-signed payment takes, then reports the
   * outcome back. Omitting it answers such a request with the ordinary 402, byte-identical to before
   * the option existed.
   */
  licenceAuthority?: LicenceAuthority;

  /**
   * Optional crawler-route seam: accept requests the publisher's own CDN proxies to one shared
   * ingress hostname, naming the site in `Forwarded: host=` and authenticating with a per-site edge
   * secret (see `ingress.ts`). Omitting it, with `INGRESS_HOST` unset, is byte-identical to before
   * the option existed: no host is treated as an ingress.
   */
  ingress?: IngressOptions;
}

export function createApp(
  resolverArg?: PublisherResolver,
  opts?: CreateAppOptions,
): Hono {
  const resolver = resolverArg ?? envPublisherResolver();
  // The env ingress applies ONLY to the single-tenant default resolver: it carries one secret, and
  // handing one secret to a resolver that answers many publishers would let any of them be named.
  const ingress = opts?.ingress ?? (resolverArg === undefined ? envIngress(resolver) : undefined);
  if (ingress && !isBareHostname(ingress.host)) {
    throw new Error(`ingress host must be a bare lowercase hostname, got ${JSON.stringify(ingress.host)}`);
  }
  const onUpstreamOutcome = opts?.onUpstreamOutcome;
  const resolveInAppConfig = opts?.resolveInAppConfig;
  const licenceAuthority = opts?.licenceAuthority;
  const app = new Hono();
  app.use("*", logger());
  // Ingress requests are limited after admission instead (`takeIngress`): before it, every crawler
  // behind one publisher's CDN shares that CDN's egress address, and those addresses are shared
  // across publishers too.
  app.use("*", rateLimit(ingress ? { skipHost: (host) => isIngressHost(host, ingress) } : {}));
  const ingressLimiter = createRateLimiter({
    rpm: cfg.RATE_LIMIT_RPM,
    burst: cfg.RATE_LIMIT_BURST,
    maxBuckets: cfg.RATE_LIMIT_MAX_BUCKETS,
  });
  /**
   * `scope` names whose budget this is; an unidentified sender passes, as it does globally. `peek`
   * answers without spending, for a check that must run before a lookup the caller has not yet
   * earned.
   */
  const takeIngress = (scope: string, caller: string | undefined, mode: "take" | "peek" = "take"): Response | undefined => {
    if (!ingressLimiter.enabled || caller === undefined) return undefined;
    const key = `${scope}\0${caller}`;
    const { allowed, retryAfter } = mode === "peek" ? ingressLimiter.peek(key) : ingressLimiter.take(key);
    if (allowed) return undefined;
    return Response.json({ error: "rate limit exceeded" }, {
      status: 429,
      headers: { "Retry-After": String(Math.max(1, retryAfter)), "cache-control": "no-store" },
    });
  };

  // Crawler route. Admission runs here, in front of every route, because a crawler that received a
  // 402 through the publisher's CDN follows its links through the same CDN: `/.well-known/x402` and
  // `/licenses/*` arrive on the ingress host too, and must answer for the site the CDN named rather
  // than for the ingress hostname. Refusals look exactly like an unknown Host (see ingress.ts).
  const admitted = new WeakMap<Request, Extract<IngressAdmission, { kind: "admitted" }>>();
  // A verifier following an absolute machine URL (`https://<ingress>/licenses/{jti}?host=<site>`)
  // has no edge secret and needs none: these routes disclose only what the same request with that
  // `Host` would, and each still checks that the event belongs to the resolved publisher. The value
  // is the named site, or null when none was named, which resolves nothing.
  const hinted = new WeakMap<Request, string | null>();
  const machineBase = (site: string): MachineUrlBase | undefined =>
    ingress ? { origin: `https://${ingress.host}`, host: site } : undefined;
  if (ingress) {
    app.use("*", async (c, next) => {
      const inboundHost = c.req.header("host") ?? new URL(c.req.url).host;
      if (!isIngressHost(inboundHost, ingress)) return next();
      const path = c.req.path;
      const caller = clientKeyOf(c);
      if (c.req.method === "GET" || c.req.method === "OPTIONS" || c.req.method === "HEAD") {
        if (INGRESS_OPEN_PATHS.has(path)) return takeIngress("ingress", caller) ?? next();
        if (!c.req.header("forwarded") && isMachinePath(path)) {
          const limited = takeIngress("ingress", caller);
          if (limited) return limited;
          const site = siteHostOf(c.req.query("host"));
          hinted.set(c.req.raw, site && !isIngressHost(site, ingress) ? site : null);
          await next();
          c.res = privateToIngress(c.res);
          return;
        }
      }
      // A sender whose misses have used up its budget is refused before admission looks anything
      // up; otherwise every refused request would still cost the resolver a lookup. The budget is
      // per NAMED SITE: the sender is a CDN's egress, which publishers share, so one site's stale
      // or forged rule must not use up the budget of every other site behind the same CDN. A
      // request naming no site shares the sender's budget with the ingress's open routes.
      const named = namedSiteOf(c.req.raw);
      const missScope = named ? `miss\0${named}` : "ingress";
      const spent = takeIngress(missScope, caller, "peek");
      if (spent) return spent;
      const admission = await admitIngress(c.req.raw, ingress);
      if (admission.kind === "miss") {
        return takeIngress(missScope, caller) ?? handleUnknownHost(c, inboundHost);
      }
      if (admission.kind === "loop") {
        return c.text(
          "naulon received its own request back. Your CDN rule must skip requests that carry the x-naulon-origin-auth header.",
          508,
          { "cache-control": "no-store", "X-Naulon-Verdict": "ingress loop refused" },
        );
      }
      const limited = takeIngress(admission.config.id, admission.clientIp ?? caller);
      if (limited) return limited;
      admitted.set(c.req.raw, admission);
      await next();
      c.res = privateToIngress(c.res);
      // Names the site the gate answered for, on every response it served through the route. A
      // publisher (or the route self-test) can see the rule works with one request, whatever the
      // page returned: an unknown article is a plain passthrough that carries no other gate header.
      c.res.headers.set(INGRESS_RESPONSE_HEADER, admission.siteHost);
    });
  }
  /**
   * The site a machine route answers for when the request came to the ingress host, or undefined
   * for any other host. By `?host=` the two kinds of route resolve differently, on purpose:
   *
   * - `terms` (the manifest) are what the site sells NOW, so only a live crawler route answers.
   *   Any other publisher publishes its terms on its own host.
   * - `identity` (a licence, its record) is permanent: a record sold through a route must still
   *   verify after that route is revoked. So it resolves the way `/licenses/:jti/record?host=`
   *   does on every gate host, by routing and then by ownership, and the event's publisher check
   *   is what bounds what it can disclose.
   */
  const ingressSite = async (
    c: Context,
    purpose: "terms" | "identity",
  ): Promise<{ host: string; publisher: PublisherConfig | undefined } | undefined> => {
    const via = admitted.get(c.req.raw);
    if (via) return { host: via.siteHost, publisher: via.config };
    if (!hinted.has(c.req.raw)) return undefined;
    const site = hinted.get(c.req.raw);
    if (!site) return { host: "", publisher: undefined };
    const live = (await ingress?.resolve(site))?.config;
    if (purpose === "terms") return { host: site, publisher: live };
    return { host: site, publisher: live ?? (await resolver.resolve(site)) ?? (await resolveInAppConfig?.(site)) };
  };

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
    c.json(licensing ? licensing.publishedJwks : { keys: [] }, 200, { ...JWKS_CORS }),
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
    const site = await ingressSite(c, "terms");
    const publisher = site ? site.publisher : await resolver.resolve(host);
    if (!publisher) return c.json({ error: "no toll for this host" }, 404);
    // Pinned to the TENANT's chain, not the fleet default. The 402 this host emits already
    // resolves per tenant (`quote.network` → `buildRequirements`); the manifest did not, so a
    // publisher settling on another chain published terms naming ours. An agent that reads the
    // manifest, prepares a payment on that chain and then meets a 402 for a different one reads
    // it as our bug — correctly.
    return c.json(
      buildX402Manifest(
        publisher,
        publisher.settlementNetwork ? getNetwork(publisher.settlementNetwork) : activeNetwork(),
        site ? machineBase(site.host) : undefined,
      ),
    );
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
    const site = await ingressSite(c, "identity");
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
    const publisher = site ? site.publisher : (await resolver.resolve(host)) ?? (await resolveInAppConfig?.(host));
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
   * defaults to 3600s and is capped there because it is an unrevocable bearer credential
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
    const site = await ingressSite(c, "identity");
    const host = publisherHostHint(c.req.query("host")) ?? c.req.header("host") ?? new URL(c.req.url).host;
    const publisher = site ? site.publisher : (await resolver.resolve(host)) ?? (await resolveInAppConfig?.(host));
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
        title: event.title ?? event.slug,
        network: { chainId: net.chainId, usdc: net.usdc, gateway: net.gatewayWallet },
        // What a SALE bought, replayed from the row rather than re-derived. Absent on a toll, so
        // its record is byte-identical to what this route emitted before sales existed.
        //
        // Spread individually rather than as one object: `MintInput` takes these four flat, and
        // the record is the ONLY place a buyer's scope, terms and period become permanently
        // checkable. Passing the row's facts through unchanged is what makes the record and the
        // access licence two projections of one row instead of two documents that agree by habit.
        ...(event.licence?.scope ? { scope: event.licence.scope } : {}),
        // A toll's access token states `DEFAULT_TOLL_TERMS`, so its permanent record must too: the
        // two are projections of one row and may not disagree about what was bought.
        terms: event.licence?.terms ?? DEFAULT_TOLL_TERMS,
        ...(event.licence?.period ? { period: event.licence.period } : {}),
        ...(event.licence?.subject ? { subject: event.licence.subject } : {}),
      },
      licensing.key,
      // Issued at the moment of sale, not the moment of this fetch. Ed25519 signing is
      // deterministic, so the same row and key yield the same bytes on every fetch: a copy saved
      // today and one fetched next year compare equal, and a verifier can tell them apart only by
      // the key that signed them.
      event.at,
    );
    // The record is permanent and byte-stable for a given signing key, so anyone may cache it.
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

    const inboundHost = c.req.header("host") ?? new URL(c.req.url).host;

    // Crawler route: the publisher's CDN proxied this to the shared ingress host, naming the site.
    // Refusals look exactly like an unknown Host (see ingress.ts); an admitted request is rewritten
    // into the site's own request, so everything below it names the site without being told to.
    const via = admitted.get(c.req.raw);
    if (via) return serveGated(c, via.request, path, via.clientIp ?? clientIp, via.siteHost, via.config, true);
    // An open path reached with a method its route does not take: nothing to serve on this host.
    if (ingress && isIngressHost(inboundHost, ingress)) return handleUnknownHost(c, inboundHost);

    // Resolve the publisher this Host fronts. Every downstream decision (proxy
    // target, price, payees, license identity, settlement) reads from here.
    const host = inboundHost;
    const publisher = await resolver.resolve(host);
    if (!publisher) return handleUnknownHost(c, host);
    return serveGated(c, c.req.raw, path, clientIp, host, publisher, false);
  });

  /**
   * Serve one request for a resolved publisher. `raw` is the request as the site sees it: the
   * inbound one, or for a crawler route the rewritten one. `viaIngress` is set only after the edge
   * secret checked out, and reaches the classifier and the rows this request writes.
   */
  const serveGated = async (
    c: Context,
    raw: Request,
    path: string,
    clientIp: string,
    host: string,
    publisher: PublisherConfig,
    viaIngress: boolean,
  ): Promise<Response> => {
    // Suspended ≠ dead. A paused publisher (billing lapse upstream) serves its
    // origin straight through, free and untolled — suspension must never dark a
    // live site or turn its readers away. The gate just stops earning until it's
    // lifted. (Unknown host already failed closed above; this is a KNOWN host.)
    if (publisher.suspended) {
      const res = await proxyToOrigin(raw, path, clientIp, publisher.originUrl, publisher.originAuthSecret, publisher.id, onUpstreamOutcome, proxySigning);
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
      raw: raw,
      host,
      path,
      publisher,
      now,
      quote,
      botAuthOpts: { allowInsecureHttp: cfg.BOT_AUTH_ALLOW_HTTP },
      ...(viaIngress ? { viaIngress: true } : {}),
    });

    // Audit plane: one observation per gated-route decision, built from the facts
    // decide() carried back (telemetry only, never gates). Default sink off → no-op.
    // `at` is stamped per emit, exactly as before the extraction.
    const emitObs = (obs: DecideObs, v: ObservationVerdict, extra?: { kind?: TollKind; price?: Usdc; failureReason?: PaymentFailureReason; delivery?: Delivered }): void =>
      observe({
        id: randomUUID(),
        publisherId: publisher.id,
        host,
        ...(viaIngress ? { servedVia: "ingress" as const } : {}),
        slug: obs.slug,
        path: pathnameOf(path),
        ...(obs.classifiedAs === "human" ? optionalReferrer(referrerHost(raw.headers.get("referer"), host)) : {}),
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
        ...deliveryFacts(extra?.delivery),
        at: Date.now(),
      });

    // A free reread under a licence the agent already holds. Nothing is charged, so there is no
    // settle to protect; the body is only read into memory when it has to be reshaped.
    const serveReread = async (obs: DecideObs, tollKind: TollKind, verdict: string): Promise<Response> => {
      const fetched = await proxyToOrigin(raw, path, clientIp, publisher.originUrl, publisher.originAuthSecret, publisher.id, onUpstreamOutcome, proxySigning);
      if (!fetched.ok || !prefersMarkdown(raw.headers.get("accept"))) {
        emitObs(obs, "agent-reread", { kind: tollKind });
        if (fetched.ok) varyOnAccept(fetched.headers);
        fetched.headers.set("X-Naulon-Verdict", verdict);
        return stampGateCacheHeaders(fetched, { noStore: true });
      }
      const materialized = await materializeBody(fetched);
      if (!materialized) {
        emitObs(obs, "agent-reread", { kind: tollKind });
        const res = c.text("The origin did not deliver this page in full.", 502);
        res.headers.set("X-Naulon-Verdict", "agent reread: origin body unreadable");
        return stampGateCacheHeaders(res, { noStore: true });
      }
      const delivery = await deliverForAgent(materialized, raw.headers.get("accept"), raw.url);
      emitObs(obs, "agent-reread", { kind: tollKind, delivery });
      delivery.res.headers.set("X-Naulon-Verdict", verdict);
      return stampGateCacheHeaders(delivery.res, { noStore: true });
    };

    // The paid tail, shared by a buyer-signed payment and one a licence authority returned. `extra`
    // is empty for the former, which keeps that path byte-identical to what it was.
    type Priced = Extract<Decision, { kind: "payment-presented" | "licence-presented" }>;
    type SettleOutcome = "settled" | "unpaid" | "ambiguous";
    const settleAndServe = async (
      p: Priced,
      payment: string,
      extra: {
        mandate?: EventMandate;
        onOutcome?: (o: SettleOutcome, s?: { licenseJws?: string; eventId?: string }) => Promise<void>;
      },
    ): Promise<Response> => {
      const outcome = async (o: SettleOutcome, st?: { licenseJws?: string; eventId?: string }): Promise<void> => {
        if (!extra.onOutcome) return;
        try {
          await extra.onOutcome(o, st);
        } catch {
          // Reporting never changes what the buyer is told.
        }
      };
      // A throw still has to be reported: before the settle nothing moved and the reserve is owed
      // back; during it, money may have moved. The throw itself carries on to the error boundary.
      const reportingThrow = async <T>(o: SettleOutcome, f: () => Promise<T>): Promise<T> => {
        try {
          return await f();
        } catch (err) {
          await outcome(o);
          throw err;
        }
      };
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
      const safeMethod = raw.method === "GET" || raw.method === "HEAD";
      let prefetched: Response | undefined;
      let contentSha256: string | undefined;
      let delivery: Delivered | undefined;
      if (safeMethod) {
        prefetched = await reportingThrow("unpaid", () =>
          proxyToOrigin(raw, path, clientIp, publisher.originUrl, publisher.originAuthSecret, publisher.id, onUpstreamOutcome, proxySigning),
        );
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
          const fetched = prefetched;
          const materialized = await reportingThrow("unpaid", () => materializeBody(fetched));
          if (!materialized) {
            // The read failed BEFORE anything settled, which is the whole point of doing it here:
            // the buyer's signed authorization is untouched and reusable, exactly as in the
            // non-2xx branch below. An origin that cannot deliver its own bytes is an origin that
            // could not serve, and we bill only for delivered content.
            emitObs(p.obs, "unservable", { kind: p.tollKind, price: usdc(p.quote.price) });
            await outcome("unpaid");
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
          // Shape the body before hashing it: an agent that asked for markdown gets the article as
          // markdown, and the licence then covers exactly that text. A throw here is the origin's
          // body failing to become a read, so it refuses like any other undeliverable body.
          delivery = await reportingThrow("unpaid", () => deliverForAgent(materialized, raw.headers.get("accept"), raw.url));
          prefetched = delivery.res;
          // Hash what is about to be served, from the same in-memory bytes the buyer receives. A
          // HEAD carries no body to sell, so it states no hash rather than the hash of nothing.
          if (raw.method === "GET") {
            contentSha256 = createHash("sha256").update(delivery.bytes).digest("hex");
          }
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
          emitObs(p.obs, "unservable", { kind: p.tollKind, price: usdc(p.quote.price) });
          await outcome("unpaid");
          prefetched.headers.set(
            "X-Naulon-Verdict",
            headerSafe(`agent not charged: origin could not serve (${prefetched.status})`),
          );
          return stampGateCacheHeaders(prefetched, { noStore: true });
        }
      }

      // The settlement tail — the exact same code path the hosted /verify runs.
      const settled = await reportingThrow("ambiguous", () => settleAndAttribute({
        payment: payment,
        legs: p.legs,
        quote: p.quote,
        publisher,
        host,
        ...(viaIngress ? { servedVia: "ingress" as const } : {}),
        now,
        resource: canonicalResource(host, new URL(raw.url).pathname),
        ...(contentSha256 ? { contentSha256 } : {}),
        ...(extra.mandate ? { mandate: extra.mandate } : {}),
      }));
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
        // Refused at verify means nothing was broadcast; any later failure may have moved money.
        await outcome(settled.stage === "verify" ? "unpaid" : "ambiguous");
        // Carry WHY, classified. `settled.error` goes to the buyer in the 402 body below (they are
        // entitled to the detail); the publisher's audit row gets the closed-set reason, so a
        // counterparty address or leg amount can never reach it.
        emitObs(p.obs, "payment-failed", {
          kind: p.tollKind,
          price: usdc(p.quote.price),
          failureReason: classifyPaymentFailure(settled.error),
        });
        return stampGateCacheHeaders(
          c.json({ error: settled.error }, 402, {
            [PAYMENT_REQUIRED_HEADER]: p.header,
            // Still the ASK, not a charge — settlement failed, so nothing was taken.
            [CRAWLER_PRICE_HEADER]: formatCrawlerPrice(totalChargedMicro(p.legs)),
            Link: paymentLinkHeader(viaIngress ? machineBase(host) : undefined),
          }),
          { noStore: true },
        );
      }

      await outcome("settled", {
        ...(settled.licenseJws ? { licenseJws: settled.licenseJws } : {}),
        ...(settled.eventId ? { eventId: settled.eventId } : {}),
      });

      // Audit plane: the paid outcome on the same timeline as denials/free reads.
      emitObs(p.obs, "paid", { kind: p.quote.kind, price: usdc(p.quote.price), ...(delivery ? { delivery } : {}) });

      // Reuse the response we already hold on the safe-method path; only a non-GET reaches the
      // origin here (see the ordering note above).
      const res =
        prefetched ??
        (await proxyToOrigin(raw, path, clientIp, publisher.originUrl, publisher.originAuthSecret, publisher.id, onUpstreamOutcome, proxySigning));
      if (settled.responseHeader) res.headers.set(PAYMENT_RESPONSE_HEADER, settled.responseHeader);
      if (settled.licenseJws) res.headers.set(LICENSE_HEADER, settled.licenseJws);
      // Only on the settled path: `crawler-charged` is a claim that money moved, so
      // it is set after settleAndAttribute succeeded and never on a 402. It is the SETTLED
      // total, not the ask: a stock x402 payer (naulon#73) signs `accepts[0]` alone, so the
      // operator fee and any co-author cut never left their wallet and must not be billed to
      // them here. `crawler-price` on the 402 above still carries the full ask.
      res.headers.set(CRAWLER_CHARGED_HEADER, formatCrawlerPrice(settledChargedMicro(p.legs, settled.forgoneLegs)));
      res.headers.set("X-Naulon-Verdict", headerSafe(`agent paid (${p.obs.classifyReason})`));
      return stampGateCacheHeaders(res, { noStore: true });
    };

    // An RSL licence token the authority is asked to charge. The caller answers the ordinary 402
    // itself when no authority is configured.
    const serveLicence = async (
      p: Extract<Decision, { kind: "licence-presented" }>,
      authority: LicenceAuthority,
    ): Promise<Response> => {
      let verdict: LicenceVerdict;
      try {
        verdict = await authority.authorize({
          token: p.token,
          publisherId: publisher.id,
          host,
          resource: canonicalResource(host, new URL(raw.url).pathname),
          slug: p.obs.slug,
          tollKind: p.tollKind,
          header: p.header,
          legs: p.legs,
          ...(p.signer ? { signer: p.signer } : {}),
        });
      } catch {
        // An authority that cannot answer charges nothing. The crawler is told to come back, and
        // can still buy this read over x402 meanwhile.
        verdict = {
          ok: false,
          status: 503,
          error: "licence_server_unavailable",
          description: "the licence server could not check this licence; retry, or buy the read over x402",
        };
      }
      if (!verdict.ok) {
        const headers: Record<string, string> = {
          "X-Naulon-Verdict": headerSafe(`licence refused (${verdict.error})`),
        };
        if (verdict.status === 401) headers["WWW-Authenticate"] = `License error="${verdict.error}"`;
        // Still buyable over x402 when the licence cannot be used: the refusal carries the same
        // advertisement a 402 does. Never on `in_flight`, where a charge for this URL is running and
        // an x402 offer would invite a second payment for the same read.
        if (verdict.status === 402 || verdict.error === "licence_server_unavailable") {
          headers[PAYMENT_REQUIRED_HEADER] = p.header;
          headers[CRAWLER_PRICE_HEADER] = formatCrawlerPrice(totalChargedMicro(p.legs));
          headers.Link = paymentLinkHeader(viaIngress ? machineBase(host) : undefined);
        }
        if (verdict.status === 503) headers["retry-after"] = "2";
        emitObs(p.obs, "denied", { kind: p.tollKind, price: usdc(p.quote.price) });
        return stampGateCacheHeaders(
          c.json(
            { error: verdict.error, ...(verdict.description ? { error_description: verdict.description } : {}) },
            verdict.status,
            headers,
          ),
          { noStore: true },
        );
      }
      if (verdict.kind === "held") return serveReread(p.obs, p.tollKind, "agent reread (licence)");
      const { grantId } = verdict;
      return settleAndServe(p, verdict.payment, {
        mandate: verdict.mandate,
        onOutcome: (o, st) =>
          authority.report(
            o === "settled"
              ? { grantId, outcome: "settled", eventId: st?.eventId ?? "", ...(st?.licenseJws ? { licenseJws: st.licenseJws } : {}) }
              : { grantId, outcome: o },
          ),
      });
    };

    switch (d.kind) {
      // Non-article OR unknown-article: pure passthrough, no observation.
      case "passthrough":
        return proxyToOrigin(raw, path, clientIp, publisher.originUrl, publisher.originAuthSecret, publisher.id, onUpstreamOutcome, proxySigning);

      // Publisher-refused crawler: 403 before any content leaves.
      case "blocked": {
        emitObs(d.obs, "blocked");
        const res = c.text("This crawler is refused by the publisher.", 403);
        res.headers.set("X-Naulon-Verdict", headerSafe(`blocked ("${d.frag}")`));
        return stampGateCacheHeaders(res, { noStore: true });
      }

      // A use the published terms prohibit: 403 before any content leaves, the same refusal a
      // blocked crawler gets, because a prohibition is not a price.
      case "prohibited": {
        emitObs(d.obs, "blocked");
        const res = c.text(`${d.reason}.`, 403);
        res.headers.set("X-Naulon-Verdict", headerSafe(`prohibited (${d.term})`));
        return stampGateCacheHeaders(res, { noStore: true });
      }

      // Humans read free, forever. Set the verdict on the proxied Response itself
      // (a fresh Response from proxyToOrigin doesn't inherit c.header()).
      case "free": {
        emitObs(d.obs, "served-free");
        const res = await proxyToOrigin(raw, path, clientIp, publisher.originUrl, publisher.originAuthSecret, publisher.id, onUpstreamOutcome, proxySigning);
        res.headers.set("X-Naulon-Verdict", headerSafe(d.verdict));
        return stampGateCacheHeaders(res, { noStore: false });
      }

      // A valid license scoped to this slug+kind re-reads free.
      case "reread":
        return serveReread(d.obs, d.tollKind, "agent reread (license)");

      // Machine presenting an RSL licence token. With no licence authority configured it is
      // answered exactly as a request with no payment.
      case "licence-presented":
        // GET only. A HEAD carries no body to sell, and a standing licence must not be charged for a
        // probe the buyer never saw; anything else is not a read at all.
        if (licenceAuthority && raw.method === "GET") return serveLicence(d, licenceAuthority);
      // falls through
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
            maxPrice: raw.headers.get(CRAWLER_MAX_PRICE_HEADER) ?? undefined,
            exactPrice: raw.headers.get(CRAWLER_EXACT_PRICE_HEADER) ?? undefined,
          }),
          askMicro,
        );
        return stampGateCacheHeaders(
          // The body is the ADVERTISEMENT — price, terms, where the real obligation is —
          // in the vendor-neutral shape a non-x402 crawler can read. It used to be zero
          // bytes, which told a buyer that does not decode PAYMENT-REQUIRED nothing at all.
          c.body(paymentRequiredBodyText({ askMicro, publisher: host, endpoint: new URL(raw.url).pathname, tollKind: d.tollKind }), 402, {
            [PAYMENT_REQUIRED_HEADER]: d.header,
            [CRAWLER_PRICE_HEADER]: formatCrawlerPrice(askMicro),
            "content-type": PAYMENT_BODY_CONTENT_TYPE,
            Link: paymentLinkHeader(viaIngress ? machineBase(host) : undefined),
            "X-Naulon-Verdict": headerSafe(
              `agent (${d.obs.classifyReason})${budget ? `; ${budget} crawler budget` : ""}`,
            ),
          }),
          { noStore: true },
        );
      }

      // Machine WITH a payment: fetch what we sold, verify + settle (custody-free), then serve.
      case "payment-presented":
        return settleAndServe(d, d.payment, {});
    }
  };

  return app;
}

/**
 * The default, single-tenant app instance. The runtime entrypoints wrap this:
 * `index.ts` runs it under @hono/node-server, `api/index.ts` adapts it to a
 * Vercel function. A downstream embedder builds its own via `createApp(resolver)`.
 */
export const app = createApp();

/**
 * The URL a buyer paid for, as the citation record names it: the Host that was tolled plus the
 * path exactly as requested, with no query string (a query does not change what was priced; the slug is
 * derived from the path alone). `https` everywhere except a loopback host, which is only ever a
 * local rig and would otherwise name a URL nobody can open.
 */
export function canonicalResource(host: string, pathname: string): string {
  const scheme = /^(localhost|127\.|\[::1\])/i.test(host) ? "http" : "https";
  return `${scheme}://${host.toLowerCase()}${pathname}`;
}

/** Set on every response served through an admitted crawler route, naming the site. */
export const INGRESS_RESPONSE_HEADER = "x-naulon-ingress";

/** Routes on the ingress host that answer without naming a site: they describe the gate itself. */
const INGRESS_OPEN_PATHS = new Set(["/healthz", "/.well-known/naulon-edge", "/.well-known/naulon-jwks.json", BOT_AUTH_DIRECTORY_PATH]);

/** The gate's own machine routes, which a verifier may reach on the ingress host by `?host=`. */
function isMachinePath(path: string): boolean {
  return path === X402_MANIFEST_PATH || /^\/licenses\/[^/]+(\/record)?$/.test(path);
}

/**
 * A `?host=` hint on the record route is a host with an optional port, or nothing. A scheme, a
 * path or a query is refused outright (never "cleaned" into a host), because the value becomes
 * the `iss` of a document a stranger is told to trust.
 */
function publisherHostHint(raw: string | undefined): string | undefined {
  const h = raw?.trim().toLowerCase();
  return h && /^[a-z0-9.-]+(:\d+)?$/.test(h) ? h : undefined;
}

/** The pathname of a request target that may carry a query string. */
function pathnameOf(target: string): string {
  const q = target.search(/[?#]/);
  return q === -1 ? target : target.slice(0, q);
}


function optionalReferrer(h: string | undefined): { referrerHost?: string } {
  return h === undefined ? {} : { referrerHost: h };
}
