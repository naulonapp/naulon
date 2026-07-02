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

import { resetConfig } from "@naulon/shared";

import { run } from "./agent.ts";

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

/** A gate that never gates: every probe returns 200, so nothing is priced or paid. */
async function withNonGatedFetch(fn: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("free", { status: 200 })) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test("run honors an explicit budget override instead of the configured ceiling", async () => {
  // Configured ceiling is 0.5; the run is asked to spend at most 0.01.
  await withEnv(
    {
      WAYFARER_BUDGET_USDC: "0.5",
      RSS_URL: undefined,
      PUBLISHER_URL: undefined,
      CATALOG_URL: undefined,
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
      CATALOG_URL: undefined,
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
      CATALOG_URL: undefined,
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

test("BUY-3.1: a kill-switch policy threads through run() — the real pipeline pays nothing", async () => {
  await withEnv(
    {
      WAYFARER_BUDGET_USDC: "0.1",
      RSS_URL: undefined,
      PUBLISHER_URL: undefined,
      CATALOG_URL: undefined,
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
