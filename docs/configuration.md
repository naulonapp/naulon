# Configuration

Every environment variable the gate, the dashboard and the buying agent read, what
each one does, and what happens if you leave it alone. The schema in
[`packages/shared/src/config.ts`](https://github.com/naulonapp/naulon/blob/main/packages/shared/src/config.ts)
is the source of truth; this page is the prose version of it, and a test fails the
build if the two stop agreeing.

## How config is loaded

`.env` is read from the **repo root**, not the current directory. npm workspaces run
each package's scripts with the cwd set to that package, so a cwd-relative lookup
would miss the root file and fall back to defaults — mock payments, an ephemeral
signing key — without saying anything. The root is found by walking up until a
`package-lock.json` appears.

Everything is validated with zod at first `getConfig()`, and an invalid value throws
before the process serves a request. The point is to fail at boot, not mid-payment.
Tests run with `NODE_ENV=test` and deliberately do **not** load your `.env`, so a
local `PAYMENT_MODE=gateway` never leaks into a test run.

**Secrets never get a default.** If a value is a key, a password, or an HMAC secret,
it is optional in the schema and the feature that needs it stays dark until you set
it. That is what lets the whole demo loop run with no credentials at all.

A few rules are enforced across variables rather than on one of them:

- Any `*_BACKEND` set to `supabase` requires `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`.
- `LICENSE_SIGNING_KEY` is required once licensing is on **and** either payments are
  real or any Supabase backend is in play — an ephemeral key can't be verified by
  another instance.
- `LICENSE_TTL_SECONDS` may not exceed 3600, and `LICENSE_POP_WINDOW_SECONDS` may not
  exceed 600. Both are replay windows; the cap is the point.
- `X402_MAX_TIMEOUT_SECONDS` may not go below 604900. See the note in the payment
  table.

## Payments and the settlement rail

| Variable | Default | What it does |
|---|---|---|
| `PAYMENT_MODE` | `mock` | `mock` settles offline with no credentials. `gateway` uses the real Circle Gateway batching SDK and needs a funded `BUYER_PRIVATE_KEY`. |
| `SETTLEMENT_NETWORK` | `arcTestnet` | Which chain the gate tolls on: `arcTestnet`, `baseSepolia`, or `base`. One switch selects the whole rail — quote, settlement body, discovery manifest, buyer client, and testnet-vs-mainnet facilitator. The default is testnet so a misconfigured deploy can never settle real money by accident. |
| `CIRCLE_API_KEY` | unset | Circle facilitator bearer for a **mainnet** leg. |
| `CIRCLE_API_KEY_TESTNET` | unset | Circle issues one test and one live key per account, split by environment rather than chain. Set this and one process can serve both; unset, a testnet leg falls back to `CIRCLE_API_KEY` (and the testnet facilitator works with no key at all). |
| `GATEWAY_API_URL` | unset | Overrides the facilitator endpoint. |
| `ARC_RPC_URL` | unset | Arc **mainnet** has no public RPC during the private preview, so a settle on `arc` requires this. It fails at settle time rather than boot, so testnet deploys never need it. |
| `RELAYER_PRIVATE_KEY` | unset | The EOA that signs the outer transaction and pays gas on the Arc self-relay path. It never touches the transferred funds — the money moves buyer → author under the buyer's own EIP-3009 authorization — so custody-free still holds. Only needed with `PAYMENT_MODE=gateway` on a network that ships the Memo predeploy. |
| `RELAYER_PRIVATE_KEY_MAINNET` | unset | The same role on Arc mainnet, with **no fallback** to the testnet key. Mainnet gas is real money, so an Arc-mainnet memo settle without this fails loudly. |
| `USDC_EIP712_NAME` | unset | Override the USDC EIP-712 domain name if it is ever not `USD Coin`. Confirm against the on-chain `name()` before a real settle. |
| `X402_MAX_TIMEOUT_SECONDS` | `691200` (8 days) | The validity window advertised in the 402 quote. Circle's facilitator rejects `verify` unless at least 7 days of validity remain, so anything under 604900 (the floor plus the SDK's buffer) makes a non-SDK buyer that trusts your advertised number fail with `authorization_validity_too_short`. The schema refuses to go below it. |

