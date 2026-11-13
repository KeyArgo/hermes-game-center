"""Doctrine end to end: the card, the battle, watch, ladder, improve, share, profiles."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("doctrine_game_under_test", ROOT / "doctrine" / "game.py")
GAME = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(GAME)

ZERO = {
    "schema": "doctrine-card/1",
    "name": "Flawless Zero",
    "author": "test",
    "personality": "Does nothing well.",
    "weights": {key: 0 for key in GAME._module("card").WEIGHTS},
}
STRONG = {
    "schema": "doctrine-card/1",
    "name": "Probe Winner",
    "author": "test",
    "personality": "Attacks and finishes.",
    "weights": {"aggression": 100, "safety": 70, "objective": 10, "focus": 100,
                "cohesion": 50, "center": 0, "mobility": 70, "endurance": 90},
}


@pytest.fixture()
def game(tmp_path: Path) -> "GAME.Doctrine":
    return GAME.Doctrine(tmp_path)


def picture(game) -> dict:
    shown = game.picture()
    assert shown["view"] == "hex" and len(shown["cells"]) == 11
    return shown["doctrine"]


def test_idle_board_and_help(game):
    shown = picture(game)
    assert shown["mode"] == "idle" and shown["status"] == "idle"
    assert shown["your_card"]["name"] and shown["house"]
    assert "doctrine play" in game.command("help")


def test_cards_and_pick(game):
    text = game.command("cards")
    for name in ("Glass Swarm", "Iron Vanguard", "Long Game", "Stone Bastion"):
        assert name in text
    assert game.command("pick glass-swarm").startswith("Your card is now")
    assert picture(game)["your_card"]["name"] == "Glass Swarm"
    assert "No card named" in game.command("pick nobody")


def test_human_battle_by_clicking_is_deterministic(tmp_path):
    def refusals(prompt):
        raise AssertionError("a battle must never call a model")

    results = []
    for _ in range(2):
        play = GAME.Doctrine(tmp_path / "same")
        play.command("pick glass-swarm")
        play.command("play seed=3", complete=refusals)
        for _ in range(400):
            shown = play.picture()["doctrine"]
            if shown["status"] != "active":
                break
            legal = play.picture()["legal"]
            assert legal, "a human turn always offers a reachable hex"
            assert play.command(f"move {legal[0]}").strip()
        else:
            raise AssertionError("the battle never finished")
        results.append(json.dumps(play.picture()["doctrine"]["frames"], sort_keys=True))
    assert results[0] == results[1]
    assert picture(play)["status"] in {"won", "draw"}


def test_new_match_shows_spawned_units(game):
    game.command("play seed=1")
    shown = game.picture()
    marks = [mark for row in shown["cells"] for mark in row]
    assert marks.count("1") == 3 and marks.count("2") == 3, "both sides' units are on the board before the first turn"


def test_pending_cannot_send_two_units_to_one_hex(game):
    game.command("play seed=1")
    options = game.picture()["doctrine"]["legal_units"]
    first = options[sorted(options)[0]]["cells"]
    second = options[sorted(options)[1]]["cells"]
    shared = sorted(set(first) & set(second))
    if not shared:
        pytest.skip("this seed has no shared destination")
    target = shared[0]
    assert "to" in game.command(f"move {target}")
    assert "already going" in game.command(f"move {target}")
    assert "Turn played" in game.command("end") or game.picture()["doctrine"]["status"] != "active"
    assert game.picture()["doctrine"]["pending"] == {}


def test_end_turn_holds_the_rest(game):
    game.command("play seed=1")
    assert picture(game)["can_move"] is True
    assert "Turn played" in game.command("end") or picture(game)["status"] != "active"
    assert picture(game)["pending"] == {}


@pytest.mark.parametrize("count", (2, 3, 4))
def test_watch_free_for_all(game, count):
    game.command(f"watch {count} seed=2", complete=lambda prompt: pytest.fail("watch must not call a model"))
    shown = picture(game)
    assert shown["mode"] == "watch"
    assert len(shown["scoreboard"]) == count
    assert shown["frame_count"] >= 1 and len(shown["frames"]) == shown["frame_count"]
    assert any("wins" in line or "draw" in line for line in shown["result"])
    for frame in shown["frames"]:
        assert len(frame["board"]) == 11 and all(len(row) == 11 for row in frame["board"])


def test_watch_reads_its_seed_and_protects_a_live_battle(game):
    game.command("watch seed=42")
    assert picture(game)["seed"] == 42
    game.command("play seed=1")
    assert "still running" in game.command("watch 2 seed=5")
    assert picture(game)["mode"] == "human"
    game.command("reset")
    game.command("watch 2 seed=5")
    assert picture(game)["seed"] == 5 and picture(game)["mode"] == "watch"


def test_export_and_import_card(game):
    game.command("pick long-game")
    payload = game.command("export")
    assert json.loads(payload)["kind"] == "doctrine-card"
    game.command("pick stone-bastion")
    assert "Imported" in game.command("import " + payload)
    assert picture(game)["your_card"]["name"] == "Long Game"
    bare = json.dumps(GAME._module("card").house_cards()[0])
    assert "Imported" in game.command("import " + bare)


@pytest.mark.parametrize("text", [
    "",
    "not json",
    "[]",
    "null",
    '{"kind":"doctrine-card","data":{"name":"x"}}',
    '{"kind":"doctrine-replay","data":{"frames":[]}}',
    '{"kind":"doctrine-replay","data":{"cards":[],"frames":[]}}',
    '{"kind":"doctrine-replay","data":{"cards":[{"bad":1}],"frames":[]}}',
    '{"kind":"nonsense","data":{}}',
    '{"kind":"doctrine-replay","data":{"cards":[]}}',
])
def test_import_of_malformed_files_is_refused(game, text):
    answer = game.command("import " + text)
    assert answer
    assert "Imported" not in answer
    assert picture(game)["mode"] == "idle"


def test_import_replay_round_trip(game):
    game.command("watch 3 seed=5")
    payload = game.command("export replay")
    saved = json.loads(payload)
    assert saved["kind"] == "doctrine-replay"
    game.command("reset")
    assert "Imported a replay" in game.command("import " + payload)
    shown = picture(game)
    assert shown["mode"] == "shared" and shown["frame_count"] == len(saved["data"]["frames"])


def test_replay_hostile_shapes(game):
    card = GAME._module("card").house_cards()[0]
    base = {"cards": [card], "frames": [], "status": "won", "seed": 1, "turn": 1, "max_turns": 1,
            "scores": {"p1": 0}, "units": {"p1": []}, "winner": "p1"}
    bad = dict(base, frames=[{"board": [["."] * 11] * 11, "events": [], "actions": [],
                              "units": {}, "scores": {}, "turn": 1, "actor": "p1"}])
    assert "Imported a replay" in game.command("import " + json.dumps({"kind": "doctrine-replay", "data": bad}))
    for broken in (
        dict(base, frames=[{"board": [["z"] * 11] * 11}], scores={"p1": 0}),
        dict(base, frames=[{"board": [["."] * 11] * 11, "events": "no", "actions": []}]),
        dict(base, frames=[{"board": [["."] * 10] * 11, "events": [], "actions": []}]),
        dict(base, frames=[{"board": [["."] * 11] * 11, "events": [], "actions": [], "units": {"p9": []}}]),
        dict(base, scores={"p1": -4}),
        dict(base, status="maybe"),
        dict(base, max_turns="lots"),
        dict(base, units={"p1": [{}]}),
        dict(base, units={"p1": [{"id": "p9u1", "hp": 3, "pos": "a1"}]}),
        dict(base, units={"p1": [{"id": "p1u1", "hp": 9, "pos": "a1"}]}),
        dict(base, winner="p3"),
        dict(base, frames=[{"board": [["."] * 11] * 11, "events": [], "actions": [], "units": {}, "scores": {}, "beacons": {"p1": "two"}}]),
        dict(base, frames=[{"board": [["."] * 11] * 11, "events": [1], "actions": [], "units": {}, "scores": {}}]),
        dict(base, frames=[{"board": [["."] * 11] * 11, "events": [], "actions": ["x"], "units": {}, "scores": {}}]),
    ):
        answer = game.command("import " + json.dumps({"kind": "doctrine-replay", "data": broken}))
        assert "Imported" not in answer, broken


def test_ladder(game):
    text = game.command("ladder")
    assert "Ladder for" in text and "Overall" in text
    shown = picture(game)
    assert len(shown["ladder"]) == 4
    for row in shown["ladder"]:
        assert row["wins"] + row["losses"] + row["draws"] == 10


def test_improve_needs_a_model(game):
    shown = picture(game)
    assert shown["improve_ready"] is False
    assert "Settings" in shown["improve_note"]
    answer = game.command("improve")
    assert "Improve needs one model" in answer
    assert "everything else still works" in answer.lower()
    game.command("play seed=1")
    assert picture(game)["can_move"] is True


def test_improve_keeps_a_card_that_wins_more(game, tmp_path):
    game.command("import " + json.dumps(ZERO))
    answer = game.command("improve", complete=lambda prompt: json.dumps(STRONG))
    assert "Kept Probe Winner" in answer
    shown = picture(game)
    assert shown["your_card"]["name"] == "Probe Winner"
    family = game.command("tree")
    assert "Probe Winner" in family and "generation 1" in family
    state = json.loads((tmp_path / "state.json").read_text())
    assert state["lineage"][-1]["record"]["wins"] > state["lineage"][-1]["record"]["losses"]
    assert state["lineage"][-1]["parent"] == ""


def test_improve_garbage_and_worse_are_honest(game):
    game.command("import " + json.dumps(ZERO))
    before = picture(game)["your_card"]
    for reply, phrase in (
        ("I think your bot is fine.", "not a valid card"),
        (json.dumps(ZERO), "did not win more"),
    ):
        answer = game.command("improve", complete=lambda prompt, reply=reply: reply)
        assert phrase in answer
        assert picture(game)["your_card"] == before


def test_improve_is_person_only(game):
    assert "person" in game.command("improve", source="tool", complete=lambda prompt: "{}").lower()


def test_improve_reads_the_agent_route_shape(game):
    """The Dashboard's complete() returns {"move": text}; Doctrine must read it."""
    game.command("import " + json.dumps(ZERO))
    answer = game.command("improve", complete=lambda prompt, max_tokens=80: {"move": json.dumps(STRONG), "remark": "", "tokens": 10})
    assert "Kept Probe Winner" in answer
    assert picture(game)["your_card"]["name"] == "Probe Winner"


