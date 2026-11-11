"""Prisoner's Dilemma as a round-robin between the whole field.

The vendored ``IteratedPrisonersDilemmaEnv`` is a two-seat game, so a table of
three or more seats is scored as a tournament: every pair meets once, and each
seat's points are added up across its matches. That is the "scored across the
whole field" shape of this game.
"""

from __future__ import annotations

import itertools
import random

from .. import common, ta_envs

ID = "prisoners-dilemma"
TITLE = "Prisoner's Dilemma"
BLURB = (
    "Every pair talks, then secretly chooses: work together for a small reward "
    "or sell the other out for a bigger one. Points add up across the whole field."
)
MIN_SEATS = 3
MAX_SEATS = 6
DEFAULT_SEATS = 4
ROUNDS = 2
TALK_TURNS = 1

_CHAT_COOPERATE = (
    "I would rather we both did well than both lost. I will work with you.",
    "Two points each is better than a race to the bottom. Let us both cooperate.",
)
_CHAT_DEFECT = (
    "I am not going to be the one who gets sold out.",
    "Promises are cheap here. I will look after my own score.",
)


def sessions(seats: int) -> list[list[int]]:
    return [[a, b] for a, b in itertools.combinations(range(seats), 2)]


def build(seats: int):
    return ta_envs.env_class("IteratedPrisonersDilemmaEnv")(num_rounds=ROUNDS, communication_turns=TALK_TURNS)


def reset(env, seat_ids, seed) -> None:
    env.reset(num_players=len(seat_ids), seed=seed)


def done(env) -> bool:
    return bool(env.state.done)


def current(env) -> int:
    return int(env.state.current_player_id)


def _gs(env):
    return env.state.game_state


def phase(env) -> dict:
    gs = _gs(env)
    talking = gs.get("phase") == "conversation"
    label = f"Round {gs.get('round', 1)} of {gs.get('num_rounds', ROUNDS)} · " + (
        "talking" if talking else "choosing")
    return {"label": label, "kind": "talk" if talking else "act"}


def can_say(env, seat: int) -> bool:
    return not done(env) and _gs(env).get("phase") == "conversation" and current(env) == seat


def actions(env, seat: int, draft=None) -> list[dict]:
    del draft
    if done(env) or can_say(env, seat):
        return []
    return [
        {"id": "cooperate", "label": "Work together", "hint": "Both gain 3 each", "raw": "[Cooperate]"},
        {"id": "defect", "label": "Sell them out", "hint": "You gain 5, they gain 0", "raw": "[Defect]"},
    ]


def parse(env, seat: int, text: str, allowed: list[dict], draft=None):
    del draft
    if can_say(env, seat):
        said = common.clean(text)
        return ("act", said) if said else None
    said = str(text or "").strip().lower()
    for item in allowed:
        if said in {item["id"], item["raw"].lower().strip("[]")}:
            return ("act", item["raw"])
    return None


def parse_free(env, seat: int, text: str):
    """A model writing a sentence instead of the two words: read the word it meant."""
    raw = str(text or "")
    if can_say(env, seat):
        said = common.clean(raw)
        return said or None
    low = raw.lower()
    cooperate = "[cooperate]" in low or "cooperate" in low
    defect = "[defect]" in low or "defect" in low
    if defect and not cooperate:
        return "[Defect]"
    if cooperate and not defect:
        return "[Cooperate]"
    return None


def _opponent_last(history, seat: int) -> str:
    """The last thing the other seat chose, read from the session's own record."""
    for who, raw in reversed(history or []):
        try:
            if int(who) == int(seat):
                continue
        except (TypeError, ValueError):
            continue
        low = str(raw).lower()
        if "[defect]" in low:
            return "defect"
        if "[cooperate]" in low:
            return "cooperate"
    return ""


def bot(env, seat: int, rng: random.Random, history=None) -> str:
    if can_say(env, seat):
        last = _opponent_last(_finished_rounds(env, history), seat)
        pool = _CHAT_DEFECT if last == "defect" else _CHAT_COOPERATE
        return rng.choice(pool)
    # Tit for tat: start friendly, then answer the other seat's last choice. On
    # the last round a third of the built-in players take the money instead,
    # so a field of computers is not always a wall of draws.
    past = _finished_rounds(env, history)
    if _opponent_last(past, seat) == "defect":
        return "[Defect]"
    gs = _gs(env)
    if int(gs.get("round", 1)) >= int(gs.get("num_rounds", ROUNDS)) and rng.random() < 0.34:
        return "[Defect]"
    return "[Cooperate]"


