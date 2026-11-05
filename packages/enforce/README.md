# @naulon/enforce

The runtime-agnostic toll-decision kernel plus the in-app enforcement middleware.

This is the neutral low-level core that both `@naulon/tollgate` (the gate shell, the
reverse-proxy that boots `createApp`) and `@naulon/sdk` (the publisher SDK)
sit **above**, with no dependency cycle. It depends only on `@naulon/shared` (and
`viem`, for the holder-of-key proof). The heavy settlement path, the Circle
facilitator and the pending-leg drain, stays in `@naulon/tollgate`; nothing here
imports `@circle-fin/x402-batching`.

## Why it exists

`decide()` is one pure function: given a web `Request` and a known publisher, it
returns a verdict, whether serve free, refuse, or `402` with the payment legs, and
performs **no** side effects (no proxy, no settle, no observe). Extracting it lets
two very different runtimes reach the *same* verdict:

- **The gate** (`@naulon/tollgate`) runs `decide()` inside its Hono reverse proxy.
- **In-app middleware** runs the *identical* `decide()` in the publisher's own app,
  so an agent's request reaches the origin directly instead of routing through the
  fleet's single egress IP (which an origin edge can rate-limit).

Both build a byte-identical `402`, because they share this code.

## Exports

### `@naulon/enforce`

The decision kernel and the framework-agnostic middleware core:

- `decide(input)`: the pure verdict function. It also honors `PublisherConfig.termsPolicy`
  (`@naulon/shared`): a publisher who declares `ai-input: "free"` gets every agent read served
  free, and `"prohibit"` refuses a recognized AI crawler outright, both ahead of pricing. The
  `/.well-known/x402` manifest reflects the same declaration through `agentReads`. Absent
  `termsPolicy` behaves exactly as before; the single-tenant `envPublisherResolver` never sets
  it; a `PublisherResolver` you write is how you would.
