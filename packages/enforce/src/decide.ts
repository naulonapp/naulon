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
import { build402, PAYMENT_SIGNATURE_HEADER, type SettlementLegReq } from "./build402.ts";
import type { Quote } from "./pricing.ts";
import { licensing } from "./license.ts";
import { revocations } from "./revocation.ts";
import { verifyPopProof } from "./pop.ts";
import { slugFromPath, slugFromSitePath } from "@naulon/sdk/slug";
import {
  externalSchemeOf,
  externalUrl,
  type ExternalSchemeOpts,
  getConfig,
  popBoundAddress,
  verifyLicense,
  type JwkSet,
  type PublisherConfig,
  type TollKind,
} from "@naulon/shared";

/**
 * How a re-read license is verified when the deployment MINTING the license is not
 * this process. In proxy mode the gate mints AND verifies with one local key, so the
 * module-global `licensing` (from `LICENSE_SIGNING_KEY`) is both. But an IN-APP
 * enforcer (API mode: the publisher runs `decide()` in its own runtime and settles
 * money via the hosted gate's `/verify`) receives licenses SIGNED BY THE GATE — its
 * local `licensing` is `null` (a consuming site sets no signing key), so without this
 * seam `licenseEntitlesRead` fails closed and every licensed re-read 402s. Injecting
 * the gate's published JWKS (`/.well-known/naulon-jwks.json`) + the issuer the gate
 * stamped lets the in-app enforcer verify a gate-minted license locally. Absent ⇒ the
 * module-global `licensing` path, byte-identical to before (proxy mode / the gate itself).
 */
export interface LicenseVerification {
  /** The minting authority's public keys — the gate's JWKS, fetched from its well-known. */
  jwks: JwkSet;
  /** The `iss`/`aud` the minting gate stamped for this publisher (= its `licenseIdentity`). */
  issuer: string;
}

// Global license POLICY (online-check flag) is a gate-operator setting, read once.
const cfg = getConfig();

