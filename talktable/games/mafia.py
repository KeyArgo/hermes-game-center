"""Secret Mafia on a talking table.

Rules, roles and every check come from the vendored ``SecretMafiaEnv``. This
module only answers: what may this seat see, what may it click, what would a
simple built-in player do, and how is the table drawn.
"""

from __future__ import annotations

import random
import re

from .. import common, ta_envs

ID = "mafia"
TITLE = "Mafia"
# The rules write "Player 2" for the third seat; see ``words``.
_PLAYER_WORD = re.compile(r"\bPlayer (\d+)\b")
# Bracketed targets are zero-based, as the prompt and parser use them.
_BRACKET = re.compile(r"\[(\d+)\]")
_TARGET_TOKEN = re.compile(r"\[(\d+)\]")
BLURB = (
    "Six or more seats, two of them mafia. Talk by day, vote someone out, and "
    "the mafia picks a victim at night. The table decides who wins."
)
MIN_SEATS = 6
MAX_SEATS = 10
DEFAULT_SEATS = 6
DISCUSSION_ROUNDS = 1
# One turn per seat per phase, plus the night actions: a rough upper bound used
# for the up-front model-call estimate.
TURNS_PER_SEAT = 6

_NIGHT_TALK = (
    "Night is quiet. Nothing to say yet.",
    "I am here. Let us see who speaks first tomorrow.",
)
_DAY_LINES = (
    "I have nothing solid yet. I am listening.",
    "Someone is lying. Watch who votes the fastest.",
    "I would rather not throw a vote away on a guess.",
    "Someone here agreed with everything far too quickly.",
    "Let us hear from the quiet ones before we vote.",
)


def sessions(seats: int) -> list[list[int]]:
    return [list(range(seats))]


def build(seats: int):
    env = ta_envs.env_class("SecretMafiaEnv")(discussion_rounds=DISCUSSION_ROUNDS)
    return env


def reset(env, seat_ids, seed) -> None:
    env.reset(num_players=len(seat_ids), seed=seed)


def done(env) -> bool:
    return bool(env.state.done)


def current(env) -> int:
    return int(env.state.current_player_id)


def _phase(env):
    return env.state.game_state["phase"]


def _phase_name(env) -> str:
    return getattr(_phase(env), "value", str(_phase(env)))


def phase(env) -> dict:
    name = _phase_name(env)
    day = int(env.state.game_state.get("day_number", 1))
    if name == "Day-Discussion":
        return {"label": f"Day {day} · talking", "kind": "talk"}
    if name == "Day-Voting":
        return {"label": f"Day {day} · voting", "kind": "act"}
    if name.startswith("Night-"):
        # Everyone at the table sees the same words. Which night role is acting is
        # private: only that seat's own buttons and instruction say what it is doing.
        return {"label": f"Night {day} · the table sleeps", "kind": "act"}
    return {"label": name, "kind": "act"}


def _targets(env, seat: int) -> list[int]:
    gs = env.state.game_state
    alive = list(gs["alive_players"])
    name = _phase_name(env)
    if name == "Night-Mafia":
        return [pid for pid in alive if env.player_roles.get(pid) != "Mafia"]
    if name == "Night-Doctor":
        # The rules accept any living player, the doctor included: a doctor who expects
        # to be attacked has to be able to pick themself.
        return alive
    if name == "Night-Detective":
        # Investigating yourself answers nothing, so that turn is not offered.
        return [pid for pid in alive if pid != seat]
    return alive


def words(text: str) -> str:
    """The rules count players from zero; this table counts from one.

    "Player 2 IS a Mafia member" is about the third person as the buttons and the log
    name them, and so is "Player 2 has been eliminated", so every "Player N" the rules
    write is shifted to match. Bracketed targets ("[2]") are left alone: those are the
    numbers the prompt and the parser use.
    """
    return _PLAYER_WORD.sub(lambda found: f"Player {int(found.group(1)) + 1}", str(text or ""))


def narrate(text: str, name_of) -> str:
    """Seat names in the rules' own narration, the way the table names people.

    The rules write "Player 4 was killed during the night" and list votes as
    "Valid: [0], [1], [3]". The log is read by a person, so each one-based
    "Player N" and each zero-based "[N]" gives way to the name on that seat.
    An unknown number keeps its original words.
    """
    def swap_player(found):
        return str(name_of(int(found.group(1)) - 1) or found.group(0))

    told = _PLAYER_WORD.sub(swap_player, str(text or ""))

    def swap_target(found):
        return str(name_of(int(found.group(1))) or found.group(0))

    return _BRACKET.sub(swap_target, told)


