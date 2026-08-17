# Writing a crawl adapter

`naulon crawl` reads a publisher's own site and drafts a `credits.json` so nobody has to hand-write
one article at a time. It ships three adapters — WordPress, RSS/Atom, and sitemap — which between
them cover most sites. This page is for the case they don't: your CMS, your internal publishing
system, a platform API nobody has wired up yet.

You do not fork the crawler to add a source. You implement one interface and hand it in.

## The interface

```ts
import type { SourceAdapter } from "@naulon/sdk/crawl";

export const myAdapter: SourceAdapter<"my-cms"> = {
  id: "my-cms",
  rank: 50,          // higher wins when several adapters detect the same site
  curated: true,     // this source lists real articles, not every URL on the site

  async detect(ctx) {
    // Cheap probe. Returns false on a normal "no" — never throws.
    const res = await ctx.fetch(new URL("/api/posts?limit=1", ctx.origin).toString());
    return res.ok;
  },

  async discover(ctx) {
    const res = await ctx.fetch(new URL("/api/posts", ctx.origin).toString());
    const posts = (await res.json()) as Array<{ url: string; title: string; byline?: string }>;
    return posts.map((p) => ({
      url: p.url,
      title: p.title,
      authors: p.byline ? [{ name: p.byline }] : [],
    }));
  },
};
```

Then pass it where the built-ins would go:

```ts
import { selectAdapter, ADAPTERS } from "@naulon/sdk/crawl";

const adapter = await selectAdapter(ctx, [myAdapter, ...ADAPTERS], "my-cms");
```

## Four rules, and why each one exists

**Reach the network only through `ctx.fetch`.** That fetcher is bound to the one origin the
publisher proved they own, blocks private-IP targets, and connects to the IP it validated. An
adapter that imports `fetch` itself is a server-side request forgery waiting for a hostile
`<link>` tag.

**Never derive the slug.** Return a URL; the orchestrator derives the credits key from it. The key
must equal what the gate computes for the same URL, and centralising that is the only way it stays
true. This is why `discover` returns candidates rather than finished articles — an adapter cannot
emit a key the gate can't reproduce, because it cannot emit a key at all.

**Never infer money.** An adapter reports the author STRING the source states. Mapping that string
to a wallet is the human's job, through `authorWalletMap` and `defaultWallet`. An unmapped author
is reported to the operator; it is never paid to a guess.

**Say what you need.** If your source needs an API key, or lives at a host other than the
publisher's origin, declare it:

```ts
requires: { secret: true, offOrigin: ["api.example.com"] }
```

A front-door that cannot grant those never runs your adapter — it is filtered out before `detect`,
not trusted to behave. `naulon crawl` grants neither, so a keyed adapter is inert there by
construction; a host that holds publisher credentials can grant both.

## Prove it with the conformance kit

The rules above are executable. Run them:

```ts
import { test } from "node:test";
import { runConformance, assertConformance } from "@naulon/sdk/crawl/testing";
import { myAdapter } from "./my-adapter.ts";

test("my adapter honours the crawl contract", async () => {
  assertConformance(
    await runConformance(myAdapter, {
      origin: "https://site.com",
      routes: { "/api/posts": JSON.stringify([{ url: "https://site.com/articles/one", title: "One" }]) },
    }),
  );
});
```

The kit supplies the network itself, so it measures what your adapter did rather than taking your
word for it: which hosts it touched, whether `detect` survives a dead origin, whether a candidate
ever carried a wallet or a slug. A failing report names every check that failed, not just the first.

It is the same suite the built-in adapters run in this repo's own test run. If your adapter passes
it, it is an adapter — not merely shaped like one.
