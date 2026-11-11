"""Three of the jackpot symbol must count as a jackpot after the session retunes its pay.

The session solver replaces the starting guess in SPECS. The result flag was still compared
to that guess, so a real jackpot paid the session amount and the table never called it one.
The payout itself is the session's; only the flag was wrong.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from shelf.reels import NOUS, SPECS, result, strips  # noqa: E402


def test_a_retuned_jackpot_is_still_a_jackpot() -> None:
    spec = SPECS["fruit9"]
    tuned = dict(spec["pays"])
    tuned[NOUS] = spec["pays"][NOUS] - 50
    stops = tuple(strip.index(NOUS) for strip in strips(spec, 0))
    out = result(spec, stops, stake=1, blanks=0, pays=tuned)
    assert out["payout"] == tuned[NOUS]
    assert any(win["symbol"] == NOUS and win["pay"] == tuned[NOUS] for win in out["wins"])
    assert out["jackpot"] is True
