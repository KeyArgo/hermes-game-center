"""Liar's Dice on a talking table.

Every bid and every call is judged by the vendored ``LiarsDiceEnv``. There is
no table talk in this game (the environment treats anything that is not a bid
or a call as an illegal move), so the message box stays shut.
"""

from __future__ import annotations

import random
import re

from .. import common, ta_envs

ID = "liars-dice"
TITLE = "Liar's Dice"
BLURB = (
    "Everyone rolls five dice and keeps them hidden. Bid higher on how many of "
    "one face are on the table, or call the last bid a lie."
)
MIN_SEATS = 2
MAX_SEATS = 6
DEFAULT_SEATS = 4
NUM_DICE = 5
TURNS_PER_SEAT = 10

_BID = re.compile(r"\[bid\s*:?\s*(\d+)\s*[,\s]\s*(\d+)\]", re.IGNORECASE)
_CALL = re.compile(r"\[call\]", re.IGNORECASE)
_PLAYER_WORD = re.compile(r"\bPlayer (\d+)\b")


def words(text: str) -> str:
    """The rules count players from zero; this table counts from one.

    Every round's notice ends "Remaining dice: Player 0: 5; ...", which a model
    would otherwise read as a different seat from the one the table and its own
    prompt name. Bracketed bids carry no player number, so nothing else moves.
    """
    return _PLAYER_WORD.sub(lambda found: f"Player {int(found.group(1)) + 1}", str(text or ""))


def narrate(text: str, name_of) -> str:
    """Seat names in the rules' own narration, the way the rest of the table names them.

    The rules tell the round in environment numbers: "Player 2 bids 2 of face 1",
    "Player 1 calls! ... Player 3 (the caller) loses one die." Read at the table
    every seat then looks like a numbered stranger (the bug hunt), so each number
    gives way to the name the seat carries. An unknown number keeps its number.
    """

    def swap(found):
        return str(name_of(int(found.group(1)) - 1) or found.group(0))

    return _PLAYER_WORD.sub(swap, str(text or ""))


def sessions(seats: int) -> list[list[int]]:
    return [list(range(seats))]


def build(seats: int):
    return ta_envs.env_class("LiarsDiceEnv")(num_dice=NUM_DICE)


def reset(env, seat_ids, seed) -> None:
    env.reset(num_players=len(seat_ids), seed=seed)


def done(env) -> bool:
    return bool(env.state.done)


def current(env) -> int:
    return int(env.state.current_player_id)


def phase(env) -> dict:
    bid = env.state.game_state.get("current_bid") or {}
    quantity = int(bid.get("quantity") or 0)
    face = int(bid.get("face_value") or 0)
    if quantity:
        label = f"Bidding · the bid is {quantity} × {face}s"
    else:
        label = "Bidding · first bid"
    return {"label": label, "kind": "act"}


def can_say(env, seat: int) -> bool:
    return False


def _valid(quantity: int, face: int, bid: dict) -> bool:
    """The environment's own "strictly higher" rule, mirrored for the buttons."""
    old_q = int(bid.get("quantity") or 0)
    old_f = int(bid.get("face_value") or 0)
    if face < 1 or face > 6:
        return False
    if quantity < old_q or face < old_f:
        return False
    return not (quantity == old_q and face == old_f)


def label(raw: str) -> str:
    """A move in the words the buttons use, for the table's log.

    The log prints whatever the rules said, and the rules speak in machine action
    tokens: ``Browser QA (you):[Bid: 1, 1]`` and ``[Call]`` under a player's name
    (the bug hunt). The same words the bid buttons carry say it in plain English.
    """
    text = str(raw or "").strip()
    call = _CALL.fullmatch(text)
    if call:
        return "called the bid a lie"
    bid = _BID.fullmatch(text)
    if bid:
        return f"bid {int(bid.group(1))} × {int(bid.group(2))}s"
    return text


def actions(env, seat: int, draft=None) -> list[dict]:
    del draft
    if done(env):
        return []
    bid = env.state.game_state.get("current_bid") or {}
    quantity = int(bid.get("quantity") or 0)
    face = int(bid.get("face_value") or 0)
    found = []
    if quantity:
        found.append({"id": "call", "label": "Call the bid a lie", "hint": "Reveal the dice",
                      "raw": "[Call]"})
    # One more of each face is always a legal raise, so every button below works.
    for wanted in range(1, 7):
        if not _valid(quantity + 1, wanted, bid):
            continue
        if quantity and wanted < face:
            continue
        found.append({
            "id": f"bid-{quantity + 1}-{wanted}",
            "label": f"{quantity + 1} × {wanted}s",
            "hint": "Raise the bid",
            "raw": f"[Bid: {quantity + 1}, {wanted}]",
            "group": "One more die",
        })
    # The rules also accept the same count on a higher face (2 × 3s → 2 × 4s), and
    # that is the cheaper raise; without these it was a move only a model could make.
    if quantity:
        for wanted in range(face + 1, 7):
            if not _valid(quantity, wanted, bid):
                continue
            found.append({
                "id": f"bid-{quantity}-{wanted}",
                "label": f"{quantity} × {wanted}s",
                "hint": "Same count, higher face",
                "raw": f"[Bid: {quantity}, {wanted}]",
                "group": "Same count",
            })
    return found


