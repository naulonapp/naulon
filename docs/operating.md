# Operating your gate — the dashboard

You run `naulon` as a reverse proxy in front of your site. Humans pass through
free; machines pay to read or cite. The **operator console** is how you see that
happening: is the gate up, who's being served or blocked, what's settling, and is
your config right. It's read-only — you don't configure anything here, you watch.

Start it alongside the gate:

```
npm run -w @naulon/dashboard dev      # → http://127.0.0.1:8403
```

By default it binds `127.0.0.1`, so only the box owner sees it. That's the private
ops console. Point a browser at it and you get five things.

The sidebar carries seven pages in four groups — **Overview**; **Requests** and
**Agents** under Traffic; **Ledger** under Money; **Content**, **Crawlers**,
**Webhooks** and **Doctor** under Config — and at its foot, the live gate state.

- **Requests** — every decision the gate made, including the ones that earned nothing,
  with missed earnings broken down by cause. The settlement ledger cannot show you this
  half: it only knows about reads that paid.
- **Agents** — who is reading and how much of that you can trust. A user-agent is a
  claim anyone can make; a Web Bot Auth signature is not, and this page separates them.
- **Crawlers** — the per-crawler decision (read free, pay, or refused) and your own
  rules on top of the defaults. Contract: [crawler-policy.md](./crawler-policy.md).
- **Webhooks** — endpoints and their delivery log, for telling your systems a citation
  settled. Contract: [settlement-notifications.md](./settlement-notifications.md).

## What each panel tells you

**Gate state** (sidebar, bottom). A ping to the gate's `/healthz`. "gate up" means
the proxy is answering. "gate down" means the console can reach itself but not the
gate — check the gate process and `GATE_URL`.

**The stat strip.** Traffic over the last 24h, straight from the gate's observation
log:

- **served free** — humans and allow-listed crawlers, passed through untolled.
- **denied** — agents that got a 402 and walked away. This is scraping you stopped.
- **blocked** — refused outright, without a price being offered.
- **paid** — agents that settled and were served.
- **payment failed** — an agent presented payment that failed verify/settle. A few
  is normal (a bad signer); a spike is worth investigating.
- **earned · missed** — USDC you captured, and the price of everything `denied`
  (what you'd have earned if they'd paid). Missed climbing means demand you're not
  converting yet.

**Recent requests.** The live feed — one row per gated request: when, the slug, who
(a verified agent shows its operator, e.g. `✓ chatgpt.com`; an unsigned one shows
its user-agent; a forged signature shows `spoofed signature`), and the verdict,
colour-coded. This is where you watch the toll work in real time.

**Config.** The effective config the gate loaded, so you can confirm it's right:
your origin, the price, the credits source, how many articles are tollable and the
wallets they pay, and whether the observation + event logs are on. If something's
off here, your gate isn't doing what you think.

**Warnings.** Misconfig that quietly under-performs — the commonest being the
observation log switched off, which leaves the traffic panel blank.

## "Is it actually tolling?" — Doctor and Test toll

Two things answer the questions everyone has on day one.

**Test toll** (a button on Overview and on Doctor) asks *your* gate for one of *your*
tollable articles while pretending to be a crawler, and shows you exactly what came
back:

```
402 Payment Required, with a signed quote. The toll works.
GET http://127.0.0.1:8402/essays/on-stillness → 402 · agent (user-agent matched "gptbot") · 3ms
```

Anything other than a 402 is diagnosed rather than dumped. A `200` means the gate
served a crawler for free, and it names the three real causes in the order they
actually occur: the path isn't under `ARTICLE_PATH_PREFIXES`, the slug isn't in your
credits source, or a `crawlerPolicy` is allow-listing that user-agent. A redirect
means an edge is answering before the gate does. A `502` means the gate is up but
your origin isn't.

The probe leaves a real observation behind — it genuinely asked and was genuinely
refused — so it shows up in Recent requests tagged **self-test**. That's deliberate:
those rows are real denials and they do count toward "missed", and you should be able
to tell which ones were you.

**Doctor** (`/doctor`) is the preflight: every condition that decides whether this
gate can earn, each with the fix attached, and passing checks shown too so you can
see the thing is configured rather than merely quiet. It checks the gate, your
origin, whether anything is tollable at all, both logs, the price, whether settlement
is live or mocked, whether the gate is serving credits you've since edited, and
whether the console itself is over-exposed.

It reads config and GETs addresses that came from that config. It never writes,
spends, or settles.

## Where articles, wallets, and prices come from

Not the dashboard — that would defeat the point (the gate never holds your keys or
your content). You declare them in your **credits source**, and the console just
reflects what loaded:

