/**
 * BUY-1.1 / BUY-1.2 — the MCP server, driven through an in-memory transport pair
 * from a real MCP `Client`. Proves the package resolves, the SDK is wired, the
 * `@naulon/wayfarer` brain is reachable, and each §3.1 tool is both LISTABLE (tool
 * discovery) and CALLABLE.
 *
 * `appraise` runs offline (no network). `discover` reads a tiny in-test catalog
 * HTTP server (`withCatalog`) — discovery has no bundled-demo fallback, so it
 * always exercises the real catalogSource path. The gate-facing tools (quote,
 * pay_and_read, read_held, research) run against a tiny in-test stub gate
 * (quote/research) or via their no-license early-return (read_held); the full
 * PAID happy-path against a real running tollgate is BUY-1.5's `live` bar.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { resetConfig } from "@naulon/shared";
import { DEFAULT_POLICY, memoryHeldStore, type HeldLicense, type MemoSigner } from "@naulon/wayfarer";

import { buildServer, type BuildServerOptions, type DecisionAuditEvent } from "./server.ts";

/** Stand up an isolated server + connected client over a linked in-memory pair. */
async function connectedClient(): Promise<Client> {
  return connectedClientWith();
}

/** As `connectedClient`, but with per-session BUY-4.0 options (injected signer /
 *  budget / policy) — the hosted path supplies these per authed buyer session
 *  instead of reading process env. */
async function connectedClientWith(opts?: BuildServerOptions): Promise<Client> {
  const server = buildServer(opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "wayfarer-mcp-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Run `fn` with env overrides applied (undefined = unset), restoring after. Each
 *  flip brackets a `resetConfig()` so the lazily-cached config reloads. */
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

/** The catalog these tests discover from. Discovery has no bundled-demo fallback,
 *  so every research/discover test must supply a real source. Slugs mirror
 *  examples/meridian/credits.json; `the-naulon` is the on-topic essay. */
const CATALOG_ESSAYS = [
  { slug: "on-stillness", title: "On Stillness", summary: "On attention, silence, and the discipline of staying with one thing." },
  { slug: "the-naulon", title: "The Naulon", summary: "The fare paid to cross — payment, passage, and what we owe for what we take." },
  { slug: "the-river-and-the-name", title: "The River and the Name", summary: "Identity, change, and whether a thing survives the renaming of itself." },
];

/** Stand up a throwaway catalog HTTP server, point CATALOG_URL at it, and tear it
 *  down. Replaces the old bundled-demo fallback: the agent discovers over the real
 *  catalogSource path — the same path prod runs — instead of fabricated fixtures. */
async function withCatalog<T>(fn: () => Promise<T>): Promise<T> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(CATALOG_ESSAYS));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await withEnv(
      { RSS_URL: undefined, PUBLISHER_URL: undefined, CATALOG_URL: `http://127.0.0.1:${port}/catalog` },
      fn,
    );
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
}

/** Stand up a throwaway HTTP gate on an ephemeral port, point TOLLGATE_URL at it,
 *  and tear it down (forcing keep-alive sockets closed so the close callback fires). */
async function withStubGate(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: () => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await withEnv({ TOLLGATE_URL: `http://127.0.0.1:${port}` }, fn);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
}

/** Stand up a throwaway gate that records the paths it was asked for and returns its
 *  own base URL — so a test can assert WHICH of several gates a session reached.
 *  Caller tears it down (forcing keep-alive sockets closed). */
async function standGate(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/** A gate that 402s a probe (no payment-signature) and serves content once a
 *  payment-signature is presented — enough for the mock buyer to complete a pay. */
function payGate(amountAtomic: string) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.headers["payment-signature"]) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("paid content");
    } else {
      res.writeHead(402, { "payment-required": paymentRequired(amountAtomic), "content-type": "application/json" });
      res.end(JSON.stringify({ error: "payment required" }));
    }
  };
}

/** A base64 x402 PAYMENT-REQUIRED header advertising a single author leg. */
function paymentRequired(amountAtomic: string): string {
  const body = {
    accepts: [
      {
        network: "arc-testnet",
        asset: "USDC",
        payTo: "0x000000000000000000000000000000000000dEaD",
        amount: amountAtomic,
        maxTimeoutSeconds: 120,
        extra: { nonce: "nonce-1" },
      },
    ],
  };
  return Buffer.from(JSON.stringify(body)).toString("base64");
}

const TOOL_NAMES = [
  "naulon_discover",
  "naulon_appraise",
  "naulon_quote",
  "naulon_pay_and_read",
  "naulon_read_held",
  "naulon_research",
];

// ── BUY-1.1 (carried) ────────────────────────────────────────────────────────

test("the server lists naulon_discover with a non-empty description", async () => {
  const client = await connectedClient();
  const { tools } = await client.listTools();
  const discover = tools.find((t) => t.name === "naulon_discover");
  assert.ok(discover, "naulon_discover is registered");
  assert.ok((discover.description ?? "").length > 0, "naulon_discover has a description");
});

test("exposes cross-client slash-command prompts that steer the tools", async () => {
  const client = await connectedClient();
  const { prompts } = await client.listPrompts();
  const names = new Set(prompts.map((p) => p.name));
  for (const name of ["research", "discover", "verify"]) {
    assert.ok(names.has(name), `prompt "${name}" is registered`);
  }
  // The topic argument is substituted into the returned steering message.
  const got = await client.getPrompt({ name: "research", arguments: { topic: "passage rites" } });
  const text = got.messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("\n");
  assert.ok(text.includes("passage rites"), "the prompt weaves the topic argument into its message");
  assert.ok(text.includes("naulon_discover"), "the prompt steers the model through the free-first loop");
});

test("naulon_discover returns free catalog teasers (no payment)", async () => {
  await withCatalog(async () => {
    const client = await connectedClient();
    const res = await client.callTool({
      name: "naulon_discover",
      arguments: { topic: "payment and passage" },
    });

    const structured = res.structuredContent as
      | { candidates: Array<{ slug: string; title: string; summary: string }> }
      | undefined;
    assert.ok(structured, "tool returns structuredContent matching the outputSchema");
    assert.ok(structured.candidates.length > 0, "returns at least one teaser");
    assert.ok(
      structured.candidates.some((c) => c.slug === "the-naulon"),
      "includes the on-topic catalog slug",
    );
    for (const c of structured.candidates) {
      assert.equal(typeof c.title, "string");
      assert.equal(typeof c.summary, "string");
    }
  });
});

// ── BUY-1.2 — the full §3.1 tool surface ──────────────────────────────────────

