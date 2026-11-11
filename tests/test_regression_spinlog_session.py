"""The log must record the session the spin actually used, not a second draw of its own.

The defect these tests pin: ``slotplay.spin`` logged ``reels.variant(machine)`` — a fresh draw —
instead of the variant ``reels.spin`` had already used to pay. Two draws of the same machine carry
different blank counts and paytables, so re-deriving a payout from the stops with the *logged*
variant disagreed with the *paid* one on 184 of 592 real spins (2026-11-10). Those 184 were reported
as payout mismatches; every one of them was the log lying about the paytable, not the machine
underpaying. A false accusation is the worst thing a proof tool can do.

So: the session is carried out of ``reels.spin`` on the result itself, and the log writes that exact
one. ``scripts/slot-audit.py --verify`` then agrees with every spin, which is what makes a real
mismatch mean something.
"""

from __future__ import annotations

import json
from pathlib import Path

from shelf import reels, slotplay
from shelf.wallet import Wallet

MACHINE = "fruit9"


def _wallet(tmp_path: Path, chips: int = 10_000_000) -> Wallet:
    wallet = Wallet(tmp_path / "wallet.json")
    held = wallet.read()
    held["chips"] = chips
    held["bet"] = 25
    wallet.path.write_text(json.dumps(held))
    return wallet


def test_a_spin_reports_the_session_it_paid_with() -> None:
    drawn = reels.spin(MACHINE, 5)
    session = drawn.get("session")
    assert session, "a spin must carry the session it paid with"
    assert set(session) >= {"hit", "return", "blanks", "pays"}
    # And it is the paytable that money came from: re-deriving with it must agree.
    again = reels.result(reels.SPECS[MACHINE], tuple(drawn["stops"]), 5,
                         session["blanks"], session["pays"])
    assert again["payout"] == drawn["payout"]


def test_the_log_records_the_session_that_paid(tmp_path: Path) -> None:
    wallet = _wallet(tmp_path)
    row = slotplay.spin(wallet, bet=25, machine=MACHINE)
    assert row is not None
    line = json.loads((tmp_path / "spins.jsonl").read_text().strip().splitlines()[-1])
    assert line["session"]["pays"] == row["session"]["pays"]
    assert line["session"]["blanks"] == row["session"]["blanks"]


def test_every_logged_payout_re_derives_without_disagreement(tmp_path: Path) -> None:
    """The end-to-end claim: read the log back and re-derive it, as the audit script does."""
    wallet = _wallet(tmp_path)
    for _ in range(60):
        assert slotplay.spin(wallet, bet=25, machine=MACHINE) is not None

    rows = [json.loads(line) for line in
            (tmp_path / "spins.jsonl").read_text().splitlines() if line.strip()]
    assert len(rows) == 60
    for row in rows:
        spec = reels.SPECS[row["machine"]]
        per_line = max(1, row["bet"] // len(spec["lines"]))
        expected = reels.result(spec, tuple(row["stops"]), per_line,
                                row["session"]["blanks"], row["session"]["pays"])
        assert expected["payout"] == row["payout"], row["at"]
