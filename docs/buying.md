# Buying: the agent side of the toll

Every other page here is written for the side that gets paid. This one is the other
side: what it takes for an agent to discover tolled sources, price them, pay, and cite
what it bought.

There are two ways in, and they share a brain.

- **[`@naulon/wayfarer`](https://github.com/naulonapp/naulon/tree/main/packages/wayfarer)** — the CLI agent. Give it a topic and
  a budget; it discovers candidates, ranks them by relevance per dollar, pays only the
  ones worth citing, and answers from what it bought.
- **[`@naulon/wayfarer-mcp`](https://github.com/naulonapp/naulon/tree/main/packages/wayfarer-mcp)** — the same loop exposed over
  the Model Context Protocol, so any MCP client (Claude Code, Claude Desktop, Cursor,
  Windsurf, VS Code, Cline, or your own host) gets the tools directly.

```bash
npx -y @naulon/wayfarer-mcp        # the stdio MCP server
```

## The tools

| Tool | Cost | What it does |
|---|---|---|
| `naulon_discover` | free | Candidate teasers for a topic — slug, title, summary. Start here. |
| `naulon_appraise` | free | Relevance and rationale for teasers already held. |
| `naulon_quote` | free | The x402 402 probe: real price and terms, no spend. |
| `naulon_pay_and_read` | spends | Pays the toll; returns the content, a settlement reference, and a citation license. |
| `naulon_read_held` | free | Re-reads an article on a license you already hold, proof-signed when the license is wallet-bound. |
| `naulon_research` | spends | The whole discover → quote → pay → ground loop as one call. |
| `naulon_ask` | spends | Hosted only: a grounded, numbered-citation answer. |

The free tools carry `readOnlyHint`, so a client can render "safe" and "spends money"
differently. That distinction is worth preserving in any host you build.

## What the model is not allowed to decide

The spend envelope is **server configuration, never a tool argument**. A model plans
inside the envelope; it cannot widen it, and neither can a prompt injected into a page
the agent reads.

| Variable | What it fixes |
|---|---|
| `WAYFARER_BUDGET_USDC` | The session ceiling. |
| `TOLLGATE_URL` | The single gate every payment resolves against. A pinned gate is one publisher by design. |
| `WAYFARER_ALLOW_DOMAINS` | An allowlist of publisher hosts, applied to every paid tool. Setting it **replaces** the single-gate pin, which is how one agent buys across many publishers while staying bounded. |
| `WAYFARER_DENY_DOMAINS` | Hosts never paid. Deny wins over allow. |
| `WAYFARER_PER_DOMAIN_CAP` | Maximum paid reads per publisher per session. |
| `WAYFARER_APPROVAL_USDC` | A toll at or above this becomes a human approval instead of a payment. |
| `WAYFARER_KILL_SWITCH` | Hard stop: refuse all new spend. Free re-reads of held licenses still work. |

A blank or malformed domain list reads as **unset** — no restriction — never as an
empty allowlist that would silently deny everything. That asymmetry is deliberate: the
failure of a config string should be visible as "no policy", not as an agent that
mysteriously buys nothing.

## Paying safely

Two smaller knobs exist because of things that actually go wrong on the wire:

- **`WAYFARER_TOLL_TOLERANCE_BPS`** (default `0`) — pricing and paying are two separate
  requests, so the toll can move in between. The agent re-quotes at pay time and aborts
  if the live total exceeds the quoted total by more than this tolerance in basis
  points. The default aborts on any increase; a price drop is always fine.
- **`WAYFARER_MIN_VALIDITY_SECONDS`** (default `60`) — a floor on the buyer's EIP-3009
  validity window. If a gate advertises too short a window, the signed authorization
  can expire before the relayer submits it and the settle fails with
  `authorization_validity_too_short`. The window only ever widens to this floor.

## Discovery

With nothing configured, the tools refuse rather than fabricate a source. Pick where to
look:

- `CATALOG_URL` — a catalog of `{slug, title, summary}`. Defaults to the naulon fleet
  directory, so zero-config discovery resolves to a real corpus.
- `PUBLISHER_URL` — one publisher's site; the agent reads `${PUBLISHER_URL}/rss.xml`.
- `RSS_URL` — an explicit feed.

Precedence is `RSS_URL` > `PUBLISHER_URL` > `CATALOG_URL`.

## What you keep after paying

A payment returns a **citation license**: a signed receipt the agent stores and can
re-present for a free re-read inside its TTL, and which anyone can verify
independently. That is what makes a citation checkable later rather than a claim —
the full spec is in [citation-license.md](./citation-license.md). Licenses are cached
at `WAYFARER_LICENSE_PATH`, so a re-read spans runs.

Running with no credentials at all settles in mock mode: the whole loop works, nothing
moves on-chain. Set `PAYMENT_MODE=gateway` with a funded `BUYER_PRIVATE_KEY` to pay for
real. Every variable named here is in [configuration.md](./configuration.md).
