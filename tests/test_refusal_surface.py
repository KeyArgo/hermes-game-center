"""The referee's refusal is said out loud: one plain sentence the table shows as a banner."""

from __future__ import annotations

import json
import re
from pathlib import Path

from test_agent_seat import ME, Model, first_human_move, table  # puts the repo on sys.path
from shelf.kitref import kit  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def _record(**overrides):
    record = {
        "ply": 12,
        "side": "white",
        "proposals": [{"proposed": "Ne5", "reason": "Your king would be in check."}],
        "played": "Nf3",
    }
    record.update(overrides)
    return record


def test_illegal_move_produces_a_plain_sentence():
    msg = kit.refusal_message(_record())
    assert msg.startswith("Illegal move")
    assert "Ne5" in msg
    assert "king" in msg.lower()
    assert "Nf3" in msg
    # Plain words only: no error codes, no snake_case, no brackets.
    assert not re.search(r"[a-z]+_[a-z]+", msg)
    assert "{" not in msg and "[" not in msg


def test_every_proposal_is_named():
    msg = kit.refusal_message(_record(proposals=[
        {"proposed": "Ne5", "reason": "Your king would be in check."},
        {"proposed": "castle", "reason": "That isn't a move in this game."},
    ]))
    assert "Ne5" in msg and "castle" in msg
    assert msg.count("Nf3") == 1


def test_empty_or_odd_records_never_raise():
    assert kit.refusal_message({}) == ""
    assert kit.refusal_message({"proposals": []}) == ""
    assert isinstance(kit.refusal_message({"proposals": [{}], "played": ""}), str)


def test_a_real_refusal_records_the_sentence_for_the_table(tmp_path):
    # Same setup as test_referee_refusal: a model proposes two illegal chess moves.
    tab, module = table("chessboard", tmp_path)
    tries = iter(["a8a1", "e8e8"])
    model = Model(lambda legal: next(tries))
    tab.command("allow-ai black=agent", complete=model, player=ME)
    state_path = tmp_path / "chessboard" / "state.json"
    tab.command(f"move {first_human_move(module, state_path)}", complete=model, player=ME)
    record = json.loads(state_path.read_text())["refusals"][-1]
    # The sentence is stored on the record itself, so picture == state still holds.
    assert record["message"] == kit.refusal_message(record)
    assert record["message"].startswith("Illegal move")
    assert "a8a1" in record["message"] and record["played"] in record["message"]
    assert tab.picture(player=ME)["refusals"][-1]["message"] == record["message"]


def test_game_page_shows_a_banner():
    page = (ROOT / "desktop" / "src" / "30-game-page.js").read_text(encoding="utf-8")
    assert "games-refusal-banner" in page
    assert "Illegal move" in page or ".message" in page
    assert "2500" in page
