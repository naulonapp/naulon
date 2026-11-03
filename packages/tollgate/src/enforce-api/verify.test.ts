import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { InAppObservation } from "./index.ts";
import { mountFromHostedDeps as mountEnforceVerify } from "./hostedDeps.testkit.ts";

const publisherOf = (id: string, suspended = false) =>
  ({ id, suspended, originUrl: "http://o", articlePrefixes: ["essays"], licenseIdentity: "did:web:t" }) as never;

/** The legs the default injected `build402` stub derives from any quote — the default
 *  body (below) signs the same (payTo, amount) so the consistency check passes. */
const EXPECTED_LEGS = [{ role: "author", requirements: { payTo: "0xAUTHOR", amount: "1000" } }];

function appWith(opts: {
  resolveHost?: (host: string) => unknown;
  resolveKey?: (token: string) => { tenantId: string; ownerUserId: string; scopes: string[] } | null;
  settleOk?: boolean;
  settleErr?: string;
  stamp?: (tenantId: string, host: string, atMs: number) => void;
  /** Override the 402 builder — omit for the default stub (returns EXPECTED_LEGS); pass
   *  a throwing fn to exercise the malformed-quote path. */
  derive402?: (quote: unknown, resource: string, now: number) => { legs: unknown[] };
  /** Collect the audit-plane emissions (the `paid` / `payment-failed` rows this route owns). */
  observe?: (o: InAppObservation) => void;
  /** Capture what the route hands the settle tail. */
  onSettle?: (args: Record<string, unknown>) => void;
}) {
  const app = new OpenAPIHono();
  mountEnforceVerify(app, {
    resolver: { resolve: async (host: string) => (opts.resolveHost ? opts.resolveHost(host) : publisherOf("pub_a")) } as never,
    verify: (async () => null) as never,
    apiKeyResolve: (async (token: string) =>
      opts.resolveKey ? opts.resolveKey(token) : { tenantId: "pub_a", ownerUserId: "u1", scopes: ["tenant.read"] }) as never,
    settle: (async (args: Record<string, unknown>) =>
      (opts.onSettle?.(args), opts.settleOk === false)
        ? { ok: false, error: opts.settleErr ?? "bad sig" }
        : { ok: true, settlementRef: "mock-ref", payer: `0x${"a".repeat(40)}`, responseHeader: "rh", licenseJws: "jws", eventId: "0b7c4f0e-2a8f-4c55-9a4e-1f0d6c2b9e11" }) as never,
    build402: (opts.derive402 ?? (() => ({ legs: EXPECTED_LEGS }))) as never,
    stampInApp: opts.stamp,
    ...(opts.observe ? { observe: opts.observe } : {}),
  });
  return app;
}

/** Collect the observations the settle path emits. */
function observeCollector() {
  const seen: InAppObservation[] = [];
  return { seen, observe: (o: InAppObservation) => void seen.push(o) };
}

/** Collect stampInApp calls for the in-app liveness assertions. */
function stampCollector() {
  const calls: Array<{ tenantId: string; host: string }> = [];
  return { calls, stamp: (tenantId: string, host: string) => void calls.push({ tenantId, host }) };
}

const body = (over?: Record<string, unknown>) =>
  JSON.stringify({
    payment: "eyJ4Ijp0cnVlfQ==",
    legs: [{ role: "author", requirements: { payTo: "0xauthor", amount: "1000" } }],
    quote: { slug: "essays/x" },
    resource: "http://h.test/essays/x",
    ...over,
  });

const keyHeaders = { authorization: "Bearer nln_live_test", "content-type": "application/json" };

test("missing key → 401", async () => {
  const res = await appWith({}).request("/_naulon/verify", { method: "POST", body: "{}" });
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { verdict?: string }).verdict, undefined, "a key refusal carries no verdict; runtimes read the 4xx as refused");
});

test("valid key + resource owned by tenant → 200 ok:true with settlementRef + license", async () => {
  const res = await appWith({ resolveHost: () => publisherOf("pub_a") }).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body(),
  });
  assert.equal(res.status, 200);
  const j = (await res.json()) as { ok: boolean; settlementRef: string; licenseJws: string };
  assert.equal(j.ok, true);
  assert.equal((j as { verdict?: string }).verdict, "paid");
  assert.equal(j.settlementRef, "mock-ref");
  assert.equal(j.licenseJws, "jws");
});

