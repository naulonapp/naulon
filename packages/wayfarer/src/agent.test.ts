/**
 * `run` budget-override coverage (BUY-1.3). The MCP clamps the model's requested
 * budget to the session envelope and passes it as `RunOptions.budgetUsdc`; this
 * proves the override is honored over the configured ceiling and can only narrow
 * spend. Full discover→pay→ground behavioral coverage for `run` is BUY-1.5; here we
 * keep the gate non-gated (200 everywhere) so the run is fast and pays nothing — the
 * assertion is purely that the override reaches the budget the run reports.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { jwksOf, loadSigningKey, mintLicense, resetConfig, type JwkSet } from "@naulon/shared";

import { run, tollgateBase, verifyAgainst } from "./agent.ts";
import { memoryHeldStore } from "./licenseStore.ts";

/** The discovery catalog these run() tests point CATALOG_URL at. Discovery no
 *  longer has a bundled-demo fallback, so every run() test must supply a real
 *  source — exercising the same catalogSource path prod runs. The essays mirror
 *  examples/meridian/credits.json; `the-naulon` is the on-topic one for
 *  "payment and passage". */
const TEST_CATALOG = "http://catalog.test/list";
const TEST_ESSAYS = [
  { slug: "on-stillness", title: "On Stillness", summary: "On attention, silence, and the discipline of staying with one thing." },
  { slug: "the-naulon", title: "The Naulon", summary: "The fare paid to cross — payment, passage, and what we owe for what we take." },
  { slug: "the-river-and-the-name", title: "The River and the Name", summary: "Identity, change, and whether a thing survives the renaming of itself." },
];

/** Serve TEST_ESSAYS (bare Candidate[] legacy shape) for a catalog probe, else null. */
function catalogResponse(url: string): Response | null {
  return url.startsWith(TEST_CATALOG) ? new Response(JSON.stringify(TEST_ESSAYS), { status: 200 }) : null;
}

/** Run `fn` with env overrides applied (undefined = unset), bracketing a config
 *  reset so wayfarer's lazily-cached config reloads, and restoring after. */
async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  for (const [key, val] of Object.entries(overrides)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  resetConfig();
  try {
    return await fn();
  } finally {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    resetConfig();
  }
}

/** A gate that never gates: every probe returns 200, so nothing is priced or paid.
 *  The catalog probe still gets real JSON so discovery succeeds. */
async function withNonGatedFetch(fn: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) =>
    catalogResponse(String(url)) ?? new Response("free", { status: 200 })) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test("tollgateBase THROWS when TOLLGATE_URL is unset — no invented localhost target", async () => {
  await withEnv({ TOLLGATE_URL: undefined }, async () => {
    assert.throws(
      () => tollgateBase(),
      /TOLLGATE_URL is not configured/i,
      "no configured gate is a config error at the seam, not a fabricated http://localhost:8402",
    );
  });
});

test("tollgateBase returns the configured URL when set", async () => {
  await withEnv({ TOLLGATE_URL: "https://gate.test" }, async () => {
    assert.equal(tollgateBase(), "https://gate.test");
  });
});

test("run honors an explicit budget override instead of the configured ceiling", async () => {
  // Configured ceiling is 0.5; the run is asked to spend at most 0.01.
  await withEnv(
    {
      WAYFARER_BUDGET_USDC: "0.5",
      RSS_URL: undefined,
      PUBLISHER_URL: undefined,
      CATALOG_URL: TEST_CATALOG,
      OPENAI_API_KEY: undefined,
      TOLLGATE_URL: "http://gate.invalid",
    },
    async () => {
      await withNonGatedFetch(async () => {
        const overridden = await run("payment and passage", () => {}, { budgetUsdc: 0.01 });
        assert.equal(overridden.budget, 0.01, "the explicit override is the run's budget, not the 0.5 ceiling");

        const defaulted = await run("payment and passage", () => {});
        assert.equal(defaulted.budget, 0.5, "with no override the run falls back to the configured ceiling");
      });
    },
  );
});

// ── BUY-1.5 (testable half) — `run` end-to-end behavioral coverage ─────────────
// The carried BUY-0 gap: `run` (the pipeline the MCP leans on) had only a smoke
// `typeof` test. This drives the whole loop offline against a stub gate — discover
// (demo) → price → appraise → decide → pay → ground — and asserts it actually pays
// for and cites a relevant source, bounded by budget. The on-chain `live` bar is the
// remaining half of BUY-1.5.

import { tmpdir } from "node:os";
import { join } from "node:path";

