/**
 * Buyer abstraction — how the Wayfarer prices and pays for an article.
 *
 * Pricing is the same in both modes: probe the tollgate, read the x402
 * `PAYMENT-REQUIRED` header (free — no payment yet). Paying differs:
 *   - mock: sign a simple offline payment-signature the mock gate accepts.
 *   - gateway: Circle's GatewayClient does the full deposit-backed 402 flow.
 */
import { activeNetwork, getConfig, supportsMemo } from "@naulon/shared";
import { agentFetch } from "./sign.ts";

const AGENT_UA = "naulon-wayfarer/0.1";

export interface Quoted {
  priceUsdc: number;
  amountAtomic: string;
  /** Nonce the gate issued on the 402; echo it back in the payment (replay guard). */
  nonce?: string;
  requirements: { network: string; asset: string; payTo: string; amount: string; maxTimeoutSeconds: number };
  /**
   * When the publisher declares extra settlement legs (e.g. a control-plane operator
   * fee), the gate advertises the FULL per-leg list (author first) via the
   * `extensions.naulonLegs` block, and rejects any payment that doesn't sign every leg.
   * Present only for such an N-leg quote; absent for the stock single-author toll —
   * then the buyer pays the bare single payload, byte-identical to before.
   */
  legs?: { role: string; payTo: string; amount: string; nonce?: string }[];
}

/** A per-leg requirement the buyer signs — the author requirement with this leg's
 *  payTo + amount substituted (same network/asset/timeout). */
export type LegRequirements = Quoted["requirements"];

/**
 * Why a paid fetch failed, classified so the host can decide what to do (BUY-1.4).
 * The point is the `retryable` split: `insufficient_funds` is a HARD stop (fund the
 * wallet, don't re-call), while `toll_moved` / `expired` / `rejected` are transient
 * (re-quote and try again may succeed). `not_gated` means there was nothing to pay.
 */
export type FetchErrorCode =
  | "not_gated"
  | "not_found"
  | "toll_moved"
  | "insufficient_funds"
  | "expired"
  | "rejected"
  | "origin_error";

export interface Fetched {
  ok: boolean;
  content?: string;
  settlementRef?: string;
  paidUsdc?: number;
  /** Citation License (compact JWS) the gate handed back on a paid read. */
  license?: string;
  error?: string;
  /** Typed failure classification (BUY-1.4); absent on success. */
  errorCode?: FetchErrorCode;
  /** True when re-quoting/retrying may succeed (toll moved, validity expired, a
   *  generic rejection); false for a hard stop (insufficient funds — fund first).
   *  Absent on success. */
  retryable?: boolean;
}

/**
 * A pay-time spend ceiling the buyer must not exceed (BUY-1.4). The buyer re-quotes
 * at pay time (its own pre-pay probe IS the re-quote) and ABORTS — paying nothing —
 * if the live toll total tops this. The caller (the MCP) sets it to the quote it
 * already gated the budget on, plus a configured tolerance, so a toll that moved up
 * between the budget check and the pay can never silently overspend.
 */
export interface PayGuard {
  /** Max atomic (micro-USDC) total across all legs the buyer may pay. */
  maxTotalAtomic: string;
}

export interface Buyer {
  readonly address: string;
  /** One-time setup (gateway mode deposits USDC into the Gateway Wallet). */
  init(): Promise<void>;
  /** Probe price without paying. null if the article isn't gated. */
  price(url: string, kind: "read" | "citation"): Promise<Quoted | null>;
  /** Pay and fetch the content. `guard` (optional) caps the pay-time total — the
   *  buyer aborts beyond it (toll-moved protection), paying nothing. */
  fetch(url: string, kind: "read" | "citation", guard?: PayGuard): Promise<Fetched>;
}

/**
 * The buyer's true outflow for a quote, in atomic micro-USDC (integer) — the sum of
 * every advertised settlement leg, or the single author amount when there are none.
 * Integer math only (AGENTS.md: money is integer micro-USDC, never floats).
 */
export function quotedTotalAtomic(quoted: Quoted): bigint {
  if (quoted.legs && quoted.legs.length > 0) {
    return quoted.legs.reduce((sum, leg) => sum + BigInt(leg.amount), 0n);
  }
  return BigInt(quoted.amountAtomic);
}

/**
 * The toll-moved guard. If `guard` is set and the LIVE quote's true total tops the
 * guard ceiling, returns a typed `toll_moved` failure (the buyer pays NOTHING);
 * otherwise null (clear to pay). This is "re-quote at pay time, abort beyond
 * tolerance": the buyer's own pre-pay probe is the re-quote, compared here against
 * the ceiling the caller authorized.
 */
