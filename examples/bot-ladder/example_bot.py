"""A tiny Game Center bot: connect with a bot key and play one legal move at a time.

It is deliberately small. Copy it, replace ``choose`` with your own strategy (or ask your
model), and keep the bot key secret. Bots always run on their owner's machine; the server
never runs your code.

    python example_bot.py --base http://127.0.0.1:8790 --key BOTKEY --room ROOMID

See docs/BOT-API.md for the protocol.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random

import aiohttp


def choose(picture: dict) -> str:
    """Pick one move token from picture["legal"]. Replace this with something clever."""
    return random.choice(picture["legal"])


class ExampleBot:
    def __init__(self, base: str, key: str, room: str, *, delay: float = 0.02) -> None:
        self.base = base.rstrip("/")
        self.key = key
        self.room = room
        self.delay = delay
        self.done: asyncio.Future | None = None

    def socket_url(self) -> str:
        scheme = "wss" if self.base.startswith("https://") else "ws"
        host = self.base.split("://", 1)[-1]
        return f"{scheme}://{host}/ws/{self.room}"

    async def play(self) -> dict:
        """Connect, play until the match ends, and return the last picture seen."""
        last: dict = {}
        played = -1
        ref = 0
        async with aiohttp.ClientSession() as session:
            async with session.ws_connect(self.socket_url(), heartbeat=25) as ws:
                await ws.send_json({"t": "auth", "token": self.key})
                async for raw in ws:
                    if raw.type != aiohttp.WSMsgType.TEXT:
                        break
                    message = json.loads(raw.data)
                    kind = message.get("t")
                    if kind in {"error", "closed"}:
                        raise RuntimeError(message.get("text") or "the table refused the bot")
                    if kind != "state":
                        continue
                    picture = message.get("picture") or {}
                    last = picture
                    status = picture.get("status")
                    if status in {"win", "draw", "resigned"}:
                        return picture
                    legal = picture.get("legal") or []
                    perms = picture.get("permissions") or {}
                    if perms.get("can_move") and legal and picture.get("plies") != played:
                        played = picture.get("plies")
                        if self.delay:
                            await asyncio.sleep(self.delay)
                        ref += 1
                        await ws.send_json({"t": "cmd", "action": "move",
                                            "args": [choose(picture)], "ref": ref})
        return last


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", required=True, help="server address, e.g. http://127.0.0.1:8790")
    parser.add_argument("--key", required=True, help="the bot's secret key")
    parser.add_argument("--room", required=True, help="room id, from POST /api/ladder or an invite")
    options = parser.parse_args()
    picture = asyncio.run(ExampleBot(options.base, options.key, options.room).play())
    print(json.dumps({"status": picture.get("status"), "winner": picture.get("winner"),
                      "plies": picture.get("plies")}, indent=2))


if __name__ == "__main__":
    main()
