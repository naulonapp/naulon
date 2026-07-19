import assert from "node:assert/strict";
import { test } from "node:test";
import { usdc } from "@naulon/shared";
import { decide, DEFAULT_POLICY } from "./decide.ts";
import type { AppraisedCandidate } from "./types.ts";

function cand(slug: string, relevance: number, price: number): AppraisedCandidate {
  return { slug, title: slug, summary: "", price: usdc(price), relevance, rationale: "" };
}

/** A candidate pinned to a host — for the domain allow/deny/per-domain-cap policies.
 *  Sets `url` on that host too, because policy is evaluated against the url that will actually be
 *  PAID, never the free-form `host` field a discovery source supplies beside it (see the
 *  host-spoof test below). A real discovery source always carries both. */
function candOn(host: string, slug: string, relevance: number, price: number): AppraisedCandidate {
  return { ...cand(slug, relevance, price), host, url: `https://${host}/articles/${slug}` };
}

test("pays relevant essays within budget, ranked by density", () => {
  const decisions = decide(
    [cand("cheap-good", 0.8, 0.001), cand("dear-good", 0.8, 0.01)],
    1,
  );
  const cheap = decisions.find((d) => d.slug === "cheap-good")!;
  const dear = decisions.find((d) => d.slug === "dear-good")!;
  assert.equal(cheap.action, "pay");
  assert.equal(dear.action, "pay");
  // cheaper-but-equally-relevant ranks first
  assert.equal(decisions[0]!.slug, "cheap-good");
});

test("skips below the relevance floor", () => {
  const [d] = decide([cand("tangential", 0.1, 0.001)], 1);
  assert.equal(d!.action, "skip");
  assert.match(d!.reason, /below floor/);
});

test("stops paying when budget runs out", () => {
  const decisions = decide(
    [cand("a", 0.9, 0.6), cand("b", 0.9, 0.6)],
    1, // only one 0.6 fits
  );
  const paid = decisions.filter((d) => d.action === "pay");
  assert.equal(paid.length, 1);
  assert.ok(decisions.some((d) => d.action === "skip" && /exceeds remaining/.test(d.reason)));
});

test("reuses cached essays for free instead of paying", () => {
  const [d] = decide([cand("seen", 0.9, 0.001)], 1, new Set(["seen"]));
  assert.equal(d!.action, "cache");
});

test("a held license re-reads free even with no budget left", () => {
  // cached short-circuits before the budget check — a live license is zero-cost.
  const [d] = decide([cand("licensed", 0.9, 0.01)], 0, new Set(["licensed"]));
  assert.equal(d!.action, "cache");
  assert.match(d!.reason, /re-read free/);
});

test("respects maxPaid cap", () => {
  const many = Array.from({ length: 10 }, (_, i) => cand(`e${i}`, 0.9, 0.001));
  const decisions = decide(many, 1, new Set(), { ...DEFAULT_POLICY, maxPaid: 3 });
  assert.equal(decisions.filter((d) => d.action === "pay").length, 3);
});

// ── BUY-3.1: policy engine — caps, allow/deny, rate caps, approval, kill-switch ──

test("kill-switch halts all new spend (free re-reads still allowed)", () => {
  const decisions = decide(
    [cand("payme", 0.9, 0.001), cand("held", 0.9, 0.001)],
    1,
    new Set(["held"]),
    { ...DEFAULT_POLICY, killSwitch: true },
  );
  const pay = decisions.find((d) => d.slug === "payme")!;
  const cache = decisions.find((d) => d.slug === "held")!;
  assert.equal(pay.action, "skip");
  assert.match(pay.reason, /kill-switch/i);
  assert.equal(cache.action, "cache"); // a free re-read is not "spend" — still allowed
});

test("deny list is never paid, even when allowed and affordable", () => {
  const [d] = decide([candOn("evil.example", "x", 0.9, 0.001)], 1, new Set(), {
    ...DEFAULT_POLICY,
    denyDomains: ["evil.example"],
  });
  assert.equal(d!.action, "skip");
  assert.match(d!.reason, /denied/i);
});

test("allowlist pays in-list hosts and skips everything else (deny-by-default)", () => {
  const decisions = decide(
    [candOn("good.example", "in", 0.9, 0.001), candOn("other.example", "out", 0.9, 0.001), cand("nohost", 0.9, 0.001)],
    1,
    new Set(),
    { ...DEFAULT_POLICY, allowDomains: ["good.example"] },
  );
  assert.equal(decisions.find((d) => d.slug === "in")!.action, "pay");
  const out = decisions.find((d) => d.slug === "out")!;
  const nohost = decisions.find((d) => d.slug === "nohost")!;
  assert.equal(out.action, "skip");
  assert.match(out.reason, /allowlist/i);
  assert.equal(nohost.action, "skip"); // unknown host under an allowlist ⇒ deny-by-default
});

