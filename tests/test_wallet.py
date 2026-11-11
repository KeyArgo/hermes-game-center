"""The Jackpot wallet: chips only. A spin costs the bet; nothing is banked or earned."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shelf.wallet import MIN_BET, START_CHIPS, Wallet, wallet_path  # noqa: E402


def fresh(tmp_path: Path) -> Wallet:
    return Wallet(wallet_path(tmp_path))


def test_a_new_wallet_holds_only_chips(tmp_path: Path) -> None:
    held = fresh(tmp_path).read()
    assert held["chips"] == START_CHIPS
    assert held["bet"] == MIN_BET
    assert held["visible"] is False and held["autoplay"] is False
    assert "pulls" not in held and "earned" not in held, held


def test_debit_refuses_more_than_it_holds(tmp_path: Path) -> None:
    wallet = fresh(tmp_path)
    assert wallet.debit(START_CHIPS + 1) is False
    assert wallet.read()["chips"] == START_CHIPS
    assert wallet.debit(25) is True
    assert wallet.read()["chips"] == START_CHIPS - 25


def test_a_bet_is_never_below_the_minimum(tmp_path: Path) -> None:
    wallet = fresh(tmp_path)
    assert wallet.set_bet(5).get("bet") == MIN_BET
    assert wallet.set_bet(200).get("bet") == 200


def test_visibility_is_remembered_and_round_trips(tmp_path: Path) -> None:
    wallet = fresh(tmp_path)
    assert wallet.set_visible(True)["visible"] is True
    assert Wallet(wallet_path(tmp_path)).read()["visible"] is True
    assert wallet.set_visible(False)["visible"] is False


def test_a_spin_is_credited_and_lands_on_the_feed(tmp_path: Path) -> None:
    wallet = fresh(tmp_path)
    held = wallet.record_spin({"at": 1.0, "payout": 40, "machine": "fruit9", "reels": ["🍒", "🍒", "🍒"]})
    assert held["chips"] == START_CHIPS + 40
    assert held["biggest"] == 40
    assert held["feed"][0]["payout"] == 40 and held["feed"][0]["chips"] == held["chips"]


def test_the_feed_stays_short(tmp_path: Path) -> None:
    wallet = fresh(tmp_path)
    for index in range(30):
        wallet.record_spin({"at": float(index), "payout": 0, "machine": "fruit9", "reels": ["🍒"] * 3})
    assert len(wallet.read()["feed"]) == 20


def test_a_broke_player_gets_the_stake_back_once(tmp_path: Path) -> None:
    wallet = fresh(tmp_path)
    assert wallet.debit(START_CHIPS) is True
    assert wallet.refill() is True
    assert wallet.read()["chips"] == START_CHIPS
    assert wallet.refill() is False, "refill must not top up a wallet that still has chips"


def test_settings_survive_a_spin(tmp_path: Path) -> None:
    wallet = fresh(tmp_path)
    wallet.set_autoplay(True)
    wallet.set_bet(75)
    wallet.record_spin({"at": 2.0, "payout": 0, "machine": "fruit9", "reels": ["🍋"] * 3})
    held = Wallet(wallet_path(tmp_path)).read()
    assert held["autoplay"] is True and held["bet"] == 75


def test_a_corrupt_file_falls_back_to_a_fresh_wallet(tmp_path: Path) -> None:
    path = wallet_path(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json", encoding="utf-8")
    assert Wallet(path).read()["chips"] == START_CHIPS


def test_unknown_keys_are_carried_so_a_downgrade_cannot_erase_them(tmp_path: Path) -> None:
    """The opposite of what this test used to assert, and on purpose.

    Unknown keys are kept. A wallet file is written by whichever build is installed, and a build that
    has never heard of a key would otherwise delete it on the next write — which is exactly how a
    person could roll back to an older commit and be paid a second time for an easter egg they had
    already found. Junk keys riding along is the cheap price of that guarantee.
    """
    path = wallet_path(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"chips": 500, "pulls": 9, "earned": 9}), encoding="utf-8")
    held = Wallet(path).read()
    assert held["chips"] == 500
    assert held["pulls"] == 9 and held["earned"] == 9, "an unknown key is carried, not silently dropped"
    # And a known key with a wrong type still falls back to its default rather than being carried.
    path.write_text(json.dumps({"chips": "lots", "autoplay": "yes"}), encoding="utf-8")
    fixed = Wallet(path).read()
    assert fixed["chips"] == START_CHIPS and fixed["autoplay"] is False, "a wrong type is repaired"
