"""Web Bot Auth: RFC 9421 HTTP Message Signatures, scoped to the web-bot-auth profile. A port of
`packages/enforce/src/botAuth.ts`, held to `botauth-vectors.json`, which the gate's own signer and
verifier generate.

Needs the `botauth` extra (`cryptography`). Without it every signature reads `unverified`, which
never charges anyone: the user agent path decides as if the request were unsigned.
"""

from __future__ import annotations

import base64
import hashlib
import http.client
import json
import re
import socket
import ssl
import threading
import time
import urllib.parse
from collections import OrderedDict
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Literal

from naulon import ip
from naulon._log import warn_once
from naulon.transport import Response

WELL_KNOWN_PATH = "/.well-known/http-message-signatures-directory"
DIRECTORY_CONTENT_TYPE = "application/http-message-signatures-directory+json"
DIRECTORY_MAX_BYTES = 65_536
POS_TTL_S = 6 * 60 * 60
NEG_TTL_S = 10 * 60
CACHE_CAP = 256
SKEW_S = 10
MAX_VALIDITY_S = 86_400
# A directory is refetched for an unknown keyid (a rotation) at most this often.
ROTATION_REFETCH_S = 60
DIRECTORY_TIMEOUT_S = 3.0
_DNS_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")

Status = Literal["absent", "verified", "invalid", "unverified"]
_KEY_START = re.compile(r"[a-z*]")
_KEY_CHAR = re.compile(r"[a-z0-9_\-.*]")
_TOKEN_START = re.compile(r"[A-Za-z*]")
_TOKEN_CHAR = re.compile(r"[A-Za-z0-9!#$%&'*+\-.^_`|~:/]")
_BASE64 = re.compile(r"[A-Za-z0-9+/]*={0,2}\Z")

BareItem = str | int | bool


@dataclass(frozen=True)
class Component:
    name: str
    raw: str
    key: str | None = None


@dataclass(frozen=True)
class Entry:
    label: str
    components: tuple[Component, ...]
    params: Mapping[str, BareItem]
    raw_member: str


@dataclass(frozen=True)
class SignedRequest:
    authority: str
    method: str
    path: str
    target_uri: str
    headers: Mapping[str, str]


@dataclass(frozen=True)
class Outcome:
    status: Status
    agent: str | None = None
    keyid: str | None = None
    covers: tuple[str, ...] = field(default_factory=tuple)
    reason: str = ""
    # Needs a directory that is not cached: run again with a fetch, off the request thread.
    deferred: bool = False


class _Cursor:
    def __init__(self, s: str) -> None:
        self.s = s
        self.i = 0

    def eof(self) -> bool:
        return self.i >= len(self.s)

    def peek(self) -> str:
        return self.s[self.i] if self.i < len(self.s) else ""

    def skip_sp(self) -> None:
        while self.peek() in (" ", "\t") and not self.eof():
            self.i += 1


def _key(c: _Cursor) -> str | None:
    start = c.i
    if not _KEY_START.fullmatch(c.peek() or "\x00"):
        return None
    c.i += 1
    while c.peek() and _KEY_CHAR.fullmatch(c.peek()):
        c.i += 1
    return c.s[start : c.i]


def _quoted(c: _Cursor) -> str | None:
    if c.peek() != '"':
        return None
    c.i += 1
    out: list[str] = []
    while not c.eof():
        ch = c.peek()
        if ch == '"':
            c.i += 1
            return "".join(out)
        if ch == "\\":
            c.i += 1
            esc = c.peek()
            if esc not in ('"', "\\"):
                return None
            out.append(esc)
            c.i += 1
            continue
        out.append(ch)
        c.i += 1
    return None


