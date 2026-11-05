"""The directory `naulon connect` and the running app share."""

from __future__ import annotations

import os
import stat
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from naulon.connect import PendingConnect
from naulon.local import FileConnectStore

STATE = "s" * 32


def pending(expires_at: float) -> PendingConnect:
    return PendingConnect(
        "https://blog.example.com",
        "https://gate.example.com",
        "v",
        "c",
        "https://blog.example.com/naulon/connect/return",
        expires_at,
    )


def test_of_many_takes_racing_for_one_connect_exactly_one_gets_it(tmp_path: Path) -> None:
    store = FileConnectStore(tmp_path)
    store.put(STATE, pending(9e12))
    with ThreadPoolExecutor(16) as pool:
        got = [p for p in pool.map(lambda _: store.take(STATE), range(32)) if p is not None]
    assert len(got) == 1
    assert store.get(STATE) is None


def test_an_expired_connect_is_not_handed_out(tmp_path: Path) -> None:
    t = [1000.0]
    store = FileConnectStore(tmp_path, clock=lambda: t[0])
    store.put(STATE, pending(2000.0))
    t[0] = 2000.0
    assert store.get(STATE) is None and store.take(STATE) is None


def test_everything_is_the_owners_alone_and_a_state_cannot_name_a_path(tmp_path: Path) -> None:
    store = FileConnectStore(tmp_path)
    store.put(STATE, pending(9e12))
    store.write_credential("nln_site_" + "A" * 43)
    assert stat.S_IMODE(os.stat(tmp_path / "connect").st_mode) == 0o700
    for f in (tmp_path / "connect").iterdir():
        assert stat.S_IMODE(os.stat(f).st_mode) == 0o600, f
    assert stat.S_IMODE(os.stat(tmp_path / "credential").st_mode) == 0o600
    assert store.get("../../etc/passwd") is None
    with pytest.raises(ValueError):
        store.put("../escape-this-directory-now", pending(1))
    assert store.read_credential() == "nln_site_" + "A" * 43


def test_a_credential_file_holding_anything_else_is_ignored(tmp_path: Path) -> None:
    store = FileConnectStore(tmp_path)
    store.write_credential("not-a-credential")
    assert store.read_credential() is None


def test_python_dash_m_naulon_says_how_to_use_it() -> None:
    r = subprocess.run(
        [sys.executable, "-m", "naulon", "connect"], capture_output=True, text=True, timeout=30, check=False
    )
    assert r.returncode == 2 and "--site is required" in r.stderr


def test_a_return_for_a_connect_this_site_never_started_leaves_nothing_on_disk(tmp_path: Path) -> None:
    from naulon.local import LocalConnect

    local = LocalConnect("My blog", directory=tmp_path, environ={})
    for i in range(25):
        state = "x" * 30 + f"{i:02d}"
        answer = local.connect.answer(
            "https", "blog.example.com", "/naulon/connect/return", "GET", f"state={state}&code=nln_code_x"
        )
        assert answer is not None and answer.status == 400
    assert list((tmp_path / "connect").iterdir()) == []
