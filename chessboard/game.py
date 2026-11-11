"""Chess. Moves are from-square then to-square: e2e4, castle e1g1, promote e7e8q.

Written for this plugin (MIT). Draws: stalemate, fifty moves, threefold repetition, too little material.
"""

from __future__ import annotations

import importlib.util
import sys
import time
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
# Load this plugin's own kit.py under a name no other plugin can claim. A plain
# `import kit` would hand us another plugin's module when both ship a kit.py.
_KIT_NAME = "hermes_gameshelf_kit"
if _KIT_NAME not in sys.modules:
    _kit_spec = importlib.util.spec_from_file_location(_KIT_NAME, _ROOT / "kit.py")
    _kit_module = importlib.util.module_from_spec(_kit_spec)
    sys.modules[_KIT_NAME] = _kit_module
    _kit_spec.loader.exec_module(_kit_module)
kit = sys.modules[_KIT_NAME]

ID = "chessboard"
TITLE = "Chess"
MARKS = ("White", "Black")
EXAMPLE = "move e2e4"
MAX_PLIES = 600
HELP = [
    "Move with from and to squares: move e2e4. Castle by moving the king: move e1g1.",
    "Promote with a letter: move e7e8q (q, r, b or n).",
]

_FILES = "abcdefgh"
_START = [
    "RNBQKBNR",
    "PPPPPPPP",
    "........",
    "........",
    "........",
    "........",
    "pppppppp",
    "rnbqkbnr",
]
_KNIGHT = ((1, 2), (2, 1), (2, -1), (1, -2), (-1, -2), (-2, -1), (-2, 1), (-1, 2))
_KING = ((1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1))
_ROOK = ((1, 0), (-1, 0), (0, 1), (0, -1))
_BISHOP = ((1, 1), (1, -1), (-1, 1), (-1, -1))
_VALUE = {"p": 100, "n": 320, "b": 330, "r": 500, "q": 900, "k": 0}


def create(root: Path, settings: dict | None = None):
    del settings
    return kit.Table(Path(root), kit.rules(globals()))


def fresh() -> dict:
    return {
        "board": [list(row) for row in _START],
        "castling": "KQkq",
        "ep": "",
        "halfmove": 0,
        "turn": "white",
        "seen": [],
    }


# ----- squares and positions -------------------------------------------------

def _name(rank: int, file: int) -> str:
    return f"{_FILES[file]}{rank + 1}"


def _spot(text: str) -> tuple[int, int] | None:
    if len(text) != 2 or text[0] not in _FILES or text[1] not in "12345678":
        return None
    return int(text[1]) - 1, _FILES.index(text[0])


def _white(piece: str) -> bool:
    return piece.isupper()


def _mine(piece: str, white: bool) -> bool:
    return piece != "." and _white(piece) == white


def _key(state: dict) -> str:
    """Position for the repetition rule. The en passant square counts only if a pawn can take there."""
    rows = "/".join("".join(row) for row in state["board"])
    ep = state["ep"] or "-"
    if ep != "-":
        rank, file = _spot(ep) or (0, 0)
        pawn, from_rank = ("P", rank - 1) if state["turn"] == "white" else ("p", rank + 1)
        if not any(0 <= file + df < 8 and state["board"][from_rank][file + df] == pawn for df in (-1, 1)):
            ep = "-"
    return f"{rows} {state['turn'][0]} {state['castling'] or '-'} {ep}"


def _attacked(board: list[list[str]], rank: int, file: int, by_white: bool) -> bool:
    """Is (rank, file) attacked by the side by_white?"""
    pawn_rank = rank - 1 if by_white else rank + 1
    pawn = "P" if by_white else "p"
    for df in (-1, 1):
        f = file + df
        if 0 <= pawn_rank < 8 and 0 <= f < 8 and board[pawn_rank][f] == pawn:
            return True
    knight = "N" if by_white else "n"
    for dr, df in _KNIGHT:
        r, f = rank + dr, file + df
        if 0 <= r < 8 and 0 <= f < 8 and board[r][f] == knight:
            return True
    king = "K" if by_white else "k"
    for dr, df in _KING:
        r, f = rank + dr, file + df
        if 0 <= r < 8 and 0 <= f < 8 and board[r][f] == king:
            return True
    for steps, sliders in ((_ROOK, "RQ"), (_BISHOP, "BQ")):
        mine = sliders if by_white else sliders.lower()
        for dr, df in steps:
            r, f = rank + dr, file + df
            while 0 <= r < 8 and 0 <= f < 8:
                piece = board[r][f]
                if piece != ".":
                    if piece in mine:
                        return True
                    break
                r += dr
                f += df
    return False