def _bare(c: _Cursor) -> BareItem | None:
    ch = c.peek()
    if ch == '"':
        return _quoted(c)
    if ch == "?":
        c.i += 1
        b = c.peek()
        if b not in ("0", "1"):
            return None
        c.i += 1
        return b == "1"
    if ch == "-" or ch.isdigit():
        start = c.i
        if ch == "-":
            c.i += 1
        while c.peek().isdigit():
            c.i += 1
        text = c.s[start : c.i]
        if not text or not text[-1].isdigit():
            return None
        return int(text)
    if ch and _TOKEN_START.fullmatch(ch):
        start = c.i
        c.i += 1
        while c.peek() and _TOKEN_CHAR.fullmatch(c.peek()):
            c.i += 1
        return c.s[start : c.i]
    return None


def _params(c: _Cursor) -> dict[str, BareItem] | None:
    out: dict[str, BareItem] = {}
    while c.peek() == ";":
        c.i += 1
        c.skip_sp()
        k = _key(c)
        if k is None:
            return None
        if c.peek() == "=":
            c.i += 1
            v = _bare(c)
            if v is None:
                return None
            out[k] = v
        else:
            out[k] = True
    return out


def parse_signature_input(value: str) -> list[Entry] | None:
    c = _Cursor(value)
    entries: list[Entry] = []
    c.skip_sp()
    if c.eof():
        return None
    while True:
        label = _key(c)
        if label is None or c.peek() != "=":
            return None
        c.i += 1
        member_start = c.i
        if c.peek() != "(":
            return None
        c.i += 1
        comps: list[Component] = []
        while True:
            c.skip_sp()
            if c.peek() == ")":
                c.i += 1
                break
            if c.eof():
                return None
            comp_start = c.i
            name = _quoted(c)
            if name is None:
                return None
            item = _params(c)
            if item is None:
                return None
            k = item.get("key")
            comps.append(Component(name, value[comp_start : c.i], k if isinstance(k, str) else None))
        params = _params(c)
        if params is None:
            return None
        entries.append(Entry(label, tuple(comps), params, value[member_start : c.i]))
        c.skip_sp()
        if c.eof():
            return entries
        if c.peek() != ",":
            return None
        c.i += 1
        c.skip_sp()


def parse_signature_header(value: str) -> dict[str, bytes] | None:
    c = _Cursor(value)
    out: dict[str, bytes] = {}
    c.skip_sp()
    if c.eof():
        return None
    while True:
        label = _key(c)
        if label is None or c.peek() != "=":
            return None
        c.i += 1
        if c.peek() != ":":
            return None
        c.i += 1
        end = c.s.find(":", c.i)
        if end < 0:
            return None
        b64 = c.s[c.i : end]
        if not _BASE64.match(b64) or len(b64) % 4 != 0:
            return None
        out[label] = base64.b64decode(b64)
        c.i = end + 1
        c.skip_sp()
        if c.eof():
            return out
        if c.peek() != ",":
            return None
        c.i += 1
        c.skip_sp()


def parse_signature_agent(value: str) -> str | None:
    c = _Cursor(value)
    c.skip_sp()
    if c.eof():
        return None
    raw: str | None = None
    if c.peek() == '"':
        raw = _quoted(c)
    else:
        label = _key(c)
        if label is not None and c.peek() == "=":
            c.i += 1
            raw = _quoted(c)
    if not raw:
        return None
    normalized = raw if "://" in raw else f"https://{raw}"
    try:
        u = urllib.parse.urlsplit(normalized)
    except ValueError:
        return None
    if u.scheme not in ("https", "http") or not u.hostname:
        return None
    return normalized


def _dict_member_raw(header: str, key: str) -> str | None:
    c = _Cursor(header)
    c.skip_sp()
    while True:
        label = _key(c)
        if label is None or c.peek() != "=":
            return None
        c.i += 1
        start = c.i
        if c.peek() == ":":
            c.i += 1
            end = c.s.find(":", c.i)
            if end < 0:
                return None
            c.i = end + 1
        elif _bare(c) is None:
            return None
        if _params(c) is None:
            return None
        if label == key:
            return c.s[start : c.i]
        c.skip_sp()
        if c.eof() or c.peek() != ",":
            return None
        c.i += 1
        c.skip_sp()


