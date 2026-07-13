# @naulon/sdk

The publisher SDK for the naulon citation toll — the credits contract, the
settlement wire types, and the helpers a site uses to get tolled.

This is the money-routing trust boundary in one place: `ArticleCredits` (what a
page is worth and who gets paid), the validators that keep a credits response
honest, the HMAC sign/verify used on the settlement path, and the credits
resolvers the gate calls. It also ships the crawl engine behind the `naulon` /
`naulon-kit` CLI — discover a site's tollable articles from its RSS or sitemap —
and framework adapters for exposing a credits route and receiving settlement.

## Install

```bash
npm install @naulon/sdk
```

## Entry points

- `@naulon/sdk` — the contract types, validators, crypto (sign/verify), credits
  resolvers, and the crawl engine.
- `@naulon/sdk/next` · `@naulon/sdk/express` — credits-route + settlement-receiver
  adapters for those frameworks (both optional peer deps).
- `@naulon/sdk/cli` — the `naulon` / `naulon-kit` command entry.

## What it is not

For in-app enforcement — the 402-at-the-edge middleware a site drops into its
request pipeline — use [`@naulon/enforce`](https://www.npmjs.com/package/@naulon/enforce).
The gate shell (`@naulon/tollgate`) is not published to npm; it ships as a
container image.

MIT.
