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
} from "@naulon/shared";
import {
  AGENT_UA,
  assemblePayment,
  classifyPaymentError,
  probe,
  probeFailure,
  probePrice,
  tollMovedOrNull,
  type Buyer,
  type Fetched,
  type LegRequirements,
  type PayGuard,
  type Quoted,
} from "./buyer.ts";
import { agentFetch } from "./sign.ts";

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
  signTypedData(args: {
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
  }): Promise<`0x${string}`>;
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
async function memoLegPayload(
  requirements: LegRequirements,
  nowMs: number,
  signer?: MemoSigner,
): Promise<{ authorization: MemoAuthorization; signature: `0x${string}` }> {
  const cfg = getConfig();
  const net = activeNetwork();
  // Default path resolves the local key; an injected signer NEVER reads BUYER_PRIVATE_KEY (the whole
  // point of the cloud wallet — the key lives in the grant-checked BFF, not this process).
  const envAccount = signer ? undefined : privateKeyToAccount(buyerKey());
  const from = (signer?.address ?? envAccount!.address) as `0x${string}`;
  // Stamp validity at PAY time (nowMs is `Date.now()` from fetch, not quote time) with a
  // MARGIN: floor the window to WAYFARER_MIN_VALIDITY_SECONDS so a gate advertising a
  // too-short maxTimeoutSeconds can't make the authorization expire before the relay
  // submits it (the facilitator's `authorization_validity_too_short` — the Keryx ~1-day
  // lesson; see memory `x402-validity-window-floor`). The window only widens, never
  // shrinks — a long gate window is honored as-is.
  const window = Math.max(requirements.maxTimeoutSeconds, cfg.WAYFARER_MIN_VALIDITY_SECONDS);
  const authorization: MemoAuthorization = {
    from,
    to: requirements.payTo as `0x${string}`,
    value: requirements.amount,
    validAfter: "0",
    validBefore: String(Math.floor(nowMs / 1000) + window),
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const typedData = {
    domain: usdcDomain(net, cfg.USDC_EIP712_NAME),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization" as const,
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  };
  const signature = signer ? await signer.signTypedData(typedData) : await envAccount!.signTypedData(typedData);
  return { authorization, signature };
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
      const outcome = await probe(url, kind, address);
      if (outcome.status !== "gated") return probeFailure(outcome, url);
      const quoted = outcome.quoted;
      // Re-quote at pay time and abort if the toll moved past the authorized ceiling.
      const moved = tollMovedOrNull(quoted, guard);
      if (moved) return moved;
      // One raw EIP-3009 authorization per advertised leg (operator fee → 2-leg array);
      // a stock single-author quote stays the bare object, byte-identical to before.
      const nowMs = Date.now();
      const paymentSignature = await assemblePayment(quoted, (req) => memoLegPayload(req, nowMs, signer));
      const res = await agentFetch(url, {
        headers: {
          "user-agent": AGENT_UA,
          "x-naulon-agent": address,
          "x-naulon-kind": kind,
          "payment-signature": paymentSignature,
        },
      });
      if (res.status === 402) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const error = body.error ?? "payment rejected";
        return { ok: false, error, ...classifyPaymentError(error) };
      }
      if (!res.ok) return { ok: false, error: `origin returned ${res.status}`, errorCode: "origin_error", retryable: true };
      let settlementRef: string | undefined;
      const respHeader = res.headers.get("payment-response");
      if (respHeader) {
        try {
          settlementRef = (JSON.parse(Buffer.from(respHeader, "base64").toString("utf8")) as {
            transaction?: string;
          }).transaction;
        } catch {
          /* ignore */
        }
      }
      const license = res.headers.get("x-naulon-license") ?? undefined;
      return { ok: true, content: await res.text(), settlementRef, paidUsdc: quoted.priceUsdc, license };
    },
  };
}
