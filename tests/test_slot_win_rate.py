"""About half of every machine's spins pay the bet back, and the return lands on its target.

Every flavour is tuned so about 51% of spins pay at least the bet (hit frequency 0.50-0.52), with
each flavour's own return target unchanged. This file is the acceptance test for both halves of it,
and it is the reason the numbers are allowed to be published at all.

Two rules about how it is measured:

* **a hit is a spin that pays at least the bet.** On a five-line machine the bet is split over the
  lines, so a spin that pays back the stake is a spin whose paylines add up to the number of lines (in
  line bets). A five-chip "win" on a twenty-five chip bet is not a hit, and used to be counted as one -
  which is how a machine could claim to win half its spins while the person kept losing.
* **the return is the machine's target, not more and not less** (within a hundredth). The everyday pays
  carry as much of it as they can while the jackpot stays the top prize; whatever is left over is the
  jackpot's, solved to the chip.

The numbers are enumerated exactly - every stop combination of the session's own reels is walked, the
way ``shelf/reels.py`` walks it - and the test re-derives the hit rate from ``reels.result()`` one spin
at a time rather than trusting the machine's own count.
"""

from __future__ import annotations

import importlib
import itertools

import pytest

# The chance window, and the tolerance on the return.
BAND_LOW, BAND_HIGH = 0.50, 0.52
RTP_TOLERANCE = 0.01
MOODS = ("usual", "bonus", "cold")
# How many seeds to look through for each mood. One in fifty sessions is a bonus or a cold one, so the
# usual draw is found in the first few and the others well inside this.
SEED_LIMIT = 4000


def _slotplay():
    """The module the plugin actually plays through.

    ``shelf.reels`` imported directly is a SECOND draw with its own seed (the trap
    tests/test_session_draws.py documents), so everything here goes through slotplay's copy.
    """
    return importlib.import_module("shelf.slotplay")


@pytest.fixture()
def session():
    """Force a session seed on the module slotplay plays, then restore it."""
    slotplay = _slotplay()
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

    def seed_for(mood: str, machine: str) -> int:
        for seed in range(SEED_LIMIT):
            reels.SESSION_SEED = seed
            clear()
            if reels.mood(machine) == mood:
                return seed
        raise AssertionError(f"no {mood} session found for {machine} in {SEED_LIMIT} seeds")

    yield apply, seed_for
    reels.SESSION_SEED = original
    clear()


def _enumerate(machine: str) -> dict:
    """Walk every stop combination and count what the player is actually paid.

    Returns the exact hit count (spins paying at least the bet), the return, the smallest positive
    payout, and how many spins paid anything at all.
    """
    reels = _slotplay().reels
    spec = reels.SPECS[machine]
    session = reels.variant(machine)
    strips = reels.strips(spec, session["blanks"])
    lines = len(spec["lines"])
    combos = hits = paid_any = 0
    total = 0
    floor: int | None = None
    for stops in itertools.product(*(range(len(strip)) for strip in strips)):
        row = reels.result(spec, stops, 1, session["blanks"], session["pays"])
        payout = int(row["payout"])
        combos += 1
        total += payout
        if payout >= lines:
            hits += 1
        if payout > 0:
            paid_any += 1
            floor = payout if floor is None else min(floor, payout)
    return {
        "combos": combos,
        "hit": hits / combos,
        "return": total / (combos * lines),
        "floor": floor or 0,
        "paid_any": paid_any,
        "session": session,
        "lines": lines,
    }


# ---- the hit frequency -------------------------------------------------------


@pytest.mark.parametrize("machine", ["fruit9", "robot3"])
def test_a_usual_session_hands_back_the_bet_on_about_half_its_spins(session, machine: str) -> None:
    apply, seed_for = session
    reels = apply(seed_for("usual", machine))
    counted = _enumerate(machine)
    assert BAND_LOW <= counted["hit"] <= BAND_HIGH, (
        f"{machine}: {counted['hit']:.4f} of spins pay the bet back, outside {BAND_LOW}-{BAND_HIGH}"
    )
    # The machine publishes its own count of the same thing; the two have to agree, or the published
    # number is not the number the reels play. The published one is rounded to four places.
    assert abs(counted["hit"] - counted["session"]["hit"]) < 5e-5, (counted["hit"], counted["session"]["hit"])
    assert reels.chance_window(machine)[0] <= counted["session"]["hit"] <= reels.chance_window(machine)[1]


