/**
 * Per-path price rules — what a publisher charges for one SECTION of their site, rather
 * than one price for everything.
 *
 * The whole module is two functions with opposite jobs, and keeping them apart is the point:
 * `normalizePriceRules` runs once on the WRITE path and may throw a sentence a person can act
 * on; `resolvePriceRule` runs on every priced request and can only ever pick, never fail.
 *
 * ## One pattern dialect: RFC 9309
 *
 * Not a bespoke glob. RSL 1.0 requires RFC 9309 for `content@url`, the RSL documents this core's
 * consumers publish already carry that shape (`/prefix/*`), and a licence scope already matches
 * with it (`license.ts` → `matchesPattern`). So a price rule projects
 * 1:1 into an RSL `<content>` block instead of being translated into one, and the gate, the
 * licence and the published terms cannot disagree about which paths a rule covers.
 *
 * ## Overlap RESOLVES; it is not refused
 *
 * The design spec proposed refusing overlapping rules at the write path, by analogy with
 * `normalizeCrawlerPolicy`, which rejects overlapping crawler fragments because "which state
 * did they mean?" is a user error. That analogy does not carry, for two reasons:
 *
 *  - **Crawler fragments have no natural order; paths do.** RFC 9309 §2.2.2 settles the
 *    equivalent question with "the most specific match wins", RSL 1.0 states the same rule
 *    for its own declarations, and `specificity()` already implements it in this repo for
 *    exactly that purpose. There is no ambiguity to refuse.
 *  - **Refusing overlap removes the most ordinary thing a publisher wants to say.**
 *    "Everything under /papers costs $0.05, except the free preview" is two overlapping
 *    rules and one intent. A rule list that cannot express it is a worse product than one
 *    that resolves it deterministically and shows the publisher the order.
 *
 * What IS ambiguous is the same pattern written twice with different prices, and that is
 * refused. Rules are stored specificity-sorted, so the stored order IS the resolution order
 * and the editor can render it without inventing a second explanation of precedence.
 *
 * ## `free` is not expressible here
 *
 * `priceUsdc: 0` is refused. A hosted control plane built on this core fails closed on a quote
 * whose `price <= 0`, and nothing below `USDC_FLOOR` can settle at all, so a zero rule would
 * store an intent the money path can never honour — the publisher would save successfully and
 * get a refused settle with no error to read. Free stays what it already is: `excludePrefixes`,
 * `credits_free_slugs`, or a 404 from the credits source.
 */
import { matchesPattern, specificity } from "@naulon/sdk/rsl";
import { USDC_FLOOR } from "./types.ts";

/**
 * One price rule. Both money fields are optional and absent means INHERIT the site value —
 * a rule that raises the citation multiple on one section without touching its read price is
 * a real thing to want, and spelling it means writing only the field you are changing.
 */
export interface PriceRule {
  /** RFC 9309 path pattern — robots.txt syntax, `*` and a trailing `$`. Leading slash. */
  pattern: string;
  /** Absent ⇒ inherit the site base price. */
  priceUsdc?: number;
  /** Absent ⇒ inherit the site citation multiplier. */
  citationMultiplier?: number;
}

/** More than this is not a pricing policy, it is an import that went wrong. */
export const MAX_PRICE_RULES = 50;
/** Longer than this is not a path pattern. The longest real URL path we serve is ~120. */
export const MAX_PATTERN_LEN = 200;

/** Printable ASCII, space excluded — the only bytes a URL path pattern may carry verbatim. */
const PRINTABLE_PATH = /^[\x21-\x7e]+$/;

/**
 * Normalise a publisher's rule list for storage, or throw with a message a person can act on.
 *
 * Returns a NEW array sorted most-specific-first — the order `resolvePriceRule` scans and the
 * order an editor should render. Never mutates the input. Ties (two different patterns of equal
 * specificity that could both match one path) keep their authored order, which is a stable
 * sort's own guarantee and is asserted by the tests rather than left to the engine.
 */
/**
 * Validate ONE RFC 9309 path pattern; return it trimmed, or throw a sentence a person can act on.
 *
 * `label` names the list the pattern came from ("price rule", "licence scope") so the message says
 * WHICH list is wrong, which is the only thing the caller knows and the validator does not.
 *
 * Shared by price rules and licence scopes deliberately. The header above is a warning about what
 * a second pattern dialect costs; two validators of one dialect is that second dialect with extra
 * steps, and it drifts the first time one of them learns a rule the other does not.
 */
