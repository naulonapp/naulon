"""HTTP to the gate. Every failure becomes `None`; nothing here raises into the host app."""

from __future__ import annotations

import http.client
import socket
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import IO, Any, Protocol

from naulon import ip

# A gate answer larger than this is not one the protocol produces. Reading it would hold a worker.
MAX_BODY_BYTES = 1_048_576


@dataclass(frozen=True)
class Response:
    status: int
    headers: Mapping[str, str] = field(default_factory=dict)
    body: bytes = b""


class Transport(Protocol):
    def request(
        self, method: str, url: str, *, headers: Mapping[str, str], body: bytes | None, timeout: float
    ) -> Response | None: ...


class _SameHostRedirects(urllib.request.HTTPRedirectHandler):
    """Follow a redirect only within the same scheme and host. The request carries the site's key,
    and a redirect elsewhere would hand it to whoever the gate's answer named."""

    def redirect_request(
        self, req: urllib.request.Request, fp: IO[bytes], code: int, msg: str, headers: Any, newurl: str
    ) -> urllib.request.Request | None:
        a = urllib.parse.urlsplit(req.full_url)
        b = urllib.parse.urlsplit(newurl)
        if (a.scheme, a.netloc) != (b.scheme, b.netloc):
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class UrllibTransport:
    """The stdlib transport. A non-2xx is a `Response`; no answer at all is `None`."""

    def __init__(self) -> None:
        self._opener = urllib.request.build_opener(_SameHostRedirects())

    def request(
        self, method: str, url: str, *, headers: Mapping[str, str], body: bytes | None, timeout: float
    ) -> Response | None:
        req = urllib.request.Request(url, data=body, headers=dict(headers), method=method)  # noqa: S310
        try:
            with self._opener.open(req, timeout=timeout) as res:
                return Response(res.status, _headers(res.headers), res.read(MAX_BODY_BYTES))
        except urllib.error.HTTPError as err:
            try:
                data = err.read(MAX_BODY_BYTES)
            except Exception:
                data = b""
            return Response(err.code, _headers(err.headers), data)
        except Exception:
            # DNS, refused, reset, timeout, TLS, a refused redirect: all are "no answer".
            return None


def _headers(h: Any) -> dict[str, str]:
    try:
        return {str(k).lower(): str(v) for k, v in h.items()}
    except Exception:
        return {}


class Breaker:
    """Opens after `threshold` consecutive failures and stays open for `cooldown_s`, then lets one
    request through to probe. A success closes it."""

    def __init__(self, threshold: int = 5, cooldown_s: float = 60.0, clock: Callable[[], float] = time.monotonic):
        self._threshold = threshold
        self._cooldown = cooldown_s
        self._clock = clock
        self._failures = 0
        self._opened_at: float | None = None
        self._probing = False
        self._lock = threading.Lock()

    def allow(self) -> bool:
        with self._lock:
            if self._opened_at is None:
                return True
            if self._probing or self._clock() - self._opened_at < self._cooldown:
                return False
            self._probing = True
            return True

    def record(self, ok: bool) -> None:
        with self._lock:
            self._probing = False
            if ok:
                self._failures = 0
                self._opened_at = None
                return
            self._failures += 1
            if self._failures >= self._threshold:
                self._opened_at = self._clock()


def _connect_any(addresses: list[str], port: int, deadline: float) -> socket.socket:
    """The first of the approved addresses that accepts, in resolver order, all of them sharing one
    budget. A name with an IPv6 address that does not route still connects over IPv4, as an
    unguarded client would."""
    last: OSError | None = None
    for address in addresses:
        left = deadline - time.monotonic()
        if left <= 0:
            break
        try:
            return socket.create_connection((address, port), left)
        except OSError as err:
            last = err
    raise last or OSError("no address to connect to before the deadline")


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    # The TCP socket, kept apart from `sock`: http.client clears `sock` when a response with no
    # length takes the connection over, and the watchdog must still be able to stop it.
    raw: socket.socket | None = None

    """Connects only to addresses chosen in advance, while TLS still checks the certificate against
    the hostname. The addresses are the ones the guard approved, so nothing can resolve the name
    again to somewhere private between the check and the connect."""

    def __init__(self, host: str, port: int, addresses: list[str], deadline: float, context: ssl.SSLContext) -> None:
        super().__init__(host, port, timeout=max(deadline - time.monotonic(), 0.001), context=context)
        self._addresses = addresses
        self._deadline = deadline
        self._ctx = context

    def connect(self) -> None:
        sock = _connect_any(self._addresses, self.port, self._deadline)
        self.raw = sock
        self.sock = self._ctx.wrap_socket(sock, server_hostname=self.host)


