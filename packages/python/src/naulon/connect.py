"""Connect: how a site gets its credential from its gate without anyone copying a secret.

The site's owner is sent to their gate to approve; the gate first fetches two paths on the site
itself, the client's metadata and the challenge for this connect, and only a runtime that started
the connect answers them. Approving returns the owner to the site with a code, which this module
exchanges for the site's credential.

    connect = Connect(client_name="My blog")
    # A button in the site's settings:
    started = connect.start("https://blog.example.com")
    # At {site}{return_path}, where the gate sends the owner back:
    done = connect.finish(query)  # done.credential, done.site, done.gate
    # Every request, before the toll (the middleware does this when given `connect=`):
    answer = connect.well_known(host, path, method)

The wire rules (discovery, PKCE, what a site origin is) are held to the same answers as the TypeScript
and PHP runtimes by `packages/shared/test-fixtures/connect-cases.json`.
"""

from __future__ import annotations

import base64
import hashlib
import html
import json
import re
import secrets
import threading
import time
import urllib.parse
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

from naulon import ip
from naulon.transport import GuardedTransport, Transport

DEFAULT_GATE = "https://gate.naulon.app"
DISCOVERY_PATH = "/.well-known/naulon"
CHALLENGE_PATH = "/.well-known/naulon-challenge/"
CLIENT_METADATA_PATH = "/.well-known/naulon-client"
PROTOCOL = "naulon/1"
SITE_SCOPE = "site.enforce"
PENDING_TTL_S = 15 * 60.0
MAX_PENDING = 1_000

_STATE = re.compile(r"[A-Za-z0-9\-_]{22,128}\Z")
_VERIFIER = re.compile(r"[A-Za-z0-9\-._~]{43,128}\Z")
_CREDENTIAL = re.compile(r"nln_site_[0-9A-Za-z]{43}\Z")


def is_connect_path(path: str) -> bool:
    """Whether a path is one of the two this module answers. Cheap, so a framework can skip a thread
    hop for every other request."""
    return path == CLIENT_METADATA_PATH or path.startswith(CHALLENGE_PATH)


def is_loopback_hostname(hostname: str) -> bool:
    """`localhost`, any of 127.0.0.0/8, or `::1`: an address that can only mean this machine."""
    h = hostname.lower().strip("[]")
    if h in ("localhost", "::1"):
        return True
    a = ip.parse(h)
    return a is not None and a.family == 4 and a.raw[0] == 127


def origin_of(raw: str) -> str | None:
    """An origin with no path, query or credentials. Plain http is accepted only on loopback."""
    try:
        u = urllib.parse.urlsplit(raw.strip())
        port = u.port
    except ValueError:
        return None
    host = u.hostname
    if not host or u.username or u.password:
        return None
    if u.scheme != "https" and not (u.scheme == "http" and is_loopback_hostname(host)):
        return None
    default = 443 if u.scheme == "https" else 80
    netloc = f"[{host}]" if ":" in host else host
    return f"{u.scheme}://{netloc}{'' if port in (None, default) else f':{port}'}"


def site_origin(raw: str) -> str | None:
    """The origin a site is connected as. Anything after the origin makes it not one."""
    origin = origin_of(raw)
    if origin is None:
        return None
    u = urllib.parse.urlsplit(raw.strip())
    return origin if u.path in ("", "/") and not u.query and not u.fragment else None


def code_challenge(verifier: str) -> str:
    if not _VERIFIER.match(verifier):
        raise ValueError("code_verifier must be 43 to 128 unreserved characters")
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def is_state(value: str) -> bool:
    return bool(_STATE.match(value))


def is_site_credential(value: str) -> bool:
    return bool(_CREDENTIAL.match(value))


@dataclass(frozen=True)
class Discovery:
    issuer: str
    enforce_api: str
    authorization_endpoint: str
    token_endpoint: str
    revocation_endpoint: str
    jwks_uri: str
    network_member: bool


