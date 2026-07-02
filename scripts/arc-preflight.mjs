/**
 * Settlement preflight (read-only) — run before the first REAL settle on any network,
 * especially the Arc memo self-relay rail. It answers the two questions a live settle
 * silently fails on:
 *
 *   1. Does the on-chain USDC EIP-712 domain match what we SIGN against? The buyer's
 *      raw EIP-3009 authorization is signed over `name()`/`version()`; a mismatch makes
 *      every signature reject with a confusing "recovered signer != from". Arc testnet
 *      USDC names itself "USDC" (not the mainnet FiatToken "USD Coin") — this catches it.
 *   2. Are the wallets funded the way the rail needs? The buyer needs raw ERC-20 USDC
 *      (EIP-3009 moves the token directly); the relayer needs native gas (it pays for
 *      the Memo broadcast). Gateway-deposited balance does NOT count for the memo rail.
 *
 * Network-agnostic: everything comes from `activeNetwork()` (SETTLEMENT_NETWORK) and the
 * configured wallets — no addresses are hardcoded here, so it tracks the registry.
 *
 *   npx tsx scripts/arc-preflight.mjs            (or: make arc-preflight)
 */
import { createPublicClient, http, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { activeNetwork, supportsMemo, getConfig } from "@naulon/shared";

const cfg = getConfig();
const net = activeNetwork();
const client = createPublicClient({ transport: http(net.rpcUrl) });

const ERC20 = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];

const norm = (k) => (k ? (k.startsWith("0x") ? k : `0x${k}`) : null);
const addr = (k, fallback) => (k ? privateKeyToAccount(norm(k)).address : fallback ?? null);

const buyer = addr(cfg.BUYER_PRIVATE_KEY, cfg.BUYER_ADDRESS);
const relayer = addr(cfg.RELAYER_PRIVATE_KEY, null);

// Author = the primary payee of the first fixture article (best-effort; only for a
// balance read — recursive composite credits fall back to the first leaf wallet).
let author = null;
try {
  const fix = JSON.parse(readFileSync(cfg.CREDITS_FIXTURES, "utf8"));
  const first = Object.values(fix)[0];
  const walk = (c) => c?.wallet ?? (c?.members ? walk(c.members[0]) : null);
  author = walk(first?.contributors?.[0]);
} catch { /* fixtures optional */ }

const fmt = (n, decimals) => Number(n) / 10 ** decimals;

console.log(`\nSETTLEMENT_NETWORK = ${net.chainName}  (chainId ${net.chainId}, memo ${supportsMemo(net) ? "YES" : "no"})`);
const block = await client.getBlockNumber().catch((e) => `RPC ERROR: ${e.message}`);
console.log(`RPC ${net.rpcUrl} — block ${block}`);

// 1) USDC EIP-712 domain
const want = cfg.USDC_EIP712_NAME ?? net.usdcName ?? "USD Coin";
let onchainName, onchainVersion;
try { onchainName = await client.readContract({ address: net.usdc, abi: ERC20, functionName: "name" }); } catch (e) { onchainName = `ERR ${e.message}`; }
try { onchainVersion = await client.readContract({ address: net.usdc, abi: ERC20, functionName: "version" }); } catch { onchainVersion = "(no version())"; }
const nameOk = onchainName === want;
console.log(`\nUSDC ${net.usdc}`);
console.log(`  name()    on-chain ${JSON.stringify(onchainName)}  vs signed ${JSON.stringify(want)}  ${nameOk ? "✓" : "✗ MISMATCH — set USDC_EIP712_NAME"}`);
console.log(`  version() on-chain ${JSON.stringify(onchainVersion)}  vs signed ${JSON.stringify(net.usdcVersion ?? "2")}`);

// 2) Balances
async function report(label, a) {
  if (!a || !a.startsWith("0x")) { console.log(`  ${label}: ${a ?? "(not configured)"}`); return { native: 0n, token: 0n }; }
  const A = getAddress(a);
  const native = await client.getBalance({ address: A }).catch(() => 0n);
  const token = await client.readContract({ address: net.usdc, abi: ERC20, functionName: "balanceOf", args: [A] }).catch(() => 0n);
  console.log(`  ${label} ${A}`);
  console.log(`      native(gas) ${fmt(native, 18)}    erc20 USDC ${fmt(token, 6)}`);
  return { native, token };
}
console.log(`\nWallets (raw on-chain — gateway-deposited balance does NOT count for the memo rail):`);
const b = await report("BUYER  ", buyer);
const r = await report("RELAYER", relayer);
await report("AUTHOR ", author);

// Verdict for a memo settle
if (supportsMemo(net)) {
  const issues = [];
  if (!nameOk) issues.push("USDC name() mismatch (set USDC_EIP712_NAME)");
  if (b.token === 0n) issues.push("buyer holds no ERC-20 USDC to transfer");
  if (!relayer) issues.push("RELAYER_PRIVATE_KEY not set");
  else if (r.native === 0n) issues.push("relayer has no native gas");
  console.log(`\n${issues.length ? "⚠️  NOT READY for a memo settle:\n   - " + issues.join("\n   - ") : "✅ READY for a memo settle on " + net.chainName}`);
} else {
  console.log(`\n(${net.chainName} has no Memo predeploy — settles via Circle Gateway, not the self-relay rail.)`);
}
