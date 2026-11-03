from __future__ import annotations

import logging

import pytest

from naulon import _log
from naulon.facts import lower_headers
from naulon.settings import Settings


def test_missing_gate_means_inactive() -> None:
    assert not Settings.from_env({}).active


def test_enabled_zero_means_inactive_even_with_a_gate() -> None:
    assert not Settings.from_env({"NAULON_GATE": "http://g", "NAULON_ENABLED": "0"}).active
    assert Settings.from_env({"NAULON_GATE": "http://g/"}).gate == "http://g"


def test_a_non_numeric_timeout_falls_back_and_logs(caplog: pytest.LogCaptureFixture) -> None:
    _log.reset()
    with caplog.at_level(logging.WARNING, logger="naulon"):
        s = Settings.from_env({"NAULON_GATE": "http://g", "NAULON_TIMEOUT": "soon"})
    assert s.timeout == 2.0
    assert "NAULON_TIMEOUT" in caplog.text


def test_env_wins_over_the_mapping() -> None:
    s = Settings.from_mapping({"GATE": "http://from-settings", "KEY": "k1"}, {"NAULON_GATE": "http://from-env"})
    assert (s.gate, s.key) == ("http://from-env", "k1")


def test_headers_are_lowercased_and_repeats_joined() -> None:
    assert lower_headers([("Accept", "a"), ("ACCEPT", "b"), ("X-Y", "z")]) == {"accept": "a, b", "x-y": "z"}