export function tollMovedOrNull(quoted: Quoted, guard?: PayGuard): Fetched | null {
  if (!guard) return null;
  const live = quotedTotalAtomic(quoted);
  const ceiling = BigInt(guard.maxTotalAtomic);
  if (live <= ceiling) return null;
  return {
    ok: false,
    errorCode: "toll_moved",
    retryable: true,
    error:
      `Toll moved at pay time: the live total is ${live} atomic but only ${ceiling} was authorized ` +
      `(the quoted total plus tolerance). Re-quote and decide again — nothing was paid.`,
  };
}

/**
 * Classify a gate's payment-rejection message (BUY-1.4). The gate surfaces the real
 * reason in its 402 body; this maps the known signals onto a typed code + a retry
 * verdict. Insufficient funds is the one hard stop — every other rejection is worth a
 * re-quote. Conservative by design: an unrecognized reason is `rejected` (retryable),
 * never silently treated as a fundable hard stop.
 */
export function classifyPaymentError(errorText: string): { errorCode: FetchErrorCode; retryable: boolean } {
  const t = errorText.toLowerCase();
  if (/insufficient|exceeds balance|transfer amount exceeds|not enough|balance too low/.test(t)) {
    return { errorCode: "insufficient_funds", retryable: false };
  }
  if (/validity_too_short|validity too short|expired|valid ?before|too short|window/.test(t)) {
    return { errorCode: "expired", retryable: true };
  }
  return { errorCode: "rejected", retryable: true };
}

/**
 * The classified outcome of a price probe. A probe is NOT just "gated or not" — the
 * reason it isn't gated matters, and collapsing everything non-402 into one bucket is a
 * money-correctness bug: a wrong URL (404) or a down origin (5xx) is NOT a free read, and
 * an agent that treats it as one silently skips paying and reads nothing (or an error
 * page). This union keeps the four cases apart so every caller can respond correctly:
 *   - `gated`       — a real 402 with a decodable toll; pay it.
 *   - `free`        — a genuine 2xx; there is nothing to pay (the one true "not gated").
 *   - `not_found`   — a 404; the path is wrong/unknown, NOT free. On a slug-only pay this
 *                     is usually the `/essays/<slug>` fallback missing a publisher that
 *                     serves `/articles/<slug>` — the fix is to pass the canonical url.
 *   - `unreachable` — any other non-2xx (5xx, 403, a network throw); transient, retryable.
 *   - `malformed`   — a 402 whose PAYMENT-REQUIRED header is missing/undecodable/empty;
 *                     a broken gate, never silently a free read.
 */
export type ProbeOutcome =
  | { status: "gated"; quoted: Quoted }
  | { status: "free" }
  | { status: "not_found"; httpStatus: number }
  | { status: "unreachable"; httpStatus: number }
  | { status: "malformed"; reason: string };

/** Shared price probe — classify the gate's response by HTTP status, decoding the 402
 *  PAYMENT-REQUIRED header only for a real toll. Never throws: a broken 402 body or a
 *  network failure is returned as a typed outcome, not an exception. */
export async function probe(
  url: string,
  kind: "read" | "citation",
  agentId: string,
): Promise<ProbeOutcome> {
  let res: Response;
  try {
    res = await agentFetch(url, {
      headers: { "user-agent": AGENT_UA, "x-naulon-agent": agentId, "x-naulon-kind": kind },
    });
  } catch {
    // A DNS/connection failure is unreachable, not "free" — httpStatus 0 = no response.
    return { status: "unreachable", httpStatus: 0 };
  }
  if (res.status === 402) {
    const header = res.headers.get("payment-required");
    if (!header) return { status: "malformed", reason: "missing the PAYMENT-REQUIRED header" };
    let decoded: {
      accepts?: {
        network: string;
        asset: string;
        payTo: string;
        amount: string;
        maxTimeoutSeconds: number;
        extra?: { nonce?: string };
      }[];
      extensions?: { naulonLegs?: { legs?: { role: string; payTo: string; amount: string; nonce?: string }[] } };
    };
    try {
      decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    } catch {
      return { status: "malformed", reason: "an undecodable PAYMENT-REQUIRED header" };
    }
    const req = decoded.accepts?.[0];
    if (!req) return { status: "malformed", reason: "a 402 with no payment options (empty accepts)" };
    // The author leg is what the agent appraises (the content's price), so `priceUsdc`
    // stays the author amount even when an additive fee leg makes the buyer's TOTAL
    // higher. `legs` (when present) is the full set the buyer must sign — see assemblePayment.
    const legs = decoded.extensions?.naulonLegs?.legs;
    return {
      status: "gated",
      quoted: {
        priceUsdc: Number(req.amount) / 1_000_000,
        amountAtomic: req.amount,
        nonce: req.extra?.nonce,
        requirements: req,
        ...(legs && legs.length > 0 ? { legs } : {}),
      },
    };
  }
  if (res.status === 404) return { status: "not_found", httpStatus: 404 };
  if (res.ok) return { status: "free" };
  return { status: "unreachable", httpStatus: res.status };
}

