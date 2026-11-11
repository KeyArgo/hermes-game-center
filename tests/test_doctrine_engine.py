"""Behavioral coverage for Doctrine cards and the match engine."""
import copy
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from doctrine import card, engine


def test_deterministic_replay():
    cards = card.house_cards()[:2]
    first = engine.replay(cards, 42, 20)
    assert json.dumps(first, sort_keys=True) == json.dumps(engine.replay(cards, 42, 20), sort_keys=True)
    assert engine.replay(cards, 99, 20)["status"] in ("won", "draw")


@pytest.mark.parametrize("key", card.WEIGHTS)
def test_weights(key):
    original = card.house_cards()[0]
    for value in (-1, 101, 1.5, "50", None, True):
        bad = copy.deepcopy(original)
        bad["weights"][key] = value
        assert card.validate(bad)[0] is None
        assert card.validate(bad)[1]
    for value in (0, 100):
        good = copy.deepcopy(original)
        good["weights"][key] = value
        assert card.validate(good)[1] == []
    bad = copy.deepcopy(original)
    del bad["weights"][key]
    assert card.validate(bad)[1]
    bad["weights"][key] = 50
    bad["weights"]["extra"] = 1
    assert card.validate(bad)[1]


def test_hostile_cards():
    original = card.house_cards()[0]
    control = dict(original, name="bad\nname")
    huge = dict(original, name="x" * 100000)
    extra = dict(original, extra=1)
    nested = dict(original, weights={"aggression": {"x": 1}})
    for raw in ("x" * 1000000, "{", "[]", "null", control, huge, "NaN", extra, nested):
        result, problems = card.validate(raw)
        assert result is None and 0 < len(problems) <= 8
    assert card.from_payload(json.dumps({"kind": "doctrine-card", "card": original}))[0] == original
    assert card.from_payload(json.dumps(card.envelope("doctrine-card", original)))[0] == original


def test_house_cards():
    cards = card.house_cards()
    assert len(cards) == 4
    assert len({tuple(c["weights"].values()) for c in cards}) == 4
    for c in cards:
        assert card.validate(c)[1] == []
        assert set(c["weights"]) == set(card.WEIGHTS)


@pytest.mark.parametrize("count", (2, 3, 4))
def test_ffa(count):
    state = engine.replay(card.house_cards()[:count], 123, 24)
    assert state["status"] in ("won", "draw")
    assert len(state["frames"]) == state["turn"] - 1
    assert all(score >= 0 for score in state["scores"].values())
    for f in state["frames"]:
        positions = [u["pos"] for units in f["units"].values() for u in units]
        assert len(positions) == len(set(positions))
        if any(a["killed"] for a in f["actions"]):
            assert any("eliminated" in e for e in f["events"])


def test_wins_and_ties():
    cards = card.house_cards()[:2]
    state = engine.new_match(cards, 1)
    state["units"]["p2"] = []
    engine.step_turn(state)
    assert (state["status"], state["winner"]) == ("won", "p1")
    for scores, status, winner in (([10, 0], "won", "p1"), ([0, 0], "draw", "")):
        state = engine.new_match(cards, 1, 1)
        state["scores"] = dict(zip(("p1", "p2"), scores))
        engine.step_turn(state)
        assert (state["status"], state["winner"]) == (status, winner)


def test_human_turn():
    state = engine.new_match(card.house_cards()[:2], 1, 10, human="p1")
    options = engine.human_options(state)
    assert len(options) == 3
    for moves in ({}, {"p1u1": "hold", "p1u2": "hold", "dead": "hold"},
                  {"p1u1": "k11", "p1u2": "hold", "p1u3": "hold"},
                  {"p1u1": "hold", "p1u2": "hold", "p1u3": "hold", "unknown": "hold"}):
        before = copy.deepcopy(state)
        with pytest.raises(ValueError):
            engine.human_turn(state, moves)
        assert state == before
    engine.human_turn(state, {uid: "hold" for uid in options})
    assert state["status"] != "active" or state["actor"] == 0
    state["actor"] = 1
    assert engine.human_options(state) == {}


def test_summary():
    state = engine.new_match(card.house_cards()[:2], 0, 1)
    state["scores"]["p1"] = 9
    engine.run(state)
    text = " ".join(engine.summary(state))
    assert state["cards"][0]["name"] in text
    assert str(state["scores"]["p1"]) in text
    assert str(state["scores"]["p2"]) in text
    assert len(engine.summary(state)) < 20


def test_every_frame_carries_beacon_counts():
    state = engine.replay(card.house_cards()[:2], 3)
    assert state["frames"]
    for frame in state["frames"]:
        assert set(frame["beacons"]) == {"p1", "p2"}
        assert all(isinstance(value, int) and value >= 0 for value in frame["beacons"].values())
