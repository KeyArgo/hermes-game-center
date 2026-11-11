"""The referee refuses illegal moves and leaves the game exactly as it was.

Every test here goes through the same door a person uses (``kit.Table.command``
or a talking table's ``command``), sends a move the rules do not allow, and
checks two things: the answer is a plain sentence saying why, and the saved game
did not change. The last two tests send the illegal move from a model seat and
check the seat is covered by the built-in player instead, so play carries on.
"""

from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf.who import Player  # noqa: E402
from talktable.engine import create as talk_create  # noqa: E402
from talktable.games import liarsdice  # noqa: E402


def load(name: str):
    spec = importlib.util.spec_from_file_location(f"referee_{name}", ROOT / name / "game.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def board_table(module, tmp_path: Path):
    folder = tmp_path / module.ID
    folder.mkdir(parents=True, exist_ok=True)
    return module.create(folder)


def people():
    return Player("irc:ada", "Ada", "irc"), Player("irc:bea", "Bea", "irc")


def two_humans(module, tmp_path: Path):
    tab = board_table(module, tmp_path)
    ada, bea = people()
    started = tab.command("new white=human black=human", player=ada)
    assert "Refused" not in started, started
    sat = tab.command("sit black", player=bea)
    assert "Refused" not in sat, sat
    return tab, ada, bea


def state_bytes(tab) -> bytes:
    return (tab.root / "state.json").read_bytes()


def saved_state(module, tab) -> dict:
    return module.kit.load(tab.root)


def save_state(module, tab, state: dict) -> None:
    module.kit.write(tab.root, state)


def sentence(reply: str) -> str:
    """The plain sentence a refusal must carry, not a board dump or a move report."""
    text = str(reply or "").strip()
    assert text, "the referee answered with nothing"
    assert not text.startswith("Played"), text
    found = re.search(r"[A-Z][^.!?]*[.!?]", text)
    assert found, f"no plain sentence in the refusal: {text!r}"
    return found.group(0)


def refused(tab, command: str, player, expected: str = "") -> str:
    before = state_bytes(tab)
    reply = tab.command(command, player=player)
    assert sentence(reply)
    if expected:
        assert expected in reply, f"{command!r}: expected {expected!r} in {reply!r}"
    assert state_bytes(tab) == before, f"{command!r} changed the saved game"
    return reply


def from_fen(fen: str) -> dict:
    board, turn, castling, ep, half, *_ = fen.split()
    rows = []
    for part in board.split("/"):
        rows.append(list("".join("." * int(ch) if ch.isdigit() else ch for ch in part)))
    rows.reverse()
    return {"board": rows, "turn": "white" if turn == "w" else "black",
            "castling": "" if castling == "-" else castling,
            "ep": "" if ep == "-" else ep, "halfmove": int(half),
            "status": "active", "winner": "", "seen": []}


# ------------------------------------------------------------------ chess


def test_chess_moving_out_of_turn_is_refused(tmp_path):
    chess = load("chessboard")
    tab, ada, _bea = two_humans(chess, tmp_path)
    assert tab.command("move e2e4", player=ada).startswith("Played e2e4")
    refused(tab, "move d2d4", ada, "It's Bea's turn.")


def test_chess_capturing_your_own_piece_is_refused(tmp_path):
    chess = load("chessboard")
    tab, ada, _bea = two_humans(chess, tmp_path)
    # a1 rook cannot take the white pawn on a2.
    refused(tab, "move a1a2", ada, "That's your own piece.")


def test_chess_castling_through_check_is_refused(tmp_path):
    chess = load("chessboard")
    tab, ada, _bea = two_humans(chess, tmp_path)
    # Black rook f7 covers f1, so e1g1 castles through an attacked square.
    state = saved_state(chess, tab)
    state.update(from_fen("4k3/5r2/8/8/8/8/8/4K2R w K - 0 1"))
    save_state(chess, tab, state)
    assert "e1g1" not in chess.legal(saved_state(chess, tab))
    refused(tab, "move e1g1", ada, "Castling through check isn't allowed.")


def test_chess_moving_into_check_is_refused(tmp_path):
    chess = load("chessboard")
    tab, ada, _bea = two_humans(chess, tmp_path)
    # The e2 rook is pinned by the e8 rook; e2a2 would expose the white king.
    state = saved_state(chess, tab)
    state.update(from_fen("4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1"))
    save_state(chess, tab, state)
    assert "e2a2" not in chess.legal(saved_state(chess, tab))
    refused(tab, "move e2a2", ada, "That move would leave your king in check.")


# --------------------------------------------------------------- connect four


def test_connect4_full_column_is_refused(tmp_path):
    connect4 = load("connect4")
    tab, ada, bea = two_humans(connect4, tmp_path)
    for player in (ada, bea, ada, bea, ada, bea):
        assert tab.command("move 1", player=player).startswith("Played 1")
    assert "1" not in [str(column) for column in connect4.legal(saved_state(connect4, tab))]
    refused(tab, "move 1", ada, "That column is full.")


def test_connect4_column_that_does_not_exist_is_refused(tmp_path):
    connect4 = load("connect4")
    tab, ada, _bea = two_humans(connect4, tmp_path)
    refused(tab, "move 8", ada, "There is no column 8.")


def test_connect4_moving_after_the_game_ended_is_refused(tmp_path):
    connect4 = load("connect4")
    tab, ada, bea = two_humans(connect4, tmp_path)
    for player, column in ((ada, 1), (bea, 2), (ada, 1), (bea, 2),
                           (ada, 1), (bea, 2), (ada, 1)):
        tab.command(f"move {column}", player=player)
    state = saved_state(connect4, tab)
    assert state["status"] == "win" and state["winner"] == "white"
    before = state_bytes(tab)
    reply = tab.command("move 3", player=bea)
    assert "Game over" in reply, reply
    assert state_bytes(tab) == before


# ------------------------------------------------------------------ checkers


def test_checkers_non_capture_when_a_capture_is_compulsory_is_refused(tmp_path):
    checkers = load("checkers")
    tab, ada, _bea = two_humans(checkers, tmp_path)
    board = [["." for _ in range(8)] for _ in range(8)]
    board[0][0] = "x"   # a1
    board[2][2] = "x"   # c3
    board[3][3] = "o"   # d4
    state = saved_state(checkers, tab)
    state.update({"board": board, "turn": "white", "quiet": 0,
                  "status": "active", "winner": ""})
    save_state(checkers, tab, state)
    assert checkers.legal(saved_state(checkers, tab)) == [("c3", "e5")]
    refused(tab, "move a1 b2", ada, "You must capture: Checkers makes captures compulsory.")


def test_checkers_moving_an_opponents_piece_is_refused(tmp_path):
    checkers = load("checkers")
    tab, ada, _bea = two_humans(checkers, tmp_path)
    board = [["." for _ in range(8)] for _ in range(8)]
    board[0][0] = "x"   # a1
    board[2][2] = "x"   # c3
    board[3][3] = "o"   # d4
    state = saved_state(checkers, tab)
    state.update({"board": board, "turn": "white", "quiet": 0,
                  "status": "active", "winner": ""})
    save_state(checkers, tab, state)
    # Black's d4 tries to move on White's turn.
    refused(tab, "move d4 c3", ada, "That's not your piece.")


# --------------------------------------------------------------- hex or go


def test_hex_occupied_cell_is_refused(tmp_path):
    hex_game = load("hex")
    tab, ada, bea = two_humans(hex_game, tmp_path)
    assert tab.command("move f6", player=ada).startswith("Played f6")
    assert "f6" not in hex_game.legal(saved_state(hex_game, tab))
    refused(tab, "move f6", bea, "That cell is taken.")


def test_go_occupied_point_is_refused(tmp_path):
    go = load("go")
    tab, ada, bea = two_humans(go, tmp_path)
    assert tab.command("move e5", player=ada).startswith("Played e5")
    assert "e5" not in go.legal(saved_state(go, tab))
    refused(tab, "move e5", bea, "That point is taken.")


# --------------------------------------------------------------- liar's dice


def talk_table(tmp_path: Path, **settings):
    data = tmp_path / "data"
    folder = data / "liars-dice"
    folder.mkdir(parents=True, exist_ok=True)
    return talk_create(folder, "liars-dice", {"data_root": str(data), **settings})


def current_bid(tab):
    state = tab._load()
    env, _index, _trace = tab._env(state)
    bid = env.state.game_state.get("current_bid") or {}
    return liarsdice.current(env), int(bid.get("quantity") or 0), int(bid.get("face_value") or 0)


def test_liars_dice_a_bid_that_does_not_raise_is_refused(tmp_path):
    tab = talk_table(tmp_path)
    ada = Player("desktop:ada", "Ada", "desktop")
    assert "Table set" in tab.command("new seats=2 seed=31", player=ada)
    assert tab.command("act [Bid: 1, 1]", player=ada) == "Played."
    for _ in range(40):
        seat, quantity, _face = current_bid(tab)
        if seat == 0 and quantity:
            break
        tab.command("step", player=ada)
    seat, quantity, face = current_bid(tab)
    assert seat == 0 and quantity > 0, (seat, quantity, face)
    before = tab._load()
    reply = tab.command(f"act [Bid: {quantity}, {face}]", player=ada)
    assert "Your bid must raise the last bid." in reply, reply
    assert tab._load() == before


# --------------------------------------------------------------- model seats


class BadModel:
    """Stands in for a model that keeps sending something the rules refuse."""

    def __init__(self, answer: str):
        self.answer = answer
        self.prompts: list[str] = []

    def __call__(self, prompt: str) -> dict:
        self.prompts.append(prompt)
        return {"move": self.answer, "remark": "", "tokens": 1}


def test_a_model_seat_cannot_play_an_illegal_board_move(tmp_path):
    connect4 = load("connect4")
    tab = board_table(connect4, tmp_path)
    ada = Player("desktop:ada", "Ada", "desktop")
    model = BadModel("banana")
    started = tab.command("allow-ai black=agent", complete=model, player=ada)
    assert "Your agent" in started, started
    reply = tab.command("move 4", complete=model, player=ada)
    assert "Agent played" in reply and "gave no legal move" in reply, reply
    assert "built-in player chose" in reply, reply
    assert model.prompts, "the model was never asked"
    state = saved_state(connect4, tab)
    assert state["plies"] == 2 and state["turn"] == "white" and state["status"] == "active"
    assert state["moves"][-1] in {str(column) for column in range(1, 8)}, state["moves"]
    assert state["moves"] == ["4", state["moves"][-1]]


def test_a_model_seat_cannot_play_an_illegal_liars_dice_bid(tmp_path):
    tab = talk_table(tmp_path)
    ada = Player("desktop:ada", "Ada", "desktop")
    model = BadModel("I have no idea")
    started = tab.command("new seats=2 agent=1 seed=31", complete=model, player=ada)
    assert "Table set" in started and "model" in started.lower(), started
    assert tab.command("act [Bid: 1, 1]", complete=model, player=ada) == "Played."
    reply = tab.command("step", complete=model, player=ada)
    assert "gave no legal action" in reply, reply
    assert "built-in player played that turn" in reply, reply
    assert model.prompts, "the model seat was never asked"
    state = tab._load()
    assert state["calls"]["illegal"] >= 1
    actions = state["sessions"][0]["actions"]
    assert actions[-1]["seat"] == 1, actions
    assert actions[-1]["raw"] != "I have no idea"
    env, _index, _trace = tab._env(state)
    assert not liarsdice.done(env) or state["status"] == "active"
