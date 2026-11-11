"""The public jackpot leaderboard reads what the caller asks for, bounded.

`GET /api/leaderboard/jackpot?limit=` went straight into `int()` and then into a
SQL `LIMIT`: a non-numeric value raised and became a 500, and a negative value is
SQLite's "no limit", so `?limit=-1` returned every player in the ledger together
with a correlated COUNT per row. A public endpoint must clamp, not trust.
"""
from __future__ import annotations

import importlib.util
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_spec = importlib.util.spec_from_file_location("jackpot_helpers", Path(__file__).with_name("test_online_server.py"))
helpers = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(helpers)
run, started = helpers.run, helpers.started


def _seed_rows(app, count: int = 3) -> None:
    now = time.time()
    for index in range(count):
        player = f"web:limit{index}"
        app.ledger.db.execute(
            "INSERT OR REPLACE INTO chips (player, balance, won, lost, updated) VALUES (?, ?, ?, ?, ?)",
            (player, 100, 10 * (index + 1), 5, now))
        app.ledger.db.execute(
            "INSERT OR REPLACE INTO pulls (id, player, seed, reels, payout, ts) VALUES (?, ?, ?, ?, ?, ?)",
            (f"pull-{index}", player, "seed", "[]", 5, now))


def test_a_non_numeric_limit_is_not_a_server_error(tmp_path) -> None:
    async def scenario():
        server, client = await started(tmp_path)
        try:
            _seed_rows(server)
            answer = await client.get("/api/leaderboard/jackpot?limit=abc")
            assert answer.status != 500, await answer.text()
        finally:
            await client.close()
    run(scenario())


def test_a_negative_limit_does_not_return_the_whole_ledger(tmp_path) -> None:
    async def scenario():
        server, client = await started(tmp_path)
        try:
            _seed_rows(server, 3)
            answer = await (await client.get("/api/leaderboard/jackpot?limit=-1")).json()
            assert len(answer["rows"]) == 1, answer["rows"]
        finally:
            await client.close()
    run(scenario())


def test_a_limit_above_the_cap_is_clamped(tmp_path) -> None:
    async def scenario():
        server, client = await started(tmp_path)
        try:
            _seed_rows(server, 3)
            answer = await (await client.get("/api/leaderboard/jackpot?limit=100000")).json()
            assert len(answer["rows"]) == 3
            assert server.ledger.get_leaderboard(limit=1)[0]["player"]
        finally:
            await client.close()
    run(scenario())
