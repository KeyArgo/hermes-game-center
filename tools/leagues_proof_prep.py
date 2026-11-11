"""Seed a real, local lobby server for the BO browser proof and keep it running.

Creates two people with a bot each, starts one rated Hex pair, has both bots play
two plies on the first leg, and holds the sockets open so the table is live while
the browser proof runs. Nothing here touches the live site: the server binds
127.0.0.1 on a free port and dies with this process.

    python3 tools/leagues_proof_prep.py

Prints one JSON line: {"url": ..., "room": ..., "bots": [...]} then waits.
"""

from __future__ import annotations

import asyncio
import json
import socket
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aiohttp import ClientSession, web  # noqa: E402
from aiohttp.test_utils import TestServer  # noqa: E402

from online.rooms import load_games  # noqa: E402
from online.server import App  # noqa: E402


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


async def main() -> None:
    data = Path(tempfile.mkdtemp(prefix="gameshelf-bo-proof-"))
    port = free_port()
    app = App(data, games=load_games())
    runner = web.AppRunner(app.build())
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()
    base = f"http://127.0.0.1:{port}"

    async with ClientSession() as client:
        async def post(path: str, body: dict | None = None, key: str = "") -> dict:
            headers = {"Authorization": f"Bearer {key}"} if key else {}
            async with client.post(base + path, json=body or {}, headers=headers) as answer:
                return await answer.json()

        async def get(path: str) -> dict:
            async with client.get(base + path) as answer:
                return await answer.json()

        ada = await post("/api/session", {"name": "Proof Ada"})
        bea = await post("/api/session", {"name": "Proof Bea"})
        tag = str(int(__import__("time").time()) % 100000)
        bot_a = await post("/api/bots", {"name": f"Proof Robo {tag}"}, key=ada["token"])
        bot_b = await post("/api/bots", {"name": f"House Hound {tag}"}, key=bea["token"])

        card = {
            "schema": "doctrine-card/1", "name": "Proof Card", "author": "Proof Ada",
            "personality": "Holds the middle and never overcommits.",
            "weights": {"aggression": 55, "safety": 45, "objective": 50, "focus": 55,
                        "cohesion": 40, "center": 60, "mobility": 50, "endurance": 40},
        }
        saved = await post("/api/cards", {"game": "doctrine", "card": card}, key=ada["token"])
        rival = await post("/api/cards", {"game": "doctrine", "card": {**card, "name": "Rival Card"}},
                           key=bea["token"])
        bout = await post("/api/card-arena", {"game": "doctrine", "mine": saved["card"]["id"],
                                              "theirs": rival["card"]["id"]}, key=ada["token"])

        made = await post("/api/ladder", {"game": "hex", "opponent": bot_b["bot"]["id"]},
                          key=bot_a["key"])
        room = made["room"]["id"]
        first = await client.ws_connect(f"{base}/ws/{room}")
        second = await client.ws_connect(f"{base}/ws/{room}")
        await first.send_json({"t": "auth", "token": bot_a["key"]})
        await second.send_json({"t": "auth", "token": bot_b["key"]})
        await asyncio.sleep(0.2)
        await first.send_json({"t": "cmd", "action": "move", "args": ["a1"], "ref": 1})
        await asyncio.sleep(0.2)
        await second.send_json({"t": "cmd", "action": "move", "args": ["b1"], "ref": 2})
        await asyncio.sleep(0.2)

        print(json.dumps({
            "url": base, "room": room, "bot": bot_a["bot"]["id"],
            "white": bot_a["bot"]["name"], "black": bot_b["bot"]["name"],
            "bout": bout.get("bout", {}).get("id", ""),
        }), flush=True)

        # Hold the live table open until the proof is done with it, and keep its move
        # clock fresh so the janitor does not forfeit a table nobody is meant to finish.
        try:
            while True:
                for room_id in list(app.rooms.turn_since):
                    app.rooms.turn_since[room_id] = __import__("time").time() + 3600
                await asyncio.sleep(3)
        finally:
            await first.close()
            await second.close()
            await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