/** A stub tollgate over global fetch: every essay is gated at a cheap price; a probe
 *  (no payment-signature) 402s, a paid request 200s with content; JWKS is absent
 *  (license stays unverified — fine, the pay path is what's under test). */
function withStubGate(amountAtomic: string, fn: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
    const u = String(url);
    const cat = catalogResponse(u);
    if (cat) return cat;
    if (u.includes("/.well-known/")) return new Response(null, { status: 404 });
    if (init?.headers?.["payment-signature"]) {
      return new Response("the toll is the fare paid to cross", { status: 200, headers: { "x-naulon-license": "lic.jws" } });
    }
    const header = Buffer.from(
      JSON.stringify({
        accepts: [{ network: "arc-testnet", asset: "0xUSDC", payTo: "0x00000000000000000000000000000000000000Ad", amount: amountAtomic, maxTimeoutSeconds: 120, extra: { nonce: "n" } }],
      }),
    ).toString("base64");
    return new Response(JSON.stringify({ error: "payment required" }), { status: 402, headers: { "payment-required": header } });
  }) as typeof globalThis.fetch;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = real;
  });
}

test("run discovers, prices, decides, pays for and cites a relevant source under budget", async () => {
  await withEnv(
    {
      WAYFARER_BUDGET_USDC: "0.1",
      RSS_URL: undefined,
      PUBLISHER_URL: undefined,
      CATALOG_URL: TEST_CATALOG,
      OPENAI_API_KEY: undefined,
      TOLLGATE_URL: "http://gate.test",
      WAYFARER_LICENSE_PATH: join(tmpdir(), `naulon-run-${process.pid}.json`),
    },
    async () => {
      await withStubGate("1000", async () => {
        const result = await run("payment and passage", () => {});

        assert.equal(result.topic, "payment and passage");
        assert.ok(result.decisions.length >= 3, "every discovered demo essay gets a logged decision");
        assert.ok((result.spent as number) > 0, "it actually paid for at least one source");
        assert.ok(result.sources.length >= 1, "and cites what it paid for");

        const naulon = result.sources.find((s) => s.slug === "the-naulon");
        assert.ok(naulon, "the on-topic essay (the-naulon) is among the paid sources");
        assert.equal(naulon.paidUsdc, 0.001, "the paid amount is the quoted author price");
        assert.match(naulon.content, /fare/, "the paid content came back");

        // Budget invariant: never spend more than the ceiling.
        assert.ok((result.spent as number) <= 0.1, "total spend stays within budget");
        assert.match(result.answer, /the-naulon/, "the grounded answer cites the paid source");
      });
    },
  );
});

// A2 — discovery (and the gates it points at) is untrusted: a candidate essay's
// tollgate can 402 with a malformed/negative amount. Before the fix, run()'s price
// loop pushed `usdc(quoted.priceUsdc)` unvalidated (buyer.ts probe()), and usdc()
// (shared/src/types.ts) THROWS on a non-finite/negative value — aborting the whole
// price loop and silently discarding every other, perfectly-good candidate's price.
// One bad gate must never take down pricing for the rest of the batch.
//
// A2 follow-up — the same batch-DoS class survives a shape the original regex
// (`^\d+$` alone) let through: an all-digit amount long enough that `Number(amount)`
// overflows to `Infinity` (e.g. "9".repeat(310)). `overflow-toll` below pins that
// case alongside the original non-numeric one.
test("run does not throw when a gate 402s one candidate with a malformed toll amount (A2) — prices only the valid one", async () => {
  const CATALOG = "http://catalog.test/list-a2";
  await withEnv(
    {
      WAYFARER_BUDGET_USDC: "0.1",
      RSS_URL: undefined,
      PUBLISHER_URL: undefined,
      CATALOG_URL: CATALOG,
      OPENAI_API_KEY: undefined,
      TOLLGATE_URL: "http://gate.test",
      WAYFARER_LICENSE_PATH: join(tmpdir(), `naulon-a2-${process.pid}.json`),
    },
    async () => {
      const real = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
        const u = String(url);
        if (u.startsWith(CATALOG)) {
          return new Response(
            JSON.stringify([
              { slug: "bad-toll", title: "Bad Toll", summary: "a gate with a malformed 402 amount, about payment and passage" },
              { slug: "overflow-toll", title: "Overflow Toll", summary: "a gate with an overflowing 402 amount, about payment and passage" },
              { slug: "good-toll", title: "Good Toll", summary: "a gate with a valid 402 amount, about payment and passage" },
            ]),
            { status: 200 },
          );
        }
        if (u.includes("/.well-known/")) return new Response(null, { status: 404 });
        if (init?.headers?.["payment-signature"]) {
          return new Response("the toll is the fare paid to cross", { status: 200, headers: { "x-naulon-license": "lic.jws" } });
        }
        // The attacker-controlled candidates' gates 402 with a non-numeric amount and an
        // overflow-to-Infinity amount, respectively; the well-behaved one 402s normally.
        const amount = u.includes("bad-toll") ? "abc" : u.includes("overflow-toll") ? "9".repeat(310) : "1000";
        const header = Buffer.from(
          JSON.stringify({
            accepts: [{ network: "arc-testnet", asset: "0xUSDC", payTo: "0x00000000000000000000000000000000000000Ad", amount, maxTimeoutSeconds: 120, extra: { nonce: "n" } }],
          }),
        ).toString("base64");
        return new Response(JSON.stringify({ error: "payment required" }), { status: 402, headers: { "payment-required": header } });
      }) as typeof globalThis.fetch;
      try {
        const result = await run("payment and passage", () => {});
        const decisionSlugs = result.decisions.map((d) => d.slug);
        assert.ok(decisionSlugs.includes("good-toll"), "the well-behaved candidate is still priced, appraised and decided");
        assert.ok(!decisionSlugs.includes("bad-toll"), "the malformed-toll candidate is dropped at price — never reaches decide()");
        assert.ok(!decisionSlugs.includes("overflow-toll"), "the overflow-to-Infinity candidate is dropped at price — never reaches decide()");
      } finally {
        globalThis.fetch = real;
      }
    },
  );
});