- A static `credits.json` (see `examples/meridian/credits.json`): a map of
  `slug → { title, contributors: [{ authorId, wallet, weight }] }`. Point
  `CREDITS_FIXTURES` at it. `weight` splits a toll across co-authors.
- Or a live endpoint — set `CREDITS_API_URL` to your CMS serving `/credits/:slug`.
  The article list is then dynamic and won't enumerate in the console.

Price is `DEFAULT_PRICE_USDC` per read, times `CITATION_MULTIPLIER` for a citation.
Credits are validated when loaded — a malformed source is rejected, never settled.

`npx naulon init` scaffolds a starter `.env` + `credits.json` if you're starting
from scratch.

## Managing credits without the CLI — the Content tab

You don't hand-write `credits.json`. The console's **Content** tab does it in the
browser, over the same crawl + validation engine as `naulon-kit crawl` (one
engine, two front-doors — they can't drift):

1. **Scan site** reads your sitemap/RSS/WordPress and lists your articles.
2. Fill in the **payout wallet** per article — the one thing no crawler can
   supply, since only you know who gets paid. An article with >1 payee (a split)
   shows read-only and is preserved verbatim; edit those in the file.
3. **Save** validates every wallet and writes `credits.json` (backing up the old
   to `credits.json.bak`). One bad wallet rejects the whole save — a typo can't
   half-write a payout map.

Two things to know: edits apply on the **next gate restart** (the file is read at
boot), and this manager is a **write surface**, so it's served only in the private
or authed modes — never in public mode, and cross-origin writes are refused. If
your credits come from a live API (`CREDITS_API_URL`), edit them at your CMS; the
tab tells you so.

## Turning the traffic panel on

The gate records nothing by default. To populate the stat strip and the request feed:

```
OBSERVATIONS_BACKEND=jsonl            # writes to data/observations.jsonl
```

Observations are telemetry only — they never gate a request or move money. The
console reads that file; the earnings figures and the ledger read the event log
(`EVENTS_BACKEND`, on by default).

**Know what the `jsonl` backend costs before you leave it on.** It appends one line
per gated request and never rotates or expires anything, and the console re-reads and
re-parses the *whole* file every second while an Overview tab is open. That is fine for
a box serving thousands of gated requests and it is not fine at millions — the file
grows without bound and the console gets slower in step with it. Today it is on you to
prune or rotate `data/observations.jsonl`. This is the reason the default is `off`
rather than an excess of caution; if you want recording that stays cheap at volume,
point `OBSERVATIONS_BACKEND` at `supabase`, where retention is the table's problem and
the console is not reading a growing file to answer a poll.

## Exposing it safely

The console shows wallets, earnings, and traffic. It must not face the open
internet by accident, so exposure is deliberate:

| You want | Set | Result |
|---|---|---|
| **Private** (default) | `DASHBOARD_BIND=127.0.0.1`, no credential | Full ops, box owner only. |
| **Remote ops** | `DASHBOARD_AUTH=user:secret` (+ a wide bind, or a named host below) | Full ops behind HTTP Basic. |
| **Public proof** | `DASHBOARD_PUBLIC=true` | Only the earnings page — wallets masked, every ops panel hidden. |

### Sign-in: operator accounts

`DASHBOARD_AUTH` is one credential shared by everyone who has it. It cannot tell you who
ran a test toll, it cannot be revoked for one person, and rotating it signs out everybody
at once. So the console has accounts.

Open `/setup` on a fresh console and create the first administrator. From then on:

- Browsers sign in at `/login` and get a session cookie — `HttpOnly`, `SameSite=Strict`,
  and `__Host-`+`Secure` whenever the console is actually served over HTTPS.
- `/account` is where you change your password, sign out, and (as an administrator) add or
  disable operators. There is no self-signup, deliberately.
- Two roles. `viewer` reads every panel; `admin` may also run the six ops writes (test
  toll, content, crawlers, webhook ping and resend).
- Every sign-in, sign-out, account change and refusal is appended to
  `console-audit.jsonl`, beside the state file. That log is the reason accounts exist.

Containers can skip the interactive first run with `CONSOLE_ADMIN_PASSWORD` (plus
`CONSOLE_ADMIN_USERNAME`). That account has to change its password before the console
will render anything else — a password that came out of the environment is a bootstrap
value, not a credential.

Sessions live in `console.json` (mode 0600) beside your event ledger, and the token is
stored only as a hash, so a copy of that file is not a set of live sessions. Put it on the
volume you already mount or sign-ins reset on every restart. A read-only filesystem — the
serverless entrypoint, for instance — cannot hold sessions at all; there, `DASHBOARD_AUTH`
stays the only way in, and the console says so at boot.

**Upgrading changes nothing until you create an account.** A console with `DASHBOARD_AUTH`
and no accounts behaves exactly as it did before, browsers included. Once accounts exist,
that credential becomes a MACHINE credential: it answers API requests for scripts and CI,
it is refused for browser navigation (sign in instead), and it is a `viewer` unless you set
`DASHBOARD_AUTH_ROLE=admin`.

### Don't store the password

The secret half of `DASHBOARD_AUTH` may be a scrypt hash instead of the password itself:

```
npm run hash -w @naulon/dashboard -- --user ops
Console password: (not echoed)
DASHBOARD_AUTH=ops:$scrypt$ln=15,r=8,p=1$...
```

Paste that line into `.env`. Basic still sends the password over the wire on every
request — that is the protocol, and it is why HTTPS is not optional here — but the
password no longer sits in your `.env`, your compose file, your secret store or a
`docker inspect`. A plaintext secret keeps working and prints a warning at every boot.

Hashing costs ~100 ms by design, and Basic re-authenticates on every request, so a
verified credential is cached in memory for 60 s. A REJECTED one never is, which is what
keeps the failed-sign-in budget below seeing every guess.

Setting `DASHBOARD_AUTH` always enforces it, loopback or not. If you share the box —
a container on the same network namespace, another user with an SSH tunnel, anything
else that can reach `127.0.0.1` — that is how you keep the ops plane to yourself; a
loopback bind is not a boundary between users on one machine.

A credential that is *set but unreadable* — `ops:` with no secret, a value with no colon,
a quoting accident — also refuses to serve, loopback included. It used to fall through to
the private console: full ops, no credential, and a boot line that said `[private]`.

Make the console reachable with neither auth nor public set and it **refuses to
serve** — it won't leak wallets because you fat-fingered a bind. For real exposure,
HTTP Basic is the floor; put it behind your own reverse proxy (Caddy, nginx) or an
access gateway if you want more.

"Reachable" means more than a wide bind, because `DASHBOARD_BIND` describes a socket
and two real deployments have no socket to describe. A serverless host never calls
`listen`, so the loopback default survives untouched while the console answers the
open internet; a reverse proxy in front of a loopback bind is the same shape. Both
announce themselves by needing a non-loopback name in `DASHBOARD_ALLOWED_HOSTS`
(below) — so naming one is what counts as reachable, and doing it without a
credential is refused.

Failed sign-ins are metered per client (`DASHBOARD_AUTH_FAIL_RPM`, default 20/min,
burst 10): Basic auth has no lockout of its own, so without that the password can be
guessed at network speed. Only the rejections are charged, so using the console
heavily — however hard you click — can never lock you out of it.

If a deployment genuinely cannot tell callers apart (no socket and no forwarded
address), the budget is shared across them rather than switched off, and the 429 says
so. Sharing it means guesses from one caller can make another wait; that is a paused
ops view, against an unlimited guessing rate at a page holding your wallets, and it
resolves as soon as the forwarded address is readable.

### Why "it's on 127.0.0.1" isn't the whole story

A loopback bind has no authentication — that's the point of the private mode, and
it's fine against the network. It is *not* fine against your own browser. A page you
visit can register a hostname, re-point it at `127.0.0.1`, and fetch the dashboard;
the browser treats that as same-origin, so nothing is blocked and the attacker's
script reads the response. That's DNS rebinding, and it's how "private" consoles
leak.

So the private console answers only to loopback hostnames. If you front a
loopback-bound dashboard with a reverse proxy, name it — and give it a credential in
the same breath:

```
DASHBOARD_ALLOWED_HOSTS=ops.example.com,dash.internal
DASHBOARD_AUTH=user:pass
```

Naming a non-loopback host is you telling naulon that something outside this box can
address the console, so it stops treating the loopback bind as evidence of privacy
and asks for a credential. Only naming loopback aliases (`localhost`, `::1`) keeps
private mode as-is.

Anything not on the list gets a `403` naming the Host it refused. Authed mode skips
the check — Basic already defeats rebinding, since your browser holds no credential
for the attacker's origin — and so does public mode, which serves nothing worth
stealing.

The public page (`DASHBOARD_PUBLIC=true`, or `/ledger` from the ops console) is the
shareable "authors are earning" view — the same live ledger with addresses
truncated and nothing operational on it. It carries no console navigation, so it
doesn't advertise routes it won't serve.

Every byte the console loads comes off your own box. Its fonts ship in
`packages/dashboard/src/public/fonts` (SIL OFL), so it runs under a strict
`default-src 'self'` CSP and never calls a CDN — an air-gapped box serves it
exactly as a connected one does.
