import assert from "node:assert/strict";
import { test } from "node:test";
import { author, primaryPayee, resolvePayees, splitAmount, splitAuthorLegs } from "./attribution.ts";
import type { ArticleCredits, AuthorShare } from "./types.ts";
import { walletAddress } from "./types.ts";

const W1 = "0x1111111111111111111111111111111111111111";
const W2 = "0x2222222222222222222222222222222222222222";
const W3 = "0x3333333333333333333333333333333333333333";

const share = (id: string, wallet: string, s: number): AuthorShare => ({
  authorId: id,
  wallet: walletAddress(wallet),
  share: s,
});

test("single author gets the whole share", () => {
  const credits: ArticleCredits = {
    slug: "a",
    title: "A",
    contributors: [author("alice", W1)],
  };
  const payees = resolvePayees(credits);
  assert.equal(payees.length, 1);
  assert.equal(payees[0]!.share, 1);
});

test("equal co-authors split evenly", () => {
  const credits: ArticleCredits = {
    slug: "a",
    title: "A",
    contributors: [author("alice", W1), author("bob", W2)],
  };
  const payees = resolvePayees(credits);
  assert.equal(payees.length, 2);
  assert.equal(payees[0]!.share, 0.5);
  assert.equal(payees[1]!.share, 0.5);
});

test("recursive composite re-splits its slice", () => {
  // alice 50%; a collective holds the other 50%, split between bob & carol.
  const credits: ArticleCredits = {
    slug: "a",
    title: "A",
    contributors: [
      author("alice", W1),
      {
        authorId: "collective",
        members: [author("bob", W2), author("carol", W3)],
      },
    ],
  };
  const payees = resolvePayees(credits);
  const byId = Object.fromEntries(payees.map((p) => [p.authorId, p.share]));
  assert.equal(byId["alice"], 0.5);
  assert.equal(byId["bob"], 0.25);
  assert.equal(byId["carol"], 0.25);
});

test("duplicate wallet across subtrees merges into one payee", () => {
  const credits: ArticleCredits = {
    slug: "a",
    title: "A",
    contributors: [
      author("alice", W1),
      { authorId: "grp", members: [author("alice-again", W1)] },
    ],
  };
  const payees = resolvePayees(credits);
  assert.equal(payees.length, 1);
  assert.equal(payees[0]!.share, 1);
});

test("splitAmount conserves the toll exactly (no dust)", () => {
  const payees = resolvePayees({
    slug: "a",
    title: "A",
    contributors: [author("a", W1), author("b", W2), author("c", W3)],
  });
  // 0.001 USDC = 1000 micro across 3 -> 334/333/333 after remainder.
  const split = splitAmount(0.001, payees);
  const sum = split.reduce((s, x) => s + x.amountUsdc, 0);
  assert.ok(Math.abs(sum - 0.001) < 1e-9, `sum ${sum} != 0.001`);
});

test("primaryPayee picks the highest share regardless of order", () => {
  const payees = [share("a", W1, 0.2), share("b", W2, 0.5), share("c", W3, 0.3)];
  assert.equal(primaryPayee(payees), W2);
});

test("primaryPayee tie-break 'wallet' is order-independent", () => {
  // Equal top shares; W2 < W3 lexicographically, so W2 wins either input order.
  const forward = [share("b", W2, 0.5), share("c", W3, 0.5)];
  const reversed = [share("c", W3, 0.5), share("b", W2, 0.5)];
  assert.equal(primaryPayee(forward, "wallet"), W2);
  assert.equal(primaryPayee(reversed, "wallet"), W2);
});

test("primaryPayee tie-break 'input' keeps credits-graph order", () => {
  const forward = [share("c", W3, 0.5), share("b", W2, 0.5)];
  const reversed = [share("b", W2, 0.5), share("c", W3, 0.5)];
  assert.equal(primaryPayee(forward, "input"), W3);
  assert.equal(primaryPayee(reversed, "input"), W2);
});

