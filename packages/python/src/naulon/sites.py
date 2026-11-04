"""Which key tolls a request's site.

A single site sets `NAULON_KEY` and every request uses it. A platform that hosts many sites (one
codebase, many writers, each with their own naulon account) passes `key_for(host)`: it returns the
key the writer pasted into the platform for that host, or None when that site has not turned naulon
on. None means the request is not touched at all. It never falls back to `NAULON_KEY`, which would
toll a writer who never opted in.

The answer is cached per host for `ttl_s`, so the platform's lookup runs about once per host per
interval, not once per request. A revoked or changed key takes effect within that interval.
"""

from __future__ import annotations

import collections
import threading
import time
from collections.abc import Callable

from naulon._log import warn_error

KeyFor = Callable[[str], "str | None"]

DEFAULT_TTL_S = 30.0
# Host headers are the caller's to write: at most this many answers are remembered, oldest out first.
MAX_HOSTS = 10_000


class _Miss:
    pass


MISS = _Miss()


class SiteKeys:
    def __init__(
        self,
        default: str | None,
        key_for: KeyFor | None = None,
        ttl_s: float = DEFAULT_TTL_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._default = default
        self._key_for = key_for
        self._ttl = ttl_s
        self._clock = clock
        self._lock = threading.Lock()
        self._cache: collections.OrderedDict[str, tuple[float, str | None]] = collections.OrderedDict()

    @property
    def per_site(self) -> bool:
        return self._key_for is not None

    def peek(self, host: str) -> str | None | _Miss:
        """The cached answer for `host`, or MISS when `key_for` has to be asked. Never calls it."""
        if self._key_for is None:
            return self._default
        h = host.lower()
        now = self._clock()
        with self._lock:
            hit = self._cache.get(h)
            if hit is not None and now - hit[0] < self._ttl:
                self._cache.move_to_end(h)
                return hit[1]
        return MISS

    def lookup(self, host: str) -> str | None:
        """Ask `key_for` for `host` and remember the answer. A hook that raises leaves the site
        untouched for this interval: the page is served, never tolled by mistake."""
        if self._key_for is None:
            return self._default
        h = host.lower()
        try:
            key = _clean(self._key_for(h))
        except Exception as err:
            warn_error("sites.key_for", "naulon: key_for raised; the site is served untouched", err)
            key = None
        with self._lock:
            self._cache[h] = (self._clock(), key)
            self._cache.move_to_end(h)
            while len(self._cache) > MAX_HOSTS:
                self._cache.popitem(last=False)
        return key

    def key(self, host: str) -> str | None:
        hit = self.peek(host)
        return self.lookup(host) if isinstance(hit, _Miss) else hit


def _clean(v: object) -> str | None:
    if not isinstance(v, str):
        return None
    s = v.strip()
    return s or None