test("URL-centric: run uses a candidate's canonical url verbatim, never a reconstructed /essays/ path", async () => {
  const CATALOG = "http://catalog.test/list";
  await withEnv(
    {
      WAYFARER_BUDGET_USDC: "0.1",
      RSS_URL: undefined,
      PUBLISHER_URL: undefined,
      CATALOG_URL: CATALOG,
      OPENAI_API_KEY: undefined,
      TOLLGATE_URL: "http://gate.test",
      WAYFARER_LICENSE_PATH: join(tmpdir(), `naulon-urlcentric-${process.pid}.json`),
    },
    async () => {
      const probed: string[] = [];
      const real = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
        const u = String(url);
        // Discovery: one candidate whose canonical url sits at /articles/, not /essays/.
        if (u.startsWith(CATALOG)) {
          return new Response(
            JSON.stringify([
              { slug: "deep", title: "Deep", summary: "a deep essay on passage and payment", url: "http://gate.test/articles/deep" },
            ]),
            { status: 200 },
          );
        }
        if (u.includes("/.well-known/")) return new Response(null, { status: 404 });
        if (u.includes("gate.test")) probed.push(u); // every gate hit (quote probe + pay)
        if (init?.headers?.["payment-signature"]) {
          return new Response("the fare is paid", { status: 200, headers: { "x-naulon-license": "lic.jws" } });
        }
        const header = Buffer.from(
          JSON.stringify({
            accepts: [{ network: "arc-testnet", asset: "0xUSDC", payTo: "0x00000000000000000000000000000000000000Ad", amount: "1000", maxTimeoutSeconds: 120, extra: { nonce: "n" } }],
          }),
        ).toString("base64");
        return new Response(JSON.stringify({ error: "payment required" }), { status: 402, headers: { "payment-required": header } });
      }) as typeof globalThis.fetch;
      try {
        await run("passage and payment", () => {});
        assert.ok(
          probed.some((u) => u === "http://gate.test/articles/deep"),
          `expected the canonical /articles/deep url used verbatim; got ${JSON.stringify(probed)}`,
        );
        assert.ok(!probed.some((u) => u.includes("/essays/deep")), "must NOT reconstruct an /essays/ path when a canonical url is present");
      } finally {
        globalThis.fetch = real;
      }
    },
  );
});