test("per-domain cap limits pays per host (this run)", () => {
  const decisions = decide(
    [candOn("h.example", "a", 0.9, 0.001), candOn("h.example", "b", 0.9, 0.001), candOn("other.example", "c", 0.9, 0.001)],
    1,
    new Set(),
    { ...DEFAULT_POLICY, perDomainCap: 1 },
  );
  assert.equal(decisions.filter((d) => d.action === "pay").length, 2); // 1 from h.example + 1 from other.example
  const capped = decisions.find((d) => d.action === "skip")!;
  assert.match(capped.reason, /per-domain cap/i);
});

test("per-domain cap counts prior spend in the window (context.priorDomainCounts)", () => {
  const [d] = decide([candOn("h.example", "a", 0.9, 0.001)], 1, new Set(), { ...DEFAULT_POLICY, perDomainCap: 2 }, {
    priorDomainCounts: { "h.example": 2 }, // already at the cap this window
  });
  assert.equal(d!.action, "skip");
  assert.match(d!.reason, /per-domain cap/i);
});

test("approval threshold defers a costly toll to 'approve' (no spend, budget intact)", () => {
  const decisions = decide(
    [cand("cheap", 0.9, 0.001), cand("dear", 0.9, 0.02)],
    1,
    new Set(),
    { ...DEFAULT_POLICY, approvalThresholdUsdc: 0.005 },
  );
  const cheap = decisions.find((d) => d.slug === "cheap")!;
  const dear = decisions.find((d) => d.slug === "dear")!;
  assert.equal(cheap.action, "pay");
  assert.equal(dear.action, "approve");
  assert.match(dear.reason, /approval/i);
});

// Finding-1 regression — domain policy MUST bind to the url that gets paid, never to the
// free-form `host` field the (untrusted) discovery source supplies alongside it. A malicious feed
// claiming host:"trusted-publisher.com" while pointing url at an attacker would otherwise pass an
// allow/deny check on one string while real USDC flowed to another.
test("domain policy uses the PAY url's host, not a spoofable Candidate.host", () => {
  const spoofed: AppraisedCandidate = {
    ...cand("x", 0.9, 0.001),
    host: "trusted-publisher.com", // what the feed CLAIMS
    url: "https://attacker.example/articles/x", // where the money would actually go
  };
  const [denied] = decide([spoofed], 1, new Set(), { ...DEFAULT_POLICY, denyDomains: ["attacker.example"] });
  assert.equal(denied!.action, "skip", "the real pay host is denied, despite the trusted-looking host field");
  assert.match(denied!.reason, /attacker\.example/);

  // And the mirror: an allowlist naming only the CLAIMED host must not let the real host through.
  const [notAllowed] = decide([spoofed], 1, new Set(), {
    ...DEFAULT_POLICY,
    allowDomains: ["trusted-publisher.com"],
  });
  assert.equal(notAllowed!.action, "skip", "a spoofed host field cannot satisfy the allowlist");
});

test("a slug-only candidate resolves its policy host from the configured gateBase", () => {
  const slugOnly = cand("y", 0.9, 0.001);
  const [d] = decide([slugOnly], 1, new Set(), { ...DEFAULT_POLICY, denyDomains: ["gate.example"] }, {
    gateBase: "https://gate.example",
  });
  assert.equal(d!.action, "skip", "the gate host the slug resolves to is what policy sees");
});

// Origin pin for the run()/research path. Default posture: only the configured gate is payable,
// because a discovery catalog is untrusted and can return any url. Multi-gate is opt-in via the
// existing allowDomains — no separate flag.
test("run-path origin pin: an off-gate candidate is refused by default", () => {
  const offGate: AppraisedCandidate = { ...cand("x", 0.9, 0.001), url: "https://attacker.example/a/x" };
  const [d] = decide([offGate], 1, new Set(), DEFAULT_POLICY, { gateBase: "https://gate.example" });
  assert.equal(d!.action, "skip", "only the configured gate is payable by default");
  assert.match(d!.reason, /not the configured gate/i);
});

test("run-path origin pin: an on-gate candidate still pays", () => {
  const onGate: AppraisedCandidate = { ...cand("x", 0.9, 0.001), url: "https://gate.example/a/x" };
  const [d] = decide([onGate], 1, new Set(), DEFAULT_POLICY, { gateBase: "https://gate.example" });
  assert.equal(d!.action, "pay");
});

test("run-path origin pin: allowDomains opts INTO multi-gate (one knob, not two)", () => {
  const other: AppraisedCandidate = { ...cand("x", 0.9, 0.001), url: "https://partner.example/a/x" };
  const [allowed] = decide([other], 1, new Set(), { ...DEFAULT_POLICY, allowDomains: ["partner.example"] }, {
    gateBase: "https://gate.example",
  });
  assert.equal(allowed!.action, "pay", "an explicit allowlist is the sanctioned multi-gate boundary");
  const [denied] = decide([other], 1, new Set(), { ...DEFAULT_POLICY, allowDomains: ["someone-else.example"] }, {
    gateBase: "https://gate.example",
  });
  assert.equal(denied!.action, "skip", "an allowlist that omits the host still refuses");
});