export function normalizePathPattern(pattern: unknown, label: string): string {
  if (typeof pattern !== "string") throw new Error(`a ${label} has no pattern`);
  const p = pattern.trim();
  if (p === "") throw new Error(`a ${label} has an empty pattern`);
  if (!p.startsWith("/")) {
    throw new Error(`${label} "${p}" must start with "/" — an RFC 9309 pattern is an absolute path`);
  }
  if (p.length > MAX_PATTERN_LEN) {
    throw new Error(`${label} "${p.slice(0, 40)}…" is too long (max ${MAX_PATTERN_LEN})`);
  }
  // A pattern reaches a path comparison. Whitespace or a control character in it is a matcher
  // operating on something that is not a path, and it is far likelier to be a paste artefact
  // than an intent — a URL path carries %20, never a raw space.
  if (!PRINTABLE_PATH.test(p)) {
    throw new Error(`${label} "${p}" has a character that is not printable ASCII — percent-encode it (a space is %20)`);
  }
  return p;
}

/**
 * Validate a LIST of patterns and return it deduped and most-specific-first — the order
 * `matchesPattern` scanning should follow, the same order `normalizePriceRules` returns.
 *
 * `max` is the caller's ceiling: a price list and a licence scope have different reasons to cap,
 * so neither number belongs here.
 */
export function normalizePathPatterns(
  input: readonly unknown[],
  label: string,
  max: number,
): string[] {
  if (input.length > max) throw new Error(`too many ${label} patterns (max ${max})`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const p = normalizePathPattern(raw, label);
    if (seen.has(p)) {
      throw new Error(`${label} "${p}" is listed twice`);
    }
    seen.add(p);
    out.push(p);
  }
  return out.sort((a, b) => specificity(b) - specificity(a));
}

export function normalizePriceRules(input: readonly unknown[]): PriceRule[] {
  if (input.length > MAX_PRICE_RULES) {
    throw new Error(`priceRules exceeds ${MAX_PRICE_RULES} entries`);
  }
  const seen = new Set<string>();
  const out: PriceRule[] = [];

  for (const raw of input) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("priceRules contains an entry that is not an object");
    }
    const { pattern, priceUsdc, citationMultiplier } = raw as Record<string, unknown>;

    const p = normalizePathPattern(pattern, "price rule");
    if (seen.has(p)) {
      throw new Error(`price rule "${p}" is listed twice — two prices for one pattern have no resolution order`);
    }

    const rule: PriceRule = { pattern: p };

    if (priceUsdc !== undefined && priceUsdc !== null) {
      if (typeof priceUsdc !== "number" || !Number.isFinite(priceUsdc)) {
        throw new Error(`price rule "${p}" has a price that is not a number`);
      }
      // Deliberately NOT `>= 0`. See the header: a zero-priced rule stores an intent the settle
      // path refuses, which is worse than refusing it here where there is somewhere to say why.
      if (priceUsdc < USDC_FLOOR) {
        throw new Error(
          `price rule "${p}" is priced below ${USDC_FLOOR} USDC, which cannot settle — to make a section free use its exclude list, not a rule`,
        );
      }
      rule.priceUsdc = priceUsdc;
    }

    if (citationMultiplier !== undefined && citationMultiplier !== null) {
      if (typeof citationMultiplier !== "number" || !Number.isFinite(citationMultiplier)) {
        throw new Error(`price rule "${p}" has a citation multiplier that is not a number`);
      }
      if (citationMultiplier <= 0) {
        throw new Error(
          `price rule "${p}" has a citation multiplier of ${citationMultiplier} — it must be greater than zero`,
        );
      }
      rule.citationMultiplier = citationMultiplier;
    }

    // A rule that overrides neither field is a row a publisher will read as doing something.
    if (rule.priceUsdc === undefined && rule.citationMultiplier === undefined) {
      throw new Error(`price rule "${p}" sets neither a price nor a citation multiplier — it would change nothing`);
    }

    seen.add(p);
    out.push(rule);
  }

  // Most specific first. `sort` is stable in every runtime we target (ES2019 requires it), so
  // equal-specificity rules keep the order the publisher wrote them in.
  return out.sort((a, b) => specificity(b.pattern) - specificity(a.pattern));
}

/**
 * The rule that governs `path`, or undefined when none does.
 *
 * Pure, synchronous and allocation-free on the miss path — it runs inside the price formula on
 * every priced request. It assumes the list is already normalised (most-specific-first); an
 * un-normalised list still resolves, just in the caller's order, which is why normalisation is
 * the write path's job and not re-done here per request.
 */
export function resolvePriceRule(
  rules: readonly PriceRule[] | undefined,
  path: string | undefined,
): PriceRule | undefined {
  if (!rules || rules.length === 0 || path === undefined) return undefined;
  for (const rule of rules) {
    if (matchesPattern(rule.pattern, path)) return rule;
  }
  return undefined;
}
