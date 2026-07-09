/**
 * Runtime-agnostic, PRE-SETTLEMENT toll decision.
 *
 * This is the single decision path the `createApp` proxy weld used to inline.
 * Extracting it lets any runtime — the gate's Hono reverse proxy OR the
 * `@naulon/sdk` in-app middleware — reach the SAME verdict from a web `Request`
 * without dragging along the gate's proxy / observe / settle side effects.
 *
 * `decide()` performs NO side effects: no `observe`, no `proxyToOrigin`, no
 * `verifyAndSettle`, no `record`/`emitSettlement`/`mintLicense`. It stops at "here
 * is the verdict, and — for a machine — the 402 legs + header and the payment to
 * settle." The CALLER settles, observes, and proxies. To keep the caller's audit
 * plane byte-identical, every observed variant carries an `obs` facts payload
 * (the classifier verdict + Web-Bot-Auth signals the `observe(...)` call needs).
 *
 * Preconditions the caller enforces BEFORE calling: the publisher is KNOWN
 * (unknown-host already failed closed) and NOT suspended (a paused publisher
 * proxies straight through, free). `decide()` assumes a known, live publisher.
 */
import { classify, matchUaFragment, type RequestSignals, type Verdict } from "./agentDetect.ts";
import { verifyBotAuth, type RequestFacts, type BotAuthOptions } from "./botAuth.ts";
import { build402, PAYMENT_SIGNATURE_HEADER, type SettlementLegReq } from "./x402.ts";
import type { Quote } from "./pricing.ts";
import { licensing } from "./license.ts";
import { revocations } from "./revocation.ts";
import { verifyPopProof } from "./pop.ts";
import {
  getConfig,
  popBoundAddress,
  verifyLicense,
  type PublisherConfig,
  type TollKind,
} from "@naulon/shared";

// Global license POLICY (online-check flag) is a gate-operator setting, read once.
const cfg = getConfig();

/** The header that carries a Citation License Token, both ways. */
export const LICENSE_HEADER = "X-Naulon-License";
/** The header that carries a holder-of-key proof-of-possession on a re-read. */
export const PROOF_HEADER = "X-Naulon-Proof";

/**
 * A presented license entitles a free re-read iff it verifies AND is scoped to
 * this exact slug, this publisher (aud === the publisher's licenseIdentity), and
 * covers the requested kind (a citation license entitles a read, never the
 * reverse). Fails closed — any defect drops the caller to the normal 402 path.
 * Revocation is consulted only when the online check is enabled (needs shared state).
 */
