"""Regression locks for the slot economy and the blackjack payout formula (A51 bug hunt).

Two of these numbers are the house's published promise, and both were under-pinned:

* ``online/slots.py`` ships an expected return per pull. The only test of it,
  ``test_jackpot_odds.test_ev_200k_spins``, estimates that return from 200,000
  random pulls. The 3,123-chip NOUS jackpot lands about once in 57,000 pulls, so
  that estimate has a standard error near 0.03 and drifts above its own 1.00
  ceiling on an unlucky run (seen in the A51 baseline: 1.00091). These tests
  derive the return **exactly**, by walking every one of the 77x77x77 weighted
  reel combinations once, so a payout-table change is caught deterministically
  rather than one run in five.

* Blackjack pays a natural 3:2, rounded up because chips are whole. The rounding
  is easy to get wrong for a stake that is not a multiple of two, so the exact
  table is pinned here for every bet the table offers.

Nothing here found a defect: the slot return is the designed 0.975 and the
blackjack formula is correct. They lock those facts so a later edit cannot move
them unseen.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


# --------------------------------------------------------------------------- #
# online/slots.py: the published return, derived exactly                      #
# --------------------------------------------------------------------------- #

def _load_online_slots():
    import sys
    if str(REPO) not in sys.path:
        sys.path.insert(0, str(REPO))
    from online import slots
    return slots


def _payout_for(slots, reels: tuple[str, str, str]) -> int:
    """The payout rule the engine applies, stated once for the whole-table walk.

    Three of a kind pays its row; otherwise two NOUS stamps *from the left*
    (reels one and two) pay the pair prize; otherwise nothing. This mirrors
    ``online.slots.spin`` exactly, so the walk below is the engine's own math.
    """
    r1, r2, r3 = reels
    if r1 == r2 == r3:
        return slots.PAYOUTS_3OAK.get(r1, 0)
    if r1 == "NOUS" and r2 == "NOUS":
        return 10
    return 0


def _exact_return(slots) -> float:
    """Chips paid per chip staked, over every weighted reel combination."""
    weights = slots.WEIGHTS
    symbols = slots.SYMBOLS
    total_weight = sum(weights)
    paid = 0
    combos = 0
    for i, s1 in enumerate(symbols):
        for j, s2 in enumerate(symbols):
            for k, s3 in enumerate(symbols):
                w = weights[i] * weights[j] * weights[k]
                paid += w * _payout_for(slots, (s1, s2, s3))
                combos += w
    assert combos == total_weight ** 3
    return paid / combos


def test_the_published_slot_return_is_exactly_0_975():
    """The one number the house promises, derived without a single random pull."""
    slots = _load_online_slots()
    exact = _exact_return(slots)
    # 445098 / 456533 == 0.9749525..., the designed 97.5% return.
    assert abs(exact - (445098 / 456533)) < 1e-12
    assert round(exact, 4) == 0.9750
    # The ceiling the Monte-Carlo test asserts: the exact value is safely under it,
    # so any regression that pushes the true return past 1.00 is a code change, not
    # a run of luck.
    assert 0.90 <= exact <= 1.00


def test_every_published_slot_payout_is_reachable_and_nothing_else_pays():
    """The payout column, pinned: exactly these values can come off the machine."""
    slots = _load_online_slots()
    reachable = set()
    for s1 in slots.SYMBOLS:
        for s2 in slots.SYMBOLS:
            for s3 in slots.SYMBOLS:
                reachable.add(_payout_for(slots, (s1, s2, s3)))
    assert reachable == {0, 5, 8, 10, 12, 45, 130, 3123}


def test_the_live_spin_pays_what_the_rule_says_for_its_reels():
    """Every spin's own payout matches the walk's rule for the reels it drew.

    Guards against the engine and its published rule drifting apart: the spin is
    the source of truth for a player, and it must pay what the odds table says.
    """
    slots = _load_online_slots()
    for n in range(3000):
        seed = n.to_bytes(32, byteorder="big")
        row = slots.spin(seed)
        expected = _payout_for(slots, (row["reel1"], row["reel2"], row["reel3"]))
        assert row["payout"] == expected, (n, row)


def test_a_slot_seed_replays_to_the_same_pull():
    slots = _load_online_slots()
    seed = b"A51-regression-seed-0123456789ab"
    first = slots.spin(seed)
    again = slots.spin(seed)
    assert (first["reel1"], first["reel2"], first["reel3"], first["payout"]) == \
           (again["reel1"], again["reel2"], again["reel3"], again["payout"])


# --------------------------------------------------------------------------- #
# blackjack: a natural pays 3:2, rounded up, for every bet on offer           #
# --------------------------------------------------------------------------- #

def _load_blackjack():
    spec = importlib.util.spec_from_file_location("blackjack_a51", REPO / "blackjack" / "game.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_a_natural_pays_three_to_two_rounded_up_for_every_bet():
    """The exact chips a blackjack returns, bet by bet.

    3:2 on the stake, rounded up because a chip cannot be halved, plus the stake
    itself back. A 25 stake is the awkward one: 1.5 x 25 = 37.5 rounds up to 38,
    so the hand returns 63.
    """
    bj = _load_blackjack()
    expected = {
        10: 25,     # 10 + ceil(15) = 25
        25: 63,     # 25 + ceil(37.5 -> 38) = 63
        50: 125,    # 50 + ceil(75) = 125
        100: 250,   # 100 + ceil(150) = 250
        500: 1250,  # 500 + ceil(750) = 1250
        1000: 2500, # 1000 + ceil(1500) = 2500
    }
    for stake, total in expected.items():
        assert bj._blackjack_win(stake) == total, stake
        # The profit is the win shown to the player: total back minus the stake staked.
        assert bj._blackjack_win(stake) - stake == -(-3 * stake // 2), stake