def narrate_action(text: str, name_of, phase: str = "") -> str:
    """A move token as the person at the table reads it: "voted for Juno".

    The engine still records and replays "[3]"; only the words shown in the log
    change. A typed line is not a bare target token, so it is returned untouched.
    """
    found = _TARGET_TOKEN.fullmatch(str(text or "").strip())
    if not found:
        return text
    pid = int(found.group(1))
    name = str(name_of(pid) or "") or f"Player {pid + 1}"
    label = str(phase or "").lower()
    if "voting" in label:
        return f"voted for {name}"
    if "night" in label:
        return f"chose {name}"
    return f"named {name}"


def can_say(env, seat: int) -> bool:
    return not done(env) and current(env) == seat and _phase_name(env) == "Day-Discussion"


def turn_is_private(env, acting: int, viewer: int | None) -> bool:
    """Who is acting at night is the secret: the night order is mafia, doctor, detective."""
    return _phase_name(env).startswith("Night-") and viewer != acting


def _target_word(env, seat: int, pid: int, meta: dict | None = None) -> str:
    word = _name(pid, meta) if meta else f"Player {pid + 1}"
    if pid == seat:
        word += " (you)"
    if pid not in env.state.game_state["alive_players"]:
        word += " · out"
    return word


def actions(env, seat: int, draft=None, meta: dict | None = None) -> list[dict]:
    del draft
    if done(env):
        return []
    name = _phase_name(env)
    verb = "vote" if name == "Day-Voting" else "pick"
    label = "Vote out" if name == "Day-Voting" else (
        "Eliminate" if name == "Night-Mafia" else ("Protect" if name == "Night-Doctor" else "Investigate")
    )
    found = []
    for pid in _targets(env, seat):
        found.append({
            "id": f"{verb}-{pid}",
            "label": _target_word(env, seat, pid, meta),
            "hint": label,
            "raw": f"[{pid}]",
        })
    return found


def _wanted_target(text: str) -> int | None:
    """The seat a free-text answer names.

    A bare number is the seat number the prompt lists in brackets, which is
    zero-based ("vote from [0], [1], …"). The written name "Player 3" is
    one-based, because that is how the buttons and the log spell it out.
    """
    raw = str(text or "")
    named = re.search(r"player\s*(\d+)", raw, re.IGNORECASE)
    if named:
        return int(named.group(1)) - 1
    digits = "".join(ch if ch.isdigit() else " " for ch in raw)
    pieces = [piece for piece in digits.split() if piece]
    if not pieces:
        return None
    return int(pieces[-1])


def parse(env, seat: int, text: str, allowed: list[dict], draft=None):
    del draft
    if can_say(env, seat):
        said = common.clean(text)
        return ("act", said) if said else None
    said = str(text or "").strip().lower()
    for item in allowed:
        if said == str(item["id"]).lower() or said == item["raw"].lower():
            return ("act", item["raw"])
    # Free text from a model or a typed command: read the last number as a seat.
    wanted = _wanted_target(text)
    for item in allowed:
        if wanted is not None and item["raw"] == f"[{wanted}]":
            return ("act", item["raw"])
    return None


def bot(env, seat: int, rng: random.Random) -> str:
    name = _phase_name(env)
    if name == "Day-Discussion":
        others = [pid for pid in env.state.game_state["alive_players"] if pid != seat]
        other = rng.choice(others) if others else seat
        return rng.choice(_DAY_LINES).format(other=f"Player {other + 1}")
    targets = _targets(env, seat)
    if not targets:
        return ""
    if name == "Night-Mafia":
        # Never name a teammate: the mafia knows its own.
        return f"[{rng.choice(targets)}]"
    if name == "Day-Voting" and env.player_roles.get(seat) == "Mafia":
        return f"[{rng.choice(targets)}]"
    if name == "Night-Doctor":
        return f"[{seat if seat in targets else rng.choice(targets)}]"
    return f"[{rng.choice(targets)}]"


def brief(env, seat: int) -> str:
    """The seat's own role prompt, which is the only role text it may see."""
    for entry in env.state.observations.get(seat, []):
        try:
            _from, text, kind = entry
        except (TypeError, ValueError):
            continue
        if getattr(kind, "name", "") == "PROMPT":
            return str(text)
    return ""


