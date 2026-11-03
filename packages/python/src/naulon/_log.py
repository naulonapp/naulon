"""One log line per distinct problem per minute, so an outage never floods the host's logs."""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

logger = logging.getLogger("naulon")

_WINDOW_S = 60.0
_last: dict[str, float] = {}
_lock = threading.Lock()


def _due(key: str, now: float) -> bool:
    with _lock:
        seen = _last.get(key)
        if seen is not None and now - seen < _WINDOW_S:
            return False
        _last[key] = now
        if len(_last) > 512:
            _last.clear()
        return True


def warn_once(key: str, msg: str, *args: Any) -> None:
    """Log at WARNING unless `key` was logged in the last minute. Never logs a key or a payment."""
    if _due(key, time.monotonic()):
        logger.warning(msg, *args)


def reset() -> None:
    """Test seam."""
    with _lock:
        _last.clear()
