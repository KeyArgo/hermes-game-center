"""Replay proofs: every shipped game's recorded moves must rebuild the exact final state.

Each test plays a full bot-vs-bot game through the real table bookkeeping
(``kit.Table._count``, the trim/cap logic at kit.py:603), then rebuilds the
state from ``state["moves"]`` alone -- the same replay ``kit.lesson_position``
performs for lesson setups, minus the "must stay active" guard so the final
move may end the game.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from shelf.kitref import kit

ROOT = Path(__file__).resolve().parent.parent

GAMES = ["connect4", "reversi", "checkers", "breakthrough", "gomoku", "chessboard", "go", "hex"]

CAP = 400  # safety guard on the bot mirror match, per the replay contract


def _load(name: str):
    """Load a shipped game module the way the shelf does, by path."""
    spec = importlib.util.spec_from_file_location(f"replay_{name}", ROOT / name / "game.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _rules(name: str):
    return kit.rules(vars(_load(name)))


def _start(rules) -> dict:
    state = {"turn": "white", "status": "active", "winner": "", "plies": 0, "moves": [], "last": ""}
    state.update(rules.fresh())
    return state


def _mirror(table, rules, cap: int | None = None) -> dict:
    """Bot vs bot until the game is over, exactly as Table._finish counts plies."""
    limit = cap if cap is not None else CAP
    state = _start(rules)
    guard = 0
    while state.get("status") == "active" and guard < limit:
        shown = rules.show(rules.bot(state))
        rules.play(state, rules.parse(shown.split()))
        table._count(state, shown)  # the real ply/trim/cap bookkeeping, kit.py:601
        guard += 1
    return state


def _replay(rules, moves: list[str]) -> dict:
    """Rebuild the state from the move list alone.

    Applies the same bookkeeping ``Table._count`` applies on live play
    (kit.py:601: ply count, history trim, ply-cap draw) -- the same replay
    ``kit.lesson_position`` performs for lesson setups, plus the cap the
    table enforces, minus the "must stay active" guard so the final move
    may end the game.
    """
    state = _start(rules)
    for token in moves:
        move = rules.parse(str(token).split())
        assert move is not None, f"recorded move {token!r} does not parse"
        assert move in rules.legal(state), f"recorded move {token!r} is illegal on replay"
        rules.play(state, move)
        shown = rules.show(move)
        state["plies"] = int(state.get("plies") or 0) + 1
        state["last"] = shown
        state["moves"] = [*state.get("moves", []), shown][-rules.MAX_PLIES:]
        if state.get("status") == "active" and state["plies"] >= rules.MAX_PLIES:
            state["status"] = "draw"
            state["winner"] = ""
    return state


@pytest.mark.parametrize("name", GAMES)
def test_recorded_moves_rebuild_the_final_state(name: str, tmp_path: Path) -> None:
    rules = _rules(name)
    final = _mirror(kit.Table(tmp_path, rules), rules)
    assert final["status"] != "active", f"{name}: the bot mirror match never ended"

    again = _replay(rules, final["moves"])

    assert again["status"] == final["status"]
    assert again["winner"] == final["winner"]
    assert again["plies"] == final["plies"]
    assert again["moves"] == final["moves"]
    assert again["last"] == final["last"]
    for key, value in rules.fresh().items():  # board cells / pits / captured stones ...
        assert again[key] == final[key], f"{name}: {key!r} differs after replay"


def test_ply_cap_keeps_the_opening_moves(tmp_path: Path) -> None:
    # kit.py:603 trims moves to the last MAX_PLIES; a real game's ply count is
    # capped by the same constant, so the trim must be a no-op on history:
    # at the cap the very first move is still present, nothing lost.
    rules = _rules("checkers")
    rules.MAX_PLIES = 6  # namespace copy; the shipped game.py is untouched
    table = kit.Table(tmp_path, rules)
    final = _mirror(table, rules, cap=rules.MAX_PLIES * 2)

    assert final["plies"] == 6  # the cap itself ended the game, not the rules
    assert final["status"] == "draw" and final["winner"] == ""
    assert len(final["moves"]) == final["plies"]
    assert final["moves"][0] == rules.show(rules.bot(_start(rules)))  # the opening move survived
    again = _replay(rules, final["moves"])
    assert again["status"] == final["status"] and again["winner"] == final["winner"]
    assert again["plies"] == final["plies"] and again["last"] == final["last"]
    assert again["moves"] == final["moves"]