## The gate

| Variable | Default | What it does |
|---|---|---|
| `TOLLGATE_PORT` | `8402` | Port the gate listens on. |
| `ORIGIN_URL` | `http://localhost:3000` | The site the gate sits in front of. |
| `DEFAULT_PRICE_USDC` | `0.001` | Price of a single read when the credits response doesn't name one. |
| `CITATION_MULTIPLIER` | `5` | A citation costs this multiple of a read, because a citation has downstream reach — it grounds an answer many people will see. Both resolve to the same payees; only the price differs. `1` prices a citation like a read. |
| `ARTICLE_PATH_PREFIXES` | `essays,articles,posts` | Comma-separated path prefixes that count as gateable articles. |
| `CREDITS_API_URL` | unset | When set, the gate asks `${url}/credits/:slug` who wrote an article. See [credits-api.md](./credits-api.md). |
| `CREDITS_API_TOKEN` | unset | Bearer token sent with that request, if your endpoint is not public. |
| `CREDITS_FIXTURES` | `examples/meridian/credits.json` | Local JSON credits file used when `CREDITS_API_URL` is unset. |
| `CRAWLER_POLICY_PATH` | `data/crawler-policy.json` | Per-crawler allow / charge / block policy. Absent or unreadable means classifier defaults, which is what every deploy has today. See [crawler-policy.md](./crawler-policy.md). |

## Hardening

| Variable | Default | What it does |
|---|---|---|
| `TOLLGATE_SECRET` | unset | HMAC secret signing 402 payment nonces. Unset mints an ephemeral one at boot — fine for a single instance, wrong for several, and it invalidates outstanding nonces on restart. |
| `NONCE_TTL_SECONDS` | `300` | How long an issued 402 nonce stays valid. This is also the replay window. |
| `RATE_LIMIT_RPM` | `120` | Sustained per-client request ceiling. `0` disables rate limiting. |
| `RATE_LIMIT_BURST` | `40` | Short bursts absorbed above the sustained rate. |
| `RATE_LIMIT_MAX_BUCKETS` | `50000` | Ceiling on live per-client buckets, shared by the request limiter and the console's failed-sign-in budget. Keying per client is what makes a limiter fair, and it's also what makes its key space as large as the caller's address space: a host with a routed IPv6 /64 can spend a fresh address per request. At the default, 50k buckets is single-digit MB. Too high costs memory; too low costs accuracy, because a live client can be evicted early and start again with a full allowance. |
| `TRUST_PROXY` | `false` | Trust the `X-Forwarded-*` trail. Turn it **on** whenever anything sits in front of the gate; it governs two separate things. **The client IP** (`X-Forwarded-For`) — with it off, every request keys to the proxy's address, the whole deployment shares one bucket, and a single caller can 429 everyone. **The public scheme** (`X-Forwarded-Proto`) — TLS normally terminates at the edge, so the gate's own socket sees `http`. That scheme is published in the 402's signed `resource.url`, and it is signed over as Web-Bot-Auth's `@target-uri`: leave this off behind TLS and every quote advertises `http://`, while an agent whose signature covers `@target-uri` fails verification and is silently treated as unverified. Both trails are read from the right, so a client-forged entry is ignored; the proxy still has to be one you control. |
| `TRUST_PROXY_HOPS` | `1` | How many trusted hops sit in front, counted outward. `1` is a single reverse proxy or one serverless edge; `2` is a CDN in front of that proxy. Only read when `TRUST_PROXY=true`. Adding a hop is an env change, never a code change. |
| `BOT_AUTH_SIGNING_KEY` | unset | Base64url 32-byte Ed25519 seed (`scripts/wba-keygen.mjs`). When set, the gate serves and self-signs its Web Bot Auth key directory at `/.well-known/http-message-signatures-directory`, and the buying agent signs its outbound requests. Unset, both surfaces are dark and the traffic is byte-identical. |
| `BOT_AUTH_SIGNATURE_AGENT` | unset | The directory host the agent advertises in `Signature-Agent`. It has to actually serve your directory. |
| `BOT_AUTH_ALLOW_HTTP` | `false` | Allow `http://` and loopback key directories so a local signer fixture can serve one. Test walks only — the directory URL is attacker-supplied, so never enable this in production. |

