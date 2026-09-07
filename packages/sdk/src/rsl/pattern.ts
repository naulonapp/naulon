/**
 * RFC 9309 path-pattern matching — the grammar RSL borrows for `content@url`.
 *
 * This is NOT `crawl/glob.ts`. That module's grammar is a filesystem-ish glob (`*` stops at `/`,
 * `**` crosses segments, `?` is one char) written for filtering a sitemap. RFC 9309 — robots.txt —
 * is a different language with two rules: `*` matches ANY run of characters including `/`, and a
 * trailing `$` anchors the end of the path. Everything else is a literal PREFIX match.
 *
 * Mixing them up is silent and expensive: under glob semantics `/articles/*` would fail to match
 * `/articles/2026/x`, so a crawler would read a priced article believing it was unlicensed. The two
 * grammars stay in two files precisely so neither can be edited into the other by accident.
 */

/** Compile one RFC 9309 pattern to an anchored RegExp. */
function toRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  let re = "";
  for (const ch of body) {
    if (ch === "*") re += ".*";
    // `$` inside the pattern (not the final char) is a literal per RFC 9309 — only the trailing one
    // is the end-of-match operator.
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}${anchored ? "$" : ""}`);
}

const cache = new Map<string, RegExp>();
function compiled(pattern: string): RegExp {
  let re = cache.get(pattern);
  if (!re) {
    re = toRegExp(pattern);
    cache.set(pattern, re);
  }
  return re;
}

/**
 * Does this RFC 9309 pattern cover this URL path?
 *
 * `path` is a pathname (`/articles/x`), never a full URL — the caller has already decided the
 * origin matches, and feeding a full URL here would let `https://evil.example/https://good.example`
 * satisfy a pattern written for the good origin.
 */
export function matchesPattern(pattern: string, path: string): boolean {
  if (pattern === "") return false; // association-scoped; the caller resolves it, not this matcher
  return compiled(pattern).test(path);
}

/**
 * How specific a pattern is, for RSL's "more specific declarations MUST take precedence".
 *
 * The spec states the rule and no algorithm for it. RFC 9309 §2.2.2 settles the equivalent question
 * for robots.txt with "the most specific match … the longest rule wins", and that is the convention
 * every crawler already implements, so it is what a publisher's expectations are calibrated to.
 *
 * Wildcards do not count toward length: `/*` is one literal character of specificity (`/`), not
 * two, otherwise `/*` (everything) would outrank `/a` (one path). This is the whole reason the
 * function is not `pattern.length`.
 */
export function specificity(pattern: string): number {
  const anchored = pattern.endsWith("$");
  const literals = (anchored ? pattern.slice(0, -1) : pattern).replace(/\*/g, "").length;
  // An anchored pattern is strictly more specific than the same prefix unanchored: `/a.pdf$`
  // describes exactly one path, `/a.pdf` describes a subtree.
  return literals * 2 + (anchored ? 1 : 0);
}