test("registers the full §3.1 tool surface with schemas and honest read-only hints", async () => {
  const client = await connectedClient();
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  for (const name of TOOL_NAMES) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} is registered`);
    assert.ok((tool.description ?? "").length > 0, `${name} has a description`);
    assert.ok(tool.outputSchema, `${name} advertises an output schema`);
  }

  // The free, side-effect-free tools are flagged read-only; the two that can SPEND
  // money must not be (the host must see they mutate state / move funds).
  for (const name of ["naulon_discover", "naulon_appraise", "naulon_quote", "naulon_read_held"]) {
    assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, `${name} is read-only`);
  }
  for (const name of ["naulon_pay_and_read", "naulon_research"]) {
    assert.notEqual(
      byName.get(name)?.annotations?.readOnlyHint,
      true,
      `${name} is NOT flagged read-only (it can spend)`,
    );
  }
});

test("naulon_appraise scores an on-topic teaser above an off-topic one (offline heuristic)", async () => {
  await withEnv({ OPENAI_API_KEY: undefined }, async () => {
    const client = await connectedClient();
    const res = await client.callTool({
      name: "naulon_appraise",
      arguments: {
        topic: "payment citation toll",
        candidates: [
          { slug: "match", title: "Payment and passage", summary: "tolls and citation payment for agents" },
          { slug: "off", title: "Gardening tips", summary: "soil, water and healthy plants" },
        ],
      },
    });

    const structured = res.structuredContent as
      | { appraised: Array<{ slug: string; relevance: number; rationale: string }> }
      | undefined;
    assert.ok(structured, "tool returns structuredContent");
    const match = structured.appraised.find((a) => a.slug === "match");
    const off = structured.appraised.find((a) => a.slug === "off");
    assert.ok(match && off, "scores both candidates");
    assert.ok(match.relevance > off.relevance, "on-topic scores higher than off-topic");
    assert.ok(match.relevance > 0, "on-topic has positive relevance");
    assert.equal(typeof match.rationale, "string");
  });
});

test("naulon_quote reads real price + terms from a 402, and reports gated:false for a free read", async () => {
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    if ((req.url ?? "").includes("/essays/priced")) {
      res.writeHead(402, { "payment-required": paymentRequired("5000"), "content-type": "application/json" });
      res.end(JSON.stringify({ error: "payment required" }));
    } else {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("free content");
    }
  };

  await withStubGate(handler, async () => {
    const client = await connectedClient();

    const gatedRes = await client.callTool({ name: "naulon_quote", arguments: { slug: "priced" } });
    const gated = gatedRes.structuredContent as {
      gated: boolean;
      priceUsdc?: number;
      totalUsdc?: number;
      network?: string;
      payTo?: string;
    };
    assert.equal(gated.gated, true, "the gated slug is quoted");
    assert.equal(gated.priceUsdc, 0.005, "author price decoded from the 402 (5000 micro)");
    assert.equal(gated.totalUsdc, 0.005, "no extra legs → total equals the author price");
    assert.equal(gated.network, "arc-testnet");
    assert.equal(typeof gated.payTo, "string");

    const freeRes = await client.callTool({ name: "naulon_quote", arguments: { slug: "free" } });
    const free = freeRes.structuredContent as { gated: boolean };
    assert.equal(free.gated, false, "a non-402 response is reported as a free read");
  });
});

test("naulon_pay_and_read reports not_found (not a free read) when the path 404s", async () => {
  // A gate that 404s every path — the exact shape of a slug-only pay whose /essays/<slug>
  // fallback misses a publisher serving /articles/<slug>. This must NOT read as "free".
  const handler = (_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  };
  await withStubGate(handler, async () => {
    const client = await connectedClient();
    const res = await client.callTool({ name: "naulon_pay_and_read", arguments: { slug: "zeybek" } });
    const r = res.structuredContent as { ok: boolean; error?: string; errorCode?: string; spentSessionUsdc: number };
    assert.equal(r.ok, false, "a 404 path is not payable");
    assert.equal(r.errorCode, "not_found", "a 404 is a wrong path, not the free-read not_gated");
    assert.match(r.error ?? "", /404|canonical url/i, "the error points the agent at passing the real url");
    assert.equal(r.spentSessionUsdc, 0, "nothing was spent");
  });
});

test("naulon_pay_and_read surfaces a hosted session-signer grant refusal as needs_topup + a top-up link", async () => {
  // The hosted path injects a grant-checked session signer that THROWS on a refusal. The pay
  // tool must turn that into a structured non-spend the agent can act on — errorCode:needs_topup
  // plus the top-up URL — never a thrown MCP protocol error that hides the remedy.
  const throwingSigner: MemoSigner = {
    address: "0x000000000000000000000000000000000000bEEF",
    signTypedData: () => {
      throw new Error("grant_exceeded (remaining 0)");
    },
  };
  await withStubGate(payGate("5000"), async () => {
    // Budget clears the toll ($0.005) so the flow reaches the signer (the refusal is the point).
    const client = await connectedClientWith({ signer: throwingSigner, budgetUsdc: 1, buyerWalletUrl: "https://portal.test/buyer/wallet" });
    const res = await client.callTool({ name: "naulon_pay_and_read", arguments: { slug: "zeybek" } });
    assert.notEqual(res.isError, true, "a grant refusal is a typed result, not a thrown MCP error");
    const r = res.structuredContent as { ok: boolean; errorCode?: string; retryable?: boolean; topUpUrl?: string; requiredUsdc?: number; spentSessionUsdc: number };
    assert.equal(r.ok, false, "nothing was paid");
    assert.equal(r.errorCode, "needs_topup", "the agent learns the remedy is funding");
    assert.equal(r.retryable, false, "retrying without funding only re-fails");
    assert.equal(r.topUpUrl, "https://portal.test/buyer/wallet", "the configured wallet URL is surfaced");
    assert.equal(r.requiredUsdc, 0.005, "the toll it could not cover is reported");
    assert.equal(r.spentSessionUsdc, 0, "the budget is untouched");
  });
});

test("naulon_quote does not pass off a 404 path as a plain free read", async () => {
  const handler = (_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  };
  await withStubGate(handler, async () => {
    const client = await connectedClient();
    const res = await client.callTool({ name: "naulon_quote", arguments: { slug: "zeybek" } });
    const q = res.structuredContent as { gated: boolean; note?: string };
    assert.equal(q.gated, false, "still not gated (nothing was paid)");
    assert.match(q.note ?? "", /404|not found|canonical url/i, "the note distinguishes a 404 from a genuine free read");
  });
});

test("naulon_read_held with no held license tells the model to pay first (no network)", async () => {
  await withEnv(
    { WAYFARER_LICENSE_PATH: join(tmpdir(), `naulon-mcp-empty-${process.pid}.json`) },
    async () => {
      const client = await connectedClient();
      const res = await client.callTool({ name: "naulon_read_held", arguments: { slug: "whatever" } });
      const r = res.structuredContent as { ok: boolean; error?: string };
      assert.equal(r.ok, false, "no held license → not ok");
      assert.match(r.error ?? "", /pay/i, "the error points the model at paying");
    },
  );
});

// ── BUY-1.3 — session budget envelope (server-config ceiling, "$Y remaining") ──

type PayResult = {
  ok: boolean;
  costUsdc?: number;
  spentSessionUsdc: number;
  remainingUsdc: number;
  ceilingUsdc: number;
  error?: string;
};

test("naulon_pay_and_read refuses a toll over the remaining budget and spends nothing", async () => {
  await withStubGate(payGate("5000"), async () => {
    // Ceiling 0.001 < the 0.005 toll → must refuse before any spend.
    await withEnv({ WAYFARER_BUDGET_USDC: "0.001" }, async () => {
      const client = await connectedClient();

      const quoteRes = await client.callTool({ name: "naulon_quote", arguments: { slug: "x" } });
      const q = quoteRes.structuredContent as { affordable?: boolean; totalUsdc?: number; remainingUsdc: number };
      assert.equal(q.totalUsdc, 0.005, "quote decodes the 0.005 toll");
      assert.equal(q.affordable, false, "quote flags the toll as unaffordable under the 0.001 budget");
      assert.equal(q.remainingUsdc, 0.001, "quote surfaces the remaining session budget");

      const payRes = await client.callTool({ name: "naulon_pay_and_read", arguments: { slug: "x" } });
      const p = payRes.structuredContent as PayResult;
      assert.equal(p.ok, false, "the over-budget pay is refused");
      assert.match(p.error ?? "", /budget/i, "the error explains it is a budget refusal");
      assert.match(p.error ?? "", /cannot be raised/i, "the error states the ceiling is not tool-raisable");
      assert.equal(p.spentSessionUsdc, 0, "nothing was spent");
      assert.equal(p.remainingUsdc, 0.001, "the full budget still remains");
    });
  });
});

test("naulon_pay_and_read debits the session envelope; a later pay beyond remaining is refused", async () => {
  await withStubGate(payGate("5000"), async () => {
    // Ceiling 0.012 affords two 0.005 tolls (→0.002 left), not a third.
    await withEnv({ WAYFARER_BUDGET_USDC: "0.012" }, async () => {
      const client = await connectedClient();

      const first = (await client.callTool({ name: "naulon_pay_and_read", arguments: { slug: "a" } }))
        .structuredContent as PayResult;
      assert.equal(first.ok, true, "first pay succeeds");
      assert.equal(first.costUsdc, 0.005, "the true toll total is reported");
      assert.equal(first.spentSessionUsdc, 0.005, "the session spend is debited");
      assert.equal(first.remainingUsdc, 0.007, "remaining drops by the toll");

      const second = (await client.callTool({ name: "naulon_pay_and_read", arguments: { slug: "b" } }))
        .structuredContent as PayResult;
      assert.equal(second.ok, true, "second pay succeeds");
      assert.equal(second.spentSessionUsdc, 0.01, "spend accumulates across calls in one session");
      assert.equal(second.remainingUsdc, 0.002, "remaining drops again");

      const third = (await client.callTool({ name: "naulon_pay_and_read", arguments: { slug: "c" } }))
        .structuredContent as PayResult;
      assert.equal(third.ok, false, "the third pay exceeds the remaining 0.002 and is refused");
      assert.equal(third.spentSessionUsdc, 0.01, "the refused pay debits nothing");
    });
  });
});

// ── BUY-1.4 — pay-path failure modes (toll-moved · insufficient-funds) ─────────

test("naulon_pay_and_read aborts when the toll moves up between the budget quote and the pay", async () => {
  // The server probes once to gate the budget, then the buyer probes again to pay —
  // two requests, so the toll can move between them. This gate raises the price on the
  // SECOND probe; the pay-time guard must catch it and spend nothing.
  let probes = 0;
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.headers["payment-signature"]) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("paid content");
      return;
    }
    probes += 1;
    // First probe (server budget gate): 0.005. Second probe (buyer pay): 0.05.
    const amount = probes >= 2 ? "50000" : "5000";
    res.writeHead(402, { "payment-required": paymentRequired(amount), "content-type": "application/json" });
    res.end(JSON.stringify({ error: "payment required" }));
  };

  await withStubGate(handler, async () => {
    await withEnv({ WAYFARER_BUDGET_USDC: "1", WAYFARER_TOLL_TOLERANCE_BPS: "0" }, async () => {
      const client = await connectedClient();
      const p = (await client.callTool({ name: "naulon_pay_and_read", arguments: { slug: "x" } }))
        .structuredContent as PayResult & { errorCode?: string; retryable?: boolean };
      assert.equal(p.ok, false, "the moved toll is not paid");
      assert.equal(p.errorCode, "toll_moved", "the failure is typed as a moved toll");
      assert.equal(p.retryable, true, "re-quoting may succeed");
      assert.equal(p.spentSessionUsdc, 0, "nothing was spent");
      assert.equal(p.remainingUsdc, 1, "the full budget still remains");
    });
  });
});

test("naulon_pay_and_read surfaces an insufficient-funds rejection as a non-retryable hard stop", async () => {
  // The gate accepts the probe but rejects the settled payment for insufficient balance.
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.headers["payment-signature"]) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "settle reverted: transfer amount exceeds balance" }));
      return;
    }
    res.writeHead(402, { "payment-required": paymentRequired("5000"), "content-type": "application/json" });
    res.end(JSON.stringify({ error: "payment required" }));
  };

  await withStubGate(handler, async () => {
    await withEnv({ WAYFARER_BUDGET_USDC: "1" }, async () => {
      const client = await connectedClient();
      const p = (await client.callTool({ name: "naulon_pay_and_read", arguments: { slug: "x" } }))
        .structuredContent as PayResult & { errorCode?: string; retryable?: boolean };
      assert.equal(p.ok, false, "the payment is reported as failed");
      assert.equal(p.errorCode, "insufficient_funds", "classified from the gate's balance reason");
      assert.equal(p.retryable, false, "a hard stop — fund the wallet, don't retry as-is");
      assert.equal(p.spentSessionUsdc, 0, "a failed pay never debits the budget (no partial-pay)");
    });
  });
});

test("naulon_research clamps a requested budget down to the remaining session budget (never up)", async () => {
  const handler = (_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("free");
  };
  await withStubGate(handler, async () => {
    await withCatalog(async () => {
      await withEnv(
        {
          WAYFARER_BUDGET_USDC: "0.05",
          WAYFARER_LICENSE_PATH: join(tmpdir(), `naulon-mcp-clamp-${process.pid}.json`),
          OPENAI_API_KEY: undefined,
        },
        async () => {
          const client = await connectedClient();

          const over = (await client.callTool({ name: "naulon_research", arguments: { topic: "passage", budgetUsdc: 999 } }))
            .structuredContent as { budget: number; requestedBudgetUsdc?: number; remainingUsdc: number };
          assert.equal(over.budget, 0.05, "a 999 request is clamped to the 0.05 session ceiling");
          assert.equal(over.requestedBudgetUsdc, 999, "the un-clamped request is echoed back for transparency");

          const under = (await client.callTool({ name: "naulon_research", arguments: { topic: "passage", budgetUsdc: 0.01 } }))
            .structuredContent as { budget: number; requestedBudgetUsdc?: number };
          assert.equal(under.budget, 0.01, "a request below the ceiling is honored as-is (model may spend less)");
          assert.equal(under.requestedBudgetUsdc, undefined, "an un-clamped request is not flagged");
        },
      );
    });
  });
});

test("naulon_research composes the pipeline and returns a structured result (offline; nothing gated)", async () => {
  const handler = (_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("free");
  };

  await withStubGate(handler, async () => {
    await withCatalog(async () => {
      await withEnv(
        {
          WAYFARER_LICENSE_PATH: join(tmpdir(), `naulon-mcp-research-${process.pid}.json`),
          OPENAI_API_KEY: undefined,
        },
        async () => {
          const client = await connectedClient();
          const res = await client.callTool({
            name: "naulon_research",
            arguments: { topic: "payment and passage" },
          });

          const r = res.structuredContent as {
            topic: string;
            sources: unknown[];
            decisions: unknown[];
            answer: string;
            log: string[];
          };
          assert.equal(r.topic, "payment and passage");
          assert.equal(r.sources.length, 0, "nothing was gated, so nothing was paid for");
          assert.equal(typeof r.answer, "string");
          assert.ok(Array.isArray(r.log) && r.log.length > 0, "captures the auditable decision log");
        },
      );
    });
  });
});

test("BUY-3: a WAYFARER_KILL_SWITCH env halts naulon_research spend (server-config policy, not a tool arg)", async () => {
  // A gate that WOULD charge (every essay is priced + payable) — so absent the
  // kill-switch the agent pays. The env-configured policy must veto every pay.
  await withStubGate(payGate("1000"), async () => {
    await withCatalog(async () => {
      await withEnv(
        {
          WAYFARER_BUDGET_USDC: "0.1",
          WAYFARER_KILL_SWITCH: "true",
          WAYFARER_LICENSE_PATH: join(tmpdir(), `naulon-mcp-kill-${process.pid}.json`),
          OPENAI_API_KEY: undefined,
        },
        async () => {
          const client = await connectedClient();
          const res = await client.callTool({ name: "naulon_research", arguments: { topic: "payment and passage" } });
          const r = res.structuredContent as {
            spent: number;
            spentSessionUsdc: number;
            sources: unknown[];
            decisions: Array<{ action: string; reason: string }>;
          };
          assert.equal(r.spent, 0, "kill-switch env ⇒ the research run spends nothing");
          assert.equal(r.spentSessionUsdc, 0, "the session envelope was never debited");
          assert.equal(r.sources.length, 0, "nothing paid ⇒ nothing cited");
          assert.ok(r.decisions.length > 0, "essays were still discovered + decided");
          assert.ok(r.decisions.every((d) => d.action !== "pay"), "no decision is a pay under the kill-switch");
          assert.ok(r.decisions.some((d) => /kill-switch/i.test(d.reason)), "the halt reason is auditable in the log");
        },
      );
    });
  });
});

// ── BUY-4.0 — per-session options override env (the hosted-path config seam) ────
// The stdio funnel reads wallet/budget/policy from process env (one process = one
// buyer). The hosted server authenticates MANY buyer sessions, so it must inject
// each session's signer/budget/policy per `buildServer(opts)` — and the injected
// value must WIN over env (env is only the default when the opt is absent). These
// prove the override; the env-default path is covered by every other test above.

test("BUY-4.0: an injected budgetUsdc overrides the env ceiling for this session", async () => {
  await withStubGate(payGate("5000"), async () => {
    // Env budget is generous (1 USDC), but the session opt caps at 0.001 — the
    // 0.005 toll must read as unaffordable, proving the opt (not env) is the ceiling.
    await withEnv({ WAYFARER_BUDGET_USDC: "1" }, async () => {
      const client = await connectedClientWith({ budgetUsdc: 0.001 });
      const q = (await client.callTool({ name: "naulon_quote", arguments: { slug: "x" } }))
        .structuredContent as { affordable?: boolean; ceilingUsdc: number; remainingUsdc: number };
      assert.equal(q.ceilingUsdc, 0.001, "the session ceiling is the injected budget, not the 1 USDC env");
      assert.equal(q.affordable, false, "the 0.005 toll is unaffordable under the injected 0.001 ceiling");
      assert.equal(q.remainingUsdc, 0.001, "remaining reflects the injected ceiling");
    });
  });
});

test("BUY-4.0: an injected killSwitch policy halts spend even with no env kill-switch", async () => {
  await withStubGate(payGate("1000"), async () => {
    await withCatalog(async () => {
      // Env has NO kill-switch — absent the injected policy this run would pay.
      await withEnv(
        {
          WAYFARER_BUDGET_USDC: "0.1",
          WAYFARER_KILL_SWITCH: undefined,
          WAYFARER_LICENSE_PATH: join(tmpdir(), `naulon-mcp-optkill-${process.pid}.json`),
          OPENAI_API_KEY: undefined,
        },
        async () => {
          const client = await connectedClientWith({ policy: { ...DEFAULT_POLICY, killSwitch: true } });
          const r = (await client.callTool({ name: "naulon_research", arguments: { topic: "payment and passage" } }))
            .structuredContent as { spent: number; sources: unknown[]; decisions: Array<{ action: string; reason: string }> };
          assert.equal(r.spent, 0, "the injected kill-switch policy vetoes every pay");
          assert.equal(r.sources.length, 0, "nothing paid ⇒ nothing cited");
          assert.ok(r.decisions.length > 0, "essays were still discovered + decided");
          assert.ok(r.decisions.every((d) => d.action !== "pay"), "no decision is a pay under the injected kill-switch");
        },
      );
    });
  });
});

test("BUY-4.0: an injected signer is used to pay (no env private key involved)", async () => {
  await withStubGate(payGate("5000"), async () => {
    await withEnv({ WAYFARER_BUDGET_USDC: "1", BUYER_PRIVATE_KEY: undefined }, async () => {
      // A spy signer standing in for the cloud /sign-memo session key. The payGate
      // accepts any payment-signature, so a fixed sig completes the pay; we assert
      // the INJECTED signer produced it (the hosted custody-free path).
      let signed = 0;
      const spy: MemoSigner = {
        address: "0x000000000000000000000000000000000000BEEF",
        async signTypedData() {
          signed += 1;
          return `0x${"11".repeat(65)}` as `0x${string}`;
        },
      };
      const client = await connectedClientWith({ signer: spy });
      const p = (await client.callTool({ name: "naulon_pay_and_read", arguments: { slug: "x" } }))
        .structuredContent as { ok: boolean; costUsdc?: number };
      assert.equal(p.ok, true, "the pay completes via the injected signer");
      assert.equal(p.costUsdc, 0.005, "the toll total is debited");
      assert.ok(signed >= 1, "the injected signer signed the leg — not an env/BYO key");
    });
  });
});

test("BUY-4.0: the hosted probe binds the quote to the injected signer's address, not getWallet()'s dev key", async () => {
  // Regression: on the custody-free path (no BUYER_PRIVATE_KEY), getWallet() returns a THROWAWAY dev
  // key, so probing the 402 with getWallet().address bound the quote/license to an identity the buyer
  // never pays from. The probe must carry the injected session EOA (`x-naulon-agent`) instead.
  let probedAgent: string | undefined;
  const gate = await standGate((req, res) => {
    probedAgent = req.headers["x-naulon-agent"] as string | undefined;
    res.writeHead(402, { "payment-required": paymentRequired("5000"), "content-type": "application/json" });
    res.end("{}");
  });
  try {
    await withEnv({ BUYER_PRIVATE_KEY: undefined }, async () => {
      const spy: MemoSigner = {
        address: "0x000000000000000000000000000000000000bEEF",
        async signTypedData() {
          return `0x${"11".repeat(65)}` as `0x${string}`;
        },
      };
      const client = await connectedClientWith({ signer: spy, tollgateUrl: gate.url });
      await client.callTool({ name: "naulon_quote", arguments: { slug: "priced" } });
      assert.equal(
        probedAgent?.toLowerCase(),
        "0x000000000000000000000000000000000000beef",
        "the hosted probe binds to the session EOA (cloudSigner.address), not the dev BYO key",
      );
    });
  } finally {
    await gate.close();
  }
});

// ── BUY-4.2 — per-session tollgateUrl targets a specific fleet gate ────────────
// The hosted cloud serves ONE process for MANY buyer sessions, and each session
// settles into a specific fleet tenant's gate (the moat: own both ends of the
// receipt). An injected tollgateUrl must WIN over the process-global env
// TOLLGATE_URL — exactly as budget/policy/signer do (BUY-4.0) — so the cloud picks
// the payee gate server-side and a prompt-injected model can never redirect it.

test("BUY-4.2: an injected tollgateUrl targets that gate for naulon_quote, overriding env", async () => {
  const envGate = await standGate((_req, res) => {
    res.writeHead(402, { "payment-required": paymentRequired("9999"), "content-type": "application/json" });
    res.end("{}");
  });
  const fleetGate = await standGate((_req, res) => {
    res.writeHead(402, { "payment-required": paymentRequired("5000"), "content-type": "application/json" });
    res.end("{}");
  });
  try {
    await withEnv({ TOLLGATE_URL: envGate.url }, async () => {
      const client = await connectedClientWith({ tollgateUrl: fleetGate.url });
      const q = (await client.callTool({ name: "naulon_quote", arguments: { slug: "priced" } }))
        .structuredContent as { gated: boolean; amountAtomic?: string };
      assert.equal(q.gated, true, "the slug is gated");
      assert.equal(q.amountAtomic, "5000", "the price comes from the injected fleet gate, not the env gate");
      assert.ok(fleetGate.hits.some((u) => u.includes("/essays/priced")), "the fleet gate was probed");
      assert.equal(envGate.hits.length, 0, "the env gate was never touched");
    });
  } finally {
    await Promise.all([envGate.close(), fleetGate.close()]);
  }
});

// ── BUY-4.4 — the per-decision audit sink (the cloud's org-audit seam) ─────────
// The hosted path injects an `auditSink` so every buyer spend DECISION — a pay, a
// policy/budget skip, a kill-switch halt — is handed out structured for the cloud to
// write to its org-partitioned audit plane. A pure hook (the package never imports the
// cloud). Absent (the stdio funnel), no sink fires — proven by every test above running
// green with no sink. These prove the sink fires with the right shape.

test("BUY-4.4: a successful naulon_pay_and_read hands the auditSink a structured `pay` decision", async () => {
  await withStubGate(payGate("5000"), async () => {
    await withEnv({ WAYFARER_BUDGET_USDC: "1", BUYER_PRIVATE_KEY: undefined }, async () => {
      const events: DecisionAuditEvent[] = [];
      // A spy signer completes the pay deterministically (the payGate accepts any sig).
      const spy: MemoSigner = {
        address: "0x000000000000000000000000000000000000BEEF",
        async signTypedData() {
          return `0x${"11".repeat(65)}` as `0x${string}`;
        },
      };
      const client = await connectedClientWith({ signer: spy, auditSink: (e) => events.push(e) });
      const p = (await client.callTool({ name: "naulon_pay_and_read", arguments: { slug: "x" } }))
        .structuredContent as { ok: boolean };
      assert.equal(p.ok, true, "the pay completes");

      assert.equal(events.length, 1, "exactly one decision was audited");
      const [e] = events;
      assert.ok(e, "the decision event is present");
      assert.equal(e.action, "pay", "the decision is a pay");
      assert.equal(e.slug, "x", "the audited decision names the source slug");
      assert.equal(e.costUsdc, 0.005, "the true total debited is on the event");
      assert.equal(e.paidUsdc, 0.005, "the author leg paid is on the event");
      assert.ok((e.reason ?? "").length > 0, "the decision carries a human reason");
    });
  });
});

test("BUY-4.4: a budget-refused naulon_pay_and_read audits a `skip` decision (accountable, spent nothing)", async () => {
  await withStubGate(payGate("5000"), async () => {
    // Ceiling 0.001 < the 0.005 toll → refused before any spend, but still audited.
    await withEnv({ WAYFARER_BUDGET_USDC: "0.001" }, async () => {
      const events: DecisionAuditEvent[] = [];
      const client = await connectedClientWith({ auditSink: (e) => events.push(e) });
      const p = (await client.callTool({ name: "naulon_pay_and_read", arguments: { slug: "x" } }))
        .structuredContent as { ok: boolean; spentSessionUsdc: number };
      assert.equal(p.ok, false, "the over-budget pay is refused");
      assert.equal(p.spentSessionUsdc, 0, "nothing was spent");

      assert.equal(events.length, 1, "the refusal is still audited (an accountable non-spend)");
      const [e] = events;
      assert.ok(e, "the decision event is present");
      assert.equal(e.action, "skip", "a refused pay is a skip decision");
      assert.equal(e.slug, "x");
      assert.match(e.reason, /budget/i, "the reason explains it was a budget refusal");
    });
  });
});

test("BUY-4.4: naulon_research hands the auditSink one event per decision; a kill-switch run audits `skip`s carrying the halt reason", async () => {
  await withStubGate(payGate("1000"), async () => {
    await withCatalog(async () => {
      await withEnv(
        {
          WAYFARER_BUDGET_USDC: "0.1",
          WAYFARER_LICENSE_PATH: join(tmpdir(), `naulon-mcp-audit-kill-${process.pid}.json`),
          OPENAI_API_KEY: undefined,
        },
        async () => {
          const events: DecisionAuditEvent[] = [];
          const client = await connectedClientWith({
            policy: { ...DEFAULT_POLICY, killSwitch: true },
            auditSink: (e) => events.push(e),
          });
          const r = (await client.callTool({ name: "naulon_research", arguments: { topic: "payment and passage" } }))
            .structuredContent as { spent: number; decisions: Array<{ action: string }> };

          assert.equal(r.spent, 0, "the injected kill-switch vetoes every pay");
          assert.equal(events.length, r.decisions.length, "the sink fired exactly once per decision");
          assert.ok(events.length > 0, "essays were discovered + decided (so decisions were audited)");
          assert.ok(events.every((e) => e.action !== "pay"), "no audited decision is a pay under the kill-switch");
          assert.ok(
            events.some((e) => e.action === "skip" && /kill-switch/i.test(e.reason)),
            "the kill-switch halt is auditable — a skip carrying the halt reason",
          );
          for (const e of events) assert.equal(typeof e.slug, "string", "every audited decision names a slug");
        },
      );
    });
  });
});

test("BUY-4.2: naulon_research probes the injected tollgateUrl, not the env gate", async () => {
  // Both gates serve every path as a free read (200) → nothing is gated, nothing is
  // paid; the test only asserts WHICH gate the composite loop reached.
  const free = (_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("free content");
  };
  const envGate = await standGate(free);
  const fleetGate = await standGate(free);
  try {
    await withCatalog(async () => {
      await withEnv({ TOLLGATE_URL: envGate.url, OPENAI_API_KEY: undefined }, async () => {
        const client = await connectedClientWith({ tollgateUrl: fleetGate.url });
        const r = (await client.callTool({ name: "naulon_research", arguments: { topic: "payment and passage" } }))
          .structuredContent as { spent: number };
        assert.equal(r.spent, 0, "nothing is gated ⇒ nothing paid");
        assert.ok(fleetGate.hits.length > 0, "the composite loop probed the injected fleet gate");
        assert.equal(envGate.hits.length, 0, "the env gate was never touched by the run");
      });
    });
  } finally {
    await Promise.all([envGate.close(), fleetGate.close()]);
  }
});

// ── C1/C2/C3 — hosted held-store isolation, PoP wallet seam, dev-key warn ─────

/** A minimal mock cloud signer (never actually signs a real tx in these tests). */
const mockSigner: MemoSigner = {
  address: "0x1111111111111111111111111111111111111111",
  async signTypedData() {
    return `0x${"11".repeat(65)}` as `0x${string}`;
  },
};

function heldLicense(slug: string, exp: number): HeldLicense {
  return { slug, title: slug, jti: `jti-${slug}`, exp, aud: "gate://naulon", pop: false, jws: "h.p.s" };
}

test("C1 — read_held consults the INJECTED per-session store, not the process file", async () => {
  // An expired license in the injected store hits the 'expired' branch WITHOUT any gate call.
  // The file store would be empty → 'No held license'. The distinct error proves which store was read.
  const store = memoryHeldStore([["x", heldLicense("x", 1)]]); // exp=1 → long expired
  const client = await connectedClientWith({ heldStore: store });
  const res = await client.callTool({ name: "naulon_read_held", arguments: { slug: "x" } });
  const r = res.structuredContent as { ok: boolean; error?: string };
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /expired/i, "read the injected store's expired license, not the empty file");
});

test("C1 — two sessions with separate stores do not cross-read (the hosted leak, closed)", async () => {
  const storeA = memoryHeldStore([["secret", heldLicense("secret", 1)]]);
  const storeB = memoryHeldStore();
  const a = await connectedClientWith({ heldStore: storeA });
  const b = await connectedClientWith({ heldStore: storeB });
  const ra = (await a.callTool({ name: "naulon_read_held", arguments: { slug: "secret" } }))
    .structuredContent as { ok: boolean; error?: string };
  const rb = (await b.callTool({ name: "naulon_read_held", arguments: { slug: "secret" } }))
    .structuredContent as { ok: boolean; error?: string };
  assert.match(ra.error ?? "", /expired/i, "A sees its own held license");
  assert.match(rb.error ?? "", /No held license/i, "B never sees A's license — isolation holds");
});

test("A′4 — read_held re-reads at the STORED paid url, not a reconstructed /essays/ path", async () => {
  // The publisher serves the source at a custom path (/articles/<slug>), captured at pay
  // time in HeldLicense.url. A later read_held must re-fetch THAT url verbatim — not
  // articleUrl(gateBase(), slug), which would 404 off-shape. Two stub gates disambiguate:
  // the url-gate (where the license was paid) vs the session's tollgate base (the template
  // target). The re-read must hit the url-gate and never the base.
  const urlGate = await standGate((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("the real paid content");
  });
  const baseGate = await standGate((_req, res) => {
    res.writeHead(404);
    res.end("wrong shape");
  });
  try {
    const exp = Math.floor(Date.now() / 1000) + 3600; // live
    const store = memoryHeldStore([
      ["custom", { ...heldLicense("custom", exp), url: `${urlGate.url}/articles/the-real-path` }],
    ]);
    const client = await connectedClientWith({ heldStore: store, tollgateUrl: baseGate.url });
    const res = await client.callTool({ name: "naulon_read_held", arguments: { slug: "custom" } });
    const r = res.structuredContent as { ok: boolean; content?: string };
    assert.equal(r.ok, true, "re-read succeeded against the stored url");
    assert.equal(r.content, "the real paid content");
    assert.ok(
      urlGate.hits.some((u) => u.includes("/articles/the-real-path")),
      "re-read hit the STORED paid url verbatim",
    );
    assert.equal(baseGate.hits.length, 0, "never reconstructed a /essays/<slug> path against the gate base");
  } finally {
    await Promise.all([urlGate.close(), baseGate.close()]);
  }
});

// ── B1 (CRITICAL) — a held license must never leak to a same-slug candidate at a
// DIFFERENT publisher ────────────────────────────────────────────────────────────
// The held store is keyed by SLUG ALONE (licenseStore.ts). Two publishers can both
// be legitimately trusted (both in WAYFARER_ALLOW_DOMAINS — no SSRF/allowlist
// refusal applies to either) yet still be DIFFERENT origins. If naulon_research's
// composite loop re-reads a cache decision at the DISCOVERED candidate's own url
// (untrusted — discover() can hand back anything) instead of the url the license
// was actually PAID at, a same-slug candidate served from pubB gets pubA's
// license/PoP-proof headers on the wire — a credential leak across publisher
// origins, independent of whether pubB's response ultimately honors them.
test("B1: a held license (issued by pubA) never leaks to a same-slug candidate discovered at pubB, even though both are allow-listed", async () => {
  const PUB_A = "http://pub-a.test";
  const PUB_B = "http://pub-b.test";
  const CATALOG = "http://catalog.test/b1";
  const slug = "shared-slug";

  const hitsA: Array<Record<string, string>> = [];
  const hitsB: Array<Record<string, string>> = [];

  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
    const u = String(url);
    const headers = init?.headers ?? {};
    if (u.startsWith(CATALOG)) {
      return new Response(
        JSON.stringify([
          { slug, title: "Shared Slug", summary: "payment and passage", url: `${PUB_B}/essays/${slug}` },
        ]),
        { status: 200 },
      );
    }
    if (u.includes("/.well-known/")) return new Response(null, { status: 404 });
    if (u.startsWith(PUB_A)) {
      hitsA.push(headers as Record<string, string>);
      return new Response("pubA content", { status: 200 });
    }
    if (u.startsWith(PUB_B)) {
      hitsB.push(headers as Record<string, string>);
      // Whatever the response, the REQUEST itself already carried (or didn't carry)
      // the credential — that's the leak surface under test, not pubB's reply.
      return new Response(JSON.stringify({ error: "payment required" }), {
        status: 402,
        headers: { "payment-required": paymentRequired("1000") },
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;

  try {
    await withEnv(
      {
        RSS_URL: undefined,
        PUBLISHER_URL: undefined,
        CATALOG_URL: CATALOG,
        OPENAI_API_KEY: undefined,
        TOLLGATE_URL: PUB_A,
        WAYFARER_ALLOW_DOMAINS: "pub-a.test,pub-b.test",
        WAYFARER_BUDGET_USDC: "0.1",
      },
      async () => {
        const exp = Math.floor(Date.now() / 1000) + 3600; // live
        const held: HeldLicense = {
          slug,
          title: "Shared Slug",
          jti: `jti-${slug}`,
          exp,
          aud: "gate://pub-a",
          pop: true,
          jws: "held.jws.sig",
          url: `${PUB_A}/essays/${slug}`,
        };
        const store = memoryHeldStore([[slug, held]]);
        const client = await connectedClientWith({
          heldStore: store,
          popWallet: {
            address: "0x1111111111111111111111111111111111111111",
            mock: false,
            signMessage: async () => "0xproofsig",
          },
        });

        const r = (await client.callTool({ name: "naulon_research", arguments: { topic: "payment and passage" } }))
          .structuredContent as { decisions: Array<{ slug: string; action: string }> };
        assert.ok(
          r.decisions.some((d) => d.slug === slug && d.action === "cache"),
          `expected a "cache" decision for the shared slug, got ${JSON.stringify(r.decisions)}`,
        );

        assert.ok(
          !hitsB.some((h) => h["x-naulon-license"] || h["x-naulon-proof"]),
          "pubB (the untrusted same-slug candidate) must NEVER receive pubA's license/PoP proof",
        );
        assert.ok(
          hitsA.some((h) => h["x-naulon-license"]),
          "pubA (the url the license was actually paid at) receives the free re-read WITH its own license",
        );
      },
    );
  } finally {
    globalThis.fetch = real;
  }
});

test("C3 — hosted signer present but no popWallet + mock dev key ⇒ loud warn", async () => {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(" "));
  };
  try {
    await withEnv({ BUYER_PRIVATE_KEY: undefined }, async () => {
      buildServer({ signer: mockSigner });
    });
  } finally {
    console.warn = orig;
  }
  assert.ok(
    warnings.some((w) => /popWallet/.test(w) && /proof-of-possession/.test(w)),
    "warns that PoP re-reads will use the mock dev key",
  );
});

test("C3 — hosted signer WITH popWallet injected ⇒ no warn", async () => {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(" "));
  };
  try {
    await withEnv({ BUYER_PRIVATE_KEY: undefined }, async () => {
      buildServer({
        signer: mockSigner,
        popWallet: { address: mockSigner.address, mock: false, signMessage: async () => "0xsig" },
      });
    });
  } finally {
    console.warn = orig;
  }
  assert.equal(
    warnings.some((w) => /popWallet/.test(w)),
    false,
    "no warn when a PoP signer is supplied",
  );
});

// ── Slice A′ — URL-centric discrete MCP tools ──────────────────────────────────
// The composite run()/naulon_research pipeline is URL-centric (Slice A). These prove
// the DISCRETE tools carry the canonical url too, so a hosted MCP pays a publisher's
// real /articles/<slug> link (a typical publisher's shape) instead of the reconstructed
// /essays/<slug> template. Absent a url, quote/pay must still fall back to the template.

test("A′: naulon_discover surfaces each candidate's canonical url", async () => {
  const CATALOG = "http://catalog.test/list";
  await withEnv(
    { RSS_URL: undefined, PUBLISHER_URL: undefined, CATALOG_URL: CATALOG, OPENAI_API_KEY: undefined },
    async () => {
      const real = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL) => {
        if (String(url).startsWith(CATALOG)) {
          return new Response(
            JSON.stringify([
              { slug: "deep", title: "Deep", summary: "a deep essay on passage and payment", url: "http://gate.test/articles/deep" },
            ]),
            { status: 200 },
          );
        }
        return new Response(null, { status: 404 });
      }) as typeof globalThis.fetch;
      try {
        const client = await connectedClient();
        const res = await client.callTool({ name: "naulon_discover", arguments: { topic: "passage and payment" } });
        const s = res.structuredContent as { candidates: Array<{ slug: string; url?: string }> };
        const deep = s.candidates.find((c) => c.slug === "deep");
        assert.ok(deep, "the catalog candidate is discovered");
        assert.equal(deep.url, "http://gate.test/articles/deep", "the canonical url is surfaced to the model");
      } finally {
        globalThis.fetch = real;
      }
    },
  );
});

test("A′: naulon_quote probes the passed canonical url verbatim, not a reconstructed /essays/ path", async () => {
  const gate = await standGate((_req, res) => {
    res.writeHead(402, { "payment-required": paymentRequired("5000"), "content-type": "application/json" });
    res.end("{}");
  });
  try {
    const client = await connectedClientWith({ tollgateUrl: gate.url });
    const q = (
      await client.callTool({ name: "naulon_quote", arguments: { slug: "deep", url: `${gate.url}/articles/deep` } })
    ).structuredContent as { gated: boolean };
    assert.equal(q.gated, true, "the source is quoted from its canonical url");
    assert.ok(gate.hits.some((u) => u.includes("/articles/deep")), "the canonical /articles/ url was probed verbatim");
    assert.ok(!gate.hits.some((u) => u.includes("/essays/")), "no /essays/ reconstruction when a url is present");
  } finally {
    await gate.close();
  }
});

test("A′: naulon_quote falls back to the /essays/ template when no url is passed", async () => {
  const gate = await standGate((_req, res) => {
    res.writeHead(402, { "payment-required": paymentRequired("5000"), "content-type": "application/json" });
    res.end("{}");
  });
  try {
    const client = await connectedClientWith({ tollgateUrl: gate.url });
    const q = (await client.callTool({ name: "naulon_quote", arguments: { slug: "deep" } })).structuredContent as {
      gated: boolean;
    };
    assert.equal(q.gated, true, "the slug-only quote still works");
    assert.ok(gate.hits.some((u) => u.includes("/essays/deep")), "slug-only reconstructs the /essays/ template");
  } finally {
    await gate.close();
  }
});

test("A′: naulon_pay_and_read pays the passed canonical url verbatim (/articles/), never /essays/", async () => {
  const gate = await standGate(payGate("5000"));
  try {
    const client = await connectedClientWith({ signer: mockSigner, tollgateUrl: gate.url, budgetUsdc: 1 });
    const p = (
      await client.callTool({ name: "naulon_pay_and_read", arguments: { slug: "deep", url: `${gate.url}/articles/deep` } })
    ).structuredContent as { ok: boolean };
    assert.equal(p.ok, true, "the pay completes");
    assert.ok(gate.hits.some((u) => u.includes("/articles/deep")), "both the budget probe and the pay hit the canonical url");
    assert.ok(!gate.hits.some((u) => u.includes("/essays/")), "no /essays/ reconstruction on the pay path");
  } finally {
    await gate.close();
  }
});

// ── RAS-A2b — buildServer routes the injected signer to the network's rail ────
// The injected-cloud-signer pay path hardcoded memoBuyer(cloudSigner), so on a
// memo-LESS network (Base + every Gateway chain) the hosted MCP could never settle
// (the Base-settle bug). buildServer must mirror selectBuyer(): on a gateway network
// route the SAME injected signer through gatewayBuyer, which posts the Circle
// envelope the facilitator verify requires — proof the branch, not memo, ran.
const GATEWAY_WALLET_BASE_SEPOLIA = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
function gatewayPaymentRequired(amountAtomic: string): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "https://x.test/a", description: "naulon read toll", mimeType: "text/html" },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:84532",
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          payTo: "0x000000000000000000000000000000000000dEaD",
          amount: amountAtomic,
          maxTimeoutSeconds: 691200,
          extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: GATEWAY_WALLET_BASE_SEPOLIA },
        },
      ],
    }),
  ).toString("base64");
}

test("RAS-B5: with railSigners buildServer picks the rail from the 402 — a gateway 402 under an Arc (memo) fleet signs the gateway envelope", async () => {
  // The mixed-fleet buy side: the fleet default is arcTestnet (memo-capable), but the tenant's 402
  // is gateway-shaped. railBuyer must sign the GATEWAY envelope off the 402, not the memo rail the
  // fleet's activeNetwork() would pick. The two rail signers are distinct accounts so the envelope's
  // authorization.from proves the GATEWAY signer ran (not memo).
  const memoAcct = privateKeyToAccount(generatePrivateKey());
  const gatewayAcct = privateKeyToAccount(generatePrivateKey());
  let paidHeader: string | undefined;
  const gate = await standGate((req, res) => {
    if (req.headers["payment-signature"]) {
      paidHeader = req.headers["payment-signature"] as string;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("paid content");
    } else {
      res.writeHead(402, { "payment-required": gatewayPaymentRequired("10000"), "content-type": "application/json" });
      res.end(JSON.stringify({ error: "payment required" }));
    }
  });
  try {
    await withEnv(
      {
        SETTLEMENT_NETWORK: "arcTestnet", // fleet default is memo-capable, ON PURPOSE
        PAYMENT_MODE: "gateway",
        LICENSES_ENABLED: "false",
        WAYFARER_BUDGET_USDC: "1",
        BUYER_PRIVATE_KEY: undefined,
      },
      async () => {
        const client = await connectedClientWith({
          railSigners: { memo: memoAcct, gateway: gatewayAcct },
          tollgateUrl: gate.url,
          budgetUsdc: 1,
        });
        const p = (
          await client.callTool({ name: "naulon_pay_and_read", arguments: { slug: "x", url: `${gate.url}/articles/x` } })
        ).structuredContent as { ok: boolean; error?: string };
        assert.equal(p.ok, true, `expected a paid read on the gateway rail, got: ${p.ok ? "" : p.error}`);
        assert.ok(paidHeader, "the buyer retried with a payment-signature");
        const envelope = JSON.parse(Buffer.from(paidHeader!, "base64").toString("utf8")) as {
          payload?: { authorization?: { from?: string } };
          resource?: unknown;
          accepted?: unknown;
        };
        assert.equal(
          envelope.payload?.authorization?.from?.toLowerCase(),
          gatewayAcct.address.toLowerCase(),
          "the gateway envelope's authorization.from is the GATEWAY signer — railBuyer picked gateway off the 402, not memo off the Arc fleet",
        );
        assert.ok(envelope.resource && envelope.accepted, "the envelope carries resource + accepted (facilitator verify requires them)");
      },
    );
  } finally {
    await gate.close();
  }
});

test("RAS-A2b: on a gateway (memo-less) network buildServer routes the injected signer through gatewayBuyer", async () => {
  const injected = privateKeyToAccount(generatePrivateKey()); // ≠ any env key
  let paidHeader: string | undefined;
  const gate = await standGate((req, res) => {
    if (req.headers["payment-signature"]) {
      paidHeader = req.headers["payment-signature"] as string;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("paid content");
    } else {
      res.writeHead(402, { "payment-required": gatewayPaymentRequired("10000"), "content-type": "application/json" });
      res.end(JSON.stringify({ error: "payment required" }));
    }
  });
  try {
    await withEnv(
      {
        SETTLEMENT_NETWORK: "baseSepolia",
        PAYMENT_MODE: "gateway",
        LICENSES_ENABLED: "false",
        WAYFARER_BUDGET_USDC: "1",
        BUYER_PRIVATE_KEY: undefined,
      },
      async () => {
        const client = await connectedClientWith({ signer: injected, tollgateUrl: gate.url, budgetUsdc: 1 });
        const p = (
          await client.callTool({ name: "naulon_pay_and_read", arguments: { slug: "x", url: `${gate.url}/articles/x` } })
        ).structuredContent as { ok: boolean; error?: string };
        assert.equal(p.ok, true, `expected a paid read on the gateway rail, got: ${p.ok ? "" : p.error}`);
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
    await gate.close();
  }
});

// ── δ (A2-2 / A2-3) — the granular pay path must be gated too ────────────────────────────────
// Both holes lived in the same place: naulon_quote / naulon_pay_and_read ran with NO policy and
// NO origin check, while only naulon_research went through decide(). The tool descriptions tell
// agents to PREFER the granular path, so these were the recommended workflow, not an edge case.

test("A2-3: naulon_pay_and_read REFUSES an off-gate url and spends nothing", async () => {
  // A poisoned discover teaser (or direct prompt injection) is enough to hand the model a url.
  // Off-gate ⇒ the attacker authors the 402, naming their OWN payTo — a real USDC authorization.
  await withStubGate(payGate("1000"), async () => {
    const client = await connectedClient();
    const res = await client.callTool({
      name: "naulon_pay_and_read",
      arguments: { slug: "zeybek", url: "http://attacker.example/articles/zeybek" },
    });
    const r = res.structuredContent as { ok: boolean; error?: string; spentSessionUsdc: number };
    assert.equal(r.ok, false, "an off-gate url must never be paid");
    assert.match(r.error ?? "", /configured gate/i, "the refusal names the gate pin");
    assert.equal(r.spentSessionUsdc, 0, "nothing was spent");
  });
});

test("A2-3: naulon_quote refuses an off-gate url as refused:true, NOT gated:false (no free-read shape)", async () => {
  await withStubGate(payGate("1000"), async () => {
    const client = await connectedClient();
    const res = await client.callTool({
      name: "naulon_quote",
      arguments: { slug: "zeybek", url: "http://attacker.example/articles/zeybek" },
    });
    const r = res.structuredContent as { gated?: boolean; refused?: boolean; note?: string };
    // A refusal must NOT wear gated:false — the tool description says gated:false means
    // "free read, just fetch it", so a buyer agent would fetch the very off-gate url we refused.
    assert.equal(r.refused, true, "the refusal carries an explicit refused:true signal");
    assert.equal(r.gated, undefined, "gated is absent — a refusal is neither payable nor a free read");
    assert.match(r.note ?? "", /configured gate/i, "the reason is surfaced");
  });
});

test("A2-3: a policy-denied host is quoted as refused:true, not a free read", async () => {
  await withStubGate(payGate("1000"), async () => {
    // On-gate host, but operator policy denies it — spendGate refuses even the free probe.
    const client = await connectedClientWith({
      policy: { ...DEFAULT_POLICY, denyDomains: ["127.0.0.1"] },
      budgetUsdc: 1,
    });
    const res = await client.callTool({ name: "naulon_quote", arguments: { slug: "zeybek" } });
    const r = res.structuredContent as { gated?: boolean; refused?: boolean; note?: string };
    assert.equal(r.refused, true, "a policy denial is a refusal, surfaced through the same signal");
    assert.equal(r.gated, undefined, "not gated:false — a buyer must not read a denied host as free");
    assert.match(r.note ?? "", /denied by policy/i);
  });
});

test("A2-2: an injected killSwitch halts naulon_pay_and_read, not just naulon_research", async () => {
  await withStubGate(payGate("1000"), async () => {
    const client = await connectedClientWith({ policy: { ...DEFAULT_POLICY, killSwitch: true }, budgetUsdc: 1 });
    const res = await client.callTool({ name: "naulon_pay_and_read", arguments: { slug: "zeybek" } });
    const r = res.structuredContent as { ok: boolean; error?: string; spentSessionUsdc: number };
    assert.equal(r.ok, false, "the operator's kill switch must bind on every spending path");
    // Canonical wording comes from the ONE shared spendGate, identical to what decide() reports.
    assert.match(r.error ?? "", /kill-switch engaged/i);
    assert.equal(r.spentSessionUsdc, 0, "nothing was spent");
  });
});

test("A2-2: a denyDomains entry blocks the granular pay path", async () => {
  await withStubGate(payGate("1000"), async () => {
    const client = await connectedClientWith({
      policy: { ...DEFAULT_POLICY, denyDomains: ["127.0.0.1"] },
      budgetUsdc: 1,
    });
    const res = await client.callTool({ name: "naulon_pay_and_read", arguments: { slug: "zeybek" } });
    const r = res.structuredContent as { ok: boolean; error?: string; spentSessionUsdc: number };
    assert.equal(r.ok, false, "a denied host must not be paid from the granular tool");
    assert.match(r.error ?? "", /denied by policy/i);
    assert.equal(r.spentSessionUsdc, 0);
  });
});

test("A2-2: approvalThresholdUsdc gates an expensive toll behind human approval (nothing spent)", async () => {
  await withStubGate(payGate("1000"), async () => {
    // Toll is $0.001; threshold $0.0005 ⇒ must NOT auto-pay.
    const client = await connectedClientWith({
      policy: { ...DEFAULT_POLICY, approvalThresholdUsdc: 0.0005 },
      budgetUsdc: 1,
    });
    const res = await client.callTool({ name: "naulon_pay_and_read", arguments: { slug: "zeybek" } });
    const r = res.structuredContent as { ok: boolean; error?: string; spentSessionUsdc: number };
    assert.equal(r.ok, false, "a toll at/above the approval threshold is not auto-paid");
    assert.match(r.error ?? "", /approval/i);
    assert.equal(r.spentSessionUsdc, 0);
  });
});

// ── β (A2-4 / A2-7) — the spend lock ─────────────────────────────────────────────────────────
// The budget check and its debit are separated by network I/O, and an MCP client may issue tool
// calls concurrently. Unserialized, two pays both read the same remaining budget, both pass the
// check, and both spend — breaching a ceiling that is supposed to be un-raisable.

test("A2-4: two CONCURRENT pays cannot breach the session ceiling", async () => {
  await withStubGate(payGate("1000"), async () => {
    // Ceiling $0.0015 fits exactly ONE $0.001 toll, never two.
    const client = await connectedClientWith({ budgetUsdc: 0.0015 });
    const [a, b] = await Promise.all([
      client.callTool({ name: "naulon_pay_and_read", arguments: { slug: "a" } }),
      client.callTool({ name: "naulon_pay_and_read", arguments: { slug: "b" } }),
    ]);
    const ra = a.structuredContent as { ok: boolean; spentSessionUsdc: number };
    const rb = b.structuredContent as { ok: boolean; spentSessionUsdc: number };
    const okCount = [ra.ok, rb.ok].filter(Boolean).length;
    assert.equal(okCount, 1, "exactly one concurrent pay may succeed under a one-toll ceiling");
    const finalSpent = Math.max(ra.spentSessionUsdc, rb.spentSessionUsdc);
    assert.ok(finalSpent <= 0.0015, `spend ${finalSpent} must never exceed the $0.0015 ceiling`);
  });
});

// A2-7 (held-license lost update) is fixed by the SAME lock proven above: the store's
// read-modify-write (load → set → save) now runs inside the locked pay_and_read region, so two
// pays can no longer both load a pre-update snapshot. There is no dedicated test here because the
// stub `payGate` issues no `x-naulon-license` header, leaving the persist path unreachable from
// these fixtures — a real coverage gap. Closing it needs a stub that mints a decodable license JWS.
