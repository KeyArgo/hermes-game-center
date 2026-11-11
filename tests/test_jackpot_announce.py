"""Regression: the Jackpot Mode "hit JACKPOT!" broadcast must fire on a prize a
spin can actually pay (A51 bug hunt, round 1).

``online/server.py`` announced a jackpot in chat only when an earned pull paid
exactly ``260`` chips::

    if spin_result["payout"] == 260:
        msg = f"... hit JACKPOT! 260 chips!"

But ``online/slots.py`` can never pay 260. Its only reachable payouts are
``{0, 5, 8, 10, 12, 45, 130, 3123}`` -- the top prize (three NOUS stamps) pays
3123. So the branch was dead: no real spin could ever trigger the announcement,
and the "260 chips!" text was wrong besides. 260 is a stale constant from an
older payout table.

The fix pins the announcement to the machine's real top prize via the
``JACKPOT_ANNOUNCE`` constant, derived from the live payout table.
"""

from __future__ import annotations


def _reachable_payouts(slots) -> set[int]:
    """Every payout a single spin of online.slots can produce."""
    reach = set()
    for a in slots.SYMBOLS:
        for b in slots.SYMBOLS:
            for c in slots.SYMBOLS:
                if a == b == c:
                    reach.add(slots.PAYOUTS_3OAK.get(a, 0))
                elif a == "NOUS" and b == "NOUS":
                    reach.add(10)
                else:
                    reach.add(0)
    return reach


def test_the_stale_260_jackpot_value_is_unreachable():
    """Documents the defect: no spin can ever pay 260, so == 260 was dead code."""
    from online import slots
    assert 260 not in _reachable_payouts(slots)


def test_jackpot_announcement_fires_on_the_real_top_prize():
    """The announced payout must be a reachable prize, and the top one at that."""
    from online import server, slots
    reachable = _reachable_payouts(slots)
    announce = server.JACKPOT_ANNOUNCE
    assert announce in reachable, (announce, sorted(reachable))
    assert announce == max(reachable)
    # The NOUS triple is the jackpot everywhere in this repo.
    assert announce == slots.PAYOUTS_3OAK["NOUS"]