def instruction(env, seat: int, meta: dict | None = None) -> tuple[str, str]:
    name = _phase_name(env)
    # The rules' own words, the buttons and the log name a player from one; the
    # bracketed target is the seat number behind the button. Both are printed, so a
    # model can copy either and never has to work out the offset itself.
    # Seat numbers only, never a person's name: the model reads this line, and a name in a
    # prompt is the one thing the table promises never to hand it.
    targets = ", ".join(f"[{pid}] is Player {pid + 1}" for pid in _targets(env, seat))
    # An answer is the table's own name for a player ("Player 3"), never a bare bracket the
    # model would have to count against the list itself.
    example = f"Player {_targets(env, seat)[0] + 1}" if _targets(env, seat) else "Player 2"
    if name == "Day-Discussion":
        return ("Say one or two short sentences to the whole table (20 words at most). "
                "Do not name a role you were told in secret.", "one short line of speech")
    if name == "Day-Voting":
        return (f"Vote to remove one player from {targets}.", example)
    if name == "Night-Mafia":
        return (f"Choose one player to eliminate from {targets}.", example)
    if name == "Night-Doctor":
        return (f"Choose one player to protect from {targets}.", example)
    return (f"Choose one player to investigate from {targets}.", example)


def table(env, seat_ids, meta) -> dict:
    gs = env.state.game_state
    alive = set(gs.get("alive_players", []))
    places = []
    for seat in seat_ids:
        places.append({
            "seat": seat,
            "out": seat not in alive,
            "note": "" if seat in alive else "out",
            "role": "",
        })
    return {"places": places, "alive": len(alive), "day": gs.get("day_number", 1)}


def private(env, seat: int) -> dict:
    """Only the seat's own role, and only before the reveal."""
    return {"role": env.player_roles.get(seat, ""), "alive": seat in env.state.game_state["alive_players"]}


def _name(seat: int, meta) -> str:
    row = (meta or {}).get(seat) or {}
    if row.get("you"):
        return "you"
    return str(row.get("name") or "") or common.seat_name(seat)


def _join(names: list[str]) -> str:
    if len(names) == 1:
        return names[0]
    return ", ".join(names[:-1]) + " and " + names[-1]


def plain_reason(env, seat_ids, meta) -> str:
    """The finish in the table's own words: the winning side and its players.

    The vendored result names the side but nobody in it, so the card would say
    only "Mafia wins!". The card and the reveal name seats the way the table
    does, so the winning seats are spelled out here instead of raw numbers.
    """
    roles = env.player_roles or {}
    rewards = env.state.rewards or {}
    best = max((float(rewards.get(seat, 0)) for seat in seat_ids), default=0.0)
    winners = [seat for seat in seat_ids if best > 0 and float(rewards.get(seat, 0)) == best]
    mafia = [seat for seat in seat_ids if roles.get(seat) == "Mafia"]
    mafia_won = bool(winners) and bool(set(winners) & set(mafia))
    side = "mafia" if mafia_won else "village"
    team = [seat for seat in seat_ids if (roles.get(seat) == "Mafia") == mafia_won]
    named = _join([_name(seat, meta) for seat in team])
    if not named:
        return f"The {side} won."
    return f"The {side} won. {named} were the {side}."


def reveal(env, seat_ids, meta) -> dict:
    roles = []
    mafia = []
    for seat in seat_ids:
        role = env.player_roles.get(seat, "")
        roles.append({"seat": seat, "role": role})
        if role == "Mafia":
            mafia.append(seat)
    rewards = env.state.rewards or {}
    winners = [seat for seat in seat_ids if rewards.get(seat, 0) > 0]
    return {
        "roles": roles,
        "mafia": mafia,
        "winners": winners,
        "reason": plain_reason(env, seat_ids, meta),
    }


def scores(env, seat_ids, meta) -> dict[int, float]:
    rewards = env.state.rewards or {}
    return {seat: float(rewards.get(seat, 0)) for seat in seat_ids}


def estimate(seats: int, model_seats: int) -> int:
    return max(1, model_seats) * TURNS_PER_SEAT


def beat(env) -> str:
    """One beat per phase, and a new one whenever the field shrinks."""
    gs = env.state.game_state
    alive = len(gs.get("alive_players") or [])
    return f"{_phase_name(env)}-day-{int(gs.get('day_number') or 0)}-alive-{alive}"