test("BUY-4.3 P2: an injected session signer pays through run() — no BUYER_PRIVATE_KEY needed", async () => {
  // The hosted path: the cloud injects the buyer's custody-free session signer, and the
  // MCP threads it into run() (mirroring naulon_pay_and_read). Proof it works even with
  // NO env key present (the exact gap: hosted research threw "gateway requires
  // BUYER_PRIVATE_KEY"), and that the payment is actually signed by the INJECTED signer.
  const signerAddress = "0x000000000000000000000000000000000000C0DE" as const;
  const signed: { count: number } = { count: 0 };
  const signer = {
    address: signerAddress,
    async signTypedData(): Promise<`0x${string}`> {
      signed.count += 1;
      return `0x${"11".repeat(65)}` as `0x${string}`;
    },
  };
  await withEnv(
    {
      WAYFARER_BUDGET_USDC: "0.1",
      BUYER_PRIVATE_KEY: undefined, // the whole point: the process holds no key
      RSS_URL: undefined,
      PUBLISHER_URL: undefined,
      CATALOG_URL: TEST_CATALOG,
      OPENAI_API_KEY: undefined,
      TOLLGATE_URL: "http://gate.test",
      WAYFARER_LICENSE_PATH: join(tmpdir(), `naulon-signer-${process.pid}.json`),
    },
    async () => {
      await withStubGate("1000", async () => {
        const log: string[] = [];
        const result = await run("payment and passage", (line) => log.push(line), { signer });

        assert.ok((result.spent as number) > 0, "the injected signer paid for at least one source");
        assert.ok(result.sources.length >= 1, "and cites what the session wallet paid for");
        assert.ok(signed.count >= 1, "the payment was signed by the INJECTED signer, not the env key");
        assert.ok(
          log.some((l) => l.includes(signerAddress)),
          "the run reports the injected session wallet, not the env buyer",
        );
      });
    },
  );
});

test("RAS-B: injected railSigners rail-pick PER-402 in run() — a memo-network 402 under a gateway-default fleet pays via the MEMO signer", async () => {
  // The naulon_research half of the mixed-fleet fix: run() with BOTH rail signers must route
  // like railBuyer (per-402 network registry), not by supportsMemo(activeNetwork()). Fleet default
  // here is baseSepolia (gateway) while the 402 advertises Arc — with the REAL gate shape, i.e.
  // the GatewayWalletBatched extra stamped on it (build402 stamps it on every gateway-mode 402).
  const mkSigner = () => {
    const calls: { count: number } = { count: 0 };
    return {
      calls,
      signer: {
        address: "0x000000000000000000000000000000000000C0DE" as `0x${string}`,
        async signTypedData(): Promise<`0x${string}`> {
          calls.count += 1;
          return `0x${"11".repeat(65)}` as `0x${string}`;
        },
      },
    };
  };
  const memo = mkSigner();
  const gateway = mkSigner();
  await withEnv(
    {
      WAYFARER_BUDGET_USDC: "0.1",
      SETTLEMENT_NETWORK: "baseSepolia", // fleet default = gateway rail, on purpose
      PAYMENT_MODE: "gateway",
      LICENSES_ENABLED: "false", // real-payment mode would demand a stable signing key
      BUYER_PRIVATE_KEY: undefined,
      RSS_URL: undefined,
      PUBLISHER_URL: undefined,
      CATALOG_URL: TEST_CATALOG,
      OPENAI_API_KEY: undefined,
      TOLLGATE_URL: "http://gate.test",
      WAYFARER_LICENSE_PATH: join(tmpdir(), `naulon-rail-${process.pid}.json`),
    },
    async () => {
      const real = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
        const u = String(url);
        const cat = catalogResponse(u);
        if (cat) return cat;
        if (u.includes("/.well-known/")) return new Response(null, { status: 404 });
        if (init?.headers?.["payment-signature"]) {
          return new Response("the fare is paid", { status: 200 });
        }
        const header = Buffer.from(
          JSON.stringify({
            accepts: [
              {
                scheme: "exact",
                network: "eip155:5042002", // Arc testnet — a memo chain, NOT the fleet default
                asset: "0x3600000000000000000000000000000000000000",
                payTo: "0x00000000000000000000000000000000000000Ad",
                amount: "1000",
                maxTimeoutSeconds: 691200,
                extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" },
              },
            ],
          }),
        ).toString("base64");
        return new Response(JSON.stringify({ error: "payment required" }), { status: 402, headers: { "payment-required": header } });
      }) as typeof globalThis.fetch;
      try {
        const result = await run("payment and passage", () => {}, {
          railSigners: { memo: memo.signer, gateway: gateway.signer },
        });
        assert.ok((result.spent as number) > 0, "the run paid for at least one source");
        assert.ok(memo.calls.count >= 1, "the MEMO signer must sign an Arc 402 — per-402 rail pick, not the fleet default");
        assert.equal(gateway.calls.count, 0, "the gateway signer must NOT be consulted despite the fleet-default gateway rail");
      } finally {
        globalThis.fetch = real;
      }
    },
  );
});

