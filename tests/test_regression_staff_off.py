"""Forgetting the staff key has to survive a restart. The flag was saved and never read back."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from shelf import online_source  # noqa: E402


class _Opener:
    def __init__(self, answer):
        self.answer = answer

    def __call__(self, request, timeout=0):
        body = json.dumps(self.answer).encode()

        class Answer:
            status = 200

            def read(self, limit=0):
                return body

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        return Answer()


def test_a_forgotten_staff_key_stays_forgotten_after_restart(tmp_path: Path, monkeypatch) -> None:
    secrets: dict[str, str] = {online_source.KEY_ENV: "account-key"}
    monkeypatch.setattr(online_source, "read_secret", lambda name: secrets.get(name, ""))

    def store(name, value):
        secrets[name] = value
        return True

    opener = _Opener({"role": "moderator", "name": "Ada", "powers": ["reports"]})
    source = online_source.Online(tmp_path, opener=opener, secret=lambda name: secrets.get(name, ""),
                                  store_secret=store)
    source.turn_on()
    saved = source.set_staff_key("staff-secret")
    assert saved["ok"] is True, saved
    assert source.staff_key() == "staff-secret"
    assert source.clear_staff_key()["ok"] is True
    assert source.staff_key() == ""
    on_disk = json.loads((tmp_path / online_source.STATE_FILE).read_text(encoding="utf-8"))
    assert on_disk["staff_off"] is True

    restarted = online_source.Online(tmp_path, opener=opener, secret=lambda name: secrets.get(name, ""),
                                     store_secret=store)
    assert restarted.on is True
    assert restarted.staff_key() == ""
    assert "staff-secret" not in json.dumps(restarted.snapshot())
