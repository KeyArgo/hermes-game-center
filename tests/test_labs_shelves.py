"""Suggestions for known games and link-out tools for making games."""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf.catalog import Catalog, known_games, makers_shelf  # noqa: E402

IDS = ["agent-hold-em", "tamahermes", "hermes-pets-all", "hermes-quest", "deskrpg"]
NOT_INSTALLED = "Not installed. Its catalog page is where Hermes installs it, after you agree."
OFF = "Installed but turned off in Hermes. Open its catalog page to turn it on or read about it."


def _home(tmp_path: Path, monkeypatch) -> Path:
    home = tmp_path / "hermes"
    (home / "plugins").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


def _api(monkeypatch, tmp_path: Path, config: dict):
    fake = types.ModuleType("fastapi")

    class APIRouter:
        def get(self, _path):
            return lambda handler: handler

        def post(self, _path):
            return lambda handler: handler

    fake.APIRouter = APIRouter
    monkeypatch.setitem(sys.modules, "fastapi", fake)
    spec = importlib.util.spec_from_file_location("labs_plugin_api", ROOT / "dashboard" / "plugin_api.py")
    assert spec and spec.loader
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    monkeypatch.setattr(api, "_data_root", lambda: tmp_path / "data")
    monkeypatch.setattr(api, "_config", lambda: config)
    return api


def test_known_list_and_bad_catalog(tmp_path: Path) -> None:
    known = known_games()
    assert list(known["plugins"]) == IDS
    assert known["problems"] == []
    assert all(item["catalog"].startswith("https://") for item in known["plugins"].values())
    path = tmp_path / "known.json"
    path.write_text(json.dumps({"plugins": [
        {"plugin_id": "bad", "title": "Bad Link", "catalog": "http://example.com"},
        {"plugin_id": "good", "title": "Good", "maker": 4, "note": "  hello  "},
    ]}), encoding="utf-8")
    result = known_games(path)
    assert list(result["plugins"]) == ["good"]
    assert result["plugins"]["good"]["maker"] == ""
    assert result["plugins"]["good"]["note"] == "hello"
    assert len(result["problems"]) == 1 and "Bad Link" in result["problems"][0]


def test_nothing_installed(tmp_path: Path, monkeypatch) -> None:
    home = _home(tmp_path, monkeypatch)
    catalog = Catalog([home / "plugins"], tmp_path, {"allow_ai": True})
    cards = catalog.your_suggestions()
    assert [card["id"] for card in cards] == IDS
    assert all(card["state"] == "not-installed" and card["line"] == NOT_INSTALLED for card in cards)
    assert all("ready" not in str(card).lower() for card in cards)
    assert catalog.storefront()["your_suggestions"] == cards


def test_known_installed_and_disabled(tmp_path: Path, monkeypatch) -> None:
    home = _home(tmp_path, monkeypatch)
    for name in ("agent-hold-em", "tamahermes"):
        folder = home / "plugins" / name
        folder.mkdir()
        (folder / "plugin.yaml").write_text(f"name: {name}\n", encoding="utf-8")
    api = _api(monkeypatch, tmp_path, {"plugins": {"enabled": ["hermes-gameshelf", "agent-hold-em"]}})
    view = api.view()
    games = {card["id"]: card for card in view["your_games"]}
    suggestions = {card["id"]: card for card in view["your_suggestions"]}
    assert games["agent-hold-em"]["opens"] == "none"
    assert "agent-hold-em" not in suggestions
    assert "tamahermes" not in games
    assert suggestions["tamahermes"]["state"] == "installed-off"
    assert suggestions["tamahermes"]["line"] == OFF
    assert len(view["makers"]["items"]) == 6
    off_view = _api(monkeypatch, tmp_path, {"plugins": {"enabled": ["hermes-gameshelf"]}}).view()
    assert "tamahermes" not in {card["id"] for card in off_view["your_games"]}
    off = {card["id"]: card for card in off_view["your_suggestions"]}["tamahermes"]
    assert off["state"] == "installed-off" and off["line"] == OFF


def test_empty_catalog_uses_terminal_fallback(tmp_path: Path, monkeypatch) -> None:
    home = _home(tmp_path, monkeypatch)
    known = {"example": {"id": "example", "title": "Example", "catalog": ""}}
    card = Catalog([home / "plugins"], tmp_path, {"allow_ai": True}, known=known).your_suggestions()[0]
    assert card["catalog"] == ""
    assert card["line"] == "Not installed. Read about it in your terminal with hermes plugins search."


def test_makers_list_and_invalid_items(tmp_path: Path) -> None:
    shelf = makers_shelf()
    assert shelf["problems"] == []
    assert [item["id"] for item in shelf["items"]] == [
        "game-dev", "gameforge", "godot-studio", "game-editor", "csharp-game-editor", "pixel-art",
    ]
    assert [item["kind"] for item in shelf["items"]] == ["plugin"] * 5 + ["skill"]
    assert all(item["url"].startswith("https://") for item in shelf["items"])
    assert "not affiliated" in shelf["notice"]
    good = {"id": "good", "title": "Good", "maker": "Ada", "summary": "A tool", "kind": "plugin", "url": "https://example.com"}
    items = [good, dict(good, id="bad-url", title="Bad URL", url="http://example.com"),
             dict(good, title="Duplicate"), dict(good, id="kind", title="Bad Kind", kind="other"),
             dict(good, id="summary", title="No Summary", summary="")]
    path = tmp_path / "makers.json"
    path.write_text(json.dumps({"items": items}), encoding="utf-8")
    result = makers_shelf(path)
    assert [item["id"] for item in result["items"]] == ["good"]
    assert len(result["problems"]) == 4
    assert all(any(name in note for note in result["problems"]) for name in ("Bad URL", "Duplicate", "Bad Kind", "No Summary"))
    missing = makers_shelf(tmp_path / "missing.json")
    assert missing["items"] == [] and len(missing["problems"]) == 1
