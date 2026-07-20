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
 * Scope, deliberately narrow: this module owns ENDPOINT IDENTITY — host:port must equal
 * the configured gate, because a different port is a different service and must not
 * satisfy the pin. That is the whole of its authority.
 *
 * It does NOT own domain policy. An allowlist names domains ("inneraxiom.com"), and
 * which of them are payable — along with deny lists, per-domain caps, the kill switch
 * and human approval — belongs to `spendGate`, the one shared evaluator. Stating an
 * allowlist therefore REPLACES the gate pin rather than stacking with it: the operator
 * has named a boundary, so identity steps aside and spendGate adjudicates. Checking it
 * in both places would recreate the very divergence this module exists to end.
 *
 * So: "whose origin, by identity" here; "which domains, at what price" there. Neither
 * answers the other's question, and neither has a second implementation.
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

/**
 * Why a target was refused. Callers render their OWN prose from this — the research
 * path's skip reason and an MCP tool's refusal address different readers, and forcing
 * one wording on both would be a cosmetic unification of the wrong thing. The DECISION
 * is what must not diverge; the sentence may.
 */
export type OriginRefusalCode = "invalid-target" | "invalid-gate" | "off-gate";

export type OriginVerdict =
  | { ok: true; target: PayableTarget }
  | { ok: false; code: OriginRefusalCode; refusal: string };

/** Lowercased host INCLUDING port — endpoint identity. */
function hostOf(u: string): string | null {
  try {
    return new URL(u).host.toLowerCase();
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
  if (host === null) return { ok: false, code: "invalid-target", refusal: `"${target}" is not a valid URL.` };

  // The gate satisfies the pin on endpoint identity, when one is configured.
  if (gate !== undefined) {
    const gateHost = hostOf(gate);
    if (gateHost === null) {
      return {
        ok: false,
        code: "invalid-gate",
        refusal: `the server's configured gate ("${gate}") is not a valid URL — fix TOLLGATE_URL.`,
      };
    }
    if (host === gateHost) return { ok: true, target: target as PayableTarget };
  }

  // A stated domain boundary REPLACES the gate pin rather than stacking with it. Which
  // domains are payable is `spendGate`'s question, and it already answers it; answering it
  // here as well would be the second copy this module exists to prevent. So when the
  // operator has named a boundary, identity defers and spendGate adjudicates.
  //
  // An empty array counts as "stated" for the same reason: spendGate reads an empty
  // allowlist as deny-by-default, so deferring is strictly equivalent and keeps one owner.
  if (allowDomains !== undefined) return { ok: true, target: target as PayableTarget };

  // No gate configured and no allowlist stated ⇒ there is no identity boundary to apply,
  // so defer rather than invent one. Refusing here would read as safer and is not: it
  // would break the deny-list and per-domain-cap paths, which legitimately run with no
  // gateBase and rely on spendGate alone.
  //
  // "A deployment that enables buying must configure a gate" is a real requirement, but it
  // is a CONFIG-time one — a process that boots without it should fail to start, not
  // discover it per-candidate at pay time. That check belongs in the server's config
  // validation, not here.
  if (gate === undefined) return { ok: true, target: target as PayableTarget };

  return {
    ok: false,
    code: "off-gate",
    refusal:
      `refusing to touch ${host}: this server only quotes and pays at its configured gate (${hostOf(gate)}). ` +
      `Pass the slug instead of an off-gate url. The gate is server-config and cannot be changed from a tool.`,
  };
}
