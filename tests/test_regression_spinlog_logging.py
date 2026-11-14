"""A spin log that cannot be written says so instead of vanishing.

``shelf/spinlog.py`` is best-effort by design: a spin must never fail because its log could not be
written. The defect these tests pin is the opposite failure — it was *silently* best-effort, so a
log that had stopped being written at all looked exactly like a log with nothing to record, and a
question about missing payouts could not be answered from a log that never existed.

Every handler now logs at warning level with the traceback a person can act on. The game still does
not raise: the balance, the payout and the spin are untouched.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import pytest

from shelf import spinlog

SPIN = {"at": 1_700_000_000.0, "machine": "spins", "bet": 25, "payout": 0, "stops": [1, 2, 3]}


def test_a_log_that_cannot_be_opened_is_reported_not_swallowed(tmp_path: Path, caplog) -> None:
    """A directory where the log file should be: the write fails, and the failure is visible."""
    (tmp_path / spinlog.LOG_NAME).mkdir()

    with caplog.at_level(logging.WARNING, logger="shelf.spinlog"):
        spinlog.record(tmp_path / "wallet.json", SPIN)  # must not raise

    assert "a spin could not be recorded" in caplog.text, "the failed write is still silent"
    assert caplog.records[-1].exc_info is not None, "the warning carries no traceback to act on"


def test_a_rollover_that_cannot_happen_is_reported(tmp_path: Path, caplog, monkeypatch) -> None:
    """Full log, move it aside, move fails: the spin is still recorded and the rollover is logged."""
    path = tmp_path / spinlog.LOG_NAME
    path.write_text("x" * (spinlog.MAX_BYTES + 1), encoding="utf-8")

    def refuse(src, dst):
        raise OSError("read-only filesystem")

    monkeypatch.setattr(os, "replace", refuse)

    with caplog.at_level(logging.WARNING, logger="shelf.spinlog"):
        spinlog.record(tmp_path / "wallet.json", SPIN)

    assert "a full spin log could not be rolled over" in caplog.text
    own = [r for r in caplog.records if r.name == "shelf.spinlog"]
    assert own and own[-1].exc_info is not None
    assert path.exists() and path.stat().st_size > spinlog.MAX_BYTES, "the spin must still be appended"


@pytest.mark.parametrize("wallet_name", ["wallet.json"])
def test_a_healthy_log_records_without_a_warning(tmp_path: Path, caplog, wallet_name: str) -> None:
    """The fix must not make a working log noisy: no warning when everything succeeds."""
    with caplog.at_level(logging.WARNING, logger="shelf.spinlog"):
        spinlog.record(tmp_path / wallet_name, SPIN)

    assert caplog.text == ""
    written = (tmp_path / spinlog.LOG_NAME).read_text(encoding="utf-8").strip().splitlines()
    assert len(written) == 1 and '"bet":25' in written[0]
