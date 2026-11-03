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

Then point it at a gate:

```
NAULON_GATE=https://gate.your-site.com
NAULON_KEY=<your enforce key>
```

## WSGI and ASGI

```python
from naulon.adapters.wsgi import NaulonWSGI
app = NaulonWSGI(app)

from naulon.adapters.asgi import NaulonASGI
app = NaulonASGI(app)
```

## Settings

| Variable | Default | |
|---|---|---|
| `NAULON_GATE` | unset | The gate's URL. Unset, the middleware does nothing |
| `NAULON_KEY` | unset | The enforce key the gate gave you |
| `NAULON_ENABLED` | `1` | `0` turns the middleware into a no-op |
| `NAULON_TIMEOUT` | `2.0` | Seconds to wait for the gate on an agent request |

Django may set the same keys in `settings.NAULON` (`GATE`, `KEY`, `ENABLED`, `TIMEOUT`); the
environment wins. The middleware prices the URL Django sees, so behind a proxy that terminates TLS set
`USE_X_FORWARDED_HOST = True` and `SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")`,
and only when the proxy overwrites both headers on every request. Behind a proxy that writes the caller's address into a single-value header, name
it in `NAULON["TRUST_PROXY_HEADERS"]` (for example `"X-Real-IP"`). `X-Forwarded-For` is refused:
the caller writes its first entry.

## Hosted or self-hosted

The gate is open source. Run it yourself with `NAULON_ENFORCE_KEY` set, or use the hosted one at
`https://gate.naulon.app` with the key from your dashboard. The middleware is the same either way.

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
