/**
 * Web Bot Auth live walk — the slice-1 `live` gate. Everything real: the gate
 * on a TCP socket, a loopback key-directory server the gate actually fetches
 * (BOT_AUTH_ALLOW_HTTP=true), an Ed25519 signer, and curl driving the matrix:
 *
 *   1. verified unlisted signer  → 402 (charged despite a browser-shaped UA)
 *   2. verified allow-listed     → 200 free (spoof-proof allowlist)
 *   3. verified blocked + payment→ 403 (block beats payment, UA innocence moot)
 *   4. tampered signature        → 200 human (fail-open) + sigInvalid observation
 *   5. unsigned browser          → 200 human (regression)
 *
 * Run: node --import tsx scripts/wba-walk.mjs
 */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OBS_PATH = join(tmpdir(), `naulon-wba-walk-${process.pid}.jsonl`);
process.env.OBSERVATIONS_BACKEND = "jsonl";
process.env.OBSERVATIONS_PATH = OBS_PATH;
process.env.EVENTS_PATH = join(tmpdir(), `naulon-wba-walk-events-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";
process.env.BOT_AUTH_ALLOW_HTTP = "true";

const { createApp } = await import("../packages/tollgate/src/app.ts");
const { jwkThumbprint, buildSignatureBase, parseSignatureInput } = await import(
  "../packages/tollgate/src/botAuth.ts"
);
const { usdc, walletAddress } = await import("@naulon/shared");
const { serve } = await import("@hono/node-server");

const GATE_PORT = 18402;
const DIR_PORT = 19421;
const ORIGIN_PORT = 13999;
const HOST = "wba.example";

// ── Ed25519 signer ──────────────────────────────────────────────────
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const X = publicKey.export({ format: "jwk" }).x;
const KEYID = jwkThumbprint(X);
// Signature-Agent points at host:port (the directory URL); the verified
// IDENTITY is the hostname alone — in production "chatgpt.com", here loopback.
const AGENT_URL = `127.0.0.1:${DIR_PORT}`;
const AGENT = "127.0.0.1";

// ── loopback key directory (what the gate live-fetches) ─────────────
const dirServer = createServer((req, res) => {
  if (req.url === "/.well-known/http-message-signatures-directory") {
    res.writeHead(200, { "content-type": "application/http-message-signatures-directory+json" });
    res.end(JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: X }] }));
    return;
  }
  res.writeHead(404).end();
});
dirServer.listen(DIR_PORT);

// ── origin stub ─────────────────────────────────────────────────────
const originServer = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html>origin content</html>");
});
originServer.listen(ORIGIN_PORT);

// ── the gate, on a real socket ──────────────────────────────────────
const AUTHOR_WALLET = walletAddress("0x0000000000000000000000000000000000000001");
const PUB = {
  id: "wba-walk",
  originUrl: `http://127.0.0.1:${ORIGIN_PORT}`,
  articlePrefixes: ["essays"],
  price: usdc(0.001),
  citationMultiplier: 5,
  credits: {
    async resolve(slug) {
      return { slug, title: slug, contributors: [{ authorId: "a", wallet: AUTHOR_WALLET }] };
    },
  },
  licenseIdentity: "naulon:wba.example",
  crawlerPolicy: { allow: [], block: [], charge: [] },
};
// The verified identity IS the directory host — for the walk that's the
// loopback host:port, so allow/block fragments name it. Two publishers keyed
// by policy would complicate the walk; instead flip policy per case below.
const app = createApp({ async resolve(h) { return h === HOST ? PUB : undefined; } });
const gate = serve({ fetch: app.fetch, port: GATE_PORT });

