"""The end-of-game review: both fleets published, the sunk ones marked.

The owner asked for a picture at the end - five hulls a side, the killed ones red, your kills in the
enemy's waters and your losses in your own. That needs the enemy's whole fleet in the payload, which
must not leak while the game is still running.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import seabattle.game as game  # noqa: E402


def _midway():
    state = game.fresh()
    state.update({"white": "human", "black": "human", "white_id": "p1", "turn": "white", "phase": "fire"})
    state["fleets"]["white"] = game.duplicate_fleet("white")
    state["fleets"]["black"] = game.duplicate_fleet("black")
    return state


def test_a_running_game_does_not_publish_the_enemy_fleet():
    picture = game.picture(_midway(), {"id": "p1"})
    assert picture["enemy_fleet"] == [], "the enemy's hulls stay hidden until the game ends"
    assert picture["enemy_ships"] == [], "and nothing is listed as sunk yet"


def test_the_end_publishes_both_fleets_with_their_fate():
    state = _midway()
    state["shots"]["white"] = [[r, c] for ship in state["fleets"]["black"] for r, c in ship["cells"]]
    state["status"] = "win"
    state["winner"] = "white"
    picture = game.picture(state, {"id": "p1"})
    assert len(picture["enemy_fleet"]) == 5, "their whole fleet is published for the review"
    assert all(ship["sunk"] for ship in picture["enemy_fleet"]), "every hull they lost is marked sunk"
    assert len(picture["own_ships"]) == 5
    assert all(not ship["sunk"] for ship in picture["own_ships"]), "your fleet survived untouched"


def test_a_partial_loss_marks_only_the_hulls_that_went_down():
    state = _midway()
    state["fleets"]["white"] = game.duplicate_fleet("white")
    victim = state["fleets"]["white"][0]
    state["shots"]["black"] = [[r, c] for r, c in victim["cells"]]
    state["status"] = "win"
    state["winner"] = "black"
    picture = game.picture(state, {"id": "p1"})
    lost = [ship for ship in picture["own_ships"] if ship["sunk"]]
    assert len(lost) == 1, "exactly the hull that was hit on every cell is red"
    assert lost[0]["name"] == victim["name"]
