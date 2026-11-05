"""Which credential tolls a request's site, and on which gate.

A single site sets `NAULON_KEY` and every request uses it. A platform that hosts many sites (one
codebase, many writers, each connected to naulon on their own) passes `credential_for(host)`: it
returns what that site's owner connected, or None when that site has not turned naulon on. None means
the request is not touched at all. It never falls back to `NAULON_KEY`, which would toll a writer who
never opted in.

An answer may be a plain credential, tolled on the configured gate, or a `Site` naming a gate of its
own: a writer who runs their own gate connects to it. That URL came from a writer, so `Gates` sends
every request for it through the guarded transport.

The answer is cached per host for `ttl_s`, so the platform's lookup runs about once per host per
interval, not once per request. A revoked or changed credential takes effect within that interval.
"""

from __future__ import annotations

import collections
import hashlib
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import NamedTuple

from naulon._log import warn_error, warn_once
from naulon.connect import CHALLENGE_PATH, WellKnown, origin_of, proof_answer
from naulon.transport import Breaker, Transport


@dataclass(frozen=True)
class Site:
    """What a site's owner connected: the credential, and the gate it is for (None: the configured
    gate). The credential is a secret, so it is never part of the repr."""

    credential: str = field(repr=False)
    gate: str | None = None

    @property
    def digest(self) -> str:
        """A short, stable name for this site's credential on its gate, for keying caches."""
        return hashlib.sha256(f"{self.gate or ''}\x00{self.credential}".encode()).hexdigest()[:24]


CredentialFor = Callable[[str], str | Site | None]

DEFAULT_TTL_S = 30.0
# Host headers are the caller's to write: at most this many answers are remembered, oldest out first.
MAX_HOSTS = 10_000
# Gates a platform's writers named, each with its own breaker. Bounded for the same reason.
MAX_GATES = 1_000


class _Miss:
    pass


MISS = _Miss()


def site_of(raw: object) -> Site | None:
    """A lookup's answer as a `Site`, or None for anything that is not a usable one."""
    if isinstance(raw, str):
        s = raw.strip()
        return Site(s) if s else None
    if isinstance(raw, Site):
        cred = raw.credential.strip() if isinstance(raw.credential, str) else ""
        if not cred:
            return None
        if raw.gate is None:
            return Site(cred)
        gate = origin_of(raw.gate)
        if gate is None:
            warn_once("sites.gate", "naulon: a site's saved gate is not an https URL; that site is served untouched")
            return None
        return Site(cred, gate)
    return None


class SiteCredentials:
    def __init__(
        self,
        default: str | None,
        credential_for: CredentialFor | None = None,
        ttl_s: float = DEFAULT_TTL_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._default = Site(default) if default else None
        self._credential_for = credential_for
        self._ttl = ttl_s
        self._clock = clock
        self._lock = threading.Lock()
        self._cache: collections.OrderedDict[str, tuple[float, Site | None]] = collections.OrderedDict()

    @property
    def per_site(self) -> bool:
        return self._credential_for is not None

    @property
    def any(self) -> bool:
        """Whether anything can ever be tolled: a single credential, or a lookup."""
        return self.per_site or self._default is not None

    def peek(self, host: str) -> Site | None | _Miss:
        """The cached answer for `host`, or MISS when `credential_for` has to be asked. Never calls it."""
        if self._credential_for is None:
            return self._default
        h = host.lower()
        now = self._clock()
        with self._lock:
            hit = self._cache.get(h)
            if hit is not None and now - hit[0] < self._ttl:
                self._cache.move_to_end(h)
                return hit[1]
        return MISS

    def lookup(self, host: str) -> Site | None:
        """Ask `credential_for` for `host` and remember the answer. A hook that raises leaves the
        site untouched for this interval: the page is served, never tolled by mistake."""
        if self._credential_for is None:
            return self._default
        h = host.lower()
        try:
            site = site_of(self._credential_for(h))
        except Exception as err:
            warn_error("sites.credential_for", "naulon: credential_for raised; the site is served untouched", err)
            site = None
        with self._lock:
            self._cache[h] = (self._clock(), site)
            self._cache.move_to_end(h)
            while len(self._cache) > MAX_HOSTS:
                self._cache.popitem(last=False)
        return site

    def site(self, host: str) -> Site | None:
        hit = self.peek(host)
        return self.lookup(host) if isinstance(hit, _Miss) else hit

    def proof(self, host: str, path: str, method: str) -> WellKnown | None:
        """The connect proof of the credential this host holds, when `path` asks for it. May call
        `credential_for`, so an async stack runs it off the loop."""
        if not path.startswith(CHALLENGE_PATH):
            return None
        site = self.site(host)
        return proof_answer(path, method, site.credential if site is not None else None)


class Route(NamedTuple):
    base: str
    transport: Transport
    breaker: Breaker


class Gates:
    """Where a site's requests go. The configured gate uses the configured transport; a gate a
    writer named uses the guarded one. Each gate has its own breaker, so one writer's gate going
    down never stops the toll on anyone else's site."""

    def __init__(
        self,
        home: str | None,
        transport: Transport,
        guarded: Transport,
        clock: Callable[[], float] = time.monotonic,
        make_breaker: Callable[[], Breaker] | None = None,
    ) -> None:
        self.home = home
        self._transport = transport
        self._guarded = guarded
        self._make_breaker = make_breaker or (lambda: Breaker(clock=clock))
        self._lock = threading.Lock()
        self._breakers: collections.OrderedDict[str, Breaker] = collections.OrderedDict()

    def gate_of(self, site: Site | None) -> str | None:
        return site.gate if site is not None and site.gate else self.home

    def route(self, site: Site | None) -> Route | None:
        gate = self.gate_of(site)
        return None if gate is None else self.for_gate(gate)

    def for_gate(self, gate: str) -> Route:
        with self._lock:
            breaker = self._breakers.get(gate)
            if breaker is None:
                breaker = self._breakers[gate] = self._make_breaker()
                while len(self._breakers) > MAX_GATES:
                    self._breakers.popitem(last=False)
            self._breakers.move_to_end(gate)
        return Route(gate, self._transport if gate == self.home else self._guarded, breaker)
