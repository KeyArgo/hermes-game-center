"""Build chessboard/openingbook.json from the vendored lichess openings TSVs.

Dev-only helper (python-chess, GPL-3.0+, used here offline; none of it ships).
The data it emits derives solely from vendor/chess-openings/*.tsv, which is
CC0-1.0, https://github.com/lichess-org/chess-openings.

Positions are keyed by the same string chessboard.game._key builds (piece
placement rows, side to move, castling rights, en passant square only when a
pawn of the right colour stands beside it), so the runtime needs no chess
library:

    {"<key>": {"n": [["B10", "Caro-Kann Defense"], ...],
               "m": [["b1c3", "Nc6"], ...]}, ...}

"n" is every name that reaches this position, transpositions included; "m" is
the deduplicated book continuations as from-to moves with their SAN.

Run:  /tmp/coachenv/bin/python tools/make_chess_openings.py  (any python with `chess`)
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import chess
import chess.pgn

ROOT = Path(__file__).resolve().parent.parent
TSV_DIR = ROOT / "vendor" / "chess-openings"
OUT = ROOT / "chessboard" / "openingbook.json"


def board_key(board: chess.Board) -> str:
    """The exact string chessboard.game._key builds for the same position."""
    rows = "/".join(
        "".join(
            (piece.symbol() if (piece := board.piece_at(chess.square(file_i, rank))) else ".")
            for file_i in range(8)
        )
        for rank in range(8)
    )
    turn = "w" if board.turn == chess.WHITE else "b"
    castling = board.fen().split()[2] or "-"
    ep = ""
    if board.has_legal_en_passant() and board.ep_square is not None:
        name = chess.square_name(board.ep_square)
        rank = int(name[1]) - 1
        file_i = ord(name[0]) - 97
        pawn = "P" if board.turn == chess.WHITE else "p"
        from_rank = rank - 1 if board.turn == chess.WHITE else rank + 1
        for df in (-1, 1):
            if 0 <= file_i + df < 8:
                neighbour = board.piece_at(chess.square(file_i + df, from_rank))
                if neighbour is not None and neighbour.symbol() == pawn:
                    ep = name
                    break
    return f"{rows} {turn} {castling} {ep or '-'}"


def main() -> int:
    index: dict[str, dict] = {}
    games = 0
    for path in sorted(TSV_DIR.glob("?.tsv")):
        for line in path.read_text(encoding="utf-8").splitlines()[1:]:
            parts = (line.split("\t") + ["", ""])[:3]
            if len(parts) < 3 or not parts[2].strip():
                continue
            eco, name, pgn = parts
            game = chess.pgn.read_game(io.StringIO(pgn + " *"))
            board = game.board()
            assert board.fen() == chess.STARTING_FEN, f"{eco} {name}: {board.fen()}"
            moves = list(game.mainline_moves())
            if not moves:
                continue
            if [eco, name] not in index.setdefault(
                board_key(chess.Board()), {"n": [], "m": []}
            )["n"]:
                index[board_key(chess.Board())]["n"].append([eco, name])
            b = chess.Board()
            for i, mv in enumerate(moves):
                key = board_key(b)
                entry = index.setdefault(key, {"n": [], "m": []})
                if not any(m[0] == mv.uci() for m in entry["m"]):
                    entry["m"].append([mv.uci(), b.san(mv)])
                b.push(mv)
            end = index.setdefault(board_key(b), {"n": [], "m": []})
            if [eco, name] not in end["n"]:
                end["n"].append([eco, name])
            games += 1
    OUT.write_text(
        json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(f"{games} openings -> {len(index)} positions, {OUT.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
