"""The server doctor reads a lobby database and never writes it.

The database is one the server's own store built. The staff page is the same
report, and it answers 401 until both keys are present.
"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import time
from pathlib import Path

from online.doctor import collect, open_readonly, render_html, render_text
from online.store import Store

ROOT = Path(__file__).resolve().parents[1]
PHRASE = "secret-phrase-do-not-print"


def _built(tmp_path: Path):
    """A temp database from Store, with one quiet room, one fresh room, and a chat line."""
    store = Store(tmp_path / "online.sqlite3")
    ada, _token = store.create_player("Ada")
    bea, _bea = store.create_player("Bea")
    quiet = store.create_room("connect4", ada["id"], True)
    fresh = store.create_room("chessboard", bea["id"], False)
    now = time.time()
    store.db.execute("UPDATE rooms SET active = ?, created = ? WHERE id = ?",
                     (now - 3 * 3600, now - 5 * 3600, quiet["id"]))
    store.db.execute("UPDATE players SET seen = ? WHERE id = ?", (now - 30, ada["id"]))
    store.db.execute("UPDATE players SET seen = ? WHERE id = ?", (now - 2 * 3600, bea["id"]))
    store.save_availability(ada["id"], True, {"connect4": True}, now)
    store.set_looking(ada["id"], ["connect4"], now)
    store.create_play_request(ada["id"], bea["id"], "connect4", now, seconds=60)
    store.add_chat(quiet["id"], ada["id"], "Ada", "player", PHRASE)
    room_dir = tmp_path / "rooms" / quiet["id"]
    room_dir.mkdir(parents=True)
    (room_dir / "state.json").write_text(json.dumps({
        "status": "win",
        "white": "human",
        "white_name": "Ada",
        "black": "human",
        "black_name": "Bea",
    }), encoding="utf-8")
    store.close()
    return quiet, fresh, now


def test_doctor_reads_a_store_database_and_does_not_write(tmp_path):
    quiet, fresh, now = _built(tmp_path)
    path = tmp_path / "online.sqlite3"
    before = path.read_bytes()
    report = collect(path, now=now + 5)
    assert path.read_bytes() == before

    conn = open_readonly(path)
    try:
        try:
            conn.execute("CREATE TABLE doctor_must_not_write (id INTEGER)")
        except sqlite3.OperationalError:
            refused = True
        else:
            refused = False
    finally:
        conn.close()
    assert refused, "a doctor connection must refuse a write"

    rooms = {room["id"]: room for room in report["rooms"]}
    assert quiet["id"] in rooms and fresh["id"] in rooms
    old = rooms[quiet["id"]]
    assert old["game"] == "connect4"
    assert old["host_name"] == "Ada"
    assert old["idle_seconds"] >= 3 * 3600 - 10
    assert old["finished_open"] is True
    assert old["status"] == "win"
    assert {seat["name"] for seat in old["seats"]} == {"Ada", "Bea"}
    assert rooms[fresh["id"]]["would_sweep"] is False
    assert [room["id"] for room in report["would_sweep"]] == [quiet["id"]]

    assert report["presence"]["source"] == "recent"
    assert [person["name"] for person in report["presence"]["players"]] == ["Ada"]

    assert report["looking"][0]["name"] == "Ada"
    assert report["looking"][0]["game"] == "connect4"
    assert report["availability"][0]["open"] is True
    assert "connect4" in report["availability"][0]["games"]
    assert report["requests"][0]["from_name"] == "Ada"
    assert report["requests"][0]["to_name"] == "Bea"
    assert report["requests"][0]["game"] == "connect4"

    assert report["chat"] and "text" not in report["chat"][0]
    blob = json.dumps(report) + render_text(report) + render_html(report)
    assert PHRASE not in blob
    assert report["chat"][0]["name"] == "Ada"
    assert report["counts"]["open_rooms"] == 2
    assert report["counts"]["would_sweep"] == 1
    assert report["counts"]["chat"] == 1

    text = render_text(report)
    assert "host=Ada" in text
    assert "finished_open=yes" in text
    assert "rooms that would be swept:" in text
    assert quiet["id"] in text


def test_doctor_cli_prints_json(tmp_path):
    quiet, _fresh, _now = _built(tmp_path)
    proc = subprocess.run(
        ["python3", "-m", "online.doctor", "--db", str(tmp_path / "online.sqlite3"), "--json"],
        cwd=ROOT, capture_output=True, text=True, check=False,
    )
    assert proc.returncode == 0, proc.stderr
    body = json.loads(proc.stdout)
    assert quiet["id"] in {room["id"] for room in body["rooms"]}
    assert PHRASE not in proc.stdout


def test_doctor_script_says_how_to_set_the_ssh_target():
    script = ROOT / "tools" / "gc-server-doctor.sh"
    text = script.read_text(encoding="utf-8")
    assert "GC_SERVER_SSH" in text
    assert "/opt/gameshelf-online/app" in text
    assert "journalctl -u gameshelf-online" in text
    env = os.environ.copy()
    env.pop("GC_SERVER_SSH", None)
    proc = subprocess.run(["bash", str(script)], cwd=ROOT, env=env, capture_output=True, text=True)
    assert proc.returncode == 2
    assert "GC_SERVER_SSH" in proc.stderr


def test_doctor_page_is_staff_only(tmp_path):
    import asyncio

    from aiohttp.test_utils import TestClient, TestServer

    from online.rooms import load_games
    from online.server import App
    from online.store import token_hash

    async def scenario():
        server = App(tmp_path / "live", games=load_games())
        client = TestClient(TestServer(server.build()))
        await client.start_server()
        try:
            response = await client.post("/api/session", json={"name": "Ada"})
            body = await response.json()
            token = body["token"]
            server.store.set_staff(body["player"]["id"], "owner", token_hash("owner-key"), "test")
            room = server.store.create_room("connect4", body["player"]["id"], True)
            server.store.add_chat(room["id"], body["player"]["id"], "Ada", "player", PHRASE)
            import logging
            logging.getLogger("gameshelf.online").warning("doctor-sample-error")

            bare = await client.get("/admin/doctor")
            assert bare.status == 401
            only_account = await client.get("/admin/doctor", headers={"Authorization": f"Bearer {token}"})
            assert only_account.status == 401
            wrong = await client.get(
                "/admin/doctor",
                headers={"Authorization": f"Bearer {token}", "X-Staff-Key": "nope"},
            )
            assert wrong.status == 401

            page = await client.get(
                "/admin/doctor",
                headers={"Authorization": f"Bearer {token}", "X-Staff-Key": "owner-key"},
            )
            assert page.status == 200
            html = await page.text()
            assert "connect4" in html
            assert "doctor-sample-error" in html
            assert PHRASE not in html
            assert "Who is connected" in html

            data = await client.get(
                "/api/admin/doctor",
                headers={"Authorization": f"Bearer {token}", "X-Staff-Key": "owner-key"},
            )
            assert data.status == 200
            payload = await data.json()
            assert payload["counts"]["open_rooms"] == 1
            assert PHRASE not in json.dumps(payload)
            assert any(row["message"] == "doctor-sample-error" for row in payload["errors"])
        finally:
            await client.close()

    asyncio.run(scenario())
