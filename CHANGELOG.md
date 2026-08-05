# Changelog

What changed in the published `@naulon/*` packages, per release tag.

A tag publishes only the packages whose version moved (the publish is idempotent), so
a section names the versions it actually shipped. Packages absent from a section did
not change. The WordPress plugin keeps its own changelog in
`plugins/naulon/readme.txt` — that is the one WordPress shows a publisher, and it is
written for them rather than for integrators.

`@naulon/tollgate`, `@naulon/dashboard` and `@naulon/attribution` are not on npm: the
gate ships as a Docker image, and the other two are workspace-internal.

Releases before v0.5.0 predate this file. Their contents are the git history between
tags and the auto-generated notes on each GitHub Release.

## v0.5.0

Ships `@naulon/shared` 0.2.0 · `@naulon/enforce` 0.2.0 · `@naulon/wayfarer` 0.2.0 ·
`@naulon/wayfarer-mcp` 0.3.0. `@naulon/sdk` is unchanged at 0.1.1.

**This is the release that closes a gap, not a normal cadence bump.** The four packages
above accumulated 8 months of fixes — including the two security fixes below — against
versions that had not moved since July, so `npm install` served none of them. The guard
that now prevents a repeat is in `.github/workflows/release.yml`; the reason it did not
exist is recorded in the report dated 2026-08-05.

Because these are `0.x` versions, a caret range is minor-tight: `^0.1.2` will not
resolve `0.2.0`. Anything depending on `@naulon/shared` or `@naulon/wayfarer` needs its
range bumped in the same change, not just an `npm update`.

### Security

- **`@naulon/shared` — the prompt-injection fence could be closed by the text it was
  fencing.** `fenceUntrusted()` wrapped untrusted text in `<<<UNTRUSTED … /UNTRUSTED>>>`
  and did nothing about a body that contained those markers itself. The markers are in
  MIT-licensed source, so they were never a secret. Publisher-controlled text carrying
  `UNTRUSTED>>>` ended the fence early and everything after it reached the model as
  instruction — and in `@naulon/wayfarer` that model answer sets the relevance score
  that decides what gets bought. Closing markers in the body are now neutralised.
- **`@naulon/wayfarer` — a teaser could set its own relevance score.** The appraisal
  read a score out of text the source itself supplied, so a source could rank itself.

### Fixed

- **`@naulon/enforce` — a failed quote lookup no longer throws, and no longer fails
  silently.** A lookup error took the toll off for that request with nothing in the log
  saying so; it now fails open *loudly*, which is a decision an operator can see.
- **`@naulon/shared` / `@naulon/enforce` — Web Bot Auth signed the scheme the socket
  saw, not the one the buyer used.** Behind a TLS-terminating proxy the gate signs over
  `http` while the buyer signed `https`, so verification fails on exactly the deployment
  shape every hosted publisher has.
- **`@naulon/wayfarer` — an unfunded chain read to the agent as a config error**, and a
  Gateway-rail shortfall was classified `origin_error` rather than `needs_topup`. Both
  told a buyer to fix the wrong thing.
- **`@naulon/wayfarer-mcp` — `naulon_status` told buyers to fund a wallet that never
  pays.** It printed the address of a wallet outside the paying path.
- **`@naulon/shared` — the ledger read is paginated**, so money planes stop truncating
  at the first page.
- Payment failures now carry *why* they failed, not only that they did
  (`@naulon/shared` observations), and an attributed event carries the tolled host.

### Added

- **`@naulon/enforce` speaks Cloudflare's pay-per-crawl price vocabulary** —
  `crawler-price`, `crawler-exact-price`, `crawler-max-price` and the charged header —
  so a crawler already trained on it understands the price. Settlement stays x402/USDC.
- **The agent vocabulary covers the tokens the fleet actually sees.** Meta publishes
  five crawler tokens and the list matched one; it now also charges
  `meta-externalfetcher`, `amzn-user` and `mistralai-user`. Pure search indexers
  (`meta-webindexer`, `amzn-searchbot`, …) stay deliberately absent: tolling one
  deindexes the publisher.
- **`@naulon/enforce` reports in-app gating decisions to the audit plane**, so an
  in-app publisher's decisions are visible where DNS-mode ones already were.
- **`@naulon/wayfarer` gained `gatewayWithdraw`** (a thin adapter over
  `GatewayClient.transfer()`), `licenseIdentityFor`, `payHostOf`,
  `resolvedDiscoverySourceUrl`, and an appraisal surface that explains *why* a source
  matched (`buildAppraisePrompt`, `evidenceLine`, `parseRelevance`).
- **`@naulon/shared` publishes the seams the fleet had kept private**: the crawler
  policy file and registry, webhook core and endpoint env, client identity, external
  scheme, rate-limit core, CSV, fleet types, and `untrusted`.

### Changed

- **One appraisal prompt, not one per consumer** (`@naulon/wayfarer`). The prompt now
  has a single owner; consumers that built their own are on the shared one.
- **The settlement registry covers all 14 Circle Gateway chains**, locked to the
  installed `@circle-fin/x402-batching` SDK by a parity test rather than by hand.
