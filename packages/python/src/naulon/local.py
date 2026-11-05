"""Connect for a site you run yourself, started from a terminal beside the app.

    python -m naulon connect --site https://blog.example.com

The command and the running app share one directory (`.naulon/` by default, `NAULON_DIR` to move
it). The command writes the pending connect there; the app, which is what the gate can reach,
answers the gate's challenge from it and finishes the owner's return itself, keeping the site's
credential beside it. The app reads that credential when `NAULON_KEY` is unset, so it starts tolling
without a restart, and the command reports the result.

Wire the app once:

    from naulon.local import LocalConnect
    local = LocalConnect(client_name="My blog")
    app = NaulonWSGI(app, connect=local.connect, credential_for=local.credential_for)

In Django, point `NAULON["CONNECT"]` and `NAULON["CREDENTIAL_FOR"]` at `local.connect` and
`local.credential_for` in a module of your own.

Every file is the owner's alone (directory 0700, files 0600). `take` claims a pending connect by
renaming it, which exactly one process can do, so two workers never exchange one code twice.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict
from pathlib import Path

from naulon.connect import (
    DEFAULT_GATE,
    Connect,
    Connected,
    Failed,
    PendingConnect,
    Started,
    is_site_credential,
    is_state,
)

DEFAULT_DIR = ".naulon"


def naulon_dir(env: Mapping[str, str] | None = None) -> Path:
    """Where the command and the app meet: `NAULON_DIR`, else `.naulon` in the working directory."""
    e = os.environ if env is None else env
    return Path((e.get("NAULON_DIR") or "").strip() or DEFAULT_DIR).resolve()


def _write_atomic(path: Path, body: str) -> None:
    tmp = path.with_name(f"{path.name}.{secrets.token_hex(6)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(fd, body.encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, path)


def _take(path: Path) -> str | None:
    """Rename to a name only this caller knows, then read and remove it: an atomic take."""
    claimed = path.with_name(f"{path.name}.{secrets.token_hex(6)}.taken")
    try:
        os.rename(path, claimed)
    except FileNotFoundError:
        return None
    try:
        return claimed.read_text(encoding="utf-8")
    finally:
        claimed.unlink(missing_ok=True)


class FileConnectStore:
    """A `ConnectStore` in a directory the command and the app share."""

    def __init__(self, directory: Path | str | None = None, clock: Callable[[], float] = time.time) -> None:
        self.dir = Path(directory) if directory is not None else naulon_dir()
        self._connect = self.dir / "connect"
        self._connect.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self._connect, 0o700)
        self._clock = clock

    def _path(self, kind: str, state: str) -> Path:
        # A state is a token from a URL: only its own alphabet ever names a file.
        if not is_state(state):
            raise ValueError("not a connect state")
        return self._connect / f"{kind}-{state}.json"

    def _live(self, raw: str | None) -> PendingConnect | None:
        if raw is None:
            return None
        p = PendingConnect(**json.loads(raw))
        return p if p.expires_at > self._clock() else None

    def put(self, state: str, pending: PendingConnect) -> None:
        _write_atomic(self._path("pending", state), json.dumps(asdict(pending)))

    def get(self, state: str) -> PendingConnect | None:
        if not is_state(state):
            return None
        try:
            return self._live(self._path("pending", state).read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None

    def take(self, state: str) -> PendingConnect | None:
        return self._live(_take(self._path("pending", state))) if is_state(state) else None

    def put_result(self, state: str, result: Connected | Failed) -> None:
        if isinstance(result, Connected):
            body = {"ok": True, "site": result.site, "gate": result.gate}
        else:
            body = {"ok": False, "error": result.error, "message": result.message}
        _write_atomic(self._path("result", state), json.dumps(body))

    def take_result(self, state: str) -> dict[str, object] | None:
        raw = _take(self._path("result", state)) if is_state(state) else None
        return None if raw is None else dict(json.loads(raw))

    def read_credential(self) -> str | None:
        try:
            raw = (self.dir / "credential").read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            return None
        return raw if is_site_credential(raw) else None

    def write_credential(self, credential: str) -> None:
        _write_atomic(self.dir / "credential", f"{credential}\n")


class LocalConnect:
    """The app's half of `naulon connect`: a `Connect` that finishes the return itself, and the
    credential it left, for the middleware (`NAULON_KEY` pins one instead)."""

    def __init__(
        self,
        client_name: str,
        gate: str | None = None,
        directory: Path | str | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> None:
        env = os.environ if environ is None else environ
        self.store = FileConnectStore(directory if directory is not None else naulon_dir(env))
        self._pinned = (env.get("NAULON_KEY") or "").strip() or None
        self.connect = Connect(
            client_name,
            gate=gate or (env.get("NAULON_GATE") or "").strip() or DEFAULT_GATE,
            store=self.store,
            on_finish=self._finished,
        )

    def _finished(self, state: str, result: Connected | Failed) -> None:
        if isinstance(result, Connected):
            self.store.write_credential(result.credential)
        if is_state(state):
            self.store.put_result(state, result)

    def credential_for(self, host: str) -> str | None:
        """The credential for this process's site, whatever the host: the gate answers only for the
        host it was approved for, so another hostname reads free."""
        return self._pinned or self.store.read_credential()


def connect_main(
    argv: Sequence[str], out: Callable[[str], None] = print, err: Callable[[str], None] | None = None
) -> int:
    """`python -m naulon connect`: start a connect beside the running app and wait for it."""
    say_err = err or (lambda line: print(line, file=sys.stderr))
    parser = argparse.ArgumentParser(prog="python -m naulon connect", description="Connect a site you run to its gate.")
    parser.add_argument("--site", default=os.environ.get("NAULON_SITE"), help="the site's own address (or NAULON_SITE)")
    parser.add_argument("--gate", default=os.environ.get("NAULON_GATE"), help="the gate (or NAULON_GATE)")
    parser.add_argument("--dir", default=None, help="the directory shared with the app (or NAULON_DIR)")
    parser.add_argument("--timeout", type=float, default=15.0, help="minutes to wait for the approval")
    args = parser.parse_args(list(argv))
    if not args.site:
        say_err("naulon connect: --site is required, e.g. --site https://blog.example.com")
        return 2
    store = FileConnectStore(args.dir if args.dir else naulon_dir())
    # The owner reads the app's own name, from the document the app serves; this one is never shown.
    # The operator runs this on the app's own machine, for the app's own address.
    connect = Connect("naulon connect", gate=args.gate or DEFAULT_GATE, store=store, site=args.site)
    started = connect.start(args.site)
    if not isinstance(started, Started):
        say_err(f"naulon connect: {started.message}")
        return 1
    state = dict(_query(started.url)).get("state", "")
    out("Open this address to approve, on any device:\n")
    out(f"  {started.url}\n")
    out(f"Waiting for the approval (up to {args.timeout:g} min). The app finishes the connect; leave it running.")
    deadline = time.time() + args.timeout * 60
    result: dict[str, object] | None = None
    while result is None and time.time() < deadline:
        time.sleep(1)
        result = store.take_result(state)
    if result is None:
        say_err("naulon connect: no approval arrived in time. Run it again when you are ready to approve.")
        return 1
    if not result.get("ok"):
        say_err(f"naulon connect: {result.get('message')}")
        return 1
    out(f"\nConnected: {result['site']} tolls through {result['gate']}.")
    out(f"The app keeps the credential in {store.dir / 'credential'} and uses it now, with no restart.")
    out("To pin it instead, set NAULON_KEY to that value in the app's environment.")
    return 0


def _query(url: str) -> list[tuple[str, str]]:
    import urllib.parse

    return urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query)
