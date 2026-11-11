"""Persistent table lifecycle and command-boundary regression tests."""
from pathlib import Path
import sys
import pytest
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from shelf.kitref import kit
from connect4.game import create


def person(name, platform="irc"):
    return SimpleNamespace(id=name, name=name, platform=platform)


def test_schema_picture_and_stable_identity(tmp_path):
    game = create(tmp_path)
    game.command("new", player=person("Ada"))
    first = game.picture()
    assert first["schema_version"] == 2
    assert first["table_id"]
    assert first["owner_id"] == "Ada"
    assert first["seats"][1] == dict(side="black", kind="human", id="", name="", open=True)
    assert first["score"] == dict(white=0, black=0, draws=0)
    assert first["moves"] == []
    assert first["rematch"] == {"requested_by": []}
    assert first["draw_offer"] == ""
    assert create(tmp_path).picture()["table_id"] == first["table_id"]
    assert game.command("state")
    assert game.picture()["table_id"] == first["table_id"]


def test_explicit_seating_and_pregame_leave(tmp_path):
    game = create(tmp_path)
    ada, bea, cy = map(person, ("Ada", "Bea", "Cy"))
    game.command("new", player=ada)
    game.command("sit black", player=bea)
    assert game.picture()["seats"][1]["id"] == "Bea"
    game.command("sit black", player=cy)
    assert game.picture()["seats"][1]["id"] == "Bea"
    game.command("leave", player=bea)
    assert game.picture()["seats"][1]["open"]
    game.command("join", player=cy)
    assert game.picture()["seats"][1]["id"] == "Cy"
    game.command("sit black", player=ada)
    assert game.picture()["seats"][1]["id"] == "Cy"


def test_leaving_live_game_resigns_and_scores_only_once(tmp_path):
    game = create(tmp_path)
    ada, bea = person("Ada"), person("Bea")
    game.command("new", player=ada)
    game.command("join", player=bea)
    game.command("move 4", player=ada)
    game.command("leave", player=bea)
    pic = game.picture()
    assert pic["status"] == "resigned"
    assert pic["winner"] == "white"
    assert pic["score"] == dict(white=1, black=0, draws=0)
    assert pic["seats"][1]["open"]
    game.command("resign", player=ada)
    game.command("leave", player=bea)
    assert create(tmp_path).picture()["score"] == pic["score"]


def test_natural_result_history_and_score_survive_reload(tmp_path):
    game = create(tmp_path)
    game.command("new")
    for column in (1, 2, 1, 2, 1, 2, 1):
        game.command(f"move {column}")
    pic = create(tmp_path).picture()
    assert pic["score"] == dict(white=1, black=0, draws=0)
    assert pic["moves"] == ["1", "2", "1", "2", "1", "2", "1"]
    assert pic["plies"] == 7
    game.command("step")
    assert game.picture()["score"] == pic["score"]


def test_draw_requires_opponent_acceptance(tmp_path):
    game = create(tmp_path)
    ada, bea, cy = map(person, ("Ada", "Bea", "Cy"))
    game.command("new", player=ada)
    game.command("join", player=bea)
    game.command("draw", player=cy)
    assert game.picture()["draw_offer"] == ""
    game.command("draw", player=ada)
    assert game.picture()["draw_offer"] == "white"
    game.command("draw accept", player=ada)
    assert game.picture()["status"] == "active"
    game.command("draw accept", player=bea)
    assert game.picture()["status"] == "draw"
    assert game.picture()["score"] == dict(white=0, black=0, draws=1)
    assert game.picture()["draw_offer"] == ""
    game.command("draw accept", player=bea)
    assert create(tmp_path).picture()["score"]["draws"] == 1


