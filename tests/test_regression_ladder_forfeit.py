"""Only a player at the table may end it, even when the clock has run out.

A ladder room forfeits the side to move once its move clock expires. That check ran
before the referee saw who was acting, so anyone who could reach the room — a
spectator, a passer-by — could trigger the forfeit and record the loss. The clock
had expired, so the result is the one the janitor would reach anyway; the defect is
that a person who is not at the table decides when it is recorded.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from online.rooms import Rooms, load_games  # noqa: E402
from online.store import Store  # noqa: E402

HOST = {"id": "web:host", "name": "Ada", "bot": False}
BYSTANDER = {"id": "web:other", "name": "Eve", "bot": False}


def _ladder_room(tmp_path: Path):
    store = Store(tmp_path / "online.sqlite3")
    clock = [1000.0]
    rooms = Rooms(store, tmp_path, games=load_games(), clock=lambda: clock[0])
    store.create_player("Host")  # ensures the player row exists for lookups
    room, refusal = rooms.create("connect4", HOST, public=True, mode="bot")
    assert room and not refusal, refusal
    store.mark_ladder(room["id"], True)
    rooms.turn_since[room["id"]] = clock[0] - 999  # long past any move clock
    return store, rooms, room


def test_a_bystander_cannot_force_a_ladder_forfeit(tmp_path: Path) -> None:
    store, rooms, room = _ladder_room(tmp_path)
    result = rooms.run(store.room(room["id"]), BYSTANDER, "move", ["1"])
    state = rooms.state(store.room(room["id"])) or {}
    assert state.get("status") != "resigned", "someone who is not at the table ended it"
    assert result.get("ok") is False, result


def test_a_seated_player_still_loses_on_time(tmp_path: Path) -> None:
    """The clock must still work: the side to move owns the forfeit, whoever asks."""
    store, rooms, room = _ladder_room(tmp_path)
    state = rooms.state(store.room(room["id"])) or {}
    seated = str(state.get("white_id") or "")
    assert seated, state
    player = {"id": seated, "name": "Seat", "bot": seated.startswith("bot:")}
    result = rooms.run(store.room(room["id"]), player, "move", ["1"])
    after = rooms.state(store.room(room["id"])) or {}
    assert after.get("status") == "resigned", (result, after.get("status"))
