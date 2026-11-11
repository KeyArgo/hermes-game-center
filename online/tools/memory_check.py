"""Measure the server's memory with N simulated clients.

Start the server, then:

    python memory_check.py --base http://127.0.0.1:8790 --pid <server pid> --clients 20

It makes N players, opens one public table, keeps N WebSockets signed in for a while while
polling the lobby, and prints the server's VmRSS before, at peak and after. No dependencies
beyond aiohttp.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import secrets

import aiohttp


def rss_kb(pid: int) -> int:
    try:
        with open(f"/proc/{pid}/status", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1])
    except OSError:
        return 0
    return 0


async def api(session: aiohttp.ClientSession, method: str, path: str, *, token: str = "",
              body: dict | None = None) -> dict:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    async with session.request(method, path, headers=headers, json=body) as response:
        data = await response.json()
        if response.status >= 400:
            raise RuntimeError(f"{method} {path}: {response.status} {data}")
        return data


async def hold(base: str, pid: int, clients: int, seconds: float) -> int:
    suffix = secrets.token_hex(3)
    peak = rss_kb(pid)
    async with aiohttp.ClientSession(base_url=base) as session:
        tokens = []
        for index in range(clients):
            made = await api(session, "POST", "/api/session", body={"name": f"Load {suffix} {index}"})
            tokens.append(made["token"])
        room = (await api(session, "POST", "/api/rooms", token=tokens[0],
                          body={"game": "connect4", "public": True}))["room"]
        sockets = []
        for token in tokens:
            ws = await session.ws_connect(f"{base.replace('http', 'ws', 1)}/ws/{room['id']}", heartbeat=25)
            await ws.send_json({"t": "auth", "token": token})
            sockets.append(ws)
        stop = asyncio.get_running_loop().time() + seconds
        while asyncio.get_running_loop().time() < stop:
            await api(session, "GET", "/api/lobby")
            await asyncio.sleep(1.0)
            peak = max(peak, rss_kb(pid))
        for ws in sockets:
            await ws.close()
        await asyncio.sleep(2)
    return peak


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", default="http://127.0.0.1:8790")
    parser.add_argument("--pid", type=int, required=True, help="server process id")
    parser.add_argument("--clients", type=int, default=20)
    parser.add_argument("--seconds", type=float, default=30.0)
    options = parser.parse_args()
    before = rss_kb(options.pid)
    peak = asyncio.run(hold(options.base.rstrip("/"), options.pid, options.clients, options.seconds))
    after = rss_kb(options.pid)
    print(json.dumps({
        "clients": options.clients,
        "before_mb": round(before / 1024, 1),
        "peak_mb": round(peak / 1024, 1),
        "after_mb": round(after / 1024, 1),
        "delta_mb": round((peak - before) / 1024, 1),
    }, indent=2))


if __name__ == "__main__":
    main()
