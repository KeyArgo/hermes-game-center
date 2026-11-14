"""Watch it think and the corner coach: the private panel and the whisper.

Two promises are proved here, and nothing else matters if they fail:

* a seat's working is shown to the person whose bot it is, and to nobody else —
  not to an opponent's screen, not to a watcher, not in a shared game file;
* a whisper from the person reaches that seat's next prompt, once a round, and
  the log says plainly that it happened.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf.who import Player  # noqa: E402
from talktable import common  # noqa: E402
from talktable.engine import create  # noqa: E402

ME = Player("desktop:me", "Ada", "desktop")
WATCHER = Player("desktop:watcher", "Watcher", "desktop")

ENVELOPE = """<read>
know: I hold two fours and a six, which nobody else can see.
saw: Player 2 raised twice in a row, too fast.
believe: They want me to think the table is full of fives.
safe: Call only if the count passes six.
</read>
<think_scratchpad>coach: I keep the raise small and stay quiet.
Two fours is a fair base. Player 2's quick raises look like a bluff, so I put
one more die on the table and let them call it.
</think_scratchpad>
<action>[Bid: 3, 4]</action>"""


def table(tmp_path: Path, game_id: str, **settings):
    data = tmp_path / "data"
    folder = data / game_id
    folder.mkdir(parents=True, exist_ok=True)
    return create(folder, game_id, {"data_root": str(data), **settings})


def act_or_step(played, player=ME, complete=None):
    """One move of the person's, or one machine step. Returns the picture."""
    picture = played.picture(player=player)
    if picture.get("status") != "active":
        return picture
    if picture.get("can_move"):
        if picture.get("can_say"):
            played.command("say quiet over here", player=player, complete=complete)
        elif picture.get("actions"):
            played.command("act " + picture["actions"][0]["id"], player=player, complete=complete)
        else:
            played.command("act send", player=player, complete=complete)
    elif picture.get("can_step"):
        played.command("step", player=player, complete=complete)
    return played.picture(player=player)


# ---------------------------------------------------------------- the envelope


def test_a_full_envelope_is_read_into_read_answers_working_and_action():
    thought = common.parse_thinking(ENVELOPE)
    keys = [row["key"] for row in thought["read"]]
    assert keys == ["know", "saw", "believe", "safe"]
    assert "two fours" in thought["read"][0]["text"]
    assert thought["action"] == "[Bid: 3, 4]"
    assert thought["scratch"].startswith("Two fours is a fair base")
    assert "coach:" not in thought["scratch"], "the coach line is lifted out of the working"
    assert thought["coach"] == "I keep the raise small and stay quiet."


def test_prose_around_the_envelope_is_ignored():
    thought = common.parse_thinking("Here is my answer, boss.\n" + ENVELOPE + "\nGood luck.")
    assert thought["action"] == "[Bid: 3, 4]"
    assert len(thought["read"]) == 4


@pytest.mark.parametrize("plain", ["[Bid: 2, 3]", "banana", "  [Call]  "])
def test_a_plain_reply_still_plays(plain):
    thought = common.parse_thinking(plain)
    assert thought["action"] == plain.strip()
    assert thought["scratch"] == "" and thought["read"] == []


def test_an_overlong_working_is_cut_to_the_promise():
    word = "very "
    body = "".join(f"{word}reason {index} " for index in range(200))
    thought = common.parse_thinking(f"<think_scratchpad>{body}</think_scratchpad><action>[Call]</action>")
    assert len(thought["scratch"].split()) <= common.MAX_SCRATCH_WORDS
    assert len(thought["scratch"]) <= common.MAX_SCRATCH_CHARS


def test_the_parser_never_raises():
    for junk in (None, 12, [], {"move": "x"}):
        thought = common.parse_thinking(junk)
        assert thought["action"] == "" and thought["read"] == []


# ------------------------------------------------------- the panel, and privacy


