"""Play one real rated bot-versus-bot ladder game and print both career records.

Two different owners each make a bot, one bot challenges the other, both run the tiny
``example_bot.py`` player over WebSockets, and the server records the rated result. Run it
against a local server:

    python ladder_demo.py --base http://127.0.0.1:8790 --game connect4

Needs aiohttp (already needed by the server). Nothing is executed on the server.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import secrets

import aiohttp

from example_bot import ExampleBot


async def api(session: aiohttp.ClientSession, method: str, path: str, *, token: str = "",
              body: dict | None = None) -> dict:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    async with session.request(method, path, headers=headers, json=body) as response:
        data = await response.json()
        if response.status >= 400:
            raise RuntimeError(f"{method} {path}: {response.status} {data}")
        return data


async def make_player(session: aiohttp.ClientSession, name: str) -> tuple[dict, str]:
    made = await api(session, "POST", "/api/session", body={"name": name})
    return made["player"], made["token"]


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", default="http://127.0.0.1:8790")
    parser.add_argument("--game", default="connect4")
    parser.add_argument("--delay", type=float, default=0.02)
    options = parser.parse_args()
    base = options.base.rstrip("/")
    suffix = secrets.token_hex(3)
    async with aiohttp.ClientSession(base_url=base) as session:
        owner_a, token_a = await make_player(session, f"Ladder A {suffix}")
        owner_b, token_b = await make_player(session, f"Ladder B {suffix}")
        bot_a = await api(session, "POST", "/api/bots", token=token_a, body={"name": f"Demo A {suffix}"})
        bot_b = await api(session, "POST", "/api/bots", token=token_b, body={"name": f"Demo B {suffix}"})
        challenge = await api(session, "POST", "/api/ladder", token=bot_a["key"],
                              body={"game": options.game, "opponent": bot_b["bot"]["id"]})
        room = challenge["room"]["id"]
        print(f"room {room}: {bot_a['bot']['name']} (white) vs {bot_b['bot']['name']} (black), "
              f"rated={challenge['rated']}", flush=True)
        results = await asyncio.gather(
            ExampleBot(base, bot_a["key"], room, delay=options.delay).play(),
            ExampleBot(base, bot_b["key"], room, delay=options.delay).play(),
            return_exceptions=True,
        )
        for result in results:
            if isinstance(result, Exception):
                raise result
        for bot in (bot_a["bot"], bot_b["bot"]):
            career = await api(session, "GET", f"/api/bots/{bot['id']}")
            record = career["career"]
            print(json.dumps({
                "bot": record["bot"]["name"],
                "games": record["games"],
                "history": record["history"][:3],
                "opponents": record["opponents"][:2],
            }, indent=2), flush=True)
        leaderboard = await api(session, "GET", f"/api/leaderboard?game={options.game}&pool=bots")
        names = [row["name"] for row in leaderboard["rows"]]
        print("bot leaderboard:", names, flush=True)
        if bot_a["bot"]["name"] not in names or bot_b["bot"]["name"] not in names:
            raise SystemExit("the rated bots are missing from the bot leaderboard")


if __name__ == "__main__":
    asyncio.run(main())
