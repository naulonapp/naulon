/**
 * Web Bot Auth slice-3 live walk — the dogfood loop, everything real:
 * the gate on a TCP socket serving OUR key directory from its own route,
 * and the REAL wayfarer buyer code (agentFetch → probePrice → mock pay)
 * signing every request with the identity that directory publishes. The
 * toll verifies its own species end-to-end:
 *
 *   1. the gate serves + self-signs /.well-known/http-message-signatures-directory
 *   2. signed probe            → 402 quote, observation verified:true
 *   3. signed pay_and_read     → 200 paid, observation verified:true (paid row)
 *   4. verified allow-listed   → reads free (price() sees no 402)
 *   5. tampered signature      → served as human, sigInvalid observation
 *   6. unsigned wayfarer       → regression: no WBA fields on the observation
 *
 * Run: node --import tsx scripts/wba-s3-walk.mjs
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GATE_PORT = 18412;
const ORIGIN_PORT = 13998;
const HOST = `127.0.0.1:${GATE_PORT}`;
const OBS_PATH = join(tmpdir(), `naulon-wba-s3-walk-${process.pid}.jsonl`);

process.env.OBSERVATIONS_BACKEND = "jsonl";
process.env.OBSERVATIONS_PATH = OBS_PATH;
process.env.EVENTS_PATH = join(tmpdir(), `naulon-wba-s3-events-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";
process.env.BOT_AUTH_ALLOW_HTTP = "true"; // loopback directory — walk fixture only
process.env.BOT_AUTH_SIGNING_KEY = randomBytes(32).toString("base64url");
process.env.BOT_AUTH_SIGNATURE_AGENT = `http://${HOST}`; // the gate serves its own directory

const { createApp } = await import("../packages/tollgate/src/app.ts");
const { buildSignatureBase, parseSignatureInput, parseSignatureHeader, verifyEd25519 } = await import(
  "../packages/tollgate/src/botAuth.ts"
);
const { botAuthKeyFromSeed, resetConfig, usdc, walletAddress } = await import("@naulon/shared");
const { mockBuyer } = await import("../packages/wayfarer/src/pay.ts");
const { botAuthHeadersFor, resetAgentIdentity } = await import("../packages/wayfarer/src/sign.ts");
const { serve } = await import("@hono/node-server");

const KEY = botAuthKeyFromSeed(process.env.BOT_AUTH_SIGNING_KEY);
const AGENT = "127.0.0.1"; // verified identity = directory hostname, port stripped

// ── origin stub ─────────────────────────────────────────────────────
const originServer = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html>origin content</html>");
});
originServer.listen(ORIGIN_PORT);

// ── the gate, on a real socket, resolving the loopback host ────────
const AUTHOR_WALLET = walletAddress("0x0000000000000000000000000000000000000001");
const PUB = {
  id: "wba-s3-walk",
  originUrl: `http://127.0.0.1:${ORIGIN_PORT}`,
  articlePrefixes: ["essays"],
  price: usdc(0.001),
  citationMultiplier: 5,
  credits: {
    async resolve(slug) {
      return { slug, title: slug, contributors: [{ authorId: "a", wallet: AUTHOR_WALLET }] };
    },
  },
  licenseIdentity: "naulon:wba-s3.example",
  crawlerPolicy: { allow: [], block: [], charge: [] },
};
const app = createApp({ async resolve(h) { return h === HOST ? PUB : undefined; } });
const gate = serve({ fetch: app.fetch, port: GATE_PORT });

const url = (slug) => `http://${HOST}/essays/${slug}`;
const results = [];
const check = (name, ok, got = "") => results.push({ name, ok, got });

// 1. the gate serves + self-signs our directory
{
  const res = await fetch(`http://${HOST}/.well-known/http-message-signatures-directory`);
  const body = await res.json();
  const okShape =
    res.status === 200 &&
    (res.headers.get("content-type") ?? "").includes("http-message-signatures-directory+json") &&
    body.keys?.[0]?.x === KEY.x;
  const entries = parseSignatureInput(res.headers.get("signature-input") ?? "");
  const entry = entries?.find((e) => e.params.tag === "http-message-signatures-directory");
  const sig = entry && parseSignatureHeader(res.headers.get("signature") ?? "")?.get(entry.label);
  const base =
    entry &&
    buildSignatureBase(entry, {
      authority: HOST,
      method: "GET",
      path: "/.well-known/http-message-signatures-directory",
      targetUri: `http://${HOST}/.well-known/http-message-signatures-directory`,
      headers: {},
    });
  const okSig = Boolean(base && sig && verifyEd25519(base, sig, KEY.x));
  check("gate serves its own signed key directory", okShape && okSig, `status ${res.status}`);
}

const buyer = mockBuyer();

// 2. signed probe → 402 quote
const quoted = await buyer.price(url("quote"), "read");
check("signed probe gets a 402 quote", quoted !== null && quoted.priceUsdc === 0.001, JSON.stringify(quoted?.priceUsdc));

// 3. signed pay_and_read → 200 paid
const bought = await buyer.fetch(url("buy"), "read");
check("signed pay_and_read succeeds", bought.ok === true && (bought.content ?? "").includes("origin content"), bought.error ?? "ok");

// 4. verified allow-listed CRAWL → reads free. Deliberately NOT buyer.price():
// the buyer's probe declares payment intent (x-naulon-kind), and payment intent
// beats verified-allow by design ("an agent that wants to pay, pays"). An
// allow-listed crawler crawling — signed, no payment headers — reads free.
PUB.crawlerPolicy.allow = [AGENT];
{
  const res = await fetch(url("free"), {
    headers: { ...botAuthHeadersFor(url("free")), "user-agent": "naulon-wayfarer/0.1", accept: "text/html" },
  });
  check("verified allow-listed crawl reads free (200)", res.status === 200, `status ${res.status}`);
}
PUB.crawlerPolicy.allow = [];

// 5. tampered signature → served human, masquerade telemetry
{
  const h = botAuthHeadersFor(url("masq"));
  h.signature = h.signature.replace(/:(....)/, ":AAAA");
  const res = await fetch(url("masq"), {
    headers: { ...h, "user-agent": "Mozilla/5.0 Firefox/128.0", accept: "text/html" },
  });
  check("tampered signature fails open (200 human)", res.status === 200, `status ${res.status}`);
}

// 6. unsigned wayfarer — regression (identity unset ⇒ plain fetch)
delete process.env.BOT_AUTH_SIGNING_KEY;
delete process.env.BOT_AUTH_SIGNATURE_AGENT;
resetConfig();
resetAgentIdentity();
const plainQuote = await buyer.price(url("plain"), "read");
check("unsigned wayfarer still quotes (regression)", plainQuote !== null, JSON.stringify(plainQuote?.priceUsdc));

// observations: give the fire-and-forget sink a beat, then read the ledger
await new Promise((r) => setTimeout(r, 300));
const obs = readFileSync(OBS_PATH, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const bySlug = (s) => obs.filter((o) => o.slug === s).at(-1) ?? {};
check("obs: probe row verified + identity", bySlug("quote").verified === true && bySlug("quote").verifiedAgent === AGENT);
check("obs: paid row verified + verdict paid", bySlug("buy").verdict === "paid" && bySlug("buy").verified === true && bySlug("buy").verifiedAgent === AGENT);
check("obs: allow-listed row served-free + verified", bySlug("free").verdict === "served-free" && bySlug("free").verified === true);
check("obs: tampered row sigInvalid, never verified", bySlug("masq").sigInvalid === true && bySlug("masq").verified === undefined);
check("obs: unsigned row carries no WBA fields", bySlug("plain").verified === undefined && bySlug("plain").sigInvalid === undefined);

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.got ? `  → ${r.got}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);

gate.close();
originServer.close();
process.exit(failed === 0 ? 0 : 1);
