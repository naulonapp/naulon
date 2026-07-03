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
  getConfig,
  mintLicense,
  signBotAuthDirectory,
  popBoundAddress,
  usdc,
  verifyLicense,
  walletAddress,
  type AttributedEvent,
  type ObservationVerdict,
  type PublisherResolver,
  type TollKind,
  type Usdc,
} from "@naulon/shared";
import { classify, matchUaFragment, type RequestSignals } from "./agentDetect.ts";
import { verifyBotAuth, type RequestFacts } from "./botAuth.ts";
import {
  buildX402Manifest,
  PAYMENT_LINK_HEADER,
  X402_MANIFEST_PATH,
} from "./discoverability.ts";
import { get as getEvent, record } from "./eventLog.ts";
import { licensing } from "./license.ts";
import { observe } from "./observationLog.ts";
import { verifyPopProof } from "./pop.ts";
import { quote } from "./pricing.ts";
import { rateLimit } from "./rateLimit.ts";
import { revocations } from "./revocation.ts";
import { emitSettlement } from "./settlementSink.ts";
import { envPublisherResolver } from "./publisher.ts";

// Re-exported for downstream embedding: a host that injects its own resolver via
// `createApp` can run the settlement drain over a chosen scope (secret/origin) —
// the optional parameter the single-tenant default never needs. See settlementSink.
export { drainSettlements, type DrainScope } from "./settlementSink.ts";
// The deferred extra-leg drain (O5/O1): a downstream fleet runs this per-publisher to
// settle the buyer-authorized extra legs the gate verified-but-deferred on the request
// path. Scoped by `publisherId` for multi-tenant isolation. See pendingLegs / x402.
export { drainPendingLegs, type DrainLegScope, type DrainLegResult } from "./x402.ts";
import {
  build402,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  verifyAndSettle,
} from "./x402.ts";

// Global license POLICY (TTL, payees mode, holder-of-key, online check) and the
// settlement network coordinates are gate-operator settings, not publisher identity,
// so they stay on global config. Only per-publisher facts (origin, price, credits,
// license issuer, settlement secret) live on the resolved PublisherConfig.
const cfg = getConfig();

/** The header that carries a Citation License Token, both ways. */
const LICENSE_HEADER = "X-Naulon-License";
/** The header that carries a holder-of-key proof-of-possession on a re-read. */
const PROOF_HEADER = "X-Naulon-Proof";
/** Network coordinates embedded in a minted license — the active settlement chain. */
const settlementNetwork = activeNetwork();
const LICENSE_NETWORK = {
  chainId: settlementNetwork.chainId,
  usdc: settlementNetwork.usdc,
  gateway: settlementNetwork.gatewayWallet,
};
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * A presented license entitles a free re-read iff it verifies AND is scoped to
 * this exact slug, this publisher (aud === the publisher's licenseIdentity), and covers
 * the requested kind (a citation license entitles a read, never the reverse).
 * Fails closed — any defect drops the caller to the normal 402 path. Revocation
 * is consulted only when the online check is enabled (it needs shared state).
 */
async function licenseEntitlesRead(
  jws: string,
  slug: string,
  requestedKind: TollKind,
  req: Request,
  identity: string,
): Promise<boolean> {
  if (!licensing) return false;
  const r = verifyLicense(jws, {
    now: Date.now(),
    expectedIssuer: identity,
    expectedAudience: identity,
    jwks: licensing.jwks,
  });
  if (!r.ok) return false;
  const n = r.claims.naulon;
  if (n.slug !== slug) return false;
  if (requestedKind === "citation" && n.kind !== "citation") return false; // no read→citation upgrade
  if (cfg.LICENSE_ONLINE_CHECK && (await revocations.isRevoked(r.claims.jti))) return false;
  // Holder-of-key: a cnf-bound license is NOT a bearer right — require a fresh
  // wallet proof-of-possession. Fail closed (drop to 402) if it's missing or bad.
  if (popBoundAddress(r.claims)) {
    const proof = req.headers.get(PROOF_HEADER);
    if (!proof) return false;
    if (!(await verifyPopProof(proof, { claims: r.claims, slug, identity, now: Date.now() }))) return false;
  }
  return true;
}

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
  // gate-controlled forwarding facts (set below, never trusted from the client)
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
]);

/** Pull the classifier's inputs out of the raw request. */
function signalsFrom(req: Request): RequestSignals {
  const headers = Object.fromEntries(req.headers.entries());
  return {
    userAgent: headers["user-agent"] ?? "",
    hasPaymentHeader: PAYMENT_SIGNATURE_HEADER in headers,
    declaredAgentId: headers["x-naulon-agent"] ?? null,
    accept: headers["accept"] ?? "",
    headers,
  };
}

