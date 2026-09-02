import { test } from "node:test";
import assert from "node:assert/strict";
import type { RslTermsForUrl } from "@naulon/sdk/rsl";
import { DEFAULT_POLICY, decide, spendGate, type DecisionPolicy } from "./decide.ts";
import type { AppraisedCandidate } from "./types.ts";
import type { Usdc } from "@naulon/shared";

const terms = (over: Partial<RslTermsForUrl> = {}): RslTermsForUrl => ({
  scopes: ["/"],
  usage: { "ai-input": true },
  read: { paymentType: "crawl", amount: { value: 0.01, currency: "USD" }, accepts: [], scope: "/" },
  obligation: "inline",
  ...over,
});

const policy: DecisionPolicy = { relevanceFloor: 0.1, maxPaid: 10 };

test("no published licence changes nothing — the world before RSL is still allowed", () => {
  assert.deepEqual(spendGate({ host: "pub.example", priceUsdc: 0.01, policy }), { ok: true });
  assert.deepEqual(spendGate({ host: "pub.example", priceUsdc: 0.01, policy, licence: null }), { ok: true });
});

test("a licence prohibiting ai-input refuses the pay, whatever the budget says", () => {
  const v = spendGate({
    host: "pub.example",
    priceUsdc: 0.01,
    policy,
    remainingUsdc: 1000,
    licence: terms({ usage: { "ai-input": false } }),
  });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.action, "skip");
  assert.match(v.ok === false ? v.reason : "", /prohibits ai-input/);
});

test("a licence-server obligation refuses: paying the inline price licenses nothing", () => {
  const v = spendGate({
    host: "pub.example",
    priceUsdc: 0.01,
    policy,
    licence: terms({ obligation: "license-server", server: "https://olp.example/api" }),
  });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.action, "skip");
  assert.match(v.ok === false ? v.reason : "", /olp\.example/);
});

test("a quote far above the published price asks a human rather than paying it", () => {
  const v = spendGate({ host: "pub.example", priceUsdc: 0.1, policy: DEFAULT_POLICY, licence: terms() });
  assert.equal(v.ok === false && v.action, "approve");
  assert.match(v.ok === false ? v.reason : "", /exceeds the published price/);
});

test("a quote inside the tolerance is paid — a fee leg is not an overcharge", () => {
  // 0.011 against a published 0.01 is the exact shape of naulon's own operator fee.
  assert.deepEqual(
    spendGate({ host: "pub.example", priceUsdc: 0.011, policy: DEFAULT_POLICY, licence: terms() }),
    { ok: true },
  );
});

test("with the tolerance unset there is no overcharge gate at all", () => {
  assert.deepEqual(spendGate({ host: "pub.example", priceUsdc: 100, policy, licence: terms() }), { ok: true });
});

test("a non-USD published price is not compared against a USDC quote", () => {
  const eur = terms({ read: { paymentType: "crawl", amount: { value: 0.001, currency: "EUR" }, accepts: [], scope: "/" } });
  assert.deepEqual(
    spendGate({ host: "pub.example", priceUsdc: 5, policy: DEFAULT_POLICY, licence: eur }),
    { ok: true },
  );
});

test("a published price with no amount states no number to be compared with", () => {
  const unpriced = terms({ read: { paymentType: "crawl", accepts: [], scope: "/" } });
  assert.deepEqual(
    spendGate({ host: "pub.example", priceUsdc: 5, policy: DEFAULT_POLICY, licence: unpriced }),
    { ok: true },
  );
});

test("operator policy is evaluated before the publisher's licence", () => {
  // Both apply; the operator's own kill-switch is the reason surfaced, because it is the reason
  // this run is not spending at all.
  const v = spendGate({
    host: "pub.example",
    priceUsdc: 0.01,
    policy: { ...policy, killSwitch: true },
    licence: terms({ usage: { "ai-input": false } }),
  });
  assert.match(v.ok === false ? v.reason : "", /kill-switch/);
});

test("decide() matches a licence to the url money goes to, not to the candidate's claimed host", () => {
  const candidate = (slug: string, url: string): AppraisedCandidate => ({
    slug,
    title: slug,
    summary: "",
    url,
    // A hostile discovery source can claim any host; policy and licence both key off the pay URL.
    host: "trusted.example",
    price: 0.01 as Usdc,
    relevance: 0.9,
    rationale: "",
  });
  const decisions = decide(
    [candidate("a", "https://pub.example/a"), candidate("b", "https://pub.example/b")],
    10,
    new Set(),
    { ...policy, allowDomains: ["pub.example"] },
    {
      licences: {
        "https://pub.example/a": terms({ usage: { "ai-input": false } }),
        "https://pub.example/b": terms(),
      },
    },
  );
  const byslug = Object.fromEntries(decisions.map((d) => [d.slug, d]));
  assert.equal(byslug["a"]!.action, "skip");
  assert.match(byslug["a"]!.reason, /prohibits ai-input/);
  assert.equal(byslug["b"]!.action, "pay");
});

test("a candidate with no resolvable pay url is never matched to someone else's licence", () => {
  const decisions = decide(
    [{ slug: "s", title: "s", summary: "", price: 0.01 as Usdc, relevance: 0.9, rationale: "" }],
    10,
    new Set(),
    { ...policy, allowDomains: ["pub.example"] },
    { licences: { "https://pub.example/a": terms() } },
  );
  assert.equal(decisions[0]!.action, "skip");
  assert.match(decisions[0]!.reason, /host unknown|no resolvable pay URL/);
});