test("cross-tenant: resource resolves to a DIFFERENT tenant → 403", async () => {
  const res = await appWith({ resolveHost: () => publisherOf("pub_b") }).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body(),
  });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { verdict?: string }).verdict, undefined, "a host refusal is no verdict");
});

test("unknown host (no publisher) → 403", async () => {
  const res = await appWith({ resolveHost: () => undefined }).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body(),
  });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { verdict?: string }).verdict, undefined);
});

test("suspended publisher → 403", async () => {
  const res = await appWith({ resolveHost: () => publisherOf("pub_a", true) }).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body(),
  });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { verdict?: string }).verdict, "refused");
});

test("settle failure (bad signature) → 402 with error", async () => {
  const res = await appWith({ settleOk: false, settleErr: "invalid signature" }).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body(),
  });
  assert.equal(res.status, 402);
  const j = (await res.json()) as { ok: boolean; error: string };
  assert.equal(j.ok, false);
  assert.equal((j as { verdict?: string }).verdict, "refused");
  assert.equal(j.error, "invalid signature");
});

test("malformed body → 400", async () => {
  const res = await appWith({}).request("/_naulon/verify", { method: "POST", headers: keyHeaders, body: JSON.stringify({ payment: "x" }) });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { verdict?: string }).verdict, "refused");
});

// ── in-app liveness stamp ────────────────────────────────────

test("stamp fires on a paid 200 with the owned host + tenant", async () => {
  const { calls, stamp } = stampCollector();
  await appWith({ stamp }).request("/_naulon/verify", { method: "POST", headers: keyHeaders, body: body() });
  assert.deepEqual(calls, [{ tenantId: "pub_a", host: "h.test" }]);
});

test("stamp fires even on a 402 settle failure (SDK is live regardless of pay outcome)", async () => {
  const { calls, stamp } = stampCollector();
  const res = await appWith({ settleOk: false, stamp }).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body(),
  });
  assert.equal(res.status, 402);
  assert.equal(calls.length, 1);
});

test("stamp fires for a suspended publisher (the SDK is still installed and calling)", async () => {
  const { calls, stamp } = stampCollector();
  const res = await appWith({ resolveHost: () => publisherOf("pub_a", true), stamp }).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body(),
  });
  assert.equal(res.status, 403);
  assert.equal(calls.length, 1);
});

test("stamp NEVER fires on an unauthenticated call (401 before ownership)", async () => {
  const { calls, stamp } = stampCollector();
  await appWith({ stamp }).request("/_naulon/verify", { method: "POST", body: "{}" });
  assert.equal(calls.length, 0);
});

test("stamp NEVER fires on a cross-tenant call (403, not owned by this key)", async () => {
  const { calls, stamp } = stampCollector();
  await appWith({ resolveHost: () => publisherOf("pub_b"), stamp }).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body(),
  });
  assert.equal(calls.length, 0);
});

// ── legs↔quote attribution integrity (money follows legs, attribution follows quote) ──

test("legs whose payTo does NOT match the quote's derived legs → 400 (no settle)", async () => {
  const { calls, stamp } = stampCollector();
  const res = await appWith({ stamp }).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body({ legs: [{ role: "author", requirements: { payTo: "0xEVIL", amount: "1000" } }] }),
  });
  assert.equal(res.status, 400);
  const j = (await res.json()) as { ok: boolean; error: string };
  assert.equal(j.ok, false);
  assert.equal(j.error, "legs do not match quote");
  assert.equal(calls.length, 1); // stamp still fires (SDK is live); the toll just doesn't settle
});

test("legs whose amount does NOT match the quote → 400", async () => {
  const res = await appWith({}).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body({ legs: [{ role: "author", requirements: { payTo: "0xauthor", amount: "9999" } }] }),
  });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, "legs do not match quote");
});