def test_improve_never_waits_on_a_stuck_model(game, monkeypatch):
    """Improve used to call the model raw: no 20 s limit, no slot cap, no retry."""
    import time

    game.command("import " + json.dumps(ZERO))
    before = picture(game)["your_card"]
    monkeypatch.setattr(GAME.kit, "AGENT_SECONDS", 0.05)
    start = time.monotonic()
    answer = game.command("improve", complete=lambda prompt: time.sleep(2) or json.dumps(STRONG))
    spent = time.monotonic() - start
    assert spent < 1.0, f"improve waited {spent:.2f}s for a stuck model"
    assert "took too long" in answer and "kept your old card" in answer, answer
    assert picture(game)["your_card"] == before


def test_improve_reports_every_model_slot_busy(game, monkeypatch):
    game.command("import " + json.dumps(ZERO))
    before = picture(game)["your_card"]

    class Busy:
        def is_alive(self):
            return True

    monkeypatch.setattr(GAME.kit, "_LIVE", [Busy() for _ in range(GAME.kit.AGENT_CALLS)])
    answer = game.command("improve", complete=lambda prompt: json.dumps(STRONG))
    assert "busy with other requests" in answer, answer
    assert picture(game)["your_card"] == before


def test_improve_gets_two_tries_at_a_usable_card(game):
    game.command("import " + json.dumps(ZERO))
    replies = iter(["I think your bot is fine.", json.dumps(STRONG)])
    answer = game.command("improve", complete=lambda prompt: next(replies))
    assert "Kept Probe Winner" in answer, answer


