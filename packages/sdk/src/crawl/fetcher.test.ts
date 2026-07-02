import { test } from "node:test";
import assert from "node:assert/strict";
import { makeGuardedFetcher } from "./fetcher.ts";

/** A fetch stub that records the URL it was asked for and returns a canned 200. */
function stub(body = "ok") {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    return { ok: true, status: 200, async text() { return body; } } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("makeGuardedFetcher rejects an off-origin host", async () => {
  const { impl } = stub();
  const f = makeGuardedFetcher({ origin: "https://site.com", fetchImpl: impl });
  await assert.rejects(() => f("https://evil.com/x"), /off-origin host blocked/);
});

test("makeGuardedFetcher allows the verified origin host", async () => {
  const { impl, calls } = stub("<rss>");
  const f = makeGuardedFetcher({ origin: "https://site.com", fetchImpl: impl });
  const res = await f("https://site.com/feed");
  assert.equal(res.ok, true);
  assert.equal(await res.text(), "<rss>");
  assert.deepEqual(calls, ["https://site.com/feed"]);
});

test("makeGuardedFetcher rejects non-https by default", async () => {
  const { impl } = stub();
  const f = makeGuardedFetcher({ origin: "https://site.com", fetchImpl: impl });
  await assert.rejects(() => f("http://site.com/feed"), /must be https/);
});

test("makeGuardedFetcher permits http on the origin only under allowPrivate (dev)", async () => {
  const { impl } = stub("ok");
  const f = makeGuardedFetcher({ origin: "http://localhost:3000", allowPrivate: true, fetchImpl: impl });
  const res = await f("http://localhost:3000/feed");
  assert.equal(res.ok, true);
});

test("makeGuardedFetcher throws on an invalid origin at construction", () => {
  const { impl } = stub();
  assert.throws(() => makeGuardedFetcher({ origin: "not a url", fetchImpl: impl }), /invalid origin/);
});

test("makeGuardedFetcher wraps json()", async () => {
  const { impl } = stub("[1,2,3]");
  const f = makeGuardedFetcher({ origin: "https://site.com", fetchImpl: impl });
  const res = await f("https://site.com/wp-json/wp/v2/posts");
  assert.deepEqual(await res.json(), [1, 2, 3]);
});