test("an EXTRA signed leg the quote never produced → 400", async () => {
  const res = await appWith({}).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body({
      legs: [
        { role: "author", requirements: { payTo: "0xauthor", amount: "1000" } },
        { role: "coauthor", requirements: { payTo: "0xstranger", amount: "500" } },
      ],
    }),
  });
  assert.equal(res.status, 400);
});

test("payTo case difference alone is NOT a mismatch (checksum-insensitive)", async () => {
  const res = await appWith({}).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body({ legs: [{ role: "author", requirements: { payTo: "0xAuThOr", amount: "1000" } }] }),
  });
  assert.equal(res.status, 200);
});

test("a malformed quote (build402 throws) → 400 bad quote, never settles", async () => {
  const res = await appWith({
    derive402: () => {
      throw new Error("bad quote shape");
    },
  }).request("/_naulon/verify", { method: "POST", headers: keyHeaders, body: body() });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, "bad quote");
});

// ── Audit plane ───────────────────────────────────────────────────────────────
// The gate's proxy path is the only OTHER observation writer, and an in-app publisher
// never touches it. So these are the rows that decide whether the portal's Audit page
// shows a real "Paid" count or the 0 it showed against 17 settled prod citations.

test("a settled toll emits a `paid` observation attributed to the resolved tenant", async () => {
  const { seen, observe } = observeCollector();
  const res = await appWith({ observe }).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body({ quote: { slug: "essays/x", kind: "citation", price: 0.003 } }),
  });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.verdict, "paid");
  assert.equal(seen[0]?.publisherId, "pub_a");
  assert.equal(seen[0]?.host, "h.test");
  // The page the agent asked for, from the resource it paid for: the audit trace shows it, and the
  // slug alone is not a path on a site whose articles sit under a prefix.
  assert.equal(seen[0]?.path, "/essays/x");
  assert.equal(seen[0]?.slug, "essays/x");
  assert.equal(seen[0]?.kind, "citation");
  assert.equal(seen[0]?.priceUsdc, 0.003);
  assert.equal(seen[0]?.classifiedAs, "agent");
  // The row names the ledger row it settled as, so a trace can open the payment it describes.
  assert.match(seen[0]?.licenseJti ?? "", /^[0-9a-f-]{36}$/);
});

test("a failed settle emits `payment-failed`, not `paid` — money offered that did not land", async () => {
  const { seen, observe } = observeCollector();
  const res = await appWith({ observe, settleOk: false }).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body({ quote: { slug: "essays/x", price: 0.001 } }),
  });
  assert.equal(res.status, 402);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.verdict, "payment-failed");
  assert.equal(seen[0]?.priceUsdc, 0.001);
});

test("the optional agent block is carried through, so a paid row buckets by agent", async () => {
  const { seen, observe } = observeCollector();
  await appWith({ observe }).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body({ agent: { ua: "GPTBot/1.0", classifyReason: "ua-pattern:bot", verified: true, verifiedAgent: "chatgpt.com" } }),
  });
  assert.equal(seen[0]?.agent?.ua, "GPTBot/1.0");
  assert.equal(seen[0]?.agent?.verifiedAgent, "chatgpt.com");
  assert.equal(seen[0]?.agent?.verified, true);
});

test("no agent block → still a correct paid row (every integration shipping today sends none)", async () => {
  const { seen, observe } = observeCollector();
  await appWith({ observe }).request("/_naulon/verify", { method: "POST", headers: keyHeaders, body: body() });
  assert.equal(seen[0]?.verdict, "paid");
  assert.equal(seen[0]?.agent, undefined);
});

test("a refusal BEFORE the settle emits nothing — no verdict was reached", async () => {
  const { seen, observe } = observeCollector();
  // Cross-tenant: resolves to another publisher, so it 403s before any money path.
  await appWith({ observe, resolveHost: () => publisherOf("pub_b") }).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body(),
  });
  // Suspended: 403 for a different reason, also pre-settle.
  await appWith({ observe, resolveHost: () => publisherOf("pub_a", true) }).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body(),
  });
  assert.equal(seen.length, 0);
});