function signHeaders(path, { breakSig = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const agentHeader = `"http://${AGENT_URL}"`;
  const member = `("@authority");created=${now - 2};expires=${now + 58};keyid="${KEYID}";alg="ed25519";tag="web-bot-auth"`;
  const entry = parseSignatureInput(`sig1=${member}`)[0];
  const base = buildSignatureBase(entry, {
    authority: HOST,
    method: "GET",
    path,
    targetUri: `http://${HOST}${path}`,
    headers: { "signature-agent": agentHeader },
  });
  let sig = cryptoSign(null, Buffer.from(base), privateKey);
  if (breakSig) sig = Buffer.from(sig.map((b, i) => (i === 5 ? b ^ 0xff : b)));
  return [
    "-H", `Signature-Agent: ${agentHeader}`,
    "-H", `Signature-Input: sig1=${member}`,
    "-H", `Signature: sig1=:${sig.toString("base64")}:`,
  ];
}

// curl runs ASYNC — the gate lives in this same process, so a synchronous
// child call would block the event loop and deadlock the request against it.
async function curl(path, extraArgs = []) {
  const { stdout } = await execFileP("curl", [
    "-s", "-o", "/dev/null",
    "-w", "%{http_code} %{header_json}",
    "-H", `Host: ${HOST}`,
    "-H", "User-Agent: Mozilla/5.0 Firefox/128.0",
    "-H", "Accept: text/html",
    ...extraArgs,
    `http://127.0.0.1:${GATE_PORT}${path}`,
  ]);
  const code = Number(stdout.slice(0, 3));
  const headers = JSON.parse(stdout.slice(4));
  return { code, verdict: headers["x-naulon-verdict"]?.[0] ?? "" };
}

const results = [];
function check(name, got, want) {
  const ok = got.code === want.code && (want.verdict === undefined || got.verdict.includes(want.verdict));
  results.push({ name, ok, got: `${got.code} "${got.verdict}"` });
}

// 1. verified, unlisted → 402
check("verified unlisted signer pays (402)", await curl("/essays/one", signHeaders("/essays/one")), {
  code: 402, verdict: "verified web-bot-auth",
});

// 2. verified + allow-listed → 200 free
PUB.crawlerPolicy.allow = [AGENT];
check("verified allow-listed reads free (200)", await curl("/essays/two", signHeaders("/essays/two")), {
  code: 200, verdict: "verified agent",
});
PUB.crawlerPolicy.allow = [];

// 3. verified + blocked + payment header → 403
PUB.crawlerPolicy.block = [AGENT];
check(
  "verified blocked refused despite payment (403)",
  await curl("/essays/three", [...signHeaders("/essays/three"), "-H", "X-PAYMENT: deadbeef"]),
  { code: 403, verdict: "blocked" },
);
PUB.crawlerPolicy.block = [];

// 4. tampered signature → 200 human, fail-open
check(
  "tampered signature fails open to human (200)",
  await curl("/essays/four", signHeaders("/essays/four", { breakSig: true })),
  { code: 200, verdict: "human" },
);

// 5. unsigned browser → 200 human (regression)
check("unsigned browser unchanged (200 human)", await curl("/essays/five"), { code: 200, verdict: "human" });

// observations: give the fire-and-forget sink a beat, then read the ledger
await new Promise((r) => setTimeout(r, 300));
const obs = readFileSync(OBS_PATH, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const bySlug = (s) => obs.filter((o) => o.slug === s).at(-1) ?? {};
const obsChecks = [
  ["obs: charged row verified:true + agent", bySlug("one").verified === true && bySlug("one").verifiedAgent === AGENT],
  ["obs: allowed row served-free + verified", bySlug("two").verdict === "served-free" && bySlug("two").verified === true],
  ["obs: blocked row verifiedAgent stamped", bySlug("three").verdict === "blocked" && bySlug("three").verifiedAgent === AGENT],
  ["obs: tampered row sigInvalid:true", bySlug("four").sigInvalid === true && bySlug("four").verified === undefined],
  ["obs: unsigned row carries no WBA fields", bySlug("five").verified === undefined && bySlug("five").sigInvalid === undefined],
];
for (const [name, ok] of obsChecks) results.push({ name, ok, got: "" });

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.got ? `  → ${r.got}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);

gate.close();
dirServer.close();
originServer.close();
process.exit(failed === 0 ? 0 : 1);