def test_a_model_seat_that_shows_its_working_still_plays(tmp_path):
    played = table(tmp_path, "liars-dice")
    played.command("new seats=3 agent=1 seed=8", player=ME)
    seen = []

    def complete(prompt, max_tokens=0):
        seen.append(prompt)
        return {"move": ENVELOPE, "tokens": 12}

    for _ in range(12):
        picture = act_or_step(played, complete=complete)
        if picture.get("think"):
            break
    assert seen, "the model was never asked"
    assert "<read>" in seen[0] and "<action>" in seen[0], "the prompt asks for the working"
    assert common.READS[0][2].strip(".") in seen[0] or "know:" in seen[0]

    state = played._load()
    records = state["think"]["1"]  # the agent seat is seat 1
    assert records, "the working was not kept"
    latest = records[-1]
    assert latest["fallback"] is False
    assert latest["action"].startswith("[Bid:") or latest["action"] == "[Call]"
    assert "two fours" in json.dumps(latest["read"])
    assert latest["scratch"]

    owner_view = played.picture(player=ME)
    assert owner_view["status"] == "active"
    assert [row["seat"] for row in owner_view["think"]] == [1]
    assert owner_view["think"][0]["name"]


def test_an_opponent_and_a_watcher_never_read_the_working(tmp_path):
    played = table(tmp_path, "liars-dice")
    played.command("new seats=3 agent=1 seed=8", player=ME)

    def complete(prompt, max_tokens=0):
        return {"move": ENVELOPE, "tokens": 12}

    for _ in range(12):
        picture = act_or_step(played, complete=complete)
        if picture.get("think"):
            break
    secret = played.picture(player=ME)["think"][0]["scratch"]
    assert secret

    # A stranger who is not at this table.
    other = paint = played.picture(player=Player("desktop:other", "Other", "desktop"))
    assert paint["think"] == []
    assert secret not in json.dumps(paint)
    # A person watching machines play has no seat, so no working either.
    watched = table(tmp_path / "watch", "liars-dice")
    watched.command("new seats=3 bots=1 seed=8", player=ME)
    machine = watched.picture(player=WATCHER)
    assert machine["watching"] is True
    assert machine["think"] == []


def test_a_shared_game_file_carries_no_working(tmp_path):
    played = table(tmp_path, "liars-dice")
    played.command("new seats=3 agent=1 seed=8", player=ME)

    def complete(prompt, max_tokens=0):
        return {"move": ENVELOPE, "tokens": 12}

    for _ in range(400):
        picture = act_or_step(played, complete=complete)
        if picture.get("status") != "active":
            break
    done = played.picture(player=ME)
    assert done["status"] == "done"
    assert done["share"]
    assert "think_scratchpad" not in json.dumps(done["share"])
    assert "two fours" not in json.dumps(done["share"])
    assert "think" not in json.dumps(done["share"])


def test_a_built_in_fallback_is_shown_as_one(tmp_path):
    played = table(tmp_path, "liars-dice")
    played.command("new seats=3 agent=1 seed=8", player=ME)

    def complete(prompt, max_tokens=0):
        return {"move": "banana", "tokens": 3}

    saw_fallback = False
    for _ in range(20):
        picture = act_or_step(played, complete=complete)
        if picture.get("think") and picture["think"][0]["fallback"]:
            saw_fallback = True
            assert picture["think"][0]["scratch"] == ""
            break
    assert saw_fallback, "a covered turn was not reported to the owner"


# ------------------------------------------------------------- the corner coach


def test_the_coach_window_opens_and_closes(tmp_path):
    played = table(tmp_path, "liars-dice")
    played.command("new seats=3 agent=1 seed=8", player=ME)
    picture = played.picture(player=ME)
    assert picture["coach"]["available"] is True
    assert picture["coach"]["open"] is True
    assert 0 < picture["coach"]["seconds_left"] <= 15

    # The window is fifteen seconds, and it is measured on the server.
    state = played._load()
    state["coach"]["window"]["until"] = int(time.time()) - 1
    played._save(state)
    assert "closed" in played.command("coach Raise now.", player=ME)
    assert played.picture(player=ME)["coach"]["open"] is False


