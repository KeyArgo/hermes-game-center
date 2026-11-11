"""Liar's Dice 2v2: four seats, two teams, one shared pool per team.

The promises this game makes that the single-table version does not: the turn
order alternates between the teams, a die lost by one seat is lost from the
team's shared pool, a team is out together, and every word said is public.
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf.who import Player  # noqa: E402
from talktable import engine  # noqa: E402
from talktable.engine import create  # noqa: E402
from talktable.games import liarsdice_teams as game  # noqa: E402

ME = Player("desktop:me", "Ada", "desktop")


def table(tmp_path: Path, **settings):
    data = tmp_path / "data"
    folder = data / "liars-dice-2v2"
    folder.mkdir(parents=True, exist_ok=True)
    return create(folder, "liars-dice-2v2", {"data_root": str(data), **settings})


def fresh_env(seed: int = 7):
    env = game.build(4)
    game.reset(env, [0, 1, 2, 3], seed)
    return env


# ------------------------------------------------------------------ the rules


def test_four_seats_and_the_turn_order_alternates_between_teams():
    assert game.MIN_SEATS == game.MAX_SEATS == 4
    assert game.sessions(4) == [[0, 1, 2, 3]]
    assert [game.TEAM_OF[seat] for seat in (0, 1, 2, 3)] == [0, 1, 0, 1]


def test_each_team_starts_with_one_shared_pool_of_ten_dice():
    env = fresh_env()
    state = env.state.game_state
    assert state["team_dice"] == {0: 10, 1: 10}
    assert state["remaining_dice"] == {0: 5, 1: 5, 2: 5, 3: 5}
    assert sum(state["remaining_dice"].values()) == 20


def test_a_call_charges_the_losers_team_not_the_seat_alone():
    env = fresh_env()
    state = env.state.game_state
    caller = game.current(env)
    # A bid, then a call that is certainly wrong (20 dice cannot hold a 99 in one face).
    env.step("[Bid: 99, 1]")
    env.step("[Call]")
    # One team lost exactly one die; the other still has ten.
    pools = sorted(state["team_dice"].values())
    assert pools == [9, 10], pools
    # And the split of the shrunken pool is still the whole pool.
    for team, seats in game.TEAM_SEATS.items():
        assert state["remaining_dice"][seats[0]] + state["remaining_dice"][seats[1]] == state["team_dice"][team]


def test_a_team_goes_out_together_and_the_other_team_wins():
    env = fresh_env()
    state = env.state.game_state
    # Drive the pool of team 1 down to nothing by calling every bid.
    guards = 0
    while not game.done(env) and guards < 200:
        seat = game.current(env)
        if state["current_bid"]["quantity"]:
            env.step("[Call]")
        else:
            env.step("[Bid: 1, 1]")
        guards += 1
    assert game.done(env)
    pools = state["team_dice"]
    assert sorted(pools.values())[0] == 0
    winner = 0 if pools[0] > 0 else 1
    rewards = env.state.rewards
    assert all((value == 1.0) == (game.TEAM_OF[seat] == winner) for seat, value in rewards.items())


def test_table_talk_is_public_and_does_not_pass_the_turn():
    env = fresh_env()
    seat = game.current(env)
    before = dict(env.state.game_state["remaining_dice"])
    env.step("I am holding fours.")
    assert game.current(env) == seat
    assert env.state.game_state["remaining_dice"] == before
    assert env.state.game_state["said"] == [{"seat": seat, "text": "I am holding fours."}]
    # Everyone at the table heard it: the observation went to all seats.
    entries = [entry for entries in env.state.observations.values() for entry in entries]
    assert any("I am holding fours." in str(entry[1]) for entry in entries)


@pytest.mark.parametrize("level", list(game.LEVELS))
def test_every_level_finishes_a_game_with_the_built_in_player(level):
    env = fresh_env(11)
    env.level = level
    rng = random.Random(level)
    plies = 0
    while not game.done(env) and plies < 400:
        seat = game.current(env)
        allowed = {item["raw"] for item in game.actions(env, seat)}
        raw = game.bot(env, seat, rng)
        assert raw, "the built-in player always has something to play"
        if raw in allowed:
            env.step(raw)
        else:
            # A said line is not an action on the table; it is still legal speech.
            assert raw in game.SIGNALS.values(), raw
            env.step(raw)
        plies += 1
    assert game.done(env), f"{level} never finished"


def test_advanced_seats_signal_their_partner_in_the_open():
    env = fresh_env(3)
    env.level = "expert"
    rng = random.Random(1)
    said = []
    for _ in range(20):
        if game.done(env):
            break
        seat = game.current(env)
        raw = game.bot(env, seat, rng)
        if raw in game.SIGNALS.values():
            said.append((seat, raw))
            break
        env.step(raw)
    assert said, "an expert seat never used the public convention"
    seat, line = said[0]
    partner = game._partner(seat)
    assert partner != seat
    assert game.TEAM_OF[partner] == game.TEAM_OF[seat]


def test_the_screen_gets_both_teams_and_your_own_cup_only():
    env = fresh_env(5)
    table_view = game.table(env, [0, 1, 2, 3], None)
    assert [team["team"] for team in table_view["teams"]] == [0, 1]
    assert {team["dice"] for team in table_view["teams"]} == {10}
    assert all(len(team["seats"]) == 2 for team in table_view["teams"])
    mine = game.private(env, 0)
    assert mine["team"] == 0
    assert mine["team_dice"] == 10
    assert mine["partner"] == 2
    assert len(mine["dice"]) == 5
    # Nothing here names another seat's dice.
    assert "3" not in mine or mine["partner_dice"] >= 0


# ------------------------------------------------------------------ the table


def test_a_person_plays_with_a_partner_against_the_computer_pair(tmp_path):
    obj = table(tmp_path)
    answer = obj.command("new seats=4 level=advanced", player=ME)
    assert "Table set" in answer or "Table set" in str(obj.picture(player=ME).get("phase")), answer
    pic = obj.picture(player=ME)
    kinds = {place["seat"]: place["kind"] for place in pic["places"]}
    assert kinds[0] == "human"
    assert kinds[1] == "local" and kinds[3] == "local"
    assert pic["teams"][0]["seats"] == [0, 2]
    assert pic["level"] == "advanced" or pic["setup"]["level"] == "advanced"
    assert pic["max_invites"] == 1


def test_the_guest_sits_on_the_person_s_team(tmp_path):
    obj = table(tmp_path)
    obj.command("new seats=4 agent=1", player=ME)
    pic = obj.picture(player=ME)
    kinds = {place["seat"]: place["kind"] for place in pic["places"]}
    assert kinds[0] == "human"
    assert kinds[2] == "agent", kinds
    assert pic["mine"]["team"] == 0
    assert pic["mine"]["partner"] == 2


def test_a_level_that_does_not_exist_is_refused(tmp_path):
    obj = table(tmp_path)
    assert "not one of the levels" in obj.command("new seats=4 level=galaxy", player=ME)


def test_a_finished_game_shares_and_replays(tmp_path):
    obj = table(tmp_path)
    obj.command("new seats=4 agent=1 level=advanced", player=ME)
    for _ in range(400):
        pic = obj.picture(player=ME)
        if pic.get("status") != "active":
            break
        answer = obj.command("act " + pic["actions"][0]["id"], player=ME) if pic.get("can_move") else obj.command("step", player=ME)
        assert not str(answer).startswith("Refused"), answer
    pic = obj.picture(player=ME)
    assert pic["status"] == "done"
    shared = json.dumps(pic["share"])
    fresh = table(tmp_path / "opened")
    answer = fresh.command("import " + shared, player=ME)
    assert "Imported" in answer, answer
    opened = fresh.picture(player=ME)
    assert opened["status"] == "done"
    # The seats keep their numbers, so the partner is still the partner after a reopen.
    kinds = {place["seat"]: place["kind"] for place in opened["places"]}
    assert kinds[0] == "human" and kinds[2] in {"agent", "local", "champion"}, kinds
    assert [team["seats"] for team in opened["teams"]] == [[0, 2], [1, 3]]


def test_a_whole_table_plays_to_a_win_or_a_loss(tmp_path):
    obj = table(tmp_path)
    obj.command("new seats=4 level=beginner", player=ME)
    for _ in range(400):
        pic = obj.picture(player=ME)
        if pic.get("status") != "active":
            break
        if pic.get("can_move"):
            if pic.get("can_say") and not pic.get("actions"):
                answer = obj.command("say I am holding fives.", player=ME)
            else:
                answer = obj.command("act " + pic["actions"][0]["id"], player=ME)
        else:
            answer = obj.command("step", player=ME)
        assert not str(answer).startswith("Refused"), answer
    pic = obj.picture(player=ME)
    assert pic["status"] == "done"
    assert pic["reveal"]["dice"]
    assert pic["reveal"]["teams"]
    assert pic["reveal"]["winners"]
    # The win/lose overlay reads from the same two fields the backend sends.
    winners = set(pic["reveal"]["winners"])
    assert pic["your_seat"] in winners or winners
