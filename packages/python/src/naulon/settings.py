"""Where the middleware finds its gate, and whether it runs at all."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from naulon._log import warn_once

DEFAULT_TIMEOUT = 2.0
DEFAULT_REFRESH_S = 300.0


@dataclass(frozen=True)
class Settings:
    """`gate` is the gate's base URL. Without one, nothing runs."""

    gate: str | None
    key: str | None
    enabled: bool = True
    timeout: float = DEFAULT_TIMEOUT
    refresh_s: float = DEFAULT_REFRESH_S

    @property
    def active(self) -> bool:
        return self.enabled and self.gate is not None

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> Settings:
        return cls.from_mapping({}, environ)

    @classmethod
    def from_mapping(cls, m: Mapping[str, Any], environ: Mapping[str, str] | None = None) -> Settings:
        """Read `GATE`, `KEY`, `ENABLED`, `TIMEOUT` from `m`; `NAULON_*` in the environment wins."""
        env = os.environ if environ is None else environ

        # Spelled out, not built from a prefix, so every name a reader can set is greppable.
        def pick(from_env: str | None, from_mapping: Any) -> Any:
            return from_env if from_env is not None else from_mapping

        gate = _text(pick(env.get("NAULON_GATE"), m.get("GATE")))
        return cls(
            gate=gate.rstrip("/") if gate else None,
            key=_text(pick(env.get("NAULON_KEY"), m.get("KEY"))),
            enabled=_flag(pick(env.get("NAULON_ENABLED"), m.get("ENABLED"))),
            timeout=_seconds(pick(env.get("NAULON_TIMEOUT"), m.get("TIMEOUT"))),
        )


def _text(v: Any) -> str | None:
    if not isinstance(v, str):
        return None
    s = v.strip()
    return s or None


def _flag(v: Any) -> bool:
    if v is None:
        return True
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() not in ("0", "false", "no", "off", "")


def _seconds(v: Any) -> float:
    if v is None:
        return DEFAULT_TIMEOUT
    try:
        t = float(v)
    except (TypeError, ValueError):
        warn_once("settings.timeout", "NAULON_TIMEOUT is not a number; using %.1f s", DEFAULT_TIMEOUT)
        return DEFAULT_TIMEOUT
    if not (0 < t <= 30):
        warn_once("settings.timeout", "NAULON_TIMEOUT must be between 0 and 30 seconds; using %.1f s", DEFAULT_TIMEOUT)
        return DEFAULT_TIMEOUT
    return t
