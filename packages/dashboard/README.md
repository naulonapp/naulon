# @naulon/dashboard

The operator console — a read-only window onto a running gate: is it up, who's
being served or blocked, what's settling, and is the config sane.

You don't configure anything here; you watch. It reads the gate's observation log
(`OBSERVATIONS_BACKEND=jsonl`) and event ledger and renders health, live toll
traffic (served free / denied / paid), settlement earnings, and a config-sanity
panel — enough to confirm your proxy is actually working.

## Run

```bash
npm run -w @naulon/dashboard dev      # → http://127.0.0.1:8403
npm run -w @naulon/dashboard seed     # optional: sample data to look at
```

## Exposure — read carefully

The console shows wallets, earnings, and traffic, so its exposure is deliberate:

- Binds `127.0.0.1` by default — private to the box.
- Bind wider (`DASHBOARD_BIND=0.0.0.0`) and it **requires** `DASHBOARD_AUTH=user:pass`
  (HTTP Basic). Wide, unauthenticated, and not public, it refuses to serve rather
  than leak.
- `DASHBOARD_PUBLIC=true` serves only a masked public earnings page.

The gate (`:8402`) is built to face the internet; this console (`:8403`) is not.
Full guide: [docs/operating.md](../../docs/operating.md).

## What's inside

- **`server.ts` / `access.ts`** — the read-only server and the exposure guard.
- **`aggregate.ts` / `observations.ts` / `ops.ts`** — earnings, traffic, health rollups.
- **`config-view.ts` / `content.ts`** — the config-sanity and content panels.

MIT.
