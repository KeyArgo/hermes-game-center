"""The comeback loop: a graded rescue tap when the wallet cannot cover a bet.

Owner's ask, 2026-11-09: "come up with a gamification for making quick chips when the user runs out
so they aren't broke and unable to play ... really gamify this so its addictive to the user".

The properties that matter are the ones a player could exploit if they broke: it is refused while
the wallet can still play, the cooldown holds under a clock, the streak pays for returning on another
day rather than for hammering the button, and the comeback premium is paid on real wins only.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from shelf.wallet import MIN_BET, START_CHIPS, Wallet, wallet_path  # noqa: E402

DAY = 86_400


def broke(tmp_path: Path, chips: int = 10) -> Wallet:
    wallet = Wallet(wallet_path(tmp_path))
    with wallet._held() as data:
        data["chips"] = chips
    return wallet


def test_it_is_refused_while_the_person_can_still_play(tmp_path: Path) -> None:
    wallet = Wallet(wallet_path(tmp_path))
    answer = wallet.bailout("perfect", now=1000)
    assert answer["given"] == 0 and answer["reason"] == "not broke"
    assert wallet.read()["chips"] == START_CHIPS, "nothing was handed out"


def test_a_graded_shot_picks_the_stack(tmp_path: Path) -> None:
    for grade, expected in (("miss", 1500), ("good", 2500), ("perfect", 4000), ("nonsense", 1500)):
        folder = tmp_path / grade
        wallet = broke(folder)
        answer = wallet.bailout(grade, now=DAY * 20_000)
        assert answer["given"] == expected, (grade, answer)
        assert wallet.read()["chips"] == 10 + expected


def test_the_cooldown_holds(tmp_path: Path) -> None:
    wallet = broke(tmp_path)
    now = DAY * 20_000
    assert wallet.bailout("good", now=now)["given"] == 2500
    with wallet._held() as data:      # stand the wallet broke again for the second attempt
        data["chips"] = 10
    second = wallet.bailout("good", now=now + 60)
    assert second["given"] == 0 and second["reason"] == "cooling"
    assert second["next_at"] == now + Wallet.BAILOUT_COOLDOWN


def test_the_streak_pays_for_returning_on_another_day(tmp_path: Path) -> None:
    wallet = broke(tmp_path)
    first = wallet.bailout("good", now=DAY * 20_000 + 500)
    assert first["streak"] == 1 and first["given"] == 2500
    with wallet._held() as data:
        data["chips"] = 10
    # Same day: no new streak tick, and the cooldown still applies.
    assert wallet.bailout("good", now=DAY * 20_000 + 900)["reason"] == "cooling"
    with wallet._held() as data:
        data["chips"] = 10
    second = wallet.bailout("good", now=DAY * 20_001 + 500)
    assert second["streak"] == 2 and second["given"] == 2750, "day two pays ten percent more"


def test_the_comeback_premium_is_paid_on_wins_only(tmp_path: Path) -> None:
    wallet = broke(tmp_path)
    wallet.bailout("perfect", now=DAY * 20_000)
    held = wallet.read()
    assert held["comeback"] == Wallet.COMEBACK_SPINS

    row = wallet.record_spin({"payout": 100, "machine": "fruit9", "at": 1})
    assert row["feed"][0]["payout"] == 120, "a fifth more while the comeback runs"
    assert row["comeback"] == Wallet.COMEBACK_SPINS - 1

    spent = wallet.record_spin({"payout": 0, "machine": "fruit9", "at": 2})
    assert spent["comeback"] == Wallet.COMEBACK_SPINS - 1, "a losing spin does not burn the premium"


def test_the_premium_runs_out(tmp_path: Path) -> None:
    wallet = broke(tmp_path)
    wallet.bailout("perfect", now=DAY * 20_000)
    for index in range(Wallet.COMEBACK_SPINS):
        wallet.record_spin({"payout": 100, "machine": "fruit9", "at": index})
    assert wallet.read()["comeback"] == 0
    row = wallet.record_spin({"payout": 100, "machine": "fruit9", "at": 99})
    assert row["feed"][0]["payout"] == 100, "after ten wins the premium is gone"


def test_a_rescue_never_pays_points(tmp_path: Path) -> None:
    wallet = broke(tmp_path)
    before = wallet.read()["bonus"]
    wallet.bailout("perfect", now=DAY * 20_000)
    assert wallet.read()["bonus"] == before, "the rescue buys chips, never rank"
