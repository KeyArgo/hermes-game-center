"""Names stick: one rename per 30 days, the old name held for its owner, word filter still applies."""
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location("online_server_helpers_names", Path(__file__).with_name("test_online_server.py"))
helpers = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(helpers)
run, started, sign_in = helpers.run, helpers.started, helpers.sign_in

from online import store as store_mod  # noqa: E402


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def test_rename_cooldown_and_old_name_held(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, token = await sign_in(client, "Ada")
            first = await client.post("/api/me", json={"name": "Adelaide"}, headers=auth(token))
            assert first.status == 200
            again = await client.post("/api/me", json={"name": "Adele"}, headers=auth(token))
            assert again.status == 429 and "30 days" in (await again.json())["error"]
            caps = await client.post("/api/me", json={"name": "ADELAIDE"}, headers=auth(token))
            assert caps.status == 200  # capitals only: free
            # Someone else cannot grab the name Ada just gave up.
            grab = await client.post("/api/session", json={"name": "ada"})
            assert grab.status == 409
            # After the wait, Ada may rename, even back to her old name.
            server.store.db.execute("UPDATE players SET renamed = ? WHERE id = ?",
                                    (time.time() - store_mod.RENAME_DAYS * 86400 - 1, ada["id"]))
            back = await client.post("/api/me", json={"name": "Ada"}, headers=auth(token))
            assert back.status == 200, await back.text()
        finally:
            await client.close()
    run(scenario())


def test_old_name_frees_up_after_the_hold(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, token = await sign_in(client, "Ada")
            await client.post("/api/me", json={"name": "Adelaide"}, headers=auth(token))
            server.store.db.execute("UPDATE old_names SET until = ?", (time.time() - 1,))
            bea = await client.post("/api/session", json={"name": "Ada"})
            assert bea.status == 200
        finally:
            await client.close()
    run(scenario())


def test_rude_names_still_refused(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            bad = await client.post("/api/session", json={"name": "s h i t head"})
            assert bad.status == 400
        finally:
            await client.close()
    run(scenario())
