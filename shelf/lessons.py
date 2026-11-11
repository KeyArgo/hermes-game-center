"""Checks a game's lesson (lesson.json beside game.py). The lesson itself runs in kit.Table.

A step:
  say     what to do (one or two short sentences)
  setup   moves from the start, in the game's own notation; the side to move after them is the learner
  goal    moves that pass the step ([] = any legal move)
  wins    optional; true when every goal move must win the game
  tip     shown after a legal move that is not a goal
  praise  shown when the step is passed
"""

from __future__ import annotations

from .kitref import kit

SAY_WORDS = 40


def problems(rules, steps: list[dict]) -> list[str]:
    """Every reason a lesson would not work. Empty means it is good."""
    found = []
    if not 3 <= len(steps) <= 7:
        found.append(f"{len(steps)} steps; use 3 to 7")
    for number, step in enumerate(steps, start=1):
        where = f"step {number}"
        say = str(step.get("say") or "")
        if not say or len(say.split()) > SAY_WORDS:
            found.append(f"{where}: 'say' must be 1 to {SAY_WORDS} words")
        try:
            state = kit.lesson_position(rules, step)
        except ValueError as error:
            found.append(f"{where}: {error}")
            continue
        legal = {str(rules.show(move)).lower(): move for move in rules.legal(state)}
        if not legal:
            found.append(f"{where}: no legal move after setup")
            continue
        goal = [str(item).lower() for item in step.get("goal") or []]
        for token in goal:
            if token not in legal:
                found.append(f"{where}: goal {token!r} is not legal here (legal: {', '.join(list(legal)[:12])})")
            elif not kit.lesson_passes(rules, step, state, legal[token]):
                found.append(f"{where}: goal {token!r} does not win")
        if step.get("wins") and not goal:
            found.append(f"{where}: a 'wins' step needs goal moves")
    return found
