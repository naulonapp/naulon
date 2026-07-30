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
plugins/naulon         the WordPress plugin (PHP, not part of the Node workspace)
```

## Common changes

- **Add a publisher** → implement `CreditsResolver` (`@naulon/shared`); copy
  `examples/meridian`. Point `ORIGIN_URL` + a credits source at your site.
- **Add a payment rail** → implement `Settlement` (attribution) or `Buyer`
  (wayfarer); keep the `mock` path working.
- **Persist events elsewhere** → implement `EventSink` (`@naulon/shared`).

## The WordPress plugin

`plugins/naulon` is PHP and `make test` cannot see it. It has two suites, and both
run in CI on every push.

```bash
cd plugins/naulon
composer install
composer test                     # unit: the decision functions, no WordPress, instant

bin/install-wp-tests.sh           # once: fetches WordPress + the PHPUnit test library
WP_TESTS_DIR=/tmp/naulon-wordpress-tests-lib composer run test:integration
```

The installer needs a MySQL it can reach — pass `[db-name] [db-user] [db-pass]
[db-host]` if yours is not `wordpress_test root root 127.0.0.1`, and set
`SKIP_DB_CREATE=1` when the database already exists. It points the test WordPress at
this working tree rather than a copy, so the integration suite runs the files you
just edited.

The integration suite is where anything that only means something against a real
database is proven: that a cached update manifest is re-validated against the pinned
download host on every read, and that deleting the plugin keeps the publisher's
wallets and earnings. Do not move a test out of it to make it faster.

`npx @wordpress/env start` still works if you want a browsable site, but its teardown
has twice emptied the bind-mounted plugin directory — commit before you run it.

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