/**
 * The request facts the Web Bot Auth verifier serializes signed components
 * from. `authority` is the resolved tenant Host — the same identity the gate
 * routes by — so a signature over `@authority` binds to the host being tolled.
 */
function requestFactsFrom(req: Request, host: string): RequestFacts {
  const url = new URL(req.url);
  return {
    authority: host,
    method: req.method,
    path: url.pathname,
    targetUri: `${url.protocol}//${host}${url.pathname}${url.search}`,
    headers: Object.fromEntries(req.headers.entries()),
  };
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

/** Proxy a request to the publisher's origin and return its response verbatim. */
async function proxyToOrigin(
  req: Request,
  path: string,
  clientIp: string,
  originUrl: string,
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
  const upstream = await fetch(target, {
    method: req.method,
    headers: forwardHeaders(req, clientIp, new URL(originUrl).host),
    body: ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer(),
    redirect: "manual",
  });
  // Clone into a fresh, mutable Headers (fetch's are immutable once attached to
  // a Response) and drop encoding/length — fetch already decoded the body.
  const headers = new Headers(upstream.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(upstream.body, { status: upstream.status, headers });
}

/** Escape regex metacharacters so a prefix is matched literally. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Compiled article-path matchers, memoized per prefix set — a gate sees a handful
// of distinct prefix configs, not one per request, so we compile each regex once
// and reuse it rather than rebuilding it on every call. Prefixes are escaped
// before interpolation: an injected resolver may feed untrusted publisher prefixes
// here, so a literal `new RegExp(prefix)` would be a regex injection / ReDoS hole.
const articleReCache = new Map<string, RegExp>();
function articleRe(prefixes: string[]): RegExp {
  const key = prefixes.join("|");
  let re = articleReCache.get(key);
  if (!re) {
    re = new RegExp(`^/(?:${prefixes.map(escapeRe).join("|")})/([^/?#]+)`);
    articleReCache.set(key, re);
  }
  return re;
}

/** Article slug from a path like /essays/on-stillness, using the publisher's prefixes. */
function slugFromPath(path: string, prefixes: string[]): string | null {
  // Never treat the gate's own control routes as articles, whatever the
  // configured prefixes are.
  if (path.startsWith("/.well-known/") || path.startsWith("/licenses/")) return null;
  // Drop empty prefixes — an empty alternative would make the regex match `//x`
  // or any leading slash and gate routes the publisher never opted in.
  const clean = prefixes.filter(Boolean);
  if (clean.length === 0) return null;
  const m = path.match(articleRe(clean));
  return m ? decodeURIComponent(m[1]!) : null;
}

const STATIC_EXT_RE = /\.(css|js|mjs|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|pdf|txt|xml|json)$/i;
const DISCOVERY_RE = /^\/(robots\.txt|sitemap[^/]*|rss[^/]*|atom[^/]*|feed[^/]*|favicon\.ico)$/i;

/**
 * Site-mode slug: the full decoded pathname, or null for the surfaces that must
 * stay free — gate control routes, discovery (robots/sitemaps/feeds/favicon),
 * static assets by extension (deliberately including .txt/.xml/.json: machine-
 * readable surfaces never toll — the conservative humans/discovery-free bias),
 * and the publisher's own excludePrefixes.
 */
function slugFromSitePath(path: string, excludePrefixes: string[]): string | null {
  const pathname = path.split(/[?#]/, 1)[0]!;
  if (pathname.startsWith("/.well-known/") || pathname.startsWith("/licenses/")) return null;
  if (DISCOVERY_RE.test(pathname) || STATIC_EXT_RE.test(pathname)) return null;
  const clean = excludePrefixes.filter(Boolean);
  if (clean.some((p) => pathname === `/${p}` || pathname.startsWith(`/${p}/`))) return null;
  return decodeURIComponent(pathname);
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
export function createApp(resolver: PublisherResolver = envPublisherResolver()): Hono {
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
      const res = await proxyToOrigin(c.req.raw, path, clientIp, publisher.originUrl);
      res.headers.set("X-Naulon-Verdict", "suspended (degraded passthrough)");
      return res;
    }

    const slug =
      publisher.gateScope?.mode === "site"
        ? slugFromSitePath(path, publisher.gateScope.excludePrefixes)
        : slugFromPath(path, publisher.articlePrefixes);

    // Non-article routes: pure passthrough (assets, home, RSS...).
    if (!slug) return proxyToOrigin(c.req.raw, path, clientIp, publisher.originUrl);

    // Web Bot Auth: verify cryptographic identity once per gateable request.
    // Requests without the three signature headers short-circuit to "absent"
    // before any async work — zero cost for the entire unsigned world. Fail-open
    // discipline lives in the verifier: "invalid" (a PRESENTED signature that is
    // wrong) still serves via the UA path but is stamped `sigInvalid` on the
    // observation — masquerade telemetry no proxy-side product can give an
    // origin-level publisher.
    const botAuth = await verifyBotAuth(requestFactsFrom(c.req.raw, host), {
      allowInsecureHttp: cfg.BOT_AUTH_ALLOW_HTTP,
    });
    const verifiedAgent = botAuth.status === "verified" ? botAuth.agent : null;
    const sigInvalid = botAuth.status === "invalid" ? true : undefined;

    // Publisher-refused crawlers: 403 BEFORE classification, so payment intent
    // (classify's first check) can never buy past a block, and before the allow
    // merge, so block wins an overlap. Gateable routes only — the passthrough
    // above is untouched. Fragments name bots; a real browser UA never carries
    // one, so humans-read-free holds. The same fragments match the VERIFIED
    // identity too — a blocked operator cannot dodge the block by UA rotation.
    const uaRaw = c.req.header("user-agent") ?? "";
    const blockedFrag =
      matchUaFragment(uaRaw, publisher.crawlerPolicy?.block) ??
      (verifiedAgent ? matchUaFragment(verifiedAgent.agent, publisher.crawlerPolicy?.block) : undefined);
    if (blockedFrag) {
      observe({
        id: randomUUID(),
        publisherId: publisher.id,
        host,
        slug,
        verdict: "blocked",
        classifiedAs: "agent",
        classifyReason: `crawler blocked by publisher ("${blockedFrag}")`,
        agentUa: uaRaw,
        verified: verifiedAgent ? true : undefined,
        verifiedAgent: verifiedAgent?.agent,
        sigInvalid,
        at: Date.now(),
      });
      const res = c.text("This crawler is refused by the publisher.", 403);
      res.headers.set("X-Naulon-Verdict", headerSafe(`blocked ("${blockedFrag}")`));
      return stampGateCacheHeaders(res, { noStore: true });
    }

    const verdict = classify(
      { ...signalsFrom(c.req.raw), verifiedAgent },
      {
        seoAllowlist: [...(publisher.seoAllowlist ?? []), ...(publisher.crawlerPolicy?.allow ?? [])],
        chargeList: publisher.crawlerPolicy?.charge,
      },
    );

    // Audit plane: emit one observation per gated-route decision (telemetry only,
    // never gates the request). Default sink is off → a no-op, zero cost. A
    // multi-tenant deploy turns it on to see who was served free / denied / paid —
    // the negative space the settlement ledger can't record. publisher.id and the
    // classifier verdict are known here; price/kind are added once priced.
    const agentUa = c.req.header("user-agent");
    const recordObs = (v: ObservationVerdict, extra?: { kind?: TollKind; price?: Usdc }): void =>
      observe({
        id: randomUUID(),
        publisherId: publisher.id,
        host,
        slug,
        kind: extra?.kind,
        verdict: v,
        classifiedAs: verdict.kind,
        classifyReason: verdict.reason,
        agentUa,
        verified: verifiedAgent ? true : undefined,
        verifiedAgent: verifiedAgent?.agent,
        sigInvalid,
        price: extra?.price,
        at: Date.now(),
      });

    // Humans read free, forever. Set the verdict on the proxied Response itself
    // (a fresh Response from proxyToOrigin doesn't inherit c.header()), matching
    // the paid/reread paths so the verdict is observable on every gated route.
    if (verdict.kind === "human") {
      recordObs("served-free");
      const res = await proxyToOrigin(c.req.raw, path, clientIp, publisher.originUrl);
      res.headers.set("X-Naulon-Verdict", headerSafe(`human (${verdict.reason})`));
      return stampGateCacheHeaders(res, { noStore: false });
    }

    // Machine. What's it asking for?
    const kind: TollKind = c.req.header("x-naulon-kind") === "citation" ? "citation" : "read";

    // Already paid? A valid, unexpired license scoped to this slug+kind re-reads
    // free — the entitlement that makes the receipt worth keeping. Fails closed:
    // an invalid/expired/mismatched license falls through to the normal 402.
    const presentedLicense = c.req.header(LICENSE_HEADER);
    if (
      presentedLicense &&
      (await licenseEntitlesRead(presentedLicense, slug, kind, c.req.raw, publisher.licenseIdentity))
    ) {
      recordObs("agent-reread", { kind });
      const res = await proxyToOrigin(c.req.raw, path, clientIp, publisher.originUrl);
      res.headers.set("X-Naulon-Verdict", "agent reread (license)");
      return stampGateCacheHeaders(res, { noStore: true });
    }

    // Price it.
    const q = await quote(publisher, slug, kind);
    if (!q) return proxyToOrigin(c.req.raw, path, clientIp, publisher.originUrl); // unknown article — don't gate.

    const now = Date.now();
    const resourceUrl = new URL(c.req.url).toString();
    const { legs, header } = build402(q, resourceUrl, now);

    const payment = c.req.header(PAYMENT_SIGNATURE_HEADER);
    if (!payment) {
      // x402 contract: 402 with the requirement in the PAYMENT-REQUIRED header.
      // Link header points an agent at the toll manifest (discoverability).
      // The "scrape attempt, blocked" datum: an agent priced out at the 402.
      recordObs("denied", { kind, price: usdc(q.price) });
      return stampGateCacheHeaders(
        c.body(null, 402, {
          [PAYMENT_REQUIRED_HEADER]: header,
          Link: PAYMENT_LINK_HEADER,
          "X-Naulon-Verdict": headerSafe(`agent (${verdict.reason})`),
        }),
        { noStore: true },
      );
    }

    const result = await verifyAndSettle(payment, legs, now, publisher.id);
    if (!result.ok) {
      recordObs("payment-failed", { kind, price: usdc(q.price) });
      return stampGateCacheHeaders(
        c.json({ error: result.error }, 402, {
          [PAYMENT_REQUIRED_HEADER]: header,
          Link: PAYMENT_LINK_HEADER,
        }),
        { noStore: true },
      );
    }

    // Paid. Build the attributed event (full recursive split).
    const payerResolved = /^0x[0-9a-fA-F]{40}$/.test(result.payer ?? "") ? result.payer! : ZERO_ADDRESS;
    const event: AttributedEvent = {
      // Full UUID — this is also the license `jti`. A sliced/derived id risks a
      // collision that would make the supabase ignore-duplicates path silently
      // drop a second paid event and make /licenses/:jti return the wrong one.
      id: randomUUID(),
      // Attribute the event to the resolved publisher (the default resolver's id is
      // "default"). A single optional tag; the single-tenant drain never reads it.
      publisherId: publisher.id,
      slug: q.slug,
      kind: q.kind,
      amount: usdc(q.price),
      payees: q.payees,
      payerAddress: walletAddress(payerResolved),
      settlementRef: result.settlementRef ?? "unknown",
      at: now,
    };

    // Mint the receipt from the IN-MEMORY event, before persisting — money has
    // already moved, so a ledger hiccup must never cost the agent its license or
    // turn a paid request into a 402. Skip minting only when we couldn't resolve a
    // real payer (a zero-address bearer token would be unscoped).
    let licenseJws: string | undefined;
    if (licensing && payerResolved !== ZERO_ADDRESS) {
      licenseJws = mintLicense(
        {
          event,
          issuer: publisher.licenseIdentity,
          audience: publisher.licenseIdentity,
          ttlSeconds: cfg.LICENSE_TTL_SECONDS,
          payeesMode: cfg.LICENSE_PAYEES_MODE,
          tieBreak: cfg.PRIMARY_PAYEE_TIEBREAK,
          title: q.title,
          network: LICENSE_NETWORK,
          // Holder-of-key: bind to the (already non-zero) payer wallet so re-reads
          // need a proof-of-possession. Off → a v1 bearer license, demo unchanged.
          popBindAddress: cfg.LICENSE_POP ? payerResolved : undefined,
        },
        licensing.key,
        now,
      );
    }

    // Persist best-effort. A failure here is logged, never surfaced to the agent
    // (it already paid and holds a valid receipt).
    await record(event).catch((err: unknown) => {
      console.error("[tollgate] ledger write failed (payment already settled on-chain):", err);
    });

    // Report the settlement to the publisher's earnings ledger (wire #3). Fire and
    // forget — never delay the agent's content on the publisher's RTT; the
    // background drain guarantees eventual delivery if this attempt misses. Dark
    // without the publisher's settlement secret; idempotent on event.id; never throws.
    void emitSettlement(event, publisher.settlementSecret, publisher.originUrl).catch((err: unknown) => {
      console.error("[tollgate] settlement emit threw (payment already settled):", err);
    });

    // Audit plane: the paid outcome on the same timeline as denials/free reads.
    recordObs("paid", { kind: q.kind, price: usdc(q.price) });

    const res = await proxyToOrigin(c.req.raw, path, clientIp, publisher.originUrl);
    if (result.responseHeader) res.headers.set(PAYMENT_RESPONSE_HEADER, result.responseHeader);
    if (licenseJws) res.headers.set(LICENSE_HEADER, licenseJws);
    res.headers.set("X-Naulon-Verdict", headerSafe(`agent paid (${verdict.reason})`));
    return stampGateCacheHeaders(res, { noStore: true });
  });

  return app;
}

/**
 * The default, single-tenant app instance. The runtime entrypoints wrap this:
 * `index.ts` runs it under @hono/node-server, `api/index.ts` adapts it to a
 * Vercel function. A downstream embedder builds its own via `createApp(resolver)`.
 */
export const app = createApp();
