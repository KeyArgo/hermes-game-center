"""Cashing points in: the person picks the slice, the shelf pays it, the server hears about it.

The owner's ask (2026-11-11): *"a control where the person chooses HOW MANY points to turn into chips
(slider/number + Max), at the existing rate in shelf/wallet.py (4 points -> 3 chips, cash_points
(points))"*, and the copy that says what that decision costs: *"Points are your ranking. Cash some in
for chips when you run low - it lowers your ranking."*

What is pinned here:

* the route takes the slice the person chose and pays the wallet's own rate - the number is read off
  ``wallet.cash_points``, not re-derived in the route or in the cabinet;
* the payload carries that rate (``points_rate``), so the cabinet's slider works out how many chips a
  slice buys from the shelf's own arithmetic instead of a second copy of 4 and 3;
* the ranking really does go down, and only by the blocks that were spent;
* the balance the server keeps is told the NEW pair after a conversion - chips up and points down in
  the same change (``/api/balance``).
"""

from __future__ import annotations

import json
from pathlib import Path
from urllib import error as urlerror
from urllib.parse import urlsplit

import pytest

from dashboard import plugin_api
from shelf import online_source
from shelf.wallet import CHIPS_PER_BLOCK, POINTS_PER_CHIP_BLOCK, Wallet, wallet_path


