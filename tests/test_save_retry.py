"""A save that lands on a file Windows has open, and a bet that never leaves the wallet.

Windows refuses to swap a file in while another process has it open for reading ("Access is
denied", ``PermissionError``), and every surface here reads a table's state without taking the
write lock: a poll, an antivirus scan or a network folder can hold ``state.json`` at the moment a
move is written. Three things are pinned here, each of which failed before:

* every save in ``shelf/`` and ``kit.py`` retries the swap for about two seconds instead of losing
  the write (``shelf/filelock.replace``);
* a table state that really cannot be written puts back the chips the bet took, and leaves no
  ``.tmp`` file for the next write to trip on - a lost save must not cost a person chips;
* the dashboard's command route answers a sentence instead of a 500.

``tests/test_resilience.py`` keeps the other half: no state file is ever written in place.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class HeldOpen:
    """``os.replace`` with the first ``denials`` swaps refused the way Windows refuses them."""

    def __init__(self, denials: int, only: str = "") -> None:
        self.denials = denials
        # Only deny swaps onto this file name: the wallet and the lock files still move.
        self.only = only
        self.calls = 0
        self.real = os.replace

    def __call__(self, source, target):
        held = not self.only or Path(target).name == self.only
        if held and self.calls < self.denials:
            self.calls += 1
            raise PermissionError(13, "Access is denied")
        return self.real(source, target)


def _load(game: str):
    spec = importlib.util.spec_from_file_location(f"save_retry_{game}", ROOT / game / "game.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_table_state_survives_a_file_windows_holds_open(monkeypatch, tmp_path):
    """Three refused swaps, then the save lands: a move is not lost to a reader."""
    from shelf.kitref import kit

    held = HeldOpen(3, only="state.json")
    monkeypatch.setattr(os, "replace", held)

    kit.write(tmp_path / "blackjack", {"phase": "bet", "note": "saved after three denials"})

    assert held.calls == 3, f"the swap was retried {held.calls} times, not three"
    saved = json.loads((tmp_path / "blackjack" / "state.json").read_text(encoding="utf-8"))
    assert saved["note"] == "saved after three denials"
    assert not list((tmp_path / "blackjack").glob("*.tmp")), "the temp file was swapped in"


def test_a_bet_is_refunded_when_the_state_cannot_be_saved(monkeypatch, tmp_path):
    """A save that never lands costs nothing: the chips come back and no temp file is left."""
    bj = _load("blackjack")
    bj.use_wallet(tmp_path / "wallet.json")
    table = bj.create(tmp_path / "blackjack")
    me = SimpleNamespace(id="u1", name="Ada", platform="desktop", bot=False)
    table.command("new", player=me)
    state_path = tmp_path / "blackjack" / "state.json"
    # A fixed shoe: 19 against 17, so no natural pays out inside the same request and the only
    # chips that move are the bet.
    state = json.loads(state_path.read_text(encoding="utf-8"))
    state["deck"] = list(reversed(["10S", "10H", "9S", "7H"]))
    state_path.write_text(json.dumps(state), encoding="utf-8")
    before = bj._wallet().read()["chips"]

    # The whole retry budget is spent: this is a reader that never lets go.
    with monkeypatch.context() as patched:
        patched.setattr(os, "replace", HeldOpen(10_000, only="state.json"))
        with pytest.raises(OSError):
            table.command("move bet100", player=me)

    assert bj._wallet().read()["chips"] == before, "the bet left the wallet for a move never saved"
    folder = tmp_path / "blackjack"
    assert not [path.name for path in folder.iterdir() if path.name.endswith(".tmp")], \
        "a failed swap must not leave state.json.tmp behind"
    state = json.loads((folder / "state.json").read_text(encoding="utf-8"))
    assert state["phase"] == "bet" and not state.get("player_hands"), state


def test_a_spin_is_refunded_when_the_state_cannot_be_saved(monkeypatch, tmp_path):
    """The slots bet from the same wallet, so the same rule: a lost save costs no chips."""
    slots = _load("slots")
    slots.use_wallet(tmp_path / "wallet.json")

    def losing_spin(wallet, bet=0, **_kwargs):
        """One spin that pays nothing: the only chips that move are the stake."""
        if not wallet.debit(int(bet)):
            return None
        return {"reels": ["A", "B", "C"], "grid": [["A"], ["B"], ["C"]], "wins": [], "payout": 0,
                "machine": "fruit9", "at": 1.0, "jackpot": False, "paid_with": int(bet)}

    monkeypatch.setattr(slots.slotplay, "spin", losing_spin)
    table = slots.create(tmp_path / "slots")
    before = slots._wallet.read()["chips"]

    with monkeypatch.context() as patched:
        patched.setattr(os, "replace", HeldOpen(10_000, only="state.json"))
        with pytest.raises(OSError):
            table.command("move bet25")

    assert slots._wallet.read()["chips"] == before, "the spin was paid for and never saved"
    folder = tmp_path / "slots"
    assert not [path.name for path in folder.iterdir() if path.name.endswith(".tmp")]


def test_the_dashboard_answers_words_when_a_table_cannot_be_saved(monkeypatch):
    """The command route catches the failed save: a sentence and ok:false, never a 500."""
    from dashboard import plugin_api

    def denied(line: str) -> str:
        raise PermissionError(13, "Access is denied")

    monkeypatch.setattr(plugin_api, "_say", denied)
    answer = plugin_api.command({"line": "/games blackjack move bet100"})

    assert answer["ok"] is False, answer
    assert "could not be saved" in answer["text"], answer
    assert "Nothing was staked" in answer["text"], answer


def _save_once(name: str, folder: Path) -> None:
    """One real save through the named module's own writer, with no test-only shortcut."""
    if name == "champions":
        from shelf.champions import ChampionStore

        saved, error = ChampionStore(folder / name).save({"name": "Ada", "brief": "A short brief."})
        assert saved and not error, error
    elif name == "directory":
        from shelf.directory import Directory

        Directory(folder / name).save({"playit_host": "", "units": {}})
    elif name == "library":
        from shelf.library import Library

        Library(folder / name).add("connect4")
    elif name == "lobby":
        from shelf import lobby

        lobby._save(folder / name, {"lines": [], "looking": {}})
    elif name == "online_source":
        from shelf.online_source import Online

        Online(folder / name)._save()
    elif name == "playbook":
        from shelf import playbook

        playbook._write(folder / name / "pb-00000001.json", {"read": [], "tactics": []})
    elif name == "tournament":
        from shelf import tournament

        tournament._write(folder / name / "ratings.json", {"ratings": {}})
    elif name == "who":
        from shelf.who import NameBook

        NameBook(folder / name / "names.json")._write({"someone": "Ada"})
    else:  # pragma: no cover - the parametrisation below is the whole list
        raise AssertionError(name)