def _king(board: list[list[str]], white: bool) -> tuple[int, int] | None:
    target = "K" if white else "k"
    for r in range(8):
        for f in range(8):
            if board[r][f] == target:
                return r, f
    return None


def _in_check(board: list[list[str]], white: bool) -> bool:
    spot = _king(board, white)
    return spot is not None and _attacked(board, spot[0], spot[1], not white)


# ----- move generation -------------------------------------------------------

def _pseudo(state: dict) -> list[str]:
    board = state["board"]
    white = state["turn"] == "white"
    moves: list[str] = []
    for r in range(8):
        for f in range(8):
            piece = board[r][f]
            if not _mine(piece, white):
                continue
            kind = piece.lower()
            here = _name(r, f)
            if kind == "p":
                step = 1 if white else -1
                start = 1 if white else 6
                last = 7 if white else 0
                ahead = r + step
                if 0 <= ahead < 8 and board[ahead][f] == ".":
                    _pawn_to(moves, here, ahead, f, last)
                    if r == start and board[r + 2 * step][f] == ".":
                        moves.append(here + _name(r + 2 * step, f))
                for df in (-1, 1):
                    tf = f + df
                    if not (0 <= ahead < 8 and 0 <= tf < 8):
                        continue
                    target = board[ahead][tf]
                    if target != "." and not _mine(target, white):
                        _pawn_to(moves, here, ahead, tf, last)
                    elif _name(ahead, tf) == state["ep"]:
                        moves.append(here + _name(ahead, tf))
            elif kind in "nk":
                for dr, df in (_KNIGHT if kind == "n" else _KING):
                    tr, tf = r + dr, f + df
                    if 0 <= tr < 8 and 0 <= tf < 8 and not _mine(board[tr][tf], white):
                        moves.append(here + _name(tr, tf))
            else:
                steps = _ROOK if kind == "r" else _BISHOP if kind == "b" else _ROOK + _BISHOP
                for dr, df in steps:
                    tr, tf = r + dr, f + df
                    while 0 <= tr < 8 and 0 <= tf < 8:
                        target = board[tr][tf]
                        if _mine(target, white):
                            break
                        moves.append(here + _name(tr, tf))
                        if target != ".":
                            break
                        tr += dr
                        tf += df
    moves.extend(_castles(state, white))
    return moves


def _pawn_to(moves: list[str], here: str, rank: int, file: int, last: int) -> None:
    there = _name(rank, file)
    if rank == last:
        moves.extend(here + there + promo for promo in "qrbn")
    else:
        moves.append(here + there)


def _castles(state: dict, white: bool) -> list[str]:
    board = state["board"]
    rank = 0 if white else 7
    king, rook = ("K", "R") if white else ("k", "r")
    rights = state["castling"]
    found: list[str] = []
    if board[rank][4] != king or _attacked(board, rank, 4, not white):
        return found
    short, long = ("K", "Q") if white else ("k", "q")
    if short in rights and board[rank][7] == rook and board[rank][5] == board[rank][6] == ".":
        if not _attacked(board, rank, 5, not white) and not _attacked(board, rank, 6, not white):
            found.append(_name(rank, 4) + _name(rank, 6))
    if long in rights and board[rank][0] == rook and board[rank][1] == board[rank][2] == board[rank][3] == ".":
        if not _attacked(board, rank, 3, not white) and not _attacked(board, rank, 2, not white):
            found.append(_name(rank, 4) + _name(rank, 2))
    return found


