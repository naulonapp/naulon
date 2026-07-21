/**
 * BUY-1.3 (e2e) — the session budget envelope verified against the REAL shipped
 * stdio binary. Where `server.test.ts` drives `buildServer()` over an in-memory
 * transport, this spawns `tsx src/index.ts` as a child process and talks to it
 * with a real MCP `StdioClientTransport` — the exact path an MCP host (Claude
 * Desktop / Cursor) uses. It proves the budget gate, debit, accumulation,
 * over-budget refusal, and research clamp survive real stdio JSON-RPC framing.
 *
 * Payment is mock-signed (default PAYMENT_MODE=mock) against a tiny local gate:
 * the on-chain settle is BUY-1.5's `live` bar, deliberately out of scope here.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Package root — the spawned binary's cwd. This file lives in <pkg>/src. */
const PKG_ROOT = join(import.meta.dirname, "..");

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

/** Gate that 402s a probe and serves content once a payment-signature is shown. */
function payGate(amountAtomic: string) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.headers["payment-signature"]) {
      res.writeHead(200, {
        "content-type": "text/plain",
        "payment-response": Buffer.from(JSON.stringify({ settlement: "mock-settle-ref", network: "arc-testnet" })).toString("base64"),
      });
      res.end("paid content body");
    } else {
      res.writeHead(402, { "payment-required": paymentRequired(amountAtomic), "content-type": "application/json" });
      res.end(JSON.stringify({ error: "payment required" }));
    }
  };
}

/** Gate that serves everything free (nothing gated). */
const freeGate = (_req: IncomingMessage, res: ServerResponse): void => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("free content");
};

/** The catalog the research e2e discovers from — discovery has no bundled-demo
 *  fallback, so the spawned binary needs a real CATALOG_URL. `the-naulon` is the
 *  on-topic essay for the "passage" topic. */
const catalogGate = (_req: IncomingMessage, res: ServerResponse): void => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify([
      { slug: "on-stillness", title: "On Stillness", summary: "On attention, silence, and the discipline of staying with one thing." },
      { slug: "the-naulon", title: "The Naulon", summary: "The fare paid to cross — payment, passage, and what we owe for what we take." },
      { slug: "the-river-and-the-name", title: "The River and the Name", summary: "Identity, change, and whether a thing survives the renaming of itself." },
    ]),
  );
};

/** Stand up a throwaway gate on an ephemeral port; returns its URL + a teardown. */
async function startGate(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/** Spawn the real stdio binary with env overrides and return a connected client.
 *  OPENAI_API_KEY is blanked so appraise stays offline. Discovery has no bundled
 *  fallback, so any test that discovers must pass CATALOG_URL (see catalogGate). */
async function connect(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/index.ts"],
    cwd: PKG_ROOT,
    env: { ...process.env, OPENAI_API_KEY: "", PAYMENT_MODE: "mock", ...env },
  });
  const client = new Client({ name: "wayfarer-mcp-e2e", version: "0.0.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

async function structured<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  return res.structuredContent as T;
}

type Quote = { gated: boolean; totalUsdc?: number; affordable?: boolean; remainingUsdc: number };
type Pay = { ok: boolean; content?: string; costUsdc?: number; spentSessionUsdc: number; remainingUsdc: number; error?: string };
type Research = { budget: number; requestedBudgetUsdc?: number };

test("e2e (real stdio binary): pay debits the envelope, accumulates, and refuses an over-budget toll spending nothing", async () => {
  const gate = await startGate(payGate("5000")); // 0.005 USDC toll
  // Ceiling 0.012 affords two 0.005 tolls (→0.002 left), not a third.
  const { client, close } = await connect({
    TOLLGATE_URL: gate.url,
    WAYFARER_BUDGET_USDC: "0.012",
    WAYFARER_LICENSE_PATH: join(tmpdir(), `naulon-mcp-e2e-pay-${process.pid}.json`),
  });
  try {
    const q = await structured<Quote>(client, "naulon_quote", { slug: "a" });
    assert.equal(q.gated, true, "the slug is gated");
    assert.equal(q.totalUsdc, 0.005, "the 402 price is decoded");
    assert.equal(q.affordable, true, "0.005 fits under the 0.012 ceiling");
    assert.equal(q.remainingUsdc, 0.012, "the full budget remains before any spend");

    const p1 = await structured<Pay>(client, "naulon_pay_and_read", { slug: "a" });
    assert.equal(p1.ok, true, "first pay succeeds");
    assert.equal(p1.costUsdc, 0.005, "the true total is reported");
    assert.equal(p1.spentSessionUsdc, 0.005, "the envelope is debited");
    assert.equal(p1.remainingUsdc, 0.007, "remaining drops by the toll");
    assert.ok((p1.content ?? "").length > 0, "the paid content comes back");

    const p2 = await structured<Pay>(client, "naulon_pay_and_read", { slug: "b" });
    assert.equal(p2.ok, true, "second pay succeeds");
    assert.equal(p2.spentSessionUsdc, 0.01, "spend accumulates across calls in one stdio session");
    assert.equal(p2.remainingUsdc, 0.002, "remaining drops again");

    const p3 = await structured<Pay>(client, "naulon_pay_and_read", { slug: "c" });
    assert.equal(p3.ok, false, "the third pay exceeds the remaining 0.002 and is refused");
    // B4: the refusal reason now comes from the ONE shared spendGate (byte-identical to decide()'s
    // wording) instead of a second, duplicate over-budget check with its own prose.
    assert.match(p3.error ?? "", /exceeds remaining budget/i, "the error explains it is a budget refusal");
    assert.equal(p3.spentSessionUsdc, 0.01, "the refused pay debits nothing");

    const q2 = await structured<Quote>(client, "naulon_quote", { slug: "c" });
    assert.equal(q2.affordable, false, "quote flags the toll unaffordable once the budget is exhausted");
  } finally {
    await close();
    await gate.close();
  }
});

test("e2e (real stdio binary): naulon_research clamps a requested budget down to the session remaining (never up)", async () => {
  const gate = await startGate(freeGate);
  const catalog = await startGate(catalogGate);
  const { client, close } = await connect({
    TOLLGATE_URL: gate.url,
    CATALOG_URL: `${catalog.url}/catalog`,
    WAYFARER_BUDGET_USDC: "0.05",
    WAYFARER_LICENSE_PATH: join(tmpdir(), `naulon-mcp-e2e-research-${process.pid}.json`),
  });
  try {
    const over = await structured<Research>(client, "naulon_research", { topic: "passage", budgetUsdc: 999 });
    assert.equal(over.budget, 0.05, "a 999 request is clamped to the 0.05 session ceiling");
    assert.equal(over.requestedBudgetUsdc, 999, "the un-clamped request is echoed back for transparency");

    const under = await structured<Research>(client, "naulon_research", { topic: "passage", budgetUsdc: 0.01 });
    assert.equal(under.budget, 0.01, "a request below the ceiling is honored as-is (model may spend less)");
    assert.equal(under.requestedBudgetUsdc, undefined, "an un-clamped request is not flagged");
  } finally {
    await close();
    await gate.close();
    await catalog.close();
  }
});
