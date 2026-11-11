"""Review My Game: find the last clear one-move mistake in a finished game.

Pure functions. No I/O, no model. The recorded moves are replayed through the
game's own rules (the same replay ``kit.lesson_position`` performs); every
check is a real rules answer, never a guess. The words around the answer are
fixed templates, so the feature works with no model at all.
"""

from __future__ import annotations

import copy

SIDES = ("white", "black")


def start(rules) -> dict:
    """A fresh state, exactly as a new table starts."""
    state = {"turn": "white", "status": "active", "winner": "", "plies": 0, "moves": [], "last": ""}
    state.update(rules.fresh())
    return state


def _wins_with(rules, state, move) -> bool:
    """``move``, played by the side to move in ``state``, wins the game at once."""
    trial = copy.deepcopy(state)
    rules.play(trial, move)
    return trial.get("status") == "win" and trial.get("winner") == state.get("turn")


def _loses_with(rules, state, move) -> bool:
    """``move``, played by the side to move in ``state``, loses the game at once."""
    trial = copy.deepcopy(state)
    rules.play(trial, move)
    return trial.get("status") == "win" and trial.get("winner") != state.get("turn")


def _opponent_can_win(rules, state, move) -> bool:
    """After ``move`` (by the side to move in ``state``) the opponent can win on
    their immediate reply. False when the move ends the game, or when the mover
    keeps the turn (some games, e.g. Kalah, grant another move: then there is no
    opponent reply to assess)."""
    trial = copy.deepcopy(state)
    mover = state["turn"]
    rules.play(trial, move)
    if trial.get("status") != "active":
        return False
    if trial.get("turn") == mover:
        return False
    return any(_wins_with(rules, trial, reply) for reply in rules.legal(trial))


def examine(rules, state: dict, played) -> dict | None:
    """The one-move mistake by the side to move in ``state``, or None.

    A missed win outranks an allowed loss on the same move: if a winning move
    exists and the played one is not it, that is the mistake to teach.
    """
    turn = state["turn"]
    other = "black" if turn == "white" else "white"
    legal = rules.legal(state)
    if played not in legal:
        return None
    if _wins_with(rules, state, played):
        return None  # the move won; there is nothing to fix
    winners = [move for move in legal if move != played and _wins_with(rules, state, move)]
    if winners:
        shown = rules.show(winners[0])
        return {
            "kind": "missed_win",
            "setup": list(state.get("moves") or []),
            "goal": [str(rules.show(move)).lower() for move in winners],
            "wins": True,
            "say": "You had a winning move this turn and played something else. Find the move that ends the game.",
            "tip": f"{shown} wins at once.",
            "praise": "That is the one. The win was there.",
        }
    if not _opponent_can_win(rules, state, played):
        return None
    saves = [move for move in legal
             if move != played and not _opponent_can_win(rules, state, move) and not _loses_with(rules, state, move)]
    if not saves:
        return None  # nothing could be done: not a clear mistake
    shown = rules.show(saves[0])
    return {
        "kind": "allowed_win",
        "setup": list(state.get("moves") or []),
        "goal": [str(rules.show(move)).lower() for move in saves],
        "wins": False,
        "say": f"Your move lets {other} win at once next turn. Find the move that prevents it.",
        "tip": f"{shown} stops the winning reply.",
        "praise": "Good block. The loss was prevented.",
    }


def find_mistake(rules, moves, learner: str) -> dict | None:
    """The last clear one-move mistake by ``learner`` in the recorded game.

    Replays ``moves`` from the start through the real rules, checking every
    ``learner`` move. Returns
    ``{ply, kind, setup, goal, wins, say, tip, praise}`` where ``ply`` is the
    1-based move number and ``setup`` the position before it with ``learner``
    to move -- or None when every checked move stands up. The caller then says
    so honestly; no mistake is ever invented.
    """
    if learner not in SIDES:
        return None
    state = start(rules)
    found = None
    for index, token in enumerate(moves):
        if state.get("status") != "active":
            break
        move = rules.parse(str(token).split())
        if move is None or move not in rules.legal(state):
            break  # a game we cannot replay: report nothing rather than guess
        if state["turn"] == learner:
            mistake = examine(rules, state, move)
            if mistake:
                mistake["ply"] = index + 1  # the last mistake is the one nearest the loss
                found = mistake
        rules.play(state, move)
        shown = rules.show(move)
        state["plies"] = int(state.get("plies") or 0) + 1
        state["last"] = shown
        state["moves"] = [*state.get("moves", []), shown][-rules.MAX_PLIES:]
        if state.get("status") == "active" and state["plies"] >= rules.MAX_PLIES:
            state["status"] = "draw"
            state["winner"] = ""
    return found
