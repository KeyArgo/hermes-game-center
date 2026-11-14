"""The backend under the conditions a person's machine actually produces.

Three properties, checked over every game rather than one worked example:

* random legal play always reaches an end, and a move taken from ``legal()`` is always accepted;
* hostile input — wrong types, huge strings, negative numbers, control bytes — comes back as a
  sentence, never a traceback;
* a state file is replaced whole, never written in place, so a crash mid-write cannot leave a table
  that half exists.

Concurrency is checked too: several threads on one table must not corrupt its state, which is what
the file lock is for.
"""

from __future__ import annotations

import importlib.util
import random
import re
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf.catalog import Catalog  # noqa: E402
from shelf.commands import run  # noqa: E402
from shelf.kitref import kit  # noqa: E402

# Games where the two seats take turns until one side wins or the board is full. Blackjack and the
# slots are round-based: each command settles one hand or spin and the table is ready for the next, so
# "it must end" does not describe them.
TURN_BASED = ["breakthrough", "checkers", "chessboard", "connect4", "go", "gomoku", "hex",
              "reversi", "seabattle"]

# Every game the shelf lists, for the hostile-input sweep.
ALL_GAMES = ["blackjack", "breakthrough", "checkers", "chessboard", "connect4", "doctrine", "go",
             "gomoku", "hex", "mafia", "reversi", "seabattle", "slots"]

HOSTILE = [
    "", "   ", "move", "move abc", "move 99999999999999999999", "move -1", "move 0",
    "move " + "9" * 4000, "move 1 2 3 4 5 6 7 8", "move ~~~", "move \u00ff\u00fe", "move NaN",
    "move inf", "sit", "sit white", "sit purple", "sit white=purple", "level 999",
    "level " + "x" * 2000, "draw accept", "resign", "rematch", "review", "join", "leave",
    "state", "board", "help", "hint", "step", "\x00\x01\x02", "new seed=abc", "new seed=-5",
]


def _load(game_id: str):
    spec = importlib.util.spec_from_file_location(f"resilience_{game_id}", ROOT / game_id / "game.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("game", TURN_BASED)
def test_random_legal_play_always_reaches_an_end(game: str, tmp_path: Path) -> None:
    """Six whole games of random legal moves: each one ends, and no move it offered is refused."""
    module = _load(game)
    table = module.create(tmp_path / "table")
    rules = table.rules
    rng = random.Random(f"resilience-{game}")
    for index in range(6):
        root = tmp_path / f"game-{index}"
        table = module.create(root)
        assert isinstance(table.command("new"), str)
        plies = 0
        while True:
            state = kit.load(table.root)
            assert state is not None, f"{game} wrote no readable state"
            if state.get("status") != "active":
                assert state.get("status") in {"win", "draw"}, state.get("status")
                break
            legal = list(rules.legal(state))
            assert legal, f"{game} is active with no legal move for {state.get('turn')}"
            move = rng.choice(legal)
            said = table.command(f"move {rules.show(move)}")
            assert isinstance(said, str) and said.strip(), said
            assert not said.startswith("Refused"), f"{game} refused its own legal move: {said}"
            plies += 1
            assert plies <= int(getattr(rules, "MAX_PLIES", 2000)) + 50, f"{game} ran past its limit"
        # The end is a fact in the state, not just a sentence.
        final = kit.load(table.root)
        assert final is not None and final.get("status") in {"win", "draw"}


@pytest.mark.parametrize("game", ALL_GAMES)
def test_hostile_input_is_always_a_sentence(game: str, tmp_path: Path) -> None:
    """Wrong types, huge strings, control bytes and impossible numbers all come back as words."""
    catalog = Catalog([ROOT], tmp_path / game, {"allow_ai": True})
    assert isinstance(run(catalog, f"{game} new", source="command"), str)
    for command in HOSTILE:
        for source in ("command", "tool"):
            said = run(catalog, f"{game} {command}".strip(), source=source)
            assert isinstance(said, str) and said.strip(), (game, command, said)


def test_several_threads_on_one_table_keep_one_whole_state(tmp_path: Path) -> None:
    """Four threads moving on the same table: every answer is words and the file still parses."""
    catalog = Catalog([ROOT], tmp_path / "race", {"allow_ai": True})
    run(catalog, "connect4 new", source="command")
    errors: list[str] = []
    answers: list[str] = []

    def worker(index: int) -> None:
        try:
            for step in range(10):
                answers.append(run(catalog, f"connect4 move {1 + (index + step) % 7}", source="command"))
                run(catalog, "connect4 state", source="command")
                catalog.picture("connect4")
        except Exception as error:  # noqa: BLE001 - the thread reports, the test asserts
            errors.append(f"{type(error).__name__}: {error}")

    threads = [threading.Thread(target=worker, args=(index,)) for index in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)

    assert not errors, errors
    assert len(answers) == 40, len(answers)
    state = kit.load(tmp_path / "race" / "connect4")
    assert state is not None and isinstance(state.get("moves"), list)
    # Replaying the moves on an empty board must reproduce the board that is on screen: a lost
    # update shows up as a board that does not match its own move list. The table always opens with
    # white to move, so the replay starts there rather than from the turn it ended on.
    module = _load("connect4")
    replayed = module.fresh()
    replayed.update({"turn": "white", "status": "active", "winner": "", "game": "connect4"})
    for move in state["moves"]:
        module.play(replayed, move if isinstance(move, int) else module.parse([str(move)]))
    assert sum(1 for row in state["board"] for cell in row if cell != ".") == len(state["moves"])
    assert replayed["board"] == state["board"], "the board and its move list disagree"


def test_every_state_file_is_written_through_a_temp_file() -> None:
    """A write that lands in place leaves half a table behind when the process dies mid-write."""
    direct = []
    for path in sorted(ROOT.rglob("*.py")):
        parts = path.relative_to(ROOT).parts
        if {"tests", "tools", "examples", "third_party", "vendor", "node_modules", "docs"} & set(parts):
            continue
        text = path.read_text(encoding="utf-8")
        for match in re.finditer(r"(\w+(?:\.\w+)*)\.write_(?:text|bytes)\(", text):
            receiver = match.group(1)
            if not re.search(r"(tmp|temporary|temp)", receiver, re.IGNORECASE):
                line = text[:match.start()].count("\n") + 1
                direct.append(f"{path.relative_to(ROOT)}:{line}: {receiver}.write...")
        if "write_text(" in text or "write_bytes(" in text:
            assert "os.replace(" in text or "os.rename(" in text, (
                f"{path.relative_to(ROOT)} writes a file but never swaps one into place"
            )
    assert not direct, "these write a state file in place instead of a temp file:\n" + "\n".join(direct)


def test_the_pet_gallery_fails_soft_when_the_network_is_down(monkeypatch) -> None:
    """The Petdex manifest is the one request the shelf makes on its own; offline is not an error."""
    from shelf import pet

    def offline(*_args, **_kwargs):
        raise OSError("network is unreachable")

    monkeypatch.setattr(pet, "_fallback_manifest", offline)
    monkeypatch.setattr(pet, "_manifest_cache", None, raising=False)
    answer = pet.gallery({})
    assert isinstance(answer, dict)
    assert answer.get("enabled") is False, answer
    # And a pet the host cannot render is a missing toy, not a broken page.
    assert pet.thumb("nonesuch", "")["ok"] is False
    assert pet.active({}) in ({}, None) or isinstance(pet.active({}), dict)
