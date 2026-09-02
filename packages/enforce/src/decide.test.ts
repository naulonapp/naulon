import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, LICENSE_HEADER, type LicenseVerification } from "./decide.ts";
import { PAYMENT_SIGNATURE_HEADER } from "./build402.ts";
import { jwksOf, loadSigningKey, mintCitationRecord, mintLicense } from "@naulon/shared";

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

// A malformed percent-escape in the path used to throw URIError out of slugFromPath, before
// any verdict existed — so the gate's catch-all handler answered 500 to a request that is a
// plain passthrough. Node delivers `GET /essays/100%` to the handler verbatim (no rejection,
// no normalization), so this is one raw request away from any tolled site, and it costs the
// publisher a 5xx on a URL of their own origin. Now: no throw, no article, straight through.
test("malformed percent-escape in the path → passthrough, never a throw", async () => {
  for (const path of ["/essays/100%", "/essays/%zz", "/essays/%"]) {
    const req = new Request("http://h/essays/x", { headers: { "user-agent": "GPTBot/1.0" } });
    const d = await decide({ raw: req, host: "h", path, publisher: basePublisher, now: 1, quote: quoteOf });
    assert.equal(d.kind, "passthrough", `${path} must pass through`);
  }
});

test("site mode: a malformed percent-escape stays free too", async () => {
  const pub = { ...basePublisher, gateScope: { mode: "site", excludePrefixes: [] } };
  const req = new Request("http://h/blog/x", { headers: { "user-agent": "GPTBot/1.0" } });
  const d = await decide({ raw: req, host: "h", path: "/blog/100%", publisher: pub, now: 1, quote: quoteOf });
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

// ── API-mode license re-read: verify against the MINTING gate's JWKS ─────────────
// The bug (MCP-HELD-1): an in-app enforcer (API mode) receives a license SIGNED BY THE
// HOSTED GATE, but licenseEntitlesRead verified it against the local module-global
// `licensing` — which is null in a consuming site (no LICENSE_SIGNING_KEY). So every
// licensed re-read fell through to a fresh 402, re-charging a paid reader. The
// `licenseVerification` seam lets the in-app decide() verify a gate-minted license
// against the gate's published JWKS + the issuer it stamped.

const GATE_KEY = loadSigningKey(); // stands in for the hosted gate's LICENSE_SIGNING_KEY
const GATE_JWKS = jwksOf([GATE_KEY]); // what /.well-known/naulon-jwks.json serves
const GATE_ISS = "naulon:publisher.example"; // the gate's licenseIdentity for this publisher

// licenseEntitlesRead verifies with the REAL clock (verifyLicense reads Date.now()), not
// decide's injected `now`, so fixtures must be minted relative to real time — an unexpired
// license needs a real-current `mintedAt` + TTL, an expired one a real-past `mintedAt`.
const REAL_NOW = Date.now();

/** Mint a gate-signed license for slug `x`, kind, minted at `mintedAt` with `ttlSeconds`. */
function gateLicense(
  iss: string,
  kind: "read" | "citation" = "citation",
  mintedAt = REAL_NOW,
  ttlSeconds = 3600,
): string {
  const event = {
    id: "11111111-2222-4333-8444-555555555555",
    slug: "x",
    kind,
    amount: 0.003,
    payees: [{ authorId: "etiric", wallet: `0x${"1".repeat(40)}`, share: 1 }],
    payerAddress: `0x${"3".repeat(40)}`,
    settlementRef: "0xref",
    at: mintedAt,
  } as any;
  return mintLicense(
    { event, issuer: iss, audience: iss, ttlSeconds, payeesMode: "full", title: "X", network: "eip155:5042002" as any } as any,
    GATE_KEY,
    mintedAt,
  );
}

const NOW = REAL_NOW; // decide's build402 clock (license verify uses the real clock regardless)
const agentReread = (jws: string) =>
  new Request("http://h/essays/x", { headers: { "user-agent": "GPTBot/1.0", [LICENSE_HEADER]: jws } });

test("API mode: a gate-minted license WITHOUT the verifier 402s (the bug — local licensing can't verify it)", async () => {
  // No licenseVerification, and the test process has no LICENSE_SIGNING_KEY → licensing is
  // null → the license cannot be verified here → falls through to payment-required.
  const d = await decide({
    raw: agentReread(gateLicense(GATE_ISS)),
    host: "h",
    path: "/essays/x",
    publisher: basePublisher,
    now: NOW,
    quote: quoteOf,
  });
  assert.equal(d.kind, "payment-required", "without the gate JWKS, a valid license is re-charged");
});

test("API mode: WITH the gate JWKS + issuer, the same license re-reads FREE", async () => {
  const verification: LicenseVerification = { jwks: GATE_JWKS, issuer: GATE_ISS };
  const d = await decide({
    raw: agentReread(gateLicense(GATE_ISS)),
    host: "h",
    path: "/essays/x",
    publisher: basePublisher,
    now: NOW,
    quote: quoteOf,
    licenseVerification: verification,
  });
  assert.equal(d.kind, "reread", "the gate-minted license verifies against the injected gate JWKS → free re-read");
});

test("API mode: a license minted for ANOTHER issuer is refused even with our gate JWKS (no cross-publisher reuse)", async () => {
  // Same signing key (one gate signs every tenant), but the license's iss/aud is a DIFFERENT
  // publisher. Our verifier expects GATE_ISS, so the iss mismatch drops it to 402.
  const d = await decide({
    raw: agentReread(gateLicense("naulon:someone-else.com")),
    host: "h",
    path: "/essays/x",
    publisher: basePublisher,
    now: NOW,
    quote: quoteOf,
    licenseVerification: { jwks: GATE_JWKS, issuer: GATE_ISS },
  });
  assert.equal(d.kind, "payment-required", "a license scoped to another publisher must not re-read here");
});

test("API mode: an expired gate license falls through to 402 (fails closed)", async () => {
  // Minted 2h ago with a 600s TTL → expired against the real clock verifyLicense uses.
  const expired = gateLicense(GATE_ISS, "citation", REAL_NOW - 7_200_000, 600);
  const d = await decide({
    raw: agentReread(expired),
    host: "h",
    path: "/essays/x",
    publisher: basePublisher,
    now: NOW,
    quote: quoteOf,
    licenseVerification: { jwks: GATE_JWKS, issuer: GATE_ISS },
  });
  assert.equal(d.kind, "payment-required", "an expired license is not a free re-read");
});

// ── site mode: the extension allowlist ────────────────────────────────────────

const sitePublisher = (includeExtensions?: string[]) =>
  ({
    ...basePublisher,
    gateScope: { mode: "site", excludePrefixes: [], ...(includeExtensions ? { includeExtensions } : {}) },
  }) as any;

const agentReq = (path: string) =>
  new Request(`http://h${path}`, { headers: { "user-agent": "GPTBot/1.0" } });

test("site mode: an allowlisted extension is gated, not passed through", async () => {
  const path = "/papers/q.pdf";
  const d = await decide({
    raw: agentReq(path),
    host: "h",
    path,
    publisher: sitePublisher(["pdf"]),
    now: 1,
    quote: quoteOf,
  });
  assert.equal(d.kind, "payment-required");
});

test("site mode: a NON-allowlisted extension still passes through free", async () => {
  const path = "/app.css";
  const d = await decide({
    raw: agentReq(path),
    host: "h",
    path,
    publisher: sitePublisher(["pdf"]),
    now: 1,
    quote: quoteOf,
  });
  assert.equal(d.kind, "passthrough");
});

test("site mode: without the allowlist a .pdf stays free (regression)", async () => {
  const path = "/papers/q.pdf";
  const d = await decide({
    raw: agentReq(path),
    host: "h",
    path,
    publisher: sitePublisher(),
    now: 1,
    quote: quoteOf,
  });
  assert.equal(d.kind, "passthrough");
});

test("site mode: allowlisting xml never tolls the sitemap", async () => {
  for (const path of ["/sitemap.xml", "/robots.txt", "/.well-known/x402"]) {
    const d = await decide({
      raw: agentReq(path),
      host: "h",
      path,
      publisher: sitePublisher(["xml", "txt"]),
      now: 1,
      quote: quoteOf,
    });
    assert.equal(d.kind, "passthrough", `${path} must stay free`);
  }
});

// ── W6: a citation record grants nothing; a scoped licence covers its scope ──────
// The record is permanent BECAUSE it entitles no read. If one could be presented for a
// free re-read, permanence would be an unrevocable free-read credential — the exact
// thing the CLT's 3600s cap exists to prevent.

/** Mint a permanent citation record for slug `x` — same key, issuer and shape as gateLicense. */
function gateRecord(iss: string, opts: { slug?: string; scope?: { patterns: string[] } } = {}): string {
  const event = {
    id: "11111111-2222-4333-8444-555555555555",
    slug: opts.slug ?? "x",
    kind: "citation",
    amount: 0.003,
    payees: [{ authorId: "etiric", wallet: `0x${"1".repeat(40)}`, share: 1 }],
    payerAddress: `0x${"3".repeat(40)}`,
    settlementRef: "0xref",
    at: REAL_NOW,
  } as any;
  return mintCitationRecord(
    {
      event,
      issuer: iss,
      audience: iss,
      ttlSeconds: 3600,
      payeesMode: "full",
      title: "X",
      network: "eip155:5042002" as any,
      ...(opts.scope ? { scope: opts.scope } : {}),
    } as any,
    GATE_KEY,
    REAL_NOW,
  );
}

/** Mint a SCOPED access licence — valid, unexpired, covering a path pattern. */
function gateScopedLicense(iss: string, patterns: string[], slug = "some-other-article"): string {
  const event = {
    id: "11111111-2222-4333-8444-555555555556",
    slug,
    kind: "citation",
    amount: 0.003,
    payees: [{ authorId: "etiric", wallet: `0x${"1".repeat(40)}`, share: 1 }],
    payerAddress: `0x${"3".repeat(40)}`,
    settlementRef: "0xref",
    at: REAL_NOW,
  } as any;
  return mintLicense(
    {
      event,
      issuer: iss,
      audience: iss,
      ttlSeconds: 3600,
      payeesMode: "full",
      title: "X",
      network: "eip155:5042002" as any,
      scope: { patterns },
    } as any,
    GATE_KEY,
    REAL_NOW,
  );
}

const VERIFY: LicenseVerification = { jwks: GATE_JWKS, issuer: GATE_ISS };

test("W6: a citation record NEVER buys a free re-read, though it verifies", async () => {
  const d = await decide({
    raw: agentReread(gateRecord(GATE_ISS)),
    host: "h",
    path: "/essays/x",
    publisher: basePublisher,
    now: NOW,
    quote: quoteOf,
    licenseVerification: VERIFY,
  });
  assert.equal(d.kind, "payment-required", "a record grants nothing — it must not re-read");
});

test("W6: the record's own signature and issuer are fine — only the grant refuses it", async () => {
  // Same key, same issuer, same slug as the licence that DOES re-read above.
  const { verifyLicense } = await import("@naulon/shared");
  const r = verifyLicense(gateRecord(GATE_ISS), {
    now: Date.now(),
    expectedIssuer: GATE_ISS,
    expectedAudience: GATE_ISS,
    jwks: GATE_JWKS,
  });
  assert.equal(r.ok, true, "the record itself is a valid token");
});

test("W6: a scoped licence re-reads an article it was not minted for", async () => {
  const d = await decide({
    raw: agentReread(gateScopedLicense(GATE_ISS, ["/essays/*"])),
    host: "h",
    path: "/essays/x",
    publisher: basePublisher,
    now: NOW,
    quote: quoteOf,
    licenseVerification: VERIFY,
  });
  assert.equal(d.kind, "reread", "the scope covers /essays/*, so the mint-time slug is irrelevant");
});

test("W6: a scoped licence is refused outside its scope", async () => {
  const d = await decide({
    raw: new Request("http://h/essays/x", {
      headers: { "user-agent": "GPTBot/1.0", [LICENSE_HEADER]: gateScopedLicense(GATE_ISS, ["/journal/*"]) },
    }),
    host: "h",
    path: "/essays/x",
    publisher: basePublisher,
    now: NOW,
    quote: quoteOf,
    licenseVerification: VERIFY,
  });
  assert.equal(d.kind, "payment-required", "/essays/x is not under /journal/*");
});

test("W6: an unscoped licence still matches on slug alone, exactly as before", async () => {
  const d = await decide({
    raw: agentReread(gateLicense(GATE_ISS)),
    host: "h",
    path: "/essays/x",
    publisher: basePublisher,
    now: NOW,
    quote: quoteOf,
    licenseVerification: VERIFY,
  });
  assert.equal(d.kind, "reread");
});
