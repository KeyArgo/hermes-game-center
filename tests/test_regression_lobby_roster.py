"""The lobby does not hand a signed-out caller a list of who is playing.

`GET /api/lobby` is public so a visitor can browse the tables. It also returned the
queue and presence rosters — display names, ratings and the game — to anyone with
the URL, so the names of everyone currently looking for a game could be scraped
without an account. Tables, counts and the ladder stay public; names need a sign-in.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_spec = importlib.util.spec_from_file_location("lobby_helpers", Path(__file__).with_name("test_online_server.py"))
helpers = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(helpers)
run, started, sign_in = helpers.run, helpers.started, helpers.sign_in


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_a_signed_out_caller_gets_counts_but_no_names(tmp_path) -> None:
    async def scenario():
        _server, client = await started(tmp_path)
        try:
            ada, token = await sign_in(client, "Ada")
            await client.post("/api/queue", json={"game": "connect4"}, headers=auth(token))

            anonymous = await (await client.get("/api/lobby")).json()
            assert anonymous["presence"]["humans"] == [], anonymous["presence"]
            assert anonymous["presence"]["bots"] == []
            assert anonymous["waiting"].get("connect4", []) == []

            seen = await (await client.get("/api/lobby", headers=auth(token))).json()
            assert [p["name"] for p in seen["waiting"]["connect4"]] == ["Ada"]
            assert "Ada" in [p["name"] for p in seen["presence"]["humans"]]
        finally:
            await client.close()
    run(scenario())


def test_the_public_parts_of_the_lobby_stay_public(tmp_path) -> None:
    async def scenario():
        _server, client = await started(tmp_path)
        try:
            anonymous = await (await client.get("/api/lobby")).json()
            assert anonymous["games"], "a visitor must still see the games"
            assert anonymous["ladder"], "a visitor must still see the ladder"
            assert anonymous["looking"]["connect4"] == 0
        finally:
            await client.close()
    run(scenario())