def build_signature_base(entry: Entry, req: SignedRequest) -> str | None:
    lines = []
    for comp in entry.components:
        if comp.name.startswith("@"):
            if comp.key is not None:
                return None
            if comp.name == "@authority":
                value = req.authority.lower()
            elif comp.name == "@method":
                value = req.method.upper()
            elif comp.name == "@path":
                value = req.path
            elif comp.name == "@target-uri":
                value = req.target_uri
            else:
                return None
        else:
            raw_header = req.headers.get(comp.name.lower())
            if raw_header is None:
                return None
            if comp.key is not None:
                member = _dict_member_raw(raw_header, comp.key)
                if member is None:
                    return None
                value = member
            else:
                value = raw_header.strip()
        lines.append(f"{comp.raw}: {value}")
    lines.append(f'"@signature-params": {entry.raw_member}')
    return "\n".join(lines)


def jwk_thumbprint(x: str) -> str:
    """RFC 7638 thumbprint of an Ed25519 key: the profile's keyid."""
    canonical = json.dumps({"crv": "Ed25519", "kty": "OKP", "x": x}, separators=(",", ":"))
    return base64.urlsafe_b64encode(hashlib.sha256(canonical.encode()).digest()).rstrip(b"=").decode()


def _b64url(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def verify_ed25519(base: str, sig: bytes, x: str) -> bool:
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError:
        return False
    try:
        Ed25519PublicKey.from_public_bytes(_b64url(x)).verify(sig, base.encode())
        return True
    except (InvalidSignature, ValueError):
        return False


def available() -> bool:
    try:
        import cryptography.hazmat.primitives.asymmetric.ed25519  # noqa: F401
    except ImportError:
        return False
    return True


def _dns_name(host: str) -> bool:
    """A strict DNS name: dotted labels, and a top-level label with a letter (never an address)."""
    labels = host.split(".")
    return (
        len(host) <= 253
        and len(labels) >= 2
        and all(_DNS_LABEL.match(label) for label in labels)
        and any(ch.isalpha() for ch in labels[-1])
    )


def _directory_url(agent_url: str) -> tuple[str, str] | None:
    """The directory URL and the agent host, or None when refused. The agent URL is the caller's:
    HTTPS on the default port, a strict DNS name, no userinfo, no loopback, no address literal."""
    try:
        u = urllib.parse.urlsplit(agent_url)
        port = u.port
    except ValueError:
        return None
    host = (u.hostname or "").lower().rstrip(".")
    if u.scheme != "https" or u.username is not None or u.password is not None or port not in (None, 443):
        return None
    if host == "localhost" or host.endswith(".localhost") or ip.parse(host) is not None or not _dns_name(host):
        return None
    return f"https://{host}{WELL_KNOWN_PATH}", host


class _PinnedHTTPS(http.client.HTTPSConnection):
    """HTTPS to one checked address, with the certificate verified for the host name."""

    def __init__(self, host: str, address: str, timeout: float) -> None:
        super().__init__(host, 443, timeout=timeout, context=ssl.create_default_context())
        self._address = address

    def connect(self) -> None:
        sock = socket.create_connection((self._address, 443), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)  # type: ignore[attr-defined]


def pinned_fetch(url: str, timeout: float = DIRECTORY_TIMEOUT_S) -> Response | None:
    """GET a key directory without following redirects, refusing any host that resolves to a
    private, loopback, link-local, metadata or otherwise reserved address. The connection goes to
    the address that was checked, so a second DNS answer cannot swap it. None on any failure."""
    try:
        u = urllib.parse.urlsplit(url)
        host = u.hostname or ""
        addresses = [str(info[4][0]) for info in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)]
        if not addresses:
            return None
        for a in addresses:
            parsed = ip.parse(a)
            if parsed is None or not ip.usable(parsed, []):
                return None
        conn = _PinnedHTTPS(host, addresses[0], timeout)
        try:
            conn.request(
                "GET", u.path or "/", headers={"Accept": DIRECTORY_CONTENT_TYPE, "User-Agent": "naulon-python"}
            )
            res = conn.getresponse()
            body = res.read(DIRECTORY_MAX_BYTES + 1)
            return Response(res.status, {k.lower(): v for k, v in res.getheaders()}, body)
        finally:
            conn.close()
    except Exception:
        return None


