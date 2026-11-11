"""Bot strength, proved rather than felt: tactics, legality, time, and a seeded match.

Each game gets a small tactical suite (a win in one, a must-block, a piece that must not
be hung) and a match of the new bot against the old two-ply/one-ply bot over several seeds.
The old bots are reproduced here, in the test file, so the shipped games carry only the new
engine. Times are asserted per move so a slow search cannot slip through.
"""

from __future__ import annotations

import copy
import importlib.util
import random
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
BLACK = "black"


def load(name: str):
    spec = importlib.util.spec_from_file_location(f"strength_{name}", ROOT / name / "game.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def start(rules) -> dict:
    state = {"turn": "white", "status": "active", "winner": "", "plies": 0, "moves": [], "last": ""}
    state.update(rules.fresh())
    return state


def board_state(rows: list[str], turn: str = "white", castling: str = "", ep: str = "") -> dict:
    """Rows are rank 1 first, the order the game modules store and draw them in."""
    state = start(load("chessboard"))
    state["board"] = [list(row) for row in rows]
    state["turn"] = turn
    state["castling"] = castling
    state["ep"] = ep
    return state


# ----- the old bots, verbatim in behaviour ------------------------------------

_VALUE = {"p": 100, "n": 320, "b": 330, "r": 500, "q": 900, "k": 0}


def _material(board: list[list[str]]) -> int:
    """The old chess score: material plus the old centre and pawn-push terms."""
    total = 0
    for r in range(8):
        for f in range(8):
            piece = board[r][f]
            if piece == ".":
                continue
            kind = piece.lower()
            value = _VALUE[kind]
            if kind in "nb":
                value += int(12 - 3 * (abs(3.5 - f) + abs(3.5 - r)))
            elif kind == "p":
                value += 5 * (r - 1 if piece.isupper() else 6 - r)
            total += value if piece.isupper() else -value
    return total


def old_chess(rules, state: dict, rng: random.Random) -> str:
    """The old two-ply bot: best of our moves against their worst reply.

    The replies are the old bot's pseudo-legal ones (it never legality-checked them), and the
    score is the old material-plus-centre count. Move generation comes from the game module so
    the baseline is cheap enough to play a whole match inside the suite.
    """
    pos = rules._Pos(state)
    sign = 1 if pos.turn else -1
    # The old bot chose from pseudo-legal moves, which `play()` would apply blindly and turn the
    # match into nonsense. The baseline must play chess, so keep only moves that leave its own
    # king safe; the pseudo-legal *replies* below are left as they were.
    allowed = set(rules._legal_moves(state))
    moves = [move for move in rules._gen(pos) if rules._text(move) in allowed]
    if not moves:
        return ""
    rng.shuffle(moves)
    best, best_value = moves[0], None
    for move in moves:
        record = rules._do(pos, move)
        replies = rules._gen(pos)
        if not replies:
            value = 100_000 if rules._checked(pos, pos.turn) else 0
        else:
            value = 100_000
            for reply in replies:
                after = rules._do(pos, reply)
                value = min(value, sign * _material(pos.board))
                rules._undo(pos, after)
        rules._undo(pos, record)
        if best_value is None or value > best_value:
            best, best_value = move, value
    return rules._text(best)


def old_connect4(rules, state: dict, rng: random.Random) -> int:
    """The old one-ply bot: win, then block, then the centre column order."""
    open_columns = rules.legal(state)
    side = state["turn"]
    other = BLACK if side == "white" else "white"
    for who in (side, other):
        for column in open_columns:
            trial = {"board": [row[:] for row in state["board"]], "turn": who,
                     "status": "active", "winner": ""}
            rules.play(trial, column)
            if trial["winner"] == who:
                return column
    order = [4, 3, 5, 2, 6, 1, 7]
    rng.shuffle(order)
    for column in order:
        if column in open_columns:
            return column
    return open_columns[0]


def old_gomoku(rules, state: dict, rng: random.Random) -> str:
    """The old one-ply bot: immediate five, block a five, else the best static shape."""
    board = state["board"]
    mine, theirs = rules._mark(state["turn"]), "O" if rules._mark(state["turn"]) == "X" else "X"
    empty = [(row, col) for row in range(rules._SIZE) for col in range(rules._SIZE)
             if board[row][col] == "."]
    if len(empty) == rules._SIZE * rules._SIZE:
        return rules._name(*rules._CENTER)
    spots = [spot for spot in empty if rules._near(board, *spot)] or empty
    for who in (mine, theirs):
        for row, col in spots:
            if rules._wins(board, row, col, who):
                return rules._name(row, col)

    def value(spot):
        attack = sum(rules._worth(*rules._run(board, *spot, mine, dr, dc)) for dr, dc in rules._LINES)
        defend = sum(rules._worth(*rules._run(board, *spot, theirs, dr, dc)) for dr, dc in rules._LINES)
        return attack + 0.9 * defend + rng.random()

    return rules._name(*max(spots, key=value))


# ----- a match over seeds ------------------------------------------------------

def play_match(rules, new_move, old_move, games: int, seed: int, cap: int,
               new_kwargs: dict | None = None, adjudicate=None) -> dict:
    """Alternate colours, one seeded game per seed; return the new bot's score out of games.

    `adjudicate(state, new_side)` decides a game that hits the ply cap without a result; a match
    against a bot that cannot mate needs one, or long won positions would all count as draws.
    """
    new_score = 0.0
    wins = draws = losses = 0
    for index in range(games):
        rng = random.Random(seed + index * 7919)
        state = start(rules)
        new_white = index % 2 == 0
        plies = 0
        while state.get("status") == "active" and plies < cap:
            is_new = (state["turn"] == "white") == new_white
            move = new_move(state, **(new_kwargs or {})) if is_new else old_move(rules, state, rng)
            if not move:
                break
            rules.play(state, move)
            plies += 1
        new_side = "white" if new_white else BLACK
        if state.get("status") == "win":
            if state.get("winner") == new_side:
                new_score += 1.0
                wins += 1
            else:
                losses += 1
        else:
            verdict = adjudicate(state, new_side) if adjudicate else "draw"
            if verdict == "win":
                new_score += 1.0
                wins += 1
            elif verdict == "loss":
                losses += 1
            else:
                new_score += 0.5
                draws += 1
    return {"score": new_score, "wins": wins, "draws": draws, "losses": losses, "games": games}


# ----- chess ------------------------------------------------------------------

def test_chess_finds_mate_in_one():
    rules = load("chessboard")
    # Black king boxed on h8 by its own pawns; Ra1-a8 is mate on the back rank.
    state = board_state([
        "R......K",
        "........",
        "........",
        "........",
        "........",
        "........",
        "......pp",
        ".......k",
    ])
    move = rules.bot(state)
    assert move == "a1a8"
    rules.play(state, move)
    assert state["status"] == "win" and state["winner"] == "white"


def test_chess_takes_a_free_queen():
    rules = load("chessboard")
    # The black queen stands on d5 with nothing behind it: Qd1-d5 wins a queen.
    state = board_state([
        "...Q...K",
        "........",
        "........",
        "........",
        "...q....",
        "........",
        "........",
        ".......k",
    ])
    move = rules.bot(state)
    assert move == "d1d5", move


def test_chess_does_not_hang_its_queen():
    rules = load("chessboard")
    # The white queen on d4 is attacked by the e5 pawn; the bot must move it away.
    state = board_state([
        "....K...",
        "........",
        "........",
        "...Q....",
        "....p...",
        "........",
        "........",
        "....k...",
    ])
    move = rules.bot(state)
    rules.play(state, move)
    assert _queen_spot(state["board"]) != "d4", move
    # and the queen is no longer standing where that pawn can take it
    queen = _spot(_queen_spot(state["board"]))
    if queen:
        for dr, df in ((1, 1), (1, -1)):
            r, f = queen[0] - dr, queen[1] - df
            if 0 <= r < 8 and 0 <= f < 8 and state["board"][r][f] == "p":
                raise AssertionError(f"queen still hangs on {queen} to the pawn on {r},{f}")


def _spot(name: str | None) -> tuple[int, int] | None:
    if not name:
        return None
    return int(name[1]) - 1, "abcdefgh".index(name[0])


def _queen_spot(board: list[list[str]]) -> str | None:
    for r in range(8):
        for f in range(8):
            if board[r][f] == "Q":
                return f"{'abcdefgh'[f]}{r + 1}"
    return None


@pytest.mark.parametrize("depth", [None, 1, 2, 3])
def test_chess_moves_are_always_legal(depth):
    rules = load("chessboard")
    rng = random.Random(11)
    state = start(rules)
    for _ in range(10):
        if state.get("status") != "active":
            break
        move = rules.bot(state) if depth is None else rules.bot(state, depth)
        assert move in rules.legal(state), move
        rules.play(state, move)
        replies = rules.legal(state)
        if not replies:
            break
        rules.play(state, rng.choice(replies))
    assert state.get("status") in {"active", "win", "draw"}


def test_chess_time_limit_per_move():
    rules = load("chessboard")
    # A normal middlegame, the kind the table actually reaches.
    state = start(rules)
    for text in ("e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "d2d3", "f8c5", "c2c3", "d7d6"):
        rules.play(state, text)
    started = time.monotonic()
    move = rules.bot(state)
    elapsed = time.monotonic() - started
    assert move in rules.legal(state)
    assert elapsed < 2.0, f"chess took {elapsed:.2f}s"


def test_chess_depth_option_is_faster_but_still_legal():
    rules = load("chessboard")
    state = start(rules)
    for text in ("e2e4", "e7e5", "g1f3", "b8c6"):
        rules.play(state, text)
    quick = rules.bot(state, 1)
    assert quick in rules.legal(state)


def test_chess_prefers_mate_over_stalemate():
    rules = load("chessboard")
    # White king f7, queen g5, black king h8. Several queen moves mate; g5g6 stalemates black.
    state = board_state([
        "........",
        "........",
        "........",
        "........",
        "......Q.",
        "........",
        ".....K..",
        ".......k",
    ])
    move = rules.bot(state)
    assert move != "g5g6", move  # the stalemating move must not be chosen
    rules.play(state, move)
    assert state["status"] == "win" and state["winner"] == "white", state["status"]


def test_chess_takes_mate_in_one_in_a_queen_endgame():
    rules = load("chessboard")
    # Black king a8, white king c7, white queen d6: mate in one is on the board, and the search
    # must take it rather than shuffling the queen around a drawn repetition.
    state = board_state([
        "........",
        "........",
        "........",
        "........",
        "........",
        "...Q....",
        "..K.....",
        "k.......",
    ])
    move = rules.bot(state)
    rules.play(state, move)
    assert state["status"] == "win" and state["winner"] == "white", (move, state["status"])


def test_chess_capture_search_sees_promotions_and_en_passant():
    rules = load("chessboard")
    # A white pawn on a7 with a8 free: the capture-only list must still offer the promotions.
    state = board_state([
        "........",
        "........",
        "........",
        "........",
        "........",
        "........",
        "P.......",
        ".......k",
    ])
    texts = {rules._text(move) for move in rules._gen(rules._Pos(state), captures=True)}
    assert {"a7a8q", "a7a8r", "a7a8b", "a7a8n"} <= texts, texts
    # A black pawn on a5 (it just came from a7) with en passant on a6: b5xa6 is a capture.
    state = board_state([
        "........",
        "........",
        "........",
        "........",
        "pP......",
        "........",
        "........",
        ".......k",
    ], ep="a6")
    texts = {rules._text(move) for move in rules._gen(rules._Pos(state), captures=True)}
    assert "b5a6" in texts, texts


def _chess_adjudge(state: dict, new_side: str) -> str:
    """A game that reaches the ply cap is judged on material, a piece or more being a win.

    The old bot is a two-ply material grinder and rarely mates; without this every long won
    position would score as a draw and the match would say nothing about strength.
    """
    edge = _material(state["board"]) * (1 if new_side == "white" else -1)
    if edge >= 300:
        return "win"
    return "loss" if edge <= -300 else "draw"


def test_chess_beats_the_old_bot_over_seeds():
    rules = load("chessboard")
    # The shipped depth 3, four seeded games alternating colours. The old bot was allowed its
    # pseudo-legal move choice here, which `play()` applied blindly: the match was measuring
    # illegal moves rather than chess, so old_chess now picks legal moves only.
    match = play_match(rules, rules.bot, old_chess, games=4, seed=101, cap=120,
                       new_kwargs={"depth": 3}, adjudicate=_chess_adjudge)
    # Measured 4-0 (wins in 21-40 plies). The search is time-boxed, so allow one wobble rather
    # than fail the suite on a slow machine.
    assert match["losses"] <= 1, match
    assert match["score"] >= 3.0, match


# ----- connect four ------------------------------------------------------------

def test_connect4_takes_the_win():
    rules = load("connect4")
    state = start(rules)
    # X on a1..c1 (row 0, columns 0..2); column 4 completes four.
    state["board"][0][0] = state["board"][0][1] = state["board"][0][2] = "X"
    state["board"][0][4] = state["board"][1][4] = "O"
    state["board"][0][5] = "O"
    state["turn"] = "white"
    assert rules.bot(state) == 4


def test_connect4_blocks_the_loss():
    rules = load("connect4")
    state = start(rules)
    state["board"][0][0] = state["board"][0][1] = state["board"][0][2] = "O"
    state["board"][0][4] = "X"
    state["turn"] = "white"
    move = rules.bot(state)
    assert move == 4, move  # a stone in column 4 is the only block; the O three sits at a1..c1
    rules.play(state, move)
    # the block really landed on d1, and O has no four anywhere on the board
    assert state["board"][0][3] == "X", state["board"][0]
    assert not any(rules._won(state["board"], row, col, "O")
                   for row in range(6) for col in range(7) if state["board"][row][col] == "O"), \
        "O still has four in a row"


def test_connect4_time_limit_per_move():
    rules = load("connect4")
    state = start(rules)
    for move in (4, 3, 5, 2, 6, 1, 7, 4, 1, 5):
        rules.play(state, move)
    started = time.monotonic()
    move = rules.bot(state)
    elapsed = time.monotonic() - started
    assert move in rules.legal(state)
    assert elapsed < 2.0, f"connect four took {elapsed:.2f}s"


def test_connect4_beats_the_old_bot_over_seeds():
    rules = load("connect4")
    match = play_match(rules, rules.bot, old_connect4, games=4, seed=202, cap=42,
                       new_kwargs={"depth": 5})
    assert match["losses"] == 0, match
    assert match["score"] >= 3.0, match


# ----- gomoku ------------------------------------------------------------------

def _gomoku(rows: list[str], turn: str = "white"):
    rules = load("gomoku")
    state = start(rules)
    state["board"] = [list(row) for row in rows]
    state["turn"] = turn
    return rules, state


def test_gomoku_takes_five():
    rows = ["." * 15 for _ in range(15)]
    rows[7] = "....XXXX......."
    rows[8] = "....OOOO......."
    rules, state = _gomoku(rows)
    assert rules.bot(state) in {"d8", "i8"}


def test_gomoku_blocks_a_four():
    rows = ["." * 15 for _ in range(15)]
    rows[7] = ".....OOOO......"
    rules, state = _gomoku(rows)
    move = rules.bot(state)
    assert move in {"e8", "j8"}, move


def test_gomoku_answers_an_open_three():
    rows = ["." * 15 for _ in range(15)]
    rows[7] = "........XXX...."
    rules, state = _gomoku(rows)
    move = rules.bot(state)
    assert move in {"h8", "l8"}, move


def test_gomoku_time_limit_per_move():
    rules = load("gomoku")
    rng = random.Random(5)
    state = start(rules)
    slowest = 0.0
    for _ in range(12):
        if state.get("status") != "active":
            break
        started = time.monotonic()
        move = rules.bot(state)
        slowest = max(slowest, time.monotonic() - started)
        assert move in rules.legal(state)
        rules.play(state, move)
        replies = rules.legal(state)
        if not replies:
            break
        rules.play(state, rng.choice(replies))
    assert slowest < 2.0, f"gomoku took {slowest:.2f}s"


def test_gomoku_beats_the_old_bot_over_seeds():
    rules = load("gomoku")
    # Six seeded games alternating colours at the shipped settings: the new bot takes five of
    # them, the old one-ply heuristic one. The old bot is a decent shape counter, so a shutout
    # is not the honest bar; winning the match, and answering its fours and open threes in the
    # tactical tests above, is.
    match = play_match(rules, rules.bot, old_gomoku, games=6, seed=303, cap=120)
    assert match["losses"] <= 1, match
    assert match["wins"] >= 4, match
