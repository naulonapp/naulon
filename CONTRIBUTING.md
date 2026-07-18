# Contributing

Thanks for helping build the citation toll. This is a small TypeScript monorepo.

## Setup

```bash
make install      # Node >= 22
cp .env.example .env
make demo         # confirm the whole loop runs offline
```

No build step — everything runs from TypeScript via `tsx`.

## Day to day

```bash
make dev          # tollgate :8402 + dashboard :8403, together
make wayfarer TOPIC="payment and passage"
make test         # unit tests
make lint         # typecheck the whole workspace
```

## Where things live

```
packages/shared        types, config, attribution math, event store
packages/tollgate      x402 reverse proxy (the gate)
packages/wayfarer      the paying research agent
packages/attribution   batched settlement to authors
packages/dashboard     live earnings view
examples/meridian   reference publisher adapter — copy this to add your own
```

## Common changes

- **Add a publisher** → implement `CreditsResolver` (`@naulon/shared`); copy
  `examples/meridian`. Point `ORIGIN_URL` + a credits source at your site.
- **Add a payment rail** → implement `Settlement` (attribution) or `Buyer`
  (wayfarer); keep the `mock` path working.
- **Persist events elsewhere** → implement `EventSink` (`@naulon/shared`).

## Conventions

- **Money is integer micro-USDC** in any split or settlement math — never a float
  (the wire shapes are in [`docs/settlement-contract.md`](./docs/settlement-contract.md)).
- **Config is zod-validated and fails loud** at boot — a new env var gets a sane
  default and an `.env.example` line.
- **TypeScript strict**; relative imports keep the `.ts` extension (NodeNext + tsx).
  Narrow `unknown` instead of reaching for `any`.

## Documentation is part of the change

A PR that changes something meaningful updates the docs in the **same PR**. A
reviewer should reject a significant change that leaves the docs behind.

- **Changed an integrator-facing surface** — the 402 flow, the credits contract,
  an env var, a deploy step — update `README.md`, `docs/`, or `DEPLOY.md`. Keep
  that prose human and technical.
- **Changed a package's exported surface** — a new resolver, a route, a settlement
  shape — call it out in the PR description and update the affected `docs/` page
  (or add one for a brand-new surface).

"Meaningful" is roughly: anything you'd mention in the PR description. A typo or a
one-line internal rename doesn't need a doc edit; a new endpoint, a changed
contract, or a new behavior does.

## Pull requests

- `make lint && make test` pass (zero new type errors).
- Conventional Commit titles (`feat:`, `fix:`, `docs:` …). **No `Co-Authored-By`
  / AI-attribution trailers.**
- No secrets — `.env` is gitignored; commit `.env.example` updates instead. (A
  pre-commit hook blocks `.env` and hardcoded keys.)
- Keep components decoupled — talk through `@naulon/shared` + HTTP, not by
  importing a sibling package's internals.
- If you change a convention, update this guide in the same PR.

## Security

Never pool or custody USDC; settlement is buyer → author. Report anything that
could leak a key or break the humans-read-free invariant before merging.
