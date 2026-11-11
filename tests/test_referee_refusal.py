"""The referee's refusals are shown, not hidden: when a model proposes illegal moves and the
built-in player has to move for it, the reply names each proposal and why it was refused, and
the state keeps a record the table can badge."""
from __future__ import annotations

import json
from pathlib import Path

from test_agent_seat import ME, Model, first_human_move, table


def test_refused_proposals_are_named_with_their_reasons(tmp_path):
    tab, module = table("chessboard", tmp_path)
    tries = iter(["a8a1", "e8e8"])
    model = Model(lambda legal: next(tries))
    tab.command("allow-ai black=agent", complete=model, player=ME)
    state_path = tmp_path / "chessboard" / "state.json"
    reply = tab.command(f"move {first_human_move(module, state_path)}", complete=model, player=ME)

    assert "built-in player chose" in reply
    assert "a8a1" in reply and "e8e8" in reply, reply
    assert "refused" in reply.lower()
    state = json.loads(state_path.read_text())
    record = state["refusals"][-1]
    assert record["side"] == "black"
    assert [item["proposed"] for item in record["proposals"]] == ["a8a1", "e8e8"]
    assert all(item["reason"] for item in record["proposals"])
    assert record["played"], "the built-in move the board actually took is recorded"


def test_a_legal_answer_leaves_no_refusal_record(tmp_path):
    tab, module = table("connect4", tmp_path)
    model = Model(lambda legal: legal[0])
    tab.command("allow-ai black=agent", complete=model, player=ME)
    state_path = tmp_path / "connect4" / "state.json"
    tab.command(f"move {first_human_move(module, state_path)}", complete=model, player=ME)
    assert not json.loads(state_path.read_text()).get("refusals")


def test_the_picture_carries_the_refusals_to_the_table(tmp_path):
    tab, module = table("chessboard", tmp_path)
    tries = iter(["a8a1", "e8e8"])
    model = Model(lambda legal: next(tries))
    tab.command("allow-ai black=agent", complete=model, player=ME)
    state_path = tmp_path / "chessboard" / "state.json"
    tab.command(f"move {first_human_move(module, state_path)}", complete=model, player=ME)
    state = json.loads(state_path.read_text())
    picture = tab.picture(player=ME)
    assert picture["refusals"] == state["refusals"]
    record = picture["refusals"][-1]
    assert record["proposals"][0]["proposed"] == "a8a1" and record["proposals"][0]["reason"]


def test_a_game_that_was_never_refused_shows_no_refusals(tmp_path):
    tab, module = table("connect4", tmp_path)
    model = Model(lambda legal: legal[0])
    tab.command("allow-ai black=agent", complete=model, player=ME)
    state_path = tmp_path / "connect4" / "state.json"
    tab.command(f"move {first_human_move(module, state_path)}", complete=model, player=ME)
    assert tab.picture(player=ME)["refusals"] == []
