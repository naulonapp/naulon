import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EVENTS_PATH = join(tmpdir(), `naulon-rangesroute-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";

const { createApp } = await import("./app.ts");
const { createRangeFetcher } = await import("./rangeFetcher.ts");

const GOOGLE = "https://developers.google.com/static/crawling/ipranges/common-crawlers.json";
const fetchImpl = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url === GOOGLE) return new Response(JSON.stringify({ prefixes: [{ ipv4Prefix: "66.249.64.0/27" }] }));
  // The gate publishes nothing until every proxy list has a good copy.
  if (url === "https://www.cloudflare.com/ips-v4") return new Response("173.245.48.0/20\n");
  if (url === "https://www.cloudflare.com/ips-v6") return new Response("2400:cb00::/32\n");
  return new Response("nope", { status: 404 });
}) as typeof fetch;

test("the route 503s before the first fetch", async () => {
  const fetcher = createRangeFetcher({ fetchImpl });
  const app = createApp(undefined, { crawlerRanges: { ...fetcher, document: () => null } });
  const res = await app.request("/.well-known/naulon/crawler-ranges.json");
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "60");
});

test("the route serves the document, cacheable and open to every origin", async () => {
  const fetcher = createRangeFetcher({ fetchImpl });
  await fetcher.refresh();
  const app = createApp(undefined, { crawlerRanges: fetcher });
  const res = await app.request("/.well-known/naulon/crawler-ranges.json");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const body = (await res.json()) as { version: number; operators: { id: string; prefixes: string[] }[] };
  assert.equal(body.version, 1);
  assert.deepEqual(body.operators.find((o) => o.id === "google")?.prefixes, ["66.249.64.0/27"]);
});
