import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnose, probeUrl, runTollProbe } from "./test-toll.ts";

test("probeUrl joins gate + prefix + slug without doubling slashes", () => {
  assert.equal(probeUrl("http://127.0.0.1:8402", "essays,articles", "on-stillness"), "http://127.0.0.1:8402/essays/on-stillness");
  assert.equal(probeUrl("http://127.0.0.1:8402/", "essays", "x"), "http://127.0.0.1:8402/essays/x");
  assert.equal(probeUrl("http://g", "/essays/", "x"), "http://g/essays/x");
  assert.equal(probeUrl("http://g", " essays , posts ", "x"), "http://g/essays/x", "takes the FIRST prefix, trimmed");
});

test("probeUrl handles an empty prefix list", () => {
  assert.equal(probeUrl("http://g", "", "x"), "http://g/x");
});

test("402 with a quote is the pass", () => {
  const d = diagnose(402, true, null);
  assert.equal(d.status, "pass");
  assert.match(d.summary, /toll works/);
  assert.equal(d.fix, "");
});

test("402 without a quote fails — refused but never priced", () => {
  const d = diagnose(402, false, null);
  assert.equal(d.status, "fail");
  assert.match(d.fix, /DEFAULT_PRICE_USDC/);
});

test("200 names the three real causes, prefixes first", () => {
  const d = diagnose(200, false, null);
  assert.equal(d.status, "fail");
  assert.match(d.summary, /served the article free/);
  assert.match(d.fix, /ARTICLE_PATH_PREFIXES/);
  assert.match(d.fix, /credits source/);
  assert.match(d.fix, /crawlerPolicy/);
});

test("a redirect is diagnosed as an edge in front of the gate, not a toll failure", () => {
  const d = diagnose(301, false, null);
  assert.equal(d.status, "fail");
  assert.match(d.fix, /Cloudflare|CDN|edge/i);
});

test("502/504 points at the origin, not the gate", () => {
  for (const s of [502, 504]) {
    assert.match(diagnose(s, false, null).fix, /ORIGIN_URL/);
  }
});

test("401/403 points at whatever sits in front of the gate", () => {
  assert.match(diagnose(403, false, null).fix, /proxy, WAF, or basic-auth/);
});

test("an unknown status still surfaces the gate's own verdict", () => {
  const d = diagnose(418, false, "blocked (\"teapot\")");
  assert.match(d.summary, /teapot/);
});

test("no tollable slug skips rather than failing, and says why", async () => {
  const p = await runTollProbe({ slug: null, apiMode: false });
  assert.equal(p.status, "skipped");
  assert.match(p.fix, /Content page/);
  assert.equal(p.url, null);
});

test("API mode skips with the by-hand instruction — the console cannot enumerate a slug", async () => {
  const p = await runTollProbe({ slug: null, apiMode: true });
  assert.equal(p.status, "skipped");
  assert.match(p.summary, /live API/);
  assert.match(p.fix, /crawler user-agent/);
});

const refuse = () => Promise.reject(Object.assign(new Error("ECONNREFUSED"), { name: "TypeError" }));
const timeout = () => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
const respond = (status: number, headers: Record<string, string> = {}) =>
  () => Promise.resolve(new Response(null, { status, headers }));

test("an unreachable gate reports the address to fix, not a stack trace", async () => {
  const p = await runTollProbe({ slug: "on-stillness", apiMode: false }, { fetchImpl: refuse as unknown as typeof fetch });
  assert.equal(p.status, "fail");
  assert.match(p.summary, /Could not reach the gate/);
  assert.match(p.fix, /Start the gate|fix GATE_URL/);
  assert.ok(p.url?.endsWith("/on-stillness"), "the probed URL is reported back");
  assert.equal(p.httpStatus, null, "no response means no status to claim");
});

test("a hung gate is distinguished from a refused one", async () => {
  const p = await runTollProbe({ slug: "x", apiMode: false }, { fetchImpl: timeout as unknown as typeof fetch });
  assert.equal(p.status, "fail");
  assert.match(p.summary, /did not answer in 8s/);
  assert.match(p.fix, /blocked on your origin/);
});

test("a live 402 with the quote header is the pass, end to end", async () => {
  const p = await runTollProbe(
    { slug: "on-stillness", apiMode: false },
    { fetchImpl: respond(402, { "payment-required": "x402 ...", "x-naulon-verdict": 'agent (user-agent matched "gptbot")' }) as unknown as typeof fetch },
  );
  assert.equal(p.status, "pass");
  assert.equal(p.httpStatus, 402);
  assert.equal(p.quoted, true);
  assert.match(p.verdict ?? "", /gptbot/);
});

test("a 200 from the gate is reported as a failure to toll", async () => {
  const p = await runTollProbe({ slug: "x", apiMode: false }, { fetchImpl: respond(200) as unknown as typeof fetch });
  assert.equal(p.status, "fail");
  assert.match(p.fix, /ARTICLE_PATH_PREFIXES/);
});

test("elapsedMs is measured from the injected clock", async () => {
  let t = 1000;
  const p = await runTollProbe(
    { slug: "x", apiMode: false },
    { fetchImpl: respond(402, { "payment-required": "q" }) as unknown as typeof fetch, now: () => (t += 25) },
  );
  assert.equal(p.elapsedMs, 25);
});