test("primaryPayee throws on an empty payee list", () => {
  assert.throws(() => primaryPayee([]), /no payees/);
});

// --- splitAuthorLegs: custody-free split-at-source ---

/** Total of a split must always equal the price exactly — no dust created or lost. */
const legSum = (s: ReturnType<typeof splitAuthorLegs>): number =>
  Number(s.primaryAmountMicro) + s.coauthorLegs.reduce((acc, l) => acc + Number(l.amountMicro), 0);

test("splitAuthorLegs: single author → no co-author legs, primary gets the whole price", () => {
  const split = splitAuthorLegs([share("a", W1, 1)], 1000);
  assert.equal(split.primaryPayTo, W1);
  assert.equal(split.primaryAmountMicro, "1000");
  assert.deepEqual(split.coauthorLegs, []);
});

test("splitAuthorLegs: equal co-authors split and sum EXACTLY to price", () => {
  const split = splitAuthorLegs([share("a", W1, 0.5), share("b", W2, 0.5)], 1000);
  assert.equal(split.primaryPayTo, W1); // W1 < W2 wallet tie-break
  assert.equal(split.primaryAmountMicro, "500");
  assert.equal(split.coauthorLegs.length, 1);
  assert.deepEqual(split.coauthorLegs[0], { payTo: W2, amountMicro: "500" });
  assert.equal(legSum(split), 1000);
});

test("splitAuthorLegs: three unequal authors → one leg each (minus primary), exact sum", () => {
  const split = splitAuthorLegs([share("a", W1, 0.5), share("b", W2, 0.3), share("c", W3, 0.2)], 1000);
  assert.equal(split.primaryPayTo, W1);
  assert.equal(split.primaryAmountMicro, "500");
  const byWallet = Object.fromEntries(split.coauthorLegs.map((l) => [l.payTo, l.amountMicro]));
  assert.deepEqual(byWallet, { [W2]: "300", [W3]: "200" });
  assert.equal(legSum(split), 1000);
});

test("splitAuthorLegs: a co-author cut that floors to 0 micro is DROPPED, sum still exact", () => {
  // W2's 0.0005 of 1000 micro floors to 0 → no dust transfer; its unit lands on the primary.
  const split = splitAuthorLegs([share("a", W1, 0.9995), share("b", W2, 0.0005)], 1000);
  assert.equal(split.primaryPayTo, W1);
  assert.equal(split.coauthorLegs.length, 0);
  assert.equal(split.primaryAmountMicro, "1000");
  assert.equal(legSum(split), 1000);
});

test("splitAuthorLegs: the primary is NEVER also a co-author leg (custody-free, no double-pay)", () => {
  const split = splitAuthorLegs([share("a", W1, 0.4), share("b", W2, 0.35), share("c", W3, 0.25)], 999_999);
  assert.ok(!split.coauthorLegs.some((l) => l.payTo === split.primaryPayTo), "primary must not appear in co-author legs");
  assert.equal(legSum(split), 999_999); // exact even with an odd, non-divisible price
});

test("splitAuthorLegs: on-chain leg amounts match the ledger split (splitAmount) exactly", () => {
  // The split paid on-chain must equal what the earnings ledger records as owed, or
  // reconciliation shows phantom drift. Both derive from splitMicro → byte-identical.
  const payees = [share("a", W1, 0.5), share("b", W2, 0.3), share("c", W3, 0.2)];
  const atomic = 1_234_567;
  const split = splitAuthorLegs(payees, atomic);
  const ledger = Object.fromEntries(splitAmount(atomic / 1_000_000, payees).map((a) => [a.wallet, Math.round(a.amountUsdc * 1_000_000)]));
  assert.equal(Number(split.primaryAmountMicro), ledger[split.primaryPayTo]);
  for (const leg of split.coauthorLegs) assert.equal(Number(leg.amountMicro), ledger[leg.payTo]);
  assert.equal(legSum(split), atomic);
});
