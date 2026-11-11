#!/usr/bin/env python3
"""Bring up the real lobby plus the Desktop QA server for the Open-in-browser proof.

A real ``online.server.App`` runs on a free loopback port (no seeded fixture: the
same signup/queue endpoints a person uses), and ``tests/browser_table_server.py``
runs beside it with ``--lobby-url`` pointing at that lobby — so the Desktop pane's
``online.url`` is the local server, exactly as the setting intends. Everything the
proof needs already exists server-side (two people, bot passports with rated games,
a saved card-arena bout, a live bot table) is seeded through those endpoints.

Prints one JSON line — {lobby, qa, ada, bea, bot, opponent, bout, room, ...} — and
holds until killed. Servers stop with the process, nothing persists.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aiohttp import web  # noqa: E402

from online.server import App  # noqa: E402
from online.rooms import load_games  # noqa: E402


def free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = int(sock.getsockname()[1])
    sock.close()
    return port


async def seed(app: App, base: str) -> dict:
    import aiohttp

    async with aiohttp.ClientSession() as session:
        async def post(path, payload=None, token=None):
            headers = {"Content-Type": "application/json"}
            if token:
                headers["Authorization"] = f"Bearer {token}"
            async with session.post(base + path, json=payload or {}, headers=headers) as resp:
                data = await resp.json()
                if resp.status >= 400:
                    raise RuntimeError(f"{path} -> {resp.status}: {data}")
                return data

        ada = await post("/api/session", {"name": "Proof Ada"})
        bea = await post("/api/session", {"name": "Proof Bea"})
        tag = str(int(time.time()) % 100000)
        bot_a = await post("/api/bots", {"name": f"Proof Robo {tag}"}, ada["token"])
        bot_b = await post("/api/bots", {"name": f"House Hound {tag}"}, bea["token"])
        card = {
            "schema": "doctrine-card/1", "name": "Proof Card", "author": "Proof Ada",
            "personality": "Holds the middle and never overcommits.",
            "weights": {"aggression": 55, "safety": 45, "objective": 50, "focus": 55,
                        "cohesion": 40, "center": 60, "mobility": 50, "endurance": 40},
        }
        saved = await post("/api/cards", {"game": "doctrine", "card": card}, ada["token"])
        rival = await post("/api/cards", {"game": "doctrine",
                                          "card": {**card, "name": "Rival Card"}}, bea["token"])
        bout = await post("/api/card-arena", {"game": "doctrine", "mine": saved["card"]["id"],
                                              "theirs": rival["card"]["id"]}, ada["token"])
        # A rated pair of bots with two plies: passports exist and one table is live.
        made = await post("/api/ladder", {"game": "hex", "opponent": bot_b["bot"]["id"]}, bot_a["key"])
        room = made["room"]["id"]
        first = await session.ws_connect(f"{base}/ws/{room}".replace("http://", "ws://"))
        second = await session.ws_connect(f"{base}/ws/{room}".replace("http://", "ws://"))
        await first.send_json({"t": "auth", "token": bot_a["key"]})
        await second.send_json({"t": "auth", "token": bot_b["key"]})
        await asyncio.sleep(0.2)
        await first.send_json({"t": "cmd", "action": "move", "args": ["a1"], "ref": 1})
        await asyncio.sleep(0.2)
        await second.send_json({"t": "cmd", "action": "move", "args": ["b1"], "ref": 2})
        await asyncio.sleep(0.2)
        return {
            "ada": {"name": "Proof Ada", "token": ada["token"], "id": ada["player"]["id"]},
            "bea": {"name": "Proof Bea", "token": bea["token"], "id": bea["player"]["id"]},
            "bot": bot_a["bot"]["id"], "bot_name": bot_a["bot"]["name"],
            "opponent": bot_b["bot"]["name"],
            "bout": bout.get("bout", {}).get("id", ""), "room": room,
            "white": bot_a["bot"]["name"], "black": bot_b["bot"]["name"],
            "_sockets": (first, second),
        }


async def main() -> None:
    lobby_port = free_port()
    qa_port = free_port()
    # The QA server persists the plugin's own data dir; a stale online.json from
    # an earlier run would hand the proof a dead match card. Start clean.
    shutil.rmtree(ROOT / "data", ignore_errors=True)
    store = ROOT / "tmp" / f"ob-proof-store-{int(time.time())}"
    os.makedirs(store, exist_ok=True)
    app = App(store, games=load_games())
    runner = web.AppRunner(app.build())
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", lobby_port)
    await site.start()
    base = f"http://127.0.0.1:{lobby_port}"
    seeded = await seed(app, base)

    env = dict(os.environ, PYTHONPATH=str(ROOT), PYTHONUNBUFFERED="1")
    qa = subprocess.Popen(
        [sys.executable, "tests/browser_table_server.py",
         "--root", str(ROOT), "--port", str(qa_port), "--lobby-url", base],
        cwd=str(ROOT), env=env,
        stdout=open(ROOT / "tmp" / "ob-proof-qa.log", "w", encoding="utf-8"),
        stderr=subprocess.STDOUT,
    )
    try:
        for _ in range(120):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{qa_port}/plugin.js", timeout=1) as resp:
                    if resp.status == 200:
                        break
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ConnectionError):
                pass
            if qa.poll() is not None:
                raise RuntimeError(f"QA server exited early: {qa.poll()}")
            await asyncio.sleep(0.25)
        else:
            raise RuntimeError("QA server did not come up in time")
    except BaseException:
        qa.terminate()
        await runner.cleanup()
        raise
    print(json.dumps({"lobby": base, "qa": f"http://127.0.0.1:{qa_port}/",
                      **{k: v for k, v in seeded.items() if not k.startswith("_")}}), flush=True)
    try:
        # Keep the live bot table's move clock fresh so the janitor does not
        # forfeit a table the passport proof is pointing at.
        while True:
            for room_id in list(app.rooms.turn_since):
                app.rooms.turn_since[room_id] = time.time() + 3600
            await asyncio.sleep(3)
    finally:
        for sock in seeded.get("_sockets", ()):
            await sock.close()
        qa.terminate()
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
