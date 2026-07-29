/**
 * Cloudflare's pay-per-crawl wire vocabulary, spoken alongside x402.
 *
 * WHY: Cloudflare taught a generation of crawlers a specific way to ask "what does
 * this cost, and I'll pay up to X" — `crawler-max-price` / `crawler-exact-price` on
 * the request, `crawler-price` on a 402, `crawler-charged` on a paid 200. A crawler
 * already fluent in that vocabulary can price a naulon origin with no code change on
 * its side, which is demand arriving off someone else's distribution. We ADVERTISE in
 * their vocabulary and SETTLE on ours (x402/USDC, buyer→author, custody-free) — the
 * two are independent, and nothing here moves money or changes who is charged.
 *
 * THE PRECISION TRAP: Cloudflare documents `USD XX.XX`, because their pricing is flat
 * per-domain and lands in cents. A naulon citation toll is sub-cent — 1000 micro-USDC
 * is $0.001 — and `(0.001).toFixed(2)` is `"0.00"`, which advertises a FREE read. So
 * this renders the exact value, extending past two decimals when the amount needs it,
 * and never rounds a nonzero price down. Two decimals stays the floor so the common
 * case still looks like what a Cloudflare-trained parser expects.
 *
 * All arithmetic is integer micro-USDC (bigint) — the repo's money rule. No float ever
 * touches a price on the wire.
 */

/** Request headers a crawler sends (Cloudflare pay-per-crawl). Mutually exclusive. */
export const CRAWLER_MAX_PRICE_HEADER = "crawler-max-price";
export const CRAWLER_EXACT_PRICE_HEADER = "crawler-exact-price";

/** Response headers we emit: the ask on a 402, the settled fact on a 200. */
export const CRAWLER_PRICE_HEADER = "crawler-price";
export const CRAWLER_CHARGED_HEADER = "crawler-charged";

/** USDC's atomic unit: 1 USDC = 1_000_000 micro. */
const MICRO_PER_USD = 1_000_000n;

/** Cloudflare's format is `USD <amount>`. USD is the only currency naulon prices in. */
const CURRENCY = "USD";

/**
 * Integer micro-USDC → the `USD <amount>` string Cloudflare's headers carry.
 *
 * Exact by construction: the fraction is rendered from the integer remainder, trailing
 * zeros trimmed, then padded back to a two-decimal minimum. A nonzero price can never
 * render as `USD 0.00`.
 */
export function formatCrawlerPrice(atomicMicroUsdc: bigint | number | string): string {
  const micro = toMicro(atomicMicroUsdc);
  if (micro < 0n) throw new Error(`invalid crawler price: ${atomicMicroUsdc}`);

  const whole = micro / MICRO_PER_USD;
  const frac = micro % MICRO_PER_USD;

  let fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  if (fracStr.length < 2) fracStr = fracStr.padEnd(2, "0");

  return `${CURRENCY} ${whole}.${fracStr}`;
}

/**
 * `USD 0.05` → 50000n micro. Returns null for anything we do not understand — an
 * absent header, another currency, a malformed amount, a negative. Null means "the
 * crawler said nothing we can use", never "free": a caller must not read null as a
 * price of zero.
 *
 * Deliberately permissive about the amount's precision (a crawler may send more or
 * fewer decimals than Cloudflare's examples) and strict about the currency.
 */
export function parseCrawlerPrice(value: string | null | undefined): bigint | null {
  if (!value) return null;

  const m = /^\s*([A-Za-z]{3})\s+(\d+)(?:\.(\d+))?\s*$/.exec(value);
  if (!m) return null;

  const [, currency, whole, frac = ""] = m;
  if (!currency || currency.toUpperCase() !== CURRENCY) return null;
  if (!whole) return null;

  // More precision than USDC can hold is not representable — refuse rather than
  // silently truncate someone's stated limit.
  if (frac.length > 6) return null;

  const micro = BigInt(whole) * MICRO_PER_USD + BigInt(frac.padEnd(6, "0") || "0");
  return micro;
}

/**
 * What the buyer is actually authorizing, summed across every settlement leg.
 *
 * NOT the quote price: co-author legs DIVIDE the author price (total unchanged) while
 * publisher extra legs (e.g. an operator fee) ADD to it. Summing the legs is the only
 * figure that stays true as either of those changes, and `crawler-charged` is a claim
 * about money — it has to be the real total or it is a lie to the buyer.
 */
export function totalChargedMicro(legs: readonly { requirements: { amount: string } }[]): bigint {
  return legs.reduce((sum, leg) => sum + toMicro(leg.requirements.amount), 0n);
}

function toMicro(v: bigint | number | string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error(`atomic USDC must be an integer: ${v}`);
    return BigInt(v);
  }
  if (!/^\d+$/.test(v.trim())) throw new Error(`atomic USDC must be integer digits: ${v}`);
  return BigInt(v.trim());
}