class _PinnedHTTPConnection(http.client.HTTPConnection):
    raw: socket.socket | None = None

    def __init__(self, host: str, port: int, addresses: list[str], deadline: float) -> None:
        super().__init__(host, port, timeout=max(deadline - time.monotonic(), 0.001))
        self._addresses = addresses
        self._deadline = deadline

    def connect(self) -> None:
        self.sock = self.raw = _connect_any(self._addresses, self.port, self._deadline)


# `getaddrinfo` cannot be given a deadline, so each lookup runs on a thread of its own that the caller
# stops waiting for. Its own thread, not a shared pool: a few stalled names must never queue every
# other site's lookup behind them. At most this many may be outstanding; past that a lookup is
# refused at once rather than started, so stalled names cannot pile up threads either.
MAX_LOOKUPS = 32
_lookups = threading.BoundedSemaphore(MAX_LOOKUPS)


def _resolve_within(resolve: Callable[[], list[str] | None], timeout: float) -> list[str] | None:
    if not _lookups.acquire(blocking=False):
        return None
    result: list[list[str] | None] = [None]
    done = threading.Event()

    def run() -> None:
        try:
            result[0] = resolve()
        except Exception:
            result[0] = None
        finally:
            done.set()
            _lookups.release()

    threading.Thread(target=run, name="naulon-dns", daemon=True).start()
    return result[0] if done.wait(timeout) else None


class GuardedTransport:
    """For a URL somebody else chose: a gate a writer typed into a platform. https only (plain http
    to loopback when `allow_private`), every address the name resolves to must be public, the socket
    connects to the address that was checked, no redirect is followed, and the body is capped.

    `timeout` is one deadline for the whole exchange, lookup through the last byte. A watchdog
    closes the connection when it passes, whatever the request is blocked in (connect, TLS, the
    status line, a header, the body), so a server that drips a byte at a time cannot hold a worker
    past it."""

    def __init__(self, allow_private: bool = False) -> None:
        self._allow_private = allow_private
        self._context = ssl.create_default_context()

    def _addresses(self, host: str, port: int) -> list[str] | None:
        """Every address the name resolves to, or None when any of them is not public: one private
        answer is enough to refuse, since the resolver chooses which one a client would use."""
        try:
            infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except OSError:
            return None
        addresses = list(dict.fromkeys(str(info[4][0]) for info in infos))
        if not addresses:
            return None
        if not self._allow_private:
            for a in addresses:
                parsed = ip.parse(a.split("%", 1)[0])
                if parsed is None or ip.is_blocked_target(parsed):
                    return None
        return addresses

    def request(
        self, method: str, url: str, *, headers: Mapping[str, str], body: bytes | None, timeout: float
    ) -> Response | None:
        u = urllib.parse.urlsplit(url)
        host = u.hostname
        if not host or u.username or u.password:
            return None
        if u.scheme != "https" and not (u.scheme == "http" and self._allow_private):
            return None
        deadline = time.monotonic() + timeout
        port = u.port or (443 if u.scheme == "https" else 80)
        addresses = _resolve_within(lambda: self._addresses(host, port), timeout)
        if addresses is None or deadline - time.monotonic() <= 0:
            return None
        conn: _PinnedHTTPSConnection | _PinnedHTTPConnection
        if u.scheme == "https":
            conn = _PinnedHTTPSConnection(host, port, addresses, deadline, self._context)
        else:
            conn = _PinnedHTTPConnection(host, port, addresses, deadline)
        path = (u.path or "/") + (f"?{u.query}" if u.query else "")
        expired = threading.Event()

        def stop() -> None:
            expired.set()
            sock = conn.raw
            if sock is not None:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

        watchdog = threading.Timer(max(deadline - time.monotonic(), 0.0), stop)
        watchdog.daemon = True
        watchdog.start()
        try:
            conn.request(method, path, body=body, headers=dict(headers))
            res = conn.getresponse()
            data = res.read(MAX_BODY_BYTES)
            return None if expired.is_set() else Response(res.status, _headers(res.headers), data)
        except Exception:
            return None
        finally:
            watchdog.cancel()
            conn.close()