test("BUY-3.1: a kill-switch policy threads through run() — the real pipeline pays nothing", async () => {
  await withEnv(
    {
      WAYFARER_BUDGET_USDC: "0.1",
      RSS_URL: undefined,
      PUBLISHER_URL: undefined,
      CATALOG_URL: TEST_CATALOG,
      OPENAI_API_KEY: undefined,
      TOLLGATE_URL: "http://gate.test",
      WAYFARER_LICENSE_PATH: join(tmpdir(), `naulon-kill-${process.pid}.json`),
    },
    async () => {
      await withStubGate("1000", async () => {
        const result = await run("payment and passage", () => {}, {
          policy: { relevanceFloor: 0.35, maxPaid: 5, killSwitch: true },
        });
        // Same discovery/appraisal, but the policy halts every would-be pay.
        assert.ok(result.decisions.length >= 3, "decisions are still logged");
        assert.equal(result.spent as number, 0, "kill-switch ⇒ zero spend through the real run pipeline");
        assert.equal(result.sources.length, 0, "nothing paid ⇒ nothing cited");
        assert.ok(
          result.decisions.every((d) => d.action !== "pay"),
          "no decision is a pay under the kill-switch",
        );
        assert.ok(
          result.decisions.some((d) => /kill-switch/i.test(d.reason)),
          "the halt reason is visible in the decision log",
        );
      });
    },
  );
});

test("RAS-A2b: on a gateway (memo-less) network run() routes the injected signer through gatewayBuyer", async () => {
  // The research path (run) had the SAME memo-only hardcode as pay_and_read: opts.signer ?
  // memoBuyer(opts.signer). On Base + every Gateway chain that 400s the facilitator verify.
  // run() must mirror selectBuyer() and route the injected signer to gatewayBuyer, which posts
  // the Circle envelope — proven by the paid payment-signature carrying the injected authorization.
  const injected = privateKeyToAccount(generatePrivateKey());
  const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
  let paidHeader: string | undefined;
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
    const u = String(url);
    const cat = catalogResponse(u);
    if (cat) return cat;
    if (u.includes("/.well-known/")) return new Response(null, { status: 404 });
    if (init?.headers?.["payment-signature"]) {
      paidHeader = init.headers["payment-signature"];
      return new Response("the fare is paid", { status: 200, headers: { "x-naulon-license": "lic.jws" } });
    }
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        resource: { url: u, description: "naulon read toll", mimeType: "text/html" },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:84532",
            asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            payTo: "0x00000000000000000000000000000000000000Ad",
            amount: "1000",
            maxTimeoutSeconds: 691200,
            extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: GATEWAY_WALLET },
          },
        ],
      }),
    ).toString("base64");
    return new Response(JSON.stringify({ error: "payment required" }), { status: 402, headers: { "payment-required": header } });
  }) as typeof globalThis.fetch;
  try {
    await withEnv(
      {
        SETTLEMENT_NETWORK: "baseSepolia",
        PAYMENT_MODE: "gateway",
        LICENSES_ENABLED: "false",
        WAYFARER_BUDGET_USDC: "0.1",
        BUYER_PRIVATE_KEY: undefined,
        RSS_URL: undefined,
        PUBLISHER_URL: undefined,
        CATALOG_URL: TEST_CATALOG,
        OPENAI_API_KEY: undefined,
        TOLLGATE_URL: "http://gate.test",
        WAYFARER_LICENSE_PATH: join(tmpdir(), `naulon-gw-signer-${process.pid}.json`),
      },
      async () => {
        const result = await run("payment and passage", () => {}, { signer: injected });
        assert.ok((result.spent as number) > 0, "the injected signer paid on the gateway rail");
        assert.ok(paidHeader, "the buyer retried with a payment-signature");
        const envelope = JSON.parse(Buffer.from(paidHeader!, "base64").toString("utf8")) as {
          payload?: { authorization?: { from?: string } };
          resource?: unknown;
          accepted?: unknown;
        };
        assert.equal(
          envelope.payload?.authorization?.from?.toLowerCase(),
          injected.address.toLowerCase(),
          "the Gateway envelope's authorization.from is the injected signer — gatewayBuyer ran, not memoBuyer",
        );
        assert.ok(envelope.resource && envelope.accepted, "the envelope carries resource + accepted (facilitator verify requires them)");
      },
    );
  } finally {
    globalThis.fetch = real;
  }
});

// ── H-OSS-1 — the SSRF gate on run()'s price loop ───────────────────────────────
// discover() is explicitly untrusted (decide.ts: "a poisoned discover teaser is
// enough") — a compromised catalog/feed candidate can carry ANY url. Before this
// fix, run()'s price loop called buyer.price(c.url) for EVERY discovered candidate,
// unconditionally, before decide() ever ran an origin/policy check — an attacker
// url reached the network (cloud metadata endpoints, internal services) regardless
// of the operator's gate/allowlist/denylist. These assert the fetch-count-0
// invariant directly: a stub `globalThis.fetch` records every URL actually hit, and
// the off-gate/deny-listed candidate must never appear in it, while an on-gate
// candidate in the SAME run still gets priced normally.