def parse_discovery(body: object, gate: str) -> Discovery | str:
    """A discovery document fetched from `gate`, or why it is not one. Unknown fields are ignored. The
    issuer must be the gate asked, and every endpoint a runtime sends its credential to must share it."""
    expected = origin_of(gate)
    if expected is None:
        return "the gate URL must be https"
    if not isinstance(body, dict):
        return "not a naulon discovery document: body"
    d: Mapping[str, Any] = body
    endpoints = ("enforce_api", "authorization_endpoint", "token_endpoint", "revocation_endpoint", "jwks_uri")
    for k in ("issuer", *endpoints):
        if not isinstance(d.get(k), str):
            return f"not a naulon discovery document: {k}"
    if d.get("protocol") != PROTOCOL:
        return "not a naulon discovery document: protocol"
    for k in endpoints:
        if origin_of(d[k]) is None:
            return f"not a naulon discovery document: {k}"
    if d.get("challenge_path") != CHALLENGE_PATH:
        return "not a naulon discovery document: challenge_path"
    methods = d.get("code_challenge_methods_supported")
    if not isinstance(methods, list) or "S256" not in methods:
        return "not a naulon discovery document: code_challenge_methods_supported"
    if d.get("client_id_metadata_document_supported") is not True:
        return "not a naulon discovery document: client_id_metadata_document_supported"
    if d.get("authorization_response_iss_parameter_supported") is not True:
        return "not a naulon discovery document: authorization_response_iss_parameter_supported"
    network = d.get("network")
    if not isinstance(network, dict) or not isinstance(network.get("member"), bool):
        return "not a naulon discovery document: network"
    if d["issuer"] != expected:
        return f"issuer {d['issuer']} does not match {expected}"
    for k in ("enforce_api", "token_endpoint", "revocation_endpoint", "jwks_uri"):
        if origin_of(d[k]) != expected:
            return f"{k} is not on {expected}"
    return Discovery(
        issuer=d["issuer"],
        enforce_api=d["enforce_api"],
        authorization_endpoint=d["authorization_endpoint"],
        token_endpoint=d["token_endpoint"],
        revocation_endpoint=d["revocation_endpoint"],
        jwks_uri=d["jwks_uri"],
        network_member=network["member"],
    )


@dataclass(frozen=True)
class PendingConnect:
    site: str
    gate: str
    verifier: str = field(repr=False)
    challenge: str
    redirect_uri: str
    expires_at: float
    binding: str | None = None


class ConnectStore(Protocol):
    """Where a started connect waits for its owner to come back. A site served by several processes,
    or a platform, passes one backed by its own database: the process that answers the gate's
    challenge may not be the one that started the connect.

    `take` must be atomic: of two callers taking one state, exactly one gets it (`DELETE ... RETURNING`
    in a database). It keeps a refreshed return page, or two workers, from exchanging one code twice,
    which the gate answers by revoking the credential the first exchange got."""

    def put(self, state: str, pending: PendingConnect) -> None: ...
    def get(self, state: str) -> PendingConnect | None: ...
    def take(self, state: str) -> PendingConnect | None: ...


class MemoryConnectStore:
    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._rows: dict[str, PendingConnect] = {}

    def put(self, state: str, pending: PendingConnect) -> None:
        with self._lock:
            now = self._clock()
            for k in [k for k, v in self._rows.items() if v.expires_at <= now]:
                del self._rows[k]
            while len(self._rows) >= MAX_PENDING:
                del self._rows[next(iter(self._rows))]
            self._rows[state] = pending

    def get(self, state: str) -> PendingConnect | None:
        with self._lock:
            p = self._rows.get(state)
            if p is not None and p.expires_at <= self._clock():
                del self._rows[state]
                return None
            return p

    def take(self, state: str) -> PendingConnect | None:
        with self._lock:
            p = self._rows.pop(state, None)
            return p if p is not None and p.expires_at > self._clock() else None


@dataclass(frozen=True)
class Started:
    url: str


@dataclass(frozen=True)
class Connected:
    site: str
    gate: str
    credential: str = field(repr=False)


@dataclass(frozen=True)
class Failed:
    error: str  # "denied" | "expired" | "refused" | "invalid" | "not_yours"
    message: str


@dataclass(frozen=True)
class WellKnown:
    status: int
    headers: tuple[tuple[str, str], ...]
    body: bytes


def _return_page(r: Connected | Failed) -> WellKnown:
    """The page the owner lands on after approving: plain, self-contained, never cached."""
    if isinstance(r, Connected):
        site = html.escape(urllib.parse.urlsplit(r.site).netloc)
        gate = html.escape(urllib.parse.urlsplit(r.gate).netloc)
        title, body, status = "Connected", f"{site} now tolls through {gate}. You can close this tab.", 200
    else:
        title = "Not connected" if r.error == "denied" else "Connect did not finish"
        body, status = html.escape(r.message), 400
    page = (
        f'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<title>{title}</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem">'
        f'<h1 style="font-size:1.4rem">{title}</h1><p>{body}</p></body></html>'
    )
    headers = (
        ("Content-Type", "text/html; charset=utf-8"),
        ("Cache-Control", "no-store"),
        ("Referrer-Policy", "no-referrer"),
    )
    return WellKnown(status, headers, page.encode())


def _text(status: int, body: str) -> WellKnown:
    return WellKnown(
        status, (("Content-Type", "text/plain; charset=utf-8"), ("Cache-Control", "no-store")), body.encode()
    )


