/**
 * Gateway buyer — the memo-LESS Circle rail (Base + every other Gateway chain). Where the
 * memo rail (memo.ts) relays a raw USDC EIP-3009 authorization, the gateway rail signs an
 * EIP-3009 authorization against the Circle **GatewayWallet** contract (the `extra.
 * verifyingContract` the gate advertises) and posts the full x402 envelope `{x402Version,
 * payload:{authorization,signature}, resource, accepted}` as `payment-signature` — the shape
 * Circle's facilitator `verify` requires (a bare/mock shape is rejected 400
 * `x402Version/resource/accepted/payload: Required` — the Base-settle bug this path fixes).
 *
 * Custody-free seam (mirrors `memoBuyer(MemoSigner)`): a cloud host injects a sign-only
 * `GatewaySigner` (its address + a `signTypedData` that signs the GatewayWallet-domain typed
 * data elsewhere — a grant-checked BFF holding the encrypted session key), so the private key
 * never lives in this process. A viem `PrivateKeyAccount` satisfies the same shape, keeping
 * the CLI/self-host path (env `BUYER_PRIVATE_KEY`) symmetric. The signing wraps the SDK's
 * `BatchEvmScheme` so the signed shape / validity clamp can never drift from the rail (the
 * same reason the gate's own `gatewayLegPayload` does — see tollgate/src/x402.ts).
 *
 * The Gateway balance is funded out-of-band (a one-time deposit into Circle's non-custodial
 * Gateway Wallet); the pay path here is pure sign-only. On the env/CLI path `init()` still
 * deposits via the SDK `GatewayClient` for backwards compatibility.
 */
import { type Address, type Hex, type TypedDataDomain } from "viem";
import { activeNetwork, arcPreviewHeaders, getConfig } from "@naulon/shared";
// Type-only (erased at runtime) — the SDK itself is loaded lazily so the mock path never pulls it in.
import type {
  Balances,
  DepositResult,
  SearchTransfersParams,
  SearchTransfersResponse,
  SupportedChainName,
  TransferResponse,
  TransferStatus,
  WithdrawResult,
} from "@circle-fin/x402-batching/client";
import {
  classifyPaymentError,
  classifySignerRefusal,
  probe,
  type Buyer,
  type Fetched,
  type PayGuard,
  type Quoted,
} from "./buyer.ts";
import { runPaidFetch } from "./paidFetch.ts";

/**
 * The gateway signer seam — the structural twin of `MemoSigner` and of the SDK's own
 * `BatchEvmSigner` (which the package doesn't re-export). A viem `PrivateKeyAccount` and a
 * cloud in-process session signer both satisfy it. The signed typed data is a
 * `TransferWithAuthorization` against the **GatewayWallet** EIP-712 domain (name
 * "GatewayWalletBatched", version "1", `verifyingContract` from the 402's `extra`) — NOT the
 * USDC token domain the memo rail uses.
 */