def parse(env, seat: int, text: str, allowed: list[dict], draft=None):
    del draft
    bid = env.state.game_state.get("current_bid") or {}
    said = str(text or "").strip().lower()
    for item in allowed:
        if said == item["id"] or said == item["raw"].lower():
            return ("act", item["raw"])
    if said in {"call", "lie", "liar", "call the bid a lie"}:
        for item in allowed:
            if item["id"] == "call":
                return ("act", item["raw"])
        if not int(bid.get("quantity") or 0):
            return ("refuse", "Refused: There is no bid to call yet.")
    raw = str(text or "")
    found = _BID.search(raw)
    if found:
        quantity, face = int(found.group(1)), int(found.group(2))
        if not _valid(quantity, face, bid):
            return ("refuse", "Refused: Your bid must raise the last bid.")
    return None


def parse_free(env, seat: int, text: str):
    """A model's own wording, checked against the environment's bid rule.

    A raise the buttons do not offer is still a legal raise, so a model that
    says ``[Bid: 2, 2]`` is taken at its word rather than being told it failed.
    """
    raw = str(text or "")
    bid = env.state.game_state.get("current_bid") or {}
    if _CALL.search(raw):
        return "[Call]" if int(bid.get("quantity") or 0) else None
    found = _BID.search(raw)
    if not found:
        return None
    quantity, face = int(found.group(1)), int(found.group(2))
    if 1 <= quantity <= 200 and _valid(quantity, face, bid):
        return f"[Bid: {quantity}, {face}]"
    return None


def _own_dice(env, seat: int) -> list[int]:
    rolls = env.state.game_state.get("dice_rolls") or {}
    return [int(value) for value in rolls.get(seat, [])]


def bot(env, seat: int, rng: random.Random) -> str:
    bid = env.state.game_state.get("current_bid") or {}
    quantity = int(bid.get("quantity") or 0)
    face = int(bid.get("face_value") or 0)
    dice = _own_dice(env, seat)
    dice_left = env.state.game_state.get("remaining_dice") or {}
    total = sum(int(value) for value in dice_left.values()) or 1
    # How many of a face should be on the table, before anyone lies about it.
    expected = total / 6.0
    if quantity and quantity > expected + 1.5:
        return "[Call]"
    counts = {wanted: dice.count(wanted) for wanted in range(1, 7)}
    best = max(counts, key=lambda wanted: (counts[wanted], -abs(wanted - (face or 1))))
    if quantity and best < face:
        best = face
    for wanted in range(best, 7):
        if _valid(quantity + 1, wanted, bid):
            return f"[Bid: {quantity + 1}, {wanted}]"
    return "[Call]" if quantity else "[Bid: 1, 1]"


def brief(env, seat: int) -> str:
    return ("You hold hidden dice that only you can see. Nobody else knows your roll, "
            "and you never see theirs.")


def learn_tip(env, seat: int, raw: str) -> str:
    """One honest word about the move the person just made, in a guided game.

    Only public information and the person's own dice go into this: the expected
    count of a face (dice still in play divided by six), and how many of it they
    can already see. A hidden roll is never read here.
    """
    bid = env.state.game_state.get("current_bid") or {}
    quantity = int(bid.get("quantity") or 0)
    face = int(bid.get("face_value") or 0)
    dice = _own_dice(env, seat)
    dice_left = env.state.game_state.get("remaining_dice") or {}
    total = sum(int(value) for value in dice_left.values()) or len(dice) or 1
    expected = max(1, round(total / 6.0))
    text = str(raw or "").strip().lower()
    if text.startswith("[call"):
        hold = dice.count(face) if face else 0
        if quantity and hold >= max(1, quantity - 1):
            return (f"Your own dice hold {hold} of the {face}s, so at least {hold} are "
                    f"already on the table. Calling a bid of {quantity} may be a gift. "
                    "Undo and bid instead if you were not sure.")
        return ""
    found = re.match(r"\[bid:?\s*(\d+)\s*[,]\s*(\d+)\]", text)
    if found:
        want_q, want_f = int(found.group(1)), int(found.group(2))
        if want_q >= expected + 2:
            return (f"About {expected} of each face are on the table, and you hold "
                    f"{dice.count(want_f)} of the {want_f}s. A bid of {want_q} is a big "
                    "bluff — the computer calls bids like that. Undo and bid lower if "
                    "you did not mean it.")
    return ""


def _legal_replies(env) -> list[str]:
    """The raises the rules allow right now, in the order a person would see them."""
    bid = env.state.game_state.get("current_bid") or {}
    quantity = int(bid.get("quantity") or 0)
    face = int(bid.get("face_value") or 0)
    found = ["[Call]"] if quantity else []
    for wanted in range(1, 7):
        if quantity and wanted < face:
            continue
        if _valid(quantity + 1, wanted, bid):
            found.append(f"[Bid: {quantity + 1}, {wanted}]")
    return found[:8]


