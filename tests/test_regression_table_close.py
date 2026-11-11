"""Closing the table must stay closed when a frame already on the wire arrives during close."""

from __future__ import annotations

import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from shelf.online_source import Online  # noqa: E402
from shelf.online_table import OnlineTable  # noqa: E402


def test_an_in_flight_hello_cannot_reopen_a_closed_table(tmp_path: Path, monkeypatch) -> None:
    from shelf import online_table

    class LateSocket:
        def __init__(self, address, timeout):
            self.ready = threading.Event()
            self.release = threading.Event()
            self.sent = []
            self._once = False

        def send_json(self, message):
            self.sent.append(message)

        def receive(self, timeout):
            if not self._once:
                self._once = True
                self.ready.set()
                self.release.wait(timeout=3)
                return {"t": "hello", "me": {"id": "a"}, "room": {"id": "r"}, "chat": []}
            return None

        def close(self):
            self.release.set()

    sockets: list[LateSocket] = []
    monkeypatch.setattr(
        online_table.wsmod, "Socket",
        lambda address, timeout: sockets.append(LateSocket(address, timeout)) or sockets[-1],
    )
    source = Online(tmp_path, url="http://example.test", secret=lambda _: "person-secret")
    source.turn_on()
    table = OnlineTable(source)
    try:
        assert table.open("room")["ok"] is True
        assert sockets[0].ready.wait(2)
        table.close()
        assert table.snapshot().get("state") == "closed"
        assert "person-secret" not in str(table.snapshot())
    finally:
        table.close()
