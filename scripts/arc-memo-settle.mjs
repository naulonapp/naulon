/**
 * Live Arc memo-settle smoke (SPENDS REAL FUNDS) — proves the self-relay rail on-chain.
 * Exercises the exact production path the gate runs at x402.ts:settleMemo:
 *   buyer signs a raw USDC EIP-3009 authorization  →  settleViaMemo() relays it through
 *   the Arc Memo predeploy  →  one tx that transfers buyer→author AND emits an indexed
 *   Memo event. Custody-free: the relayer signs only the outer tx (pays gas), never holds
 *   the USDC.
 *
 * Guards: refuses unless the active network ships the Memo predeploy AND CONFIRM_SPEND=1
 * is set (it moves real money). Run `make arc-preflight` first.
 *
 *   CONFIRM_SPEND=1 npx tsx scripts/arc-memo-settle.mjs [amountUsdc] [authorAddress]
 *   (or: make arc-settle)
 *
 * Defaults: amount $0.005, author = the first fixture article's primary payee.
 */
import { createPublicClient, http, decodeEventLog } from "viem";
import { readFileSync } from "node:fs";
import { activeNetwork, supportsMemo, getConfig, toAtomicUsdc } from "@naulon/shared";
import {
  signMemoAuthorization, settleViaMemo, relayerAddress, toMemoId, toMemoData,
} from "../packages/tollgate/src/arcRelay.ts";

const cfg = getConfig();
const net = activeNetwork();

if (!supportsMemo(net)) {
  console.error(`✗ ${net.chainName} has no Memo predeploy — this rail is memo-network only. Set SETTLEMENT_NETWORK=arcTestnet.`);
  process.exit(1);
}
if (process.env.CONFIRM_SPEND !== "1") {
  console.error("✗ refusing to spend real funds without CONFIRM_SPEND=1. Run `make arc-preflight` first, then re-run with CONFIRM_SPEND=1.");
  process.exit(1);
}

const norm = (k) => (k.startsWith("0x") ? k : `0x${k}`);
const buyerKey = norm(cfg.BUYER_PRIVATE_KEY ?? "");
const relayerKey = norm(cfg.RELAYER_PRIVATE_KEY ?? "");
if (!buyerKey.slice(2) || !relayerKey.slice(2)) {
  console.error("✗ BUYER_PRIVATE_KEY and RELAYER_PRIVATE_KEY are both required.");
  process.exit(1);
}

const amountUsdc = process.argv[2] ?? "0.005";
let author = process.argv[3];
if (!author) {
  const fix = JSON.parse(readFileSync(cfg.CREDITS_FIXTURES, "utf8"));
  const first = Object.values(fix)[0];
  const walk = (c) => c?.wallet ?? (c?.members ? walk(c.members[0]) : null);
  author = walk(first?.contributors?.[0]);
}
if (!author) { console.error("✗ no author address (pass one as argv[3] or set CREDITS_FIXTURES)."); process.exit(1); }

const amountAtomic = toAtomicUsdc(amountUsdc);
const now = Date.now();
const citationId = `naulon:smoke:${now}`;
const relayer = await relayerAddress(relayerKey);
const usdcName = cfg.USDC_EIP712_NAME; // undefined → per-network usdcName default

console.log(`network ${net.chainName} | buyer→author ${author} | $${amountUsdc} | relayer(gas) ${relayer}`);

// 1) Buyer signs the raw USDC EIP-3009 authorization (memo rail; USDC domain, not GatewayWallet).
const { authorization, signature } = await signMemoAuthorization({
  privateKey: buyerKey, net, payTo: author, amountAtomic,
  maxTimeoutSeconds: cfg.X402_MAX_TIMEOUT_SECONDS ?? 3600, nowMs: now, usdcNameOverride: usdcName,
});
console.log(`✓ buyer signed ${authorization.from} → ${authorization.to}`);

// 2) Gate self-relays through the Memo predeploy.
const result = await settleViaMemo({
  net, auth: authorization, signature, payTo: author, relayerAddress: relayer,
  memoId: await toMemoId(citationId), memoData: await toMemoData(citationId),
  nowMs: now, usdcNameOverride: usdcName,
});
if (!result.success) { console.error(`✗ settle failed: ${result.errorReason}`); process.exit(1); }
console.log(`✓ settled — tx ${result.transaction}`);

// 3) Confirm the on-chain Memo event (decode logs emitted by the Memo predeploy address).
const client = createPublicClient({ transport: http(net.rpcUrl) });
const rcpt = await client.waitForTransactionReceipt({ hash: result.transaction });
const MEMO_EVENT = [{ type: "event", name: "Memo", inputs: [
  { name: "sender", type: "address", indexed: true }, { name: "target", type: "address", indexed: true },
  { name: "callDataHash", type: "bytes32", indexed: false }, { name: "memoId", type: "bytes32", indexed: true },
  { name: "memo", type: "bytes", indexed: false }, { name: "memoIndex", type: "uint256", indexed: false },
]}];
console.log(`receipt: status=${rcpt.status} block=${rcpt.blockNumber} gas=${rcpt.gasUsed}`);
for (const log of rcpt.logs.filter((l) => l.address.toLowerCase() === net.memo.contract.toLowerCase())) {
  try {
    const ev = decodeEventLog({ abi: MEMO_EVENT, data: log.data, topics: log.topics });
    console.log(`✓ Memo event: memoId=${ev.args.memoId} memoIndex=${ev.args.memoIndex}`);
  } catch { /* a non-Memo log from the predeploy */ }
}
console.log(`explorer: https://testnet.arcscan.app/tx/${result.transaction}`);