## Reporting earnings to the publisher (webhooks)

The gate tells you a payment landed with a signed `settlement.completed` webhook.
Contract: [settlement-notifications.md](./settlement-notifications.md).

<!-- naulon-docs: deleted-names CREDITS_SETTLEMENT_SECRET -->

There used to be a second wire here — a signed POST to
`${ORIGIN_URL}/api/credits/settlement`, tuned by eleven `SETTLEMENT_*` variables. It
is **deleted**, along with `CREDITS_SETTLEMENT_SECRET`. If your `.env` still sets any
of them, they are ignored; the webhook below is the only notification path.

| Variable | Default | What it does |
|---|---|---|
| `NAULON_WEBHOOK_ENDPOINTS` | unset | JSON array of `{ url, secret, events?, hostFilter? }`. Unset, the webhook plane is entirely dark — no store, no sweep, no POST. It is kept as a raw string here so a bad value fails with a field-specific message instead of a wall of zod. |
| `WEBHOOK_SWEEP_INTERVAL_MS` | `30000` | How often due deliveries are sent. `0` disables the loop — the right setting on serverless, where a cron drives the sweep instead. |
| `WEBHOOK_DELIVERIES_PATH` | `data/webhook-deliveries.jsonl` | Where deliveries live. A journal rather than process memory, because a gate restart used to drop every unsent delivery and because the dashboard is a separate process that can only see gate state through a file. |

## Storage backends

The open core stores nothing by default. Each plane can move to Supabase
independently — same seam, different backend — which is what makes a serverless or
multi-instance deploy possible.

| Variable | Default | What it does |
|---|---|---|
| `EVENTS_BACKEND` | `jsonl` | Where attributed events go. `jsonl` is an append-only local file; `supabase` is a Postgres table over the REST API, for hosts with no shared disk. |
| `NONCE_BACKEND` | `memory` | Where spent 402 nonces are remembered for replay protection. `memory` is correct for one instance; `supabase` holds replay protection across many. |
| `PENDING_LEGS_BACKEND` | `memory` | Where buyer-authorized extra settlement legs wait for their deferred on-chain settle. `supabase` makes them survive a restart and settle exactly once across instances. |
| `OBSERVATIONS_BACKEND` | `off` | The audit plane: who was served free, denied, or charged. `off` records nothing, which keeps the open core's zero-overhead posture. `jsonl` for dev, `supabase` for an audit UI. Separate from `EVENTS_BACKEND` on purpose — observations are higher-volume and lower-value. |
| `SUPABASE_URL` | unset | Required as soon as any backend above is `supabase`. |
| `SUPABASE_SERVICE_KEY` | unset | Same. It is a secret — keep it in `.env`, never in the repo. |
| `SUPABASE_EVENTS_TABLE` | `naulon_events` | Table override. |
| `SUPABASE_NONCES_TABLE` | `naulon_nonces` | Table override. |
| `SUPABASE_PENDING_LEGS_TABLE` | `naulon_pending_legs` | Table override. |
| `SUPABASE_REVOCATIONS_TABLE` | `naulon_revocations` | Table override, used by the online license check. |
| `SUPABASE_OBSERVATIONS_TABLE` | `naulon_observations` | Table override. |
| `EVENTS_PATH` | `data/events.jsonl` | Shared event ledger for the `jsonl` backend. The gate appends; the dashboard and attribution read. |
| `OBSERVATIONS_PATH` | `data/observations.jsonl` | Observation ledger for the `jsonl` backend. |
| `PAYOUTS_PATH` | `data/payouts.jsonl` | Where attribution records payouts. |

## Citation licenses

A signed receipt handed to a paying agent, which buys it a free re-read inside the
TTL. Full spec: [citation-license.md](./citation-license.md).