def test_your_card_dropdown_lists_your_own_cards(game):
    """The dropdown used to hold the four house cards only."""
    shown = picture(game)
    assert {card["id"] for card in shown["house"]} <= {card["id"] for card in shown["cards"]}
    game.command("import " + json.dumps(ZERO))
    shown = picture(game)
    mine = [card for card in shown["cards"] if card["origin"] == "yours"]
    assert any(card["name"] == "Flawless Zero" for card in mine), shown["cards"]
    game.command("pick glass-swarm")
    assert "Flawless Zero" in game.command("pick Flawless Zero"), "an imported card cannot be picked again"

    game.command("improve", complete=lambda prompt: json.dumps(STRONG))
    shown = picture(game)
    grown = [card for card in shown["cards"] if card["origin"] == "yours" and card["name"] == "Probe Winner"]
    assert grown, shown["cards"]
    assert "Probe Winner" in game.command("pick " + grown[0]["id"])


def test_a_fresh_doctrine_does_not_list_the_house_card_twice(game):
    shown = picture(game)
    names = [card["name"] for card in shown["cards"]]
    assert shown["your_card"]["name"] in names, names
    assert not any(name.endswith("(yours)") for name in names), names
    assert len(names) == len(set(names)), names
    assert [card["id"] for card in shown["cards"] if card.get("current")] == ["iron-vanguard"], shown["cards"]


