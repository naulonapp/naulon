"""Address and prefix math for the crawler identity check, ported from `packages/shared/src/ipRange.ts`
by way of the PHP plugin's `Naulon_Ip`. Hand-written rather than `ipaddress`: the reference reads a
leading-zero IPv4 octet as decimal, which `ipaddress` refuses, and every runtime must agree on every
input. An IPv4-mapped IPv6 address is normalised to IPv4."""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

MIN_PREFIX_V4 = 12
MIN_PREFIX_V6 = 28

RESERVED = (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
    "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24",
    "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
    "::/128", "::1/128", "64:ff9b::/96", "100::/64", "2001:db8::/32", "fc00::/7", "fe80::/10", "ff00::/8",
)  # fmt: skip

_V4_PART = re.compile(r"\d{1,3}\Z")
_V6_GROUP = re.compile(r"[0-9a-fA-F]{1,4}\Z")
_LEN = re.compile(r"\d{1,3}\Z")
_BRACKETED = re.compile(r"\[([^\]]+)\](?::\d{1,5})?\Z")
_V4_PORT = re.compile(r"(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}\Z")
_MAPPED = b"\x00" * 10 + b"\xff\xff"


@dataclass(frozen=True)
class Addr:
    family: int
    raw: bytes


@dataclass(frozen=True)
class Cidr:
    family: int
    net: bytes
    bits: int


def _v4(s: str) -> bytes | None:
    parts = s.split(".")
    if len(parts) != 4:
        return None
    out = bytearray()
    for p in parts:
        if not _V4_PART.match(p):
            return None
        n = int(p)
        if n > 255:
            return None
        out.append(n)
    return bytes(out)


def _v6(s: str) -> bytes | None:
    pct = s.find("%")
    if pct != -1:
        s = s[:pct]
    tail: bytes | None = None
    if "." in s:
        last = s.rfind(":")
        if last == -1:
            return None
        tail = _v4(s[last + 1 :])
        if tail is None:
            return None
        s = s[: last + 1] + "0:0"
    halves = s.split("::")
    if len(halves) > 2:
        return None
    head = halves[0].split(":") if halves[0] != "" else []
    rest = halves[1].split(":") if len(halves) == 2 and halves[1] != "" else []
    if len(halves) == 2:
        if len(head) + len(rest) > 7:
            return None
        groups = head + ["0"] * (8 - len(head) - len(rest)) + rest
    else:
        groups = head
    if len(groups) != 8:
        return None
    out = bytearray()
    for g in groups:
        if not _V6_GROUP.match(g):
            return None
        out += int(g, 16).to_bytes(2, "big")
    if tail is not None:
        out = out[:12] + tail
    return bytes(out)


def _parse_raw(text: object) -> Addr | None:
    if not isinstance(text, str):
        return None
    s = text.strip()
    if len(s) >= 2 and s[0] == "[" and s[-1] == "]":
        s = s[1:-1]
    if s == "":
        return None
    if ":" in s:
        b6 = _v6(s)
        return None if b6 is None else Addr(6, b6)
    b4 = _v4(s)
    return None if b4 is None else Addr(4, b4)


def _is_mapped(a: Addr) -> bool:
    return a.family == 6 and a.raw[:12] == _MAPPED


def parse(text: object) -> Addr | None:
    a = _parse_raw(text)
    if a is not None and _is_mapped(a):
        return Addr(4, a.raw[12:])
    return a


def parse_client_address(text: object) -> Addr | None:
    """An address as a header carries it: optionally quoted, an IPv6 bracketed, either with a port."""
    if not isinstance(text, str):
        return None
    v = text.strip()
    if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
        v = v[1:-1].strip()
    m = _BRACKETED.match(v)
    if m:
        return parse(m.group(1))
    m = _V4_PORT.match(v)
    if m:
        return parse(m.group(1))
    return parse(v)


def _mask(raw: bytes, bits: int) -> bytes:
    whole, rem = divmod(bits, 8)
    out = bytearray(raw[:whole])
    if whole < len(raw):
        out.append(0 if rem == 0 else raw[whole] & (0xFF << (8 - rem)) & 0xFF)
        out += b"\x00" * (len(raw) - whole - 1)
    return bytes(out)


def parse_cidr(text: object, min4: int = MIN_PREFIX_V4, min6: int = MIN_PREFIX_V6) -> Cidr | None:
    if not isinstance(text, str):
        return None
    slash = text.find("/")
    if slash == -1:
        return None
    length = text[slash + 1 :].strip()
    if not _LEN.match(length):
        return None
    bits = int(length)
    a = _parse_raw(text[:slash])
    if a is None:
        return None
    if _is_mapped(a) and bits >= 96:
        a = Addr(4, a.raw[12:])
        bits -= 96
    total = 32 if a.family == 4 else 128
    if bits > total or bits < (min4 if a.family == 4 else min6):
        return None
    return Cidr(a.family, _mask(a.raw, bits), bits)


def compile_prefixes(prefixes: Iterable[object], min4: int = MIN_PREFIX_V4, min6: int = MIN_PREFIX_V6) -> list[Cidr]:
    out = []
    for p in prefixes:
        c = parse_cidr(p, min4, min6)
        if c is not None:
            out.append(c)
    return out


def contains(a: Addr, c: Cidr) -> bool:
    if a.family != c.family:
        return False
    return _mask(a.raw, c.bits) == c.net


def in_any(a: Addr, cidrs: Sequence[Cidr]) -> bool:
    return any(contains(a, c) for c in cidrs)


_RESERVED = compile_prefixes(RESERVED, 0, 0)


def is_reserved(a: Addr) -> bool:
    """True for an address no public host has: private, loopback, link-local, documentation, multicast."""
    return in_any(a, _RESERVED)


def usable(a: Addr, proxy_sets: Iterable[Sequence[Cidr]]) -> bool:
    """True when `a` can be a caller's own public address. A proxy's address is the proxy speaking."""
    if is_reserved(a):
        return False
    return not any(in_any(a, s) for s in proxy_sets)


def truncate(a: Addr) -> str:
    """The /24 or /48 an address sits in: enough to tell operators apart, not enough to name a host."""
    b = a.raw
    if a.family == 4:
        return f"{b[0]}.{b[1]}.{b[2]}.0/24"
    groups = [format((b[i] << 8) | b[i + 1], "x") for i in range(0, 6, 2)]
    return ":".join(groups) + "::/48"