def _directory_signature_ok(res: Response, url: str, keys: Mapping[str, str]) -> bool:
    sig_input = res.headers.get("signature-input")
    sig_raw = res.headers.get("signature")
    if sig_input is None or sig_raw is None:
        return True  # absent: bound by the direct TLS fetch
    entries = parse_signature_input(sig_input)
    entry = next((e for e in entries or [] if e.params.get("tag") == "http-message-signatures-directory"), None)
    if entry is None:
        return False
    sig = (parse_signature_header(sig_raw) or {}).get(entry.label)
    keyid = entry.params.get("keyid")
    x = keys.get(keyid) if isinstance(keyid, str) else None
    if sig is None or x is None:
        return False
    u = urllib.parse.urlsplit(url)
    base = build_signature_base(entry, SignedRequest(u.netloc.lower(), "GET", WELL_KNOWN_PATH, url, dict(res.headers)))
    return base is not None and verify_ed25519(base, sig, x)


def parse_directory(res: Response | None, url: str) -> dict[str, str] | None:
    """The keyid → x map a directory answer publishes, or None when it is unusable."""
    if res is None or res.status != 200:
        return None
    if "http-message-signatures-directory+json" not in res.headers.get("content-type", ""):
        return None
    if len(res.body) > DIRECTORY_MAX_BYTES:
        return None
    try:
        doc = json.loads(res.body)
    except ValueError:
        return None
    raw_keys = doc.get("keys") if isinstance(doc, dict) else None
    if not isinstance(raw_keys, list):
        return None
    keys = {}
    for k in raw_keys:
        if isinstance(k, dict) and k.get("kty") == "OKP" and k.get("crv") == "Ed25519" and isinstance(k.get("x"), str):
            keys[jwk_thumbprint(k["x"])] = k["x"]
    if not keys or not _directory_signature_ok(res, url, keys):
        return None
    return keys


class DirectoryCache:
    """LRU + TTL cache of key directories. A None entry is negative and expires sooner."""

    def age(self, url: str) -> float | None:
        """Seconds since `url` was last fetched, or None when it never was (or was evicted)."""
        with self._lock:
            hit = self._entries.get(url)
            return None if hit is None else self._clock() - hit[1]

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._entries: OrderedDict[str, tuple[dict[str, str] | None, float]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, url: str) -> dict[str, str] | None | Literal[False]:
        """False: nothing usable cached."""
        with self._lock:
            hit = self._entries.get(url)
            if hit is None:
                return False
            keys, at = hit
            if self._clock() - at > (NEG_TTL_S if keys is None else POS_TTL_S):
                del self._entries[url]
                return False
            self._entries.move_to_end(url)
            return keys

    def set(self, url: str, keys: dict[str, str] | None) -> None:
        with self._lock:
            self._entries[url] = (keys, self._clock())
            self._entries.move_to_end(url)
            while len(self._entries) > CACHE_CAP:
                self._entries.popitem(last=False)


def verify(
    req: SignedRequest, fetch: Callable[[str], Response | None] | None, cache: DirectoryCache, now: float
) -> Outcome:
    """Verify a request's Web Bot Auth signature. `now` is epoch seconds. Never raises.

    With `fetch` None the check answers from the cache alone, and a directory it has not cached yet
    comes back `deferred`: the caller runs it again, with a fetch, off its request thread."""
    try:
        return _verify(req, fetch, cache, now)
    except Exception as err:
        warn_once("botauth", "naulon: a signature could not be checked (%s)", type(err).__name__)
        return Outcome("unverified", reason="verifier error")


