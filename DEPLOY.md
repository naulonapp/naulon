# Deploying naulon

This is the click-by-click for putting the toll in front of a live site, hosted
on **Vercel** with **Supabase** for state. It's publisher-agnostic; the worked
example is Meridian (`meridian.example`) — a fictional publisher used across the
examples.

> **Local / a single box?** You don't need any of this. `make demo` runs the
> whole loop offline, and `make dev` (or the `docker-compose.yml`) runs the gate
> + dashboard against the default JSONL ledger with no creds. Reach for this doc
> only when you want it on a serverless host where there's no shared disk.

---

## The shape

Two small services and one database, wired to the live site by DNS only — no code
coupling to the publisher (the gate talks to it purely over HTTP):

```
   agent  ──▶  naulon.<site>     (Vercel project A — the tollgate)
                  │  402 → pay USDC on Arc → settles to the author
                  │  on success, proxies upstream to:
                  ▼
               <site>            (the publisher's own site, untouched)

   author ──▶  dash.<site>       (Vercel project B — the earnings dashboard)
                  ▲
                  └─ both read/write one ledger in:
               Supabase          (naulon_events + naulon_nonces + naulon_revocations)
```

Humans keep hitting `<site>` directly — free, untouched. Only traffic pointed at
`naulon.<site>` meets the gate. Flip to a full edge later by moving the apex DNS;
no code changes.

### Why a database at all

Vercel runs your function as many short-lived instances with no shared disk, so
the JSONL ledger and the in-process nonce set (replay protection) can't live
locally. Both sit behind interfaces (`EventSink`, `ConsumedStore`) with a Supabase
implementation; you turn them on with two env vars. See `shared/src/eventsink.ts`
and `tollgate/src/nonce.ts`.

---

## 0. Prerequisites

- A **Vercel account** (Hobby/free is fine for the demo — see the ToS note at the
  end).
- A **Supabase account** (free tier; 500 MB is plenty).
- Access to the **DNS** for the site's domain (to add one subdomain record).
- For real settlement: a funded **Arc-testnet** wallet (`PAYMENT_MODE=gateway`).
  To demo the loop without a chain, use `PAYMENT_MODE=mock` — it still settles,
  records, and lights up the dashboard.

---

## 1. Supabase — create the project + schema

1. Supabase → **New project**. Pick a region near your users. Save the DB password.
2. Open **SQL Editor**, paste `supabase/migrations/0001_naulon.sql`, run it. You
   now have `naulon_events`, `naulon_nonces`, and `naulon_revocations` (the last is
   consulted only when the online license-check tier is on, `LICENSE_ONLINE_CHECK=true`).
   - Or, with the Supabase CLI from the repo root: `supabase db push`.
3. **Project Settings → API**, copy two values:
   - **Project URL** → `SUPABASE_URL` (e.g. `https://abcd.supabase.co`)
   - **service_role** key → `SUPABASE_SERVICE_KEY` *(secret — server-side only,
     never the anon key, never committed)*

---

## 2. Vercel project A — the tollgate

1. Vercel → **Add New… → Project**, import this repo.
2. **Root Directory:** `packages/tollgate`. Vercel detects the npm workspace and
   installs from the repo root; if it complains, enable *Include files outside the
   Root Directory* and set the Install Command to `npm install` at the repo root.
3. **Build & Output:** there's no build step (it runs from TS). Framework Preset
   = **Other**; the committed `vercel.json` routes every path to the function.
