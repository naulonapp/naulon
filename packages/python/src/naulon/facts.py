"""The request, as every adapter hands it to the core: plain values, no framework objects."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

from naulon.sites import Site


@dataclass(frozen=True)
class RequestFacts:
    method: str
    scheme: str
    host: str
    path: str
    query: str = ""
    headers: Mapping[str, str] = field(default_factory=dict)
    client_ip: str | None = None
    # What naulon tolls this request's site with: its credential and gate. One per site on a
    # multi-site platform, the single `NAULON_KEY` otherwise. Holds a secret, so never in the repr.
    site: Site | None = field(default=None, repr=False)

    @property
    def url(self) -> str:
        """The resource URL the gate prices and signs for: scheme, host and path, no query."""
        return f"{self.scheme}://{self.host}{self.path}"

    def header(self, name: str) -> str:
        return self.headers.get(name.lower(), "").strip()


def lower_headers(pairs: Iterable[tuple[str, str]]) -> dict[str, str]:
    """Header names lowercased; a repeated header joined with ", " as HTTP allows."""
    out: dict[str, str] = {}
    for name, value in pairs:
        k = name.lower()
        out[k] = f"{out[k]}, {value}" if k in out else value
    return out
