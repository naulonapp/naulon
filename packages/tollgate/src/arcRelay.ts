/**
 * Arc self-relay settlement — the memo-bearing settle path.
 *
 * WHY THIS EXISTS. Circle Gateway settles via a bare EIP-3009
 * `transferWithAuthorization` (the SDK's `BatchFacilitatorClient.settle`): there is
 * no field to attach an on-chain memo. Arc, uniquely, ships a Memo predeploy that
 * wraps a subcall and emits an indexed `Memo` event (offchain reconciliation — tie a
 * settlement to a citation/license id). To use it the settlement transaction must
 * call `Memo.memo(USDC, transferCalldata, memoId, memoData)` ourselves, so on a
 * memo-capable network we RELAY the buyer's signed transfer instead of handing it to
 * Circle's facilitator. This is a SECOND settlement path, gated on the network
 * capability (`supportsMemo`), living beside Circle Gateway — never replacing it.
 *
 * CUSTODY-FREE (the hard rule) HOLDS. The relayer signs only the OUTER transaction
 * (it pays gas — USDC is native gas on Arc, an operating cost). The INNER USDC
 * transfer is the BUYER's EIP-3009 authorization: funds move buyer→author directly,
 * the relayer is never `from`, never `to`, never a custodian. A relayer that tried to
 * redirect funds would invalidate the buyer's signature (the recipient is signed
 * over). `assertCustodyFree` encodes this invariant.
 *
 * GROUND TRUTH (verified 2026-06-19 against testnet.arcscan.app / Blockscout):
 *   - Memo `0x5294…`  : memo(address target, bytes data, bytes32 memoId, bytes memoData)
 *                       event Memo(address indexed sender, address indexed target,
 *                         bytes32 callDataHash, bytes32 indexed memoId, bytes memo,
 *                         uint256 memoIndex)
 *   - Arc USDC        : NativeFiatTokenV2_2 — has the `(…, bytes signature)` overload
 *                       of transferWithAuthorization; EIP-712 domain version "2".
 */
import {
  supportsMemo,
  usdcDomain,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  type SettlementNetwork,
  type MemoAuthorization,
} from "@naulon/shared";

// The EIP-3009 protocol descriptor (the MemoAuthorization shape, the EIP-712 typed-data
// types, and usdcDomain) lives in `@naulon/shared` — the single source of truth the
// BUYER signs against and this GATE verifies against. This file keeps the server side:
// the on-chain ABIs, the self-relay settle, and the off-chain pre-verify.

/** Arc USDC EIP-3009 — ONLY the `bytes signature` overload (FiatTokenV2_2). Kept to
 *  one entry so viem never has to disambiguate the overloaded selector. */
export const USDC_TRANSFER_WITH_AUTHORIZATION_ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

/** Arc Memo predeploy — `memo(target,data,memoId,memoData)` wraps the subcall through
 *  the CALL_FROM precompile and emits the indexed `Memo` event. */
