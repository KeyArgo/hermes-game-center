"""Chess, Go and Hex: rules checked against known answers, and played through kit.Table."""

from __future__ import annotations

import importlib.util
import random
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parent.parent


def load(name: str):
    spec = importlib.util.spec_from_file_location(f"test_{name}_rules", ROOT / name / "game.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CHESS = load("chessboard")
GO = load("go")
HEX = load("hex")


def start(game) -> dict:
    return {"turn": "white", "status": "active", "winner": "", **game.fresh()}


def from_fen(fen: str) -> dict:
    board, turn, castling, ep, half, *_ = fen.split()
    rows = []
    for part in board.split("/"):
        rows.append(list("".join("." * int(ch) if ch.isdigit() else ch for ch in part)))
    rows.reverse()
    return {"board": rows, "turn": "white" if turn == "w" else "black", "castling": "" if castling == "-" else castling,
            "ep": "" if ep == "-" else ep, "halfmove": int(half), "status": "active", "winner": ""}


def perft(state: dict, depth: int) -> int:
    moves = CHESS._legal_moves(state)
    if depth == 1:
        return len(moves)
    return sum(perft(CHESS._child(state, move), depth - 1) for move in moves)


@pytest.mark.parametrize("fen,depth,count", [
    ("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 3, 8902),
    ("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", 2, 2039),
    ("8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", 3, 2812),
    ("r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", 3, 9467),
    ("rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", 2, 1486),
])
def test_chess_move_counts_match_published_perft(fen, depth, count):
    assert perft(from_fen(fen), depth) == count


def test_chess_fools_mate_and_parse():
    state = start(CHESS)
    for move in ("f2f3", "e7e5", "g2g4"):
        CHESS.play(state, move)
    assert CHESS.parse(["d8h4"]) == "d8h4" and CHESS.parse(["e7e8q"]) == "e7e8q" and CHESS.parse(["Nf3"]) is None
    assert CHESS.play(state, "d8h4") == "Checkmate."
    assert state["status"] == "win" and state["winner"] == "black"


def test_chess_stalemate_and_repetition():
    state = from_fen("7k/5Q2/6K1/8/8/8/8/8 w - - 0 1")
    assert CHESS.play(state, "f7f8") == "Checkmate."  # queen f8 with king g6: no escape
    state = from_fen("7k/8/5QK1/8/8/8/8/8 w - - 0 1")
    assert CHESS.play(state, "f6f7") == "Stalemate." and state["status"] == "draw"
    state = start(CHESS)
    for move in ("g1f3", "g8f6", "f3g1", "f6g8") * 2:
        CHESS.play(state, move)
    assert state["status"] == "draw"


def test_go_capture_suicide_ko_and_score():
    state = start(GO)
    for move in ("a2", "a1", "b1"):
        GO.play(state, move)
    assert state["board"][0][0] == "." and state["captured"]["X"] == 1
    state = start(GO)
    for move in ("b1", "c1", "a2", "d2", "b3", "c3", "pass", "b2", "c2"):
        assert move in GO.legal(state)
        GO.play(state, move)
    assert "b2" not in GO.legal(state), "ko retake must be refused"
    state = start(GO)
    GO.play(state, "pass")
    GO.play(state, "pass")
    assert state["status"] == "win" and state["winner"] == "black"  # komi decides an empty board


def test_go_suicide_refused():
    state = start(GO)
    for move in ("a2", "e5", "b1"):
        GO.play(state, move)
    assert "a1" not in GO.legal(state)


def test_the_counted_win_gives_the_desktop_its_count():
    """The bug hunt: the Go win card said "Counted up. Computer wins" and no count.

    The totals the game already worked out for its own text board go to the desktop on
    the picture, so the result card can say them without anyone opening Advanced.
    """
    state = start(GO)
    GO.play(state, "pass")
    GO.play(state, "pass")
    pictured = GO.picture(state)
    assert pictured["score_now"] == {"white": 0, "black": 7.5}, pictured["score_now"]
    assert pictured["komi"] == 7.5


def test_hex_connection_swap_and_no_draws():
    state = start(HEX)
    HEX.play(state, "c2")
    assert "swap" in HEX.legal(state)
    HEX.play(state, "swap")
    assert state["board"][2][1] == "O" and state["board"][1][2] == "." and state["turn"] == "white"
    assert "swap" not in HEX.legal(state)
    random.seed(7)
    for _ in range(5):
        state = start(HEX)
        while state["status"] == "active":
            HEX.play(state, random.choice(HEX.legal(state)))
        assert state["status"] == "win"


@pytest.mark.parametrize("name", ["chessboard", "go", "hex"])
def test_bot_plays_a_whole_game_through_the_table(tmp_path, name):
    game = load(name)
    table = game.create(tmp_path)
    host = SimpleNamespace(id="web:host", name="Host", platform="web", bot=False)
    answer = table.command("allow-ai white=local black=local", player=host)
    assert "Refused" not in answer
    for _ in range(game.MAX_PLIES + 2):
        picture = table.picture()
        if picture["status"] != "active":
            break
        table.command("step", player=host)
    picture = table.picture()
    assert picture["status"] in {"win", "draw"}
    assert picture["view"] in {"chess", "gomoku", "hex"}


def test_review_fixes(tmp_path):
    assert HEX.fresh()["swapped"] is False
    assert CHESS._too_little(from_fen("4k3/8/8/2b5/8/8/3B4/4K3 w - - 0 1")["board"])  # c5 and d2: same colour
    assert not CHESS._too_little(from_fen("4k3/8/8/2b5/8/8/4B3/4K3 w - - 0 1")["board"])
    state = start(GO)
    state["plies"] = GO.MAX_PLIES - 1
    GO.play(state, "e5")
    assert state["status"] == "win" and state["result_reason"] == "score"
    state = start(CHESS)
    for move in ("e2e4", "g8f6", "g1f3", "f6g8", "f3g1", "g8f6", "g1f3", "f6g8", "f3g1"):
        CHESS.play(state, move)
    assert state["status"] == "draw"