4. **Environment Variables** (Production):

   | Key | Value | Notes |
   |---|---|---|
   | `EVENTS_BACKEND` | `supabase` | |
   | `NONCE_BACKEND` | `supabase` | shared replay protection across instances |
   | `SUPABASE_URL` | from step 1 | |
   | `SUPABASE_SERVICE_KEY` | from step 1 | secret |
   | `TOLLGATE_SECRET` | a random 32+ byte hex string | **required** multi-instance, so every instance signs nonces alike |
   | `TRUST_PROXY` | `true` | you're behind Vercel's edge; lets rate-limit see the real client IP |
   | `ORIGIN_URL` | `https://<site>` | the site the gate proxies to |
   | `ARTICLE_PATH_PREFIXES` | e.g. `essays` | which URL prefixes are gateable; match the site |
   | `DEFAULT_PRICE_USDC` | e.g. `0.001` | per machine read |
   | `CITATION_MULTIPLIER` | e.g. `5` | a citation costs this × a read (default 5; 1 = same) |
   | `PAYMENT_MODE` | `mock` or `gateway` | start `mock` to prove the path, switch to `gateway` once a wallet is funded |
   | `CREDITS_API_URL` *or* `CREDITS_FIXTURES` | author resolution | how slugs map to wallets — see `examples/meridian` |
   | `LICENSE_SIGNING_KEY` | an Ed25519 PKCS8 PEM | **secret; required** once `PAYMENT_MODE=gateway` *or* any `*_BACKEND=supabase` — an ephemeral key breaks license verification across instances. Generate: `node -e "const{generateKeyPairSync}=require('crypto');console.log(generateKeyPairSync('ed25519',{privateKeyEncoding:{type:'pkcs8',format:'pem'}}).privateKey)"` |
   | `CREDITS_SETTLEMENT_SECRET` | shared HMAC string | **secret**; must match the publisher's settlement-receiver value, so it can verify the signed earnings POST. Leave blank → earnings emit is dark (the gate still tolls + serves) |
   | `RELAYER_PRIVATE_KEY` | an EOA private key | **secret**; only when `SETTLEMENT_NETWORK` is a memo-capable chain (Arc) — the EOA that pays gas to self-relay the buyer's transfer through the Memo contract. It pays gas but never touches the funds (custody-free holds). Leave blank on Base |

   Add the Arc/Circle vars (`CIRCLE_API_KEY`, `GATEWAY_API_URL`, …) only when you
   move `PAYMENT_MODE=gateway`; the testnet facilitator needs no key.
5. **Deploy.** Smoke-test the health route: `curl https://<deployment>/healthz`
   → `{"ok":true,"service":"tollgate"}`.

## 3. Vercel project B — the dashboard

Same import, **Root Directory:** `packages/dashboard`. Env vars are just the read
side of the ledger:

| Key | Value |
|---|---|
| `EVENTS_BACKEND` | `supabase` |
| `SUPABASE_URL` | same project as the gate |
| `SUPABASE_SERVICE_KEY` | same |

Deploy. The page streams live from the same Supabase the gate writes to.

---

## 4. DNS — point the subdomains at the projects

In each Vercel project: **Settings → Domains → Add**.

- Project A → `naulon.<site>`
- Project B → `dash.<site>`

Vercel shows a **CNAME target** for each. Add those CNAME records wherever the
domain's DNS is managed. The apex (`<site>` — real readers) is left alone.

---

## 5. Verify the loop

```bash
# A browser-ish request is a human → 200, free, no payment headers.
curl -s -o /dev/null -w "%{http_code}\n" https://naulon.<site>/essays/<slug>

# An agent-ish request with no payment → 402 with a PAYMENT-REQUIRED challenge.
curl -s -D - -o /dev/null -A "node-fetch" https://naulon.<site>/essays/<slug>
```

Then run the wayfarer against `TOLLGATE_URL=https://naulon.<site>` and watch a row
land on `dash.<site>`. (See the README "Going live on Arc" for the gateway-mode
wallet/faucet steps.)

---

## Notes & caveats

- **Hobby ToS.** Vercel Hobby is non-commercial. Moving real USDC is arguably
  commercial — fine for a hackathon demo, but move to Pro (or the Fly/VPS path
  below) for anything ongoing.
- **Serverless gotchas.** The two spots most likely to need a tweak on Vercel are
  the `.ts`-extension imports and the npm-workspace install — check those first if
  the build fights the monorepo.
- **`getConnInfo` on Vercel.** Client IP comes from the platform, not a raw
  socket; `TRUST_PROXY=true` is what makes per-client rate limiting meaningful
  there.
- **Tested fallback host.** If the Vercel build fights the monorepo, the
  `docker-compose.yml` runs the same two services on **Fly.io** or any small VPS
  with a persistent volume — there you can keep `EVENTS_BACKEND=jsonl` and a single
  instance, or still point at Supabase. Same app, fewer moving parts.
