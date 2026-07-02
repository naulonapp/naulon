/**
 * Seed the ledger with a handful of realistic crossings so the dashboard has
 * something to show without a live agent run. Idempotent-ish: it appends, so
 * clear EVENTS_PATH first for a clean slate.
 *
 *   npm run -w @naulon/dashboard seed
 */
import {
  getSink,
  usdc,
  walletAddress,
  type AttributedEvent,
  type AuthorShare,
} from "@naulon/shared";

const W = {
  ava: walletAddress("0x1111111111111111111111111111111111111111"),
  guest: walletAddress("0x2222222222222222222222222222222222222222"),
  mira: walletAddress("0x3333333333333333333333333333333333333333"),
  ito: walletAddress("0x4444444444444444444444444444444444444444"),
};
const AGENTS = [
  "0xA1c0000000000000000000000000000000000001",
  "0xB0b0000000000000000000000000000000000002",
  "0xC1a0000000000000000000000000000000000003",
];

function ev(
  i: number,
  slug: string,
  kind: "read" | "citation",
  amount: number,
  payees: AuthorShare[],
  minsAgo: number,
): AttributedEvent {
  return {
    id: `seed-${i}`,
    slug,
    kind,
    amount: usdc(amount),
    payees,
    payerAddress: walletAddress(AGENTS[i % AGENTS.length]!),
    settlementRef: `seed-batch-${1000 + i}`,
    at: Date.now() - minsAgo * 60_000,
  };
}

const solo = (w: string): AuthorShare[] => [
  { authorId: nameOf(w), wallet: w as AuthorShare["wallet"], share: 1 },
];
const split = (a: string, sa: number, b: string, sb: number): AuthorShare[] => [
  { authorId: nameOf(a), wallet: a as AuthorShare["wallet"], share: sa },
  { authorId: nameOf(b), wallet: b as AuthorShare["wallet"], share: sb },
];
function nameOf(wallet: string): string {
  return Object.entries(W).find(([, w]) => w === wallet)?.[0] ?? "unknown";
}

const events: AttributedEvent[] = [
  ev(0, "on-stillness", "read", 0.001, solo(W.ava), 87),
  ev(1, "the-naulon", "citation", 0.005, split(W.ava, 2 / 3, W.guest, 1 / 3), 74),
  ev(2, "the-river-and-the-name", "citation", 0.005, split(W.ava, 0.5, W.guest, 0.5), 61),
  ev(3, "on-stillness", "citation", 0.005, solo(W.ava), 52),
  ev(4, "the-weight-of-water", "read", 0.001, solo(W.mira), 40),
  ev(5, "the-naulon", "read", 0.001, split(W.ava, 2 / 3, W.guest, 1 / 3), 33),
  ev(6, "the-weight-of-water", "citation", 0.005, split(W.mira, 0.7, W.ito, 0.3), 21),
  ev(7, "the-river-and-the-name", "read", 0.001, split(W.ava, 0.5, W.guest, 0.5), 12),
  ev(8, "the-weight-of-water", "citation", 0.005, split(W.mira, 0.7, W.ito, 0.3), 5),
  ev(9, "on-stillness", "citation", 0.005, solo(W.ava), 1),
];

const sink = getSink();
for (const e of events) await sink.record(e);
console.log(`seeded ${events.length} crossings into the ledger.`);