test("H-OSS-1: run() refuses to price/fetch an off-gate candidate url (no policy stated) — never reaches the network", async () => {
  const CATALOG = "http://catalog.test/ssrf-plain";
  await withEnv(
    {
      WAYFARER_BUDGET_USDC: "0.1",
      RSS_URL: undefined,
      PUBLISHER_URL: undefined,
      CATALOG_URL: CATALOG,
      OPENAI_API_KEY: undefined,
      TOLLGATE_URL: "http://gate.test",
      WAYFARER_LICENSE_PATH: join(tmpdir(), `naulon-ssrf-plain-${process.pid}.json`),
    },
    async () => {
      const fetched: string[] = [];
      const real = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
        const u = String(url);
        if (u.startsWith(CATALOG)) {
          return new Response(
            JSON.stringify([
              // Poisoned teaser: an off-gate url a compromised catalog handed back.
              { slug: "trap", title: "Trap", summary: "payment and passage", url: "http://evil.example/steal" },
              // A genuine on-gate candidate (slug-only, resolves to the configured gate).
              { slug: "on-stillness", title: "On Stillness", summary: "payment and passage, on staying" },
            ]),
            { status: 200 },
          );
        }
        fetched.push(u);
        if (u.includes("/.well-known/")) return new Response(null, { status: 404 });
        if (init?.headers?.["payment-signature"]) {
          return new Response("the fare is paid", { status: 200, headers: { "x-naulon-license": "lic.jws" } });
        }
        const header = Buffer.from(
          JSON.stringify({
            accepts: [{ network: "arc-testnet", asset: "0xUSDC", payTo: "0x00000000000000000000000000000000000000Ad", amount: "1000", maxTimeoutSeconds: 120, extra: { nonce: "n" } }],
          }),
        ).toString("base64");
        return new Response(JSON.stringify({ error: "payment required" }), { status: 402, headers: { "payment-required": header } });
      }) as typeof globalThis.fetch;
      try {
        const result = await run("payment and passage", () => {});
        assert.ok(
          !fetched.some((u) => u.startsWith("http://evil.example")),
          `off-gate candidate must NEVER be fetched/priced (SSRF) — got ${JSON.stringify(fetched)}`,
        );
        assert.ok(
          fetched.some((u) => u.includes("gate.test")),
          "the on-gate candidate in the SAME run must still be priced normally",
        );
        assert.ok(
          result.decisions.some((d) => d.slug === "on-stillness"),
          "the on-gate candidate reaches decide() and gets a real decision",
        );
        assert.ok(
          !result.decisions.some((d) => d.slug === "trap"),
          "the refused candidate is dropped at the price gate — it never reaches decide()",
        );
      } finally {
        globalThis.fetch = real;
      }
    },
  );
});