def test_human_rematch_needs_both_players_and_keeps_series(tmp_path):
    game = create(tmp_path)
    ada, bea, cy = map(person, ("Ada", "Bea", "Cy"))
    game.command("new", player=ada)
    game.command("join", player=bea)
    game.command("resign", player=bea)
    before = game.picture()
    game.command("rematch", player=cy)
    assert game.picture()["rematch"] == {"requested_by": []}
    game.command("rematch", player=ada)
    game.command("rematch", player=ada)
    assert game.picture()["rematch"] == {"requested_by": ["Ada"]}
    assert game.picture()["status"] == "resigned"
    create(tmp_path).command("rematch", player=bea)
    after = game.picture()
    assert after["status"] == "active"
    assert after["table_id"] == before["table_id"]
    assert after["score"] == before["score"]
    assert after["seats"] == before["seats"]
    assert after["plies"] == 0 and after["moves"] == []
    assert after["rematch"] == {"requested_by": []}


def test_bot_rematch_needs_fresh_owner_consent(tmp_path):
    game = create(tmp_path)
    ada, bea = person("Ada"), person("Bea")
    game.command("allow-ai white=local black=local", player=ada)
    for _ in range(42):
        game.command("step", player=ada)
    before = game.picture()
    assert before["status"] in {"win", "draw"}
    game.command("rematch", player=bea)
    assert game.picture() == before
    game.command("rematch", player=ada)
    after = game.picture()
    assert after["status"] == "active"
    assert after["plies"] == 1
    assert after["score"] == before["score"]
    assert kit.load(tmp_path)["ai_consent"]["by"] == "Ada"


@pytest.mark.parametrize("command", ["new white=local black=local", "new", "join", "sit black", "leave", "resign", "draw", "draw accept", "rematch", "abandon"])
def test_tool_cannot_mutate_human_lifecycle(tmp_path, command):
    game = create(tmp_path)
    ada = person("Ada")
    game.command("new", player=ada)
    before = kit.load(tmp_path)
    response = game.command(command, source="tool", player=ada)
    assert "Refused" in response
    assert kit.load(tmp_path) == before


@pytest.mark.parametrize("command", ["new", "allow-ai black=local"])
@pytest.mark.parametrize("identified", [True, False])
def test_active_match_cannot_be_reset(tmp_path, command, identified):
    game = create(tmp_path)
    player = person("Ada") if identified else None
    game.command("new", player=player)
    game.command("move 4", player=player)
    before = kit.load(tmp_path)
    game.command(command, player=player)
    assert kit.load(tmp_path) == before


@pytest.mark.parametrize("command", ["move 4", "resign", "resign black", "abandon", "new", "allow-ai black=local"])
@pytest.mark.parametrize("anonymous", [False, True])
def test_shared_keyboard_does_not_override_other_identities(tmp_path, command, anonymous):
    game = create(tmp_path)
    game.command("new", player=person("Ada"))
    game.command("join", player=person("Bea"))
    before = kit.load(tmp_path)
    outsider = None if anonymous else person("Cy", "desktop")
    game.command(command, player=outsider)
    assert kit.load(tmp_path) == before


def test_viewer_must_sit_before_moving(tmp_path):
    game = create(tmp_path)
    game.command("new", player=person("Ada"))
    game.command("move 4", player=person("Ada"))
    before = kit.load(tmp_path)
    game.command("move 3", player=person("Bea"))
    assert kit.load(tmp_path) == before
    game.command("sit black", player=person("Bea"))
    assert "Played 3." in game.command("move 3", player=person("Bea"))


@pytest.mark.parametrize("old_version", [None, 1])
def test_legacy_state_gets_stable_schema_without_picture_writes(tmp_path, old_version):
    import json
    game = create(tmp_path)
    game.command("new", player=person("Ada"))
    legacy = kit.load(tmp_path)
    for key in ("schema_version", "table_id", "owner_id", "moves", "score", "rematch", "draw_offer"):
        legacy.pop(key, None)
    if old_version is not None:
        legacy["schema_version"] = old_version
    kit.write(tmp_path, legacy)
    before = (tmp_path / "state.json").read_bytes()
    pic = game.picture()
    assert pic["table_id"] and pic["schema_version"] == 2
    assert pic["owner_id"] == "Ada"
    assert create(tmp_path).picture()["table_id"] == pic["table_id"]
    assert (tmp_path / "state.json").read_bytes() == before
    game.command("sit black", player=person("Bea"))
    saved = json.loads((tmp_path / "state.json").read_text())
    assert saved["schema_version"] == 2
    assert saved["table_id"] == pic["table_id"]


