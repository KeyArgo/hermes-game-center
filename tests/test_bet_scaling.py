"""The bet ladder must pay in proportion: a x4 bet wins four times a x1 bet, and the
numbers the machine publishes must move with it (owner's rule, 2026-11-09).

"however they do it in real life" = a slot pays per coin per line, so the same physical
result on a 4-coin bet is worth four times the 1-coin result. These tests pin that, on
the same stops, so a future change to the pays or the per-line split cannot quietly make
a bigger bet pay the same as a small one.
"""

from __future__ import annotations


import pytest

from shelf import slotplay

MIN = slotplay.MIN_BET
LADDER = list(slotplay.BETS)


def per_line(machine: str, bet: int) -> int:
    return max(1, bet // max(1, slotplay.bet_lines(machine)))


def reels():
    """The reels module the running host uses: slotplay loads it by path, so importing
    `shelf.reels` here would be a second copy with its own session draw."""
    return slotplay.reels


@pytest.mark.parametrize("machine", sorted(slotplay.MACHINES))
def test_the_bet_ladder_is_a_clean_multiple_of_the_minimum(machine):
    assert LADDER[0] == MIN, f"{machine}: the first rung is the minimum bet"
    assert LADDER == [MIN * step for step in range(1, len(LADDER) + 1)], (
        f"{machine}: the ladder must be x1..xN of {MIN}, got {LADDER}")


@pytest.mark.parametrize("machine", sorted(slotplay.MACHINES))
def test_the_published_paytable_scales_with_the_bet(machine):
    small = slotplay.paytable(machine, per_line(machine, MIN))
    big = slotplay.paytable(machine, per_line(machine, MIN * 4))
    assert len(small) == len(big)
    for a, b in zip(small, big):
        assert a["symbol"] == b["symbol"]
        assert b["payout"] == a["payout"] * 4, (
            f"{machine}: {a['symbol']} pays {b['payout']} at x4 but {a['payout']} at x1")


@pytest.mark.parametrize("machine", sorted(slotplay.MACHINES))
def test_the_jackpot_paid_scales_with_the_bet(machine):
    one = reels().jackpot_chips(machine, per_line(machine, MIN))
    four = reels().jackpot_chips(machine, per_line(machine, MIN * 4))
    assert four == one * 4, f"{machine}: jackpot pays {four} at x4 but {one} at x1"


@pytest.mark.parametrize("machine", sorted(slotplay.MACHINES))
def test_the_same_stops_pay_exactly_the_bet_multiple(machine):
    """The real test of the owner's rule: identical reels, four times the bet."""
    found = reels().variant(machine)
    spec = reels().SPECS[machine]
    one, four = per_line(machine, MIN), per_line(machine, MIN * 4)
    for stops in [(0,) * len(spec["strips"]), (1, 2, 3), (4, 4, 4), (7, 11, 5)]:
        small = reels().result(spec, stops, one, found["blanks"], found["pays"])
        big = reels().result(spec, stops, four, found["blanks"], found["pays"])
        if not small["payout"]:
            continue  # a losing spin proves nothing about scaling
        assert big["payout"] == small["payout"] * 4, (
            f"{machine}: stops {stops} paid {big['payout']} at x4 and {small['payout']} at x1")


def test_the_table_requotes_its_paytable_when_the_bet_changes(tmp_path):
    """Through the game's own picture, not the module: the pays on the table must move the
    moment the player picks a bigger rung, or the machine is advertising the wrong money."""
    import importlib.util
    from pathlib import Path

    repo = Path(__file__).resolve().parent.parent
    spec = importlib.util.spec_from_file_location("slots_game_betscaling", repo / "slots" / "game.py")
    game = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(game)
    game.use_wallet(tmp_path / "wallet.json")

    state = {"turn": "white", "status": "active", "winner": "", "moves": [], "plies": 0, **game.fresh()}
    small = {row["symbol"]: row["payout"] for row in game.picture(state)["paytable"]}

    bigger = f"bet{MIN * 4}"
    assert bigger in game.legal(state), (bigger, game.legal(state))
    game.play(state, bigger)
    big = {row["symbol"]: row["payout"] for row in game.picture(state)["paytable"]}

    assert small != big, "the paytable did not move when the bet went from x1 to x4"
    for symbol, payout in small.items():
        if payout:
            assert big[symbol] == payout * 4, (
                f"{symbol}: table shows {big[symbol]} at x4 and {payout} at x1")
