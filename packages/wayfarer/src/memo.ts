/**
 * Memo buyer — the client side of the Arc self-relay rail. On a memo-capable network the
 * gate settles by RELAYING a raw USDC EIP-3009 authorization through the Arc Memo
 * predeploy (not Circle Gateway), so the buyer signs the authorization against the USDC
 * EIP-712 domain — the shared descriptor — and posts `{authorization, signature}` as the
 * `payment-signature`. There is NO Gateway deposit: the transfer moves straight from the
 * buyer's USDC balance and the gate's relayer only pays gas (custody-free).
 *
 * Counterpart to gateway.ts (Circle SDK, GatewayWallet domain) and pay.ts (mock offline).
 * The signing here is wayfarer's own viem call over shared's `TRANSFER_WITH_AUTHORIZATION`
 * descriptor + `usdcDomain` — the same "each consumer signs against the one shared
 * descriptor" split the gate's own `buildMemoSignature` uses (the gate then verifies
 * against that identical descriptor). `selectBuyer` routes here when `supportsMemo`.
 */
import { privateKeyToAccount } from "viem/accounts";
import { toHex, type TypedDataDomain } from "viem";
import {
  activeNetwork,
  getConfig,
  usdcDomain,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  type MemoAuthorization,
  type SettlementNetwork,
} from "@naulon/shared";
import {
  assemblePayment,
  classifySignerRefusal,
  probePrice,
  type Buyer,
  type Fetched,
  type LegRequirements,
  type PayGuard,
  type Quoted,
} from "./buyer.ts";
import { runPaidFetch } from "./paidFetch.ts";

/**
 * The signer seam (BUY-2). By default the memo buyer signs each EIP-3009 leg with the local
 * `BUYER_PRIVATE_KEY` (the OSS self-host path). A cloud host instead injects a `MemoSigner` — an
 * object that signs the SAME typed data elsewhere (a grant-checked BFF holding an encrypted session
 * key), so the private key never lives in the MCP process. A `PrivateKeyAccount` from viem satisfies
 * this shape too, which keeps the two paths symmetric. The env key is only ever read on the default
 * path — when a signer is injected, `BUYER_PRIVATE_KEY` is never touched.
 */
export interface MemoSigner {
  address: `0x${string}`;
  signTypedData(args: MemoTypedData): Promise<`0x${string}`>;
  /**
   * OPTIONAL batch sign — sign EVERY leg of a multi-leg toll (operator fee, co-author split) in ONE
   * call, so a batch-capable host can RESERVE them atomically (all-or-nothing, no stranded sibling leg —
   * naulon-cloud migration 0122 / `signSessionMemoBatch`). Returns one signature per input, index-aligned.
   *
   * A signer WITHOUT this method (a local env-key `PrivateKeyAccount`, the OSS self-host path, or a mock)
   * falls back to per-leg signing via {@link assembleMemoPayment} — safe there precisely because those
   * paths take no host-side reserve (mock) or never carry a multi-leg quote through a hosted grant. Only
   * an injected cloud signer that reserves needs the atomicity, and only it implements this.
   */
  signTypedDataBatch?(argsList: MemoTypedData[]): Promise<`0x${string}`[]>;
}

/** The EIP-3009 `TransferWithAuthorization` typed data a memo leg signs — one shape for the single and
 *  batch signer methods so a leg is signed identically however it is batched. */
export interface MemoTypedData {
  domain: TypedDataDomain;
  types: typeof TRANSFER_WITH_AUTHORIZATION_TYPES;
  primaryType: "TransferWithAuthorization";
  message: {
    from: `0x${string}`;
    to: `0x${string}`;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: `0x${string}`;
  };
}

function buyerKey(): `0x${string}` {
  const cfg = getConfig();
  if (!cfg.BUYER_PRIVATE_KEY) {
    throw new Error(
      `PAYMENT_MODE=gateway on ${activeNetwork().chainName} (memo rail) requires BUYER_PRIVATE_KEY ` +
        `— a wallet holding USDC on that network (the EIP-3009 transfer moves straight from it).`,
    );
  }
  return (cfg.BUYER_PRIVATE_KEY.startsWith("0x") ? cfg.BUYER_PRIVATE_KEY : `0x${cfg.BUYER_PRIVATE_KEY}`) as `0x${string}`;
}

/** Sign a raw USDC EIP-3009 `TransferWithAuthorization` against the active network's USDC
 *  EIP-712 domain and return the base64 `{authorization, signature}` payload the gate's
 *  memo settle path parses. The memo id is NOT signed (the gate attaches it at relay), so
 *  the buyer needs nothing extra. Exported for unit testing against the gate's pre-verify. */
export async function signMemoPayment(
  requirements: Quoted["requirements"],
  nowMs: number,
): Promise<string> {
  return Buffer.from(JSON.stringify(await memoLegPayload(requirements, nowMs))).toString("base64");
}

/** The raw `{ authorization, signature }` for ONE leg — signs the leg's payTo + amount
 *  against the active network's USDC domain, with its own fresh EIP-3009 nonce. The
 *  per-leg primitive `assemblePayment` calls once per advertised leg (mirrors the gate's
 *  `memoLegPayload` → `buildMemoSignatures`). The memo id is NOT signed (the relayer
 *  attaches it at submit), so each leg needs nothing beyond its own authorization. */
