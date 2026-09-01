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

## v0.7.4

Ships `@naulon/shared` 0.4.1 · `@naulon/enforce` 0.4.1. Both are patches, so every existing
`^0.4.0` range picks them up with no change on your side.

The headline is that `@naulon/enforce` finally exports the observation sink it has shipped
since 0.4.0. The module was built, compiled into `dist` and unit-tested, and no consumer could
reach it — so the documented `/observe` wiring threw at import.

### Fixed

- **`@naulon/enforce` — `httpObservationSink` is importable.** The package barrel re-exported
  three of its four in-app-enforcement modules, and the `exports` map publishes `"."` and
  `"./next"` only, so the sibling barrel that did list the fourth was not a path any consumer
  could take. `import { httpObservationSink } from "@naulon/enforce"` threw
  `does not provide an export named 'httpObservationSink'` on 0.4.0. The same omission left
  `NaulonMiddlewareOptions.observe` as a slot whose type, `ObservationReporter`, could not be
  named — so a custom sink could not be typed either. Both are exported now, along with
  `ObservationReport` and `ReportableVerdict`.

  Every test in that directory imports its subject by relative path, which is why none of them
  saw it. `barrel.test.ts` now asserts reachability rather than behaviour: every runtime export
  of each in-app-enforcement module must appear on the package root, and a new sibling module
  fails the check until it is added.

### Added

- **`@naulon/shared` — `readAllPaged()` and `PAGE_ROWS`.** One paging primitive for PostgREST
  reads. PostgREST caps a response at 1000 rows, so an unpaged `select` silently returns a
  prefix of the truth rather than an error; this walks the pages instead. Additive — no existing
  export changed signature.

## v0.7.3

Ships `@naulon/shared` 0.4.0 · `@naulon/enforce` 0.4.0 · `@naulon/sdk` 0.3.1 ·
`@naulon/wayfarer` 0.3.1 · `@naulon/wayfarer-mcp` 0.4.2. The two minors are additive — new
exports, no signature changed — but a caret range on a zero-major is minor-tight, so anything
asking for `^0.3.x` of `shared` or `enforce` must move its range to `^0.4.0` to see them.

The headline is that a STOCK x402 client is now billed for what it actually paid. Such a client
signs only `accepts[0]`, which is the primary author's own share, and the gate had been booking
the whole quote — so a co-author's unpaid cut and the operator fee were both recorded as though
the money had moved.

### Added

- **`@naulon/enforce` — `tollPrice(publisher, kind)`.** The price formula, exported. It was
  inlined in `quote()`, and a second caller now needs the same answer: a control plane verifying a
  self-hosting publisher's quote against its own record before settling it. Copying a money formula
  into a second file is the thing this package refuses to do, so the formula moved out instead.

- **`@naulon/shared` — `ForgoneLeg` and `AttributedEvent.forgone`.** Every leg the quote required
  that the buyer never authorized, one entry each: role, payee, amount. Deliberately per-leg and
  never a sum — a total cannot say whose money it was, and an operator leg and a co-author leg are
  owed to different people. Deliberately not a `PayoutLeg` either: this records that a payment did
  NOT happen, so branding it would run an address validator over money that never moved.

### Fixed

- **A crawler read charged what the quote asked for, not what settled.** The receipt for a stock
  payer reported the full multi-leg total; it now reports the amount that actually moved.

- **The single-leg payment the gate advertises is honoured, and the fee is booked as uncollected.**
  Refusing a stock payer would have been the other way to close it — and would have broken every
  client that reads x402 the way the spec is written.

### Changed

- **`memoTemplate` is documented as a RAIL CHOICE, not a label**, and the networks that may
  self-relay are pinned by a test. Setting it takes the settle off Circle Gateway's batch and onto
  one on-chain transaction per toll, with our relayer paying that gas — measured at 4.5×–10× the
  operator fee it earns. Harmless on a testnet; a real loss per read on mainnet.

- **The settlement-rail dependencies were refreshed** within their existing ranges.

- **The published packages carry `keywords`, `homepage` and `bugs`** — npm search matched none of
  them before, for any term. `@naulon/shared` gained `engines.node` to match its siblings.

- **Three tripwires** for surfaces that had a rule and nothing executing it: a release tag must
  have a section in this file, a published package must carry the metadata npm renders, and CI
  says on `main` when the registry is behind the branch.