def _apply(state: dict, move: str) -> None:
    """Move pieces and update castling, en passant and the fifty-move count. No turn change."""
    board = state["board"]
    fr, ff = _spot(move[:2]) or (0, 0)
    tr, tf = _spot(move[2:4]) or (0, 0)
    piece = board[fr][ff]
    captured = board[tr][tf]
    kind = piece.lower()
    white = _white(piece)
    board[fr][ff] = "."
    if kind == "p" and move[2:4] == state["ep"] and captured == ".":
        board[fr][tf] = "."
        captured = "p"
    if kind == "p" and len(move) == 5:
        piece = move[4].upper() if white else move[4]
    board[tr][tf] = piece
    if kind == "k" and abs(tf - ff) == 2:
        rook_from, rook_to = (7, 5) if tf == 6 else (0, 3)
        board[tr][rook_to] = board[tr][rook_from]
        board[tr][rook_from] = "."
    state["ep"] = _name((fr + tr) // 2, ff) if kind == "p" and abs(tr - fr) == 2 else ""
    rights = state["castling"]
    for square, lost in (("e1", "KQ"), ("h1", "K"), ("a1", "Q"), ("e8", "kq"), ("h8", "k"), ("a8", "q")):
        if square in (move[:2], move[2:4]):
            rights = "".join(c for c in rights if c not in lost)
    state["castling"] = rights
    state["halfmove"] = 0 if kind == "p" or captured != "." else int(state.get("halfmove") or 0) + 1


def _child(state: dict, move: str) -> dict:
    trial = {
        "board": [row[:] for row in state["board"]],
        "castling": state["castling"],
        "ep": state["ep"],
        "halfmove": state.get("halfmove", 0),
        "turn": state["turn"],
    }
    _apply(trial, move)
    trial["turn"] = "black" if state["turn"] == "white" else "white"
    return trial


def _legal_moves(state: dict) -> list[str]:
    white = state["turn"] == "white"
    found = []
    for move in _pseudo(state):
        trial = _child(state, move)
        if not _in_check(trial["board"], white):
            found.append(move)
    return found


def legal(state: dict) -> list[str]:
    return _legal_moves(state)


def refusal(state: dict, move) -> str:
    """A short, true reason the move was refused."""
    if not move:
        return "That isn't a move."
    board = state["board"]
    white = state["turn"] == "white"
    start, end = _spot(str(move)[:2]), _spot(str(move)[2:4])
    if start is None or end is None:
        return "That isn't a move."
    fr, ff = start
    tr, tf = end
    piece = board[fr][ff]
    if piece == "." or not _mine(piece, white):
        return "That's not your piece."
    target = board[tr][tf]
    if target != "." and _mine(target, white):
        return "That's your own piece."
    if piece.lower() == "k" and abs(tf - ff) == 2:
        if _attacked(board, fr, ff, not white):
            return "You can't castle while in check."
        step = 1 if tf > ff else -1
        if _attacked(board, fr, ff + step, not white) or _attacked(board, fr, tf, not white):
            return "Castling through check isn't allowed."
        return "You can't castle right now."
    trial = _child(state, str(move))
    if _in_check(trial["board"], white):
        return "That move would leave your king in check."
    return "That move isn't allowed."


# ----- text in and out -------------------------------------------------------

def parse(words: list[str]) -> str | None:
    text = "".join(words).strip().lower().replace("-", "")
    if len(text) in (4, 5) and _spot(text[:2]) and _spot(text[2:4]) and (len(text) == 4 or text[4] in "qrbn"):
        return text
    return None


def show(move: str) -> str:
    return move


# ----- the table hooks -------------------------------------------------------

def play(state: dict, move: str) -> str:
    if not state.get("seen"):
        state["seen"] = [_key(state)]
    _apply(state, move)
    state["turn"] = "black" if state["turn"] == "white" else "white"
    key = _key(state)
    state["seen"] = [*state["seen"], key][-120:]
    moves = _legal_moves(state)
    white_to_move = state["turn"] == "white"
    if not moves:
        if _in_check(state["board"], white_to_move):
            state["status"] = "win"
            state["winner"] = "black" if white_to_move else "white"
            state["result_detail"] = "checkmate"
            return "Checkmate."
        state["status"] = "draw"
        state["result_detail"] = "stalemate"
        return "Stalemate."
    if int(state.get("halfmove") or 0) >= 100:
        state["status"] = "draw"
        state["result_detail"] = "fifty_moves"
        return "Fifty moves without a capture or pawn move."
    if state["seen"].count(key) >= 3:
        state["status"] = "draw"
        state["result_detail"] = "repetition"
        return "Same position three times."
    if _too_little(state["board"]):
        state["status"] = "draw"
        state["result_detail"] = "material"
        return "Not enough pieces left to mate."
    return "Check." if _in_check(state["board"], white_to_move) else ""


def _too_little(board: list[list[str]]) -> bool:
    """Kings alone, king and one minor piece, or only bishops that all stand on one square colour."""
    pieces = [(p, r, f) for r, row in enumerate(board) for f, p in enumerate(row) if p not in ".Kk"]
    if not pieces:
        return True
    if len(pieces) == 1 and pieces[0][0].lower() in "nb":
        return True
    return all(p.lower() == "b" for p, _r, _f in pieces) and len({(r + f) % 2 for _p, r, f in pieces}) == 1


def _build_bonus() -> dict[str, list[int]]:
    """Piece-square bonuses from White's side, indexed rank * 8 + file (a1 = 0).

    Hand-written shapes, not lifted from an engine: pawns want to advance, knights and bishops
    want the centre, rooks want the seventh, the king wants a castled corner.
    """
    tables: dict[str, list[int]] = {kind: [] for kind in _VALUE}
    for r in range(8):
        for f in range(8):
            centre = abs(3.5 - f) + abs(3.5 - r)
            tables["p"].append(8 * (r - 1) + (4 if f in (3, 4) else 2 if f in (2, 5) else 0))
            tables["n"].append(int(36 - 6 * centre))
            tables["b"].append(int(24 - 4 * centre))
            tables["r"].append(int(12 - 2 * centre) + (18 if r == 6 else 0))
            tables["q"].append(int(10 - 2 * centre))
            tables["k"].append(30 if r <= 1 and f in (2, 6) else 0 if r <= 1 else -(r - 1) * 12 - int(4 * centre))
    return tables


_BONUS = _build_bonus()
_MATE = 100_000
_INF = 2 * _MATE
# The whole search must answer inside the table's patience: the kit runs bot() while a person waits.
_TIME_LIMIT = 1.7
# The built-in player's depth cap per level. Intermediate is the shipped strength;
# Beginner sees one ply (plus the kit's light noise), Advanced one more, Expert
# two more than Advanced — and Expert first tries an installed Stockfish.
_LEVEL_DEPTH = {"beginner": 1, "intermediate": 3, "advanced": 4, "expert": 5}
_QUIESCE = 2  # two plies of captures: enough to refuse a hanging piece, short enough to stay fast

# One flat table per piece letter: centipawns already signed for White, so the eval is a sum.
_PSQ: dict[str, list[int]] = {}
for _kind, _value in _VALUE.items():
    _PSQ[_kind.upper()] = [_value + _BONUS[_kind][i] for i in range(64)]
    _PSQ[_kind] = [-(_value + _BONUS[_kind][(7 - i // 8) * 8 + i % 8]) for i in range(64)]


def _eval_white(board: list[list[str]]) -> int:
    """Material and piece-square bonus in centipawns, White's side positive."""
    total = 0
    for r in range(8):
        row = board[r]
        base = r * 8
        for f in range(8):
            piece = row[f]
            if piece != ".":
                total += _PSQ[piece][base + f]
    return total


class _Pos:
    """A position the search can change in place, with an undo record per move."""

    __slots__ = ("board", "castling", "ep", "turn", "kings", "score")

    def __init__(self, state: dict) -> None:
        self.board = [row[:] for row in state["board"]]
        self.castling = state.get("castling") or ""
        self.ep = _spot(str(state.get("ep") or ""))
        self.turn = state["turn"] == "white"
        self.kings = {True: _king(self.board, True), False: _king(self.board, False)}
        self.score = _eval_white(self.board)


class _TimeUp(Exception):
    """The search ran out of its time budget; the caller keeps the last finished depth."""


# A move is (from rank, from file, to rank, to file, promotion letter or None).
_RIGHTS = {(0, 4): "KQ", (0, 7): "K", (0, 0): "Q", (7, 4): "kq", (7, 7): "k", (7, 0): "q"}


def _do(pos: _Pos, move: tuple) -> tuple:
    """Play a move in place and return the record that undoes it. Moves are not checked here:
    the search asks `_checked` after each move, and `_root` never offers an illegal move."""
    fr, ff, tr, tf, promo = move
    board = pos.board
    piece = board[fr][ff]
    kind = piece.lower()
    white = _white(piece)
    captured = board[tr][tf]
    cap_spot = (tr, tf)
    old_king = pos.kings[white]
    old_score = pos.score
    if kind == "p" and captured == "." and (tr, tf) == pos.ep:
        cap_spot = (fr, tf)
        captured = board[fr][tf]
        board[fr][tf] = "."
    board[fr][ff] = "."
    pos.score -= _PSQ[piece][fr * 8 + ff]
    if captured != ".":
        pos.score -= _PSQ[captured][cap_spot[0] * 8 + cap_spot[1]]
    placed = (promo.upper() if white else promo) if promo else piece
    board[tr][tf] = placed
    pos.score += _PSQ[placed][tr * 8 + tf]
    rook = None
    if kind == "k":
        pos.kings[white] = (tr, tf)
        if abs(tf - ff) == 2:
            rook_from, rook_to = (7, 5) if tf == 6 else (0, 3)
            rook = (tr, rook_from, tr, rook_to)
            rook_piece = board[tr][rook_from]
            board[tr][rook_to] = rook_piece
            board[tr][rook_from] = "."
            pos.score += _PSQ[rook_piece][tr * 8 + rook_to]
            pos.score -= _PSQ[rook_piece][tr * 8 + rook_from]
    undo = (move, piece, captured, cap_spot, pos.castling, pos.ep, rook, white,
            old_king, old_score)
    pos.ep = ((fr + tr) // 2, ff) if kind == "p" and abs(tr - fr) == 2 else None
    if pos.castling:
        lost = _RIGHTS.get((fr, ff), "") + _RIGHTS.get((tr, tf), "")
        if lost:
            pos.castling = "".join(c for c in pos.castling if c not in lost)
    pos.turn = not white
    return undo


def _undo(pos: _Pos, undo: tuple) -> None:
    (move, piece, captured, cap_spot, castling, ep, rook, white, king_spot, score) = undo
    fr, ff, tr, tf, _promo = move
    board = pos.board
    board[fr][ff] = piece
    board[tr][tf] = "."
    board[cap_spot[0]][cap_spot[1]] = captured
    if rook is not None:
        board[rook[0]][rook[1]] = board[rook[2]][rook[3]]
        board[rook[2]][rook[3]] = "."
    pos.castling = castling
    pos.ep = ep
    pos.turn = white
    pos.kings[white] = king_spot
    pos.score = score


def _checked(pos: _Pos, white: bool) -> bool:
    spot = pos.kings[white]
    return spot is not None and _attacked(pos.board, spot[0], spot[1], not white)


def _gen(pos: _Pos, captures: bool = False) -> list[tuple]:
    """Every move for the side to move, or only captures, en passant and promotions when captures
    is set. Legality (our own king) is the caller's job, since it costs an attack scan per move."""
    board = pos.board
    white = pos.turn
    found: list[tuple] = []
    for r in range(8):
        row = board[r]
        for f in range(8):
            piece = row[f]
            if piece == "." or piece.isupper() != white:
                continue
            kind = piece.lower()
            if kind == "p":
                step = 1 if white else -1
                last = 7 if white else 0
                ahead = r + step
                if 0 <= ahead < 8 and board[ahead][f] == ".":
                    if ahead == last:
                        # a promotion is never quiet: the capture search must see it too
                        found.extend((r, f, ahead, f, p) for p in "qrbn")
                    elif not captures:
                        found.append((r, f, ahead, f, None))
                        if r == (1 if white else 6) and board[r + 2 * step][f] == ".":
                            found.append((r, f, r + 2 * step, f, None))
                for df in (-1, 1):
                    tf = f + df
                    if not (0 <= ahead < 8 and 0 <= tf < 8):
                        continue
                    target = board[ahead][tf]
                    if target != "." and not _mine(target, white):
                        if ahead == last:
                            found.extend((r, f, ahead, tf, p) for p in "qrbn")
                        else:
                            found.append((r, f, ahead, tf, None))
                    elif (ahead, tf) == pos.ep and pos.ep is not None:
                        found.append((r, f, ahead, tf, None))  # en passant takes a pawn
            else:
                if kind in "nk":
                    for dr, df in (_KNIGHT if kind == "n" else _KING):
                        tr, tf = r + dr, f + df
                        if 0 <= tr < 8 and 0 <= tf < 8 and not _mine(board[tr][tf], white):
                            if not captures or board[tr][tf] != ".":
                                found.append((r, f, tr, tf, None))
                    continue
                steps = _ROOK if kind == "r" else _BISHOP if kind == "b" else _ROOK + _BISHOP
                for dr, df in steps:
                    tr, tf = r + dr, f + df
                    while 0 <= tr < 8 and 0 <= tf < 8:
                        target = board[tr][tf]
                        if _mine(target, white):
                            break
                        if not captures or target != ".":
                            found.append((r, f, tr, tf, None))
                        if target != ".":
                            break
                        tr += dr
                        tf += df
    if not captures:
        found.extend(_gen_castles(pos, white))
    return found


def _gen_castles(pos: _Pos, white: bool) -> list[tuple]:
    board = pos.board
    rank = 0 if white else 7
    king, rook = ("K", "R") if white else ("k", "r")
    rights = pos.castling
    found: list[tuple] = []
    if board[rank][4] != king or _attacked(board, rank, 4, not white):
        return found
    short, long = ("K", "Q") if white else ("k", "q")
    if short in rights and board[rank][7] == rook and board[rank][5] == board[rank][6] == ".":
        if not _attacked(board, rank, 5, not white) and not _attacked(board, rank, 6, not white):
            found.append((rank, 4, rank, 6, None))
    if long in rights and board[rank][0] == rook and board[rank][1] == board[rank][2] == board[rank][3] == ".":
        if not _attacked(board, rank, 3, not white) and not _attacked(board, rank, 2, not white):
            found.append((rank, 4, rank, 2, None))
    return found


def _order(pos: _Pos, moves: list[tuple]) -> None:
    """Most valuable victim, least valuable attacker first: the cheapest way to make alpha-beta bite."""
    board = pos.board
    def key(move: tuple) -> int:
        fr, ff, tr, tf, promo = move
        victim = board[tr][tf]
        if victim != ".":
            return -(_VALUE[victim.lower()] * 16 - _VALUE[board[fr][ff].lower()])
        return -800 if promo else 0
    moves.sort(key=key)


def _quiesce(pos: _Pos, alpha: int, beta: int, deadline: float, ply: int, depth: int = 0) -> int:
    """Search captures until the position is quiet, so the eval never trusts a hanging piece.

    `ply` counts moves from the root, so a mate seen here scores the same as one seen by
    _negamax: a quick mate has to outrank a slow one wherever it is found.
    """
    if time.monotonic() > deadline:
        raise _TimeUp
    static = pos.score if pos.turn else -pos.score
    white = pos.turn
    if depth >= _QUIESCE:
        return static
    in_check = _checked(pos, white)
    if not in_check:
        if static >= beta:
            return static
        if static > alpha:
            alpha = static
    moves = _gen(pos, captures=not in_check)
    if not moves:
        return (-_MATE + ply) if in_check else alpha
    _order(pos, moves)
    searched = 0
    for move in moves:
        fr, ff, tr, tf, promo = move
        victim = pos.board[tr][tf]
        if not in_check and victim != "." and not promo:
            # delta prune: taking a pawn cannot rescue an alpha that is already far ahead
            if static + _VALUE[victim.lower()] + 200 <= alpha:
                continue
        record = _do(pos, move)
        if _checked(pos, white):
            _undo(pos, record)
            continue  # a move that leaves our own king in check is not a move
        searched += 1
        score = -_quiesce(pos, -beta, -alpha, deadline, ply + 1, depth + 1)
        _undo(pos, record)
        if score >= beta:
            return score
        if score > alpha:
            alpha = score
    if not searched:
        return (-_MATE + ply) if in_check else alpha
    return alpha


def _negamax(pos: _Pos, depth: int, alpha: int, beta: int, deadline: float, ply: int) -> int:
    if time.monotonic() > deadline:
        raise _TimeUp
    if depth <= 0:
        return _quiesce(pos, alpha, beta, deadline, ply)
    white = pos.turn
    moves = _gen(pos)
    if not moves:
        return (-_MATE + ply) if _checked(pos, white) else 0
    _order(pos, moves)
    best = -_INF
    searched = 0
    for move in moves:
        record = _do(pos, move)
        if _checked(pos, white):
            _undo(pos, record)
            continue  # illegal: a plain stalemate must not look like a mate
        searched += 1
        score = -_negamax(pos, depth - 1, -beta, -alpha, deadline, ply + 1)
        _undo(pos, record)
        if score > best:
            best = score
        if score > alpha:
            alpha = score
        if alpha >= beta:
            break
    if not searched:
        return (-_MATE + ply) if _checked(pos, white) else 0
    return best


def _root(pos: _Pos, depth: int, deadline: float) -> tuple[int, tuple | None]:
    moves = _gen(pos)
    if not moves:
        return 0, None
    _order(pos, moves)
    white = pos.turn
    alpha, best_move, best_value = -_INF, None, -_INF
    for move in moves:
        record = _do(pos, move)
        if _checked(pos, white):
            _undo(pos, record)
            continue  # never offer the table a move that leaves our own king in check
        value = -_negamax(pos, depth - 1, -_INF, -alpha, deadline, 1)
        _undo(pos, record)
        if best_move is None or value > best_value:
            best_move, best_value = move, value
        if value > alpha:
            alpha = value
    return best_value, best_move


def _text(move: tuple) -> str:
    fr, ff, tr, tf, promo = move
    return _name(fr, ff) + _name(tr, tf) + (promo or "")


def bot(state: dict, depth: int | None = None) -> str:
    """Alpha-beta search with quiescence and MVV-LVA ordering (idea from andoma, MIT; code our own).

    Depth 3 by default (Normal). Easy looks one ply ahead and now and then plays
    some other legal move; Hard looks one ply deeper. Iterative deepening stops
    early if the clock runs out, so a move is always returned inside _TIME_LIMIT.
    """
    limit = kit.level_depth(state, _LEVEL_DEPTH) if depth is None else max(1, min(int(depth), 5))
    deadline = time.monotonic() + _TIME_LIMIT
    pos = _Pos(state)
    chosen: tuple | None = None
    for level in range(1, limit + 1):
        try:
            _value, move = _root(pos, level, deadline)
        except _TimeUp:
            break
        if move is not None:
            chosen = move
        if time.monotonic() > deadline:
            break
    if chosen is None:
        moves = _legal_moves(state)
        if not moves:
            return ""
        chosen = _spot_to_move(moves[0])
    return kit.level_pick(state, legal(state), _text(chosen))


def _spot_to_move(text: str) -> tuple:
    fr, ff = _spot(text[:2]) or (0, 0)
    tr, tf = _spot(text[2:4]) or (0, 0)
    promo = text[4] if len(text) == 5 else None
    return (fr, ff, tr, tf, promo)


def draw(state: dict) -> list[str]:
    lines = [f"{rank + 1} " + " ".join(state["board"][rank]) for rank in range(7, -1, -1)]
    lines.append("  " + " ".join(_FILES))
    return lines


def picture(state: dict) -> dict:
    cells = [state["board"][rank][:] for rank in range(7, -1, -1)]
    last_to = None
    shown = str(state.get("last") or "")
    spot = _spot(shown[2:4]) if len(shown) >= 4 else None
    if spot:
        last_to = {"row": 7 - spot[0], "col": spot[1], "name": shown[2:4]}
    # Check and mate are the deciding thing, so the square is named and the drawing rings it.
    checked = _in_check(state["board"], state["turn"] == "white")
    king = _king_cell(state["board"], state["turn"] == "white") if checked else None
    return {
        "view": "chess",
        "cells": cells,
        "files": _FILES,
        "ranks": list(range(8, 0, -1)),
        "legal": legal(state) if state.get("status") == "active" else [],
        "last_to": last_to,
        "check": state.get("status") == "active" and checked,
        "highlight": [king] if king else [],
        "coach": coach().live(state.get("moves") or []) if state.get("plies") is not None and not state.get("lesson") else None,
    }


def wins_next(state: dict, side: str):
    """Find an immediate win without changing the game."""
    import copy

    if state.get("status") != "active":
        return ""
    position = copy.deepcopy(state)
    position["turn"] = side
    for move in legal(position):
        trial = copy.deepcopy(position)
        play(trial, move)
        if trial.get("status") == "win" and trial.get("winner") == side:
            return move
    return ""


def explain(move, state: dict) -> str:
    return f"It moves a piece from {show(move)[:2]} to {show(move)[2:4]}."


def _king_cell(board: list[list[str]], white: bool) -> dict | None:
    """Where the king that is in check stands, in the picture's own row/col."""
    target = "K" if white else "k"
    for rank, row in enumerate(board):
        for file, piece in enumerate(row):
            if piece == target:
                return {"row": 7 - rank, "col": file}
    return None


def coach():
    """The coach module, imported late: it imports this game back."""
    name = "hermes_gameshelf_chess_coach"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name("coach.py"))
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


def coach_mistake(moves, side):
    """Review hook for the shared kit."""
    return coach().coach_mistake(kit.rules(globals()), moves, side)