def _verify(
    req: SignedRequest, fetch: Callable[[str], Response | None] | None, cache: DirectoryCache, now: float
) -> Outcome:
    h = req.headers
    sig_input, sig_raw, agent_raw = h.get("signature-input"), h.get("signature"), h.get("signature-agent")
    if sig_input is None or sig_raw is None or agent_raw is None:
        return Outcome("absent")
    entries = parse_signature_input(sig_input)
    if entries is None:
        return Outcome("invalid", reason="unparsable Signature-Input")
    entry = next((e for e in entries if e.params.get("tag") == "web-bot-auth"), None)
    if entry is None:
        return Outcome("absent")
    created, expires, keyid = entry.params.get("created"), entry.params.get("expires"), entry.params.get("keyid")
    if (
        not isinstance(created, int)
        or isinstance(created, bool)
        or not isinstance(expires, int)
        or isinstance(expires, bool)
        or not isinstance(keyid, str)
    ):
        return Outcome("invalid", reason="missing created/expires/keyid")
    now_s = int(now)
    if expires < now_s - SKEW_S:
        return Outcome("invalid", reason="signature expired")
    if created > now_s + SKEW_S:
        return Outcome("invalid", reason="created in the future")
    if expires - created > MAX_VALIDITY_S:
        return Outcome("invalid", reason="validity window exceeds the 24h max")
    if not any(c.name in ("@authority", "@target-uri") for c in entry.components):
        return Outcome("invalid", reason="neither @authority nor @target-uri covered")
    sig = (parse_signature_header(sig_raw) or {}).get(entry.label)
    if sig is None:
        return Outcome("invalid", reason="no signature bytes for the signed label")
    agent_url = parse_signature_agent(agent_raw)
    if agent_url is None:
        return Outcome("invalid", reason="unparsable Signature-Agent")
    directory = _directory_url(agent_url)
    if directory is None:
        return Outcome("invalid", reason="refused directory host")
    dir_url, agent_host = directory
    base = build_signature_base(entry, req)
    if base is None:
        return Outcome("invalid", reason="unresolvable covered component")
    if not available():
        warn_once("botauth.extra", "naulon: install naulon[botauth] to verify Web Bot Auth signatures")
        return Outcome("unverified", reason="the botauth extra is not installed")

    cached = cache.get(dir_url)
    if cached is False:
        if fetch is None:
            return Outcome("unverified", reason="key directory not cached yet", deferred=True)
        cached = _load(dir_url, fetch, cache)
        was_cached = False
    else:
        was_cached = True
    keys = cached
    if keys is None:
        return Outcome("unverified", reason="key directory unavailable")
    x = keys.get(keyid)
    age = cache.age(dir_url)
    if x is None and was_cached and age is not None and age >= ROTATION_REFETCH_S:
        # Rotation grace: the cached directory may predate a new key. Refetched at most once a
        # minute per directory, so an unknown keyid cannot make every request a fetch.
        if fetch is None:
            return Outcome("unverified", reason="key directory may have rotated", deferred=True)
        keys = _load(dir_url, fetch, cache)
        if keys is None:
            return Outcome("unverified", reason="key directory unavailable")
        x = keys.get(keyid)
    if x is None:
        return Outcome("invalid", reason="keyid not in the operator's directory")
    if not verify_ed25519(base, sig, x):
        return Outcome("invalid", reason="signature verification failed")
    return Outcome("verified", agent=agent_host, keyid=keyid, covers=tuple(c.name for c in entry.components))


def _load(url: str, fetch: Callable[[str], Response | None], cache: DirectoryCache) -> dict[str, str] | None:
    keys = parse_directory(fetch(url), url)
    cache.set(url, keys)
    return keys