| Variable | Default | What it does |
|---|---|---|
| `LICENSES_ENABLED` | `true` | On by default — a license is additive (one extra response header), and the offline path mints with an ephemeral key. |
| `LICENSE_SIGNING_KEY` | unset | Ed25519 private key (PKCS8 PEM or base64 DER) that signs licenses. Leave it unset only for single-instance mock development; it is **required** once payments are real or any Supabase backend is on, because verification has to hold across instances. |
| `LICENSE_TTL_SECONDS` | `600` | Re-read window. A license is an unrevocable bearer credential on the offline tier, so the TTL is the kill switch — capped at 3600. |
| `LICENSE_ISSUER` | derived | Issuer and audience string. Defaults to `naulon:<gate host>` at runtime. |
| `LICENSE_PAYEES_MODE` | `full` | Embed the whole payees graph (transparent) or `hashed` for a hash plus the primary payee. |
| `LICENSE_ONLINE_CHECK` | `false` | Consult the revocation seam on the online verify tier. Needs shared state. |
| `LICENSE_POP` | `false` | Bind licenses to the payer's wallet (RFC 7800 `cnf`) and require an EIP-191 proof of possession on re-read. Turn it on to close leak-replay: a captured token is then useless without the wallet key. |
| `LICENSE_POP_WINDOW_SECONDS` | `120` | Freshness window for that proof, and how long the proof nonce is remembered against replay. Capped at 600 — it only has to cover clock skew plus one round trip. |

## The dashboard

The operator console. How to expose it safely: [operating.md](./operating.md).

| Variable | Default | What it does |
|---|---|---|
| `DASHBOARD_PORT` | `8403` | Port the console listens on. |
| `DASHBOARD_BIND` | `127.0.0.1` | Interface it binds. The earnings view has no built-in auth and shows author wallets, so loopback is the default. Set `0.0.0.0` only behind your own auth. |
| `DASHBOARD_AUTH` | unset | HTTP Basic credential, `user:secret`. The secret is either a password or — preferred — a scrypt hash minted by `npm run hash -w @naulon/dashboard`, so the password is not stored in your `.env`, your compose file or your secret store. Plaintext still works and warns at every boot. With a non-loopback bind and no credential, the console **refuses to serve** rather than leak wallets; a credential that is set but unreadable (`ops:`, no colon) also refuses, loopback or not. |
| `DASHBOARD_AUTH_FAIL_RPM` | `20` | Failed-sign-in budget per client. Basic auth has no lockout, so without this the password can be guessed at network speed. Only 401s are charged, so you cannot lock yourself out by using the console hard. `0` disables. |
| `DASHBOARD_AUTH_FAIL_BURST` | `10` | Burst allowance on that budget. |
| `DASHBOARD_PUBLIC` | `false` | Opt in to a read-only public earnings page with wallets masked and every operational panel hidden. The ops console itself is never public. |
| `DASHBOARD_ALLOWED_HOSTS` | empty | Extra `Host` values the console answers to in private (loopback) mode, comma-separated. This is for the "Caddy on :443 → 127.0.0.1:8403" shape, where the browser sends your real domain. Refusing anything else is what defeats DNS rebinding: a malicious page can't read an unauthenticated loopback console by pointing its own hostname at 127.0.0.1. Ignored in authed and public modes. |
| `GATE_URL` | `http://127.0.0.1:8402` | Where the console checks gate health (`GET /healthz`). Unreachable shows as "down". |

## Buying (the agent side)

Only read by the wayfarer agent and the MCP server. See [buying.md](./buying.md).

