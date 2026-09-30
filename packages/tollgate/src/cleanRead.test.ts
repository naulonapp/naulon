/**
 * An agent that asks for markdown gets the article as markdown, and the licence hash covers that
 * text. A human, whatever it sends, gets the origin's page untouched.
 */
import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "naulon-clean-read-"));
const OBS_PATH = join(dir, "observations.jsonl");
process.env.EVENTS_PATH = join(dir, "events.jsonl");
process.env.OBSERVATIONS_PATH = OBS_PATH;
process.env.OBSERVATIONS_BACKEND = "jsonl";
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "true";
process.env.RATE_LIMIT_RPM = "0";

const { app } = await import("./app.ts");
const { buildMockSignature, PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } = await import("./x402.ts");

const PAYER = "0x1234567890abcdef1234567890abcdef12345678";
const PARA = "The sentence an agent paid the author to read, and nothing around it. ".repeat(8);
const ARTICLE = `<!doctype html><html lang="en"><head><title>On stillness</title>
<script>${"track();".repeat(200)}</script></head><body>
<nav>${"<a href='/x'>menu item</a> ".repeat(50)}</nav>
<article><h1>On stillness</h1><p>${PARA}</p><h2>Second part</h2><p>${PARA}</p></article>
<footer>site footer</footer></body></html>`;
const MD = "text/markdown, text/html;q=0.9";

let bodyMode: "ok" | "dies-after-headers" = "ok";
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(c) {
          if (bodyMode === "dies-after-headers") {
            c.error(new Error("socket hang up"));
            return;
          }
          c.enqueue(new TextEncoder().encode(ARTICLE));
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    )) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  bodyMode = "ok";
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const licenceClaims = (jws: string) =>
  (JSON.parse(Buffer.from(jws.split(".")[1]!, "base64url").toString("utf8")) as { naulon: Record<string, unknown> }).naulon;
/** Observation writes are fire-and-forget, so poll for the row rather than read once. */
async function waitForObs(match: (o: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  for (let i = 0; i < 50; i++) {
    const rows = readFileSync(OBS_PATH, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const hit = rows.findLast(match);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("no matching observation was written");
}

async function pay(slug: string, accept?: string): Promise<Response> {
  const headers: Record<string, string> = { "x-naulon-agent": "tester", ...(accept ? { accept } : {}) };
  const first = await app.request(`/essays/${slug}`, { headers });
  assert.equal(first.status, 402);
  const req = JSON.parse(Buffer.from(first.headers.get(PAYMENT_REQUIRED_HEADER)!, "base64").toString("utf8")) as {
    accepts: Array<{ amount: string; extra: { nonce: string } }>;
  };
  const a = req.accepts[0]!;
  return app.request(`/essays/${slug}`, {
    headers: { ...headers, [PAYMENT_SIGNATURE_HEADER]: buildMockSignature(PAYER, a.amount, a.extra.nonce) },
  });
}

test("a paid read asking for markdown gets the article, and the licence hashes that text", async () => {
  const res = await pay("on-stillness", MD);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-naulon-extraction"), "gate");
  assert.match(res.headers.get("content-type")!, /^text\/markdown/);
  const body = await res.text();
  assert.match(body, /^## Second part$/m);
  assert.doesNotMatch(body, /menu item|site footer|track\(\)/);
  assert.equal(licenceClaims(res.headers.get("x-naulon-license")!).contentSha256, sha(body));
});

test("a paid read with no Accept gets the page as served, hashed as served", async () => {
  const res = await pay("on-stillness");
  const body = await res.text();
  assert.equal(body, ARTICLE);
  assert.equal(res.headers.get("x-naulon-extraction"), null);
  assert.equal(licenceClaims(res.headers.get("x-naulon-license")!).contentSha256, sha(ARTICLE));
});

test("a human asking for markdown still reads the origin's page, untouched and free", async () => {
  const res = await app.request("/essays/on-stillness", {
    headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15", accept: MD },
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), ARTICLE);
  assert.equal(res.headers.get("x-naulon-extraction"), null);
});

test("an agent's paid response varies by Accept as well as User-Agent", async () => {
  const vary = (await pay("on-stillness", MD)).headers.get("vary")!.toLowerCase();
  assert.match(vary, /user-agent/);
  assert.match(vary, /accept/);
});

test("the paid observation records how the body was produced and how much smaller it was", async () => {
  await (await pay("the-river-and-the-name", MD)).text();
  const paid = await waitForObs((o) => o.verdict === "paid" && o.slug === "the-river-and-the-name");
  assert.equal(paid.extraction, "gate");
  assert.ok((paid.servedBytes as number) < (paid.sourceBytes as number));
  assert.equal(paid.sourceBytes, Buffer.byteLength(ARTICLE));
});

test("a licensed reread asking for markdown gets markdown and records it", async () => {
  const jws = (await pay("on-stillness", MD)).headers.get("x-naulon-license")!;
  const reread = await app.request("/essays/on-stillness", {
    headers: { "x-naulon-agent": "tester", "x-naulon-license": jws, accept: MD },
  });
  assert.equal(reread.status, 200);
  assert.equal(reread.headers.get("x-naulon-extraction"), "gate");
  assert.doesNotMatch(await reread.text(), /menu item/);
  const obs = await waitForObs((o) => o.verdict === "agent-reread" && o.slug === "on-stillness");
  assert.equal(obs.extraction, "gate");
});

test("a reread whose origin body dies is a 502, never a half page", async () => {
  const jws = (await pay("on-stillness", MD)).headers.get("x-naulon-license")!;
  bodyMode = "dies-after-headers";
  const reread = await app.request("/essays/on-stillness", {
    headers: { "x-naulon-agent": "tester", "x-naulon-license": jws, accept: MD },
  });
  assert.equal(reread.status, 502);
  assert.match(reread.headers.get("x-naulon-verdict")!, /origin body unreadable/);
});