// ── Fee integrity (Slice B) ──────────────────────────────────────────────────
// `legsMatchQuote` proves the signed legs match the quote the CALLER presented — internal
// consistency, not authority. An in-app publisher who strips `extraLegs` before building
// their 402 therefore presented a self-consistent quote and settled paying the operator nothing.
// These pin the second, independent check: the legs must also carry the operator leg WE
// would have attached, recomputed through the very hook the gate quotes with.

/** A publisher whose resolver attached an operator fee — the shape `DbTenantResolver`
 *  produces when `OPERATOR_WALLET` is set and the tenant does not ride free. */
const publisherWithFee = (amount: string | null, payTo = "0xOPERATOR") =>
  ({
    id: "pub_a",
    suspended: false,
    originUrl: "http://o",
    articlePrefixes: ["essays"],
    licenseIdentity: "did:web:t",
    // The price of record. Required on a real `PublisherConfig`, so only a cast fixture can
    // omit it — and `/verify` now checks the caller's stated price against it.
    price: 0.001,
    citationMultiplier: 5,
    extraLegs: () => (amount === null ? [] : [{ role: "operator", payTo, amount }]),
  }) as never;

const AUTHOR_LEG = { role: "author", requirements: { payTo: "0xauthor", amount: "1000" } };
const feeLeg = (amount: string, payTo = "0xoperator") => ({ role: "operator", requirements: { payTo, amount } });
const QUOTE = { slug: "essays/x", kind: "read", price: 0.001 };

/** Drive /verify with the signed legs AND the derived legs held identical, so
 *  `legsMatchQuote` always passes and only the fee check can refuse. */
const verifyWithLegs = async (publisher: unknown, legs: unknown[]) =>
  appWith({ resolveHost: () => publisher, derive402: () => ({ legs }) }).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body({ legs, quote: QUOTE }),
  });

test("a stripped operator leg is refused even though the quote is self-consistent", async () => {
  const res = await verifyWithLegs(publisherWithFee("100"), [AUTHOR_LEG]);
  assert.equal(res.status, 400);
  assert.equal((await res.json() as { error: string }).error, "operator fee leg missing");
});

test("the operator leg present at the right amount settles", async () => {
  const res = await verifyWithLegs(publisherWithFee("100"), [AUTHOR_LEG, feeLeg("100")]);
  assert.equal(res.status, 200);
  assert.equal((await res.json() as { ok: boolean }).ok, true);
});

test("an operator leg SHORT of the expected amount is refused (a shaved fee is a stripped fee)", async () => {
  const res = await verifyWithLegs(publisherWithFee("100"), [AUTHOR_LEG, feeLeg("50")]);
  assert.equal(res.status, 400);
  assert.equal((await res.json() as { error: string }).error, "operator fee leg missing");
});

test("the payTo comparison is case-insensitive — a checksummed address is not a mismatch", async () => {
  const res = await verifyWithLegs(publisherWithFee("100", "0xOPERATOR"), [AUTHOR_LEG, feeLeg("100", "0xoperator")]);
  assert.equal(res.status, 200);
});

test("fee OFF (no extraLegs hook) settles exactly as before — the wire is unchanged", async () => {
  const res = await verifyWithLegs(publisherOf("pub_a"), [AUTHOR_LEG]);
  assert.equal(res.status, 200);
});

test("a tenant that rides free (hook returns no legs) is not asked for a fee", async () => {
  const res = await verifyWithLegs(publisherWithFee(null), [AUTHOR_LEG]);
  assert.equal(res.status, 200);
});

test("a fee is owed but the price is unreadable → bad quote (fail closed on the money leg)", async () => {
  const noPrice = await appWith({
    resolveHost: () => publisherWithFee("100"),
    derive402: () => ({ legs: [AUTHOR_LEG] }),
  }).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body({ legs: [AUTHOR_LEG], quote: { slug: "essays/x", kind: "read" } }),
  });
  assert.equal(noPrice.status, 400);
  assert.equal((await noPrice.json() as { error: string }).error, "bad quote");
});

