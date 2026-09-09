import assert from "node:assert/strict";
import { test } from "node:test";
import {
  author,
  primaryPayee,
  resolvePayees,
  splitAmount,
  splitAuthorLegs,
  walletTotals,
} from "./attribution.ts";
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

test("the SAME author across subtrees merges into one payee", () => {
  const credits: ArticleCredits = {
    slug: "a",
    title: "A",
    contributors: [
      author("alice", W1),
      { authorId: "grp", members: [author("alice", W1)] },
    ],
  };
  const payees = resolvePayees(credits);
  assert.equal(payees.length, 1);
  assert.equal(payees[0]!.share, 1);
});

test("two DIFFERENT authors on one wallet stay two payees — one transfer, two credits", () => {
  // The shape this repo actually produces: `wp-user-3` on one site and `wp-user-9` on
  // another are one writer with one address, and a couple sharing a wallet is the same
  // shape. Merging them by wallet kept the first id and dropped the second, so the
  // second author's earnings card, receipts, webhook line and "articles that credit me"
  // list were all empty while their money was being paid.
  const credits: ArticleCredits = {
    slug: "a",
    title: "A",
    contributors: [author("wp-user-3", W1), author("wp-user-9", W1), author("carol", W2)],
  };
  const payees = resolvePayees(credits);
  assert.equal(payees.length, 3, "identity is preserved");
  assert.equal(payees.find((p) => p.authorId === "wp-user-9")?.share, 1 / 3);

  // …but the RAIL still sees one transfer per address, and the shared wallet outranks
  // carol because its two authors hold 2/3 jointly.
  assert.deepEqual(walletTotals(payees), [
    { wallet: walletAddress(W1), share: 2 / 3 },
    { wallet: walletAddress(W2), share: 1 / 3 },
  ]);
  assert.equal(primaryPayee(payees), walletAddress(W1));

  const split = splitAuthorLegs(payees, 900);
  assert.equal(split.primaryPayTo, walletAddress(W1));
  assert.equal(split.primaryAmountMicro, "600", "both of W1's authors, in ONE leg");
  assert.deepEqual(split.coauthorLegs, [{ payTo: walletAddress(W2), amountMicro: "300" }]);
  assert.equal(
    Number(split.primaryAmountMicro) +
      split.coauthorLegs.reduce((s, l) => s + Number(l.amountMicro), 0),
    900,
    "no micro created or lost across the fold",
  );
});

test("the shared wallet wins the gating leg even when no single author leads", () => {
  // Without the wallet fold, primaryPayee compared 0.3 / 0.3 / 0.4 and handed the
  // synchronous, content-gating leg to the SMALLER real stake.
  const payees = [share("a", W1, 0.3), share("b", W1, 0.3), share("c", W2, 0.4)];
  assert.equal(primaryPayee(payees), walletAddress(W1));
  const split = splitAuthorLegs(payees, 1000);
  assert.equal(split.primaryAmountMicro, "600");
  assert.deepEqual(split.coauthorLegs, [{ payTo: walletAddress(W2), amountMicro: "400" }]);
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

/* DELEGATED PAYEES — named without a wallet, unfilled by the time credits reach here. Filtered
 * before the weight sum, or everyone else's shares sum to under 1 and the split pays out less than
 * the toll. These assert the total, not just the routing. */
const credits = (contributors: ArticleCredits["contributors"]): ArticleCredits => ({
  slug: "s",
  title: "t",
  contributors,
});

test("a delegated co-author's weight goes to the payable authors, not to nobody", () => {
  const payees = resolvePayees(
    credits([
      { authorId: "paid", wallet: walletAddress(W1), weight: 3 },
      { authorId: "delegated", weight: 1 }, // no wallet, nothing filled it
    ]),
  );
  assert.equal(payees.length, 1);
  assert.equal(payees[0]?.authorId, "paid");
  assert.equal(payees[0]?.share, 1, "the whole toll, not three quarters of it");

  const split = splitAmount(0.01, payees);
  assert.equal(
    split.reduce((s, a) => s + a.amountUsdc, 0).toFixed(6),
    (0.01).toFixed(6),
    "Σlegs must still equal the price",
  );
});

test("two payable authors keep their RELATIVE weights when a third is delegated", () => {
  const payees = resolvePayees(
    credits([
      { authorId: "a", wallet: walletAddress(W1), weight: 3 },
      { authorId: "b", wallet: walletAddress(W2), weight: 1 },
      { authorId: "c", weight: 4 },
    ]),
  );
  assert.equal(payees.length, 2);
  assert.equal(payees.find((p) => p.authorId === "a")?.share, 0.75);
  assert.equal(payees.find((p) => p.authorId === "b")?.share, 0.25);
});

test("a composite whose members are all delegated drops whole, and its siblings absorb it", () => {
  const payees = resolvePayees(
    credits([
      { authorId: "solo", wallet: walletAddress(W1), weight: 1 },
      { authorId: "studio", weight: 1, members: [{ authorId: "x" }, { authorId: "y" }] },
    ]),
  );
  assert.equal(payees.length, 1);
  assert.equal(payees[0]?.share, 1);
});

test("a composite with ONE payable member keeps only that member — and the composite's full slice", () => {
  const payees = resolvePayees(
    credits([
      { authorId: "solo", wallet: walletAddress(W1), weight: 1 },
      {
        authorId: "studio",
        weight: 1,
        members: [{ authorId: "x", wallet: walletAddress(W2), weight: 1 }, { authorId: "y", weight: 3 }],
      },
    ]),
  );
  assert.equal(payees.length, 2);
  assert.equal(payees.find((p) => p.authorId === "solo")?.share, 0.5);
  assert.equal(payees.find((p) => p.authorId === "x")?.share, 0.5, "y's weight goes to x, not out of the split");
});

test("credits where NOTHING is payable resolve to no payees at all — never a throw", () => {
  assert.deepEqual(resolvePayees(credits([{ authorId: "x" }, { authorId: "y", weight: 9 }])), []);
  assert.deepEqual(
    resolvePayees(credits([{ authorId: "group", members: [{ authorId: "x" }] }])),
    [],
    "…including through a composite",
  );
});

test("a delegated leaf that HAS been filled is an ordinary payee", () => {
  const payees = resolvePayees(
    credits([
      { authorId: "filled", wallet: walletAddress(W3), weight: 1 },
      { authorId: "paid", wallet: walletAddress(W1), weight: 1 },
    ]),
  );
  assert.equal(payees.length, 2);
  assert.equal(payees[0]?.share, 0.5);
});