test("H-OSS-1: run() refuses a deny-listed host even when an operator allowlist REPLACES the gate pin (WP-2 fleet-allowlist shape)", async () => {
  // authorizeOrigin defers identity entirely once policy.allowDomains is stated — so this
  // proves the SECOND gate (the host-only spendGate call) actually runs and enforces the
  // allowlist itself; without it, a fleet-default allowlist (WP-2) would leave pricing wide
  // open again despite the identity pin appearing to be "handled".
  const CATALOG = "http://catalog.test/ssrf-allowlist";
  await withEnv(
    {
      WAYFARER_BUDGET_USDC: "0.1",
      RSS_URL: undefined,
      PUBLISHER_URL: undefined,
      CATALOG_URL: CATALOG,
      OPENAI_API_KEY: undefined,
      TOLLGATE_URL: "http://gate.test",
      WAYFARER_LICENSE_PATH: join(tmpdir(), `naulon-ssrf-allow-${process.pid}.json`),
    },
    async () => {
      const fetched: string[] = [];
      const real = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
        const u = String(url);
        if (u.startsWith(CATALOG)) {
          return new Response(
            JSON.stringify([
              { slug: "trap", title: "Trap", summary: "payment and passage", url: "http://evil.example/steal" },
              { slug: "on-stillness", title: "On Stillness", summary: "payment and passage, on staying" },
            ]),
            { status: 200 },
          );
        }
        fetched.push(u);
        if (u.includes("/.well-known/")) return new Response(null, { status: 404 });
        if (init?.headers?.["payment-signature"]) {
          return new Response("the fare is paid", { status: 200, headers: { "x-naulon-license": "lic.jws" } });
        }
        const header = Buffer.from(
          JSON.stringify({
            accepts: [{ network: "arc-testnet", asset: "0xUSDC", payTo: "0x00000000000000000000000000000000000000Ad", amount: "1000", maxTimeoutSeconds: 120, extra: { nonce: "n" } }],
          }),
        ).toString("base64");
        return new Response(JSON.stringify({ error: "payment required" }), { status: 402, headers: { "payment-required": header } });
      }) as typeof globalThis.fetch;
      try {
        const result = await run("payment and passage", () => {}, {
          policy: { relevanceFloor: 0, maxPaid: 5, allowDomains: ["gate.test"] },
        });
        assert.ok(
          !fetched.some((u) => u.startsWith("http://evil.example")),
          `deny-listed (not-allowlisted) candidate must NEVER be fetched/priced — got ${JSON.stringify(fetched)}`,
        );
        assert.ok(
          fetched.some((u) => u.includes("gate.test")),
          "the allowlisted on-gate candidate in the SAME run must still be priced normally",
        );
        assert.ok(
          result.decisions.some((d) => d.slug === "on-stillness"),
          "the allowlisted candidate reaches decide() and gets a real decision",
        );
        assert.ok(
          !result.decisions.some((d) => d.slug === "trap"),
          "the refused candidate is dropped at the price gate — it never reaches decide()",
        );
      } finally {
        globalThis.fetch = real;
      }
    },
  );
});

// ── A1 — a held-license re-read that throws must not crash the whole run ───────
// rereadWithLicense used to let a bare agentFetch reject propagate unhandled, and
// run()'s cache branch had no try/catch around the call — so ONE held essay whose
// re-read hit a network error (DNS flake, connection reset) crashed the entire
// run(), discarding every license already paid for earlier in the SAME loop (the
// final `heldStore.save(held)` never ran). The fix: rereadWithLicense returns a
// typed failure instead of throwing, AND a just-paid license is saved incrementally
// (not only once after the loop) as a second line of defense.

/** A real, decodable Citation License JWS for `slug` (mirrors licenseStore.test.ts's
 *  `token()`) — decodeHeld() parses claims (jti/exp/aud/naulon.slug) without
 *  verifying the signature, but it DOES require a well-formed JWT; an opaque
 *  placeholder string like "lic.jws" decodes to garbage and is silently dropped,
 *  which would make the A1 assertion below vacuous (it'd pass even if the
 *  incremental-save fix were never applied). */
function paidLicense(slug: string): string {
  const now = Date.now();
  return mintLicense(
    {
      event: {
        id: `id-${slug}`,
        slug,
        kind: "citation",
        amount: 0.001 as never,
        payees: [{ authorId: "a", wallet: "0x1111111111111111111111111111111111111111" as never, share: 1 }],
        payerAddress: "0x2222222222222222222222222222222222222222" as never,
        settlementRef: "ref",
        at: now,
      },
      issuer: "naulon:test",
      audience: "naulon:test",
      ttlSeconds: 600,
      payeesMode: "full",
      title: `Title ${slug}`,
      network: { chainId: 5042002, usdc: "0x36", gateway: "g" },
    },
    loadSigningKey(),
    now,
  );
}

