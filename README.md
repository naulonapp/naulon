<div align="center">

# 🜉 &nbsp;naulon

**Humans read free. Machines pay.**

A pay-per-read toll for the agentic web. Drop it in front of any site; AI agents
and crawlers pay a USDC nanopayment to read or cite an article, and it settles
straight to the author.

[![License: MIT](https://img.shields.io/badge/license-MIT-black.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522-black.svg)

</div>

---

People should read for free. But large language models now consume writing at
scale and pay nothing for it — the cost lands on the author, the benefit on the
crawler. `naulon` flips that one exchange: a human request passes straight
through, untouched; a machine request gets an HTTP `402 Payment Required` and has
to settle a tiny USDC payment before it reads. The fare is the *naulon* — the
old coin you paid to cross.

The toll is what keeps the work open: machines subsidize the free human read.

Built on [Circle](https://www.circle.com/)'s nanopayment rail and the
[Arc](https://docs.arc.network/) chain, so a single read can cost a fraction of a
cent and still settle.

## How it works

```mermaid
flowchart TD
    Req([Incoming request]) --> Cls{"agentDetect —<br/>human or machine?"}
    Cls -->|human| Free[["Proxied through, untouched — free read"]]
    Cls -->|machine| Bill["402 Payment Required<br/>price · author wallet(s) · signed nonce"]
    Bill --> Sign["Agent signs a USDC payment,<br/>echoes the nonce, retries with X-Payment"]
    Sign --> Verify{"Verify via Circle Gateway"}
    Verify -->|valid| Serve[["Serve content + mint a Citation License,<br/>record who earned what"]]
    Verify -->|replayed / invalid| Bill

    linkStyle 0 stroke-width:2px
    linkStyle 1 stroke:#3fb950,stroke-width:2px
    linkStyle 2 stroke:#d29922,stroke-width:2px
```

The piece that makes it interesting: **attribution is the payout rule.** An
article's credits graph — who wrote it, and in what proportion — *is* how the
money splits. Co-authored pieces split automatically, and a credit can itself be
a collective that splits again among its members. No invoices, no manual payouts.

The split is recursive: a payee can itself be a collective that divides its cut
again, all the way down. This is the real credits graph from
[`examples/cascade`](./examples/cascade/credits.json) (`how-vaccines-teach`),
resolved by the split algorithm in `@naulon/shared`:

```mermaid
flowchart TD
    Toll["Toll paid — $0.006"]
    Toll -->|weight 3| Desk["the-immunology-desk<br/><i>collective</i> · $0.0045"]
    Toll -->|weight 1| Mira["mira · $0.0015"]
    Desk -->|weight 1| Oko["okonkwo · $0.0015"]
    Desk -->|weight 2| Bench["the-bench-team<br/><i>collective</i> · $0.0030"]
    Bench -->|equal| Pet["petrova · $0.0015"]
    Bench -->|equal| Had["haddad · $0.0015"]
```

Every leaf is a direct author payout, tracked per `(event, author)`, and recorded
whether or not it clears the payout floor yet. The intermediate collectives never
hold the money — they're only a rule for how the cut divides.

## Quick start

Requires Node ≥ 22.

```bash
make install
make demo        # the whole loop offline: origin → toll → agent pays → settle
```

To put a gate in front of your own site, `naulon init` asks a handful of
questions and writes a coherent `.env` plus a starter `credits.json` — no
hand-editing the 180-line example:

```bash
npx naulon init               # → .env + credits.json, then: make dev
```

It runs in mock-settlement mode by default (no wallet or API keys), refuses to
overwrite files you've edited unless you pass `--force`, and takes `--yes` with
flags for a non-interactive/CI run.

Or set it up by hand:

```bash
cp .env.example .env          # runs in mock-settlement mode with no creds
make dev                      # stub origin :3000 + tollgate :8402 + dashboard :8403
make tollgate                 # just the reverse proxy
```

`make help` lists every target. There's a `Dockerfile` + `docker-compose.yml`
too (`make docker-up`) that runs the tollgate and dashboard against a shared
ledger volume.

Watch the toll work (mock settlement — no wallet or API keys needed):

```bash
# a human reads for free → proxied straight through
curl -H 'accept: text/html' -A 'Mozilla/5.0' localhost:8402/essays/on-stillness

# an agent gets a bill
curl -A 'python-requests' localhost:8402/essays/on-stillness
# → 402 { price: 0.001, payees: [{ wallet, share }], nonce, ... }

# a co-authored piece, cited rather than read: 5× the price by default
# (CITATION_MULTIPLIER), split 2:1
curl -A 'python-requests' -H 'x-naulon-kind: citation' localhost:8402/essays/the-naulon
```

The agent then signs a payment, echoes the nonce back in an `X-Payment` header,
and retries — the gate verifies it, serves the article, and records who earned
what.

### The paying agent

The [Wayfarer](./packages/wayfarer) automates that whole loop, and makes a real
budget decision at each step rather than paying for everything:

```bash
npm run tollgate &                                   # in one shell
npm run wayfarer -- "payment and passage"            # in another
```

```text
appraisal:
  · the-naulon: relevance 1.00 — shares 2/2 topic terms (payment, passage)
  · on-stillness: relevance 0.00 — no topic-term overlap
decisions:
  [PAY]  the-naulon — relevance 1.00 @ $0.005 (density 200); $0.095 left
  [SKIP] on-stillness — relevance 0.00 below floor 0.35
  ✓ paid $0.005000 for the-naulon
→ earnings: ava 0.00333 / guest 0.00167   (the 2:1 co-author split, settled)
```

It ranks candidates by relevance-per-dollar, buys greedily under the budget down
to a relevance floor, reuses anything already cached, and logs *why* for each —
the reasoning is the artifact. It runs offline against mock settlement; set
`OPENAI_API_KEY` for LLM appraisal and answer synthesis instead of the keyword
heuristic.

### The operator console

```bash
npm run dashboard                         # http://localhost:8403
```

Your read-only window onto the gate: health, live toll traffic (served free /
denied / paid), settlement earnings, and a config-sanity panel — so you can see
your proxy actually working. It reads the gate's observation log (set
`OBSERVATIONS_BACKEND=jsonl`) and event ledger. Private on `127.0.0.1` by default;
exposing it wider needs `DASHBOARD_AUTH`, and `DASHBOARD_PUBLIC=true` serves only a
masked public earnings page. Full guide: [docs/operating.md](./docs/operating.md).

### Settling payouts

```bash
npm run attribution        # one settlement pass over the ledger
```

Sub-cent tolls aren't worth settling one at a time, so the service accrues each
author's share across many events and only cuts a payout once it clears
`MIN_PAYOUT_USDC` — carrying the rest forward. Settlement is tracked per
`(event, author)`, so a co-author whose small share is still below the floor
keeps accruing while their co-author gets paid; nothing is double-paid or lost.
Mock settlement runs offline; real Circle Gateway batching needs a funded testnet
wallet to exercise live (`PAYMENT_MODE=gateway`).

## Use it with your own site

Nothing here is tied to a particular publisher. You wire up two things:

- **`ORIGIN_URL`** — the site to sit in front of.
- **A credits source** — how an article slug maps to its author wallet(s).
  Point `CREDITS_API_URL` at your CMS (it serves `/credits/:slug`), or ship a
  static `credits.json`. For anything custom, implement the one-method
  `CreditsResolver` interface from `@naulon/shared`.

A complete worked example lives in
[`examples/meridian/`](./examples/meridian) — a fictional essays publisher.
Copy that folder, swap the origin and credits, and you have your own toll.
[`examples/cascade/`](./examples/cascade) is a second adapter for a different
kind of publisher (a different origin, path prefix, and a deeper credits graph),
proving the same core is publisher-agnostic with zero code changed.

For building the publisher side, the kit `@naulon/sdk` packages both
endpoints — the credits resolver and the HMAC-verified settlement receiver — with
drop-in adapters for Next.js (`/next`) and Express (`/express`), and a
`naulon-kit check` CLI that conformance-tests your live `/credits` endpoint against
the contract. Start with the
[integration guide](./docs/integration-guide.md); the two wire contracts are
[credits-api.md](./docs/credits-api.md) and
[settlement-contract.md](./docs/settlement-contract.md), and a runnable consumer is
in [`packages/sdk/examples/next-credits/`](./packages/sdk/examples/next-credits).

## What's here

A small npm-workspaces monorepo. Each piece is independent and runs on its own.

| Package | What it does |
|---|---|
| [`tollgate`](./packages/tollgate) | The x402 reverse proxy: human/agent detection, the `402` challenge, payment verification, and the attributed-event log. |
| [`shared`](./packages/shared) | Domain types, validated config, and the attribution + recursive-split algorithm (unit-tested). |
| [`wayfarer`](./packages/wayfarer) | An autonomous research agent that decides which articles are worth paying to cite under a budget, then pays. |
| [`attribution`](./packages/attribution) | Batches sub-cent tolls per wallet and settles author payouts (mock, or real Circle Gateway via `PAYMENT_MODE`). |
| [`dashboard`](./packages/dashboard) | The operator console — gate health, live toll traffic, earnings, and config sanity (plus an opt-in public earnings page). |

Under those sit three libraries the runnable pieces share:
[`sdk`](./packages/sdk) (the publisher contract + crawl engine),
[`shared`](./packages/shared) (domain types, config, the split algorithm), and
[`enforce`](./packages/enforce) (the runtime-agnostic toll-decision kernel). There's
also [`wayfarer-mcp`](./packages/wayfarer-mcp), which exposes the paying agent as an
MCP server.

**How the packages layer** — arrows point to what a package depends on. The
dependency graph is strictly one-directional; nothing lower reaches up.

```mermaid
flowchart TD
    tollgate["tollgate<br/><i>the gate</i>"]
    wayfarer["wayfarer<br/><i>paying agent</i>"]
    wmcp["wayfarer-mcp<br/><i>MCP server</i>"]
    attribution["attribution<br/><i>settlement</i>"]
    dashboard["dashboard<br/><i>console</i>"]
    enforce["enforce<br/><i>decision kernel</i>"]
    shared["shared<br/><i>contract + split math</i>"]
    sdk["sdk<br/><i>publisher kit + crawl</i>"]

    tollgate --> enforce
    tollgate --> sdk
    tollgate --> shared
    wmcp --> wayfarer
    wayfarer --> shared
    attribution --> shared
    dashboard --> sdk
    dashboard --> shared
    enforce --> shared
    shared --> sdk
```

```
packages/
  sdk/          publisher contract · framework adapters · crawl engine
  shared/       types, config, attribution + split math
  enforce/      runtime-agnostic toll-decision kernel + in-app middleware
  tollgate/     proxy · agentDetect · x402 · pricing · credits · eventLog
  wayfarer/     the paying agent
  wayfarer-mcp/ the paying agent as an MCP server
  attribution/  settlement + payouts
  dashboard/    operator console
examples/
  meridian/     worked example — a fictional publisher adapter
  cascade/      second adapter — proves the core is publisher-agnostic
scripts/        dev stack runner · self-contained demo · wallet generator
Makefile · Dockerfile · docker-compose.yml
```

## Develop

```bash
npm run lint     # typecheck the whole workspace
npm test         # unit tests (attribution splits, dust-free settlement, …)
npm run tollgate # or: wayfarer · attribution · dashboard
```

Everything runs straight from TypeScript via [`tsx`](https://github.com/privatenumber/tsx) —
no build step while developing.

## Going live on Arc

Everything above runs in **mock** settlement so you can develop offline. The real
rail is wired to Circle's Gateway batching SDK (`@circle-fin/x402-batching`) on
Arc — flip `PAYMENT_MODE` to switch:

```bash
make generate-wallets         # a buyer + author wallet; fund the buyer via Circle's Arc faucet
# put PAYMENT_MODE=gateway and BUYER_PRIVATE_KEY in .env
PAYMENT_MODE=gateway make wayfarer TOPIC="payment and passage"
```

- **Seller (tollgate):** `BatchFacilitatorClient.verify` / `.settle` against the
  Arc GatewayWallet (`0x0077777d7EBA…`, network `eip155:5042002`). No seller key
  — Gateway settles the buyer's deposit straight to the author. Custody-free.
- **Buyer (wayfarer):** `GatewayClient.deposit` once, then `.pay()` per citation
  runs the full deposit-backed 402 flow (gasless, batched, <500ms finality).
- **One payment, one `payTo`.** x402 settles to a single address, so the on-chain
  leg pays the article's primary author; the recursive co-author split is the
  attribution layer's job (its onward payouts). The split is always recorded.

```mermaid
sequenceDiagram
    autonumber
    participant A as Agent (wayfarer)
    participant G as Gate (tollgate)
    participant C as Circle Gateway (Arc)
    participant Au as Author wallet

    A->>G: GET /essays/the-naulon
    G-->>A: 402 · price · payTo · nonce · Link: /.well-known/x402
    Note over A: appraise relevance-per-dollar, decide to pay under budget
    A->>C: GatewayClient.pay() — deposit-backed, gasless
    A->>G: retry + X-Payment (signature, nonce)
    G->>C: BatchFacilitatorClient.verify + settle
    C->>Au: USDC settles buyer → author (custody-free)
    G-->>A: 200 · content + Citation License Token
```

The header contract (`PAYMENT-REQUIRED` / `payment-signature` / `PAYMENT-RESPONSE`)
and Arc constants mirror `circlefin/arc-nanopayments`, so a stock Gateway client
pays this gate unmodified. Both modes typecheck against the real SDK; the gateway
path needs a funded testnet wallet to exercise live.

**Self-describing toll.** The gate advertises its own terms so an agent can find
them without being told the endpoint out of band. Every `402` carries a `Link:
</.well-known/x402>; rel="payment"` header, and `GET /.well-known/x402` returns a
machine-readable manifest — article path prefixes, read/citation price, the Arc
network + USDC asset, and the JWKS/verify URLs. It names no author wallet: `payTo`
is resolved per article from the credits graph at payment time.

```bash
curl localhost:8402/.well-known/x402
# → { x402Version, humansReadFree, resources:{pathPrefixes,kinds}, payment:{network,asset,price}, license }
```

## Deploying in front of a live site

`make demo` / `make dev` need nothing — a JSONL ledger and in-process state. To
host the gate + dashboard on a serverless platform (Vercel) in front of a real
site, swap those two pieces of state for **Supabase** (`EVENTS_BACKEND=supabase`,
`NONCE_BACKEND=supabase`) so every instance shares one ledger and nonce set.
Step-by-step (Vercel projects, Supabase schema, DNS): **[DEPLOY.md](./DEPLOY.md)**.

**Self-host or hosted.** Everything in this repo runs standalone — you own the
gate. If you'd rather not run the infrastructure, [naulon.app](https://naulon.app)
operates a managed fleet that speaks the same protocol: you point your site at it
and declare your credits URL exactly as the [integration guide](./docs/integration-guide.md)
shows, then serve the same two endpoints. Same toll, same custody-free settlement —
nothing here is held back to push you toward it.

## Design notes

- **Custody-free.** Payments go agent → author. The toll never pools USDC in a
  wallet we control, which keeps the operator clear of money-transmission rules.
- **Conservative classifier.** Mistaking a human for a machine paywalls a reader
  and breaks the whole promise; mistaking a machine for a human just misses a
  fraction of a cent. So [`agentDetect`](./packages/tollgate/src/agentDetect.ts)
  is tuned to favor humans, and declared intent (an agent that *says* it'll pay)
  is trusted over fragile user-agent sniffing.
- **No secrets in the repo.** Credentials live in `.env` (gitignored); only
  `.env.example` ships.

## Hardening

The gate is built to sit on the public internet in front of a real site:

- **Replay-proof payments.** Every `402` carries a fresh, HMAC-signed nonce bound
  to the price + payee; the agent echoes it in its payment and the gate spends it
  exactly once ([`nonce.ts`](./packages/tollgate/src/nonce.ts)). A captured
  `payment-signature` can't be replayed for a free read, and a cheap nonce can't
  be swapped onto a pricier resource. Mandatory in mock mode; live, Circle's
  deposit-backed settlement is the chain-level guarantor.
- **Rate limiting.** A per-client token bucket
  ([`rateLimit.ts`](./packages/tollgate/src/rateLimit.ts)) caps request floods.
  Client identity is the socket peer IP; `X-Forwarded-For` is trusted only when
  `TRUST_PROXY=true` (set it iff you run behind a proxy you control).
- **Header hygiene.** The proxy strips hop-by-hop and internal `x-naulon-*` /
  payment headers before forwarding upstream, and re-derives `X-Forwarded-*` /
  `Host` itself so a client can't spoof its origin IP or host to the backend.
- **Validated trust boundary.** Credits (which decide *who gets paid*) are parsed
  through a strict schema before any wallet becomes a `payTo` — a malformed or
  hostile credits source is rejected, not settled
  ([`shared/credits.ts`](./packages/shared/src/credits.ts)).
- **Dashboard exposure.** The operator console is read-only but shows wallets,
  earnings, and traffic, so exposure is deliberate. It binds `127.0.0.1` by default
  (private). Bind wider (`DASHBOARD_BIND=0.0.0.0`) and it **requires**
  `DASHBOARD_AUTH=user:pass` (HTTP Basic) — wide with no auth and not public, it
  refuses to serve rather than leak. `DASHBOARD_PUBLIC=true` serves only a masked
  earnings page. The gate (`:8402`) is built to face the internet; the console
  (`:8403`) is not. See [docs/operating.md](./docs/operating.md).

Hardening knobs (all optional — safe defaults shown), add to `.env`:

```bash
TOLLGATE_SECRET=          # HMAC secret for 402 nonces; ephemeral if unset (set for multi-instance)
NONCE_TTL_SECONDS=300     # how long a 402 nonce stays valid (also the replay window)
RATE_LIMIT_RPM=120        # sustained per-client requests/min; 0 disables
RATE_LIMIT_BURST=40       # short-burst allowance before 429
TRUST_PROXY=false         # trust X-Forwarded-For for client IP (only behind your own proxy)
DASHBOARD_BIND=127.0.0.1  # dashboard interface; localhost-only by default (set 0.0.0.0 only behind your own auth)
PRIMARY_PAYEE_TIEBREAK=wallet  # on-chain recipient on a top-share tie: by address (order-independent) or "input"
```

> Nonce + rate-limit state is in-process. For a multi-instance deployment, set a
> shared `TOLLGATE_SECRET` and back both with a shared store (e.g. Redis).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, conventions, and PR rules.

## License

[MIT](./LICENSE).

---

<sub>Built during the Lepton Agents hackathon (Canteen × Circle, on Arc) — kept
general so anyone can run it.</sub>
