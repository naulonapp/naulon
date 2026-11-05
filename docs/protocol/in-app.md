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

Every call sends `Authorization: Bearer <credential>` (see [Getting a credential](#getting-a-credential-connect)). The machine-readable contract is served by every
gate at `/_naulon/openapi.json` and committed as [openapi.json](./openapi.json). Generate a client
from either.

| Route | When you call it | What comes back |
|---|---|---|
| `GET /_naulon/enforce-config?resource=<url>` | In the background, every few minutes per host | The policy: `enforcement` (scope), `rules` (who is blocked, free, charged), the x402 manifest and the RSL licence |
| `GET /_naulon/quote?resource=<url>&slug=<slug>&kind=read&build=402` | An agent asked for a tolled article | `200` with `x402.header` (send it as the 402's `PAYMENT-REQUIRED` header) and `x402.legs`, or `204`: serve it free |
| `POST /_naulon/verify` | The agent retried with a payment | A body with a `verdict` (see below). On `paid` it also carries `responseHeader`, `licenseJws` and `chargedMicro` |
| `POST /_naulon/license/check` | The agent presented `X-Naulon-License` | A body with a `verdict`: `paid` means the read was paid for, serve it free |
| `POST /_naulon/observe` | After any decision you made yourself | `202`. Batch up to 50. `paid` and `payment-failed` are refused: `/verify` writes those |
| `GET /_naulon/enforce-status` | When a credential is saved | `200` means the key works; `selfHosted` says which kind of gate it is |

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
5. An agent with a payment: call `verify` and act on its `verdict`. On `paid`, serve the article and
   add the gate's `responseHeader` as `PAYMENT-RESPONSE`.

## Reading the gate's answer

`/verify` and `/license/check` put the outcome in one field, `verdict`. Act on it whatever the
HTTP status says.

| `verdict` | What your runtime does |
|---|---|
| `paid` | Serve the resource. On `/verify`, add the receipt headers |
| `refused` | Not paid. Answer the agent with the 402 again |
| `pending` | A charge for this read is already running. Answer `503` with `Retry-After: 2` and no offer |
| `unavailable` | The gate could not decide. Serve the page; the gate has already recorded the read |

An answer without a known `verdict` is read by its status:

- a **4xx** is `refused`. The agent writes the payment header, so its size or bytes can trip a body
  limit, a firewall or a rate limiter in front of the gate. Serving on that would make the header a
  free pass. A refusal of your key is a 4xx too.
- **no answer, a 5xx, or a success** is no verdict: serve the page. No request can choose those.

[verdict-cases.json](https://github.com/naulonapp/naulon/blob/main/packages/shared/test-fixtures/verdict-cases.json)
lists both rules case by case. A gate older than protocol 1.1 sends no `verdict`, so its paid reads
are served without a receipt. Run a 1.1 gate before a runtime that reads the field.

## Rules your runtime must keep

These are what stop an integration from ever breaking the site it runs on.

1. **The page always wins.** Any exception, timeout or malformed answer in your runtime serves the
   request untouched.
2. **People never wait on the network.** Classification uses only the cached policy.
3. **Network calls happen only on the agent path,** with a short timeout (2 seconds is what the
   WordPress plugin uses) and a circuit breaker.
4. **Any gate failure serves the page free.** Config, quote, verify, licence or observe: a
   timeout, a refused connection, a 5xx or garbage means the reader gets the page. A 4xx is an
   answer, not a failure.
5. **Never invite a second payment for one read.** On `pending`, or when a licence server answers
   `in_flight` or `server_error` for a licence an agent presented, answer `503` with `Retry-After`
   and no x402 offer.
6. **Never read, buffer or rewrite the response body.** Add headers on a paid read, nothing else.
7. **Mark every 402 and every paid 200 `Cache-Control: private, no-store`,** with `Vary: User-Agent,
   Accept, Authorization`, so a cache never serves a 402 to a person.
8. **Start in observe mode** (`rules.tollMode: "observe"`): decide and report, serve everything.
9. **Never charge for something that is not an article.** If your framework can tell you the page
   is a 404, a redirect or a listing, pass it through untouched.

## Getting a credential: connect

A runtime needs one thing configured, the gate's URL. Everything else it discovers, and its
credential it asks for. Nobody copies a secret.

**Discovery.** `GET <gate>/.well-known/naulon` returns a JSON document shaped after RFC 8414:
`issuer`, `protocol` (`naulon/1`), `enforce_api`, `authorization_endpoint`, `token_endpoint`,
`revocation_endpoint`, `jwks_uri`, `challenge_path`, and
`authorization_response_iss_parameter_supported: true`. Refuse the document unless `issuer` is the
origin you were given (RFC 8414 §3.3), and derive every URL from it rather than from the gate's
origin: the hosted gate's approval page is on another origin. Cache it as its `Cache-Control` says,
at least five minutes. The default gate is `https://gate.naulon.app`.

**Your client document.** Serve `GET <site>/.well-known/naulon-client`:

```json
{
  "client_id": "https://blog.example.com/.well-known/naulon-client",
  "client_name": "My blog",
  "redirect_uris": ["https://blog.example.com/naulon/connect/return"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code"]
}
```

`client_id` is the URL it is served from. Every redirect must be on that origin. The gate shows
`client_name` labelled as your own description, beside the origin, because a name proves nothing.
A platform may serve one document for all its sites from its own origin instead.

**1. Send the owner to approve.** Make a code verifier (RFC 7636 §4.1: 43 to 128 unreserved characters),
its S256 challenge, and a `state` (22 to 128 URL-safe characters). Keep all three as a pending connect, for
15 minutes. Then redirect the owner to `authorization_endpoint` with `response_type=code`,
`client_id`, `redirect_uri`, `scope=site.enforce`, `site=https://<host>` (an origin, nothing
after it), `state`, `code_challenge` and `code_challenge_method=S256`.

**2. Answer the challenge.** Before the owner sees Approve, the gate fetches
`GET <site>/.well-known/naulon-challenge/<state>` and expects the request's `code_challenge` as
plain text. Answer it only for a `state` you have pending, on the host that connect is for, and
answer anything else with a `404` exactly like a missing page. This is what stops a connect started
for somebody else's site. Serve these two paths before your toll runs, and whether or not the site
is tolled yet: a site with no credential must still be able to get one.

**3. Exchange the code.** The owner comes back to `redirect_uri` with `state`, `iss`, and either
`code` or `error=access_denied`. Check, in this order, before you change anything:

- the pending connect for `state` exists, and when you started it for one account, this is that
  account;
- `iss` is exactly the gate the connect started with (RFC 9207). A response naming another gate,
  or none, is a mix-up: a gate that sent the owner to someone else's approval page is trying to
  collect the code. Refuse it and keep the pending connect.

Then take the pending connect atomically (exactly one request may get it), and post form-encoded to
`token_endpoint`: `grant_type=authorization_code`, `code`, `code_verifier`, `redirect_uri`,
`client_id`. If the gate could not be reached, put the pending connect back so the owner can retry.
Exchange each code once: the code is single use and lives 10 minutes, and a gate that sees one
redeemed twice revokes the credential its first redemption got. The answer:

```json
{ "access_token": "nln_site_…", "token_type": "Bearer", "scope": "site.enforce", "site": "https://blog.example.com" }
```

That is the site's credential: `nln_site_` and 43 base62 characters. It has no expiry and no
refresh token, because a runtime is often many workers sharing one stored value, and a rotating
refresh token raced across workers is how such integrations stop working without a word. It acts
for its own site and nothing else, and its owner can revoke it on the gate. Send it as
`Authorization: Bearer` on every call above. To disconnect, post `token=<credential>` to
`revocation_endpoint` (RFC 7009); it answers `200` whether or not the credential existed.

**4. Keep answering the proof.** While you hold a credential, answer
`GET <site>/.well-known/naulon-challenge/<proof>` with `<proof>` as plain text, where `<proof>` is
the lowercase hex SHA-256 of `naulon-connect-proof:` followed by the lowercase hex SHA-256 of the
credential. A gate may prove your host by the connect itself, and it fetches the proof again from
time to time; when the domain stops reaching a site that holds the credential, or the credential is
revoked, the host stops being yours on that gate. Answer any other proof with a `404`. The value is
derived, so publishing it reveals nothing about the credential.

**Older keys keep working.** A self-hosted gate's operator key, `NAULON_ENFORCE_KEY`, acts for every
site that gate serves, so keep it on servers you run. A platform that publishes a site's
`enforceKeySha256` on its record gives that site a key acting for itself only. A runtime treats
either exactly like a credential.

## Platforms with many sites

A platform that hosts many sites on one codebase (a blog host, a newsletter host, a site builder)
installs the runtime once. Each site's owner turns naulon on for their own site.

**Each owner connects their own site.** Render the start of connect as a button in the site's
settings and store the credential that comes back against that site, with the gate it came from:
a writer who runs their own gate connects to it. Your runtime sends each request to that site's
gate under that site's credential. You hold no money, no wallet and no price: the owner sets those
with the gate.

A runtime serving many sites must keep these rules:

1. **Look the credential up by host.** `credential_for(host)` in Python, `credentialFor(host)` in
   `@naulon/enforce`. The host is the request's `Host`, lowercased, port included.
2. **No credential, no toll.** A site without one is passed through untouched, with no call to the
   gate. Never fall back to a platform-wide key: that would toll an owner who never opted in.
3. **Never share an answer across credentials.** Cache the policy document and every quote by host,
   credential and gate together. A gate's JWKS and crawler ranges belong to the gate and may be
   shared by every site on it.
4. **Report under the credential of the site the report is about.** Batch reports per credential.
5. **Cache the lookup, briefly.** Thirty seconds per host is enough to spare your database and
   short enough that a changed or revoked credential lands quickly.
6. **A lookup that fails serves the page.** The fail-open rules above apply to it.
7. **A gate an owner named is untrusted.** Reach it over https only, never at a private address,
   and follow no redirects.
8. **Keep pending connects where every worker can read them, and take them atomically.** The
   worker the gate's challenge reaches may not be the one that started the connect, and two
   workers must never both exchange one code (`DELETE ... RETURNING`).
9. **Tie each connect to the account that started it.** Pass the account's id when you start it
   and require the same one when the owner comes back. Otherwise someone who started a connect can
   send its return link to another account holder, and you store their site under that account.
10. **Store the credential as a secret.** Encrypt it at rest, never render it back in full (its
   last four characters are enough to tell two apart), and never log it.

**Or run the gate for every site yourself.** A gate started with `NAULON_PLATFORM_URL` and
`NAULON_PLATFORM_KEY` asks your platform `GET <url>?host=<host>` for each site's record, validated
against [publisher-record.schema.json](./publisher-record.schema.json). Answer `404` for a site you
do not toll. Money is integer micro-USDC (`priceMicro`), and the gate keeps serving the last good
record while your platform is unreachable. Give each site its own key with `enforceKeySha256`, and
the runtime rules above apply unchanged.

## Conformance

A port is done when it passes every case in these files, generated from the gate itself:

| File | What it fixes |
|---|---|
| [access-cases.json](https://github.com/naulonapp/naulon/blob/main/packages/shared/test-fixtures/access-cases.json) | The access decision for every crawler, terms combination and rule. Its `$comment` explains the compact format |
| [scope-cases.json](https://github.com/naulonapp/naulon/blob/main/packages/shared/test-fixtures/scope-cases.json) | Which paths are tolled, and under which slug, for each scope |
| [identity-cases.json](https://github.com/naulonapp/naulon/blob/main/packages/shared/test-fixtures/identity-cases.json) | Crawler identity: a claimed crawler from the wrong network |
| [content-type-cases.json](https://github.com/naulonapp/naulon/blob/main/packages/shared/test-fixtures/content-type-cases.json) | The Content-Type to serve `/license.xml` with |
| [verdict-cases.json](https://github.com/naulonapp/naulon/blob/main/packages/shared/test-fixtures/verdict-cases.json) | The verdict and free-reason vocabularies, and the verdict to read from each body |
| [connect-cases.json](https://github.com/naulonapp/naulon/blob/main/packages/shared/test-fixtures/connect-cases.json) | Connect's wire rules: discovery, PKCE, what counts as a site origin, and the proof a connected site answers |

`npm run contract:fixtures` regenerates them, and the gate's own test suite fails when they are
stale, so a file you read is always what the gate does.

## Versions

The protocol has its own version, in the OpenAPI document's `info.version`. A runtime targets that
version, not a gate release. A change an existing runtime would break on bumps the major.
