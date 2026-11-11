"""The table log names seats, never raw engine numbers.

A newcomer reading "Player 3 was killed during the night" or a vote shown as a
bare "[0]" cannot tell who is who. Every line a person reads must use the name
on the seat, for Mafia and for Liar's Dice.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf.who import Player  # noqa: E402
from talktable.engine import create  # noqa: E402

ME = Player("desktop:me", "Ada", "desktop")
WATCHER = Player("desktop:watcher", "Watcher", "desktop")


def table(tmp_path: Path, game_id: str):
    data = tmp_path / "data"
    folder = data / game_id
    folder.mkdir(parents=True, exist_ok=True)
    return create(folder, game_id, {"data_root": str(data)})


def play_bots(tmp_path: Path, game_id: str, seats: int, seed: int):
    """Play a whole table of built-in seats and collect everything a watcher reads."""
    played = table(tmp_path, game_id)
    assert "Table set" in played.command(
        f"new seats={seats} bots=1 seed={seed}", player=ME)
    logs = []
    for _ in range(400):
        picture = played.picture(player=WATCHER)
        logs.extend(picture.get("log") or [])
        if picture["status"] != "active":
            break
        assert picture.get("can_step"), picture
        played.command("step", player=WATCHER)
    done = played.picture(player=WATCHER)
    logs.extend(done.get("log") or [])
    return done, logs


def seat_names(picture):
    return {place["name"] for place in picture.get("places") or []}


def assert_no_engine_numbers(logs, names, game_id):
    assert logs, f"{game_id}: the log stayed empty"
    for row in logs:
        text = str(row.get("text") or "")
        assert not re.search(r"\bPlayer \d+\b", text), f"{game_id}: {text!r}"
        assert not re.search(r"\[\d+\]", text), f"{game_id}: {text!r}"
    assert any(name in str(row.get("text") or "") for row in logs for name in names), \
        f"{game_id}: no log line named a seat"


def test_a_mafia_log_names_the_seats(tmp_path):
    done, logs = play_bots(tmp_path, "mafia", 6, 11)
    assert done["status"] == "done"
    names = seat_names(done)
    assert_no_engine_numbers(logs, names, "mafia")
    for row in logs:
        text = str(row.get("text") or "")
        if "was killed during the night" in text or "was eliminated by vote" in text:
            assert any(name in text for name in names), text
    assert any("was killed during the night" in str(row.get("text") or "") for row in logs), \
        "the round never logged a night kill"
    assert any("was eliminated by vote" in str(row.get("text") or "") for row in logs), \
        "the round never logged a vote"


def test_a_liars_dice_log_names_the_seats(tmp_path):
    done, logs = play_bots(tmp_path, "liars-dice", 3, 8)
    assert done["status"] == "done"
    names = seat_names(done)
    assert_no_engine_numbers(logs, names, "liars-dice")
    assert any("bid" in str(row.get("text") or "") for row in logs), \
        "the round never logged a bid"
