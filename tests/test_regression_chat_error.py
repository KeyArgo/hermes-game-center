"""A command result is not a chat refusal. Only a result with no ref is the table turning a message down."""

from __future__ import annotations

import queue
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from shelf.online_source import Online  # noqa: E402
from shelf.online_table import OnlineTable  # noqa: E402


def _wait(predicate, timeout=2):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def test_a_command_refusal_is_not_stored_as_a_chat_error(tmp_path: Path, monkeypatch) -> None:
    from shelf import online_table

    class Scripted:
        def __init__(self, address, timeout):
            self.inbox = queue.Queue()
            self.sent = []
            self.inbox.put({"t": "hello", "me": {"id": "a"}, "room": {"id": "r"}, "chat": []})
            self.inbox.put({"t": "result", "ref": 4, "ok": False, "text": "Illegal move."})

        def send_json(self, message):
            self.sent.append(message)

        def receive(self, timeout):
            try:
                return self.inbox.get(timeout=timeout)
            except queue.Empty:
                return None

        def close(self):
            pass

    sockets: list[Scripted] = []
    monkeypatch.setattr(
        online_table.wsmod, "Socket",
        lambda address, timeout: sockets.append(Scripted(address, timeout)) or sockets[-1],
    )
    source = Online(tmp_path, url="http://example.test", secret=lambda _: "person-secret")
    source.turn_on()
    table = OnlineTable(source)
    try:
        assert table.open("room")["ok"] is True
        assert _wait(lambda: table.snapshot().get("state") == "live")
        # Long enough for the queued command result to be applied if it is going to be.
        assert not _wait(lambda: table.snapshot().get("chat_error"), timeout=1)
        assert table.snapshot().get("chat_error") is None

        sockets[0].inbox.put({"t": "result", "ref": None, "ok": False, "text": "You are silenced."})
        assert _wait(lambda: (table.snapshot().get("chat_error") or {}).get("text") == "You are silenced.")
        assert table.snapshot()["chat_error"]["text"] == "You are silenced."
        assert "person-secret" not in str(table.snapshot())
    finally:
        table.close()