def test_an_imported_card_named_like_a_house_card_stays_selectable(game):
    """Its id must not be the plain name, or ``pick`` would find the house card."""
    mine = json.loads((ROOT / "doctrine" / "cards" / "stone-bastion.json").read_text())
    mine["weights"]["aggression"] = 0  # same name, a different card
    game.command("import " + json.dumps(mine))
    shown = picture(game)
    rows = [card for card in shown["cards"] if card["origin"] == "yours"]
    assert rows and rows[0]["name"] == "Stone Bastion (yours)", shown["cards"]
    assert rows[0]["id"] != "stone-bastion", "the imported card shares the house id"
    assert rows[0].get("current") is True

    game.command("pick glass-swarm")
    assert "Stone Bastion" in game.command("pick " + rows[0]["id"])
    assert picture(game)["your_card"]["weights"]["aggression"] == 0


def test_catalog_finds_and_plays_doctrine(tmp_path):
    sys.path.insert(0, str(ROOT))
    from shelf.catalog import Catalog

    catalog = Catalog([ROOT], tmp_path)
    card = catalog.card("doctrine")
    assert card and card["kind"] == "play" and card["bots"] is True
    assert "library" in catalog.install("doctrine").lower()
    assert "Doctrine" in catalog.play("doctrine", "help", source="command")
    assert "Iron Vanguard" in catalog.play("doctrine", "cards", source="command")
    assert catalog.picture("doctrine")["doctrine"]["mode"] == "idle"
    assert catalog.picture("doctrine")["doctrine"]["improve_ready"] is False
    assert catalog.picture("doctrine", complete=lambda prompt, max_tokens=80: "x")["doctrine"]["improve_ready"] is True


def test_profile_author_refuses_private(game):
    assert "private" in game.command("author private").lower()
    assert "lowercase" in game.command("author Bad/Name").lower()
    assert "Usage" in game.command("author")


def test_profile_author_reads_the_model_door_and_signs_the_card(game):
    seen = {}

    def fake_complete(prompt, max_tokens=0):
        seen.update(prompt=prompt, max_tokens=max_tokens)
        return {"move": json.dumps(STRONG), "remark": "", "tokens": 12}

    reply, error = game.profiles.author("test-profile", "write a card", complete=fake_complete)
    assert error == "" and "Probe Winner" in reply
    assert "write a card" in seen["prompt"]
    assert seen["max_tokens"] == game.profiles.MAX_TOKENS
    refused, why = game.profiles.author("private", "x", complete=fake_complete)
    assert refused is None and "private" in why


def test_the_author_path_starts_no_process_and_inherits_no_environment(game, monkeypatch):
    """The review's finding: the authoring run started `hermes chat` with dict(os.environ).

    Hermes reads an empty `--toolsets` as "not set", so that child got the profile's default tools and
    whatever approval-mode variables were in the environment. The card is now written by
    ``ctx.llm.complete``, which cannot run a tool, so there is nothing to restrict - and no process to
    start. This test is what keeps it that way.
    """
    import subprocess

    def no_process(*args, **kwargs):  # pragma: no cover - reached only on a regression
        raise AssertionError(f"the authoring path started a process: {args!r}")

    monkeypatch.setattr(subprocess, "run", no_process)
    monkeypatch.setattr(subprocess, "Popen", no_process)
    source = (ROOT / "doctrine" / "profiles.py").read_text(encoding="utf-8")
    assert "subprocess" not in source, "doctrine/profiles.py must not import subprocess at all"
    assert "--toolsets" not in source, "there is no CLI run left to pass a tool set to"
    assert "os.environ" not in source, "nothing to inherit, so nothing to copy"

    reply, error = game.profiles.author(
        "test-profile", "write a card", complete=lambda prompt, max_tokens=0: json.dumps(STRONG)
    )
    assert error == "" and "Probe Winner" in reply


def test_authoring_without_a_model_says_so_instead_of_starting_one(game):
    answer = game.command("author test-profile")
    assert "needs one model" in answer
    assert "Probe Winner" not in picture(game)["your_card"]["name"]


def test_profile_author_command(game, monkeypatch):
    monkeypatch.setattr(game, "complete", lambda prompt, max_tokens=0: {"move": json.dumps(STRONG)})
    answer = game.command("author test-profile", complete=game.complete)
    assert "wrote Probe Winner" in answer
    shown = picture(game)
    assert shown["your_card"]["name"] == "Probe Winner"
    assert shown["your_card"]["author"] == "test-profile"


def test_profile_runner_error_is_friendly(game, monkeypatch):
    def broken(prompt, max_tokens=0):
        raise RuntimeError("the provider is down")

    monkeypatch.setattr(game, "complete", broken)
    assert "did not answer" in game.command("author ghost", complete=broken)
