/**
 * Crawler-policy write-path normalization — the ONE place the tri-state lists
 * (`allow` / `charge` / `block`) are sanitized before they are stored anywhere.
 *
 * It belongs here, beside the `CrawlerPolicy` type and the `decide()` that enforces it,
 * because two of the checks below are load-bearing rather than cosmetic:
 *
 *  - **Humans read free, forever.** That is a standing promise of the protocol, and a
 *    `block` fragment like "mozilla" would 403 every human reader. The gate cannot catch
 *    that at match time — by then the fragment is just a substring that matched. It has to
 *    be refused when the policy is WRITTEN, so every surface that authors one needs this
 *    function itself, not a re-derivation of it.
 *  - **Header safety.** The matched fragment is echoed into `X-Naulon-Verdict`, so a
 *    control character surviving into a stored fragment is a response-header injection.
 *
 * Gate matching is case-insensitive substring; storing trimmed/lowercase/deduped keeps the
 * stored intent equal to the matched intent. Overlap is a user error (which state did they
 * mean?) — rejected loudly here; the gate's block-wins precedence is only the fail-safe for
 * policies this validator never saw.
 */
import type { CrawlerPolicy } from "./publisher.ts";

const MAX_FRAGMENT = 64;
const MAX_LIST = 200;

/**
 * Representative real-browser user-agents (lowercase — gate matching is
 * case-insensitive substring). A block/charge fragment that substring-matches ANY
 * of these would 403/402 human readers — "humans read free, forever" is the hard
 * rule, so such a fragment is rejected at write time. Testing fragments against
 * whole sample UAs is deliberately stronger than a token blacklist: it catches
 * "ozill", "hrome", "mac os", and any other slice of a browser UA, not just the
 * five famous tokens. Samples span the engines (Blink/WebKit/Gecko) and form
 * factors (desktop/mobile); exact versions don't matter — fragments match
 * substrings, and the stable UA skeleton is what carries them.
 */
const BROWSER_UA_SAMPLES = [
  // Chrome on Windows
  "mozilla/5.0 (windows nt 10.0; win64; x64) applewebkit/537.36 (khtml, like gecko) chrome/126.0.0.0 safari/537.36",
  // Edge on Windows
  "mozilla/5.0 (windows nt 10.0; win64; x64) applewebkit/537.36 (khtml, like gecko) chrome/126.0.0.0 safari/537.36 edg/126.0.0.0",
  // Safari on iPhone
  "mozilla/5.0 (iphone; cpu iphone os 17_5 like mac os x) applewebkit/605.1.15 (khtml, like gecko) version/17.5 mobile/15e148 safari/604.1",
  // Safari on macOS
  "mozilla/5.0 (macintosh; intel mac os x 10_15_7) applewebkit/605.1.15 (khtml, like gecko) version/17.5 safari/605.1.15",
  // Firefox on Linux
  "mozilla/5.0 (x11; linux x86_64; rv:128.0) gecko/20100101 firefox/128.0",
  // Chrome on Android
  "mozilla/5.0 (linux; android 14; pixel 8) applewebkit/537.36 (khtml, like gecko) chrome/126.0.0.0 mobile safari/537.36",
];

/** True when a (lowercased) fragment would substring-match a real browser UA. */
function matchesRealBrowser(frag: string): boolean {
  return BROWSER_UA_SAMPLES.some((sample) => sample.includes(frag));
}

function normalizeList(list: string[], label: string, opts?: { guardHumans?: boolean }): string[] {
  if (list.length > MAX_LIST) throw new Error(`${label} list exceeds ${MAX_LIST} entries`);
  const out: string[] = [];
  for (const raw of list) {
    const frag = raw.trim().toLowerCase();
    if (frag === "") throw new Error(`${label} list contains an empty fragment`);
    // Header-injection guard: CR, LF, TAB, and other C0 controls (< 32) plus DEL (127)
    // would survive trim() and could be injected into X-Naulon-Verdict response headers.
    // Spaces (32) and dashes (45) are legal — "claude-user" must pass.
    for (const ch of frag) {
      const c = ch.charCodeAt(0);
      if (c < 32 || c === 127) {
        throw new Error(`${label} fragment contains a control character`);
      }
    }
    if (frag.length > MAX_FRAGMENT) throw new Error(`${label} fragment exceeds ${MAX_FRAGMENT} characters`);
    // Humans-read-free guard (block/charge only): a fragment that lives inside a
    // real browser UA would gate human readers — refuse it at write time. Allow
    // is exempt: allowing humans is a no-op, they already read free.
    if (opts?.guardHumans && matchesRealBrowser(frag)) {
      throw new Error(
        `${label} fragment "${frag}" matches a real browser user-agent. ` +
          `Blocking or charging it would gate human readers (humans read free)`,
      );
    }
    if (!out.includes(frag)) out.push(frag);
  }
  return out;
}

export function normalizeCrawlerPolicy(input: { allow: string[]; block: string[]; charge?: string[] }): CrawlerPolicy {
  const allow = normalizeList(input.allow, "allow");
  const block = normalizeList(input.block, "block", { guardHumans: true });
  const charge =
    input.charge && input.charge.length > 0
      ? normalizeList(input.charge, "charge", { guardHumans: true })
      : undefined;

  const allowBlock = allow.find((f) => block.includes(f));
  if (allowBlock) throw new Error(`"${allowBlock}" appears in both allow and block. Pick one state per crawler`);

  if (charge !== undefined) {
    const chargeBlock = charge.find((f) => block.includes(f));
    if (chargeBlock) throw new Error(`"${chargeBlock}" appears in both charge and block. Pick one state per crawler`);

    const allowCharge = allow.find((f) => charge.includes(f));
    if (allowCharge) throw new Error(`"${allowCharge}" appears in both allow and charge. Pick one state per crawler`);

    return { allow, block, charge };
  }

  return { allow, block };
}