test("A1: a held license whose re-read throws (network reject) is logged-and-skipped — run() resolves, cites what it DID pay for, and the paid license persists", async () => {
  const CATALOG = "http://catalog.test/a1";
  const GATE = "http://gate.test";
  const PAID_SLUG = "paid-essay";
  const HELD_SLUG = "held-essay";
  await withEnv(
    {
      WAYFARER_BUDGET_USDC: "0.1",
      RSS_URL: undefined,
      PUBLISHER_URL: undefined,
      CATALOG_URL: CATALOG,
      OPENAI_API_KEY: undefined,
      TOLLGATE_URL: GATE,
      WAYFARER_LICENSE_PATH: join(tmpdir(), `naulon-a1-${process.pid}.json`),
    },
    async () => {
      const real = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
        const u = String(url);
        if (u.startsWith(CATALOG)) {
          return new Response(
            JSON.stringify([
              { slug: PAID_SLUG, title: "Paid Essay", summary: "payment and passage — worth paying for" },
              { slug: HELD_SLUG, title: "Held Essay", summary: "payment and passage — already held" },
            ]),
            { status: 200 },
          );
        }
        if (u.includes("/.well-known/")) return new Response(null, { status: 404 });
        // The vulnerable re-read: this candidate's cache-branch GET carries the held
        // license header. Simulate a network-level failure (DNS/connection reset) —
        // exactly what rereadWithLicense must catch and turn into a typed failure.
        if (init?.headers?.["x-naulon-license"]) {
          throw new TypeError("fetch failed: connection reset");
        }
        if (init?.headers?.["payment-signature"]) {
          return new Response("the paid content", {
            status: 200,
            headers: { "x-naulon-license": paidLicense(PAID_SLUG) },
          });
        }
        const header = Buffer.from(
          JSON.stringify({
            accepts: [{ network: "arc-testnet", asset: "0xUSDC", payTo: "0x00000000000000000000000000000000000000Ad", amount: "1000", maxTimeoutSeconds: 120, extra: { nonce: "n" } }],
          }),
        ).toString("base64");
        return new Response(JSON.stringify({ error: "payment required" }), { status: 402, headers: { "payment-required": header } });
      }) as typeof globalThis.fetch;

      try {
        const exp = Math.floor(Date.now() / 1000) + 3600; // live
        const store = memoryHeldStore([
          [
            HELD_SLUG,
            {
              slug: HELD_SLUG,
              title: "Held Essay",
              jti: "jti-held",
              exp,
              aud: "gate://test",
              pop: false,
              jws: "held.jws.sig",
              url: `${GATE}/essays/${HELD_SLUG}`,
            },
          ],
        ]);

        // Before the fix this `await` REJECTS (the throw from the stub propagates
        // uncaught through rereadWithLicense → run()'s cache branch → run() itself).
        const result = await run("payment and passage", () => {}, { heldStore: store });

        assert.ok(
          result.sources.some((s) => s.slug === PAID_SLUG),
          "run() still cites the essay it successfully paid for, despite the held essay's re-read throwing",
        );
        assert.ok(
          !result.sources.some((s) => s.slug === HELD_SLUG),
          "the essay whose re-read threw is NOT cited — logged-and-skipped, not fatal",
        );

        const held = await store.load();
        assert.ok(
          held.get(PAID_SLUG),
          "A's just-paid license was persisted to the injected store despite B's later re-read throwing",
        );
      } finally {
        globalThis.fetch = real;
      }
    },
  );
});

// ── A4 — verifyAgainst must check the GATE's canonical iss/aud, not the token's
// own claims. It used to decode the JWS and pass its OWN iss/aud back in as the
// "expected" value, so `claims.iss !== expected` was always false by construction —
// ANY validly-signed token verified regardless of who it was actually minted for.
// The fix takes the expected {issuer, audience} as an explicit caller-supplied arg.

function mintForIdentity(issuer: string, audience: string): { jws: string; jwks: JwkSet } {
  const key = loadSigningKey();
  const now = Date.now();
  const jws = mintLicense(
    {
      event: {
        id: "id-a4",
        slug: "a4-essay",
        kind: "citation",
        amount: 0.001 as never,
        payees: [{ authorId: "a", wallet: "0x1111111111111111111111111111111111111111" as never, share: 1 }],
        payerAddress: "0x2222222222222222222222222222222222222222" as never,
        settlementRef: "ref",
        at: now,
      },
      issuer,
      audience,
      ttlSeconds: 600,
      payeesMode: "full",
      title: "A4 essay",
      network: { chainId: 5042002, usdc: "0x36", gateway: "g" },
    },
    key,
    now,
  );
  return { jws, jwks: jwksOf([key]) };
}

test("A4: verifyAgainst rejects a token minted for the WRONG audience, checked against the gate's canonical identity", () => {
  const CANONICAL = "naulon:gate.test";
  const { jws, jwks } = mintForIdentity(CANONICAL, "naulon:attacker.test");
  // Before the fix, verifyAgainst decoded the JWS's own iss/aud and compared it
  // to itself (always true). Now the caller supplies the expected identity, and
  // a wrong-aud token must fail even though its own signature is perfectly valid.
  assert.equal(
    verifyAgainst(jws, jwks, { issuer: CANONICAL, audience: CANONICAL }),
    false,
    "a token whose aud does not match the gate's canonical identity must not verify",
  );
});

test("A4: verifyAgainst accepts a token minted for the canonical gate identity", () => {
  const CANONICAL = "naulon:gate.test";
  const { jws, jwks } = mintForIdentity(CANONICAL, CANONICAL);
  assert.equal(verifyAgainst(jws, jwks, { issuer: CANONICAL, audience: CANONICAL }), true);
});
