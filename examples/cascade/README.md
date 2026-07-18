# Second example: Cascade

A second worked adapter, for a publisher **unlike** the reference one — Cascade,
a (fictional) science-explainers publication. Same core, zero code changed: a
different origin, a different article path prefix (`explainers`, not `essays`),
and a deeper credits graph. If it works here unmodified, the toll is genuinely
publisher-agnostic — that's the whole point of this folder.

> The wallets and authors are invented; `cascade.example` is a reserved
> non-routable domain (RFC 2606). This is a fixture, not a live deployment.

## Run it

```bash
# from the repo root
cat examples/cascade/.env.example >> .env   # or copy the values in
npm run tollgate
```

Then:

```bash
# human reads free
curl -H 'accept: text/html' -A 'Mozilla/5.0' localhost:8402/explainers/why-the-sky-goes-dark

# agent must pay
curl -A 'python-requests' localhost:8402/explainers/why-the-sky-goes-dark        # 402 + requirement

# deeply co-authored, cited: 5x price by default (CITATION_MULTIPLIER), split across the nested credits graph
curl -A 'python-requests' -H 'x-naulon-kind: citation' localhost:8402/explainers/how-vaccines-teach
```

## The credits graph

[`credits.json`](./credits.json) pushes the recursive splitter one level deeper
than the Meridian example. Shares below are the real output of
`resolvePayees()` (`@naulon/shared`):

| slug | shape | resulting split |
|---|---|---|
| `why-the-sky-goes-dark` | single author → 100% | mira 100% |
| `the-half-life-of-facts` | weighted 3-way (5:3:2) | mira 50% · okonkwo 30% · petrova 20% |
| `how-vaccines-teach` | **2-level nested composite** | okonkwo 25% · petrova 25% · haddad 25% · mira 25% |

`how-vaccines-teach` is the interesting one. Its top level is
`the-immunology-desk` (weight 3) and `mira` (weight 1) → 75% / 25%. The desk
itself re-splits between `okonkwo` and a **sub-composite** `the-bench-team`
(1:2 → 1/3 and 2/3 of the desk's 75%, i.e. 25% / 50% overall), and the bench
team re-splits *again*
between `petrova` and `haddad` (50/50). Three levels of normalization collapse
to a clean 25% each — across different graph depths — and the shares still sum
to exactly 1. That recursion is the attribution layer's job; the x402 on-chain
leg still pays a single primary author, with the full split recorded on the
event (see "One payment, one `payTo`" under "Going live on Arc" in the root README).

## Building your own adapter

Same recipe as the Meridian example: copy this folder, swap `ORIGIN_URL`, the
path prefix, and the credits. If your CMS can't serve the `ArticleCredits` shape
from `/credits/:slug`, implement the `CreditsResolver` interface
(`@naulon/shared`) and pass it into the tollgate — the gate doesn't change.