def instruction(env, seat: int) -> tuple[str, str]:
    bid = env.state.game_state.get("current_bid") or {}
    quantity = int(bid.get("quantity") or 0)
    face = int(bid.get("face_value") or 0)
    options = ", ".join(_legal_replies(env))
    if quantity:
        return (f"The bid is {quantity} × {face}s. Either call it a lie or raise it. "
                f"The rules allow only these right now: {options}.",
                "one of those replies, exactly")
    return (f"Open the bidding. The rules allow only these right now: {options}.",
            "one bid like [Bid: 2, 5]")


def table(env, seat_ids, meta) -> dict:
    gs = env.state.game_state
    remaining = gs.get("remaining_dice") or {}
    bid = gs.get("current_bid") or {}
    places = []
    for seat in seat_ids:
        left = int(remaining.get(seat, 0))
        places.append({
            "seat": seat,
            "out": int(remaining.get(seat, 0)) <= 0,
            # One die reads "1 die"; the count is dice only while there are several.
            "note": f"{left} die" if left == 1 else f"{left} dice",
            "role": "",
        })
    return {
        "places": places,
        "bid": {"quantity": int(bid.get("quantity") or 0), "face": int(bid.get("face_value") or 0)},
        "dice_left": sum(int(value) for value in remaining.values()),
    }


def private(env, seat: int) -> dict:
    """The seat's own hidden dice, and nothing about anyone else's."""
    remaining = env.state.game_state.get("remaining_dice") or {}
    return {"dice": _own_dice(env, seat), "dice_left": int(remaining.get(seat, 0))}


def _placement(rank: int) -> str:
    if 0 <= rank < len(_PLACEMENTS):
        return _PLACEMENTS[rank]
    return f"{rank + 1}th"


_PLACEMENTS = ("1st", "2nd", "3rd", "4th", "5th", "6th")


def plain_reason(env, seat_ids, meta) -> str:
    """The finish in the table's own words: a winner by name, the places by name.

    The vendored result reads "Player 2 wins! Final ranking: [0, 1, 3, 2]" — the
    engine's zero-based bookkeeping. The card and the reveal name seats the way
    the table does ("Rook wins."), so the raw line is turned into plain words here.
    """
    best = max((float((env.state.rewards or {}).get(seat, 0)) for seat in seat_ids), default=0.0)
    winners = [seat for seat in seat_ids if best > 0 and float((env.state.rewards or {}).get(seat, 0)) == best]

    def name(field_seat: int) -> str:
        row = (meta or {}).get(field_seat) or {}
        label = str(row.get("name") or "") if not row.get("you") else "you"
        return label or common.seat_name(field_seat)

    def name_env(env_seat: int) -> str:
        return name(env_seat) if env_seat < len(seat_ids) else f"Player {env_seat + 1}"

    if not winners:
        return "No seat won: the table ran out of dice."
    if len(winners) == 1:
        head = f"{name_env(winners[0])} wins."
    else:
        named = [name_env(seat) for seat in winners]
        head = f"{', '.join(named[:-1])} and {named[-1]} win."
    # The order the env paid out is the finishing order: last rewards rank highest.
    ranking = sorted(seat_ids, key=lambda seat: float((env.state.rewards or {}).get(seat, 0)), reverse=True)
    places = ", ".join(f"{_placement(rank)} {name(seat)}" for rank, seat in enumerate(ranking))
    return f"{head} Finishing order: {places}."


def reveal(env, seat_ids, meta) -> dict:
    gs = env.state.game_state
    rolls = gs.get("dice_rolls") or {}
    remaining = gs.get("remaining_dice") or {}
    rewards = env.state.rewards or {}
    best = max((float(rewards.get(seat, 0)) for seat in seat_ids), default=0.0)
    return {
        "dice": [{"seat": seat, "dice": [int(v) for v in rolls.get(seat, [])],
                  "left": int(remaining.get(seat, 0))} for seat in seat_ids],
        # The environment pays every surviving seat by placement, so the winner is
        # the top reward, not everyone who scored something.
        "winners": [seat for seat in seat_ids if best > 0 and float(rewards.get(seat, 0)) == best],
        "reason": plain_reason(env, seat_ids, meta),
    }


def scores(env, seat_ids, meta) -> dict[int, float]:
    rewards = env.state.rewards or {}
    return {seat: float(rewards.get(seat, 0)) for seat in seat_ids}


def estimate(seats: int, model_seats: int) -> int:
    return max(1, model_seats) * TURNS_PER_SEAT


def beat(env) -> str:
    """Where a round ends here: every call that costs a seat a die starts a new one.

    The coach window opens on a new beat, so a person gets one whisper between
    calls, not one per bid.
    """
    remaining = env.state.game_state.get("remaining_dice") or {}
    total = sum(int(value) for value in remaining.values())
    alive = sum(1 for value in remaining.values() if int(value) > 0)
    return f"dice-{total}-alive-{alive}"