test("a negative price cannot buy its way past the fee check by making the fee resolve to nothing", async () => {
  const res = await appWith({
    resolveHost: () => publisherWithFee("100"),
    derive402: () => ({ legs: [AUTHOR_LEG] }),
  }).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body({ legs: [AUTHOR_LEG], quote: { slug: "essays/x", kind: "read", price: -0.001 } }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json() as { error: string }).error, "bad quote");
});

test("the price guard is scoped to the fee path — fee OFF with no price settles as before", async () => {
  const res = await appWith({
    resolveHost: () => publisherOf("pub_a"),
    derive402: () => ({ legs: [AUTHOR_LEG] }),
  }).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body({ legs: [AUTHOR_LEG], quote: { slug: "essays/x", kind: "read" } }),
  });
  assert.equal(res.status, 200);
});

// ── Price authority (Slice D) ────────────────────────────────────────────────
// The fee is a fraction of the price, so checking the fee against a price the CALLER
// supplied only proves they can divide. These pin the price itself to the tenant record.

/** Drive /verify with a caller-chosen quote, legs held self-consistent so only the
 *  price/fee checks can refuse. */
const verifyWithQuote = async (publisher: unknown, quote: unknown, legs: unknown[]) =>
  appWith({ resolveHost: () => publisher, derive402: () => ({ legs }) }).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body({ legs, quote }),
  });

test("a price BELOW the tenant record is refused — the fee cannot be shrunk by understating it", async () => {
  // A tenth of the real price, with a fee that is a correct 10% OF THAT. Both the
  // legs-match-quote check and the fee-containment check pass; only price authority catches it.
  const res = await verifyWithQuote(
    publisherWithFee("10"),
    { slug: "essays/x", kind: "read", price: 0.0001 },
    [AUTHOR_LEG, feeLeg("10")],
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json() as { error: string }).error, "quote price does not match tenant record");
});

test("a price ABOVE the tenant record is refused too — the record is the price, not a floor", async () => {
  const res = await verifyWithQuote(
    publisherWithFee("1000"),
    { slug: "essays/x", kind: "read", price: 0.01 },
    [AUTHOR_LEG, feeLeg("1000")],
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json() as { error: string }).error, "quote price does not match tenant record");
});

test("a citation is priced at price * citationMultiplier, not at the read price", async () => {
  // The record says 0.001 * 5. Quoting the READ price for a CITATION is an understatement
  // of exactly the multiplier, and is refused.
  const short = await verifyWithQuote(
    publisherWithFee("100"),
    { slug: "essays/x", kind: "citation", price: 0.001 },
    [AUTHOR_LEG, feeLeg("100")],
  );
  assert.equal(short.status, 400);

  const right = await verifyWithQuote(
    publisherWithFee("500"),
    { slug: "essays/x", kind: "citation", price: 0.005 },
    [AUTHOR_LEG, feeLeg("500")],
  );
  assert.equal(right.status, 200);
});

test("the comparison is in atomic micro-USDC — a difference finer than a micro is not a mismatch", async () => {
  // 0.0010004 and 0.001 are different doubles and the same money: USDC has six decimals, so
  // no payment can distinguish them. Comparing the doubles directly would refuse this settle
  // and blame the caller for arithmetic the wire cannot represent.
  const sub = 0.0010004;
  assert.notEqual(sub, 0.001);
  const res = await verifyWithQuote(
    publisherWithFee("100"),
    { slug: "essays/x", kind: "read", price: sub },
    [AUTHOR_LEG, feeLeg("100")],
  );
  assert.equal(res.status, 200);
});

test("price authority is scoped to the fee path — a fee-free tenant is not price-checked", async () => {
  // Deliberate: the check exists to protect the fee. A tenant that owes none settles on the
  // caller's own quote exactly as it did before, so switching the fee on is the only thing
  // that ever changes this path's behaviour.
  const res = await verifyWithQuote(
    publisherOf("pub_a"),
    { slug: "essays/x", kind: "read", price: 99 },
    [AUTHOR_LEG],
  );
  assert.equal(res.status, 200);
});

// ---------------------------------------------------------------------------
// `chargedMicro` — what the in-app path turns into `crawler-charged`.
// Only this side knows which legs a stock x402 payer forwent, so only this side can
// report what money actually moved. The middleware is forbidden from guessing.
// ---------------------------------------------------------------------------

