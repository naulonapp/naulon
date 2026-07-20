/**
 * Self-contained demo — the whole loop end to end, no creds, ~10 seconds:
 *   stub origin → tollgate → wayfarer pays a citation → attribution settles.
 *
 *   node scripts/demo.mjs        (or: make demo)
 *
 * Uses mock settlement so it runs offline. Set PAYMENT_MODE=gateway with a
 * funded BUYER_PRIVATE_KEY to drive the real Circle Gateway rail instead.
 */
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const TOPIC = process.argv.slice(2).join(" ") || "payment and passage";
const ORIGIN_PORT = 3019;
const TOLLGATE_PORT = 8412;

// A stable Citation License key for the demo's lifetime, so a license minted on
// the first wayfarer pass still verifies on the second — letting the agent
// re-read what it already paid for, FREE. Generated fresh each run (not persisted,
// no secret on disk); the held-license cache is cleared so the story is
// deterministic: pass 1 pays, pass 2 re-reads free.
const demoKey = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
rmSync("data/wayfarer-licenses.json", { force: true });

const env = {
  ...process.env,
  ORIGIN_URL: `http://localhost:${ORIGIN_PORT}`,
  // Discovery has no bundled-demo fallback; the agent discovers from this origin's
  // /catalog. Explicit here so the self-contained demo needs no external config.
  CATALOG_URL: `http://localhost:${ORIGIN_PORT}/catalog`,
  ARTICLE_PATH_PREFIXES: "essays",
  TOLLGATE_PORT: String(TOLLGATE_PORT),
  TOLLGATE_URL: `http://localhost:${TOLLGATE_PORT}`,
  PAYMENT_MODE: process.env.PAYMENT_MODE ?? "mock",
  WAYFARER_BUDGET_USDC: process.env.WAYFARER_BUDGET_USDC ?? "0.05",
  LICENSE_SIGNING_KEY: process.env.LICENSE_SIGNING_KEY ?? demoKey,
};

// The demo catalog — free teasers the agent discovers, then pays to read.
const CATALOG = [
  { slug: "on-stillness", title: "On Stillness", summary: "On attention, silence, and the discipline of staying with one thing." },
  { slug: "the-naulon", title: "The Naulon", summary: "The fare paid to cross — payment, passage, and what we owe for what we take." },
  { slug: "the-river-and-the-name", title: "The River and the Name", summary: "Identity, change, and whether a thing survives the renaming of itself." },
];

// 1. stub origin (stands in for a publisher): /catalog for discovery, HTML body
//    for any essay path the tollgate proxies once paid.
const origin = createServer((q, s) => {
  if ((q.url ?? "/").split("?")[0] === "/catalog") {
    s.writeHead(200, { "content-type": "application/json" });
    s.end(JSON.stringify(CATALOG));
    return;
  }
  s.writeHead(200, { "content-type": "text/html" });
  s.end(`<article>Essay at ${q.url}</article>`);
}).listen(ORIGIN_PORT);

function run(args, label) {
  return new Promise((resolve) => {
    const c = spawn("npx", ["tsx", ...args], { env, stdio: "inherit" });
    c.on("exit", () => resolve());
    if (label) c.on("error", (e) => console.error(label, e.message));
  });
}

// 2. tollgate
const tollgate = spawn("npx", ["tsx", "packages/tollgate/src/index.ts"], { env, stdio: "ignore" });

console.log(`\n━━ naulon demo ━━  topic: "${TOPIC}"  mode: ${env.PAYMENT_MODE}\n`);
await sleep(3500);

console.log("① WAYFARER — discover, decide, pay (captures a Citation License per source)\n");
await run(["packages/wayfarer/src/index.ts", TOPIC]);

console.log("\n①b WAYFARER, SECOND PASS — re-reads what it already licensed, FREE\n");
await run(["packages/wayfarer/src/index.ts", TOPIC]);

console.log("\n② ATTRIBUTION — batch + settle to authors\n");
await run(["packages/attribution/src/index.ts"]);

console.log("\n③ Open the dashboard to see it live:  npm run dashboard  → http://localhost:8403\n");

tollgate.kill("SIGTERM");
origin.close();
process.exit(0);
