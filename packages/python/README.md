# naulon for Python

Charge AI agents to read your site from inside your Python web app. People always read free.

`naulon` is a middleware for Django, any WSGI app and any ASGI app. It decides who is asking from a
policy it caches in the background, so a reader never waits on the network. When an AI agent asks
for an article, it answers `402 Payment Required` with a price the gate builds, and serves the
article once the agent pays in USDC. The money goes from the agent straight to your wallet: nothing
in this package can hold or move it.

No runtime dependencies. Python 3.10 or newer.

## Install

```
pip install naulon
```

Web Bot Auth signature checks (agents that sign their requests) need one extra:

```
pip install 'naulon[botauth]'
```

## Django

Add the middleware after `WhiteNoiseMiddleware` (or near the top if you have none):

```python
MIDDLEWARE = [
    # ...
    "naulon.adapters.django.NaulonMiddleware",
]

NAULON = {
    # Which responses are articles. Called only for agents, after your view ran.
    "TOLLABLE": "myapp.naulon_hooks.tollable",
}
```

```python
def tollable(request, response):
    return getattr(request, "naulon_post", None) is not None and response.status_code == 200
```

With no further settings it uses the hosted gate at `https://gate.naulon.app`. What it still needs is
your site's credential, which you get by connecting the site (below) and then set as:

```
NAULON_KEY=nln_site_...
```

## WSGI and ASGI

```python
from naulon.adapters.wsgi import NaulonWSGI
app = NaulonWSGI(app)

from naulon.adapters.asgi import NaulonASGI
app = NaulonASGI(app)
```

## Connect your site

Nobody copies a key out of a dashboard. Your site asks its gate for a credential, you approve it on
the gate, and the gate hands it back:

```python
from naulon.connect import Connect

connect = Connect(client_name="My blog")

# Behind a button in your site's settings:
started = connect.start("https://blog.example.com")
# redirect the owner to started.url

# At https://blog.example.com/naulon/connect/return, where the gate sends them back:
done = connect.finish(request.GET)
# done.credential is the site's credential; store it as a secret (NAULON_KEY for one site)
```

Before it shows Approve, the gate fetches two paths on your site: who is asking
(`/.well-known/naulon-client`) and a challenge only the process that started this connect can
answer. Pass the same `Connect` to the middleware so those paths are answered, whether or not
anything is tolled yet: `NaulonWSGI(app, connect=connect)`, or `NAULON["CONNECT"]` as a dotted path
in Django.

A pending connect lives 15 minutes in memory by default. A site served by several processes passes
a `ConnectStore` backed by its database, because the process the gate asks may not be the one that
started it. The credential acts only for the site it was approved for, and its owner can revoke it
on the gate's Sites page at any time; your readers then read free until you connect again.

## Settings

| Variable | Default | |
|---|---|---|
| `NAULON_GATE` | `https://gate.naulon.app` | The gate's URL. Change it to toll through a gate you run |
| `NAULON_KEY` | unset | The credential connect returned. Unset, nothing is tolled |
| `NAULON_ENABLED` | `1` | `0` turns the middleware into a no-op |
| `NAULON_TIMEOUT` | `2.0` | Seconds to wait for the gate on an agent request |

Django may set the same keys in `settings.NAULON` (`GATE`, `KEY`, `ENABLED`, `TIMEOUT`,
`CREDENTIAL_FOR`, `CONNECT`); the environment wins. The middleware prices the URL Django sees, so
behind a proxy that terminates TLS set `USE_X_FORWARDED_HOST = True` and
`SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")`, and only when the proxy overwrites
both headers on every request. Behind a proxy that writes the caller's address into a single-value
header, name it in `NAULON["TRUST_PROXY_HEADERS"]` (for example `"X-Real-IP"`). `X-Forwarded-For` is
refused: the caller writes its first entry.

## Platforms with many sites

If you host sites for other people, install the middleware once and let each site's owner turn it
on by connecting their own site. Render `connect.start(site_url)` as a button in their settings,
store the credential `connect.finish(...)` returns against that site, and tell the middleware how to
find it:

```python
# settings.py
NAULON = {"CREDENTIAL_FOR": "sites.naulon.credential_for", "CONNECT": "sites.naulon.connect"}

# sites/naulon.py
from naulon.connect import Connect
from naulon.sites import Site

# store: your ConnectStore (put, get, delete) over a table, shared by every worker
connect = Connect(client_name="Acme Sites", store=site_connect_store)

def credential_for(host: str) -> Site | None:
    row = SiteRow.objects.filter(domain=host).only("naulon_credential", "naulon_gate").first()
    if row is None or not row.naulon_credential:
        return None
    return Site(credential=row.naulon_credential, gate=row.naulon_gate)
```

`credential_for` may return a plain string, or a `Site` naming the gate the owner connected to: a
writer who runs their own gate connects to it, and their site is tolled there. Requests to a gate
other than the configured one go through a guarded transport (https only, no private addresses, no
redirects). WSGI and ASGI take both as arguments: `NaulonWSGI(app, credential_for=..., connect=...)`.

A site whose `credential_for` returns `None` is never touched. There is no fallback to
`NAULON_KEY`, so nobody is tolled who did not opt in. The answer is cached per host for 30 seconds;
under ASGI a lookup runs on a worker thread, never on the event loop. Every policy, quote and report
is kept per credential, so one site's answer never reaches another. The owner sets price, wallet
and mode with their gate; you store the credential and nothing else.

## Hosted or self-hosted

The gate is open source. Run it yourself and set `NAULON_GATE` to its URL, or use the hosted one.
The middleware and the connect flow are the same either way. A gate set up before connect still
accepts its `NAULON_ENFORCE_KEY` as `NAULON_KEY`.

## What it promises your site

- Your page always wins. Any error, timeout or bad answer inside naulon serves the request
  untouched.
- People never wait on the network. The policy refreshes in a background thread.
- Network calls happen only for agents, with a 2 second timeout and a circuit breaker.
- If the gate cannot answer, the page is served free.
- An agent is never charged for something that is not an article: your view runs first, and only a
  `200` your `tollable` hook accepts becomes a `402`.
- The response body is never read or rewritten. A paid read only gains headers.
- Every `402` and every paid `200` is marked `Cache-Control: private, no-store`.
- New sites start in observe mode: decisions are recorded and every request is served.

The wire protocol, for writing a runtime in another language:
[docs/protocol/in-app.md](https://github.com/naulonapp/naulon/blob/main/docs/protocol/in-app.md).

MIT licensed.