def test_a_whisper_reaches_the_next_prompt_and_the_log(tmp_path):
    played = table(tmp_path, "liars-dice")
    played.command("new seats=3 agent=1 seed=8", player=ME)
    answer = played.command("coach Play it calm, then raise once.", player=ME)
    assert answer.startswith("Whispered."), answer
    log = played.picture(player=ME)["log"]
    coach_rows = [row for row in log if row["kind"] == "coach"]
    assert coach_rows, "the whisper was not written into the log"
    assert coach_rows[-1]["name"] == "Coach"
    assert "Coach" in json.dumps(coach_rows[-1]["name"])
    assert "Play it calm, then raise once." in coach_rows[-1]["text"]

    asked = []

    def complete(prompt, max_tokens=0):
        asked.append(prompt)
        return {"move": ENVELOPE, "tokens": 12}

    for _ in range(12):
        picture = act_or_step(played, complete=complete)
        if picture.get("think"):
            break
    assert asked, "the model was never asked"
    assert "Play it calm, then raise once." in asked[0]
    latest = played._load()["think"]["1"][-1]
    assert latest["coach"] == "Play it calm, then raise once."


def test_one_whisper_a_round_and_none_from_a_stranger(tmp_path):
    played = table(tmp_path, "liars-dice")
    played.command("new seats=3 agent=1 seed=8", player=ME)
    assert played.command("coach First thought.", player=ME).startswith("Whispered.")
    second = played.command("coach Second thought.", player=ME)
    assert "already whispered" in second, second
    stranger = played.command("coach Let me in.", player=Player("desktop:nope", "Nope", "desktop"))
    assert "Only the person" in stranger, stranger


def test_a_sentence_over_the_limit_and_an_empty_one_are_refused(tmp_path):
    played = table(tmp_path, "liars-dice")
    played.command("new seats=3 agent=1 seed=8", player=ME)
    assert "120" in played.command("coach " + "x" * 121, player=ME)
    assert "Write one sentence" in played.command("coach    ", player=ME)


def test_a_watcher_never_sees_the_whisper_in_the_log(tmp_path):
    played = table(tmp_path, "liars-dice")
    played.command("new seats=3 agent=1 seed=8", player=ME)
    played.command("coach Hold the line.", player=ME)
    stranger = played.picture(player=Player("desktop:other", "Other", "desktop"))
    assert not [row for row in stranger["log"] if row["kind"] == "coach"]
    assert "Hold the line." not in json.dumps(stranger)


def test_the_game_over_table_has_no_coach(tmp_path):
    played = table(tmp_path, "liars-dice")
    played.command("new seats=3 agent=1 seed=8", player=ME)
    state = played._load()
    state["status"] = "done"
    played._save(state)
    assert "over" in played.command("coach Too late.", player=ME)


# ------------------------------------------------------------------- doctrine


def _doctrine(tmp_path: Path):
    spec = importlib.util.spec_from_file_location(
        "doctrine_watch_it_think", ROOT / "doctrine" / "game.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


STRONG = {
    "schema": "doctrine-card/1",
    "name": "Probe Winner",
    "author": "test",
    "personality": "Attacks and finishes.",
    "weights": {"aggression": 100, "safety": 70, "objective": 10, "focus": 100,
                "cohesion": 50, "center": 0, "mobility": 70, "endurance": 90},
}


def test_doctrine_asks_for_the_working_and_keeps_it(tmp_path):
    game_module = _doctrine(tmp_path)
    game = game_module.Doctrine(tmp_path / "doctrine")
    asked = []

    def complete(prompt, max_tokens=0):
        asked.append(prompt)
        card = json.dumps(STRONG)
        return {"move": f"<read>\nknow: the last battle was lost on the flanks.\n"
                        f"saw: my units arrived one at a time.\n"
                        f"believe: the bot wants me to chase kills.\n"
                        f"safe: hold the centre first.\n</read>\n"
                        f"<think_scratchpad>Push focus and cohesion up, keep the centre.</think_scratchpad>\n"
                        f"<action>{card}</action>", "tokens": 20}

    answer = game.command("improve", complete=complete)
    assert "Probe Winner" in answer or "kept" in answer, answer
    assert asked, "the model was never asked"
    assert "<action>" in asked[0] and "<think_scratchpad>" in asked[0]
    assert "What I know" in asked[0] or "know:" in asked[0]
    picture = game.picture()
    prep = picture["doctrine"]["prep"]
    assert prep, "a parsed card left no working behind"
    assert prep["scratch"].startswith("Push focus")
    assert [row["key"] for row in prep["read"]] == ["know", "saw", "believe", "safe"]
