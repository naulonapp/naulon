"""HTTP to the gate. Every failure becomes `None`; nothing here raises into the host app."""

from __future__ import annotations

import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import IO, Any, Protocol

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
