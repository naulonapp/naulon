import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverRestRoot, wordpressAdapter, wpRoute } from "./wordpress.ts";
import type { AdapterContext, CrawlConfig } from "../types.ts";

const POSTS = JSON.stringify([{ link: "https://x.test/the-paper/", title: { rendered: "The paper" } }]);

/** A fake origin: `routes` maps a full URL to a response; everything else 404s. */
function ctxFor(routes: Record<string, { body?: string; headers?: Record<string, string>; status?: number }>) {
  const asked: string[] = [];
  const ctx: AdapterContext = {
    origin: "https://x.test",
    articlePrefixes: [],
    config: {} as CrawlConfig,
    fetch: async (url: string) => {
      asked.push(url);
      const hit = routes[url];
      const status = hit ? (hit.status ?? 200) : 404;
      const body = hit?.body ?? "";
      const headers = new Headers(hit?.headers ?? {});
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
        json: async () => JSON.parse(body) as unknown,
        header: (name: string) => headers.get(name) ?? undefined,
      };
    },
  };
  return { ctx, asked };
}

test("wpRoute composes a path root and a query root with params as query parameters", () => {
  assert.equal(wpRoute("https://x.test/wp-json/", "wp/v2/posts", { per_page: "1" }), "https://x.test/wp-json/wp/v2/posts?per_page=1");
  assert.equal(
    wpRoute("https://x.test/?rest_route=/", "wp/v2/posts", { per_page: "1", page: "2" }),
    "https://x.test/?rest_route=%2Fwp%2Fv2%2Fposts&per_page=1&page=2",
  );
});

test("a Link header advertising ?rest_route= is the root, and posts are read there", async () => {
  const { ctx, asked } = ctxFor({
    "https://x.test/": { headers: { link: '<https://x.test/?rest_route=/>; rel="https://api.w.org/"' } },
    "https://x.test/?rest_route=%2Fwp%2Fv2%2Fposts&per_page=1": { body: POSTS },
  });
  assert.equal(await discoverRestRoot(ctx), "https://x.test/?rest_route=/");
  assert.equal(await wordpressAdapter.detect(ctx), true);
  assert.ok(asked.includes("https://x.test/?rest_route=%2Fwp%2Fv2%2Fposts&per_page=1"));
});

test("an HTML link tag naming a subdirectory root is the root", async () => {
  const { ctx } = ctxFor({
    "https://x.test/": { body: `<html><head><link rel='https://api.w.org/' href='https://x.test/blog/wp-json/' /></head></html>` },
  });
  assert.equal(await discoverRestRoot(ctx), "https://x.test/blog/wp-json/");
});

test("a root on another host is ignored", async () => {
  const { ctx } = ctxFor({
    "https://x.test/": { headers: { link: '<https://evil.test/wp-json/>; rel="https://api.w.org/"' } },
  });
  assert.equal(await discoverRestRoot(ctx), "https://x.test/wp-json/");
});

test("nothing advertised keeps today's /wp-json/ URLs", async () => {
  const { ctx, asked } = ctxFor({ "https://x.test/wp-json/wp/v2/posts?per_page=1": { body: POSTS } });
  assert.equal(await discoverRestRoot(ctx), "https://x.test/wp-json/");
  assert.equal(await wordpressAdapter.detect(ctx), true);
  assert.ok(asked.includes("https://x.test/wp-json/wp/v2/posts?per_page=1"));
});

test("a /wp-json/ that 404s falls back to ?rest_route=", async () => {
  const { ctx } = ctxFor({ "https://x.test/?rest_route=%2Fwp%2Fv2%2Fposts&per_page=1": { body: POSTS } });
  assert.equal(await wordpressAdapter.detect(ctx), true);
});

test("discover reads every page from the discovered root", async () => {
  const { ctx, asked } = ctxFor({
    "https://x.test/": { headers: { link: '<https://x.test/?rest_route=/>; rel="https://api.w.org/"' } },
    "https://x.test/?rest_route=%2Fwp%2Fv2%2Fposts&_embed=1&per_page=50&page=1&status=publish": { body: POSTS },
  });
  const found = await wordpressAdapter.discover(ctx);
  assert.equal(found.length, 1);
  assert.equal(asked.filter((u) => u.includes("/wp-json/")).length, 0);
});
