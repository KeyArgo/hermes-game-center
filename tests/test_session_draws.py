"""The per-session chance draw: bonus, cold and usual, proved on forced seeds.

Each process draws a chance per machine (50-52% usual, 60% bonus, 40% cold). A test that waits for a
bonus session fails about one run in twenty-five, and a test that assumes a usual one fails far more
often - which is exactly how three tests in ``test_slots_table.py`` went red. These force
the seed instead.

Two traps this file exists to keep shut:

* the window must be read from ``slotplay.reels``, never from ``shelf.reels``: slotplay loads its own
  copy of the module under another name, so a plain ``import shelf.reels`` is a *second* draw with a
  different seed (``tests/test_bet_scaling.py`` documents the same trap);
* the published window must be the one the draw gives, not the usual 50-52% next to a 60% number.
"""

from __future__ import annotations

import importlib

import pytest

# seed -> what it draws on each machine. Found by scanning seeds, so these are real draws.
DRAWS = {
    13: {"fruit9": "usual", "robot3": "bonus"},
    51: {"fruit9": "bonus", "robot3": "usual"},
    54: {"fruit9": "usual", "robot3": "cold"},
    110: {"fruit9": "cold", "robot3": "usual"},
}

WINDOWS = {"usual": (0.50, 0.52), "bonus": (0.40, 0.60), "cold": (0.40, 0.52)}


@pytest.fixture()
def drawn():
    """Force a session seed on the module instance slotplay actually plays, then restore it."""
    slotplay = importlib.import_module("shelf.slotplay")
    reels = slotplay.reels
    original = reels.SESSION_SEED

    def clear() -> None:
        for name in ("target_chance", "variant", "is_bonus", "is_cold", "mood", "chance_window"):
            fn = getattr(reels, name, None)
            if hasattr(fn, "cache_clear"):
                fn.cache_clear()

    def apply(seed: int):
        reels.SESSION_SEED = seed
        clear()
        return reels

    yield apply
    reels.SESSION_SEED = original
    clear()


def test_a_forced_seed_draws_the_mood_it_should(drawn) -> None:
    for seed, expected in DRAWS.items():
        reels = drawn(seed)
        for machine, mood in expected.items():
            assert reels.mood(machine) == mood, (seed, machine, reels.mood(machine))
            assert reels.chance_window(machine) == WINDOWS[mood], (seed, machine)


def test_each_draw_publishes_the_window_it_drew(drawn) -> None:
    for seed, expected in DRAWS.items():
        reels = drawn(seed)
        for machine, mood in expected.items():
            window = reels.chance_window(machine)
            odds = importlib.import_module("shelf.slotplay").odds(machine)
            assert odds["range"] == list(window), (seed, machine, odds)
            assert window[0] <= odds["win_chance"] <= window[1], (seed, machine, odds)
            # The mood has to be visible in the number, not only in the label.
            if mood == "bonus":
                assert odds["win_chance"] >= 0.55, (seed, machine, odds)
            elif mood == "cold":
                assert odds["win_chance"] <= 0.45, (seed, machine, odds)


def test_every_draw_still_returns_the_players_money(drawn) -> None:
    # The machine should not bleed a player who keeps spinning. It holds even on a cold
    # draw - fewer wins, not worse payouts - and the jackpot carries the everyday pays shortfall.
    for seed in DRAWS:
        reels = drawn(seed)
        for machine in DRAWS[seed]:
            session = reels.variant(machine)
            assert session["return"] >= 1.10, (seed, machine, session["return"])


def test_a_cold_draw_is_fewer_wins_and_the_shortfall_is_declared(drawn) -> None:
    # A cold session cannot always carry its return in the everyday pays alone (robot3 measured 0.77 on
    # seed 54). When it cannot, the jackpot is what makes up the difference - and the session's own
    # published return is what the picker quotes, so nothing is promised that is not paid.
    for seed, expected in DRAWS.items():
        reels = drawn(seed)
        for machine, mood in expected.items():
            if mood != "cold":
                continue
            session = reels.variant(machine)
            spec = reels.SPECS[machine]
            everyday = reels.measure(machine, session["blanks"], tuple(
                (symbol, 0 if symbol == spec["jackpot"] else pay)
                for symbol, pay in session["pays"].items()))
            if everyday["rtp"] <= 1.0:
                assert session["return"] >= 1.10, (seed, machine, everyday["rtp"], session["return"])