test("a settled receipt reports what was charged, in micro-USDC", async () => {
  const res = await appWith({}).request("/_naulon/verify", { method: "POST", headers: keyHeaders, body: body() });
  assert.equal(res.status, 200);
  const j = (await res.json()) as { chargedMicro?: string };
  assert.equal(j.chargedMicro, "1000", "the single author leg the quote implies");
});

test("legs a stock payer forwent are subtracted — the receipt is not the ask", async () => {
  const app = new OpenAPIHono();
  mountEnforceVerify(app, {
    resolver: { resolve: async () => publisherOf("pub_a") } as never,
    verify: (async () => null) as never,
    apiKeyResolve: (async () => ({ tenantId: "pub_a", ownerUserId: "u1", scopes: ["tenant.read"] })) as never,
    settle: (async () => ({
      ok: true,
      settlementRef: "mock-ref",
      forgoneLegs: [{ role: "operator", payTo: "0xOP", amount: "200" }],
    })) as never,
    build402: (() => ({
      legs: [
        { role: "author", requirements: { payTo: "0xAUTHOR", amount: "1000" } },
        { role: "operator", requirements: { payTo: "0xOP", amount: "200" } },
      ],
    })) as never,
  });
  const res = await app.request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body({
      legs: [
        { role: "author", requirements: { payTo: "0xauthor", amount: "1000" } },
        { role: "operator", requirements: { payTo: "0xop", amount: "200" } },
      ],
    }),
  });
  assert.equal(res.status, 200);
  const j = (await res.json()) as { chargedMicro?: string };
  assert.equal(j.chargedMicro, "1000", "1200 asked, 200 forgone — billing them 1200 would be a lie");
});

test("a failed settle reports no charge at all", async () => {
  const res = await appWith({ settleOk: false }).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body(),
  });
  assert.equal(res.status, 402);
  assert.equal((await res.json() as Record<string, unknown>)["chargedMicro"], undefined);
});

test("the settle names the URL bought, spelled as the gate spells it, and claims no content hash", async () => {
  let seen: Record<string, unknown> | undefined;
  const res = await appWith({ onSettle: (a) => (seen = a) }).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body(),
  });
  assert.equal(res.status, 200);
  assert.equal(seen?.resource, "https://h.test/essays/x");
  assert.equal("contentSha256" in (seen ?? {}), false, "the publisher served these bytes, so no hash is stated");
});

test("an agent-bound price verifies against that agent's rule, and only when the quote names the agent", async () => {
  const ruled = () =>
    ({
      ...(publisherWithFee("10") as object),
      priceRules: [{ pattern: "/essays/*", priceUsdc: 0.2, agent: "chatgpt.com" }],
    }) as never;
  const named = await verifyWithQuote(ruled(), { slug: "essays/x", kind: "read", price: 0.2, pricedFor: "chatgpt.com" }, [
    AUTHOR_LEG,
    feeLeg("10"),
  ]);
  assert.equal(named.status, 200);
  const unnamed = await verifyWithQuote(ruled(), { slug: "essays/x", kind: "read", price: 0.2 }, [AUTHOR_LEG, feeLeg("10")]);
  assert.equal(unnamed.status, 400, "an agent's price with no agent is not the price of record");
});

// ---------------------------------------------------------------------------
// `requireFullPayment`: an operator's switch for a tenant whose relay drops the fee.
// ---------------------------------------------------------------------------

const twoLegs = [
  { role: "author", requirements: { payTo: "0xauthor", amount: "1000" } },
  { role: "operator", requirements: { payTo: "0xop", amount: "200" } },
];
const asPayment = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

