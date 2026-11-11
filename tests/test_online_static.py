"""The web lobby's own files load: index, app.js, style.css and the SDK shim all come back
with their bodies, so the page never sticks on "Loading Game Center…"."""
from __future__ import annotations

import asyncio

from test_online_server import started


def test_static_files_are_served(tmp_path):
    async def scenario():
        _, client = await started(tmp_path)
        try:
            for path, kind in [("/app.js", "javascript"), ("/sdk-shim.js", "javascript"), ("/style.css", "css"), ("/hall.css", "css")]:
                response = await client.get(path)
                assert response.status == 200, (path, response.status)
                assert kind in response.headers.get("Content-Type", ""), (path, response.headers.get("Content-Type"))
                assert len(await response.read()) > 0, path
            home = await client.get("/")
            assert home.status == 200 and "app.js" in await home.text()
        finally:
            await client.close()

    asyncio.run(scenario())