def _finished_rounds(env, history) -> list:
    """Only the actions of rounds that are over.

    Both seats choose at the same time, so the opponent's choice in the round
    being played is not something a seat may look at. The environment gives the
    first seat its turn before the second, so the raw history does hold it.
    """
    gs = _gs(env)
    per_round = 2 * (int(gs.get("total_conversation_rounds", TALK_TURNS)) + 1)
    done = max(0, int(gs.get("round", 1)) - 1) * per_round
    return (history or [])[:done]


def brief(env, seat: int) -> str:
    gs = _gs(env)
    return (
        "Two players choose at the same time each round.\n"
        f"Both cooperate: 3 points each. Both defect: 1 point each. "
        f"You defect and they cooperate: 5 points to you, 0 to them (and the reverse).\n"
        f"This match runs {gs.get('num_rounds', ROUNDS)} rounds and starts with "
        f"{gs.get('total_conversation_rounds', TALK_TURNS)} round(s) of talk in each round.\n"
        "Only your own score matters for the table standings."
    )


def instruction(env, seat: int) -> tuple[str, str]:
    if can_say(env, seat):
        return ("Say one short line to the other player before you both choose.",
                "one short line of speech")
    return ("Choose whether to work together or sell them out.",
            "either [Cooperate] or [Defect]")


def table(env, seat_ids, meta) -> dict:
    gs = _gs(env)
    scores = gs.get("scores") or {}
    places = []
    for pid in range(len(seat_ids)):
        places.append({"seat": pid, "out": False, "note": f"{int(scores.get(pid, 0))} pts", "role": ""})
    return {
        "places": places,
        "round": gs.get("round", 1),
        "rounds": gs.get("num_rounds", ROUNDS),
        "talk_left": max(0, int(gs.get("total_conversation_rounds", TALK_TURNS))
                         - int(gs.get("conversation_round", 0))),
    }


def private(env, seat: int) -> dict:
    gs = _gs(env)
    scores = gs.get("scores") or {}
    return {"points": int(scores.get(seat, 0))}


def _name(env_seat: int, seat_ids, meta) -> str:
    field_seat = seat_ids[env_seat] if env_seat < len(seat_ids) else env_seat
    row = (meta or {}).get(field_seat) or {}
    if row.get("you"):
        return "you"
    return str(row.get("name") or "") or common.seat_name(field_seat)


def _join(names: list[str]) -> str:
    if len(names) == 1:
        return names[0]
    return ", ".join(names[:-1]) + " and " + names[-1]


def plain_reason(env, seat_ids, meta) -> str:
    """The last match in the table's words, naming the seats that played it.

    The vendored result reads "Player 1 wins 8 - 3.", which is the engine's
    zero-based bookkeeping. The card names seats the way the table does, so the
    winner and the scores are said in plain words here.
    """
    scores = _gs(env).get("scores") or {}
    rewards = env.state.rewards or {}
    best = max((float(rewards.get(pid, 0)) for pid in range(len(seat_ids))), default=0.0)
    winners = [pid for pid in range(len(seat_ids)) if best > 0 and float(rewards.get(pid, 0)) == best]
    s0 = int(scores.get(0, 0))
    s1 = int(scores.get(1, 0))
    high, low = max(s0, s1), min(s0, s1)
    if not winners:
        if s0 == s1:
            return f"The last match was a draw at {s0} points each."
        winner = 0 if s0 > s1 else 1
        return f"{_name(winner, seat_ids, meta)} wins the last match {high} - {low}."
    named = _join([_name(pid, seat_ids, meta) for pid in winners])
    if len(winners) == 1:
        return f"{named} wins the last match {high} - {low}."
    return f"{named} draw the last match {high} - {low}."


def reveal(env, seat_ids, meta) -> dict:
    gs = _gs(env)
    scores = gs.get("scores") or {}
    rewards = env.state.rewards or {}
    return {
        "points": [{"seat": pid, "points": int(scores.get(pid, 0))} for pid in range(len(seat_ids))],
        "winners": [pid for pid in range(len(seat_ids)) if rewards.get(pid, 0) > 0],
        "reason": plain_reason(env, seat_ids, meta),
    }


def scores(env, seat_ids, meta) -> dict[int, float]:
    gs = _gs(env)
    values = gs.get("scores") or {}
    return {pid: float(values.get(pid, 0)) for pid in range(len(seat_ids))}


def estimate(seats: int, model_seats: int) -> int:
    """Model calls: each model seat acts once per chat turn and once per round, per match.

    Every seat meets every other seat once, so one seat plays ``seats - 1`` matches.
    """
    if model_seats <= 0:
        return 0
    return model_seats * max(1, seats - 1) * ROUNDS * (TALK_TURNS + 1)


def beat(env) -> str:
    """One beat per round of the match."""
    return f"round-{int(env.state.game_state.get('round') or 1)}"