## v0.7.2

WordPress plugin only — `@naulon/*` versions all stood still, so this tag published
nothing to npm. What it shipped is in [`plugins/naulon/readme.txt`](./plugins/naulon/readme.txt),
the changelog WordPress shows a publisher.

## v0.7.1

WordPress plugin only — same shape as v0.7.2 above: no npm package moved, and the
plugin's own changelog carries the detail.

## v0.7.0

Ships `@naulon/sdk` 0.3.0 · `@naulon/shared` 0.3.1 · `@naulon/enforce` 0.3.1 ·
`@naulon/wayfarer-mcp` 0.4.1. The middle two carry no behaviour change — their
`@naulon/sdk` range moves with the minor — and the last is a corrected env var name in
its README, which is the page npm shows.

The headline is that the gate image exists and can be pulled. Everything under Fixed
below is what stood between "a workflow that builds an image" and that sentence being
true; the first of them was found by the workflow's own smoke test, on the first build
that ever ran.

### Added

- **`naulon selftest`** — drives one whole toll through your own gate and reports each leg:
  the manifest, a free human read, the 402 quote, the payment, the citation licence that came
  back, that the same payment cannot be replayed, and that a citation costs more than a read.
  Where `naulon doctor` stops at "the gate issues a challenge", this satisfies it. The path
  under test is the prefix your gate advertises in `/.well-known/x402`, so a publisher at
  `/writing/` is tested at `/writing/`; the slug is the first entry in your credits source, or
  `--slug`. It pays with the offline mock signature, so nothing moves — against a gate already
  in `gateway` mode it reports the facilitator's refusal as expected rather than as a fault.

- **A published gate image, `ghcr.io/naulonapp/naulon`.** `@naulon/tollgate` and
  `@naulon/dashboard` were never on npm because the gate ships as a container; until now
  nothing published one. `docker-compose.yml` pulls it, so a host with Docker needs neither
  this repo nor Node. Contributors build from the working tree with `make docker-build`.

### Fixed

- **The image could not boot the gate: no workspace was ever built.** Five packages
  (`@naulon/{sdk,shared,enforce,wayfarer,wayfarer-mcp}`) resolve through `dist/`, so the gate's
  first import of `@naulon/shared` reads `dist/index.js` — which nothing produced, and which the
  single `--omit=dev` stage could not produce, having no typescript. "Runs straight from
  TypeScript via tsx" was true of the entry module only. The build is now two stages: install in
  full, build in dependency order, prune to production, copy the result. A local boot of the
  *console* half hides this entirely — it imports none of the five, which is how the image passed
  a hand check twice before a machine ran the gate.
- **The Docker image could not boot at all.** `tsx` was a root devDependency while the image
  installed `--omit=dev`, so `npm run tollgate` died on a missing binary. `tsx` is now a
  dependency — nothing in this repo is compiled before it runs, which makes it a runtime need,
  not a dev one.
- **The image build copied five of eight workspace manifests**, which is why its install carried
  a `|| npm install` fallback: `npm ci` could not see the missing workspaces and failed every
  time, silently downgrading a locked install to an unlocked one. All eight are copied and the
  fallback is gone.
- **The build had no `.dockerignore`**, so `COPY . .` swept in `node_modules`, `.git`, any local
  ledger and — on a machine that had one — `.env`. For an image nobody published that was waste;
  for one anybody can pull it would have been a secret in a public layer.
- **A dispatched image build could only ever fail.** Every tag in the publish step is
  conditional and `latest` is gated on a tag ref, so a manual run computed an empty tag list and
  died on a tagless push — at the end of a ~10-minute emulated multi-arch build. `latest` stays
  release-only; a dispatch publishes `edge`, and an empty tag list is refused in a second.
- **The console's theme control rendered a third larger than the rail around it** — 16px/24px
  beside 12px/18px siblings. `font: inherit` reads as "take the page's type" and does the
  opposite: the shorthand also resets font-size to the parent's, overriding the size the
  element's own class set. Three rules styled a `<button>` to read as text and each spelled that
  reset itself; they now share one.

## v0.6.0

Ships `@naulon/sdk` 0.2.0 · `@naulon/shared` 0.3.0 · `@naulon/enforce` 0.3.0 ·
`@naulon/wayfarer` 0.3.0 · `@naulon/wayfarer-mcp` 0.4.0 — every published package.

