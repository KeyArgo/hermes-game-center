"""Click every table game through in a real headless Chrome, once, in one test.

This is the automated copy of the manual browser proof: it starts the isolated
QA page (``tests/browser_table_server.py`` — the real plugin module, scratch
storage), then runs ``tools/browser_drive.mjs --tour``, which presses "Play the
computer" and plays every table game to its winner screen using only real mouse
events on the drawn board, then presses Rematch and Back. Each game must end
with a winner screen and leave a screenshot in ``test-artifacts/tg``.

Slow (minutes) and needs Chrome, so it runs only with ``--browser``; the
ordinary suite covers the same rules and state changes in-process.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "test-artifacts" / "tg"
GAMES = [
    ("Connect Four", "connect4"), ("Reversi", "reversi"), ("Gomoku", "gomoku"),
    ("Hex", "hex"), ("Go", "go"), ("Checkers", "checkers"), ("Chess", "chess"),
    ("Breakthrough", "breakthrough"), ("Kalah", "kalah"),
]

pytestmark = pytest.mark.browser


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def chrome() -> str:
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
        found = shutil.which(name)
        if found:
            return found
    return ""


def wait_for_page(port: int, seconds: float = 90) -> bool:
    import urllib.request

    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2) as answer:
                if answer.status == 200:
                    return True
        except Exception:
            time.sleep(1)
    return False


@pytest.mark.skipif(not chrome(), reason="no Chrome on this machine")
@pytest.mark.skipif(not shutil.which("node"), reason="no node on this machine")
def test_every_table_game_is_played_to_a_winner_screen_by_clicking(tmp_path):
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    port = free_port()
    root = tmp_path / "table"
    # The QA server's own dependencies live in the uv cache; the plugin itself adds none.
    server_cmd = [
        "uv", "run", "--python", "3.13", "--with", "fastapi", "--with", "uvicorn",
        "python", str(ROOT / "tests" / "browser_table_server.py"),
        "--root", str(root), "--port", str(port),
    ]
    env = dict(os.environ)
    # The QA server logs every request. Piping that into a buffer nobody reads deadlocks the
    # whole page once the pipe fills: the server blocks in write() and stops answering
    # requests, which looks exactly like a frozen game. Write to a file and show it on failure.
    log_path = tmp_path / "qa-server.log"
    log = log_path.open("w", encoding="utf-8")
    server = subprocess.Popen(server_cmd, cwd=str(ROOT), env=env,
                              stdout=log, stderr=subprocess.STDOUT, text=True)
    try:
        assert wait_for_page(port), "the isolated QA page never came up"
        run = subprocess.run(
            ["node", str(ROOT / "tools" / "browser_drive.mjs"),
             "--url", f"http://127.0.0.1:{port}/", "--out", str(ARTIFACTS), "--tour"],
            cwd=str(ROOT), capture_output=True, text=True, timeout=5400,
        )
        assert run.returncode == 0, run.stdout[-4000:] + run.stderr[-4000:]
        board = json.loads((ARTIFACTS / "drive-results.json").read_text())
        played = {row["game"]: row for row in board["results"] if row.get("game")}
        for title, slug in GAMES:
            assert title in played, f"{title} was never opened: {sorted(played)}"
            row = played[title]
            assert not row.get("error"), f"{title} failed: {row['error']}"
            assert row.get("opened") == title, (
                f"{title}: the driver opened {row.get('opened')!r} instead — a title substring matched the wrong card"
            )
            assert row.get("over") is True, f"{title} did not reach a winner screen: {row}"
            assert row.get("moves", 0) > 0, f"{title} finished without a single board press"
            assert row.get("backHit", {}).get("under") == "Back", (
                f"{title}: Back was not the element under the pointer with More options open: {row.get('backHit')}"
            )
            shot = ARTIFACTS / f"{slug}-4-winner.png"
            assert shot.is_file() and shot.stat().st_size > 5000, f"{title} left no winner screenshot"
        # The other two screens on the shelf: the Doctrine board runs a battle and comes back,
        # and Play a friend offers the online route and pass-and-play without leaving the page.
        screens = {row.get("screen"): row for row in board["results"] if row.get("screen")}
        for title in ("Doctrine", "Doctrine Arena"):
            row = screens.get(title)
            assert row, f"{title} was never opened: {sorted(screens)}"
            assert not row.get("error"), f"{title} failed: {row['error']}"
            assert row.get("ran") is True, f"{title}: the battle never started: {row}"
            assert row.get("back") is True, f"{title}: Back did not return to the shelf: {row}"
            shot = ARTIFACTS / f"{'doctrine' if title == 'Doctrine' else 'arena'}-2-battle.png"
            assert shot.is_file() and shot.stat().st_size > 5000, f"{title} left no battle screenshot"
        friend = screens.get("friend")
        assert friend and not friend.get("error"), f"Play a friend failed: {friend}"
        assert friend.get("online") is True and friend.get("shared") is True, (
            f"Play a friend did not offer both routes: {friend}"
        )
    finally:
        server.terminate()
        try:
            server.wait(timeout=20)
        except subprocess.TimeoutExpired:
            server.kill()
        log.close()
        if server.returncode not in (0, -15) and not (ARTIFACTS / "drive-results.json").is_file():
            sys.stdout.write(log_path.read_text(encoding="utf-8", errors="replace")[-4000:])
    sys.stdout.write(f"clicked every game; screenshots in {ARTIFACTS}\n")