@pytest.mark.parametrize("machine", ["fruit9", "robot3"])
def test_every_win_pays_at_least_the_bet(session, machine: str) -> None:
    """The two counts are one count: nothing is called a win for paying less than the stake."""
    apply, seed_for = session
    apply(seed_for("usual", machine))
    counted = _enumerate(machine)
    assert counted["paid_any"] == round(counted["hit"] * counted["combos"]), (
        f"{machine}: {counted['paid_any']} spins paid something but only "
        f"{round(counted['hit'] * counted['combos'])} paid the bet"
    )
    assert counted["floor"] >= counted["lines"], (
        f"{machine}: the smallest win is {counted['floor']} line bets, under the {counted['lines']} "
        "the bet is split over"
    )
    assert counted["session"]["floor_pay"] >= counted["lines"], counted["session"]


@pytest.mark.parametrize("machine", ["fruit9", "robot3"])
@pytest.mark.parametrize("mood", MOODS)
def test_the_published_hit_rate_lands_inside_its_own_window(session, machine: str, mood: str) -> None:
    """Usual sessions inside the band; the older bonus and cold draws inside their own."""
    apply, seed_for = session
    reels = apply(seed_for(mood, machine))
    found = reels.variant(machine)
    low, high = reels.chance_window(machine)
    assert low <= found["hit"] <= high, (machine, mood, found["hit"], (low, high))
    if mood == "usual":
        assert BAND_LOW <= found["hit"] <= BAND_HIGH, (machine, found["hit"])


def test_the_usual_window_is_the_owners_band(session) -> None:
    reels = _slotplay().reels
    assert (reels.CHANCE_LOW, reels.CHANCE_HIGH) == (BAND_LOW, BAND_HIGH)


# ---- the return --------------------------------------------------------------


@pytest.mark.parametrize("machine", ["fruit9", "robot3"])
@pytest.mark.parametrize("mood", MOODS)
def test_every_draw_returns_its_machine_target(session, machine: str, mood: str) -> None:
    """RTP on the machine's own target, within a hundredth - bonus and cold draws included."""
    apply, seed_for = session
    apply(seed_for(mood, machine))
    reels = _slotplay().reels
    found = reels.variant(machine)
    target = reels.SPECS[machine]["rtp"]
    assert target - RTP_TOLERANCE <= found["return"] <= target + RTP_TOLERANCE, (
        f"{machine} ({mood}): measured {found['return']:.4f} against a target of {target}"
    )
    assert found["return"] >= target, "a session is never under the machine's own promise"
    counted = _enumerate(machine)
    assert abs(counted["return"] - found["return"]) < 5e-5, (counted["return"], found["return"])


@pytest.mark.parametrize("machine", ["fruit9", "robot3"])
def test_the_everyday_pays_alone_leave_a_session_ahead(session, machine: str) -> None:
    """An ordinary session - one that never hits the jackpot - still ends up ahead.

    Kept while the return is held on target: the jackpot tops the return up rather than carrying
    it.
    """
    apply, seed_for = session
    apply(seed_for("usual", machine))
    found = _slotplay().reels.variant(machine)
    assert found["everyday_rtp"] > 1.0, (machine, found["everyday_rtp"])
    assert found["everyday_rtp"] <= found["return"], (found["everyday_rtp"], found["return"])


@pytest.mark.parametrize("machine", ["fruit9", "robot3"])
def test_the_jackpot_is_the_top_prize_on_every_machine(session, machine: str) -> None:
    """The Nous logo pays the most, whatever the session drew."""
    apply, seed_for = session
    reels = _slotplay().reels
    for mood in MOODS:
        apply(seed_for(mood, machine))
        found = reels.variant(machine)
        spec = reels.SPECS[machine]
        assert found["jackpot_is_top"], (machine, mood, found)
        assert found["pays"][spec["jackpot"]] > found["top_pay"], (machine, mood, found["pays"])
        assert found["jackpot_pay"] == found["pays"][spec["jackpot"]]


@pytest.mark.parametrize("machine", ["fruit9", "robot3"])
def test_the_pay_table_quotes_the_session_the_reels_play(session, machine: str) -> None:
    """What it pays is generated from the live table, jackpot row included."""
    apply, seed_for = session
    apply(seed_for("usual", machine))
    slotplay = _slotplay()
    spec = slotplay.reels.SPECS[machine]
    rows = slotplay.paytable(machine, stake=5)
    quoted = {row["symbol"]: row["payout"] for row in rows}
    pays = slotplay.reels.variant(machine)["pays"]
    for symbol, value in pays.items():
        three = f"{symbol} {symbol} {symbol}"
        assert quoted.get(three) == value * 5, (symbol, quoted.get(three), value)
    assert f"{spec['jackpot']} {spec['jackpot']} {spec['jackpot']}" in quoted
    # The machine's own view marks that row as the jackpot without guessing it from the payout.
    for info in slotplay.machine_list():
        assert info["jackpot_symbol"] == spec["jackpot"], info
