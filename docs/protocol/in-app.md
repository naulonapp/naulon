# Writing an in-app runtime

An in-app runtime tolls AI agents from inside your own application, instead of a gate sitting in
front of it. The WordPress plugin, `@naulon/enforce` and the Python package are all in-app runtimes.
This page is everything you need to write one in another language. Nothing here requires reading
the TypeScript.

## The rule that keeps it portable

Your runtime only classifies. It decides, from the request and a cached policy document, whether
the caller is a person or an agent and whether the path is tolled. Everything that involves money
or a signature it asks the gate for: the 402 body, settlement, licence checks. So there is exactly
one implementation of the payment arithmetic, and your runtime never holds a key that can move
money.

## Endpoints

Every call sends `Authorization: Bearer <key>`. The machine-readable contract is served by every
gate at `/_naulon/openapi.json` and committed as [openapi.json](./openapi.json). Generate a client
from either.

| Route | When you call it | What comes back |
|---|---|---|
| `GET /_naulon/enforce-config?resource=<url>` | In the background, every few minutes per host | The policy: `enforcement` (scope), `rules` (who is blocked, free, charged), the x402 manifest and the RSL licence |
| `GET /_naulon/quote?resource=<url>&slug=<slug>&kind=read&build=402` | An agent asked for a tolled article | `200` with `x402.header` (send it as the 402's `PAYMENT-REQUIRED` header) and `x402.legs`, or `204`: serve it free |
| `POST /_naulon/verify` | The agent retried with a payment | `200 {ok:true, responseHeader, licenseJws, chargedMicro}`: serve the article. `402`: not settled, answer the agent with a fresh quote |
| `POST /_naulon/license/check` | The agent presented `X-Naulon-License` | `{entitled: true}`: serve it free |
| `POST /_naulon/observe` | After any decision you made yourself | `202`. Batch up to 50. `paid` and `payment-failed` are refused: `/verify` writes those |
| `GET /_naulon/enforce-status` | When a key is saved | `200` means the key works; `selfHosted` says which kind of gate it is |

## The request path

1. Look up the cached policy for the request's host. None yet: serve the page, and fetch one in
   the background.
2. Is the path tolled? Apply `enforcement.articlePrefixes` and `enforcement.gateScope` exactly as
   [scope-cases.json](https://github.com/naulonapp/naulon/blob/main/packages/shared/test-fixtures/scope-cases.json) defines. Not tolled:
   serve the page.
3. Classify the caller with `rules` (block, classify, refusal, free, in that order). A person:
   serve the page. Blocked or refused: `403`.
4. An agent with no payment: call `quote` with `build=402` and answer `402` with the header it
   returns.
5. An agent with a payment: call `verify`. On `ok:true`, serve the article and add the gate's
   `responseHeader` as `PAYMENT-RESPONSE`.

## Rules your runtime must keep

These are what stop an integration from ever breaking the site it runs on.

1. **The page always wins.** Any exception, timeout or malformed answer in your runtime serves the
   request untouched.
2. **People never wait on the network.** Classification uses only the cached policy.
3. **Network calls happen only on the agent path,** with a short timeout (2 seconds is what the
   WordPress plugin uses) and a circuit breaker.
4. **Any gate failure serves the page free.** Config, quote, verify, licence or observe: a
   timeout, a refused connection, a 5xx or garbage means the reader gets the page.
5. **Never invite a second payment for one read.** When a licence server answers `in_flight` or
   `server_error` for a licence an agent presented, answer `503` with `Retry-After` and no x402
   offer.
6. **Never read, buffer or rewrite the response body.** Add headers on a paid read, nothing else.
7. **Mark every 402 and every paid 200 `Cache-Control: private, no-store`,** with `Vary: User-Agent,
   Accept, Authorization`, so a cache never serves a 402 to a person.
8. **Start in observe mode** (`rules.tollMode: "observe"`): decide and report, serve everything.
9. **Never charge for something that is not an article.** If your framework can tell you the page
   is a 404, a redirect or a listing, pass it through untouched.

## Keys

A gate you host yourself has one operator key, `NAULON_ENFORCE_KEY`. It acts for every site the
gate serves, so keep it on servers you run. A platform that gives each site its own runtime gives
each site its own key and publishes its SHA-256 as `enforceKeySha256` on that site's record; that
key then acts for its own site only.

## Platforms with many sites

A gate started with `NAULON_PLATFORM_URL` and `NAULON_PLATFORM_KEY` asks your platform
`GET <url>?host=<host>` for each site's record, validated against
[publisher-record.schema.json](./publisher-record.schema.json). Answer `404` for a site you do not
toll. Money is integer micro-USDC (`priceMicro`), and the gate keeps serving the last good record
while your platform is unreachable.

## Conformance

A port is done when it passes every case in these files, generated from the gate itself:

| File | What it fixes |
|---|---|
| [access-cases.json](https://github.com/naulonapp/naulon/blob/main/packages/shared/test-fixtures/access-cases.json) | The access decision for every crawler, terms combination and rule. Its `$comment` explains the compact format |
| [scope-cases.json](https://github.com/naulonapp/naulon/blob/main/packages/shared/test-fixtures/scope-cases.json) | Which paths are tolled, and under which slug, for each scope |
| [identity-cases.json](https://github.com/naulonapp/naulon/blob/main/packages/shared/test-fixtures/identity-cases.json) | Crawler identity: a claimed crawler from the wrong network |
| [content-type-cases.json](https://github.com/naulonapp/naulon/blob/main/packages/shared/test-fixtures/content-type-cases.json) | The Content-Type to serve `/license.xml` with |

`npm run contract:fixtures` regenerates them, and the gate's own test suite fails when they are
stale, so a file you read is always what the gate does.

## Versions

The protocol has its own version, in the OpenAPI document's `info.version`. A runtime targets that
version, not a gate release. A change an existing runtime would break on bumps the major.
