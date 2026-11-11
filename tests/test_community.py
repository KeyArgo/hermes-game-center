"""The Community shelf: link-out cards only, https only, and nothing loaded from those sites."""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf.catalog import community_games  # noqa: E402

LIST = ROOT / "community" / "games.json"
PAGE = ROOT / "desktop" / "plugin.js"

EXPECTED = [
    ("nous-hermes-arcade", "Nous Hermes Arcade", "123mikeyd", "https://hermesarcade.123mikeyd.com/", "web"),
    ("nrcu-platform-fighter", "The Legends of Nous Research", "123mikeyd", "https://123mikeyd.github.io/nrcu-platform-fighter/", "web"),
    ("brother-doge", "HODL OR DIE: Brother Doge", "123mikeyd", "https://123mikeyd.github.io/Brother_Doge_VideoGame/", "web"),
    ("clawpocalypse-now", "Clawpocalypse Now", "mojomast", "https://mojomast.github.io/clawpocalypse-now/", "web"),
    ("roo-gang", "ROO GANG", "mojomast", "https://slophero.vercel.app/", "web"),
    (
        "misty-mountain",
        "Misty Mountain",
        "123mikeyd",
        "https://github.com/123mikeyd/hermes-community-care-package/releases/tag/v0.1.0-prototype",
        "download",
    ),
    ("gladiator", "Gladiator", "runtimenoteslabs", "https://runtimenotes.com/projects/gladiator/", "watch"),
]


def test_the_list_loads_the_five_community_games_and_two_that_are_not() -> None:
    shelf = community_games()
    assert shelf["problems"] == []
    assert [(game["id"], game["title"], game["creator"], game["url"]) for game in shelf["games"]] == [
        (game_id, title, creator, url) for game_id, title, creator, url, _kind in EXPECTED
    ]
    assert [game["kind"] for game in shelf["games"]] == [kind for *_rest, kind in EXPECTED]
    assert "not by Game Center or Nous" in shelf["notice"], "the shelf must say these are not ours"


def test_the_download_and_watch_cards_say_what_they_are() -> None:
    games = {game["id"]: game for game in community_games()["games"]}
    download = games["misty-mountain"]
    assert download["kind"] == "download"
    assert "does not play in the browser" in download["note"]
    assert "No licence file" in download["note"], "a project with no licence must say so on its card"
    watch = games["gladiator"]
    assert watch["kind"] == "watch"
    assert "not a game you play" in watch["note"]
    assert "MIT" in watch["note"]
    page = PAGE.read_text(encoding="utf-8")
    assert "Download page" in page and "Watch demo" in page, "the card has its own word for each kind"


def test_every_community_url_is_https() -> None:
    for game in community_games()["games"]:
        parts = urlsplit(game["url"])
        assert parts.scheme == "https", game
        assert parts.hostname, game
        assert not parts.username and not parts.password, game


def test_the_owner_decided_game_stays_off_the_shelf() -> None:
    assert "buttfights" not in [game["id"] for game in community_games()["games"]]
    listed = LIST.read_text(encoding="utf-8").lower()
    assert "buttfights" not in listed and "bumfights" not in listed


def test_a_bad_entry_is_skipped_with_a_friendly_note(tmp_path: Path) -> None:
    path = tmp_path / "games.json"
    path.write_text(
        json.dumps({
            "games": [
                {"id": "good-one", "title": "Good One", "creator": "Ada", "url": "https://example.com/play"},
                {"id": "plain-http", "title": "Plain HTTP", "creator": "Ada", "url": "http://example.com/"},
                {"id": "script-link", "title": "Script Link", "creator": "Ada", "url": "javascript:alert(1)"},
                {"id": "no-title", "creator": "Ada", "url": "https://example.com/no-title"},
                {"id": "no-creator", "title": "No Creator", "url": "https://example.com/no-creator"},
                {"id": "Bad Id", "title": "Bad Id", "creator": "Ada", "url": "https://example.com/bad"},
                {"id": "good-one", "title": "Good One Again", "creator": "Ada", "url": "https://example.com/again"},
                "just a string",
            ]
        }),
        encoding="utf-8",
    )
    shelf = community_games(path)
    assert [game["id"] for game in shelf["games"]] == ["good-one"], "one good entry survives"
    notes = " ".join(shelf["problems"])
    assert "Plain HTTP: the web address must start with https://; skipped." in notes
    assert "Script Link: the web address must start with https://; skipped." in notes
    assert "Community entry 4: it has no title; skipped." in notes
    assert "No Creator: it names no creator; skipped." in notes
    assert "Bad Id: id must be lowercase letters, digits and dashes" in notes
    assert "Good One Again: another community card already uses the id good-one; skipped." in notes
    assert "Community entry 8 is not a game; skipped." in notes


def test_a_missing_or_unreadable_list_is_a_friendly_note(tmp_path: Path) -> None:
    missing = community_games(tmp_path / "nope.json")
    assert missing["games"] == []
    assert missing["problems"] and "could not be read" in missing["problems"][0]

    broken = tmp_path / "broken.json"
    broken.write_text("{not json", encoding="utf-8")
    shelf = community_games(broken)
    assert shelf["games"] == [] and "could not be read" in shelf["problems"][0]

    empty = tmp_path / "empty.json"
    empty.write_text(json.dumps({"note": "no games yet"}), encoding="utf-8")
    shelf = community_games(empty)
    assert shelf["games"] == [] and "no games" in shelf["problems"][0]


def test_the_shelf_never_fetches_or_frames_a_community_site() -> None:
    page = PAGE.read_text(encoding="utf-8")
    assert "iframe" not in page.lower(), "a community card must never embed the site"
    assert "fetch(" not in page, "the page never fetches from a community site"
    loader = (ROOT / "shelf" / "catalog.py").read_text(encoding="utf-8")
    assert "urllib.request" not in loader and "import socket" not in loader
    assert "jsx(CommunityShelf, { community, ctx })" in page, "the Community view renders the shelf"


def _api(tmp_path: Path, monkeypatch):
    fake = types.ModuleType("fastapi")

    class APIRouter:
        def get(self, _path):
            return lambda handler: handler

        def post(self, _path):
            return lambda handler: handler

    fake.APIRouter = APIRouter  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "fastapi", fake)
    spec = importlib.util.spec_from_file_location(
        "hermes_gameshelf_community_api", ROOT / "dashboard" / "plugin_api.py"
    )
    assert spec and spec.loader
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    monkeypatch.setattr(api, "_data_root", lambda: tmp_path / "data")
    monkeypatch.setattr(api, "_config", lambda: {"plugins": {"enabled": ["hermes-gameshelf"]}})
    return api


def test_the_desktop_view_carries_the_community_shelf(tmp_path: Path, monkeypatch) -> None:
    view = _api(tmp_path, monkeypatch).view()
    assert [game["id"] for game in view["community"]["games"]] == [game[0] for game in EXPECTED]
    assert view["community"]["problems"] == []
    assert all(game["url"].startswith("https://") for game in view["community"]["games"])
    listed = [item["id"] for item in view["store"]]
    assert not set(game["id"] for game in view["community"]["games"]) & set(listed), (
        "community cards are a separate shelf, never store items"
    )
