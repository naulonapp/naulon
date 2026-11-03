"""Which paths are tolled, and under which slug. A port of `slugForScope` in
`packages/sdk/src/contract/slug.ts`, held to `scope-cases.json`."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any
from urllib.parse import unquote_to_bytes

STATIC_EXTENSIONS = (
    "avif", "css", "eot", "gif", "ico", "jpeg", "jpg", "js", "json", "map", "mjs", "mp3", "mp4",
    "otf", "pdf", "png", "svg", "ttf", "txt", "webm", "webp", "woff", "woff2", "xml",
)  # fmt: skip

_STATIC_EXT = re.compile(r"\.(" + "|".join(STATIC_EXTENSIONS) + r")\Z", re.IGNORECASE)
_DISCOVERY_ROOT = re.compile(r"/(robots\.txt|sitemap[^/]*|rss[^/]*|atom[^/]*|feed[^/]*|favicon\.ico)\Z", re.IGNORECASE)
_DISCOVERY_FILE = re.compile(
    r"(robots\.txt|llms\.txt|ads\.txt|app-ads\.txt|security\.txt|favicon\.ico)\Z", re.IGNORECASE
)
_SITEMAP_FILE = re.compile(r"(^|[-_.])sitemap([-_.][^/]*)?\.xml(\.gz)?\Z", re.IGNORECASE)
_FEED_FILE = re.compile(r"(feed|feeds|rss|atom|index)(\.(xml|rss|atom|json))?\Z", re.IGNORECASE)
_EXTENSION = re.compile(r"\.([A-Za-z0-9]+)\Z")
_BAD_PERCENT = re.compile(r"%(?![0-9A-Fa-f]{2})")


def decode_slug(raw: str) -> str | None:
    """`decodeURIComponent`, or None where it would throw: a stray `%` or bytes that are not UTF-8."""
    if _BAD_PERCENT.search(raw):
        return None
    try:
        return unquote_to_bytes(raw).decode("utf-8")
    except UnicodeDecodeError:
        return None


def _is_control_route(pathname: str) -> bool:
    p = re.sub(r"^/+", "/", pathname)
    return p.startswith(("/.well-known/", "/licenses/", "/_naulon/"))


def _strings(v: Any) -> list[str]:
    return [x for x in v if isinstance(x, str)] if isinstance(v, (list, tuple)) else []


def slug_from_path(path: str, prefixes: Sequence[str], depth: str = "segment") -> str | None:
    if _is_control_route(path):
        return None
    clean = [p for p in _strings(prefixes) if p]
    if not clean:
        return None
    tail = r"([^?#]+)" if depth == "rest" else r"([^/?#]+)"
    m = re.match(r"/(?:" + "|".join(re.escape(p) for p in clean) + r")/" + tail, path)
    return decode_slug(m.group(1)) if m else None


def _last_segment(pathname: str) -> str:
    parts = [p for p in pathname.split("/") if p]
    return parts[-1] if parts else ""


def _is_discovery(pathname: str) -> bool:
    if _DISCOVERY_ROOT.match(pathname):
        return True
    seg = _last_segment(pathname)
    return bool(_DISCOVERY_FILE.match(seg) or _SITEMAP_FILE.search(seg) or _FEED_FILE.match(seg))


def slug_from_site_path(
    path: str, exclude_prefixes: Sequence[str], include_extensions: Sequence[str] = ()
) -> str | None:
    pathname = re.split(r"[?#]", path, maxsplit=1)[0]
    if _is_control_route(pathname) or _is_discovery(pathname):
        return None
    if _STATIC_EXT.search(pathname):
        m = _EXTENSION.search(pathname)
        ext = m.group(1).lower() if m else None
        if ext is None or ext not in _strings(include_extensions):
            return None
    clean = [p for p in _strings(exclude_prefixes) if p]
    if any(pathname == f"/{p}" or pathname.startswith(f"/{p}/") for p in clean):
        return None
    return decode_slug(pathname)


_PCT = re.compile(r"%([0-9A-Fa-f]{2})")
_UNRESERVED = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")


def normalize_unreserved(path: str) -> str:
    """Decode the percent-encodings of unreserved characters (RFC 3986 §6.2.2.2), as
    `normalizeUnreserved` in @naulon/sdk does. A framework routes `/%62log/x` as `/blog/x`, so
    scoping the literal spelling would let an agent read any article free."""

    def one(m: re.Match[str]) -> str:
        c = chr(int(m.group(1), 16))
        return c if c in _UNRESERVED else m.group(0)

    return _PCT.sub(one, path)


def slug_for_scope(raw_path: str, enforcement: Mapping[str, Any]) -> str | None:
    """The slug `path` is tolled under, or None when it reads free. `enforcement` is the
    `enforcement` object of `/_naulon/enforce-config` (`articlePrefixes`, `gateScope`)."""
    path = normalize_unreserved(raw_path)
    scope = enforcement.get("gateScope")
    if isinstance(scope, dict) and scope.get("mode") == "site":
        return slug_from_site_path(
            path, _strings(scope.get("excludePrefixes")), _strings(scope.get("includeExtensions"))
        )
    depth = scope.get("depth") if isinstance(scope, dict) and scope.get("mode") == "prefixes" else None
    return slug_from_path(path, _strings(enforcement.get("articlePrefixes")), "rest" if depth == "rest" else "segment")