Two things move in this release. The settlement notification a publisher receives is now
a signed webhook and only a signed webhook; the origin-mirror POST is deleted, not
deprecated. And the crawl engine became a seam: a host with its own adapters implements
an interface instead of forking the crawler, and can prove its adapter conforms.

Every version here is a `0.x` minor, so a caret range is minor-tight — `^0.2.0` will not
resolve `0.3.0`. Anything depending on `@naulon/shared` or `@naulon/wayfarer` needs its
range bumped in the same change, not just an `npm update`.

### Breaking

- **`@naulon/sdk` — the settlement receiver is gone; receive a webhook instead.**
  `createSettlementReceiver` (`/next`) and `createExpressSettlementReceiver`
  (`/express`) are replaced by `createWebhookReceiver` and
  `createExpressWebhookReceiver`, which hand you a `WebhookEnvelope` instead of a
  `SettlementBody` and take a different options shape: `secrets` is an ARRAY (one per
  live secret during a rotation overlap), the handler is `onEvent` and sees every event
  type rather than settlements only, and `idempotency` is **required** — delivery is
  at-least-once, so the receiver dedupes on `eventId` or double-counts.
  `memoryIdempotencyStore()` satisfies the type for dev and is not durable; back it with
  a unique constraint in production. Also removed:
  `signSettlement` / `verifySettlement` / `SignedSettlement` / `VerifyResult` /
  `MAX_SKEW_SECONDS` (now `signPayload` / `verifyPayload` / `WEBHOOK_SIGNATURE_HEADER` /
  `WEBHOOK_MAX_SKEW_SECONDS`), the `contract/settlement.ts` types and schemas
  (`SettlementBody`, `SettlementSplit`, `settlementBodySchema`, `settlementSplitSchema`,
  `CONTRACT_VERSION`), and `makeSignedSettlementFixture` (now
  `makeSignedWebhookFixture`). A publisher who wants to know that money moved subscribes
  a `raw` endpoint to `settlement.completed`; `docs/settlement-notifications.md` is the
  migration. The old path stopped being served by the gate in the same change, so
  leaving the receiver mounted does not keep it working — it goes quiet.
- **`@naulon/shared` — the settlement emit and its whole retry plane are deleted.**
  `buildSettlementBody` and the `settlementEmit` barrel export are gone, as is
  `PublisherConfig.settlementSecret`. Twelve env vars stop being read:
  `CREDITS_SETTLEMENT_SECRET`, `SETTLEMENT_OUTBOX_PATH`, `SETTLEMENT_MAX_ATTEMPTS`,
  `SETTLEMENT_TIMEOUT_MS`, `SETTLEMENT_DRAIN_INTERVAL_MS`, `SETTLEMENT_DELIVERY_BACKEND`,
  `SETTLEMENT_DELIVERY_STATE_PATH`, `SETTLEMENT_MAX_DELIVERY_ATTEMPTS`,
  `SETTLEMENT_RETRY_BASE_MS`, `SETTLEMENT_RETRY_BACKOFF_CAP_MS`, `SETTLEMENT_DRAIN_BATCH`
  and `SUPABASE_SETTLEMENT_DELIVERY_TABLE`. The config schema ignores unknown keys, so a
  deploy that still sets them boots fine — they are inert, not fatal, which means nothing
  will tell you the notifications stopped. Set `NAULON_WEBHOOK_ENDPOINTS` before you
  upgrade, not after.
- **`@naulon/shared` now depends on `@naulon/sdk`.** `signPayload` / `verifyPayload` are
  re-exported from there rather than reimplemented here, so the bytes a publisher
  verifies come from the same function that produced them. Same names, same output; the
  only visible change is one more package in the install graph.

### Added

- **`@naulon/sdk/crawl` — the adapter seam.** A host that crawls sources the built-ins
  don't cover implements `SourceAdapter` and hands it to `selectAdapter`, instead of
  copying the engine to add a source. The subpath exports the port
  (`SourceAdapter`, `AdapterContext`, `ArticleCandidate`), the registry (`ADAPTERS`,
  `adapterById`, `canRun`, `selectAdapter`), the SSRF-guarded fetcher
  (`makeGuardedFetcher`), author→wallet resolution (`resolveAuthorWallet`,
  `validWallet`), and the two decisions every front-door makes before an adapter runs —
  glob matching (`matchGlob`, `passesGlobs`) and the one feed-parser config (`parseXml`,
  `toArray`, `textOf`). `docs/crawl-adapters.md` is the guide.
