"""One log line per distinct problem per minute, so an outage never floods the host's logs."""

from __future__ import annotations

import logging
import threading
import time
import traceback
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


def warn_error(key: str, msg: str, err: BaseException) -> None:
    """`warn_once` for a caught exception. Neither line carries the exception's message, because it
    can quote a payment header or a key, and a host whose root logger runs at DEBUG would print it
    without ever asking for naulon's. The WARNING names the type; DEBUG adds the frames, which point
    at the line that raised."""
    if _due(key, time.monotonic()):
        logger.warning("%s (%s; set the naulon logger to DEBUG for where it was raised)", msg, type(err).__name__)
        if logger.isEnabledFor(logging.DEBUG):
            frames = "".join(traceback.format_tb(err.__traceback__))
            logger.debug("naulon: %s raised %s at\n%s", key, type(err).__name__, frames.rstrip())


def reset() -> None:
    """Test seam."""
    with _lock:
        _last.clear()