export async function licenseEntitlesRead(
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

/** Pull the classifier's inputs out of the raw request. */
export function signalsFrom(req: Request): RequestSignals {
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
 * The request facts the Web Bot Auth verifier serializes signed components from.
 * `authority` is the resolved tenant Host — the same identity the gate routes by —
 * so a signature over `@authority` binds to the host being tolled.
 */
export function requestFactsFrom(req: Request, host: string): RequestFacts {
  const url = new URL(req.url);
  return {
    authority: host,
    method: req.method,
    path: url.pathname,
    targetUri: `${url.protocol}//${host}${url.pathname}${url.search}`,
    headers: Object.fromEntries(req.headers.entries()),
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Compiled article-path matchers, memoized per prefix set — a gate sees a handful
// of distinct prefix configs, not one per request, so we compile each regex once
// and reuse it. Prefixes are escaped before interpolation: an injected resolver may
// feed untrusted publisher prefixes here, so a literal `new RegExp(prefix)` would be
// a regex injection / ReDoS hole.
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
export function slugFromPath(path: string, prefixes: string[]): string | null {
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
export function slugFromSitePath(path: string, excludePrefixes: string[]): string | null {
  const pathname = path.split(/[?#]/, 1)[0]!;
  if (pathname.startsWith("/.well-known/") || pathname.startsWith("/licenses/")) return null;
  if (DISCOVERY_RE.test(pathname) || STATIC_EXT_RE.test(pathname)) return null;
  const clean = excludePrefixes.filter(Boolean);
  if (clean.some((p) => pathname === `/${p}` || pathname.startsWith(`/${p}/`))) return null;
  return decodeURIComponent(pathname);
}

/**
 * The classification facts an observed decision carries so the caller can emit a
 * byte-identical `observe(...)` — the classifier verdict + Web-Bot-Auth signals.
 */
export interface DecideObs {
  classifiedAs: Verdict["kind"];
  classifyReason: string;
  agentUa?: string;
  verified?: true;
  verifiedAgent?: string;
  sigInvalid?: true;
}

/**
 * The pre-settlement verdict. `passthrough` proxies untouched (no observe).
 * `payment-presented` hands the caller the buyer's payment + legs to settle.
 */
export type Decision =
  | { kind: "passthrough"; verdict: "non-article" | "unknown-article" }
  | { kind: "free"; verdict: string; obs: DecideObs }
  | { kind: "blocked"; frag: string; obs: DecideObs }
  | { kind: "reread"; tollKind: TollKind; obs: DecideObs }
  | { kind: "payment-required"; legs: SettlementLegReq[]; header: string; quote: Quote; tollKind: TollKind; obs: DecideObs }
  | { kind: "payment-presented"; payment: string; legs: SettlementLegReq[]; header: string; quote: Quote; tollKind: TollKind; obs: DecideObs };

export interface DecideInput {
  /** The raw web request being decided. */
  raw: Request;
  /** The resolved tenant Host (the identity the gate routes + Bot-Auth binds to). */
  host: string;
  /** `URL.pathname + URL.search` — the slug matcher's input. */
  path: string;
  /** The resolved, KNOWN, non-suspended publisher (caller enforced both). */
  publisher: PublisherConfig;
  /** Single timestamp for build402; the caller reuses it for settle/event/mint. */
  now: number;
  /** Price + payees resolver — local (own data) or hosted (`/quote`). */
  quote: (publisher: PublisherConfig, slug: string, kind: TollKind) => Promise<Quote | null | undefined>;
  /** Web-Bot-Auth options (e.g. `allowInsecureHttp` on a dev/plaintext origin). */
  botAuthOpts?: BotAuthOptions;
}

export async function decide(input: DecideInput): Promise<Decision> {
  const { raw, host, path, publisher, now, quote } = input;

  const slug =
    publisher.gateScope?.mode === "site"
      ? slugFromSitePath(path, publisher.gateScope.excludePrefixes)
      : slugFromPath(path, publisher.articlePrefixes);

  // Non-article routes: pure passthrough (assets, home, RSS...).
  if (!slug) return { kind: "passthrough", verdict: "non-article" };

  // Web Bot Auth: verify cryptographic identity once per gateable request.
  // Unsigned requests short-circuit to "absent" inside the verifier — zero cost.
  const botAuth = await verifyBotAuth(requestFactsFrom(raw, host), input.botAuthOpts ?? {});
  const verifiedAgent = botAuth.status === "verified" ? botAuth.agent : null;
  const sigInvalid = botAuth.status === "invalid" ? true : undefined;

  // Publisher-refused crawlers: 403 BEFORE classification, so payment intent can
  // never buy past a block, and before the allow merge, so block wins an overlap.
  // The same fragments match the VERIFIED identity too — no UA-rotation dodge.
  const uaRaw = raw.headers.get("user-agent") ?? "";
  const blockedFrag =
    matchUaFragment(uaRaw, publisher.crawlerPolicy?.block) ??
    (verifiedAgent ? matchUaFragment(verifiedAgent.agent, publisher.crawlerPolicy?.block) : undefined);
  if (blockedFrag) {
    return {
      kind: "blocked",
      frag: blockedFrag,
      obs: {
        classifiedAs: "agent",
        classifyReason: `crawler blocked by publisher ("${blockedFrag}")`,
        agentUa: uaRaw,
        verified: verifiedAgent ? true : undefined,
        verifiedAgent: verifiedAgent?.agent,
        sigInvalid,
      },
    };
  }

  const verdict = classify(
    { ...signalsFrom(raw), verifiedAgent },
    {
      seoAllowlist: [...(publisher.seoAllowlist ?? []), ...(publisher.crawlerPolicy?.allow ?? [])],
      chargeList: publisher.crawlerPolicy?.charge,
    },
  );

  const obs: DecideObs = {
    classifiedAs: verdict.kind,
    classifyReason: verdict.reason,
    agentUa: raw.headers.get("user-agent") ?? undefined,
    verified: verifiedAgent ? true : undefined,
    verifiedAgent: verifiedAgent?.agent,
    sigInvalid,
  };

  // Humans read free, forever.
  if (verdict.kind === "human") return { kind: "free", verdict: `human (${verdict.reason})`, obs };

  // Machine. What's it asking for?
  const tollKind: TollKind = raw.headers.get("x-naulon-kind") === "citation" ? "citation" : "read";

  // Already paid? A valid, unexpired license scoped to this slug+kind re-reads free.
  // Fails closed: an invalid/expired/mismatched license falls through to the 402.
  const presentedLicense = raw.headers.get(LICENSE_HEADER);
  if (
    presentedLicense &&
    (await licenseEntitlesRead(presentedLicense, slug, tollKind, raw, publisher.licenseIdentity))
  ) {
    return { kind: "reread", tollKind, obs };
  }

  // Price it.
  const q = await quote(publisher, slug, tollKind);
  if (!q) return { kind: "passthrough", verdict: "unknown-article" }; // unknown article — don't gate.

  const { legs, header } = build402(q, new URL(raw.url).toString(), now);

  const payment = raw.headers.get(PAYMENT_SIGNATURE_HEADER);
  return payment
    ? { kind: "payment-presented", payment, legs, header, quote: q, tollKind, obs }
    : { kind: "payment-required", legs, header, quote: q, tollKind, obs };
}