- `naulonMiddleware(opts)` takes a `Request` and returns `{ response, setHeaders }`:
  a `Response` to short-circuit (`402`/`403`), or `null` to let the app render
  (with `setHeaders` to attach to the app's response on a paid pass).
  When the publisher's configuration names a licence server
  (`PublisherConfig.licenceServer`), a crawler presenting `Authorization: License` is checked
  there: the middleware forwards the licence and the crawler's Web Bot Auth signature to the
  server's `/introspect` and passes only when it answers `permitted`. Any other answer is the
  ordinary 402, with the reason in the body's `licence_error`, except a charge already in
  flight or unconfirmed, which is a 503 with no x402 offer. The server must share an origin
  with `verifyUrl`, because the check carries your API key.
  When the gate gives no verdict at all (the licence server or `/verify` is unreachable,
  answers 5xx, or answers 2xx without one, or the gate's keys were never fetched), the page is
  served, logged with `console.error`, and marked `X-Naulon-Verdict: served free (<step>
  unavailable)`. A 4xx is an answer, so it never serves the page.
- `naulonSite()`: the middleware for one site, configured like the Python package. It reads
  `NAULON_KEY` (the credential connect returned) and `NAULON_GATE` (default
  `https://gate.naulon.app`), and asks the gate for everything else. See
  [Connect your site](#connect-your-site).
- `naulonSites({ credentialFor })`: the same middleware for a platform that hosts many
  sites. `credentialFor(host)` returns what that site's owner connected, or `null`; see
  [Platforms with many sites](#platforms-with-many-sites).
- `naulonConnect({ clientName, site })` (or `authorizeSite` on a platform): the runtime's half of connect: `start` sends the owner to
  their gate, `finish` exchanges the code for the site's credential, and `wellKnown` answers
  the two paths the gate checks on the site first.
- `naulonNode(toll)` serves Express, Connect and `node:http` with any of the above.
- `withNaulon(handler, opts)` wraps a generic `fetch` handler. It and the Next adapter take
  either options or a built middleware (`naulonMiddleware(...)` or `naulonSites(...)`).
- `localQuoteSource(fn)` / `httpQuoteSource(url, key)`: pluggable price and payees.
- `httpPublisherConfigSource(url, key)`: what is tolled and for whom, read from the
  control plane and cached per host. It also carries your `/.well-known/x402` manifest
  and your RSL licence, which `serveX402Manifest` and `serveRslDocument` turn into
  routes if the middleware cannot reach those paths.
- The classification, Web Bot Auth, nonce, and proof primitives (`classify`,
  `verifyBotAuth`, …) and the x402 build side (`build402`, `buildRequirements`).
- Cloudflare pay-per-crawl interop: `formatCrawlerPrice`, `parseCrawlerPrice`,
  `declaredCrawlerBudget`, `crawlerBudgetVerdict`, `totalChargedMicro`, and the four
  header constants (`crawler-max-price` / `crawler-exact-price` on the request,
  `crawler-price` on a `402`, `crawler-charged` on a paid `200`). A crawler already
  fluent in that vocabulary can price your origin with no change on its side. You
  advertise in their vocabulary and settle in ours, x402 over USDC, buyer to author, so
  nothing here moves money or changes who is charged. Prices render at full precision
  rather than Cloudflare's `USD XX.XX`: a citation toll is often sub-cent, and
  `(0.001).toFixed(2)` would advertise a free read. It lives here rather than in
  `tollgate` so a self-hosting publisher on the SDK gets it too.

### `@naulon/enforce/next`

- `createNaulonMiddleware(opts, NextResponse)`: the Next.js App Router adapter.
  It has no hard `next` dependency; you inject `NextResponse` (your app already has
  it), keeping the core framework-agnostic.

## Usage

```ts
// proxy.ts (Next.js App Router; `middleware.ts` on Next ≤ 15)
import { NextResponse } from "next/server";
import { createNaulonMiddleware } from "@naulon/enforce/next";
import { httpPublisherConfigSource, httpQuoteSource } from "@naulon/enforce";

const plane = "https://<your-control-plane>";
const key = process.env.NAULON_API_KEY!;

export const proxy = createNaulonMiddleware(
  {
    publisher: { id: "your-site", articlePrefixes: ["articles"] },
    config: httpPublisherConfigSource(`${plane}/_naulon/enforce-config`, key),
    quote: httpQuoteSource(`${plane}/_naulon/quote`, key),
    verifyUrl: `${plane}/_naulon/verify`,
    apiKey: key,
  },
  NextResponse,
);

export const config = { matcher: ["/articles/:path*", "/license.xml", "/.well-known/x402"] };
```

`config` is optional but worth passing. It makes the dashboard the source of what is
tolled, so a scope or crawler-policy change reaches your site without a deploy, and it
is what lets the middleware answer `GET /license.xml` with your RSL licence and
`GET /.well-known/x402` with your payment manifest, before any toll decision. Every 402
links an agent to that manifest, so keep both paths in your matcher when you narrow it.
With `config` omitted, or with `serveLicense: false` / `serveManifest: false`, the
request passes through to your app.

Next 16 renamed the file convention: `middleware.ts` still runs but warns
(`The "middleware" file convention is deprecated. Please use "proxy" instead.`),
and the export it looks for is `proxy`. On Next ≤ 15 keep the file `middleware.ts`
and export `middleware`. The adapter itself is identical either way.

`quote` and `verifyUrl` point at whatever runs the money and catalog legs: the
managed control plane, or your own self-hosted `POST /_naulon/verify` +
`GET /_naulon/quote`. The middleware never holds funds: it forwards the buyer's
signed payment to `verifyUrl`, which settles buyer → author directly.

## Connect your site

Nobody copies a key out of a dashboard. Your site asks its gate for a credential, you approve it on
the gate, and the gate hands it back:

```ts
import express from "express";
import { naulonConnect, naulonNode, naulonSite } from "@naulon/enforce";

const connect = naulonConnect({ clientName: "My blog", site: "https://blog.example.com" });
const app = express();

// Answers the connect paths, then tolls once NAULON_KEY is set.
app.use(naulonNode(naulonSite({ connect })));

// Behind a button in your settings:
app.post("/admin/naulon/connect", async (_req, res) => {
  const r = await connect.start({ site: "https://blog.example.com" });
  r.ok ? res.redirect(303, r.url) : res.status(400).send(r.error);
});

// Where the gate sends you back:
app.get("/naulon/connect/return", async (req, res) => {
  const r = await connect.finish(new URL(req.url, "https://blog.example.com").searchParams);
  // r.credential is this site's credential: store it as a secret, as NAULON_KEY.
  res.send(r.ok ? "Connected." : r.message);
});
```

Before it shows Approve, the gate fetches `/.well-known/naulon-client` (who is asking) and a
challenge only the process that started this connect can answer, so the connect paths are answered
whether or not anything is tolled yet. A pending connect lives 15 minutes in memory; a site served
by several processes passes a `ConnectStore` backed by its database, whose `take` must be atomic
(`DELETE ... RETURNING`) so two workers never exchange one code. The credential acts only for
the site it was approved for. Its owner can revoke it on the gate's Sites page at any time, and your
readers then read free until you connect again.

To toll through a gate you run, set `NAULON_GATE` to its URL. A gate set up before connect still
accepts its `NAULON_ENFORCE_KEY` as `NAULON_KEY`.

### From a terminal beside the app

A site with no settings page of its own can connect from the server it runs on. Wire the app once:

```ts
app.use(naulonNode(naulonSite({ connect: { clientName: "My blog" } })));
```

then, in the app's directory, with the app running:

```
npx naulon connect --site https://blog.example.com
```

The command prints an address to approve at; open it on any device, a phone works over SSH. The
gate checks the running app before it shows Approve, and the app finishes the return itself and
keeps the credential in `.naulon/credential` (owner-only files; `NAULON_DIR` moves it). It starts
tolling without a restart, and `NAULON_KEY`, when set, pins a credential instead. Add `.naulon/` to
your `.gitignore`: it holds a secret.

## Platforms with many sites

If you host sites for other people, install this once and let each site's owner turn it on by
connecting their own site. Render `connect.start({ site, binding: account.id })` as a button in
their settings, finish with `connect.finish(query, { binding: account.id })`, store the credential
it returns against that site, and tell the middleware how to find it. The binding is what stops
someone sending their own connect's return link to another account holder.

`authorizeSite` is required, and it is the one check only you can make. Approving a connect proves
the domain to the gate, and your runtime answers the gate's challenge for every site it serves, so
without it one account could start a connect for another account's site and own its domain. Answer
it from your own record of who owns which site:

```ts
import { naulonConnect, naulonSites, withNaulon } from "@naulon/enforce";

const connect = naulonConnect({
  clientName: "Acme Sites",
  store: siteConnectStore,
  authorizeSite: async (site, accountId) => (await db.site.findUnique({ where: { origin: site } }))?.ownerId === accountId,
});
const toll = naulonSites({
  connect,
  credentialFor: async (host) => {
    const site = await db.site.findUnique({ where: { host } });
    return site?.naulonCredential ? { credential: site.naulonCredential, gate: site.naulonGate ?? undefined } : null;
  },
});

export default { fetch: withNaulon(app.fetch, toll) };
```

`credentialFor` may return a plain string, or `{ credential, gate }` naming the gate the owner
connected to: a writer who runs their own gate connects to it, and their site is tolled there.
Requests to a gate other than yours go through a guarded fetch (https only, no private addresses,
no redirects followed).

A site whose `credentialFor` answers `null` is never touched, and there is no platform-wide
credential to fall back to. Each site gets its own policy, quotes and reports under its own
credential; a gate's keys and crawler ranges are fetched once for all the sites on it.
`credentialFor` is asked about once per host every 30 seconds (`credentialTtlMs`), and engines are
kept for the 1,000 most recently active sites (`maxSites`). A `credentialFor` that throws serves
the page. The owner sets price, wallet and mode with their gate; you store only the credential, as
a secret.

## Observe mode

Set `tollMode: "observe"` on the publisher to see which agents read what before you charge
anyone. Every decision runs as usual: the request is classified, the crawler's identity is checked
and the read is priced. The read is then served instead of answered with a 402, and reported as a
`denied` observation with `observeOnly: true` and the price it would have paid.

- No payment is taken. A request that presents one is served without settling and reported with
  `paymentPresented: true`. A presented licence is not redeemed either.
- Explicit blocks and prohibited uses are still refused with a 403. Observe stops charging, never a
  refusal you configured.
- When a crawler states a ceiling with `crawler-max-price` or `crawler-exact-price`, the
  observation records `crawlerBudget: "within"` or `"over"`. That is the closest thing to "this
  agent would have paid" a site can measure without asking it to. Charge mode records it too.
- A read with nobody to pay yet is still priced while observing, so you can observe before you set up
  a wallet. Charging in that state serves the read free, as it always has.
- Unset means `charge`, so upgrading changes nothing until you opt in.

Reports go out one request each by default. On a runtime that can keep working after the response
is sent, batch them with `batchingObservationSink` and hand it the runtime's `waitUntil`:

```ts
import { after } from "next/server";
import { batchingObservationSink } from "@naulon/enforce";

const observe = batchingObservationSink(`${plane}/_naulon/observe`, key, { waitUntil: after });
```

Without `waitUntil` it sends each report immediately, like `httpObservationSink`.

## Crawler identity

A user-agent is free text. A scraper that sends `Googlebot/2.1` on a site that lets Googlebot read
free would otherwise read free too. The middleware checks a request that names a known crawler
against that operator's published IP ranges, which it reads from your gate at
`/.well-known/naulon/crawler-ranges.json` (cached for an hour, fetched only when a crawler asks).

Nothing changes on day one. Every claim is checked and reported (`identityCheck` on each
observation), and a forged claim only loses its free read once your control plane has seen that
operator's real crawler at verified addresses: 20 times within 14 days. That is the proof your
site reads the caller's address correctly. A misconfigured setup sees every real crawler as
forged, so it never reaches that point, and no publisher gets deindexed by a header mix-up.

The address comes from your platform's edge header, detected from its environment:

| Platform | Header read | Set `clientIp` |
|---|---|---|
| Vercel | `x-vercel-forwarded-for`, then `x-real-ip` | nothing |
| Netlify functions | `x-nf-client-connection-ip` | nothing (Netlify Edge has no header, so claims there stay unverified) |
| Cloudflare Workers | `cf-connecting-ipv6`, then `cf-connecting-ip` | nothing |
| Cloudflare in front of another platform | `cf-connecting-ipv6`, then `cf-connecting-ip` | `"cloudflare"` |
| Any other edge | the header you name | `{ header: "x-client-ip" }` |

```ts
naulonMiddleware({
  config,
  quote,
  verifyUrl: `${plane}/_naulon/verify`,
  apiKey: process.env.NAULON_API_KEY!,
  clientIp: "cloudflare",
});
```

`clientIp: "none"` or `crawlerRanges: false` turns the check's inputs off, so every claim reads
`unverified` and nothing changes. `crawlerPolicy.forged: "block"` answers a forged claim with the
403 a blocked crawler gets instead of the 402. `identityMode: "off"` skips the check entirely.

## Layering

Arrows point to what a package depends on:

```mermaid
flowchart TD
    tollgate["@naulon/tollgate<br/><i>gate shell: runs decide() in its reverse proxy</i>"] --> enforce
    enforce["@naulon/enforce<br/><i>this package: decision kernel + middleware</i>"] --> shared["@naulon/shared"]
```

A publisher vendors `@naulon/enforce` directly (it builds to its own `dist/`
tarball) and wires the middleware; the gate consumes the very same package, which
is what guarantees both reach an identical verdict. `@naulon/enforce` is
deliberately NOT re-exported through `@naulon/sdk`, because `@naulon/shared` imports the SDK
and re-exports it, so an `sdk → enforce` edge would close the loop
`sdk → enforce → shared → sdk`, a declaration-build cycle. Keeping enforce standalone
(a second, small dependency alongside the SDK) avoids that and keeps the package
graph a clean chain.
