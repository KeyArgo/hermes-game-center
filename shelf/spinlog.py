"""A plain record of every spin, so a payout can be proved rather than argued about.

The slot machine is the one place where a person can lose real (earned) chips on a random draw, and
a session that felt wrong is exactly the claim a log has to answer. A feed of twenty spins in the
wallet is enough for the UI and useless for a claim about odds, so this writes one JSON line
per spin - the stops, the grid, the pays, what was credited, and the chance the session promised.

Two rules it keeps:

* It never raises. A logging failure must not stop a spin, cost a payout or change a balance.
* It never writes inside the repository. The log lives beside the wallet, in the plugin's data root,
  and rolls over on size so a long-running install cannot fill a disk.

Read it with ``scripts/slot-audit.py``, which re-derives each payout from the stops and refuses to
trust the number that was written down.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

# One spin is roughly 400 bytes; 8 MB holds about 20,000 spins, which is far more than the several
# thousand needed for a return measurement to be worth reading.
MAX_BYTES = 8 * 1024 * 1024
LOG_NAME = "spins.jsonl"

log = logging.getLogger(__name__)


def log_path(wallet_path) -> Path:
    """The log for a wallet: beside it, in the plugin's own data folder."""
    return Path(wallet_path).parent / LOG_NAME


def record(wallet_path, row: dict, session: dict | None = None) -> None:
    """Append one spin. Best-effort by design: an unwritable log is not a broken game."""
    try:
        path = log_path(wallet_path)
        try:
            if path.exists() and path.stat().st_size > MAX_BYTES:
                os.replace(path, path.with_suffix(path.suffix + ".1"))
        except OSError:
            log.warning("a full spin log could not be rolled over", exc_info=True)
        entry = {
            "at": float(row.get("at") or time.time()),
            "machine": row.get("machine"),
            "bet": int(row.get("bet") or 0),
            "payout": int(row.get("payout") or 0),
            "jackpot": bool(row.get("jackpot")),
            "auto": bool(row.get("auto")),
            "stops": list(row.get("stops") or []),
            "grid": row.get("grid"),
            "wins": [{"line": win.get("line"), "symbol": win.get("symbol"), "pay": win.get("pay")}
                     for win in (row.get("wins") or [])],
            "comeback_bonus": row.get("comeback_bonus"),
            "chips": row.get("chips"),
        }
        if session:
            entry["session"] = {
                "hit": session.get("hit"),
                "return": session.get("return"),
                "target": session.get("target"),
                "blanks": session.get("blanks"),
                "pays": session.get("pays"),
            }
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
    except Exception:
        # Best-effort by design: a spin must not fail because a log could not be written, but a log
        # that keeps failing is worth seeing in the console rather than being guessed at later.
        log.warning("a spin could not be recorded", exc_info=True)
        return


def summary(wallet_path, machine: str | None = None, min_spins: int = 200) -> dict | None:
    """What the log actually shows: spins, chips staked, chips paid, and the return.

    The machine quotes a promised return from the session it drew. A promise is not a measurement, so
    this reads the spins beside the wallet and lets the number on screen be the measured one. None until there are enough spins for the number to mean anything: a return over
    20 spins is noise wearing a decimal point.
    """
    path = log_path(wallet_path)
    try:
        if not path.exists():
            return None
        spins = staked = paid = won = 0
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if machine and row.get("machine") != machine:
                    continue
                bet = int(row.get("bet") or 0)
                if bet <= 0:
                    continue
                spins += 1
                staked += bet
                payout = int(row.get("payout") or 0)
                paid += payout
                if payout > 0:
                    won += 1
    except OSError:
        return None
    if spins < int(min_spins) or not staked:
        return None
    return {"spins": spins, "staked": staked, "paid": paid,
            "return": round(paid / staked, 4), "hit": round(won / spins, 4)}
