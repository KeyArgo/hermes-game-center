"""Regression: a slot result flags the jackpot by the session's own paytable,
not the base guess (A51 bug hunt, round 2).

``shelf/reels.py`` re-solves each machine's jackpot pay once per session, so the
live pay usually differs from the ``SPECS[...]["pays"]`` starting guess. But
``result()`` decided whether a spin was a jackpot by comparing the line's pay to
the *base* table::

    jackpot = any(
        win["symbol"] == spec["jackpot"]
        and win["pay"] >= int(stake) * spec["pays"][spec["jackpot"]]   # base, not session
        for win in wins
    )

When the session pay is below the base guess -- which happens routinely (this
session fruit9 solved to 428 against a 525 base) -- a genuine three-NOUS line
pays the session amount, which is less than ``stake * base``, so the ``>=`` is
false and the jackpot goes unflagged. The flag drives the UI "big win"
celebration (desktop/plugin.js) and the spin log, so a real jackpot was being
recorded and shown as an ordinary win.

The fix compares against the paytable actually in use for the spin.
"""

from __future__ import annotations


def _nous_stops(spec) -> tuple[int, int, int]:
    """A stop per reel that lands the jackpot symbol on the middle row of every reel."""
    from shelf import reels
    stops = []
    for strip in spec["strips"]:
        stops.append(strip.index(reels.NOUS))
    return tuple(stops)


def test_a_jackpot_line_is_flagged_when_the_session_pays_below_the_base():
    from shelf import reels
    spec = reels.SPECS["fruit9"]
    base = spec["pays"][reels.NOUS]
    session_pays = dict(spec["pays"])
    session_pays[reels.NOUS] = base - 100  # a solved session pay under the base guess
    stops = _nous_stops(spec)
    out = reels.result(spec, stops, stake=1, blanks=0, pays=session_pays)
    # The middle line really is three NOUS stamps, the jackpot symbol.
    assert any(win["symbol"] == reels.NOUS for win in out["wins"]), out["wins"]
    assert out["jackpot"] is True


def test_a_higher_session_pay_still_flags_the_jackpot():
    from shelf import reels
    spec = reels.SPECS["fruit9"]
    session_pays = dict(spec["pays"])
    session_pays[reels.NOUS] = spec["pays"][reels.NOUS] + 300
    out = reels.result(spec, _nous_stops(spec), stake=2, blanks=0, pays=session_pays)
    assert out["jackpot"] is True


def test_an_ordinary_line_is_not_a_jackpot():
    from shelf import reels
    spec = reels.SPECS["fruit9"]
    # Three oranges on the middle line: a win, but not the jackpot symbol.
    stops = tuple(strip.index(reels.ORANGE) for strip in spec["strips"])
    out = reels.result(spec, stops, stake=1, blanks=0)
    assert out["payout"] > 0
    assert out["jackpot"] is False
