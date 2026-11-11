"""Arcade shelf: listing, warning labels, and "Remove my game" with repo proof."""
from pathlib import Path
import asyncio
import json
import sys
import time

from aiohttp.test_utils import TestClient, TestServer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from online import arcade  # noqa: E402
from online.rooms import load_games  # noqa: E402
from online.server import App  # noqa: E402

LOADED = load_games()
TILES = [
    {"id": "hub", "title": "Hub", "by": "a", "url": "https://hub.example/", "repo": "", "featured": True,
     "listed": True, "label": "wip", "warning": arcade.LABELS["wip"], "blurb": "", "facts": []},
    {"id": "fighter", "title": "Fighter", "by": "a", "url": "https://a.example/", "repo": "a/fighter",
     "featured": False, "listed": True, "label": "prototype", "warning": arcade.LABELS["prototype"], "blurb": "", "facts": []},
    {"id": "secret", "title": "Not yet", "by": "b", "url": "https://b.example/", "repo": "b/x",
     "featured": False, "listed": False, "label": "wip", "warning": arcade.LABELS["wip"], "blurb": "", "facts": []},
]


def run(coro):
    return asyncio.run(coro)


async def started(tmp_path, repo_files):
    async def fetcher(repo):
        return list(repo_files.get(repo, []))

    server = App(tmp_path, games=LOADED, arcade_tiles=[dict(t) for t in TILES], proof_fetcher=fetcher)
    client = TestClient(TestServer(server.build()))
    await client.start_server()
    return server, client


async def shelf(client):
    response = await client.get("/api/arcade")
    assert response.status == 200
    return [tile["id"] for tile in (await response.json())["tiles"]]


def test_shipped_catalog_is_valid():
    raw = json.loads(arcade.CATALOG.read_text())
    tiles = arcade.load()
    assert len(tiles) == len(raw["tiles"])
    assert sum(t["featured"] and t["listed"] for t in tiles) == 1
    assert all(t["url"].startswith("https://") and t["warning"] for t in tiles)


def test_bad_entries_are_skipped(tmp_path):
    path = tmp_path / "a.json"
    path.write_text(json.dumps({"tiles": [None, {"id": "x", "url": "http://plain"}, {"id": "ok", "url": "https://ok", "repo": "bad repo"},
                                          {"id": "good", "url": "https://ok", "label": "weird"}]}))
    tiles = arcade.load(path)
    assert [t["id"] for t in tiles] == ["good"] and tiles[0]["label"] == "wip"
    path.write_text("[]")
    assert arcade.load(path) == []


def test_unlisted_hidden_and_labels(tmp_path):
    async def body():
        server, client = await started(tmp_path, {})
        try:
            response = await client.get("/api/arcade")
            tiles = (await response.json())["tiles"]
            assert [t["id"] for t in tiles] == ["hub", "fighter"]
            assert "listed" not in tiles[0]
            assert tiles[1]["warning"].startswith("Early prototype")
        finally:
            await client.close()
    run(body())


def test_removal_needs_exact_repo_then_proof(tmp_path):
    files = {}

    async def body():
        server, client = await started(tmp_path, files)
        try:
            wrong = await client.post("/api/arcade/remove", json={"id": "fighter", "repo": "a/other"})
            assert wrong.status == 400
            assert await shelf(client) == ["hub", "fighter"]
            nohub = await client.post("/api/arcade/remove", json={"id": "hub", "repo": "x/y"})
            assert nohub.status == 400
            unlisted = await client.post("/api/arcade/remove", json={"id": "secret", "repo": "b/x"})
            assert unlisted.status == 404

            ok = await client.post("/api/arcade/remove", json={"id": "fighter", "repo": " https://github.com/A/Fighter/ "})
            assert ok.status == 200
            ticket = await ok.json()
            assert ticket["code"].startswith("hermes-remove-") and not ticket["proven"]
            assert await shelf(client) == ["hub"]
            again = await (await client.post("/api/arcade/remove", json={"id": "fighter", "repo": "a/fighter"})).json()
            assert again["code"] == ticket["code"]

            check = await (await client.post("/api/arcade/check", json={"id": "fighter"})).json()
            assert check["proven"] is False
            files["a/fighter"] = ["# Fighter\n", f"remove: {ticket['code']}\n"]
            check = await (await client.post("/api/arcade/check", json={"id": "fighter"})).json()
            assert check["proven"] is True
            assert server.store.removal("fighter")["proven"] == 1
        finally:
            await client.close()
    run(body())


def test_unproven_removal_lapses(tmp_path):
    async def body():
        server, client = await started(tmp_path, {})
        try:
            await client.post("/api/arcade/remove", json={"id": "fighter", "repo": "a/fighter"})
            assert await shelf(client) == ["hub"]
            server.store.expire_removals(time.time() + 1)
            assert await shelf(client) == ["hub", "fighter"]
        finally:
            await client.close()
    run(body())


def test_proven_removal_never_lapses(tmp_path):
    async def body():
        server, client = await started(tmp_path, {})
        try:
            await client.post("/api/arcade/remove", json={"id": "fighter", "repo": "a/fighter"})
            server.store.prove_removal("fighter", server.store.removal("fighter")["code"])
            server.store.expire_removals(time.time() + 10 ** 9)
            assert await shelf(client) == ["hub"]
        finally:
            await client.close()
    run(body())


def test_removal_rate_limited(tmp_path):
    async def body():
        server, client = await started(tmp_path, {})
        try:
            codes = [(await client.post("/api/arcade/remove", json={"id": "fighter", "repo": "nope/nope"})).status for _ in range(11)]
            assert codes[:10] == [400] * 10 and codes[10] == 429
        finally:
            await client.close()
    run(body())


def test_owner_gets_code_back_by_repo_after_tile_is_hidden(tmp_path):
    async def body():
        server, client = await started(tmp_path, {})
        try:
            first = await (await client.post("/api/arcade/remove", json={"id": "fighter", "repo": "a/fighter"})).json()
            assert await shelf(client) == ["hub"]
            again = await client.post("/api/arcade/remove", json={"repo": "a/fighter"})
            assert again.status == 200
            again = await again.json()
            assert again["code"] == first["code"] and again["id"] == "fighter"
            missing = await client.post("/api/arcade/remove", json={"repo": "b/x"})
            assert missing.status == 404
        finally:
            await client.close()
    run(body())


def test_stale_code_does_not_prove_a_new_request(tmp_path):
    async def body():
        server, client = await started(tmp_path, {})
        try:
            old = await (await client.post("/api/arcade/remove", json={"id": "fighter", "repo": "a/fighter"})).json()
            server.store.expire_removals(time.time() + 1)
            new = await (await client.post("/api/arcade/remove", json={"id": "fighter", "repo": "a/fighter"})).json()
            assert new["code"] != old["code"]
            server.store.prove_removal("fighter", old["code"])
            assert server.store.removal("fighter")["proven"] == 0
        finally:
            await client.close()
    run(body())


def test_proof_read_in_chunks():
    class Content:
        def __init__(self, parts):
            self.parts = list(parts)

        async def read(self, n):
            return self.parts.pop(0) if self.parts else b""

    class Response:
        status = 200

        def __init__(self):
            self.content = Content([b"start ", b"middle ", b"hermes-remove-abcd1234"])

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    class Session:
        def get(self, url, allow_redirects=False):
            return Response()

    texts = asyncio.run(arcade.fetch_proof(Session(), "a/b"))
    assert texts and all("hermes-remove-abcd1234" in text for text in texts)