export async function memoLegPayload(
  requirements: LegRequirements,
  nowMs: number,
  signer?: MemoSigner,
  net = activeNetwork(),
): Promise<{ authorization: MemoAuthorization; signature: `0x${string}` }> {
  // Default path resolves the local key; an injected signer NEVER reads BUYER_PRIVATE_KEY (the whole
  // point of the cloud wallet — the key lives in the grant-checked BFF, not this process).
  const envAccount = signer ? undefined : privateKeyToAccount(buyerKey());
  const from = (signer?.address ?? envAccount!.address) as `0x${string}`;
  const { authorization, typedData } = buildMemoLeg(requirements, nowMs, from, net);
  const signature = signer ? await signer.signTypedData(typedData) : await envAccount!.signTypedData(typedData);
  return { authorization, signature };
}

/**
 * Build ONE leg's EIP-3009 authorization + the typed data to sign, WITHOUT signing — the pure half of
 * {@link memoLegPayload}, shared by the per-leg and batch paths so both stamp the identical validity
 * window and USDC domain. `from` is the already-resolved signer address.
 *
 * Stamps validity at PAY time (`nowMs` is `Date.now()` from fetch, not quote time) with a MARGIN: floor
 * the window to WAYFARER_MIN_VALIDITY_SECONDS so a gate advertising a too-short maxTimeoutSeconds can't
 * make the authorization expire before the relay submits it (the facilitator's
 * `authorization_validity_too_short` — the Keryx ~1-day lesson; see memory `x402-validity-window-floor`).
 * The window only widens, never shrinks — a long gate window is honored as-is.
 */
function buildMemoLeg(
  requirements: LegRequirements,
  nowMs: number,
  from: `0x${string}`,
  net: SettlementNetwork,
): { authorization: MemoAuthorization; typedData: MemoTypedData } {
  const cfg = getConfig();
  const window = Math.max(requirements.maxTimeoutSeconds, cfg.WAYFARER_MIN_VALIDITY_SECONDS);
  const authorization: MemoAuthorization = {
    from,
    to: requirements.payTo as `0x${string}`,
    value: requirements.amount,
    validAfter: "0",
    validBefore: String(Math.floor(nowMs / 1000) + window),
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const typedData: MemoTypedData = {
    domain: usdcDomain(net, cfg.USDC_EIP712_NAME),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  };
  return { authorization, typedData };
}

/**
 * Assemble the memo rail's base64 `payment-signature`. For a multi-leg toll signed by a BATCH-capable
 * injected signer, build every leg's authorization, sign them ALL in ONE call (so the host reserves them
 * atomically — a sibling leg that trips a ceiling can never strand an already-debited author leg), and
 * frame the leg array (author first) exactly as {@link assemblePayment} does. Every OTHER case — a
 * single-leg toll, the local env-key signer, or an injected signer WITHOUT a batch method — falls
 * straight through to the per-leg path, byte-identical to before this seam existed. The multi-leg-only
 * batch means a non-fee read and every non-hosted path are provably untouched.
 */
export async function assembleMemoPayment(
  quoted: Quoted,
  nowMs: number,
  signer?: MemoSigner,
  net: SettlementNetwork = activeNetwork(),
): Promise<string> {
  if (quoted.legs && quoted.legs.length > 1 && signer?.signTypedDataBatch) {
    // Build every leg first (fresh nonce + validity), then one atomic batch sign. The from is the
    // injected signer's address — the batch path only exists for a hosted signer, which never reads the
    // env key. Leg order (author first) is preserved into the framed array, matching assemblePayment.
    const built = quoted.legs.map((leg) =>
      buildMemoLeg({ ...quoted.requirements, payTo: leg.payTo, amount: leg.amount }, nowMs, signer.address, net),
    );
    const signatures = await signer.signTypedDataBatch(built.map((b) => b.typedData));
    // A count mismatch means the host signed a different set than we sent — never frame a partial or
    // misaligned payment. Fail loud; the caller's onSignError turns it into a typed, non-signed result.
    if (signatures.length !== built.length) {
      throw new Error(`batch signer returned ${signatures.length} signatures for ${built.length} legs`);
    }
    const payloads = built.map((b, i) => ({ authorization: b.authorization, signature: signatures[i]! }));
    return Buffer.from(JSON.stringify(payloads)).toString("base64");
  }
  // Single leg, the env-key signer, or a signer without batch: today's per-leg framing (mock/OSS/gateway
  // paths are unaffected — assemblePayment signs one leg, or Promise.all's the legs, exactly as before).
  return assemblePayment(quoted, (req) => memoLegPayload(req, nowMs, signer, net));
}

export function memoBuyer(signer?: MemoSigner): Buyer {
  const address = signer ? signer.address : privateKeyToAccount(buyerKey()).address;
  return {
    address,
    async init() {
      // No Gateway deposit — the EIP-3009 transfer pays straight from the buyer's USDC
      // balance, and the relayer (gate-side) covers gas. `make arc-preflight` checks funding.
    },
    price(url, kind): Promise<Quoted | null> {
      return probePrice(url, kind, address);
    },
    async fetch(url, kind, guard?: PayGuard): Promise<Fetched> {
      // One raw EIP-3009 authorization per advertised leg (operator fee → 2-leg array); a stock
      // single-author quote stays the bare object, byte-identical to before. The shared loop owns
      // probe→moved-guard→paid-GET→classify; the memo rail supplies only how it signs and how it
      // types a sign refusal (grant exhausted/expired/no session → typed; else a transient origin throw).
      return runPaidFetch(
        url,
        kind,
        address,
        guard,
        (quoted, nowMs) => assembleMemoPayment(quoted, nowMs, signer),
        (error) => {
          const refusal = classifySignerRefusal(error);
          return refusal
            ? { ok: false, error, ...refusal }
            : { ok: false, error, errorCode: "origin_error", retryable: true };
        },
      );
    },
  };
}
