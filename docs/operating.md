# Operating your gate — the dashboard

You run `naulon` as a reverse proxy in front of your site. Humans pass through
free; machines pay to read or cite. The **operator console** is how you see that
happening: is the gate up, who's being served or blocked, what's settling, and is
your config right. It's read-only — you don't configure anything here, you watch.

Start it alongside the gate:

```
npm run -w @naulon/dashboard dev      # → http://127.0.0.1:8403
```

By default it binds `127.0.0.1`, so only the box owner sees it. That's the private
ops console. Point a browser at it and you get five things.

## What each panel tells you

**Health** (top right). A ping to the gate's `/healthz`. Green "gate up" means the
proxy is answering. "gate down" means the console can reach itself but not the gate
— check the gate process and `GATE_URL`.

**The tiles.** Traffic over the last 24h, straight from the gate's observation log:

- **served free** — humans and allow-listed crawlers, passed through untolled.
- **denied** — agents that got a 402 and walked away. This is scraping you stopped.
- **paid** — agents that settled and were served.
- **payment failed** — an agent presented payment that failed verify/settle. A few
  is normal (a bad signer); a spike is worth investigating.
- **earned · missed** — USDC you captured, and the price of everything `denied`
  (what you'd have earned if they'd paid). Missed climbing means demand you're not
  converting yet.

**Recent requests.** The live feed — one row per gated request: when, the slug, who
(a verified agent shows its operator, e.g. `✓ chatgpt.com`; an unsigned one shows
its user-agent; a forged signature shows `spoofed signature`), and the verdict,
colour-coded. This is where you watch the toll work in real time.

**Config.** The effective config the gate loaded, so you can confirm it's right:
your origin, the price, the credits source, how many articles are tollable and the
wallets they pay, and whether the observation + event logs are on. If something's
off here, your gate isn't doing what you think.

**Warnings.** Misconfig that quietly under-performs — the commonest being the
observation log switched off, which leaves the traffic panel blank.

## Where articles, wallets, and prices come from

Not the dashboard — that would defeat the point (the gate never holds your keys or
your content). You declare them in your **credits source**, and the console just
reflects what loaded:

- A static `credits.json` (see `examples/meridian/credits.json`): a map of
  `slug → { title, contributors: [{ authorId, wallet, weight }] }`. Point
  `CREDITS_FIXTURES` at it. `weight` splits a toll across co-authors.
- Or a live endpoint — set `CREDITS_API_URL` to your CMS serving `/credits/:slug`.
  The article list is then dynamic and won't enumerate in the console.

Price is `DEFAULT_PRICE_USDC` per read, times `CITATION_MULTIPLIER` for a citation.
Credits are validated when loaded — a malformed source is rejected, never settled.

`npx naulon init` scaffolds a starter `.env` + `credits.json` if you're starting
from scratch.

## Managing credits without the CLI — the Content tab

You don't hand-write `credits.json`. The console's **Content** tab does it in the
browser, over the same crawl + validation engine as `naulon-kit crawl` (one
engine, two front-doors — they can't drift):

1. **Scan site** reads your sitemap/RSS/WordPress and lists your articles.
2. Fill in the **payout wallet** per article — the one thing no crawler can
   supply, since only you know who gets paid. An article with >1 payee (a split)
   shows read-only and is preserved verbatim; edit those in the file.
3. **Save** validates every wallet and writes `credits.json` (backing up the old
   to `credits.json.bak`). One bad wallet rejects the whole save — a typo can't
   half-write a payout map.

Two things to know: edits apply on the **next gate restart** (the file is read at
boot), and this manager is a **write surface**, so it's served only in the private
or authed modes — never in public mode, and cross-origin writes are refused. If
your credits come from a live API (`CREDITS_API_URL`), edit them at your CMS; the
tab tells you so.

## Turning the traffic panel on

The gate records nothing by default. To populate the tiles and the request feed:

```
OBSERVATIONS_BACKEND=jsonl            # writes to data/observations.jsonl
```

Observations are telemetry only — they never gate a request or move money. The
console reads that file; the earnings tiles and the ledger read the event log
(`EVENTS_BACKEND`, on by default).

## Exposing it safely

The console shows wallets, earnings, and traffic. It must not face the open
internet by accident, so exposure is deliberate:

| You want | Set | Result |
|---|---|---|
| **Private** (default) | `DASHBOARD_BIND=127.0.0.1` | Full ops, box owner only. |
| **Remote ops** | `DASHBOARD_BIND=0.0.0.0` + `DASHBOARD_AUTH=user:pass` | Full ops behind HTTP Basic. |
| **Public proof** | `DASHBOARD_PUBLIC=true` | Only the earnings page — wallets masked, every ops panel hidden. |

Bind wider than loopback with neither auth nor public set and the dashboard
**refuses to serve** — it won't leak wallets because you fat-fingered a bind. For
real exposure, HTTP Basic is the floor; put it behind your own reverse proxy
(Caddy, nginx) or an access gateway if you want more.

The public page (`DASHBOARD_PUBLIC=true`, or `/ledger` from the ops console) is the
shareable "authors are earning" view — the same live ledger with addresses
truncated and nothing operational on it.
