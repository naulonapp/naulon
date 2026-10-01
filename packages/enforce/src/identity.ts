/**
 * Does the caller's address back the crawler its user-agent names?
 *
 * `checkIdentity` answers that per claim and never accuses on missing evidence: no usable client IP,
 * no ranges, stale ranges or a source not eligible to accuse all read `unverified`. Only
 * `classifyWithIdentity` acts on the answer, and only to withhold an allowlist's free read from an
 * armed, forged claim.
 */
import { claimsIn, CRAWLER_PROOF, CRAWLER_REGISTRY, isFresh, isUsablePublicIp, parseClientAddress } from "@naulon/shared";
import type { CompiledRanges, IdentityCheck, RangeSet } from "@naulon/shared";
import { classify, matchSignerHost, type ClassifyPolicy, type RequestSignals, type Verdict } from "./agentDetect.ts";

export interface IdentityClaim {
  operatorId: string;
  operator: string;
  fragment: string;
  check: IdentityCheck;
}

export interface IdentityResult {
  check: IdentityCheck;
  claims: IdentityClaim[];
}

export interface IdentityContext {
  ranges: CompiledRanges | null;
  clientIp: string | null;
  now: number;
}

export interface IdentityInput extends IdentityContext {
  isArmed(operatorId: string): boolean;
}

const RANK: Record<IdentityCheck, number> = { signature: 0, "ip-verified": 1, unverified: 2, forged: 3 };

/**
 * Whether a verified Web Bot Auth signer speaks for a crawler fragment: its host is the directory
 * the registry records for that fragment, or a subdomain of it. A valid signature from any other
 * host proves only who signed, not that the request is the crawler its user-agent names.
 */
export function signerBacks(signerHost: string, fragment: string): boolean {
  return CRAWLER_REGISTRY.some((r) => r.fragment === fragment && r.directoryHost !== undefined && matchSignerHost(signerHost, [r.directoryHost]) !== undefined);
}

export function checkIdentity(ua: string, signerHost: string | null, ctx: IdentityContext): IdentityResult | undefined {
  const table = ctx.ranges?.table ?? CRAWLER_PROOF;
  const found = claimsIn(ua, table);
  if (found.length === 0) return undefined;

  const ip = ctx.clientIp ? parseClientAddress(ctx.clientIp) : null;
  // A proxy's address is never the caller's: a real crawler does not originate inside a CDN's own
  // ranges, so an address there means the runtime read the proxy instead of the caller.
  const proxies: RangeSet[] = ctx.ranges ? [...ctx.ranges.proxies.values()] : [];
  const usable = ip !== null && isUsablePublicIp(ip, proxies);

  const claims: IdentityClaim[] = found.map(({ id, fragment }) => {
    const op = ctx.ranges?.operators.get(id);
    const operator = op?.operator ?? CRAWLER_PROOF.find((r) => r.id === id)?.operator ?? id;
    const at = (check: IdentityCheck): IdentityClaim => ({ operatorId: id, operator, fragment, check });
    if (signerHost !== null && signerBacks(signerHost, fragment)) return at("signature");
    if (!op || op.kind !== "ranges" || !usable || !ip) return at("unverified");
    if (op.set.has(ip)) return at("ip-verified");
    if (!op.forgedEligible || !isFresh(op, ctx.now)) return at("unverified");
    return at("forged");
  });
  const check = claims.reduce<IdentityCheck>((w, c) => (RANK[c.check] > RANK[w] ? c.check : w), "signature");
  return { check, claims };
}

/** The claim that set the overall check: the one an audit row should name. */
export function decidingClaim(result: IdentityResult): IdentityClaim | undefined {
  return result.claims.find((c) => c.check === result.check);
}

export function classifyWithIdentity(
  signals: RequestSignals,
  policy: ClassifyPolicy | undefined,
  mode: "off" | "auto",
  id: IdentityInput | undefined,
): { verdict: Verdict; identity?: IdentityResult; forgedClaim?: IdentityClaim } {
  if (mode === "off" || !id) return { verdict: classify(signals, policy) };
  const identity = checkIdentity(signals.userAgent, signals.verifiedAgent?.agent ?? null, id);
  const forgedClaim = identity?.claims.find((c) => c.check === "forged" && id.isArmed(c.operatorId));
  const verdict = classify(
    forgedClaim
      ? { ...signals, forgedClaim: { operatorId: forgedClaim.operatorId, operator: forgedClaim.operator, fragment: forgedClaim.fragment } }
      : signals,
    policy,
  );
  return { verdict, ...(identity ? { identity } : {}), ...(forgedClaim ? { forgedClaim } : {}) };
}