function fullPaymentApp(requires: (tenantId: string) => Promise<boolean>, quoted = 2) {
  const settles: unknown[] = [];
  const app = new OpenAPIHono();
  mountEnforceVerify(app, {
    resolver: { resolve: async () => publisherOf("pub_a") } as never,
    verify: (async () => null) as never,
    apiKeyResolve: (async () => ({ tenantId: "pub_a", ownerUserId: "u1", scopes: ["tenant.read"] })) as never,
    settle: (async (a: unknown) => { settles.push(a); return { ok: true, settlementRef: "mock-ref" }; }) as never,
    build402: (() => ({
      legs: [
        { role: "author", requirements: { payTo: "0xAUTHOR", amount: "1000" } },
        { role: "operator", requirements: { payTo: "0xOP", amount: "200" } },
      ].slice(0, quoted),
    })) as never,
    requiresFullPayment: requires,
  });
  return { app, settles };
}

test("with the switch on, a single-leg payment against two legs is refused before any settle", async () => {
  const seen: string[] = [];
  const { app, settles } = fullPaymentApp(async (t) => { seen.push(t); return true; });
  const res = await app.request("/_naulon/verify", { method: "POST", headers: keyHeaders, body: body({ legs: twoLegs, payment: asPayment({ x: true }) }) });
  assert.equal(res.status, 402);
  assert.match(((await res.json()) as { error: string }).error, /requires every leg/);
  assert.equal(settles.length, 0, "nothing reached the facilitator, so nothing moved");
  assert.deepEqual(seen, ["pub_a"], "the switch is read for the key's own tenant");
});

test("with the switch on, a payment that signs every leg settles", async () => {
  const { app, settles } = fullPaymentApp(async () => true);
  const res = await app.request("/_naulon/verify", { method: "POST", headers: keyHeaders, body: body({ legs: twoLegs, payment: asPayment([{ a: 1 }, { b: 2 }]) }) });
  assert.equal(res.status, 200);
  assert.equal(settles.length, 1);
});

test("with the switch off, or its lookup failing, the stock payer is honoured", async () => {
  for (const requires of [async () => false, async () => { throw new Error("db down"); }]) {
    const { app, settles } = fullPaymentApp(requires);
    const res = await app.request("/_naulon/verify", { method: "POST", headers: keyHeaders, body: body({ legs: twoLegs, payment: asPayment({ x: true }) }) });
    assert.equal(res.status, 200);
    assert.equal(settles.length, 1);
  }
});

test("a single-leg quote is never refused, whatever the switch says", async () => {
  const { app, settles } = fullPaymentApp(async () => true, 1);
  const res = await app.request("/_naulon/verify", { method: "POST", headers: keyHeaders, body: body() });
  assert.equal(res.status, 200);
  assert.equal(settles.length, 1);
});

test("an observing publisher never settles, even when an older runtime forwards a payment", async () => {
  const observing = { ...(publisherOf("pub_a") as object), tollMode: "observe" } as never;
  const res = await appWith({ resolveHost: () => observing }).request("/_naulon/verify", {
    method: "POST",
    headers: keyHeaders,
    body: body(),
  });
  assert.equal(res.status, 402);
  assert.equal(((await res.json()) as { error?: string }).error, "observing");
});

test("a payment rail that could not be asked answers 503 and is recorded as a free read", async () => {
  const seen: InAppObservation[] = [];
  const app = new OpenAPIHono();
  mountEnforceVerify(app, {
    resolver: { resolve: async () => publisherOf("pub_a") } as never,
    verify: (async () => null) as never,
    apiKeyResolve: (async () => ({ tenantId: "pub_a", ownerUserId: "u1", scopes: ["tenant.read"] })) as never,
    settle: (async () => ({ ok: false, stage: "verify", unavailable: true, error: "fetch failed" })) as never,
    build402: (() => ({ legs: EXPECTED_LEGS })) as never,
    observe: (o: InAppObservation) => void seen.push(o),
  });
  const res = await app.request("/_naulon/verify", { method: "POST", headers: keyHeaders, body: body() });
  assert.equal(res.status, 503);
  const j = (await res.json()) as { error: string; verdict: string };
  assert.equal(j.error, "payment_rail_unavailable");
  assert.equal(j.verdict, "unavailable", "the runtime serves the page");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.verdict, "served-free");
  assert.equal((seen[0] as { freeReason?: string }).freeReason, "unavailable");
  assert.equal((seen[0] as { failureReason?: string }).failureReason, undefined);
});
