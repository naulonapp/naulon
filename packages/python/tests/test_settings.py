from __future__ import annotations

import logging

import pytest

from naulon import _log
from naulon.facts import lower_headers
from naulon.settings import Settings


def test_no_gate_means_the_hosted_one() -> None:
    assert Settings.from_env({}).gate == "https://gate.naulon.app"


def test_enabled_zero_means_inactive_even_with_a_gate() -> None:
    assert not Settings.from_env({"NAULON_GATE": "https://gate.test", "NAULON_ENABLED": "0"}).active
    assert Settings.from_env({"NAULON_GATE": "https://gate.test/"}).gate == "https://gate.test"
    assert Settings.from_env({"NAULON_GATE": "https://Gate.Test:443/x"}).gate == "https://gate.test"


def test_a_gate_a_credential_would_reach_in_clear_is_refused(caplog: pytest.LogCaptureFixture) -> None:
    _log.reset()
    with caplog.at_level(logging.WARNING, logger="naulon"):
        s = Settings.from_env({"NAULON_GATE": "http://gate.example.com", "NAULON_KEY": "k"})
    assert s.gate is None and not s.active
    assert "must be an https URL" in caplog.text
    assert Settings.from_env({"NAULON_GATE": "http://127.0.0.1:8402"}).gate == "http://127.0.0.1:8402", "a local walk"


def test_a_non_numeric_timeout_falls_back_and_logs(caplog: pytest.LogCaptureFixture) -> None:
    _log.reset()
    with caplog.at_level(logging.WARNING, logger="naulon"):
        s = Settings.from_env({"NAULON_GATE": "https://gate.test", "NAULON_TIMEOUT": "soon"})
    assert s.timeout == 2.0
    assert "NAULON_TIMEOUT" in caplog.text


def test_env_wins_over_the_mapping() -> None:
    s = Settings.from_mapping(
        {"GATE": "https://from-settings.test", "KEY": "k1"}, {"NAULON_GATE": "https://from-env.test"}
    )
    assert (s.gate, s.key) == ("https://from-env.test", "k1")


def test_headers_are_lowercased_and_repeats_joined() -> None:
    assert lower_headers([("Accept", "a"), ("ACCEPT", "b"), ("X-Y", "z")]) == {"accept": "a, b", "x-y": "z"}