SHELF_SAVES = ["champions", "directory", "library", "lobby", "online_source", "playbook",
               "tournament", "who"]


@pytest.mark.parametrize("name", SHELF_SAVES)
def test_every_shelf_save_survives_a_file_windows_holds_open(name, monkeypatch, tmp_path):
    """Each shelf save retries three refused swaps and still writes one whole file."""
    held = HeldOpen(3)
    monkeypatch.setattr(os, "replace", held)

    _save_once(name, tmp_path)

    assert held.calls >= 3, f"{name} gave up on the first refusal: {held.calls} attempts"
    written = [path for path in (tmp_path / name).rglob("*") if path.is_file()]
    assert written, f"{name} saved nothing"
    assert not [path for path in (tmp_path / name).rglob("*.tmp")], \
        f"{name} left a temp file behind: {[str(path) for path in (tmp_path / name).rglob('*.tmp')]}"
    for path in written:
        if path.suffix == ".lock":  # the lock file is empty on purpose
            continue
        json.loads(path.read_text(encoding="utf-8"))


def test_the_replace_budget_is_about_two_seconds():
    """The Unconfirmed finding: 20 x 25 ms was too short for a poll or a scanner to let go."""
    import shelf.filelock as filelock

    assert filelock.REPLACE_TRIES * filelock.REPLACE_WAIT >= 2.0, (
        filelock.REPLACE_TRIES, filelock.REPLACE_WAIT)


def test_a_win_is_taken_back_when_the_state_cannot_be_saved(monkeypatch, tmp_path):
    """A stand that wins pays before the table is written; if that write never lands the table still
    holds the unplayed hand, so the payout must come back off the wallet - or a retry pays it twice
    (review, 2026-11-17)."""
    bj = _load("blackjack")
    bj.use_wallet(tmp_path / "wallet.json")
    table = bj.create(tmp_path / "blackjack")
    me = SimpleNamespace(id="u1", name="Ada", platform="desktop", bot=False)
    table.command("new", player=me)
    state_path = tmp_path / "blackjack" / "state.json"
    # 19 against 17: standing wins 1:1.
    state = json.loads(state_path.read_text(encoding="utf-8"))
    state["deck"] = list(reversed(["10S", "10H", "9S", "7H"]))
    state_path.write_text(json.dumps(state), encoding="utf-8")
    start = bj._wallet().read()["chips"]
    table.command("move bet100", player=me)
    staked = bj._wallet().read()["chips"]
    assert staked == start - 100

    with monkeypatch.context() as patched:
        patched.setattr(os, "replace", HeldOpen(10_000, only="state.json"))
        with pytest.raises(OSError):
            table.command("move stand", player=me)
    assert bj._wallet().read()["chips"] == staked, "a win paid for a stand that was never saved"

    table.command("move stand", player=me)
    assert bj._wallet().read()["chips"] == start + 100, "the saved stand pays exactly once"


@pytest.mark.parametrize("game", ["blackjack", "slots"])
def test_every_chip_game_can_take_back_a_payout_for_a_lost_save(game, tmp_path):
    """kit._refund undoes the wallet both ways; a chip game without chips_reclaim would keep a win
    paid for a move that never happened."""
    rules = _load(game)
    assert callable(getattr(rules, "chips_reclaim", None)), f"{game} has no chips_reclaim"
    sys.path.insert(0, str(ROOT))
    import kit
    rules.use_wallet(tmp_path / "wallet.json") if hasattr(rules, "use_wallet") else None
    wallet = rules._wallet() if callable(getattr(rules, "_wallet", None)) else rules._wallet
    held = int(wallet.read()["chips"])
    wallet.credit(250)
    kit._refund(rules, held)
    assert int(wallet.read()["chips"]) == held, "the payout for an unsaved move came back off the wallet"