class Connect:
    def __init__(
        self,
        client_name: str,
        gate: str = DEFAULT_GATE,
        store: ConnectStore | None = None,
        client_id: Callable[[str], str] | None = None,
        return_path: str = "/naulon/connect/return",
        redirect_uris: Callable[[str], list[str]] | None = None,
        transport: Transport | None = None,
        clock: Callable[[], float] = time.time,
        on_finish: Callable[[str, Connected | Failed], None] | None = None,
    ) -> None:
        """`on_finish`, when set, makes `answer` finish the owner's return at `{site}{return_path}`
        too, so an app needs no route of its own; `naulon connect` uses it."""
        if not return_path.startswith("/"):
            raise ValueError("return_path must start with /")
        self.return_path = return_path
        self._on_finish = on_finish
        self.client_name = client_name
        self.gate = gate
        self._store = store if store is not None else MemoryConnectStore(clock)
        self._client_id = client_id or (lambda site: f"{site}{CLIENT_METADATA_PATH}")
        self._redirects = redirect_uris or (lambda site: [f"{site}{return_path}"])
        self._transport = transport
        self._clock = clock
        self._lock = threading.Lock()
        self._discovered: dict[str, tuple[float, Discovery]] = {}

    def _transport_for(self, gate: str) -> Transport:
        """Loopback is allowed only for the gate the developer configured. A gate that arrives at
        runtime (a writer's, on a platform) never reaches a private address, or a writer could aim
        the platform's server at its own internals."""
        if self._transport is not None:
            return self._transport
        local = gate == origin_of(self.gate) and is_loopback_hostname(urllib.parse.urlsplit(gate).hostname or "")
        return GuardedTransport(allow_private=local)

    def discover(self, gate: str) -> Discovery | str:
        origin = origin_of(gate)
        if origin is None:
            return f"{gate} is not an https URL"
        with self._lock:
            hit = self._discovered.get(origin)
            if hit is not None and self._clock() - hit[0] < 300:
                return hit[1]
        res = self._transport_for(origin).request(
            "GET", f"{origin}{DISCOVERY_PATH}", headers={"accept": "application/json"}, body=None, timeout=5.0
        )
        if res is None:
            return f"{origin} could not be reached"
        if res.status != 200:
            return f"{origin} is not a naulon gate (it answered {res.status})"
        try:
            body = json.loads(res.body)
        except ValueError:
            return f"{origin} is not a naulon gate"
        d = parse_discovery(body, origin)
        if isinstance(d, Discovery):
            with self._lock:
                self._discovered[origin] = (self._clock(), d)
        return d

    def start(
        self, site: str, gate: str | None = None, return_to: str | None = None, binding: str | None = None
    ) -> Started | Failed:
        """`binding` ties the connect to whoever started it: a platform passes the signed-in account's
        id, and `finish` with any other binding is refused. Without it, someone who started a connect
        could send its return link to another account holder, and a platform saving the result under
        the current account would save the sender's site there."""
        origin = site_origin(site)
        if origin is None:
            return Failed("invalid", f"{site} is not a site origin, e.g. https://example.com")
        gate_origin = origin_of(gate or self.gate)
        if gate_origin is None:
            return Failed("invalid", "the gate must be an https URL")
        allowed = self._redirects(origin)
        back = return_to or (allowed[0] if allowed else None)
        if back is None or back not in allowed:
            return Failed("invalid", f"return_to must be one of {', '.join(allowed)}")
        d = self.discover(gate_origin)
        if isinstance(d, str):
            return Failed("refused", d)
        verifier = secrets.token_urlsafe(32)
        state = secrets.token_urlsafe(24)
        challenge = code_challenge(verifier)
        self._store.put(
            state,
            PendingConnect(origin, gate_origin, verifier, challenge, back, self._clock() + PENDING_TTL_S, binding),
        )
        query = urllib.parse.urlencode(
            [
                ("response_type", "code"),
                ("client_id", self._client_id(origin)),
                ("redirect_uri", back),
                ("scope", SITE_SCOPE),
                ("site", origin),
                ("state", state),
                ("code_challenge", challenge),
                ("code_challenge_method", "S256"),
            ]
        )
        sep = "&" if urllib.parse.urlsplit(d.authorization_endpoint).query else "?"
        return Started(f"{d.authorization_endpoint}{sep}{query}")

    def finish(self, query: Mapping[str, str], binding: str | None = None) -> Connected | Failed:
        """`binding` must be what `start` was given, when it was given one."""
        state = query.get("state", "")
        if not is_state(state):
            return Failed("invalid", "this return carries no connect to finish")
        peek = self._store.get(state)
        if peek is None:
            return Failed("expired", "this connect has expired or was already finished. Start it again.")
        # Checked before anything is taken, so a return that is not this one's can neither finish the
        # connect nor cancel it.
        if peek.binding is not None and peek.binding != binding:
            return Failed(
                "not_yours", "this connect was started by someone else. Start it again from your own settings."
            )
        # RFC 9207: a response naming another gate is a mix-up, so nothing is exchanged.
        if query.get("iss") != peek.gate:
            return Failed("refused", "the response did not come from the gate this connect started with")
        if query.get("error") == "access_denied":
            self._store.take(state)
            return Failed("denied", "the gate's owner did not approve this site")
        code = query.get("code")
        if not code:
            return Failed("invalid", f"the gate returned {query.get('error') or 'no code'}")
        # One exchange per code: whoever takes the pending connect exchanges it.
        pending = self._store.take(state)
        if pending is None:
            return Failed("expired", "this connect is already being finished.")
        result, transient = self._exchange(pending, code)
        # A gate that could not be reached decided nothing: the owner may try the link again.
        if transient:
            self._store.put(state, pending)
        return result

    def _exchange(self, pending: PendingConnect, code: str) -> tuple[Connected | Failed, bool]:
        d = self.discover(pending.gate)
        if isinstance(d, str):
            return Failed("refused", d), True
        form = urllib.parse.urlencode(
            {
                "grant_type": "authorization_code",
                "code": code,
                "code_verifier": pending.verifier,
                "redirect_uri": pending.redirect_uri,
                "client_id": self._client_id(pending.site),
            }
        ).encode()
        res = self._transport_for(pending.gate).request(
            "POST",
            d.token_endpoint,
            headers={"content-type": "application/x-www-form-urlencoded", "accept": "application/json"},
            body=form,
            timeout=10.0,
        )
        if res is None:
            return Failed("refused", "the gate could not be reached"), True
        if res.status >= 500:
            return Failed("refused", f"the gate answered {res.status}"), True
        try:
            body = json.loads(res.body)
        except ValueError:
            return Failed("refused", f"the gate answered {res.status} with no JSON"), False
        if not isinstance(body, dict):
            return Failed("refused", f"the gate answered {res.status}"), False
        if res.status != 200:
            return Failed("refused", str(body.get("error_description") or f"the gate answered {res.status}")), False
        token = body.get("access_token")
        if not isinstance(token, str) or not is_site_credential(token):
            return Failed("refused", "the gate returned no site credential"), False
        if body.get("scope") != SITE_SCOPE or body.get("site") != pending.site:
            return Failed("refused", "the gate returned a credential for something else"), False
        return Connected(pending.site, pending.gate, token), False

    def handles(self, path: str) -> bool:
        """Whether `answer` could answer this path. Cheap, so a framework skips the rest."""
        return is_connect_path(path) or (self._on_finish is not None and path == self.return_path)

    def answer(self, scheme: str, host: str, path: str, method: str = "GET", query: str = "") -> WellKnown | None:
        """`well_known`, and with `on_finish` set, the return page too. None for any other request."""
        known = self.well_known(scheme, host, path, method)
        if known is not None or self._on_finish is None or method != "GET" or path != self.return_path:
            return known
        q = dict(urllib.parse.parse_qsl(query, keep_blank_values=True))
        # Reported only for a connect this site started: anyone can request the return path with any
        # state, and a report per request would let them fill the disk the report is kept on.
        state = q.get("state", "")
        ours = is_state(state) and self._store.get(state) is not None
        result = self.finish(q)
        if ours:
            self._on_finish(state, result)
        return _return_page(result)

    def well_known(self, scheme: str, host: str, path: str, method: str = "GET") -> WellKnown | None:
        """The answer to one of the two connect paths on this site, or None for any other request."""
        if method not in ("GET", "HEAD"):
            return None
        if path.startswith(CHALLENGE_PATH):
            state = path[len(CHALLENGE_PATH) :]
            pending = self._store.get(state) if is_state(state) else None
            # A state this process never started is answered exactly like a page that does not exist.
            if pending is None or urllib.parse.urlsplit(pending.site).netloc != host.lower():
                return _text(404, "not found\n")
            return _text(200, f"{pending.challenge}\n")
        if path == CLIENT_METADATA_PATH:
            site = site_origin(f"{scheme}://{host}")
            if site is None or self._client_id(site) != f"{site}{CLIENT_METADATA_PATH}":
                return None
            doc = {
                "client_id": self._client_id(site),
                "client_name": self.client_name,
                "redirect_uris": self._redirects(site),
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code"],
            }
            return WellKnown(
                200, (("Content-Type", "application/json"), ("Cache-Control", "max-age=300")), json.dumps(doc).encode()
            )
        return None
