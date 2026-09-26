# @naulon/sdk

The publisher SDK for the naulon citation toll: the credits contract, the
settlement wire types, and the helpers a site uses to get tolled.

This is the money-routing trust boundary in one place: `ArticleCredits` (what a
page is worth and who gets paid), the validators that keep a credits response
honest, the HMAC sign/verify used on the settlement path, and the credits
resolvers the gate calls. It also ships the crawl engine behind the `naulon` /
`naulon-kit` CLI, which discovers a site's tollable articles from its RSS or sitemap,
a reader for the RSL 1.0 usage-licensing standard, and framework adapters for
exposing a credits route and receiving settlement.

## Install

```bash
npm install @naulon/sdk
```

## Entry points

- `@naulon/sdk`: the contract types, validators, crypto (sign and verify), credits
  resolvers, and the crawl engine.
- `@naulon/sdk/next` · `@naulon/sdk/express`: credits-route and webhook-receiver
  adapters for those frameworks (both optional peer deps).
- `@naulon/sdk/cli`: the `naulon` and `naulon-kit` command entry.
- `@naulon/sdk/rsl`: a reader for RSL 1.0, the open content-licensing standard a
  publisher's site can declare. `parseRsl` reads the document, `termsForUrl` resolves
  what it says about one URL (usage, user class, region, price), and `licenceFor`
  locates and fetches a site's licence from a URL alone.
- `@naulon/sdk/slug`: the one article-key rule, zero dependencies. The gate, the
  crawl engine and a publisher's own credits endpoint all derive the same slug from
  a URL through this, so the three never disagree.
- `@naulon/sdk/net`: the SSRF guard every outbound fetch in this package goes
  through: private/loopback/link-local ranges blocked, DNS rebinding closed by
  validating the resolved IP before connecting.
- `@naulon/sdk/crawl` · `@naulon/sdk/crawl/testing`: the adapter interface behind
  `naulon crawl` (WordPress, RSS/Atom, sitemap) and the conformance kit for writing
  your own. See [crawl-adapters.md](https://github.com/naulonapp/naulon/blob/main/docs/crawl-adapters.md).

## What it is not

For in-app enforcement, meaning the 402-at-the-edge middleware a site drops into its
request pipeline, use [`@naulon/enforce`](https://www.npmjs.com/package/@naulon/enforce).
The gate shell (`@naulon/tollgate`) is not published to npm; it ships as a
container image.

MIT.
