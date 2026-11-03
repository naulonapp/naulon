from __future__ import annotations

import logging

import pytest

from naulon import _log


def _raised(message: str) -> RuntimeError:
    try:
        raise RuntimeError(message)
    except RuntimeError as err:
        return err


def test_warn_error_names_the_type_and_keeps_the_message_out_of_warning(caplog: pytest.LogCaptureFixture) -> None:
    _log.reset()
    with caplog.at_level(logging.WARNING, logger="naulon"):
        _log.warn_error("t.start", "naulon: request passed through after an internal error", _raised("payment=secret"))
    assert "RuntimeError" in caplog.text
    assert "DEBUG" in caplog.text, "the line says where the cause is"
    assert "payment=secret" not in caplog.text


def test_warn_error_puts_the_traceback_at_debug(caplog: pytest.LogCaptureFixture) -> None:
    _log.reset()
    with caplog.at_level(logging.DEBUG, logger="naulon"):
        _log.warn_error("t.debug", "naulon: config refresh failed", _raised("settings already configured"))
    debug = [r for r in caplog.records if r.levelno == logging.DEBUG]
    assert len(debug) == 1
    assert debug[0].exc_info is not None
    assert "settings already configured" in caplog.text


def test_warn_error_is_rate_limited_like_warn_once(caplog: pytest.LogCaptureFixture) -> None:
    _log.reset()
    with caplog.at_level(logging.DEBUG, logger="naulon"):
        for _ in range(3):
            _log.warn_error("t.flood", "naulon: report flush failed", _raised("x"))
    assert len([r for r in caplog.records if r.levelno == logging.WARNING]) == 1
    assert len([r for r in caplog.records if r.levelno == logging.DEBUG]) == 1