export interface GatewaySigner {
  address: `0x${string}`;
  signTypedData(args: {
    domain: TypedDataDomain;
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

/** The 402's author accept, with the Gateway batching `extra` the envelope needs. `probe`
 *  keeps the runtime object verbatim on `quoted.requirements`; the type there is narrowed to
 *  the common fields, so the gateway rail casts to reach `extra.verifyingContract`. */
export type BatchingRequirements = Quoted["requirements"] & {
  scheme?: string;
  extra?: { name?: string; version?: string; verifyingContract?: `0x${string}` };
};

function envAccountKey(): `0x${string}` {
  const cfg = getConfig();
  if (!cfg.BUYER_PRIVATE_KEY) {
    throw new Error(
      `PAYMENT_MODE=gateway on ${activeNetwork().chainName} requires an injected signer or a funded ` +
        `BUYER_PRIVATE_KEY (a wallet whose USDC is deposited in the Circle Gateway Wallet).`,
    );
  }
  return (cfg.BUYER_PRIVATE_KEY.startsWith("0x") ? cfg.BUYER_PRIVATE_KEY : `0x${cfg.BUYER_PRIVATE_KEY}`) as `0x${string}`;
}

/** Sign one Gateway leg's EIP-3009 authorization against the GatewayWallet domain and return
 *  the full envelope `{x402Version, payload, resource, accepted}` — exactly the gate's
 *  `gatewayLegPayload` shape. Wraps the SDK's `BatchEvmScheme` so the domain / validity clamp
 *  never drifts from the rail. SDK loaded lazily so the mock path never pulls it in. */
export async function gatewayLegPayload(
  signer: GatewaySigner,
  quoted: Quoted,
  x402Version: number,
): Promise<Record<string, unknown>> {
  // Both pre-sign guards live HERE, not in the callers. They used to sit in gatewayBuyer only,
  // while railBuyer (the mixed-fleet path) called this helper directly and got neither — the
  // classic drifted-sibling shape. Taking the whole `quoted` instead of bare requirements makes
  // them unbypassable: a caller cannot reach the signer without passing through both.
  //
  // 1. The Circle SDK's batched pay signs ONE leg. An N-leg (operator-fee) quote would be silently
  //    underpaid — refuse loudly and point at the memo rail (N-leg-capable).
  if (quoted.legs && quoted.legs.length > 1) {
    throw new Error(
      `gateway (Circle SDK) mode cannot pay a ${quoted.legs.length}-leg toll (operator fee): ` +
        `the SDK signs only the author leg. Use the memo (Arc) rail for multi-leg settlement.`,
    );
  }
  const requirements = quoted.requirements as BatchingRequirements;
  // 2. Refuse to sign a Circle envelope for a 402 that is not actually a Gateway batching option.
  if (requirements.extra?.name !== "GatewayWalletBatched") {
    throw new Error(
      "gateway mode expects a Circle Gateway batching option (extra.name 'GatewayWalletBatched'); " +
        "the gate advertised a non-gateway 402. Check PAYMENT_MODE / the settlement network.",
    );
  }
  const { BatchEvmScheme } = await import("@circle-fin/x402-batching/client");
  const scheme = new BatchEvmScheme(signer);
  const signed = await scheme.createPaymentPayload(x402Version, requirements as never);
  return { ...signed, resource: quoted.resource, accepted: requirements };
}

export function gatewayBuyer(signer?: GatewaySigner): Buyer {
  const cfg = getConfig();
  // Resolve the signer once. An injected signer NEVER reads BUYER_PRIVATE_KEY (the whole point
  // of the cloud wallet — the key lives in the grant-checked BFF, not this process).
  let resolved: GatewaySigner | null = signer ?? null;
  const getSigner = async (): Promise<GatewaySigner> => {
    if (resolved) return resolved;
    const { privateKeyToAccount } = await import("viem/accounts");
    return (resolved = privateKeyToAccount(envAccountKey()));
  };
  const fallbackAddress = signer ? signer.address : ((cfg.BUYER_ADDRESS as `0x${string}` | undefined) ?? "0x");

  return {
    get address() {
      return resolved?.address ?? fallbackAddress;
    },
    async init() {
      // Custody-free out-of-band deposit: the Gateway balance is funded separately, so the
      // injected-signer (cloud) path is a no-op. The env/CLI path keeps the SDK deposit for
      // backwards compatibility — it needs the raw key, which only exists on that path.
      if (signer) return;
      // Resolve the env-key address here so `address` is honest from init onward, matching
      // memoBuyer (which resolves eagerly at construction). Without this the env/CLI path
      // reported the "0x" placeholder until the first pay — agent.ts logs `wallet ${address}`
      // BEFORE init(), so an operator saw `wallet 0x` instead of the real derived address.
      await getSigner();
      const client = await newGatewayClient(activeNetwork().chainName, envAccountKey());
      console.log(`  depositing ${cfg.DEPOSIT_AMOUNT_USDC} USDC into the Gateway Wallet...`);
      const result = await client.deposit(cfg.DEPOSIT_AMOUNT_USDC);
      console.log(`  deposit tx ${result.depositTxHash}`);
    },
    price(url, kind): Promise<Quoted | null> {
      return probe(url, kind, this.address).then((o) => (o.status === "gated" ? o.quoted : null));
    },
    async fetch(url, kind, guard?: PayGuard): Promise<Fetched> {
      const address = this.address as `0x${string}`;
      // The shared loop owns probe→moved-guard→paid-GET→classify. The gateway rail supplies only
      // how it builds the payment (the two pre-sign guards live INSIDE the builder so a bad quote
      // throws into onSignError, keeping a typed result) and how it classifies a sign throw
      // (grant refusal → typed needs_topup; any other → classifyPaymentError — a gateway sign path
      // never sees a socket error, the shared loop handles that as a rail-agnostic origin_error).
      return runPaidFetch(
        url,
        kind,
        address,
        guard,
        async (quoted) => {
          // Both pre-sign guards (N-leg refusal + GatewayWalletBatched check) now live inside
          // gatewayLegPayload, so this rail and railBuyer enforce them identically. They still
          // throw into onSignError below, keeping a typed Fetched.
          const payload = await gatewayLegPayload(await getSigner(), quoted, 2);
          return Buffer.from(JSON.stringify(payload)).toString("base64");
        },
        (error) => {
          const refusal = classifySignerRefusal(error);
          return refusal
            ? { ok: false, error, ...refusal }
            : { ok: false, error, ...classifyPaymentError(error) };
        },
      );
    },
  };
}

/**
 * The `GatewayClient` constructor config for a chain + key. Pure + exported for direct
 * unit testing, the same discipline as tollgate's `facilitatorHeaders` — the six SDK call
 * sites below all build their client through `newGatewayClient`, so this IS the config
 * that runs, not a parallel copy.
 *
 * `headers` is the load-bearing part. SDK 3.2.0 turned the Arc private-mainnet header on
 * by itself (`config.arcPrivateMainnet ?? config.chain === "arc"`); 3.3.0 deleted that
 * default along with the whole `arcPrivateMainnet` option, so a client built with only
 * `{chain, privateKey}` now sends nothing. Passing it explicitly keeps Arc-mainnet
 * funding calls behaving exactly as they did on 3.2.0, and — unlike the old default —
 * says so out loud at a spot a reader can find.
 */
export function gatewayClientConfig(
  chain: SupportedChainName,
  privateKey: Hex,
): { chain: SupportedChainName; privateKey: Hex; headers: Record<string, string> } {
  return { chain, privateKey, headers: arcPreviewHeaders(chain) };
}

/** One owner for every `GatewayClient` construction in this module: the lazy SDK import
 *  (so the mock/memo paths never pull the SDK in) plus `gatewayClientConfig`. Six wrappers
 *  used to repeat both, which is how the deleted 3.3.0 default would have gone missing in
 *  six places at once. */
async function newGatewayClient(chain: SupportedChainName, privateKey: Hex) {
  const { GatewayClient } = await import("@circle-fin/x402-batching/client");
  return new GatewayClient(gatewayClientConfig(chain, privateKey));
}

/** Options for a standalone out-of-band Gateway deposit. */
export interface GatewayDepositOpts {
  chain: SupportedChainName;
  privateKey: Hex;
  /** USDC amount as a DECIMAL string, e.g. "10.5" — the SDK approves then deposits. */
  amountUsdc: string;
}

/**
 * Out-of-band, custody-free deposit into the Circle Gateway Wallet — the non-custodial contract that
 * holds the buyer's unified balance (Circle infra, buyer-controlled; naulon custodies nothing). The
 * cloud (injected-signer) path funds the Gateway balance HERE, out of band, because `gatewayBuyer.init()`
 * is a deposit NO-OP when a signer is injected (the key lives in the grant-checked BFF, not this process).
 * The self-host/CLI path still deposits inside `init()`; this is the standalone entry a deposit
 * script/operator calls. SDK loaded lazily so the mock/memo paths never pull it in.
 */
export async function gatewayDeposit(opts: GatewayDepositOpts): Promise<DepositResult> {
  const client = await newGatewayClient(opts.chain, opts.privateKey);
  return client.deposit(opts.amountUsdc);
}

/**
 * Withdraw from the Gateway unified balance back to a normal address. Same-chain by
 * construction — `withdraw()` to the source chain is instant (no 7-day delay); the
 * trustless initiate/complete pair is emergency-only, for a Circle API outage. `chain`
 * is passed explicitly even though `withdraw()` already defaults to the source chain
 * when `options.chain` is omitted — the same-chain intent is the whole point of this
 * wrapper, so it stays legible and testable rather than inherited from a default.
 * `maxFee` is left at the SDK default (2.01 USDC) — inventing a fee ceiling at this
 * layer is a product decision this wrapper hasn't been given.
 * NOTE: `transfer()` is a one-line deprecated alias for this same call
 * (`transfer(amount, chain, recipient) => withdraw(amount, { chain, recipient })`) —
 * don't "helpfully" switch back to it.
 * SDK lazy, so the mock/memo paths never pull it in — same discipline as `gatewayDeposit`.
 */
export async function gatewayWithdraw(opts: {
  chain: SupportedChainName;
  privateKey: Hex;
  to: Address;
  /** USDC amount as a DECIMAL string, e.g. "10.5". */
  amountUsdc: string;
}): Promise<WithdrawResult> {
  const client = await newGatewayClient(opts.chain, opts.privateKey);
  return client.withdraw(opts.amountUsdc, { chain: opts.chain, recipient: opts.to });
}

/** Read the wallet + Gateway balances for a key — the preflight a deposit script shows before it moves
 *  funds, and the check the buyer uses to see if its unified balance covers a toll. Pass `address` to
 *  read ANOTHER account's balances (e.g. confirm the AUTHOR received a settle) — the client key only
 *  authenticates the read, it needn't own the address. SDK loaded lazily. */
export async function gatewayBalances(
  opts: { chain: SupportedChainName; privateKey: Hex; address?: Address },
): Promise<Balances> {
  return (await newGatewayClient(opts.chain, opts.privateKey)).getBalances(opts.address);
}

/**
 * Look up a single Gateway transfer (a settlement) by its Circle id — the `settlementRef` a gateway
 * settle stamps. On the Gateway rail that ref is a **Circle UUID, not an on-chain tx hash**; the
 * response carries the authoritative `status` plus the eventual on-chain `txHash`. This is the
 * correct "did the settle land?" check — pair `status` with `classifyGatewaySettlement`. SDK lazy.
 */
export async function gatewayTransferStatus(
  opts: { chain: SupportedChainName; privateKey: Hex; id: string },
): Promise<TransferResponse> {
  return (await newGatewayClient(opts.chain, opts.privateKey)).getTransferById(opts.id);
}

/**
 * Search Gateway transfers with optional filters (`to`/`from`/`status`/`network`/date range). Use to
 * confirm a payee (author) received without holding the transfer id — e.g. `{ to: authorAddress }`.
 * SDK loaded lazily.
 */
export async function gatewayTransfers(
  opts: { chain: SupportedChainName; privateKey: Hex } & SearchTransfersParams,
): Promise<SearchTransfersResponse> {
  const { chain, privateKey, ...params } = opts;
  return (await newGatewayClient(chain, privateKey)).searchTransfers(params);
}

/** The one bit a caller settling buyer→author needs from a transfer's lifecycle: did the money land? */
export type GatewaySettlementState = "pending" | "settled" | "failed";

/**
 * Classify a Circle Gateway transfer `status` into settled / pending / failed. This is the CODE form
 * of the hard-won rule that a Gateway settle credits the payee's OFF-CHAIN Gateway balance — so
 * `balanceOf(payee)` is the wrong check and the transfer's own `status` is the authoritative signal.
 * `completed` ⇒ settled; the in-pipeline states ⇒ pending; `failed` ⇒ failed. An unknown/future status
 * is treated as `pending` — never falsely report the money landed.
 */
export function classifyGatewaySettlement(status: TransferStatus): GatewaySettlementState {
  switch (status) {
    case "completed":
      return "settled";
    case "failed":
      return "failed";
    case "received":
    case "batched":
    case "confirmed":
      return "pending";
    default: {
      // Exhaustiveness guard: if Circle adds a TransferStatus, this line fails tsc —
      // forcing a human to classify it, NOT silently bucketing it as pending. At
      // runtime an unknown value is treated as pending (never falsely "settled").
      const _exhaustive: never = status;
      void _exhaustive;
      return "pending";
    }
  }
}
