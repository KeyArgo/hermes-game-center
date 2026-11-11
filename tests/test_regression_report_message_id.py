"""Regression: /api/reports must reject a non-numeric message_id with 400, not 500.

The handler parsed the body's ``message_id`` unconditionally::

    message_id = int(body.get("message_id") or 0)

A signed-in player who sends ``{"message_id": "abc"}`` (or any non-numeric /
non-integer value) made ``int()`` raise ``ValueError``. There is no error
middleware, so aiohttp turns that into a 500 Internal Server Error. Input
validation on a user-supplied id must produce a clean 400 instead.
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


def run(coro):
    return asyncio.run(coro)


async def _started(tmp_path):
    server = App(tmp_path, games=LOADED)
    client = TestClient(TestServer(server.build()))
    await client.start_server()
    return server, client


async def _sign_in(client, name):
    response = await client.post("/api/session", json={"name": name})
    body = await response.json()
    return body["player"], body["token"]


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def test_non_numeric_message_id_is_a_400_not_a_500(tmp_path):
    async def scenario():
        server, client = await _started(tmp_path)
        try:
            _, token = await _sign_in(client, "Ada")
            response = await client.post(
                "/api/reports",
                json={"kind": "name", "target_name": "Someone", "reason": "spam",
                      "message_id": "abc"},
                headers=_auth(token),
            )
            assert response.status != 500, await response.text()
            assert response.status == 400, await response.text()
        finally:
            await client.close()

    run(scenario())


def test_list_message_id_is_a_400_not_a_500(tmp_path):
    async def scenario():
        server, client = await _started(tmp_path)
        try:
            _, token = await _sign_in(client, "Ada")
            response = await client.post(
                "/api/reports",
                json={"kind": "name", "target_name": "Someone", "reason": "spam",
                      "message_id": [1, 2]},
                headers=_auth(token),
            )
            assert response.status != 500, await response.text()
            assert response.status == 400, await response.text()
        finally:
            await client.close()

    run(scenario())