| Variable | Default | What it does |
|---|---|---|
| `BUYER_ADDRESS` | unset | The buying wallet's address. |
| `BUYER_PRIVATE_KEY` | unset | Its key. Required for a real (non-mock) payment. |
| `TOLLGATE_URL` | unset | The gate the agent pays. Required at use — there is no localhost fallback. Setting it pins **every** payment to one gate, which is single-publisher by design. |
| `WAYFARER_BUDGET_USDC` | `0.1` | Spend ceiling for a run. |
| `WAYFARER_TOLL_TOLERANCE_BPS` | `0` | The buyer prices and pays in two requests, so the toll can move between them. The agent re-quotes at pay time and aborts if the live total exceeds the quoted total by more than this, in basis points. `0` means abort on any increase; a price drop is always fine. |
| `WAYFARER_MIN_VALIDITY_SECONDS` | `60` | Floor on the buyer's EIP-3009 validity window. If a gate advertises too short a window, the signed authorization can expire before the relayer submits it. The window only widens to this floor, never shrinks. |
| `WAYFARER_ALLOW_DOMAINS` | unset | Comma-separated publisher hosts, applied to every paid tool. This is an **allowlist** — anything not listed is denied — and it is how one agent buys across many publishers instead of being pinned to a single `TOLLGATE_URL`. A blank or malformed value reads as unset (no restriction), never as an empty allowlist that would silently skip everything. |
| `WAYFARER_DENY_DOMAINS` | unset | Hosts never paid. Deny always wins over allow. |
| `WAYFARER_PER_DOMAIN_CAP` | unset | Maximum payments per host in a run. |
| `WAYFARER_APPROVAL_USDC` | unset | A toll at or above this becomes an approval request — a human gate — instead of a payment. |
| `WAYFARER_KILL_SWITCH` | `false` | Halt all new spend. Free re-reads of licenses already held still work. |
| `WAYFARER_LICENSE_PATH` | `data/wayfarer-licenses.json` | Where the agent caches licenses it has been issued, so a live one buys a free re-read across runs. |
| `DEPOSIT_AMOUNT_USDC` | `1` | USDC deposited into the Gateway Wallet at the start of a run. |
| `CATALOG_URL` | the naulon fleet directory | Where the agent discovers candidate articles. |
| `PUBLISHER_URL` | unset | Discover from one publisher's live feed instead. |
| `RSS_URL` | unset | An explicit feed URL. Precedence is `RSS_URL` > `PUBLISHER_URL` > `CATALOG_URL`; with none of them the agent refuses rather than inventing sources. |
| `SITEMAP_URL` | unset | Reserved for sitemap-based discovery, which fills the slugs an RSS feed truncates. Unused until that parsing lands. |
| `OPENAI_API_KEY` | unset | Only for the agent's own reasoning. The toll never needs it. |
| `NAULON_CLOUD_ENDPOINT` | unset | MCP server only. Opt-in hosted signing: the memo is signed by a remote service instead of a local key. All three of endpoint / token / session address must be set, or the server falls back to the BYO-key path unchanged (`packages/wayfarer-mcp/src/cloud-signer.ts:55`). |
| `NAULON_CLOUD_TOKEN` | unset | Bearer token for that endpoint. |
| `NAULON_BUYER_SESSION_ADDRESS` | unset | The session wallet address the hosted signer signs for. Must be a well-formed `0x…40` address or the hosted path stays off. |

## Attribution and payouts

| Variable | Default | What it does |
|---|---|---|
| `MIN_PAYOUT_USDC` | `0.005` | Don't settle a wallet until its accrued tolls reach this, so the per-transfer overhead is amortized across many sub-cent reads. Below it, the balance carries forward. |
| `PRIMARY_PAYEE_TIEBREAK` | `wallet` | How the single on-chain recipient is chosen when two co-authors tie for the top share. `wallet` breaks ties by address, so who gets the on-chain leg is a pure function of who is credited and a reordered credits graph can't move it. `input` keeps the credits-graph order. The full split is recorded either way. |
| `COAUTHOR_ONCHAIN_SPLIT` | `false` | Pay co-authors directly on-chain instead of routing the whole toll to the primary author. Off is the stock single-recipient toll, with the rest of the split recorded for you to reconcile. On, the primary's leg drops to its own share and each other co-author gets a direct buyer → author leg — still custody-free. |

## Keeping this page honest

`packages/shared/src/configDocs.test.ts` asserts, in both directions, that every key
in the schema appears in this file and in `.env.example`, that `.env.example` names
no key the schema lacks, and that this page names no variable nothing reads. Add a
variable without documenting it and the test fails — which is the only reason a
reference page like this stays true.

The reverse direction on this page allows one exception the schema doesn't cover: a
key read straight from `process.env` rather than through the validated config (the
MCP server's `NAULON_CLOUD_*` trio). It has to appear in some package's source, so a
row for a variable no code reads still fails.