def test_draw_offer_expires_after_opponent_moves(tmp_path):
    game = create(tmp_path)
    ada, bea = person("Ada"), person("Bea")
    game.command("new", player=ada)
    game.command("join", player=bea)
    game.command("move 4", player=ada)
    game.command("draw", player=ada)
    game.command("move 3", player=bea)
    assert game.picture()["draw_offer"] == ""
    game.command("draw accept", player=bea)
    assert game.picture()["status"] == "active"


def test_replacement_seat_is_for_next_match_only(tmp_path):
    game = create(tmp_path)
    ada, bea, cy = map(person, ("Ada", "Bea", "Cy"))
    game.command("new", player=ada)
    game.command("join", player=bea)
    game.command("move 4", player=ada)
    game.command("leave", player=bea)
    old = game.picture()
    game.command("sit black", player=cy)
    assert game.picture()["seats"][1]["id"] == "Cy"
    assert game.picture()["status"] == "resigned"
    assert game.picture()["plies"] == old["plies"]
    game.command("rematch", player=ada)
    game.command("rematch", player=cy)
    assert game.picture()["status"] == "active"
    assert game.picture()["score"] == old["score"]


def test_anonymous_cannot_resign_an_open_seat_in_named_match(tmp_path):
    game = create(tmp_path)
    game.command("new", player=person("Ada"))
    before = kit.load(tmp_path)
    game.command("resign")
    assert kit.load(tmp_path) == before


def test_bot_consent_records_exact_human_and_seats(tmp_path):
    game = create(tmp_path)
    game.command("allow-ai black=local", player=person("Ada"))
    state = kit.load(tmp_path)
    assert state["ai_consent"] == {"by": "Ada", "seats": ["black"]}
    before = game.picture()
    game.command("allow-ai black=local", player=person("Ada"))
    assert game.picture() == before


@pytest.mark.parametrize("command", ["resign", "abandon"])
@pytest.mark.parametrize("anonymous", [False, True])
def test_bot_table_spectators_cannot_end_match(tmp_path, command, anonymous):
    game = create(tmp_path)
    game.command("allow-ai white=local black=local", player=person("Ada"))
    before = kit.load(tmp_path)
    game.command(command, player=None if anonymous else person("Cy", "desktop"))
    assert kit.load(tmp_path) == before


@pytest.mark.parametrize("caller,source", [("Cy", "command"), (None, "command"), ("Ada", "tool")])
def test_only_human_owner_can_advance_watching_bots(tmp_path, caller, source):
    game = create(tmp_path)
    game.command("allow-ai white=local black=local", player=person("Ada"))
    before = kit.load(tmp_path)
    game.command("step", source=source, player=person(caller) if caller else None)
    assert kit.load(tmp_path) == before
    game.command("step", player=person("Ada"))
    assert game.picture()["plies"] == before["plies"] + 1


def test_lifecycle_commands_are_discoverable(tmp_path):
    help_text = create(tmp_path).command("help")
    for verb in ("sit white|black", "leave", "draw", "rematch"):
        assert f"/games connect4 {verb}" in help_text


def test_natural_finish_records_reason(tmp_path):
    game = create(tmp_path)
    game.command("new")
    for column in (1, 2, 1, 2, 1, 2, 1):
        game.command(f"move {column}")
    assert kit.load(tmp_path)["result_reason"] == "rules"
    assert game.picture()["result_reason"] == "rules"


@pytest.mark.parametrize("outsider", [None, "desktop"])
def test_shared_keyboard_cannot_claim_open_seat_of_named_remote_table(tmp_path, outsider):
    game = create(tmp_path)
    game.command("new", player=person("Ada"))
    game.command("move 4", player=person("Ada"))
    before = kit.load(tmp_path)
    game.command("move 3", player=person("Cy", outsider) if outsider else None)
    assert kit.load(tmp_path) == before