export const MEMO_ABI = [
  {
    type: "function",
    name: "memo",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "data", type: "bytes" },
      { name: "memoId", type: "bytes32" },
      { name: "memoData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

/** Coerce an arbitrary reconciliation id into the Memo's `bytes32 memoId`. A 32-byte
 *  hex passes through; anything else is keccak256'd so any string (a license jti, a
 *  citation id) yields a stable, indexed lookup key. Pure (lazy viem import). */
export async function toMemoId(id: string): Promise<`0x${string}`> {
  if (/^0x[0-9a-fA-F]{64}$/.test(id)) return id as `0x${string}`;
  const { keccak256, stringToBytes } = await import("viem");
  return keccak256(stringToBytes(id));
}

/** The `Memo` event's `memoData` — the human/agent-readable reconciliation blob as
 *  raw bytes (utf8). Kept separate from `memoId` (the indexed lookup key). */
export async function toMemoData(data: string): Promise<`0x${string}`> {
  const { stringToHex } = await import("viem");
  return stringToHex(data);
}

/** Custody-free invariant: the relayer must never be the transfer's recipient, and the
 *  recipient must be the leg's intended `payTo`. The buyer signed `to` into the
 *  authorization, so a relayer cannot redirect funds without breaking the signature —
 *  this guard catches a programming error (mis-wired leg) BEFORE we spend gas. */
export function assertCustodyFree(auth: MemoAuthorization, payTo: string, relayer: string): void {
  if (auth.to.toLowerCase() !== payTo.toLowerCase()) {
    throw new Error(`relay custody violation: authorization.to ${auth.to} != leg payTo ${payTo}`);
  }
  if (auth.to.toLowerCase() === relayer.toLowerCase()) {
    throw new Error(`relay custody violation: funds would land on the relayer ${relayer}`);
  }
}

/** Buyer side: sign a raw USDC EIP-3009 `TransferWithAuthorization` against the USDC
 *  EIP-712 domain (NOT the GatewayWallet domain — that is the only difference from the
 *  batched path). Returns the `{authorization, signature}` payload the relay settle path
 *  consumes. `nonce` defaults to a fresh random bytes32; `validAfter`/`validBefore`
 *  bracket `nowMs`. SDK-free — only viem, lazily. */
export async function signMemoAuthorization(args: {
  privateKey: `0x${string}`;
  net: SettlementNetwork;
  payTo: `0x${string}`;
  amountAtomic: string;
  maxTimeoutSeconds: number;
  nowMs: number;
  nonce?: `0x${string}`;
  usdcNameOverride?: string;
}): Promise<{ authorization: MemoAuthorization; signature: `0x${string}` }> {
  const { privateKeyToAccount } = await import("viem/accounts");
  const { toHex } = await import("viem");
  const account = privateKeyToAccount(args.privateKey);
  const nonce = args.nonce ?? toHex(crypto.getRandomValues(new Uint8Array(32)));
  const nowSec = Math.floor(args.nowMs / 1000);
  const authorization: MemoAuthorization = {
    from: account.address,
    to: args.payTo,
    value: args.amountAtomic,
    validAfter: "0",
    validBefore: String(nowSec + args.maxTimeoutSeconds),
    nonce,
  };
  const signature = await account.signTypedData({
    domain: usdcDomain(args.net, args.usdcNameOverride),
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
  });
  return { authorization, signature };
}

/** Derive the relayer EOA address from its private key (for the custody-free assert
 *  and ledger labelling). Lazy viem. */
export async function relayerAddress(privateKey: `0x${string}`): Promise<`0x${string}`> {
  const { privateKeyToAccount } = await import("viem/accounts");
  return privateKeyToAccount(privateKey).address;
}

/** Build the inner USDC `transferWithAuthorization(bytes signature)` calldata. */
export async function encodeUsdcTransfer(
  auth: MemoAuthorization,
  signature: `0x${string}`,
): Promise<`0x${string}`> {
  const { encodeFunctionData } = await import("viem");
  return encodeFunctionData({
    abi: USDC_TRANSFER_WITH_AUTHORIZATION_ABI,
    functionName: "transferWithAuthorization",
    args: [
      auth.from,
      auth.to,
      BigInt(auth.value),
      BigInt(auth.validAfter),
      BigInt(auth.validBefore),
      auth.nonce,
      signature,
    ],
  });
}

/** Build the outer `Memo.memo(USDC, transferCalldata, memoId, memoData)` transaction
 *  — `{ to: memoContract, data }`, ready to broadcast from the relayer EOA. Pure. */
export async function buildMemoSettlementTx(args: {
  net: SettlementNetwork & { memo: NonNullable<SettlementNetwork["memo"]> };
  auth: MemoAuthorization;
  signature: `0x${string}`;
  memoId: `0x${string}`;
  memoData: `0x${string}`;
}): Promise<{ to: `0x${string}`; data: `0x${string}` }> {
  const { encodeFunctionData } = await import("viem");
  const transferData = await encodeUsdcTransfer(args.auth, args.signature);
  const data = encodeFunctionData({
    abi: MEMO_ABI,
    functionName: "memo",
    args: [args.net.usdc, transferData, args.memoId, args.memoData],
  });
  return { to: args.net.memo.contract, data };
}

/** Off-chain EIP-3009 pre-verify: recover the signer against the USDC domain and check
 *  the validity window — so a bad/expired authorization returns a clean 402 instead of
 *  wasting gas on a tx that would revert on-chain anyway. (The on-chain transfer remains
 *  the ultimate guard: a replayed nonce or paused token still reverts there.) */
export async function preverifyEip3009(
  auth: MemoAuthorization,
  signature: `0x${string}`,
  net: SettlementNetwork,
  nowMs: number,
  nameOverride?: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { recoverTypedDataAddress } = await import("viem");
  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec < Number(auth.validAfter)) return { ok: false, reason: "authorization not yet valid" };
  if (nowSec > Number(auth.validBefore)) return { ok: false, reason: "authorization expired" };
  let recovered: string;
  try {
    recovered = await recoverTypedDataAddress({
      domain: usdcDomain(net, nameOverride),
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
      signature,
    });
  } catch (err) {
    return { ok: false, reason: `signature recovery failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (recovered.toLowerCase() !== auth.from.toLowerCase()) {
    return { ok: false, reason: `signer ${recovered} != authorization.from ${auth.from}` };
  }
  return { ok: true };
}

/** The broadcast seam: submit the built Memo transaction from the relayer EOA and wait
 *  for inclusion. Real implementation uses viem; tests inject a stub so the routing +
 *  encoding are exercised with no funds, no RPC. */
export type RelayBroadcaster = (
  tx: { to: `0x${string}`; data: `0x${string}` },
  net: SettlementNetwork,
) => Promise<{ success: boolean; transaction?: string; errorReason?: string }>;

let broadcaster: RelayBroadcaster = defaultViemBroadcaster;

/** Override the broadcaster (tests only — keeps the viem RPC out of the no-funds suite). */
export function setRelayBroadcasterForTest(fn: RelayBroadcaster): void {
  broadcaster = fn;
}
/** Restore the real viem broadcaster. */
export function resetRelayBroadcaster(): void {
  broadcaster = defaultViemBroadcaster;
}

/** Default broadcaster — a viem wallet client on the active network's RPC, signing with
 *  the relayer key. Lazy so neither viem-account nor an RPC loads on the mock/Gateway
 *  paths. The relayer pays gas (native USDC on Arc); it never touches the transferred
 *  funds. */
async function defaultViemBroadcaster(
  tx: { to: `0x${string}`; data: `0x${string}` },
  net: SettlementNetwork,
): Promise<{ success: boolean; transaction?: string; errorReason?: string }> {
  const { getConfig } = await import("@naulon/shared");
  const relayerKey = getConfig().RELAYER_PRIVATE_KEY;
  if (!relayerKey) {
    return { success: false, errorReason: "RELAYER_PRIVATE_KEY required for memo-network settlement" };
  }
  const key = (relayerKey.startsWith("0x") ? relayerKey : `0x${relayerKey}`) as `0x${string}`;
  try {
    const [{ createWalletClient, http, defineChain }, { privateKeyToAccount }] = await Promise.all([
      import("viem"),
      import("viem/accounts"),
    ]);
    const chain = defineChain({
      id: net.chainId,
      name: net.chainName,
      nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
      rpcUrls: { default: { http: [net.rpcUrl] } },
    });
    const client = createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(net.rpcUrl) });
    const hash = await client.sendTransaction({ to: tx.to, data: tx.data });
    return { success: true, transaction: hash };
  } catch (err) {
    return { success: false, errorReason: err instanceof Error ? err.message : String(err) };
  }
}

/** Settle one leg through the Arc Memo predeploy: pre-verify the buyer's EIP-3009
 *  authorization, assert custody-free, build the Memo-wrapped transfer, and relay it.
 *  `memoId`/`memoData` are already coerced (see `toMemoId`/`toMemoData`). The active
 *  network MUST be memo-capable — callers gate on `supportsMemo` first. */
export async function settleViaMemo(args: {
  net: SettlementNetwork;
  auth: MemoAuthorization;
  signature: `0x${string}`;
  payTo: string;
  relayerAddress: string;
  memoId: `0x${string}`;
  memoData: `0x${string}`;
  nowMs: number;
  usdcNameOverride?: string;
}): Promise<{ success: boolean; transaction?: string; errorReason?: string; payer?: string }> {
  const { net, auth, signature, payTo, relayerAddress, memoId, memoData, nowMs } = args;
  if (!supportsMemo(net)) {
    return { success: false, errorReason: `network ${net.chainName} has no Memo predeploy` };
  }
  try {
    assertCustodyFree(auth, payTo, relayerAddress);
  } catch (err) {
    return { success: false, errorReason: err instanceof Error ? err.message : String(err) };
  }
  const pre = await preverifyEip3009(auth, signature, net, nowMs, args.usdcNameOverride);
  if (!pre.ok) return { success: false, errorReason: pre.reason };
  const tx = await buildMemoSettlementTx({ net, auth, signature, memoId, memoData });
  const result = await broadcaster(tx, net);
  return { ...result, payer: auth.from };
}