@pytest.fixture()
def shelf(tmp_path, monkeypatch):
    """A shelf whose wallet is this test's, with a recorder standing in for the lobby."""
    path = wallet_path(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    Writer(path)
    monkeypatch.setattr(plugin_api, "_jackpot_wallet", lambda: Wallet(path))
    monkeypatch.setattr(plugin_api, "_data_root", lambda: tmp_path)
    monkeypatch.setattr(plugin_api, "_ONLINE", {})
    return path


class Writer:
    """A wallet file the tests can rewrite between calls."""

    def __init__(self, path: Path):
        self.path = path

    def __call__(self, chips: int = 0, points: int = 0, **extra) -> Path:
        self.path.write_text(json.dumps({"chips": chips, "bonus": points, **extra}), encoding="utf-8")
        return self.path


def put(path: Path, chips: int = 0, points: int = 0, **extra) -> None:
    path.write_text(json.dumps({"chips": chips, "bonus": points, **extra}), encoding="utf-8")


def test_the_cabinet_payload_carries_the_wallets_own_rate(tmp_path, shelf) -> None:
    put(shelf, chips=100, points=400)
    payload = plugin_api._jackpot_payload(plugin_api._jackpot_wallet())
    assert payload["points_rate"]["points"] == POINTS_PER_CHIP_BLOCK
    assert payload["points_rate"]["chips"] == CHIPS_PER_BLOCK
    assert payload["points_rate"]["tokens_per_point"] == 100_000, "the points per token are the shelf's too"


def test_the_route_spends_the_slice_the_person_chose(tmp_path, shelf) -> None:
    put(shelf, chips=10, points=2_000)
    answer = plugin_api.jackpot_points_cash({"points": 500})
    assert answer["points_cashed"] == (500 // POINTS_PER_CHIP_BLOCK) * CHIPS_PER_BLOCK
    assert answer["chips"] == 10 + answer["points_cashed"], "the chips on the cabinet follow the shelf"
    assert answer["bonus"] == 1_500, "the rest of the ranking is kept"
    assert answer["points_left"] == 1_500


def test_max_spends_every_whole_block(tmp_path, shelf) -> None:
    put(shelf, chips=0, points=6_002)
    answer = plugin_api.jackpot_points_cash({"points": 6_002})
    assert answer["points_cashed"] == (6_002 // POINTS_PER_CHIP_BLOCK) * CHIPS_PER_BLOCK
    assert answer["bonus"] == 6_002 % POINTS_PER_CHIP_BLOCK, "the points under one block wait"


def test_a_slice_under_one_block_changes_nothing(tmp_path, shelf) -> None:
    put(shelf, chips=40, points=1_000)
    answer = plugin_api.jackpot_points_cash({"points": 3})
    assert answer["points_cashed"] == 0
    assert answer["chips"] == 40 and answer["bonus"] == 1_000


def test_no_slice_means_everything_an_older_desktop(tmp_path, shelf) -> None:
    """The route still answers a caller that sends nothing: the older desktop's all-in press."""
    put(shelf, chips=0, points=808)
    answer = plugin_api.jackpot_points_cash({})
    assert answer["points_cashed"] == (808 // POINTS_PER_CHIP_BLOCK) * CHIPS_PER_BLOCK
    assert answer["bonus"] == 808 % POINTS_PER_CHIP_BLOCK


def test_cashing_in_writes_both_numbers_the_balance_note_carries(tmp_path, shelf) -> None:
    """The server's copy is told the new pair: chips up, points down, in one change."""
    put(shelf, chips=25, points=1_200)
    before = online_source.wallet_totals(tmp_path)
    plugin_api.jackpot_points_cash({"points": 200})
    after = online_source.wallet_totals(tmp_path)
    assert before == (25, 1_200)
    assert after == (25 + (200 // POINTS_PER_CHIP_BLOCK) * CHIPS_PER_BLOCK, 1_000)
    assert after[0] > before[0] and after[1] < before[1]


class Recorder:
    """The lobby, stood in for: it records every address opened and answers 200."""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.status = 200
        self.answer: dict = {}

    def __call__(self, request, timeout=None):
        raw = getattr(request, "data", None)
        self.calls.append({
            "path": urlsplit(request.full_url).path,
            "body": json.loads(raw.decode("utf-8")) if raw else None,
            "auth": request.get_header("Authorization") or "",
        })
        if self.status == 0:
            raise urlerror.URLError("down")
        payload = json.dumps(self.answer).encode()

        class Answer:
            status = 200

            def read(self, limit=0):
                return payload

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        return Answer()

    @property
    def notes(self) -> list[dict]:
        return [call for call in self.calls if call["path"] == "/api/balance"]


def test_a_conversion_is_reported_to_the_lobby_with_the_new_totals(tmp_path, shelf) -> None:
    """Cash in, and the lobby is told the new pair in the same breath (owner's ask, 2026-11-11).

    The note goes up from the route itself - not from the next lobby poll half a minute later - so a
    person who converts points and closes Hermes still has the right chips and points on the server.
    """
    opener = Recorder()
    source = online_source.Online(tmp_path, opener=opener, secret=lambda name: "key-1",
                                  clock=lambda: 1000.0)
    source.turn_on()
    plugin_api._ONLINE[str(tmp_path)] = source
    put(shelf, chips=25, points=1_200)
    answer = plugin_api.jackpot_points_cash({"points": 200})
    assert answer["points_cashed"] == 150
    assert opener.notes, "the conversion was not reported"
    assert opener.notes[-1]["body"] == {"chips": 175, "points": 1_000}
    assert opener.notes[-1]["auth"] == "Bearer key-1", "the note carries the account's own key"


def test_the_same_conversion_twice_is_not_reported_twice(tmp_path, shelf) -> None:
    """Nothing was sent, so nothing is sent again: the source's own rules still govern the note."""
    opener = Recorder()
    source = online_source.Online(tmp_path, opener=opener, secret=lambda name: "key-1",
                                  clock=lambda: 1000.0)
    source.turn_on()
    plugin_api._ONLINE[str(tmp_path)] = source
    put(shelf, chips=25, points=1_200)
    plugin_api.jackpot_points_cash({"points": 200})
    plugin_api.jackpot_points_cash({"points": 0})
    assert len(opener.notes) == 1, "an unchanged pair is not a note" 


def test_the_nudge_is_silent_when_no_source_is_running(tmp_path, shelf) -> None:
    """Cashing in on a machine that never went online opens nothing and raises nothing."""
    put(shelf, chips=0, points=400)
    plugin_api._report_balance_now()
    answer = plugin_api.jackpot_points_cash({"points": 400})
    assert answer["points_cashed"] > 0


def test_the_cabinet_says_what_cashing_in_costs_the_ranking() -> None:
    """The copy, in the cabinet's own source, word for word as the owner asked for it."""
    source = (Path(plugin_api.__file__).resolve().parents[1] / "desktop" / "src"
              / "18-jackpot2-machine.js").read_text(encoding="utf-8")
    assert "Points are your ranking. Cash some in for chips when you run low - it lowers " in source
    assert "your ranking." in source
    assert "data-jp2-points-range" in source and "data-jp2-points-number" in source
    assert "data-jp2-points-max" in source, "the control offers Max, as asked"