def test_desktop_owner_cannot_implicitly_rejoin_with_another_person_seated(tmp_path):
    game = create(tmp_path)
    ada, bea = person("Ada", "desktop"), person("Bea")
    game.command("new", player=ada)
    game.command("sit black", player=bea)
    game.command("leave", player=ada)
    before = kit.load(tmp_path)
    assert "sit white" in game.command("move 4", player=ada)
    assert kit.load(tmp_path) == before
    game.command("sit white", player=ada)
    assert "Played 4." in game.command("move 4", player=ada)


def test_desktop_passplay_still_claims_open_seat_without_another_person(tmp_path):
    game = create(tmp_path)
    ada = person("Ada", "desktop")
    game.command("new", player=ada)
    game.command("move 4", player=ada)
    assert "Played 3." in game.command("move 3", player=ada)
    assert [seat["id"] for seat in game.picture()["seats"]] == ["Ada", "Ada"]


def test_desktop_cannot_passplay_an_ownerless_table_with_someone_seated(tmp_path):
    game = create(tmp_path)
    game.command("new")
    game.command("sit black", player=person("Bea"))
    before = kit.load(tmp_path)
    assert "sit white" in game.command("move 4", player=person("Cy", "desktop"))
    assert kit.load(tmp_path) == before


@pytest.mark.parametrize("leaver", ["Ada", "Bea"])
def test_pregame_seat_change_invalidates_draw_offer(tmp_path, leaver):
    game = create(tmp_path)
    ada, bea, cy = map(person, ("Ada", "Bea", "Cy"))
    game.command("new", player=ada)
    game.command("join", player=bea)
    game.command("draw offer", player=ada)
    assert game.picture()["draw_offer"] == "white"
    game.command("leave", player=person(leaver))
    assert game.picture()["draw_offer"] == ""
    game.command("join", player=cy)
    game.command("draw accept", player=bea if leaver == "Ada" else cy)
    assert game.picture()["status"] == "active"


@pytest.mark.parametrize("source", ["tool", "agent", "background", ""])
def test_only_command_source_can_move_human_seat(tmp_path, source):
    game = create(tmp_path)
    ada = person("Ada")
    game.command("new", player=ada)
    before = kit.load(tmp_path)
    assert "Refused" in game.command("move 4", source=source, player=ada)
    assert kit.load(tmp_path) == before


def test_concurrent_owner_watch_steps_reload_under_lock(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    game = create(tmp_path)
    ada = person("Ada")
    game.command("allow-ai white=local black=local", player=ada)
    before = kit.load(tmp_path)
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda _: create(tmp_path).command("step", player=ada), range(8)))
    after = kit.load(tmp_path)
    assert after["plies"] == before["plies"] + 8
    assert len(after["moves"]) == after["plies"]


def test_concurrent_draw_acceptance_scores_once(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    game = create(tmp_path)
    ada, bea = person("Ada"), person("Bea")
    game.command("new", player=ada)
    game.command("join", player=bea)
    game.command("draw offer", player=ada)
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda _: create(tmp_path).command("draw accept", player=bea), range(8)))
    assert kit.load(tmp_path)["score"] == dict(white=0, black=0, draws=1)


@pytest.mark.parametrize("title", ["connect4", "checkers", "reversi", "gomoku", "slots"])
def test_rematch_resets_every_game_specific_field(tmp_path, title):
    from importlib import import_module
    rules = import_module(f"{title}.game")
    game = rules.create(tmp_path)
    ada, bea = person("Ada"), person("Bea")
    game.command("new", player=ada)
    game.command("join", player=bea)
    state = kit.load(tmp_path)
    game.command(f"move {rules.show(rules.legal(state)[0])}", player=ada)
    game.command("resign", player=bea)
    score = kit.load(tmp_path)["score"]
    game.command("rematch", player=ada)
    game.command("rematch", player=bea)
    restarted = kit.load(tmp_path)
    assert all(restarted[key] == value for key, value in rules.fresh().items())
    assert restarted["score"] == score
    assert restarted["plies"] == 0
    assert restarted["result_recorded"] is False
    before = kit.load(tmp_path)
    game.command("rematch", player=ada)
    assert kit.load(tmp_path) == before


