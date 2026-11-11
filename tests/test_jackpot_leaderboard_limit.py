"""Regression: the Jackpot leaderboard's ``limit`` query parameter (A51 bug hunt, round 1).

``online/server.py`` built the limit as::

    limit = min(int(request.query.get("limit", "50")), 500)

Two defects:

* A negative ``?limit=-1`` becomes ``min(-1, 500) == -1``. In SQLite ``LIMIT -1``
  means *no limit*, so the 500-row cap is silently bypassed and the whole chip
  table is dumped in one request.
* A non-numeric ``?limit=abc`` raises ``ValueError`` inside the handler, which
  aiohttp turns into a 500 Internal Server Error instead of a clean response.

The fix clamps the parsed value into ``[1, 500]`` and tolerates junk input.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from online.rooms import load_games  # noqa: E402
from online.server import App  # noqa: E402

LOADED = load_games()
CAP = 510  # just over the server's 500-row cap, so a bypass is visible


def run(coro):
    return asyncio.run(coro)


async def _seed_and_query(tmp_path, query):
    server = App(tmp_path, games=LOADED)
    for i in range(CAP):
        pid = f"p{i:04d}"
        server.ledger.init_player(pid, 100)
        server.ledger.record_pull(pid, "seed", "AAA", i)
    client = TestClient(TestServer(server.build()))
    await client.start_server()
    try:
        response = await client.get("/api/leaderboard/jackpot" + query)
        status = response.status
        body = await response.json() if status == 200 else {}
        return status, body
    finally:
        await client.close()


def test_negative_limit_does_not_bypass_the_row_cap(tmp_path):
    status, body = run(_seed_and_query(tmp_path, "?limit=-1"))
    assert status == 200
    # Pre-fix this returned all 510 rows because LIMIT -1 is unbounded in SQLite.
    assert len(body["rows"]) <= 500, len(body["rows"])


def test_a_huge_limit_is_still_capped(tmp_path):
    status, body = run(_seed_and_query(tmp_path, "?limit=100000"))
    assert status == 200
    assert len(body["rows"]) == 500


def test_a_non_numeric_limit_is_not_a_server_error(tmp_path):
    status, _ = run(_seed_and_query(tmp_path, "?limit=abc"))
    # Pre-fix this raised ValueError inside the handler -> HTTP 500.
    assert status == 200