- **`@naulon/sdk/crawl/testing` — the contract, executable.** `runConformance` supplies
  the network and measures what an adapter actually did; `assertConformance` fails the
  test. It is a separate subpath so a test-only surface never lands in a runtime bundle.
- **Adapters declare what they need, and a host grants it.** `AdapterRequirements` +
  `HostCapabilities`: an adapter requiring a secret or an off-origin fetch is filtered
  out before `detect` on a host that cannot satisfy it — it cannot fetch, log, or
  half-run. The `naulon crawl` CLI grants nothing, so a keyed adapter is inert there by
  construction rather than by convention.
- **Adapters can no longer key an article.** `discover` returns `ArticleCandidate[]`;
  the orchestrator derives the gate key once prefixes are known and reports how many it
  could not key (`CrawlResult.unkeyable` — a big number usually means the wrong
  `articlePrefixes`). Previously an adapter could emit a key the gate cannot reproduce —
  an article that silently never tolls.
- **`@naulon/sdk/slug` — one owner for the article key.** `deriveSlug`, `deriveSiteSlug`,
  `decodeSlug`, `slugFromPath`, `slugFromSitePath`, at the bottom of the package graph,
  because the key the gate derives from a request path must be byte-identical to the one
  a crawler writes and the one a credits API answers at. `@naulon/sdk/net` is the same
  move for the SSRF blocklist.
- **`@naulon/shared` — `arcPreviewHeaders(chain)` and `ARC_PRIVATE_MAINNET_HEADER`.** The
  Arc private-mainnet opt-in has an owner here because Circle stopped having one (see
  below).
- **`@naulon/wayfarer` — `Fetched.unpaid`.** True when the gate returned a complete
  response and took nothing, so a caller that reserved spend before signing knows it may
  release the reserve. Deliberately absent — never `false` — when a request throws
  mid-flight, because "it never settled" and "it settled and I lost the answer" are the
  same observation from there.

### Fixed

- **`@naulon/wayfarer` — Arc-mainnet funding calls silently stopped opting into the
  preview.** `@circle-fin/x402-batching` 3.3.0 deleted `arcPrivateMainnet` and the
  implicit `config.chain === "arc"` default that came with it, so a client built with
  `{chain, privateKey}` sent no header. Every `GatewayClient` in the package is now built
  through one constructor that passes `headers` explicitly. Visible only on the funding
  half — deposit, withdraw, balances — while settle kept working.
- **`@naulon/wayfarer-mcp` — `naulon_status` no longer offers a wallet nobody can pay
  from.** With no session and no `BUYER_PRIVATE_KEY` it fell back to the derived dev key,
  whose private key is effectively public, and told the operator to fund it. `wallet` is
  now optional and absent is the answer; `ready` is false and `nextStep` says how to get
  one.
- **`@naulon/wayfarer-mcp` — the discovery match evidence described the misleading
  case.** Neither `matchedInBody` nor `matchedSemantic` set means either the strongest
  possible match (your terms hit the title) or no signal at all (the source does not
  search), and the schema had never said which.

### Changed

- **`@naulon/enforce` no longer implements the article-key rule** — `slugFromPath` and
  `slugFromSitePath` are re-exported from `@naulon/sdk/slug`, so its public surface is
  unchanged for anyone importing them from here. The regex compilation and prefix
  escaping moved with them.
- **The `naulon-kit check` CLI prints a signed `settlement.completed` delivery** instead
  of a settlement fixture, for the same reason as before: a money-adjacent path gets no
  public "pretend" mode, so you feed the fixture to your own receiver in your own
  harness.
- **A published package may no longer depend on `@naulon/*` at `*`.**
  `packages/shared/src/releaseRanges.test.ts` used to exempt the string outright, on the
  reasoning that only workspace-internal packages use it; `@naulon/enforce` then acquired
  `"@naulon/sdk": "*"`, which would have shipped a range that resolves whatever is newest
  at install time. The exemption is now on the dependent being private.

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
