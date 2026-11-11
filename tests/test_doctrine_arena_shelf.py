"""The shelf must find Doctrine Arena the same way it finds any other game."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf.catalog import Catalog  # noqa: E402
from shelf.commands import run  # noqa: E402


def _catalog(tmp_path: Path) -> Catalog:
    return Catalog([ROOT], tmp_path / "data", {"allow_ai": True})


def test_shelf_discovers_doctrine_arena_as_a_playable_card(tmp_path: Path) -> None:
    catalog = _catalog(tmp_path)
    store = catalog.storefront()
    card = next((item for item in store["store"] if item["id"] == "doctrine-arena"), None)
    assert card is not None, "the shelf did not discover doctrine_arena/game.json"
    assert card["title"] == "Olympus Arena"
    assert card["subtitle"] == "The arena of the gods"
    assert card["kind"] == "play"
    assert catalog.has("doctrine-arena")


def test_install_then_play_reaches_a_winner_and_pictures_it(tmp_path: Path) -> None:
    catalog = _catalog(tmp_path)
    assert "library" in run(catalog, "install doctrine-arena", source="command").lower()
    text = run(catalog, "doctrine-arena play 5", source="command")
    assert "beat" in text and "Replay " in text

    pictured = catalog.picture("doctrine-arena")
    assert pictured is not None
    assert pictured["view"] == "arena"
    assert pictured["preview"] is False
    assert pictured["frames"], "a finished battle must carry a replay the UI can animate"
    assert pictured["battle_id"]
    assert pictured["combatants"][pictured["result"]["winner"]]["name"]

    saved = json.loads((tmp_path / "data" / "doctrine-arena" / "state.json").read_text(encoding="utf-8"))
    assert saved["replay"]["result"]["winner"] == pictured["result"]["winner"]
    assert saved["card"]["name"] == "Bulwark"


def test_same_seed_replays_the_same_battle_through_the_shelf(tmp_path: Path) -> None:
    catalog = _catalog(tmp_path)
    run(catalog, "install doctrine-arena", source="command")
    first = run(catalog, "doctrine-arena play 11", source="command").splitlines()[0]
    second = run(catalog, "doctrine-arena play 11", source="command").splitlines()[0]
    assert first == second


def test_a_card_can_be_set_from_a_chat_line(tmp_path: Path) -> None:
    """The key=value form survives the shelf's shlex round trip, unlike raw JSON."""
    catalog = _catalog(tmp_path)
    run(catalog, "install doctrine-arena", source="command")
    answer = run(
        catalog,
        "doctrine-arena card set name=Sniper move=flank weapon=sniper armour=light "
        "aggression=3 range=9 jink=3 focus=leader",
        source="command",
    )
    assert answer.startswith("Card set: Sniper"), answer
    pictured = catalog.picture("doctrine-arena")
    assert pictured["card"]["name"] == "Sniper"
    assert pictured["card"]["weapon"] == "sniper"

    refused = run(catalog, "doctrine-arena card set move=jump", source="command")
    assert refused.startswith("That card is not valid"), refused
    assert catalog.picture("doctrine-arena")["card"]["name"] == "Sniper"


def test_a_card_from_chat_cannot_smuggle_code_in(tmp_path: Path) -> None:
    catalog = _catalog(tmp_path)
    run(catalog, "install doctrine-arena", source="command")
    bad = run(
        catalog,
        'doctrine-arena card set {"kind":"doctrine-arena-card","schema_version":1,'
        '"name":"Cheat","move":"advance","weapon":"cannon","armour":"heavy",'
        '"aggression":5,"range":5,"jink":0,"focus":"nearest","script":"alert(1)"}',
        source="command",
    )
    assert bad.startswith("That card is not valid"), bad
    pictured = catalog.picture("doctrine-arena")
    assert pictured["card"]["name"] == "Bulwark"
