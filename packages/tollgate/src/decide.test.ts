import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./decide.ts";
import { PAYMENT_SIGNATURE_HEADER } from "./x402.ts";

const basePublisher = {
  id: "pub_test",
  originUrl: "http://origin.local",
  articlePrefixes: ["essays"],
  crawlerPolicy: undefined,
  seoAllowlist: [],
  licenseIdentity: "did:web:test",
  gateScope: undefined,
  suspended: false,
} as any;

// A build402-complete quote (extraLegs/coauthorSplit present — build402 iterates them).
const quoteOf = async () =>
  ({
    slug: "essays/x",
    kind: "read",
    title: "X",
    price: 5000,
    payees: [{ address: `0x${"a".repeat(40)}`, shareBps: 10000 }],
    extraLegs: [],
    coauthorSplit: false,
  }) as any;

test("human UA → free", async () => {
  const req = new Request("http://h/essays/x", {
    headers: { "user-agent": "Mozilla/5.0 (real browser)" },
  });
  const d = await decide({ raw: req, host: "h", path: "/essays/x", publisher: basePublisher, now: 1, quote: quoteOf });
  assert.equal(d.kind, "free");
});

test("agent, no payment → payment-required (402 legs+header)", async () => {
  const req = new Request("http://h/essays/x", { headers: { "user-agent": "GPTBot/1.0" } });
  const d = await decide({ raw: req, host: "h", path: "/essays/x", publisher: basePublisher, now: 1, quote: quoteOf });
  assert.equal(d.kind, "payment-required");
  if (d.kind === "payment-required") assert.ok(d.header.length > 0 && d.legs.length >= 1);
});

test("agent + payment-signature → payment-presented (caller settles)", async () => {
  const req = new Request("http://h/essays/x", {
    headers: { "user-agent": "GPTBot/1.0", [PAYMENT_SIGNATURE_HEADER]: "eyJ0ZXN0Ijp0cnVlfQ==" },
  });
  const d = await decide({ raw: req, host: "h", path: "/essays/x", publisher: basePublisher, now: 1, quote: quoteOf });
  assert.equal(d.kind, "payment-presented");
  if (d.kind === "payment-presented") assert.equal(d.payment, "eyJ0ZXN0Ijp0cnVlfQ==");
});

test("non-article path → passthrough", async () => {
  const req = new Request("http://h/about", { headers: { "user-agent": "GPTBot/1.0" } });
  const d = await decide({ raw: req, host: "h", path: "/about", publisher: basePublisher, now: 1, quote: quoteOf });
  assert.equal(d.kind, "passthrough");
});

test("blocked crawler → blocked (403) before classify", async () => {
  const pub = { ...basePublisher, crawlerPolicy: { block: ["BadBot"] } };
  const req = new Request("http://h/essays/x", { headers: { "user-agent": "BadBot/2.0" } });
  const d = await decide({ raw: req, host: "h", path: "/essays/x", publisher: pub, now: 1, quote: quoteOf });
  assert.equal(d.kind, "blocked");
  if (d.kind === "blocked") assert.equal(d.frag, "BadBot");
});

test("no quote (unknown article) → passthrough (don't gate)", async () => {
  const req = new Request("http://h/essays/x", { headers: { "user-agent": "GPTBot/1.0" } });
  const d = await decide({ raw: req, host: "h", path: "/essays/x", publisher: basePublisher, now: 1, quote: async () => null });
  assert.equal(d.kind, "passthrough");
});

test("observed variants carry obs facts for the caller's audit plane", async () => {
  const req = new Request("http://h/essays/x", { headers: { "user-agent": "GPTBot/1.0" } });
  const d = await decide({ raw: req, host: "h", path: "/essays/x", publisher: basePublisher, now: 1, quote: quoteOf });
  assert.equal(d.kind, "payment-required");
  if (d.kind === "payment-required") {
    assert.equal(d.obs.classifiedAs, "agent");
    assert.ok(d.obs.classifyReason.length > 0);
    assert.equal(d.tollKind, "read");
  }
});
