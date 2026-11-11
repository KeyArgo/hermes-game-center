#!/usr/bin/env python3
"""Write learn.json beside every game, from the content below.

The tutorial text is authored here so every game gets the same shape and the demo
moves are replayed through the game's own rules before they are written. Run this
after editing the text; it prints anything that would not replay, and
tests/test_tutorials.py checks the written files again on every test run.

    python3 tools/make_learn.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from shelf import tutorials  # noqa: E402
from shelf.catalog import Catalog  # noqa: E402
from types import SimpleNamespace  # noqa: E402
import tempfile  # noqa: E402


def grid(cols, rows, frames, kind="grid"):
    """A small animated diagram: each frame rings or fills cells in order."""
    return {"kind": kind, "cols": cols, "rows": rows,
            "frames": [{"cells": cells, "say": say} for cells, say in frames]}


def table_howto(goal, setup, sections, controls, diagram):
    return {"goal": goal, "setup": setup,
            "sections": [{"title": t, "text": x} for t, x in sections],
            "controls": controls, "diagram": diagram}


def storyboard(frames, intro="", outro=""):
    """A demo for a game whose rules are not a board replay: frames are drawn as they are."""
    return {"intro": intro, "frames": frames, "outro": outro}


# ---- The content ------------------------------------------------------------
# Every entry: title, howto, demo, coach. Table games give demo.moves (replayed
# through the real rules); play-kind games give demo.frames (a drawn storyboard).

CONTENT = {}

# --- the four demo games -----------------------------------------------------
CONTENT["hex"] = {
    "title": "Hex",
    "howto": table_howto(
        "Join your top side to your bottom side with an unbroken chain of your stones before the other side joins left to right.",
        "An 11 by 11 rhombus. Light joins top to bottom, dark joins left to right. Light moves first.",
        [("No draws", "Every full board has exactly one connected side, so a Hex game always ends with a winner."),
         ("Chains", "Stones touch along their six edges. A chain that reaches both of your sides wins."),
         ("Blocking", "You cannot take a stone back, so a move both extends your chain and blocks theirs is strong.")],
        ["Click any empty cell to place your stone.", "The ringed cell is where this lesson wants you.",
         "Undo in a learning game takes back your last move and the computer's reply."],
        grid(11, 11, [([[5, 5, "X"]], "Start near the middle."),
                      ([[5, 5, "X"], [4, 5, "X"]], "Join stones edge to edge."),
                      ([[5, 5, "X"], [4, 5, "X"], [3, 5, "X"]], "A chain reaching the far side wins.")]),
    ),
    "demo": {
        "intro": "Watch the computer play itself. Light is building top to bottom; dark builds left to right.",
        "moves": ["f6", "g6", "e6", "f7", "e7", "g5"],
        "lines": [
            {"at": 0, "say": "Empty board. Light wants the middle, because the middle is shortest to both sides."},
            {"at": 1, "say": "Light takes f6, the centre cell."},
            {"at": 2, "say": "Dark answers beside it at g6, starting its own line across the board."},
            {"at": 3, "say": "Light extends at e6 — a chain of two."},
            {"at": 4, "say": "Dark pushes at f7, blocking the light chain's path down the board."},
            {"at": 5, "say": "Light steps around at e7, keeping the chain connected."},
            {"at": 6, "say": "Dark blocks at g5. Notice both sides now threaten a route."},
        ],
        "outro": "The side that keeps one connected line wins. In Play & Learn you make the same first moves yourself.",
    },
    "coach": {"steps": [
        {"say": "You are Light and move first. Click the middle of the board to place your first stone.", "focus": "board", "highlight": ["f6"]},
        {"say": "Place your next stone so it touches one of your stones along an edge. If the swap took your first stone, start a fresh chain.", "focus": "board", "highlight": ["e6", "f7"]},
        {"say": "Build a line that reaches both of your sides. Top to bottom is yours.", "focus": "board"},
        {"say": "If the computer blocks you, go around it — never leave a gap in your chain.", "focus": "board"},
    ]},
}

CONTENT["connect4"] = {
    "title": "Connect Four",
    "howto": table_howto(
        "Get four of your pieces in a row — across, down, or diagonally — before the other side does.",
        "A seven-column, six-row grid. Pieces fall to the lowest empty slot. White moves first.",
        [("Dropping", "Click a column and your piece lands at the bottom of that column. You cannot drop into a full column."),
         ("Four in a row", "Four touching pieces in any straight line wins: across, down, or diagonally."),
         ("Blocking", "If the other side has three in a row with an open end, take that square first.")],
        ["Click a column to drop your piece.", "Hover a column to see where the piece would land.",
         "Undo in a learning game takes back your last move and the computer's reply."],
        grid(7, 6, [([[5, 3, "X"]], "A piece lands at the bottom."),
                    ([[5, 3, "X"], [4, 3, "X"], [3, 3, "X"]], "Three in a column."),
                    ([[5, 3, "X"], [4, 3, "X"], [3, 3, "X"], [2, 3, "X"]], "Four in a column wins.")]),
    ),
    "demo": {
        "intro": "Watch a short computer game: both sides drop pieces, and black has to answer white's threat.",
        "moves": ["4", "4", "3", "3", "5", "2"],
        "lines": [
            {"at": 0, "say": "Empty grid. The middle columns are strongest because they reach the most lines."},
            {"at": 1, "say": "White drops in the middle column."},
            {"at": 2, "say": "Black answers in the same column, stacking underneath."},
            {"at": 3, "say": "White starts a second line beside it."},
            {"at": 4, "say": "Black blocks that side."},
            {"at": 5, "say": "White spreads wider, building two threats at once."},
            {"at": 6, "say": "Black takes the open side. Two threats is how this game is won."},
        ],
        "outro": "Look for a move that creates two threats at once. Your opponent can only block one.",
    },
    "coach": {"steps": [
        {"say": "Click the middle column to drop your first piece.", "focus": "board", "highlight": ["4"]},
        {"say": "Now build a line of three pieces in one direction.", "focus": "board"},
        {"say": "Watch for the computer's three in a row and block the open end.", "focus": "board"},
        {"say": "Aim for a move that makes two threats at once — it cannot block both.", "focus": "board"},
    ]},
}

CONTENT["chessboard"] = {
    "title": "Chess",
    "howto": table_howto(
        "Checkmate the other king: put it in check with no legal way out.",
        "The usual starting position. White moves first.",
        [("Pieces", "Each piece moves its own way. Pawns go forward one square, or two on their first move, and capture diagonally."),
         ("Check and mate", "A king in check must escape. If it cannot, the game is over — checkmate."),
         ("Castling", "Once your king and rook are untouched, click the king and then two squares toward the rook to castle."),
         ("Draws", "Stalemate, fifty moves with no capture or pawn move, threefold repetition, and too little material to mate are draws.")],
        ["Click a piece, then the square it should move to.", "Legal destinations are marked when a piece is picked up.",
         "Promotion and castling happen by clicking the two squares; a small chooser appears for a pawn reaching the last rank."],
        grid(8, 8, [([[6, 4, "P"], [4, 4, "P"]], "A pawn may go two squares from its start."),
                    ([[6, 6, "N"], [5, 4, "N"]], "A knight jumps in an L shape."),
                    ([[7, 4, "K"], [7, 6, "K"], [7, 7, "R"]], "Castling moves the king two squares.")]),
    ),
    "demo": {
        "intro": "A short opening played by the computer, with the ideas named as they happen.",
        "moves": ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6"],
        "lines": [
            {"at": 0, "say": "The starting position. White moves first."},
            {"at": 1, "say": "White pushes the king's pawn two squares and opens the centre."},
            {"at": 2, "say": "Black mirrors it, claiming the same central squares."},
            {"at": 3, "say": "White develops a knight toward the centre."},
            {"at": 4, "say": "Black develops a knight to defend the centre pawn."},
            {"at": 5, "say": "White's bishop aims at the weakest square in black's camp."},
            {"at": 6, "say": "Black defends it and prepares to castle."},
        ],
        "outro": "In the opening, develop your pieces and keep your king safe. Do not chase pawns with your queen.",
    },
    "coach": {"steps": [
        {"say": "Click the pawn in front of your king, then two squares forward.", "focus": "board", "highlight": ["e2e4"]},
        {"say": "Bring a knight out toward the centre — knights jump in an L shape.", "focus": "board", "highlight": ["g1f3"]},
        {"say": "Develop your bishop so it aims at the other side's weak square.", "focus": "board"},
        {"say": "Castle to keep your king safe: click the king, then two squares toward the rook.", "focus": "board", "highlight": ["e1g1"]},
    ]},
}

CONTENT["liars_dice"] = {
    "title": "Liar's Dice",
    "howto": table_howto(
        "Be the last player with dice. Bid on how many of one face are on the whole table, or call the last bid a lie.",
        "Each player rolls five hidden dice and sees only their own. Everyone starts with five dice.",
        [("Bidding", "A bid says a face and a count, for example three fours. Each new bid must raise the count or the face."),
         ("Calling a lie", "If you think the bid is too high, call it. Everyone shows their dice. Whoever is wrong loses one die."),
         ("Winning", "The last player holding dice wins the game.")],
        ["Click a bid button to raise the count or the face.", "Click Call the bid a lie to challenge the last bid.",
         "Use the table chat to talk before you bid — talking is part of the game."],
        {"kind": "pips", "frames": [{"values": [2, 4, 4, 6, 1], "say": "Your five dice are hidden from everyone else."},
                                    {"values": [4, 4, 4], "say": "You can see three fours here. Bid on fours."}]},
    ),
    "demo": storyboard([
        {"say": "Four players each roll five dice and look only at their own.", "diagram": {"kind": "pips", "values": [3, 3, 5, 6, 2]}},
        {"say": "The first player bids two threes.", "diagram": {"kind": "pips", "values": [3, 3, 3]}},
        {"say": "The next player raises it to three threes.", "diagram": {"kind": "pips", "values": [3, 3, 3, 3]}},
        {"say": "A third player is not convinced and calls the bid a lie.", "diagram": {"kind": "cards", "cards": ["?", "?", "?"]}},
        {"say": "Everyone shows their dice. There are only two threes, so the bidder loses a die.", "diagram": {"kind": "pips", "values": [3, 3]}},
    ], intro="A round played out, with the bid and the challenge named.", outro="Count what you can see, and bid one higher than you believe the table holds."),
    "coach": {"steps": [
        {"say": "Look at your own dice and count the faces you hold most of.", "focus": "dice"},
        {"say": "Make a low, safe bid to start — two of a face you actually hold.", "focus": "bid"},
        {"say": "Raise the bid only when you hold more of that face yourself.", "focus": "bid"},
        {"say": "Call a lie when the count asked for is more than you think the table can hold.", "focus": "call"},
    ]},
}

# --- the other table games ---------------------------------------------------
CONTENT["checkers"] = {
    "title": "Checkers",
    "howto": table_howto(
        "Capture all of the other side's pieces, or leave them with no legal move.",
        "English checkers on an 8 by 8 board. Each side starts with twelve pieces on the dark squares. White moves first.",
        [("Moving", "Pieces move one square diagonally forward. Captures are compulsory: if you can jump, you must."),
         ("Jumping", "Jump over an adjacent enemy piece to an empty square beyond it, and that piece is removed."),
         ("Kings", "A piece reaching the far rank becomes a king and may move diagonally both ways."),
         ("Draws", "80 moves with no capture and no crowning is a draw.")],
        ["Click a piece, then the square to move to.", "The ringed squares are the moves this lesson wants.",
         "If several jumps are possible, any of them is legal."],
        grid(8, 8, [([[5, 2, "O"], [4, 3, "X"]], "A diagonal step forward."),
                    ([[5, 2, "O"], [4, 3, "O"], [3, 4, "X"]], "A jump captures the piece."),
                    ([[0, 1, "X"]], "A piece on the far rank becomes a king.")]),
    ),
    "demo": {
        "intro": "The computer plays both sides. Watch how a forced capture changes the position.",
        "moves": ["c3-b4", "f6-e5", "g3-f4", "e5-g3"],
        "lines": [
            {"at": 0, "say": "White and black face each other along the middle."},
            {"at": 1, "say": "White steps forward on the left."},
            {"at": 2, "say": "Black advances to meet it."},
            {"at": 3, "say": "White closes the gap."},
            {"at": 4, "say": "Black jumps over a white piece and captures it."},
        ],
        "outro": "Captures are compulsory, so a piece offered up can force your opponent's reply.",
    },
    "coach": {"steps": [
        {"say": "Click a piece that can move forward diagonally.", "focus": "board"},
        {"say": "If a capture is shown, you must take it — click the piece, then the landing square.", "focus": "board"},
        {"say": "Keep your back row intact so the other side cannot crown a king quickly.", "focus": "board"},
        {"say": "Trade pieces when you are ahead: fewer pieces means fewer ways to lose.", "focus": "board"},
    ]},
}

CONTENT["reversi"] = {
    "title": "Reversi",
    "howto": table_howto(
        "Finish with more of your discs on the board than the other side.",
        "An 8 by 8 board with four discs in the middle: two of each colour. White moves first.",
        [("Flipping", "Place a disc so it traps a line of the other colour between two of yours. That whole line flips to your colour."),
         ("Legal moves only", "A move must flip at least one disc. If you have no legal move, your turn is skipped."),
         ("The end", "The game ends when neither side can move. The side with more discs wins.")],
        ["Click an empty square to place a disc.", "Squares that would flip something are the only legal ones.",
         "Watch the corners: a corner disc can never be flipped."],
        grid(8, 8, [([[3, 3, "O"], [3, 4, "X"], [3, 5, "X"]], "Place here to trap a line."),
                    ([[3, 3, "X"], [3, 4, "X"], [3, 5, "X"]], "The trapped disc flips to your colour."),
                    ([[0, 0, "X"]], "A corner can never be taken back.")]),
    ),
    "demo": {
        "intro": "A short computer game showing how a flip works.",
        "moves": ["d3", "c3", "f5", "d2"],
        "lines": [
            {"at": 0, "say": "Four discs in the middle. White moves first."},
            {"at": 1, "say": "White places beside the black discs and flips one."},
            {"at": 2, "say": "Black flips that line back to black."},
            {"at": 3, "say": "White takes a square on the other side."},
            {"at": 4, "say": "Black flips a line from below. Every move changes the count."},
        ],
        "outro": "Early on, giving away discs can be good: it limits your opponent's legal moves.",
    },
    "coach": {"steps": [
        {"say": "Click a square that traps a line of the other colour.", "focus": "board"},
        {"say": "Corners can never be flipped, so work toward them.", "focus": "board"},
        {"say": "Avoid giving the other side a corner.", "focus": "board"},
        {"say": "If you have no legal move the turn passes — that is normal.", "focus": "board"},
    ]},
}

CONTENT["gomoku"] = {
    "title": "Gomoku",
    "howto": table_howto(
        "Get five or more of your stones in an unbroken line — across, down, or diagonally.",
        "A 15 by 15 board. White moves first.",
        [("Placing", "Click an empty point to place a stone. Stones never move or come off."),
         ("Five in a row", "Five or more touching stones in a straight line wins immediately."),
         ("Open threes", "Three in a row with both ends open is very hard to stop — build those first.")],
        ["Click an empty point to place a stone.", "The ringed point is where this lesson wants you.",
         "Watch for the computer's open three and block one end."],
        grid(15, 15, [([[7, 7, "X"]], "Take the centre."),
                      ([[7, 7, "X"], [7, 8, "X"], [7, 9, "X"]], "Three in a row, both ends open."),
                      ([[7, 7, "X"], [7, 8, "X"], [7, 9, "X"], [7, 10, "X"], [7, 11, "X"]], "Five wins.")]),
    ),
    "demo": {
        "intro": "A short computer game: white builds a line and black has to answer it.",
        "moves": ["h8", "h9", "g8", "i8", "f8"],
        "lines": [
            {"at": 0, "say": "Empty 15 by 15 board."},
            {"at": 1, "say": "White takes the centre."},
            {"at": 2, "say": "Black answers just above it."},
            {"at": 3, "say": "White builds sideways."},
            {"at": 4, "say": "Black blocks the right end."},
            {"at": 5, "say": "White extends the other way — the line now has one open end."},
        ],
        "outro": "A three with an open end threatens four — block it before it becomes five.",
    },
    "coach": {"steps": [
        {"say": "Click the centre point for your first stone.", "focus": "board", "highlight": ["h8"]},
        {"say": "Build a line of three with both ends open.", "focus": "board"},
        {"say": "Block the computer's open three before it becomes four.", "focus": "board"},
        {"say": "Five in a row ends the game — keep counting.", "focus": "board"},
    ]},
}

CONTENT["go"] = {
    "title": "Go",
    "howto": table_howto(
        "Score more points than the other side: your stones plus empty points only you surround. Dark gets 7.5 points.",
        "A 9 by 9 board. Light moves first and passes are allowed; dark gets 7.5 points.",
        [("Placing", "Click an empty point to place a stone. Stones are captured when they have no empty neighbour left."),
         ("Capturing", "Surround an enemy group completely and it comes off the board."),
         ("Ending", "Two passes in a row end the game, and the side holding more points wins; dark's 7.5 points are added to its score.")],
        ["Click an empty point to place a stone.", "Click Pass when you have nothing useful left.",
         "The ringed point is where this lesson wants you."],
        grid(9, 9, [([[4, 4, "X"]], "A stone in the middle."),
                    ([[4, 4, "X"], [3, 4, "O"], [4, 3, "O"], [4, 5, "O"], [5, 4, "O"]], "Four neighbours surround it."),
                    ([[4, 4, "."]], "A surrounded stone is captured and removed.")]),
    ),
    "demo": {
        "intro": "A short computer game on 9 by 9, showing contact play and how a group's shape grows.",
        "moves": ["e5", "e6", "d5", "f5", "d6"],
        "lines": [
            {"at": 0, "say": "Empty 9 by 9 board."},
            {"at": 1, "say": "Light takes a central point."},
            {"at": 2, "say": "Dark plays beside it, touching."},
            {"at": 3, "say": "Light extends along the row."},
            {"at": 4, "say": "Dark blocks the other side."},
            {"at": 5, "say": "Light strengthens the group's shape."},
        ],
        "outro": "In Go, stones that stay connected stay alive. Spread out early, connect later.",
    },
    "coach": {"steps": [
        {"say": "Click a central point for your first stone.", "focus": "board", "highlight": ["e5"]},
        {"say": "Keep your stones connected — a lone stone is easy to surround.", "focus": "board"},
        {"say": "Surround a single enemy stone on all four sides to capture it.", "focus": "board"},
        {"say": "Click Pass when you have no useful move left.", "focus": "pass"},
    ]},
}

CONTENT["kalah"] = {
    "title": "Kalah",
    "howto": table_howto(
        "Collect more seeds in your store than the other side. The game ends when one row of pits is empty, and the seeds left on the board go to their owners' stores.",
        "Six pits each and a store. Each pit starts with four seeds. White moves first.",
        [("Sowing", "Click one of your pits to take its seeds and drop one in each pit going round the board."),
         ("Extra turn", "If your last seed lands in your own store, you move again."),
         ("Stealing", "If your last seed lands in an empty pit on your side, you take that seed and everything opposite it.")],
        ["Click one of your pits to sow its seeds.", "The ringed pit is where this lesson wants you.",
         "Your store is the long pit on your right."],
        grid(7, 2, [([[1, 2, "3"]], "A pit with three seeds."),
                    ([[1, 2, "."], [1, 3, "1"], [1, 4, "1"], [1, 5, "1"]], "Sowing drops one seed per pit."),
                    ([[1, 6, "4"]], "Landing in your store gives another turn.")]),
    ),
    "demo": {
        "intro": "The computer plays both sides. Watch a sowing that lands in the store.",
        "moves": ["3", "4", "2", "5"],
        "lines": [
            {"at": 0, "say": "Both rows full, stores empty."},
            {"at": 1, "say": "White sows from the third pit."},
            {"at": 2, "say": "Black sows from its fourth."},
            {"at": 3, "say": "White picks a pit that reaches its store."},
            {"at": 4, "say": "Black answers on its own side."},
        ],
        "outro": "Count the seeds before you sow: landing in your store is a free turn.",
    },
    "coach": {"steps": [
        {"say": "Click one of your pits to sow its seeds.", "focus": "board"},
        {"say": "Count the seeds first — the last one decides what happens.", "focus": "board"},
        {"say": "Land your last seed in your store to move again.", "focus": "store"},
        {"say": "Land in an empty pit on your side to steal the opposite pit.", "focus": "board"},
    ]},
}

CONTENT["seabattle"] = {
    "title": "Sea Battle",
    "howto": table_howto(
        "Sink all five of the other fleet's ships before they sink yours.",
        "Two 10 by 10 seas. Each side hides five ships, from a carrier of five squares down to a destroyer of two. White lays out first.",
        [("Laying out", "Drag a ship from the tray onto your waters, or click it first to turn it. Ships lie across or down, and they cannot overlap."),
         ("Firing", "Click a square in the other fleet's water. A red ring is a hit and a pale dot is a miss."),
         ("Sinking", "A ship sinks when every one of its squares has been hit. Sink all five to win.")],
        ["Drag a ship from the tray onto your waters; a click turns it. Press Random to lay out the whole fleet.",
         "Click a square in the enemy water to fire.",
         "Press Look after handing the screen to another person."],
        grid(10, 10, [([[4, 4, "X"]], "A ship laid across the middle."),
                      ([[4, 4, "X"], [4, 3, "o"], [4, 2, "o"]], "A hit fills the square; a miss is a pale dot."),
                      ([[4, 4, "X"], [4, 5, "X"], [4, 6, "X"]], "Hit every square of a ship to sink it.")]),
    ),
    "demo": {
        "seats": "computer",
        "intro": "Both fleets use the same published layout, mirrored. White hunts the black fleet, then black answers.",
        "moves": ["duplicate", "duplicate", "fire e5", "fire e5", "fire j1", "fire a1", "fire j3", "fire a3"],
        "lines": [
            {"at": 0, "say": "Both seas are hidden. White lays out first, then black."},
            {"at": 1, "say": "White lays down the published five-ship fleet."},
            {"at": 2, "say": "Black mirrors the same fleet, left to right, so both start equal."},
            {"at": 3, "say": "White fires into the middle at e5. Nothing is there: a miss."},
            {"at": 4, "say": "Black fires at the same square in white's sea. Also a miss."},
            {"at": 5, "say": "White fires at j1 and hits the black carrier."},
            {"at": 6, "say": "Black answers at a1 and hits white's carrier."},
            {"at": 7, "say": "White hits the battleship at j3."},
            {"at": 8, "say": "Black hits back at a3. Both sides now know where to hunt."},
        ],
        "outro": "Once you get a hit, fire along that row or column. Sink all five ships to win.",
    },
    "coach": {"steps": [
        {"say": "Drag a ship from the tray onto a square of your waters; a click turns it. Random lays out the whole fleet.", "focus": "tray"},
        {"say": "Click a square in the enemy water to fire. A red ring means you hit a ship.", "focus": "board"},
        {"say": "After a hit, fire at the squares next to it: ships lie in straight lines.", "focus": "board"},
        {"say": "Press Look when you pass the screen. It stays covered until the next person looks.", "focus": "pass"},
    ]},
}

CONTENT["breakthrough"] = {
    "title": "Breakthrough",
    "howto": table_howto(
        "Race one of your pawns to the far rank, or capture every enemy pawn.",
        "An 8 by 8 board with two rows of pawns each. White moves first.",
        [("Moving", "Pawns step one square straight forward, or one square diagonally forward; a diagonal step can capture an enemy pawn."),
         ("No going back", "Pawns never move backwards, so every step commits you."),
         ("Winning", "Reaching the far rank with any pawn wins at once. Taking every enemy pawn also wins.")],
        ["Click a pawn, then the square to move to.", "The ringed squares are the moves this lesson wants.",
         "Diagonal squares can capture or step into an empty square; straight squares are quiet steps."],
        grid(8, 8, [([[6, 3, "X"], [5, 3, "X"]], "A pawn steps forward."),
                    ([[6, 3, "X"], [5, 4, "O"], [4, 5, "X"]], "A diagonal step captures."),
                    ([[0, 2, "X"]], "Reaching the far rank wins.")]),
    ),
    "demo": {
        "intro": "The computer plays both sides, pushing pawns toward each other.",
        "moves": ["d2-d3", "d7-d6", "e2-e3", "e7-e6", "f2-f3", "f7-f6"],
        "lines": [
            {"at": 0, "say": "Two solid rows of pawns."},
            {"at": 1, "say": "White advances in the middle."},
            {"at": 2, "say": "Black answers directly opposite."},
            {"at": 3, "say": "White pushes beside it."},
            {"at": 4, "say": "Black holds the line."},
            {"at": 5, "say": "White keeps coming."},
            {"at": 6, "say": "Black mirrors. Soon one side must commit diagonally."},
        ],
        "outro": "The first side to create a gap usually loses the race — keep your line unbroken.",
    },
    "coach": {"steps": [
        {"say": "Click a pawn and step it straight forward.", "focus": "board"},
        {"say": "Keep your pawns side by side so nothing can slip between them.", "focus": "board"},
        {"say": "Capture diagonally when a pawn can get past the line.", "focus": "board"},
        {"say": "The first pawn to the far rank wins — watch the race.", "focus": "board"},
    ]},
}

# --- the play-kind games -----------------------------------------------------
CONTENT["blind_auction"] = {
    "title": "Blind Auction",
    "howto": table_howto(
        "Finish with a higher net worth than the other bidder.",
        "Two bidders, five lots, and a private value for each lot. Talk first, then send one secret set of bids.",
        [("Talking", "Use the table chat before bidding. What you say is not binding — but it shapes the other bidder's guess."),
         ("Sealed bids", "Send one set of bids for the lots you want. Neither side sees the other's bids until both are in."),
         ("Winning", "Won lots are worth their private value to you. The higher net worth — spare coins plus what your lots were worth — wins.")],
        ["Click an amount button for a lot to add that bid.", "Press Send these bids once for the whole auction.",
         "Chat with the other bidder before you commit — it is part of the game."],
        {"kind": "cards", "frames": [{"cards": ["Lot 1", "Lot 2", "Lot 3", "Lot 4", "Lot 5"], "say": "Five lots, each with a value only you can see."},
                                     {"cards": ["Bid", "Bid", "—", "Bid", "—"], "say": "You bid on the lots you want."}]},
    ),
    "demo": storyboard([
        {"say": "Two bidders sit down. Five lots are on the table.", "diagram": {"kind": "cards", "cards": ["1", "2", "3", "4", "5"]}},
        {"say": "Each lot has a private value. Yours is hidden from the other bidder.", "diagram": {"kind": "cards", "cards": ["£40", "£15", "£70"]}},
        {"say": "They talk. One claims to care only about the first lot.", "diagram": {"kind": "seats", "seats": [{"name": "You", "tag": "bidder"}, {"name": "Rival", "tag": "bidder"}]}},
        {"say": "Both send sealed bids. The higher bid on a lot wins it.", "diagram": {"kind": "cards", "cards": ["40", "15", "70"]}},
        {"say": "Won lots pay their value. The richer wallet wins.", "diagram": {"kind": "cards", "cards": ["Wallet £125", "Wallet £90"]}},
    ], intro="An auction played out in five beats.", outro="Bid on what is worth most to you, and do not believe everything said in chat."),
    "coach": {"steps": [
        {"say": "Read the private value of each lot before you bid.", "focus": "lots"},
        {"say": "Talk in chat — a small misdirection can lower the other bid.", "focus": "chat"},
        {"say": "Bid on the lots worth most to you, not the ones the rival praises.", "focus": "bid"},
        {"say": "Press Send these bids once. You cannot change them afterwards.", "focus": "send"},
    ]},
}

CONTENT["doctrine"] = {
    "title": "Doctrine",
    "howto": table_howto(
        "Write a small strategy card and send it into a turn-based fight on the hex board. The card with the better priorities gives you the better moves.",
        "You write a card of eight weighted priorities: what to attack, what to defend, when to push. Then you fight a house card on the hex board.",
        [("The card", "A card is a short list of weighted priorities. Higher weights win arguments when the bot has to choose."),
         ("The fight", "The battle runs turn by turn on a hex board. You click a highlighted hex to move your units; the card sets their priorities."),
         ("Improving", "After a fight, change one weight at a time. A card that wins moves up the ladder.")],
        ["Press Play a battle to fight with your saved card.",
         "Edit the card in Card JSON and press Save card, or press Improve my bot to ask your model for a better one.",
         "Use Restart and Step to replay the fight move by move."],
        {"kind": "grid", "cols": 7, "rows": 7, "frames": [{"cells": [[3, 3, "X"]], "say": "Your units start here."},
                                                          {"cells": [[3, 3, "X"], [2, 4, "X"]], "say": "The card decides where they push."}]},
    ),
    "demo": storyboard([
        {"say": "Two players each write a weighted card of priorities.", "diagram": {"kind": "cards", "cards": ["Attack 8", "Hold 3", "Flank 5"]}},
        {"say": "The fight starts on the hex board.", "diagram": {"kind": "grid", "cols": 7, "rows": 7, "cells": [[3, 2, "X"], [3, 4, "O"]]}},
        {"say": "Each turn the cards decide movement, so the fight plays itself.", "diagram": {"kind": "grid", "cols": 7, "rows": 7, "cells": [[3, 3, "X"], [2, 4, "X"], [3, 4, "O"]]}},
        {"say": "One side breaks through and the fight ends.", "diagram": {"kind": "grid", "cols": 7, "rows": 7, "cells": [[3, 5, "X"], [4, 5, "X"], [4, 4, "O"]]}},
    ], intro="A fight between two cards, in four beats.", outro="Change one weight at a time and fight again — that is how a card gets better."),
    "coach": {"steps": [
        {"say": "Read the priorities on your card before you change anything.", "focus": "card"},
        {"say": "Change the weights in Card JSON and press Save card, or press Improve my bot.", "focus": "weights"},
        {"say": "Press Play a battle to fight, then use Step to see what your card actually did.", "focus": "send"},
        {"say": "Change one weight at a time, or you will not know what helped.", "focus": "weights"},
    ]},
}

CONTENT["doctrine_arena"] = {
    "title": "Olympus Arena",
    "howto": table_howto(
        "Send a champion into the arena with a strategy card. The card decides the whole battle, and the fight replays exactly from its seed.",
        "Your champion against a house champion, or four champions in a free-for-all. A strategy card sets how your champion fights. No model is called while the tanks fight.",
        [("Champions", "Each champion has its own strength and habits."),
         ("Strategy card", "The card decides the whole battle up front. You watch it play out, and it can be replayed exactly."),
         ("Replays", "Every fight has a seed, so the same seed always produces the same fight. Nothing is random after the fact.")],
        ["Press Fight to send your champion against a house champion.",
         "Press Four-way to send it against three house champions.",
         "Press Replay to watch the same fight again from its seed."],
        {"kind": "seats", "frames": [{"seats": [{"name": "Bulwark", "tag": "seat 1"}, {"name": "Skirmisher", "tag": "seat 2"}, {"name": "Sniper", "tag": "seat 3"}, {"name": "Bruiser", "tag": "seat 4"}], "say": "Four seats, four champions."}]},
    ),
    "demo": storyboard([
        {"say": "Four champions take their seats.", "diagram": {"kind": "seats", "seats": [{"name": "Bulwark", "tag": "1"}, {"name": "Skirmisher", "tag": "2"}, {"name": "Sniper", "tag": "3"}, {"name": "Bruiser", "tag": "4"}]}},
        {"say": "Each seat gets a strategy card.", "diagram": {"kind": "cards", "cards": ["Push 7", "Hold 4", "Focus 9"]}},
        {"say": "The battle plays out from its seed, turn by turn.", "diagram": {"kind": "grid", "cols": 6, "rows": 6, "cells": [[2, 2, "X"], [3, 3, "O"]]}},
        {"say": "The last champion standing takes the arena.", "diagram": {"kind": "seats", "seats": [{"name": "Sniper", "tag": "winner"}]}},
    ], intro="An arena fight in four beats.", outro="Same seed, same fight: try a different card and replay it to compare."),
    "coach": {"steps": [
        {"say": "Check your saved card — it decides the whole battle.", "focus": "card"},
        {"say": "Press Fight to send your champion into the arena.", "focus": "start"},
        {"say": "Watch the fight; nothing is decided by chance after the seed.", "focus": "start"},
        {"say": "Press Replay to see the same fight again.", "focus": "replay"},
    ]},
}

CONTENT["liars_dice_2v2"] = {
    "title": "Liar's Dice 2v2",
    "howto": table_howto(
        "Be on the last team with dice. Bid on how many of one face are on the table, or call the last bid a lie.",
        "Each team of two shares one pool of ten dice. Each player sees only their own dice.",
        [("Teams", "You and your partner share a pool. Talk in the open — the other team hears everything."),
         ("Bidding", "A bid says a face and a count for the whole table. Each new bid must raise the count or the face."),
         ("Calling a lie", "Call the bid and everyone shows their dice. The team that is wrong loses a die from its pool.")],
        ["Click a bid button to raise the count or the face.", "Click Call the bid a lie to challenge the last bid.",
         "Use the table chat to coordinate with your partner — openly."],
        {"kind": "pips", "frames": [{"values": [2, 5, 5, 6, 1], "say": "Your dice, and your partner's are separate."},
                                    {"values": [5, 5, 5], "say": "Between a team, fives add up fast."}]},
    ),
    "demo": storyboard([
        {"say": "Two teams sit down, five dice each.", "diagram": {"kind": "seats", "seats": [{"name": "You", "tag": "team A"}, {"name": "Partner", "tag": "team A"}, {"name": "Rival", "tag": "team B"}, {"name": "Rival 2", "tag": "team B"}]}},
        {"say": "The first bid is low: two fives.", "diagram": {"kind": "pips", "values": [5, 5]}},
        {"say": "A rival raises to four fives, counting their own dice.", "diagram": {"kind": "pips", "values": [5, 5, 5, 5]}},
        {"say": "Your partner calls the lie. Everyone shows their dice.", "diagram": {"kind": "pips", "values": [5, 5, 5]}},
        {"say": "Only three fives exist, so the rival team loses a die.", "diagram": {"kind": "pips", "values": [5, 5, 5]}},
    ], intro="A team round played out.", outro="Tell your partner what you hold — the other team is listening, so be careful."),
    "coach": {"steps": [
        {"say": "Count the face you hold most of, then say it in chat so your partner knows.", "focus": "chat"},
        {"say": "Bid low at first; you can raise on your next turn.", "focus": "bid"},
        {"say": "Remember the other team hears your hints too.", "focus": "chat"},
        {"say": "Call a lie when the count is more than your team's dice can support.", "focus": "call"},
    ]},
}

CONTENT["mafia"] = {
    "title": "Mafia",
    "howto": table_howto(
        "Townsfolk: vote out both mafia. Mafia: survive until the town is outnumbered.",
        "Six seats: two mafia, a doctor, a detective and two townsfolk. Day and night alternate.",
        [("Night", "The mafia pick a victim. The doctor may save one person, and the detective may check one person's side."),
         ("Day", "Everyone talks, then votes by clicking a player's name. The most votes is removed from the town."),
         ("Winning", "The town wins when both mafia are out. The mafia win when they equal or outnumber the town.")],
        ["Click a player's name to vote for that person.",
         "Talk in the table chat — the whole town reads it."],
        {"kind": "seats", "frames": [{"seats": [{"name": "You", "tag": "townsfolk"}, {"name": "Mara", "tag": "townsfolk"}, {"name": "Ivo", "tag": "detective"}, {"name": "Wren", "tag": "doctor"}, {"name": "Ash", "tag": "mafia"}, {"name": "Bell", "tag": "mafia"}], "say": "Six seats, two of them mafia."}]},
    ),
    "demo": storyboard([
        {"say": "Six people sit down. Two are mafia, and only they know who.", "diagram": {"kind": "seats", "seats": [{"name": "You", "tag": "?"}, {"name": "Mara", "tag": "?"}, {"name": "Ivo", "tag": "?"}, {"name": "Wren", "tag": "?"}, {"name": "Ash", "tag": "?"}, {"name": "Bell", "tag": "?"}]}},
        {"say": "Night falls. The mafia choose a victim.", "diagram": {"kind": "seats", "seats": [{"name": "Mara", "tag": "victim"}]}},
        {"say": "Day comes. Everyone argues about who stayed too quiet.", "diagram": {"kind": "seats", "seats": [{"name": "Ash", "tag": "accused"}, {"name": "You", "tag": "speaking"}]}},
        {"say": "The town votes. One person is removed.", "diagram": {"kind": "seats", "seats": [{"name": "Ash", "tag": "voted out"}]}},
        {"say": "If both mafia are gone, the town wins.", "diagram": {"kind": "seats", "seats": [{"name": "Town", "tag": "wins"}]}},
    ], intro="One day and one night, played out.", outro="Say something every day. Silence is what gets people voted out."),
    "coach": {"steps": [
        {"say": "Read the night result, then say what you noticed in chat.", "focus": "chat"},
        {"say": "Click a player's name to vote.", "focus": "vote"},
        {"say": "If you are the detective, share your checks carefully — the mafia hear them too.", "focus": "chat"},
        {"say": "Count the seats: when the mafia match the town, they win.", "focus": "seats"},
    ]},
}

CONTENT["pet_battles"] = {
    "title": "Pet Battles",
    "howto": table_howto(
        "Knock out all three of the computer's pets before it knocks out yours.",
        "Three pets a side. You pick the type and four moves for the pet who leads; two house pets join your team.",
        [("Types", "Each pet has a type. Some types hit harder against others, so mix your team."),
         ("Moves", "Pick four moves for the lead pet. The other two pets bring their own moves."),
         ("Turns", "Turns play out in order. A knocked-out pet is replaced by the next one in your team.")],
        ["Click a pet to lead your team.", "Click four moves for the lead pet.",
         "Press a level to start the battle."],
        {"kind": "seats", "frames": [{"seats": [{"name": "Your team", "tag": "3 pets"}, {"name": "Computer", "tag": "3 pets"}], "say": "Three against three."}]},
    ),
    "demo": storyboard([
        {"say": "You pick the pet who leads and its four moves; two house pets join your team.", "diagram": {"kind": "cards", "cards": ["Ember", "Bolt", "Leaf", "Frost"]}},
        {"say": "The computer brings its own team.", "diagram": {"kind": "seats", "seats": [{"name": "Your team", "tag": "ready"}, {"name": "Computer", "tag": "ready"}]}},
        {"say": "Turns play out. Type advantage decides the damage.", "diagram": {"kind": "cards", "cards": ["-18", "-24", "-9"]}},
        {"say": "Knock out all three to win.", "diagram": {"kind": "seats", "seats": [{"name": "Your team", "tag": "wins"}]}},
    ], intro="A battle in four beats.", outro="Cover your pets' weak types: a team that all shares one weakness is easy to beat."),
    "coach": {"steps": [
        {"say": "Pick the pet who leads and its type — the other two are house pets.", "focus": "team"},
        {"say": "Click four moves for the lead pet.", "focus": "moves"},
        {"say": "Check which of the computer's pets your moves hit hardest.", "focus": "moves"},
        {"say": "Press a level to start, and watch the turns play out.", "focus": "start"},
    ]},
}

CONTENT["prisoners_dilemma"] = {
    "title": "Prisoner's Dilemma",
    "howto": table_howto(
        "Score the most points across every match in the field.",
        "A whole field of seats play each other once. Each match is one choice made together.",
        [("The choice", "Choose Work together or Sell them out. Working together pays both 3 points; selling out pays 5 to the seller and 0 to the other."),
         ("Talking", "You can talk before choosing. Promises are not enforced — that is the game."),
         ("The field", "Every seat plays every other seat once. Points add up across all matches.")],
        ["Click Work together or Sell them out to choose.", "Type a line in the chat to talk before choosing.",
         "Your score is the total across every match."],
        {"kind": "cards", "frames": [{"cards": ["Together +3 each", "Sell out +5 / 0"], "say": "The two choices and what they pay."}]},
    ),
    "demo": storyboard([
        {"say": "Every seat in the field plays every other seat once.", "diagram": {"kind": "seats", "seats": [{"name": "You", "tag": "seat"}, {"name": "Rival", "tag": "seat"}]}},
        {"say": "Before choosing, you can talk.", "diagram": {"kind": "cards", "cards": ["\"Together?\"", "\"Sure.\""]}},
        {"say": "Both choose at once. Together pays 3 each; selling out pays 5 to one and 0 to the other.", "diagram": {"kind": "cards", "cards": ["Together +3", "Sell out +5/0"]}},
        {"say": "Points carry over to the next match.", "diagram": {"kind": "cards", "cards": ["+3", "+5"]}},
    ], intro="One match, played out.", outro="A promise is only worth what the other seat believes — and they remember last time."),
    "coach": {"steps": [
        {"say": "Talk before choosing: it costs nothing and may change the answer.", "focus": "chat"},
        {"say": "Click Work together or Sell them out to choose.", "focus": "choose"},
        {"say": "Remember the same seat plays you again in the field.", "focus": "seats"},
        {"say": "Your total across every match is the score that counts.", "focus": "score"},
    ]},
}

# --- the launch-only games ---------------------------------------------------
LAUNCH = {
    "doom": ("Doom",
             "Play a Doom program you installed yourself, using the game data on this machine.",
             "This card starts the Doom program on this computer. Game Center hands over the keyboard and gets it back when you close it."),
    "luanti": ("Luanti",
               "Play the Luanti (Minetest) program you installed yourself, with the games on this machine.",
               "This card starts Luanti on this computer. Its own world and menus take over until you close it."),
    "openra": ("OpenRA",
               "Play the OpenRA program you installed yourself, with the mods it brings.",
               "This card starts OpenRA on this computer. It brings its own mods and menus."),
    "openttd": ("OpenTTD",
                "Play the OpenTTD program you installed yourself, with its own base graphics.",
                "This card starts OpenTTD on this computer. Build a transport company and keep it running."),
    "wesnoth": ("Wesnoth",
                "Play The Battle for Wesnoth program you installed yourself, with its own campaigns.",
                "This card starts Wesnoth on this computer. It brings its own campaigns and menus."),
}

for game, (title, summary, detail) in LAUNCH.items():
    CONTENT[game] = {
        "title": title,
        "howto": table_howto(
            summary,
            "This game is a program on this computer, not a Game Center table.",
            [("What this screen does", detail),
             ("Where it runs", "The program is the one you installed. Game Center only starts it and steps out of the way."),
             ("Back here", "Close the program and this page is waiting for you.")],
            ["Click Play to open the program.", "Click Back to leave this card without starting anything.",
             "Nothing here needs typing."],
            {"kind": "cards", "frames": [{"cards": ["Play", "Close"], "say": "Play opens the program; closing it returns you here."}]},
        ),
        "demo": storyboard([
            {"say": f"{title} runs as its own program on this computer.", "diagram": {"kind": "cards", "cards": ["Play", "Close"]}},
            {"say": "Game Center starts it and hands over the screen.", "diagram": {"kind": "cards", "cards": ["Starting…"]}},
            {"say": "Play the game in its own window.", "diagram": {"kind": "cards", "cards": ["Your game"]}},
            {"say": "Close the window and this card is here again.", "diagram": {"kind": "cards", "cards": ["Back here"]}},
        ], intro=f"How {title} opens from Game Center.", outro="Game Center does not run the game itself — the program you installed does."),
        "coach": {"steps": [
            {"say": "Click Play to open the program.", "focus": "start"},
            {"say": "Play it in its own window; its own menus do the rest.", "focus": "start"},
            {"say": "Close the program when you are done.", "focus": "back"},
        ]},
    }


# ---- Write and check --------------------------------------------------------
def main() -> int:
    tmp = Path(tempfile.mkdtemp())
    catalog = Catalog([ROOT], tmp / "data", {"allow_ai": True})
    bad = 0
    shelf_learn = ROOT / "shelf" / "learn"
    for game, data in sorted(CONTENT.items()):
        directory = ROOT / game
        if game in LAUNCH:
            # A launch card folder holds nothing but its own code, so its
            # tutorial ships in shelf/learn instead (see shelf/tutorials.py).
            shelf_learn.mkdir(exist_ok=True)
            directory = shelf_learn
        if not (ROOT / game).is_dir():
            print(f"MISSING DIRECTORY {game}")
            bad += 1
            continue
        rules = None
        try:
            loaded = catalog._load(game)
            rules = getattr(loaded, "rules", None)
        except Exception as error:
            print(f"{game}: catalog could not load it ({error})")
        data = json.loads(json.dumps(data))
        if rules is not None:
            demo = data.get("demo") or {}
            moves = list(demo.get("moves") or [])
            played = []
            state = tutorials.kit.lesson_position(rules, {"setup": []})
            if demo.get("seats") == "computer":
                state["white"] = state["black"] = "local"
            for token in moves:
                legal = {str(rules.show(move)).lower(): move for move in rules.legal(state)}
                if str(token).lower() not in legal:
                    replacement = str(rules.show(rules.legal(state)[0])) if rules.legal(state) else ""
                    print(f"{game}: demo move {token!r} is not legal here; using {replacement!r}")
                    token = replacement
                move = legal.get(str(token).lower()) or rules.legal(state)[0]
                rules.play(state, move)
                shown = str(rules.show(move))
                state["plies"] = state.get("plies", 0) + 1
                state["moves"] = state.get("moves", []) + [shown]
                state["last"] = shown
                played.append(shown)
            if played != moves:
                demo["moves"] = played
        problems = tutorials.problems(rules, data) if rules is not None else tutorials.problems(
            SimpleNamespace(__file__=str(directory / "game.py")), data)
        if problems:
            print(f"{game}: {problems}")
            bad += 1
        target = directory / (f"{game}.json" if game in LAUNCH else "learn.json")
        target.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {len(CONTENT)} learn.json files, {bad} with problems")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