// Re-exported for `@naulon/sdk/enforce` (the in-app middleware): the wire
// primitives a runtime needs to act on a `Decision` without pulling the whole
// gate (`app.ts` boots `createApp()` at import — the `./decide` subpath does not).
export {
  PAYMENT_SIGNATURE_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  type SettlementLegReq,
  type PaymentRequirements,
} from "./build402.ts";
export { PAYMENT_LINK_HEADER } from "./discoverability.ts";
export type { Quote } from "./pricing.ts";
export type { TollKind } from "@naulon/shared";

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
  /** Verify against the MINTING gate's JWKS + issuer instead of the local `licensing`
   *  (API mode — the license was signed by the hosted gate, not this process). Absent
   *  ⇒ the module-global `licensing` + `identity`, unchanged (proxy mode / the gate). */
  verification?: LicenseVerification,
): Promise<boolean> {
  // Effective verifier: the injected gate JWKS + issuer (API mode) wins; else the local
  // signing key's JWKS + the publisher identity (proxy mode). No local key AND no injected
  // verifier ⇒ nothing can verify a license here — fail closed exactly as before.
  const jwks = verification?.jwks ?? licensing?.jwks;
  if (!jwks) return false;
  // The identity that pins BOTH the license iss/aud AND the holder-of-key proof to the
  // minting deployment. In API mode this is the gate's stamped issuer, not the in-app
  // publisher default — using the wrong one is exactly the mismatch that 402s a valid license.
  const expected = verification?.issuer ?? identity;
  const r = verifyLicense(jws, {
    now: Date.now(),
    expectedIssuer: expected,
    expectedAudience: expected,
    jwks,
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
    if (!(await verifyPopProof(proof, { claims: r.claims, slug, identity: expected, now: Date.now() }))) return false;
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
export function requestFactsFrom(
  req: Request,
  host: string,
  /** Proxy-trust settings. Defaults to the process config; passed explicitly by tests
   *  so this stays a pure function of its arguments rather than of ambient env. */
  trust: ExternalSchemeOpts = { trustProxy: cfg.TRUST_PROXY, hops: cfg.TRUST_PROXY_HOPS },
): RequestFacts {
  const url = new URL(req.url);
  // `@target-uri` is a SIGNED component: the agent signed the URI it requested, which is
  // the public `https://` one. Reconstructing it from the socket scheme yields `http://`
  // behind a TLS-terminating edge, so the signature base differs by one character and
  // verification fails — silently downgrading a properly-signed agent to unverified.
  // `@authority` (host only) was never affected, which is why this hid: an agent that
  // covers `@authority` verified fine and one that covers `@target-uri` did not.
  const proto = externalSchemeOf(req, trust);
  return {
    authority: host,
    method: req.method,
    path: url.pathname,
    targetUri: `${proto}://${host}${url.pathname}${url.search}`,
    headers: Object.fromEntries(req.headers.entries()),
  };
}

// The article-key rule is NOT implemented here. It has exactly one owner —
// `@naulon/sdk/slug`, the bottom of the package graph — because the key the gate
// derives from a request path must be byte-identical to the key a crawler writes and
// the key a publisher's credits API answers at. Re-exported so `@naulon/enforce`'s
// public surface is unchanged for anyone already importing them from here.
export { deriveSlug, deriveSiteSlug, decodeSlug } from "@naulon/sdk/slug";
export { slugFromPath, slugFromSitePath };

/**
 * The classification facts an observed decision carries so the caller can emit a
 * byte-identical `observe(...)` — the classifier verdict + Web-Bot-Auth signals.
 */
export interface DecideObs {
  /** The gated slug — carried so the caller's `observe(...)` needs nothing decide computed. */
  slug: string;
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
  /** API mode — verify a re-read license against the MINTING gate's JWKS + issuer
   *  instead of the local `licensing` (which is null in a consuming site, so every
   *  licensed re-read would otherwise 402). Absent ⇒ proxy-mode behavior, unchanged. */
  licenseVerification?: LicenseVerification;
}

export async function decide(input: DecideInput): Promise<Decision> {
  const { raw, host, path, publisher, now, quote } = input;

  const slug =
    publisher.gateScope?.mode === "site"
      ? slugFromSitePath(path, publisher.gateScope.excludePrefixes, {
          includeExtensions: publisher.gateScope.includeExtensions,
        })
      : slugFromPath(path, publisher.articlePrefixes, {
          // Absent gateScope IS prefix mode, so read the depth off the union only when it is
          // actually the prefixes variant. Undefined ⇒ "segment", unchanged.
          depth: publisher.gateScope?.mode === "prefixes" ? publisher.gateScope.depth : undefined,
        });

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
        slug,
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
    slug,
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
    (await licenseEntitlesRead(presentedLicense, slug, tollKind, raw, publisher.licenseIdentity, input.licenseVerification))
  ) {
    return { kind: "reread", tollKind, obs };
  }

  // Price it.
  const q = await quote(publisher, slug, tollKind);
  if (!q) return { kind: "passthrough", verdict: "unknown-article" }; // unknown article — don't gate.

  // The resource identifier goes into a SIGNED quote, so it must be the URL the buyer
  // actually fetched — not the one this process observed. TLS terminates at the edge in
  // every real deployment, so `raw.url` reads `http:` for an `https:` read.
  const { legs, header } = build402(
    q,
    externalUrl(raw, { trustProxy: cfg.TRUST_PROXY, hops: cfg.TRUST_PROXY_HOPS }),
    now,
  );

  const payment = raw.headers.get(PAYMENT_SIGNATURE_HEADER);
  return payment
    ? { kind: "payment-presented", payment, legs, header, quote: q, tollKind, obs }
    : { kind: "payment-required", legs, header, quote: q, tollKind, obs };
}
