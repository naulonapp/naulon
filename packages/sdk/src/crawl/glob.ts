/**
 * crawl/glob.ts — include/exclude URL-path glob matching for article filtering.
 *
 * A sitemap lists every URL on a site, not just articles, so the sitemap adapter filters
 * with these globs. Deterministic, no model. Supported syntax, deliberately small:
 *   `*`  — any run of chars except `/`
 *   `**` — any run of chars including `/`
 *   `?`  — a single char except `/`
 * A path passes when it matches at least one include glob (or include is empty → all pass)
 * AND matches no exclude glob (exclude wins — it is the safety lever).
 */

/** Compile one glob to an anchored RegExp. Literals are escaped; only `*`/`?` are special. */
function globToRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*"; // `**` → across segments
        i++;
      } else {
        re += "[^/]*"; // `*` → within a segment
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

const cache = new Map<string, RegExp>();
function compiled(glob: string): RegExp {
  let re = cache.get(glob);
  if (!re) {
    re = globToRe(glob);
    cache.set(glob, re);
  }
  return re;
}

/** True if `path` (a URL pathname) matches `glob`. */
export function matchGlob(path: string, glob: string): boolean {
  return compiled(glob).test(path);
}

/**
 * Article gate: passes an include (empty include ⇒ everything is in) and survives every
 * exclude. Exclude takes precedence — it is how an owner carves `/essays/drafts/**` out.
 */
export function passesGlobs(path: string, include: string[], exclude: string[]): boolean {
  if (exclude.some((g) => matchGlob(path, g))) return false;
  if (include.length === 0) return true;
  return include.some((g) => matchGlob(path, g));
}
