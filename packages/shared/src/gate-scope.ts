/**
 * Write-path normalisation for `gateScope.includeExtensions` — the ONE place the list is
 * sanitised, living beside the type it belongs to for the same reason
 * `normalizeCrawlerPolicy` lives beside `CrawlerPolicy`: the checks are load-bearing, not
 * cosmetic, and a rule with two spellings is one that gets fixed once.
 *
 * Two of them earn their place:
 *
 *  - **`ico` is refused.** `DISCOVERY_RE` refuses `/favicon.ico` before the allowlist is
 *    ever consulted, so storing `ico` would record an intent the gate can never honour —
 *    a publisher would tick it, save successfully, and get nothing, with no error to read.
 *    Refusing at the write path is the only place that reads as an answer.
 *  - **The alphanumeric shape.** The stored value reaches a path comparison; a `/` or a
 *    control character in it is a matcher operating on something that is not an extension.
 *
 * Storing trimmed/lowercase/deduped keeps the stored intent equal to the matched intent —
 * `slugFromSitePath` lowercases the path's own extension before comparing, and does no
 * normalisation of its own.
 */

/** More than this is not a policy, it is a mistake. */
const MAX_EXTENSIONS = 20;
/** Longer than this is not an extension. `webmanifest` is 12, the longest real one we know. */
const MAX_EXTENSION_LEN = 12;
/**
 * Extensions the gate refuses ahead of the allowlist, so accepting them here would store a
 * promise it cannot keep. `ico` is the whole set today: `/favicon.ico` is matched by
 * `DISCOVERY_RE`, which runs first and returns null.
 */
const NEVER_TOLLABLE = new Set(["ico"]);

/**
 * Normalise a publisher's opted-in extension list, or throw with a message a person can act
 * on. Returns a new sorted array; never mutates the input.
 */
export function normalizeIncludeExtensions(input: readonly string[]): string[] {
  if (input.length > MAX_EXTENSIONS) {
    throw new Error(`includeExtensions exceeds ${MAX_EXTENSIONS} entries`);
  }
  const out = new Set<string>();
  for (const raw of input) {
    const ext = raw.trim().toLowerCase().replace(/^\./, "");
    if (ext === "") throw new Error("includeExtensions contains an empty entry");
    if (ext.length > MAX_EXTENSION_LEN) {
      throw new Error(`includeExtensions entry "${ext}" is too long (max ${MAX_EXTENSION_LEN})`);
    }
    if (!/^[a-z0-9]+$/.test(ext)) {
      throw new Error(`includeExtensions entry "${ext}" is not alphanumeric — an extension has no dots, slashes or spaces`);
    }
    if (NEVER_TOLLABLE.has(ext)) {
      throw new Error(`"${ext}" can never be tolled — /favicon.ico is refused as a discovery surface before the allowlist is read`);
    }
    out.add(ext);
  }
  return [...out].sort();
}
