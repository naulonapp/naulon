/**
 * A WordPress site's REST API and feeds hand out the full article text. The gate strips it for
 * anyone the article page would charge, and serves it whole to anyone the article page serves free.
 * Driven through `createApp` against a fake origin, as an agent and as a person would reach it.
 */
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EVENTS_PATH = join(tmpdir(), `naulon-content-exit-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";

const { createApp } = await import("./app.ts");
const { usdc } = await import("@naulon/shared");
type PublisherConfig = import("@naulon/shared").PublisherConfig;

const GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.1; +https://openai.com/gptbot)";
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const POSTS = JSON.stringify([
  { id: 1, title: { rendered: "A" }, content: { rendered: "<p>Full text of A.</p>", protected: false }, excerpt: { rendered: "<p>Teaser A.</p>" } },
]);
const FEED = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><title>A</title><description><![CDATA[Teaser A]]></description><content:encoded><![CDATA[<p>Full text of A.</p>]]></content:encoded></item></channel></rss>`;

function app(over: Partial<PublisherConfig> = {}) {
  const pub: PublisherConfig = {
    id: "pub-1",
    originUrl: "https://origin.example",
    articlePrefixes: ["blog"],
    price: usdc(0.001),
    citationMultiplier: 5,
    credits: { async resolve() { return undefined; } },
    licenseIdentity: "naulon:pub-1",
    ...over,
  };
  return createApp({ async resolve(h: string) { return h === "pub.example" ? pub : undefined; } });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
  if (url.pathname.startsWith("/wp-json/") || url.searchParams.get("rest_route")) {
    return new Response(POSTS, { status: 200, headers: { "content-type": "application/json; charset=UTF-8", etag: '"v1"' } });
  }
  if (url.pathname.includes("/feed")) return new Response(FEED, { status: 200, headers: { "content-type": "application/rss+xml; charset=UTF-8" } });
  return new Response("<html>home</html>", { status: 200, headers: { "content-type": "text/html" } });
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const get = (path: string, ua: string, over?: Partial<PublisherConfig>) => app(over).request(`https://pub.example${path}`, { headers: { "user-agent": ua } });

test("an agent gets the REST API's posts with the excerpt where the body was", async () => {
  for (const path of ["/wp-json/wp/v2/posts?per_page=1", "/?rest_route=/wp/v2/posts"]) {
    const res = await get(path, GPTBOT);
    const body = await res.text();
    assert.equal(res.status, 200, path);
    assert.ok(!body.includes("Full text"), path);
    assert.deepEqual(JSON.parse(body)[0].content, { rendered: "<p>Teaser A.</p>", protected: true });
    assert.equal(res.headers.get("x-naulon-exit"), "wordpress-rest");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.match(res.headers.get("vary") ?? "", /user-agent/i);
    assert.equal(res.headers.get("etag"), null, "the origin's validator described a different body");
  }
});

test("an agent gets the feed without content:encoded, teaser kept", async () => {
  const res = await get("/feed/", GPTBOT);
  const body = await res.text();
  assert.ok(!body.includes("Full text"));
  assert.ok(body.includes("Teaser A"));
  assert.equal(res.headers.get("x-naulon-exit"), "wordpress-feed");
});

test("a person reads both whole, and the cache is told the answer depends on who asked", async () => {
  for (const path of ["/wp-json/wp/v2/posts", "/feed/"]) {
    const res = await get(path, BROWSER);
    assert.ok((await res.text()).includes("Full text"), path);
    assert.equal(res.headers.get("x-naulon-exit"), null);
    assert.match(res.headers.get("vary") ?? "", /user-agent/i, path);
    assert.notEqual(res.headers.get("cache-control"), "no-store", "a person's response keeps the origin's caching");
  }
});

test("a crawler the site lets read free reads whole, as on the article page", async () => {
  const res = await get("/wp-json/wp/v2/posts", GPTBOT, { crawlerPolicy: { allow: ["gptbot"], block: [] } });
  assert.ok((await res.text()).includes("Full text"));
});

test("a site that gives ai-input away serves it whole", async () => {
  const res = await get("/feed/", GPTBOT, { termsPolicy: { "ai-input": "free" } as PublisherConfig["termsPolicy"] });
  assert.ok((await res.text()).includes("Full text"));
});

test("a route that is not an exit is the origin's response, untouched", async () => {
  const res = await get("/", GPTBOT);
  assert.equal(await res.text(), "<html>home</html>");
  assert.equal(res.headers.get("x-naulon-exit"), null);
});
