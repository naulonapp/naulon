/**
 * Attribution & settlement service. One pass:
 *
 *   1. read the attributed-event ledger (what machines have paid for)
 *   2. subtract what's already been settled (the payouts ledger)
 *   3. batch the rest into one payout per author wallet, above a minimum
 *   4. settle (mock, or Circle Gateway once wired) and append the receipts
 *
 * Idempotent: events already covered by a receipt are never paid twice. Run it
 * on a schedule (cron) or after a wayfarer run. Recursive co-author splits are
 * already baked into each event's payees by the tollgate.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getConfig, getSink } from "@naulon/shared";
import { batchCuts, expandCuts } from "./batch.ts";
import { getSettlement, type Receipt } from "./settlement.ts";

const cfg = getConfig();
// Same ledger the tollgate writes — file or Supabase, per EVENTS_BACKEND.
const events = getSink();

async function readReceipts(path: string): Promise<Receipt[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Receipt);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function appendReceipts(path: string, receipts: Receipt[]): Promise<void> {
  if (receipts.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, receipts.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

async function main(): Promise<void> {
  const all = await events.readAll();
  const receipts = await readReceipts(cfg.PAYOUTS_PATH);
  // Settlement is tracked per (event, wallet): a co-author paid out doesn't mark
  // a co-author whose smaller share is still deferred as settled.
  const settled = new Set(receipts.flatMap((r) => r.eventIds.map((id) => `${id}:${r.wallet}`)));

  const cuts = expandCuts(all);
  const pending = cuts.filter((c) => !settled.has(`${c.eventId}:${c.wallet}`));
  console.log(`ledger: ${all.length} events (${cuts.length} cuts) · ${settled.size} settled · ${pending.length} pending`);
  if (pending.length === 0) {
    console.log("nothing to settle.");
    return;
  }

  const { payouts, deferred } = batchCuts(pending, cfg.MIN_PAYOUT_USDC);
  const settlement = getSettlement();
  const now = Date.now();
  const newReceipts = await settlement.settle(payouts, now);
  await appendReceipts(cfg.PAYOUTS_PATH, newReceipts);

  const paid = newReceipts.reduce((s, r) => s + r.amountUsdc, 0);
  const held = deferred.reduce((s, p) => s + p.amountUsdc, 0);
  console.log(`\nsettled ${newReceipts.length} payout(s) — $${paid.toFixed(6)} total:`);
  for (const r of newReceipts) {
    console.log(`  → ${r.authorId} ${r.wallet}  $${r.amountUsdc.toFixed(6)}  (${r.eventIds.length} events, ref ${r.ref})`);
  }
  if (deferred.length) {
    console.log(`\ndeferred ${deferred.length} wallet(s) below $${cfg.MIN_PAYOUT_USDC} — carrying $${held.toFixed(6)} to next pass.`);
  }
}

await main();
