"""Website: Learn to play (private lesson rooms, never recorded) and hints against the computer only."""
from pathlib import Path
import importlib.util
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

_spec = importlib.util.spec_from_file_location("online_server_helpers_lessons", Path(__file__).with_name("test_online_server.py"))
helpers = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(helpers)
run, started, sign_in, open_room, connect = helpers.run, helpers.started, helpers.sign_in, helpers.open_room, helpers.connect


def test_lesson_room_walks_through_and_is_never_recorded(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            cards = (await (await client.get("/api/games")).json())["games"]
            assert all(card["lesson"] for card in cards)
            ada, token = await sign_in(client, "Ada")
            made = await open_room(client, token, public=False, mode="lesson")
            a = await connect(client, made["room"]["id"], token)
            state = await a.until(lambda m: m.get("t") == "state" and m["picture"].get("lesson"))
            assert state["picture"]["lesson"]["step"] == 1 and state["picture"]["permissions"]["can_lesson"]
            assert not state["picture"]["permissions"]["can_hint"]
            assert (await a.result(1, t="cmd", action="move", args=["4"]))["ok"]
            done = await a.until(lambda m: m.get("t") == "state" and m["picture"]["status"] == "lesson_done")
            assert done["picture"]["lesson"]["note"]
            assert (await a.result(2, t="cmd", action="lesson", args=["next"]))["ok"]
            step2 = await a.until(lambda m: m.get("t") == "state" and (m["picture"].get("lesson") or {}).get("step") == 2)
            wrong = await a.result(3, t="cmd", action="move", args=["7"])
            assert "not this lesson's move" in wrong["text"]
            assert (await a.result(4, t="cmd", action="move", args=["5"]))["ok"]
            await a.until(lambda m: m.get("t") == "state" and m["picture"]["status"] == "lesson_done" and m["picture"]["plies"] == 7)
            assert server.store.db.execute("SELECT COUNT(*) FROM matches").fetchone()[0] == 0
            assert step2
            await a.ws.close()
        finally:
            await client.close()
    run(scenario())


def test_hint_only_against_the_computer(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, token = await sign_in(client, "Ada")
            vs_bot = await open_room(client, token, mode="bot")
            a = await connect(client, vs_bot["room"]["id"], token)
            state = await a.until(lambda m: m.get("t") == "state")
            assert state["picture"]["permissions"]["can_hint"]
            hint = await a.result(1, t="cmd", action="hint")
            assert hint["ok"] and hint["text"].startswith("Hint: try ")
            await a.ws.close()
            two = await open_room(client, token)
            a = await connect(client, two["room"]["id"], token)
            state = await a.until(lambda m: m.get("t") == "state")
            assert not state["picture"]["permissions"]["can_hint"]
            refused = await a.result(2, t="cmd", action="hint")
            assert not refused["ok"]
            # Only the host starts a lesson.
            bea, bea_token = await sign_in(client, "Bea")
            b = await connect(client, two["room"]["id"], bea_token)
            no = await b.result(3, t="cmd", action="lesson")
            assert not no["ok"]
            for seat in (a, b):
                await seat.ws.close()
        finally:
            await client.close()
    run(scenario())