/** Back-compat thin wrapper: the decoded quote for a gated 402, else null. Callers that
 *  must distinguish free / not_found / unreachable use `probe()` directly. */
export async function probePrice(
  url: string,
  kind: "read" | "citation",
  agentId: string,
): Promise<Quoted | null> {
  const outcome = await probe(url, kind, agentId);
  return outcome.status === "gated" ? outcome.quoted : null;
}

/**
 * Map a NON-gated probe outcome to the typed `Fetched` failure every buyer returns, so a
 * 404/5xx/malformed response never masquerades as a paid or free success. `not_gated` is
 * reserved for the one true free (2xx) read; a 404 is `not_found` with a message that
 * points the agent at the canonical url (the usual cause is the `/essays/<slug>` fallback
 * not matching a `/articles/<slug>` publisher).
 */
export function probeFailure(outcome: Exclude<ProbeOutcome, { status: "gated" }>, url: string): Fetched {
  switch (outcome.status) {
    case "free":
      return {
        ok: false,
        errorCode: "not_gated",
        retryable: false,
        error: "not gated — the source returned a free (2xx) read; no payment is required.",
      };
    case "not_found":
      return {
        ok: false,
        errorCode: "not_found",
        retryable: false,
        error:
          `probed ${url} — HTTP 404. This is NOT a free read: the path was not found. Pass the canonical ` +
          `url from naulon_discover — the /essays/<slug> fallback does not match every publisher (many serve ` +
          `/articles/<slug> or a custom path).`,
      };
    case "unreachable":
      return {
        ok: false,
        errorCode: "origin_error",
        retryable: true,
        error: `probed ${url} — HTTP ${outcome.httpStatus || "no response"}. The origin/gate is unreachable or erroring; retry.`,
      };
    case "malformed":
      return {
        ok: false,
        errorCode: "rejected",
        retryable: true,
        error: `the gate returned a 402 but ${outcome.reason}; cannot quote the toll. Retry or check the gate.`,
      };
  }
}

/**
 * Assemble the `payment-signature` header. For an N-leg quote (a publisher with extra
 * settlement legs, e.g. an operator fee), sign one payload per advertised leg and emit
 * them as the ARRAY the gate's `verifyAndSettle` parses (leg order, author first). For
 * a stock single-author quote, emit today's BARE single payload — byte-identical, so a
 * non-fee toll is untouched. `signLeg` is the payment mode's per-leg signer (mock /
 * memo / gateway); it receives the leg's substituted requirements + the leg's nonce and
 * returns the raw payload object (this helper does the single-vs-array framing + base64).
 */
export async function assemblePayment(
  quoted: Quoted,
  signLeg: (req: LegRequirements, nonce?: string) => unknown | Promise<unknown>,
): Promise<string> {
  if (quoted.legs && quoted.legs.length > 1) {
    const payloads = await Promise.all(
      quoted.legs.map((leg) =>
        signLeg({ ...quoted.requirements, payTo: leg.payTo, amount: leg.amount }, leg.nonce),
      ),
    );
    return Buffer.from(JSON.stringify(payloads)).toString("base64");
  }
  const payload = await signLeg(quoted.requirements, quoted.nonce);
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/**
 * Re-read an essay using a held Citation License instead of paying. Mode-agnostic
 * — it's just an authenticated GET; the gate honors the license and serves free.
 */
export async function rereadWithLicense(
  url: string,
  kind: "read" | "citation",
  license: string,
  agentId: string,
  /** Holder-of-key proof (`<ts>.<nonce>.<sig>`); required for a cnf-bound license. */
  proof?: string,
): Promise<Fetched> {
  const headers: Record<string, string> = {
    "user-agent": AGENT_UA,
    "x-naulon-agent": agentId,
    "x-naulon-kind": kind,
    "x-naulon-license": license,
  };
  if (proof) headers["x-naulon-proof"] = proof;
  const res = await agentFetch(url, { headers });
  if (!res.ok) return { ok: false, error: `re-read returned ${res.status}` };
  return { ok: true, content: await res.text(), paidUsdc: 0, license };
}

export async function selectBuyer(): Promise<Buyer> {
  const cfg = getConfig();
  if (cfg.PAYMENT_MODE === "gateway") {
    // On a memo-capable network (Arc) the gate settles via the self-relay rail, which
    // expects a RAW USDC EIP-3009 authorization (USDC domain), not Circle's Gateway
    // payload (GatewayWallet domain) — so the buyer signs differently. Field-presence
    // gate, mirroring the gate's settle routing: a swap to Base falls back to the SDK.
    if (supportsMemo(activeNetwork())) {
      const { memoBuyer } = await import("./memo.ts");
      return memoBuyer();
    }
    const { gatewayBuyer } = await import("./gateway.ts");
    return gatewayBuyer();
  }
  const { mockBuyer } = await import("./pay.ts");
  return mockBuyer();
}

export { AGENT_UA };
