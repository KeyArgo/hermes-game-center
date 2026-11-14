"""The automatic bet sizes itself by what the hook cost."""

from __future__ import annotations

from pathlib import Path

from shelf import autobet
from shelf.slotplay import MIN_BET, autospin
from shelf.wallet import Wallet, wallet_path


def test_a_cheap_frequent_hook_pays_the_smallest_bet() -> None:
    for kind in ("turn", "tool", "hook", "start"):
        assert autobet.multiple_for(kind, 0) == 1
        assert autobet.stake_for(kind, 0, MIN_BET) == MIN_BET


def test_a_longer_reply_pays_more() -> None:
    small = autobet.stake_for("reply", 10_000, MIN_BET)
    medium = autobet.stake_for("reply", 120_000, MIN_BET)
    big = autobet.stake_for("reply", 2_000_000, MIN_BET)
    assert small < medium < big, (small, medium, big)


def test_the_bet_never_exceeds_the_cap_the_person_set() -> None:
    assert autobet.stake_for("reply", 5_000_000, MIN_BET, cap=2) == MIN_BET * 2
    assert autobet.stake_for("reply", 5_000_000, MIN_BET, cap=8) == MIN_BET * 8
    # A nonsense cap cannot make the bet enormous.
    assert autobet.stake_for("reply", 5_000_000, MIN_BET, cap=99) == MIN_BET * 8


def test_auto_bet_is_on_by_default_and_the_spin_uses_it(tmp_path: Path) -> None:
    wallet = Wallet(wallet_path(tmp_path))
    wallet.set_visible(True)
    wallet.set_autoplay(True)
    held = wallet.read()
    assert held["autobet"] is True, "auto-bet ships on"
    assert held["autobet_max"] == 8

    row = autospin(wallet, kind="turn")
    assert row and row["bet"] == MIN_BET, "a turn starting is the cheapest bet"

    before = wallet.read()["chips"]
    row = autospin(wallet, kind="reply", tokens=400_000)
    assert row and row["bet"] > MIN_BET, "a big reply bets more"
    # A spin that pays back exactly its bet leaves the balance unchanged, so check the arithmetic.
    assert wallet.read()["chips"] == before - row["bet"] + row["payout"]


def test_auto_bet_off_uses_the_bet_on_the_table(tmp_path: Path) -> None:
    wallet = Wallet(wallet_path(tmp_path))
    wallet.set_visible(True)
    wallet.set_autoplay(True)
    wallet.set_autobet(on=False)
    wallet.set_bet(MIN_BET * 2)
    row = autospin(wallet, kind="turn")
    assert row and row["bet"] == MIN_BET * 2


def test_a_bet_the_wallet_cannot_cover_falls_back_to_the_smallest(tmp_path: Path) -> None:
    wallet = Wallet(wallet_path(tmp_path))
    wallet.set_visible(True)
    wallet.set_autoplay(True)
    with wallet._held() as data:  # noqa: SLF001 - the test is about the wallet's own floor
        data["chips"] = MIN_BET + 1
    row = autospin(wallet, kind="reply", tokens=2_000_000)
    assert row and row["bet"] == MIN_BET, "the machine keeps turning, at the smallest bet"


def test_the_setting_is_reported_by_the_jackpot_route(tmp_path: Path, monkeypatch) -> None:
    """The pane and the settings card read the setting from the shelf, not from a constant."""
    from dashboard import plugin_api

    monkeypatch.setattr(plugin_api, "_jackpot_wallet", lambda: Wallet(wallet_path(tmp_path)))
    payload = plugin_api._jackpot_payload(plugin_api._jackpot_wallet())
    assert payload["autobet"] is True and payload["autobet_max"] == 8
    answer = plugin_api.jackpot_autobet({"on": False, "cap": 3})
    assert answer["autobet"] is False and answer["autobet_max"] == 3
    assert plugin_api.jackpot_autobet({"cap": 99})["autobet_max"] == 8, "a nonsense cap is clamped"
