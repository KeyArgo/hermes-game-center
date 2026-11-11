"""Session games (blackjack, slots) never "finish" — the table stays open.

The Play contract asked every game for a win or a draw, which a session game can never
produce: it settles hands and keeps going. These tests pin the narrower contract that
replaces it, so a session game still has to prove it moves and settles, and a board game
gets no exemption.
"""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location("check_game_session", ROOT / "tools" / "check_game.py")
check_game = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(check_game)


class SessionRules:
    SESSION = True

    def fresh(self):
        return {"status": "active", "hands": 0}

    def legal(self, state):
        return ["bet"]

    def play(self, state, move):
        state["hands"] = int(state["hands"]) + 1

    def bot(self, state):
        return "bet"

    def show(self, move):
        return "bet"

    def parse(self, tokens):
        return tokens[0]


class StalledRules(SessionRules):
    def play(self, state, move):
        return None


def test_a_session_game_stops_at_the_cap():
    played = check_game._play_out(SessionRules(), 1, cap=10)
    assert played["status"] == "active", "a session table is still open when the cap stops it"
    assert played["state"]["hands"] >= 10, played["state"]


def test_a_session_game_that_never_settles_is_not_ok():
    played = check_game._play_out(StalledRules(), 1, cap=10)
    assert check_game._session_ok(played["state"]) is False


def test_a_session_game_that_settles_hands_is_ok():
    played = check_game._play_out(SessionRules(), 1, cap=10)
    assert check_game._session_ok(played["state"]) is True


def test_a_board_game_gets_no_exemption():
    class Board(SessionRules):
        SESSION = False

    assert check_game._is_session(Board()) is False
    assert check_game._is_session(SessionRules()) is True
