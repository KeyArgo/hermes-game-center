#!/usr/bin/env python3
"""Play every game to the end through the dashboard API — the same path the Desktop page uses.

Not a unit test: a smoke run that answers "can a person actually finish a game".
Run:  python3 -u tools/playthrough.py
Exit code 0 when every game reached a terminal status in every mode it supports.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import time
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GAMES = ["connect4", "reversi", "checkers", "breakthrough", "gomoku", "kalah", "chessboard", "go", "hex"]
TERMINAL = {"win", "draw"}
MAX_PLIES = 300


def load_api(data_root: Path):
    """Import dashboard/plugin_api.py with a stub fastapi, pointed at a temp data dir."""
    fake = types.ModuleType("fastapi")

    class APIRouter:
        def get(self, _path):
            return lambda handler: handler

        def post(self, _path):
            return lambda handler: handler

    fake.APIRouter = APIRouter  # type: ignore[attr-defined]
    sys.modules["fastapi"] = fake
    spec = importlib.util.spec_from_file_location("playthrough_api", ROOT / "dashboard" / "plugin_api.py")
    assert spec and spec.loader
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    api._data_root = lambda: data_root  # type: ignore[assignment]
    api._config = lambda: {"plugins": {"enabled": ["hermes-gameshelf"]}}  # type: ignore[assignment]
    return api


def say(api, line: str) -> tuple[bool, str]:
    """One /games line, exactly as the page sends it. The API's own `ok` is the truth."""
    answer = api.command({"line": line})
    return bool(answer.get("ok")), str(answer.get("text") or "")


def picture(api, game: str) -> dict:
    return api.board(game)["picture"] or {}


def play_until_over(api, game: str) -> dict:
    """Send one legal move at a time from the picture the page would draw, until it ends."""
    for _ in range(MAX_PLIES):
        board = picture(api, game)
        status = board.get("status")
        if status in TERMINAL:
            return {"status": status, "plies": board.get("plies", 0)}
        if status in {"idle", None}:
            return {"status": f"NOT STARTED ({status})", "plies": 0}
        legal = board.get("legal") or []
        if not legal:
            return {"status": "STUCK (no legal moves)", "plies": board.get("plies", 0), "detail": str(status)}
        ok, text = say(api, f"{game} move {legal[len(legal) // 2]}")
        if not ok:
            return {"status": "MOVE REFUSED", "plies": board.get("plies", 0), "detail": text[:70]}
    return {"status": "DID NOT END", "plies": MAX_PLIES}


def play_human_vs_bot(api, game: str) -> dict:
    say(api, f"{game} abandon")
    say(api, f"install {game}")
    ok, text = say(api, f"{game} new white=human black=local")
    result = play_until_over(api, game)
    result["mode"] = "human vs bot"
    if not ok and result["status"].startswith("NOT STARTED"):
        result["detail"] = text[:70]
    return result


def play_two_humans(api, game: str) -> dict:
    say(api, f"{game} abandon")
    say(api, f"install {game}")
    ok, text = say(api, f"{game} new white=human black=human")
    result = play_until_over(api, game)
    result["mode"] = "two humans"
    if not ok and result["status"].startswith("NOT STARTED"):
        result["detail"] = text[:70]
    return result


def play_bots(api, game: str) -> dict:
    say(api, f"{game} abandon")
    say(api, f"install {game}")
    ok, text = say(api, f"{game} allow-ai white=local black=local")
    if not ok:
        return {"mode": "bot vs bot", "status": "START FAILED", "plies": 0, "detail": text[:70]}
    for step in range(MAX_PLIES):
        board = picture(api, game)
        if board.get("status") in TERMINAL:
            return {"mode": "bot vs bot", "status": board["status"], "plies": board.get("plies", 0)}
        ok, text = say(api, f"{game} step")
        if not ok:
            return {"mode": "bot vs bot", "status": "STEP REFUSED", "plies": step, "detail": text[:70]}
    return {"mode": "bot vs bot", "status": "DID NOT END", "plies": MAX_PLIES}


def main() -> int:
    data_root = Path(tempfile.mkdtemp(prefix="gameshelf-playthrough-"))
    api = load_api(data_root)
    ok, text = say(api, "name Playtester")
    if not ok:
        print("could not name the test player:", text, flush=True)
        return 1
    rows, failures = [], 0
    for game in GAMES:
        for run in (play_human_vs_bot, play_two_humans, play_bots):
            started = time.time()
            try:
                result = run(api, game)
            except Exception as error:  # a crash is a result, not a stack trace on the floor
                result = {"mode": run.__name__, "status": f"CRASH {type(error).__name__}", "plies": 0,
                          "detail": str(error)[:60]}
            result.update(game=game, secs=round(time.time() - started, 1))
            failures += result["status"] not in TERMINAL
            rows.append(result)
            print(f"{game:11s} {result['mode']:13s} {result['status']:22s} "
                  f"plies={result['plies']:<4} {result['secs']:>5.1f}s {result.get('detail', '')}", flush=True)

    print(f"\n{len(rows)} runs, {len(rows) - failures} finished, {failures} did not", flush=True)
    out = Path(tempfile.gettempdir()) / "gameshelf-playthrough.json"
    out.write_text(json.dumps(rows, indent=1))
    print("results:", out, flush=True)
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
