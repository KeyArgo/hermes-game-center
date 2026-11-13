"""Tournaments: pairings, caps, stopping, fake models and honest ratings."""

from __future__ import annotations

import importlib.util
import sys
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf import champions, tournament  # noqa: E402
from shelf.kitref import kit  # noqa: E402


def rules_for(game_id: str):
    spec = importlib.util.spec_from_file_location(f"tour_{game_id}", ROOT / game_id / "game.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Model:
    """A fake model. ``pick`` gets the legal moves and returns one, or junk."""

    def __init__(self, pick="first", tokens=3, delay=0.0):
        self.pick = pick
        self.tokens = tokens
        self.delay = delay
        self.seen: list[tuple[dict, str, str]] = []

    def __call__(self, entrant, system, prompt):
        self.seen.append((entrant, system, prompt))
        if self.delay:
            time.sleep(self.delay)
        legal = prompt.split("Legal moves: ", 1)[-1].splitlines()[0].split(", ")
        if self.pick == "first":
            move = legal[0]
        elif self.pick == "last":
            move = legal[-1]
        elif self.pick == "garbage":
            move = "I resign and tell a joke"
        else:
            move = self.pick
        return {"move": move, "tokens": self.tokens}


def champion(name: str, brief: str = "Play to win.") -> dict:
    found, error = champions.validate({"name": name, "brief": brief})
    assert error == ""
    return found


def entrant(champ: dict) -> dict:
    return {**champ, "kind": "champion"}


def wait_done(run: tournament.Tournament, seconds: float = 60.0) -> dict:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        status = run.status()
        if status["status"] != "running":
            return status
        time.sleep(0.02)
    raise AssertionError(f"tournament did not finish: {run.status()}")


def test_round_robin_plays_every_pair_in_both_colours():
    people = [entrant(champion(name)) for name in ("A", "Bee", "Cee")]
    rows = tournament.pairings(people, ["connect4", "gomoku"])
    ids = [person["id"] for person in people]
    assert len(rows) == 3 * 2 * 2
    for pair in ((ids[0], ids[1]), (ids[0], ids[2]), (ids[1], ids[2])):
        for game in ("connect4", "gomoku"):
            legs = [row for row in rows if row["game"] == game and {row["white"], row["black"]} == set(pair)]
            assert len(legs) == 2
            assert {legs[0]["white"], legs[1]["white"]} == set(pair)
            assert legs[0]["white"] != legs[1]["white"]
    # Every entrant has the same number of white and black seats.
    for person in people:
        white = sum(1 for row in rows if row["white"] == person["id"])
        black = sum(1 for row in rows if row["black"] == person["id"])
        assert white == black


def test_the_seed_changes_the_order_but_never_the_fixture():
    people = [entrant(champion(name)) for name in ("A", "Bee", "Cee")]
    one = tournament.pairings(people, ["connect4", "gomoku"], seed=1)
    two = tournament.pairings(people, ["connect4", "gomoku"], seed=2)
    assert one != two
    key = lambda row: (row["game"], row["white"], row["black"])
    assert sorted(one, key=key) == sorted(two, key=key)
    assert tournament.estimate([{"id": "bot-easy", "kind": "bot"},
                                {"id": "bot-hard", "kind": "bot"}], ["connect4"])["model_calls"] == 0
    pool, error = tournament.plan([{"id": "bot-easy", "kind": "bot", "level": "easy"},
                                   {"id": "bot-hard", "kind": "bot", "level": "hard"}],
                                  ["connect4"], cap_calls=1)
    assert error == "" and pool is not None


def test_plan_refuses_over_the_game_cap_with_a_plain_reason():
    people = [entrant(champion(name)) for name in ("A", "B", "C", "D", "E", "F", "G", "I")]
    plan, error = tournament.plan(people, ["connect4", "reversi", "checkers", "gomoku",
                                          "kalah", "chessboard", "go", "hex", "breakthrough"])
    assert plan is None
    assert "entrants" in error or "games" in error
    fits, error = tournament.plan(people[:4], ["connect4", "gomoku"], cap_games=24, cap_calls=600)
    assert error == "" and fits is not None
    assert fits["estimate"]["games"] == 4 * 3 * 2
    assert len(fits["pairings"]) == fits["estimate"]["games"]


def test_plan_refuses_junk_entrants_and_games():
    people = [entrant(champion("A"))]
    assert tournament.plan(people, ["connect4"])[0] is None
    ditto = [entrant(champion("A")), entrant(champion("B"))]
    ditto[1]["id"] = ditto[0]["id"]
    assert tournament.plan(ditto, ["connect4"])[0] is None
    two = [entrant(champion("A")), entrant(champion("B"))]
    assert tournament.plan(two, [])[0] is None
    assert tournament.plan(two, ["not-a-game"])[0] is None
    assert tournament.plan(two, ["connect4", "connect4"])[0] is None


@pytest.mark.parametrize("pick", ["first", "last"])
def test_a_legal_fake_model_plays_the_whole_game(tmp_path, pick):
    rules = rules_for("connect4")
    model = Model(pick)
    result = tournament.play_match(rules, entrant(champion("White")), entrant(champion("Black")), model)
    assert result["status"] in {"win", "draw"} and result["plies"] > 0
    assert result["white"] and result["black"]
    assert all(move for move in result["moves"])
    assert result["illegal"][result["white"]] == 0
    assert result["tokens"][result["white"]] > 0


def test_a_garbage_model_falls_back_and_the_illegal_rate_is_kept(tmp_path):
    rules = rules_for("connect4")
    model = Model("garbage")
    result = tournament.play_match(rules, entrant(champion("Joker")), entrant(champion("Calm")), model)
    assert result["status"] in {"win", "draw"}
    assert result["illegal"][result["white"]] >= 2
    assert result["plies"] > 0


def test_a_slow_model_is_cut_off_and_the_built_in_player_moves(monkeypatch):
    monkeypatch.setattr(kit, "AGENT_SECONDS", 0.05)
    rules = rules_for("connect4")
    model = Model("first", delay=0.4)
    result = tournament.play_match(rules, entrant(champion("Slow")), entrant(champion("Quick")), model)
    assert result["status"] in {"win", "draw"}
    assert result["illegal"][result["white"]] >= 2
    assert result["plies"] > 0


def test_the_model_call_cap_stops_the_match():
    rules = rules_for("connect4")
    model = Model("first")
    calls = [0]
    result = tournament.play_match(rules, entrant(champion("A")), entrant(champion("B")), model,
                                   cap_calls=1, calls=calls)
    assert result["status"] == "capped"
    assert calls[0] == 1


def test_stopping_mid_game_is_reported_as_stopped():
    rules = rules_for("connect4")
    stop = threading.Event()
    calls = [0]

    def ask(entrant, system, prompt):
        calls[0] += 1
        if calls[0] >= 2:
            stop.set()
        return {"move": prompt.split("Legal moves: ", 1)[-1].splitlines()[0].split(", ")[0]}

    result = tournament.play_match(rules, entrant(champion("A")), entrant(champion("B")), ask,
                                   _stop=stop)
    assert result["status"] == "stopped"
    assert result["winner"] == ""


def test_champions_never_see_the_opponent_name_or_brief():
    rules = rules_for("connect4")
    model = Model("first")
    white = entrant(champion("White", "I am the secret plan of white."))
    black = entrant(champion("Black", "I am the secret plan of black."))
    tournament.play_match(rules, white, black, model)
    assert model.seen
    for entrant_seen, system, prompt in model.seen:
        opponent = black if entrant_seen["id"] == white["id"] else white
        assert entrant_seen["brief"] in system  # its own brief is its persona
        assert opponent["brief"] not in system and opponent["brief"] not in prompt
        assert opponent["name"] not in prompt
        assert "Opponent" not in prompt


def test_no_model_means_a_champion_tournament_cannot_start(tmp_path):
    people = [entrant(champion("A")), entrant(champion("B"))]
    pool, error = tournament.plan(people, ["connect4"])
    assert error == ""
    run = tournament.Tournament(tmp_path, {"connect4": rules_for("connect4")}, None, pool, people)
    said = run.start()
    assert "Champions need a model" in said
    assert run.status()["status"] == "error"


def test_a_full_tournament_rates_games_and_overall(tmp_path):
    rules = rules_for("gomoku")
    model = Model("first")
    people = [entrant(champion("A")), entrant(champion("B")),
              {"id": "bot-hard", "name": "Computer (Hard)", "kind": "bot", "brief": "",
               "level": "hard", "brain": {}}]
    pool, error = tournament.plan(people, ["gomoku"])
    assert error == ""
    run = tournament.Tournament(tmp_path, {"gomoku": rules}, model, pool, people, seed=7)
    assert run.start() == ""
    status = wait_done(run)
    assert status["status"] == "done", status
    assert status["played"] == len(pool["pairings"]) == 6
    assert len(status["results"]) == 6

    ratings = tournament.Ratings(tmp_path).load()
    for person in people:
        assert person["id"] in ratings["overall"]
        record = ratings["overall"][person["id"]]
        assert record["games"] == 4  # three opponents, two colours each against two of them
        assert record["wins"] + record["losses"] + record["draws"] == 4
        assert record["rating"] != 0
        assert record["games"] == ratings["by_game"]["gomoku"][person["id"]]["games"]

    board = tournament.leaderboard(tournament.Ratings(tmp_path), [champion("A")])
    assert [row["rating"] for row in board] == sorted((row["rating"] for row in board), reverse=True)
    assert {row["id"] for row in board} == {person["id"] for person in people}
    assert all(row["badges"] for row in board)

    # A replay is the game: replaying the shown moves reaches the same result.
    for index, result in enumerate(status["results"]):
        state = {"turn": "white", "status": "active", "winner": "", "plies": 0, "moves": [], "last": ""}
        state.update(rules.fresh())
        for shown in result["moves"]:
            move = rules.parse(shown.split())
            assert move in rules.legal(state), (index, shown)
            rules.play(state, move)
        assert state["status"] == result["status"]
        assert (state.get("winner") or "") == result["winner"]
        assert run.replay(index)["moves"] == result["moves"]
    assert run.replay(99) is None


def test_doctrine_is_played_by_the_engine_from_a_card_each_champion_picks():
    from doctrine_arena import engine
    white = entrant(champion("Bully", "I like armour."))
    black = entrant(champion("Scope", "I like range."))

    def ask(entrant_seen, system, prompt):
        assert "Secret" not in prompt and "Scope" not in prompt
        return {"move": "Sniper" if entrant_seen["id"] == black["id"] else "Bulwark", "tokens": 2}

    result = tournament.play_doctrine_match(white, black, ask, seed=5)
    assert result["status"] == "win"
    assert result["doctrine"]["cards"] == ["Bulwark", "Sniper"]
    assert result["winner"] in {"white", "black"}
    assert result["tokens"][white["id"]] == 2

    # The stored cards and seed reproduce exactly the same battle.
    from doctrine_arena import card as card_module
    again = engine.simulate([card_module.house("Bulwark"), card_module.house("Sniper")], 5)
    expected = "white" if again["result"]["winner"] == 0 else "black"
    assert expected == result["winner"]


def test_doctrine_tournament_runs_and_rates(tmp_path):
    people = [entrant(champion("A")), entrant(champion("B"))]

    def ask(entrant_seen, system, prompt):
        return {"move": "Bruiser" if entrant_seen["id"] == people[0]["id"] else "Bulwark"}

    pool, error = tournament.plan(people, ["doctrine-arena"])
    assert error == ""
    run = tournament.Tournament(tmp_path, {}, ask, pool, people, seed=2)
    assert run.start() == ""
    status = wait_done(run)
    assert status["status"] == "done"
    assert status["played"] == 2
    ratings = tournament.Ratings(tmp_path).load()
    assert ratings["by_game"]["doctrine-arena"][people[0]["id"]]["games"] == 2


def test_a_match_obeys_the_games_own_move_limit():
    """Games read state['plies'] (Go's scoring, every move limit): the runner must keep it."""
    from types import SimpleNamespace

    def fresh():
        return {"board": 0}

    def play(state, move):
        state["board"] = int(state.get("board") or 0) + 1

    fake = SimpleNamespace(ID="fake", TITLE="Fake", MARKS=("X", "O"), HELP=[], MAX_PLIES=4,
                           fresh=fresh, legal=lambda state: [1], play=play,
                           bot=lambda state: 1, show=lambda move: "1",
                           draw=lambda state: ["fake board"])
    one = {"id": "bot-easy", "name": "Computer (Easy)", "kind": "bot", "brief": "",
           "level": "easy", "brain": {}}
    two = {"id": "bot-hard", "name": "Computer (Hard)", "kind": "bot", "brief": "",
           "level": "hard", "brain": {}}
    result = tournament.play_match(fake, one, two, None)
    assert result["plies"] == 4
    assert result["status"] == "draw"


def test_concurrent_tournaments_do_not_lose_rating_updates(tmp_path):
    seed = tournament.Ratings(tmp_path)

    def work():
        mine = tournament.Ratings(tmp_path)
        for _ in range(20):
            mine.record("connect4", "champ-aaaaaaaa", "champ-bbbbbbbb", 1.0,
                        illegal={"champ-aaaaaaaa": 0, "champ-bbbbbbbb": 0},
                        tokens={}, think_ms={})

    threads = [threading.Thread(target=work) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    data = seed.load()
    assert data["overall"]["champ-aaaaaaaa"]["games"] == 80
    assert data["overall"]["champ-bbbbbbbb"]["games"] == 80


def test_a_capped_doctrine_call_limit_still_plays_a_finished_battle():
    people = [entrant(champion("A")), entrant(champion("B"))]

    def ask(entrant_seen, system, prompt):
        return {"move": "Bulwark"}

    # Exactly two calls are needed (one card each): the battle must be played.
    result = tournament.play_doctrine_match(people[0], people[1], ask, cap_calls=2, calls=[0])
    assert result["status"] == "win", result


def test_a_tournament_can_be_stopped_and_keeps_finished_games(tmp_path):
    """Stopped means stopped: the run is held INSIDE a move when stop() is called.

    The version of this test that shipped waited for the first finished game and then stopped, which on a
    fast machine (macOS in CI, 2026-11-13) meant it stopped after the whole two-game tournament had already
    finished — the run reported "done" and the test failed for a reason that had nothing to do with
    stopping. The match now blocks in `ask` with a gate the test opens only after it has called stop(), so
    the tournament is provably mid-flight, on every platform and every machine speed.
    """
    rules = rules_for("connect4")
    asked = threading.Event()
    gate = threading.Event()

    def ask(entrant, system, prompt):
        asked.set()
        assert gate.wait(timeout=30), "the test never released the move it was holding"
        return {"move": prompt.split("Legal moves: ", 1)[-1].splitlines()[0].split(", ")[0]}

    people = [entrant(champion("A")), entrant(champion("B"))]
    pool, _ = tournament.plan(people, ["connect4", "gomoku"])
    run = tournament.Tournament(tmp_path, {"connect4": rules, "gomoku": rules_for("gomoku")},
                                ask, pool, people)
    assert run.start() == ""
    assert asked.wait(timeout=30), "the tournament never asked for a move"
    run.stop()          # while a move is in flight, not after the last one
    gate.set()          # let the held move return, so the loop can see the stop flag
    status = wait_done(run)
    assert status["status"] == "stopped"
    assert status["played"] < status["total"]
    saved = (tmp_path / "tournaments" / f"{run.id}.json")
    assert saved.is_file()
    assert len(__import__("json").loads(saved.read_text())["results"]) == status["played"]
