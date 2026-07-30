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
- Make it **reachable** and it **requires** `DASHBOARD_AUTH=user:pass` (HTTP Basic).
  Reachable means a wide bind (`DASHBOARD_BIND=0.0.0.0`) *or* a non-loopback name in
  `DASHBOARD_ALLOWED_HOSTS` — which covers a reverse proxy, and covers serverless,
  where nothing binds at all and the loopback default would otherwise read as private
  while the console faces the internet. Reachable, unauthenticated and not public, it
  refuses to serve rather than leak.
- Failed sign-ins are metered per client (`DASHBOARD_AUTH_FAIL_RPM`, default 20/min).
  Only 401s are charged, so heavy legitimate use never locks you out.
- `DASHBOARD_PUBLIC=true` serves only a masked public earnings page.

The gate (`:8402`) is built to face the internet; this console (`:8403`) is not.
Full guide: [docs/operating.md](../../docs/operating.md).

## What's inside

- **`server.ts` / `access.ts`** — the read-only server and the exposure guard.
- **`aggregate.ts` / `observations.ts` / `ops.ts`** — earnings, traffic, health rollups.
- **`config-view.ts` / `content.ts`** — the config-sanity and content panels.

MIT.
