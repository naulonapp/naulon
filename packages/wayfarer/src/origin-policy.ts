/**
 * THE origin decision: may money touch this URL?
 *
 * There were two answers to that question in this codebase — `originPinRefusal` in
 * wayfarer-mcp (unconditional host:port equality) and the inline branch at the top of
 * decide()'s spend gates (equality UNLESS an allowlist is set). A comment asked the
 * second one not to drift from the first. It drifted anyway, and a third surface (the
 * cloud's /ask pay path) grew no check at all.
 *
 * A comment cannot hold an invariant. A type can. `authorizeOrigin` is the only
 * function that mints a `PayableTarget`, and the pay/probe entrypoints accept nothing
 * else — so a caller that skips the check does not compile.
 *
 * Two levels, deliberately distinct (the distinction predates this module and is
 * correct — see the header on `originPinRefusal`):
 *
 *   • ENDPOINT IDENTITY — host:port must equal the configured gate. A different port is
 *     a different service, so it must not satisfy the pin.
 *   • DOMAIN POLICY — an allowlist names domains ("inneraxiom.com"), never host:port.
 *     Setting one IS naming your trust boundary, which is why it is also what widens
 *     the pin: the fleet case (many publisher origins, no single gate) is the same
 *     statement of trust, not a second flag that could disagree with the first.
 *
 * This module answers only "whose origin". It never answers "how much" — price, caps,
 * kill-switch and human approval stay in `spendGate`, the one shared evaluator.
 */

declare const payable: unique symbol;

/**
 * A URL that has passed `authorizeOrigin`. Structurally a string, but nominally
 * unforgeable outside this module — pay/probe signatures take this, never `string`,
 * so "I forgot to check" is a type error rather than an incident.
 */
export type PayableTarget = string & { readonly [payable]: true };

/** What to authorize, and against what trust boundary. */
export interface OriginRequest {
  /** The URL money would touch. Model-supplied in the MCP tools — assume hostile. */
  target: string;
  /** The configured gate, when there is one. Absent in the fleet case. */
  gate?: string | undefined;
  /**
   * The domains this caller may pay. `undefined` = no policy stated, so the gate pin
   * is the whole boundary. An EMPTY array is a stated policy of "nothing", NOT
   * "unrestricted" — an operator whose tenant lookup returned nothing must get
   * refusals rather than an open wallet.
   */
  allowDomains?: readonly string[] | undefined;
}

export type OriginVerdict =
  | { ok: true; target: PayableTarget }
  | { ok: false; refusal: string };

/** Lowercased host INCLUDING port — endpoint identity. */
function hostOf(u: string): string | null {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Lowercased hostname EXCLUDING port — what domain policy matches on. */
function hostnameOf(u: string): string | null {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Decide whether `target` may be quoted or paid, and if so hand back the one token
 * the pay path accepts. Exact-match only at both levels: a subdomain is a different
 * host and is never implied by its parent, because "*.example" trust is a decision an
 * operator should have to write down.
 */
export function authorizeOrigin(req: OriginRequest): OriginVerdict {
  const { target, gate, allowDomains } = req;

  const host = hostOf(target);
  if (host === null) return { ok: false, refusal: `"${target}" is not a valid URL.` };

  // The gate satisfies the pin on endpoint identity, when one is configured.
  if (gate !== undefined) {
    const gateHost = hostOf(gate);
    if (gateHost === null) {
      return { ok: false, refusal: `the server's configured gate ("${gate}") is not a valid URL — fix TOLLGATE_URL.` };
    }
    if (host === gateHost) return { ok: true, target: target as PayableTarget };
  }

  // Otherwise the only way through is a stated domain policy.
  if (allowDomains !== undefined) {
    const hostname = hostnameOf(target);
    if (hostname !== null && allowDomains.some((d) => d.toLowerCase() === hostname)) {
      return { ok: true, target: target as PayableTarget };
    }
    return {
      ok: false,
      refusal:
        `refusing to touch ${host}: it is not on this server's allowed domains` +
        (gate === undefined ? "." : ` and is not the configured gate (${hostOf(gate)}).`),
    };
  }

  if (gate === undefined) {
    return {
      ok: false,
      refusal: `refusing to touch ${host}: no configured gate and no allowed domains — nothing is payable.`,
    };
  }
  return {
    ok: false,
    refusal:
      `refusing to touch ${host}: this server only quotes and pays at its configured gate (${hostOf(gate)}). ` +
      `Pass the slug instead of an off-gate url. The gate is server-config and cannot be changed from a tool.`,
  };
}
