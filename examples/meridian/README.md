# First example: Meridian

A worked example of pointing `naulon` at a publisher — Meridian, a (fictional)
essays publication. Use it as a template for your own deployment.

> The wallets and authors are invented; `meridian.example` is a reserved
> non-routable domain (RFC 2606). This is a fixture, not a live deployment.

A publisher integration is just two things:

1. **An origin** — the site the tollgate proxies (`ORIGIN_URL`).
2. **A credits source** — how a slug maps to author wallet(s). Either a static
   JSON file (`credits.json` here) or a live API (`CREDITS_API_URL`).

## Run it

```bash
# from the repo root
cat examples/meridian/.env.example >> .env   # or copy the values in
npm run tollgate
```

Then:

```bash
# human reads free
curl -H 'accept: text/html' -A 'Mozilla/5.0' localhost:8402/essays/on-stillness

# agent must pay
curl -A 'python-requests' localhost:8402/essays/on-stillness        # 402 + requirement

# co-authored, cited: 5x price by default (CITATION_MULTIPLIER), recursively split 2:1
curl -A 'python-requests' -H 'x-naulon-kind: citation' localhost:8402/essays/the-naulon
```

## The credits graph

[`credits.json`](./credits.json) shows all three shapes the splitter handles:

| slug | shape |
|---|---|
| `on-stillness` | single author → 100% |
| `the-naulon` | weighted co-authors → 2:1 split |
| `the-river-and-the-name` | a **composite** (`the-meridian-desk`) that recursively re-splits among its members |

To resolve credits from a live backend instead, set `CREDITS_API_URL` and have
that endpoint return the same `ArticleCredits` shape from
`/credits/:slug`. See `packages/tollgate/src/credits.ts`.

## Building your own adapter

Copy this folder, swap the origin and credits, done. If your CMS can't serve the
credits shape directly, implement the `CreditsResolver` interface
(`@naulon/shared`) and pass it into the tollgate.
