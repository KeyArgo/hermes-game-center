"""Liar's Dice, two teams of two, on a talking table.

The rules are the vendored ``LiarsDiceEnv`` rules: five hidden dice a seat, bids
that only go up, and a call that shows the dice. Three things change for teams:

* seats 0 and 2 are one team, seats 1 and 3 the other, so the turn order
  alternates between the teams all the way round;
* each team owns *one* pool of ten dice, not a cup per seat. The pool is split
  as evenly as it can be each round, and a team that loses a call loses a die
  from the pool, so a partner's mistake costs both seats. A team is out when
  its pool reaches zero;
* anything a seat says that is not a bid or a call is public table talk. There
  is no private channel: a partner can only signal in plain sight, in a bid or
  in a said line that the other team also reads.
"""

from __future__ import annotations

import random
import re

from .. import common, ta_envs

ID = "liars-dice-2v2"
TITLE = "Liar's Dice 2v2"
BLURB = (
    "Four seats, two teams. Each team shares one pool of ten dice: bid higher on "
    "how many of a face are on the table, or call the last bid a lie. A team that "
    "loses a call loses a die from its shared pool. Partners may only talk in the open."
)
MIN_SEATS = 4
MAX_SEATS = 4
DEFAULT_SEATS = 4
NUM_DICE = 5
POOL = NUM_DICE * 2
TURNS_PER_SEAT = 10
LEVELS = ("beginner", "intermediate", "advanced", "expert")
DEFAULT_LEVEL = "intermediate"
LEVEL_WORDS = {
    "beginner": "Beginner",
    "intermediate": "Intermediate",
    "advanced": "Advanced",
    "expert": "Expert",
}
# The second seat handed out is the partner's (seat 2, same team as the person),
# not the next number: the person and their guest sit on the same side.
FILL_ORDER = (0, 2, 1, 3)
# One guest only. A second model seat would be playing for the other team.
MAX_GUESTS = 1
# Seat 0 and 2 vs 1 and 3: the turn order 0-1-2-3 alternates between teams.
TEAM_OF = {0: 0, 1: 1, 2: 0, 3: 1}
TEAM_SEATS = {0: (0, 2), 1: (1, 3)}
TEAM_WORDS = {0: "your team", 1: "the other team"}

_BID = re.compile(r"\[bid\s*:?\s*(\d+)\s*[,\s]\s*(\d+)\]", re.IGNORECASE)
_CALL = re.compile(r"\[call\]", re.IGNORECASE)
_PLAYER_WORD = re.compile(r"\bPlayer (\d+)\b")

# One public line a machine seat may use to signal its partner. It is a
# convention, not a secret: both teams read it, and it is only ever about the
# face this seat holds most of, never an exact count.
SIGNALS = {
    1: "I am holding ones.",
    2: "I am holding twos.",
    3: "I am holding threes.",
    4: "I am holding fours.",
    5: "I am holding fives.",
    6: "I am holding sixes.",
}


def words(text: str) -> str:
    """The rules count players from zero; this table counts from one."""
    return _PLAYER_WORD.sub(lambda found: f"Player {int(found.group(1)) + 1}", str(text or ""))


def _env_class():
    ta_envs.load()
    from textarena.envs.LiarsDice.env import LiarsDiceEnv

    return LiarsDiceEnv


def _team_seats(seat: int) -> tuple[int, int]:
    return TEAM_SEATS[TEAM_OF[int(seat)]]


def _split(pool: int) -> tuple[int, int]:
    """A shared pool split as evenly as it goes: the first seat takes the odd die."""
    return (pool + 1) // 2, pool // 2


class TeamLiarsDiceEnv(_env_class()):
    """The vendored rules, with a shared pool per team and public table talk."""

    def set_lang(self, lang) -> None:
        """Use the vendored Liar's Dice wording: this class lives in another folder.

        The rules class loads its strings from a ``locales`` folder beside its own
        source file. A subclass in this repo has no such folder, so it points at the
        vendored one rather than carrying a second copy of the same words.
        """
        from textarena.utils.locales.localeloader import build_locale

        self.lang = lang
        self._locale = build_locale(str(ta_envs.PACKAGE / "envs" / "LiarsDice" / "locales"), lang="en")

    def reset(self, num_players: int, seed=None) -> None:
        if int(num_players) != 4:
            raise ValueError("a 2v2 table seats exactly four")
        super().reset(int(num_players), seed)
        state = self.state.game_state
        state["teams"] = dict(TEAM_OF)
        state["team_dice"] = {0: POOL, 1: POOL}
        state["round"] = 1
        state["said"] = []
        # reset() already dealt five dice a seat, which is the starting split.
        self._split_pool()

    # -- the shared pool ---------------------------------------------------

    def _split_pool(self) -> None:
        """Hand each seat its half of the team's pool, then roll what is dealt."""
        state = self.state.game_state
        for team, seats in TEAM_SEATS.items():
            first, second = _split(int(state["team_dice"][team]))
            state["remaining_dice"][seats[0]] = first
            state["remaining_dice"][seats[1]] = second

    def _roll_round(self) -> None:
        self._split_pool()
        self._roll_new_dice()

    # -- public table talk -------------------------------------------------

    def _say(self, seat: int, text: str):
        ta = self.ta
        said = " ".join(str(text or "").split())[:common.MAX_SAY]
        if not said:
            return self.state.step(rotate_player=False)
        self.state.game_state.setdefault("said", []).append({"seat": int(seat), "text": said})
        self.state.add_observation(
            from_id=int(seat), message=said,
            observation_type=ta.ObservationType.PLAYER_ACTION,
        )
        # Talking does not pass the turn: the seat still has to bid or call.
        return self.state.step(rotate_player=False)

    # -- the rules, with teams --------------------------------------------

    def step(self, action: str):
        text = str(action or "")
        if not _CALL.search(text) and not _BID.search(text):
            return self._say(self.state.current_player_id, text)
        return super().step(text)

    def _handle_invalid_move(self, reason: str) -> None:
        # The table's buttons and parsers never send an illegal bid, but a model
        # can. An illegal line is answered in the open and the seat keeps its turn
        # rather than losing a die, because the lose-a-die rule here is team-wide.
        ta = self.ta
        self.state.add_observation(
            to_id=self.state.current_player_id, message=str(reason),
            observation_type=ta.ObservationType.GAME_ADMIN,
        )

    def _apply_die_loss(self, loser_id: int, message: str) -> None:
        ta = self.ta
        self.state.add_observation(
            from_id=ta.GAME_ID, to_id=-1, message=message,
            observation_type=ta.ObservationType.GAME_MESSAGE,
        )
        state = self.state.game_state
        team = TEAM_OF[int(loser_id)]
        state["team_dice"][team] = max(0, int(state["team_dice"][team]) - 1)
        state["round"] = int(state.get("round") or 1) + 1
        state["said"] = []
        self._roll_round()

    def _rotate_players(self) -> None:
        state = self.state.game_state
        pools = state["team_dice"]
        if sum(1 for team in (0, 1) if int(pools[team]) > 0) <= 1:
            self._set_outcome()
            return
        count = self.state.num_players
        start = self.state.current_player_id
        for step in range(1, count + 1):
            pid = (start + step) % count
            if int(pools[TEAM_OF[pid]]) > 0 and int(state["remaining_dice"].get(pid, 0)) > 0:
                self.state.manually_set_current_player_id(new_player_id=pid, force=True)
                return
        self._set_outcome()

    def _set_outcome(self) -> None:
        state = self.state.game_state
        pools = state["team_dice"]
        alive = [team for team in (0, 1) if int(pools[team]) > 0]
        winner = alive[0] if len(alive) == 1 else None
        rewards = {}
        for pid in range(self.state.num_players):
            if winner is None:
                rewards[pid] = 0.0
            else:
                rewards[pid] = 1.0 if TEAM_OF[pid] == winner else -1.0
        if winner is None:
            reason = "The two teams still had dice when the table stopped."
        else:
            reason = (f"Team {winner + 1} wins: the other team has no dice left. "
                      f"Shared pools {int(pools[1 - winner])} to {int(pools[winner])}.")
        self.state.set_game_outcome(reward_dict=rewards, reason=reason)


class _Ta:
    """The vendored package, loaded once, for its observation kinds."""

    _module = None

    def __getattr__(self, name):
        if _Ta._module is None:
            _Ta._module = ta_envs.load()
        return getattr(_Ta._module, name)


TeamLiarsDiceEnv.ta = _Ta()


def sessions(seats: int) -> list[list[int]]:
    del seats
    return [[0, 1, 2, 3]]


def build(seats: int):
    del seats
    return TeamLiarsDiceEnv()


def reset(env, seat_ids, seed) -> None:
    env.reset(num_players=len(seat_ids), seed=seed)


def done(env) -> bool:
    return bool(env.state.done)


def current(env) -> int:
    return int(env.state.current_player_id)


def phase(env) -> dict:
    state = env.state.game_state
    pools = state.get("team_dice") or {}
    bid = state.get("current_bid") or {}
    quantity = int(bid.get("quantity") or 0)
    face = int(bid.get("face_value") or 0)
    if quantity:
        label = (f"Bidding · {quantity} × {face}s · pools {int(pools.get(0, 0))} v "
                 f"{int(pools.get(1, 0))}")
    else:
        label = (f"First bid · pools {int(pools.get(0, 0))} v {int(pools.get(1, 0))}")
    return {"label": label, "kind": "act"}


def can_say(env, seat: int) -> bool:
    """Table talk is open on your own turn: it is public, and the rules judge no words."""
    return not done(env) and current(env) == int(seat)


def _dice_left(env) -> int:
    remaining = env.state.game_state.get("remaining_dice") or {}
    return sum(int(value) for value in remaining.values())


def _valid(quantity: int, face: int, bid: dict) -> bool:
    old_q = int(bid.get("quantity") or 0)
    old_f = int(bid.get("face_value") or 0)
    if face < 1 or face > 6:
        return False
    if quantity < old_q or face < old_f:
        return False
    return not (quantity == old_q and face == old_f)


def actions(env, seat: int, draft=None) -> list[dict]:
    del draft
    if done(env):
        return []
    bid = env.state.game_state.get("current_bid") or {}
    quantity = int(bid.get("quantity") or 0)
    face = int(bid.get("face_value") or 0)
    total = max(1, _dice_left(env))
    found = []
    if quantity:
        found.append({"id": "call", "label": "Call the bid a lie",
                      "hint": "Reveal the dice", "raw": "[Call]"})
    for wanted in range(1, 7):
        if quantity and wanted < face:
            continue
        if quantity + 1 > total:
            continue
        if not _valid(quantity + 1, wanted, bid):
            continue
        found.append({
            "id": f"bid-{quantity + 1}-{wanted}",
            "label": f"{quantity + 1} × {wanted}s",
            "hint": "One more die",
            "raw": f"[Bid: {quantity + 1}, {wanted}]",
            "group": "One more die",
        })
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
    del env, seat, draft
    said = str(text or "").strip().lower()
    for item in allowed:
        if said == item["id"] or said == item["raw"].lower():
            return ("act", item["raw"])
    if said in {"call", "lie", "liar", "call the bid a lie"}:
        for item in allowed:
            if item["id"] == "call":
                return ("act", item["raw"])
    return None


def parse_free(env, seat: int, text: str):
    del seat
    raw = str(text or "")
    bid = env.state.game_state.get("current_bid") or {}
    if _CALL.search(raw):
        return "[Call]" if int(bid.get("quantity") or 0) else None
    found = _BID.search(raw)
    if not found:
        return None
    quantity, face = int(found.group(1)), int(found.group(2))
    if 1 <= quantity <= _dice_left(env) and _valid(quantity, face, bid):
        return f"[Bid: {quantity}, {face}]"
    return None


def _own_dice(env, seat: int) -> list[int]:
    rolls = env.state.game_state.get("dice_rolls") or {}
    return [int(value) for value in rolls.get(seat, [])]


def _partner(seat: int) -> int:
    first, second = _team_seats(seat)
    return second if int(seat) == first else first


def _level(env) -> str:
    found = str(getattr(env, "level", "") or DEFAULT_LEVEL).lower()
    return found if found in LEVELS else DEFAULT_LEVEL


def _said_this_round(env, seat: int) -> bool:
    for entry in env.state.game_state.get("said") or []:
        if int(entry.get("seat", -1)) == int(seat):
            return True
    return False


def bot(env, seat: int, rng: random.Random, history=None) -> str:
    """A machine seat: it signals once a round, then bids or calls on its level."""
    del history
    level = _level(env)
    state = env.state.game_state
    dice = _own_dice(env, seat)
    bid = state.get("current_bid") or {}
    quantity = int(bid.get("quantity") or 0)
    face = int(bid.get("face_value") or 0)
    total = max(1, _dice_left(env))
    expected = total / 6.0

    counts = {wanted: dice.count(wanted) for wanted in range(1, 7)}
    best = max(counts, key=lambda wanted: (counts[wanted], -abs(wanted - (face or 1))))

    # Advanced and expert seats use the public convention: the first time they
    # move in a round, they name the face they hold most of. Everyone reads it.
    if level in {"advanced", "expert"} and not _said_this_round(env, seat) and counts[best] >= 2:
        return SIGNALS[best]

    # How many of the named face the seat believes are on the table: its own
    # dice, plus what a partner's signal or bid says, plus the field's average.
    believed = counts.get(face, 0) if face else 0
    seen_signal = 0
    for said in state.get("said") or []:
        if int(said.get("seat", -1)) == _partner(seat):
            for wanted, line in SIGNALS.items():
                if str(said.get("text") or "") == line:
                    seen_signal = wanted
    if seen_signal and face and seen_signal == face:
        believed += 1

    slack = {"beginner": 2.5, "intermediate": 1.6, "advanced": 1.0, "expert": 0.6}[level]
    if quantity and quantity > max(believed, expected) + slack:
        return "[Call]"

    # A raise the seat can defend: one more of the face it holds most of, or the
    # cheapest legal step when that face is already behind the bid.
    want = best
    if quantity and want < face:
        want = face
    if quantity and counts[want] == 0:
        want = face
    for wanted in range(want, 7):
        if not _valid(quantity + 1, wanted, bid):
            continue
        if quantity + 1 > total:
            break
        # Beginners pick the first legal raise; the stronger levels pick the face
        # they can actually support.
        if level == "beginner" or counts[wanted] > 0 or not quantity:
            return f"[Bid: {quantity + 1}, {wanted}]"
    if quantity:
        return "[Call]"
    first = best if level != "beginner" else 1
    return f"[Bid: 1, {first}]"


def brief(env, seat: int) -> str:
    team = TEAM_OF[int(seat)]
    partner = _partner(seat)
    return (
        f"You sit on team {team + 1} with seat {partner + 1}, and the turn order alternates "
        "between the teams. Your team shares ONE pool of dice: every die your team loses "
        "costs both of you, and your own cup is just your half of it this round. There is no "
        "private channel. You may say one public line on your turn (it is visible to both "
        "teams), and a convention such as naming the face you hold most of is a fair signal. "
        "Nothing else is hidden from the table except everyone's dice."
    )


def _legal_replies(env) -> list[str]:
    bid = env.state.game_state.get("current_bid") or {}
    quantity = int(bid.get("quantity") or 0)
    face = int(bid.get("face_value") or 0)
    total = max(1, _dice_left(env))
    found = ["[Call]"] if quantity else []
    for wanted in range(1, 7):
        if quantity and wanted < face:
            continue
        if quantity + 1 <= total and _valid(quantity + 1, wanted, bid):
            found.append(f"[Bid: {quantity + 1}, {wanted}]")
    return found[:8]


def instruction(env, seat: int) -> tuple[str, str]:
    bid = env.state.game_state.get("current_bid") or {}
    quantity = int(bid.get("quantity") or 0)
    face = int(bid.get("face_value") or 0)
    options = ", ".join(_legal_replies(env))
    pools = env.state.game_state.get("team_dice") or {}
    if quantity:
        return (f"The bid is {quantity} × {face}s. Your team has {int(pools.get(TEAM_OF[int(seat)], 0))} "
                f"dice in its pool and the other team {int(pools.get(1 - TEAM_OF[int(seat)], 0))}. "
                f"Either call it a lie or raise it. The rules allow only these right now: {options}.",
                "one of those replies, exactly")
    return (f"Open the bidding. The rules allow only these right now: {options}.",
            "one bid like [Bid: 2, 5]")


def table(env, seat_ids, meta) -> dict:
    del meta
    state = env.state.game_state
    remaining = state.get("remaining_dice") or {}
    pools = state.get("team_dice") or {}
    bid = state.get("current_bid") or {}
    places = []
    for seat in seat_ids:
        places.append({
            "seat": seat,
            "out": int(remaining.get(seat, 0)) <= 0,
            "note": f"{int(remaining.get(seat, 0))} dice",
            "role": "",
        })
    teams = []
    for team, seats in TEAM_SEATS.items():
        pool = int(pools.get(team, 0))
        teams.append({
            "team": team,
            "seats": list(seats),
            "dice": pool,
            "out": pool <= 0,
            "spread": list(_split(pool)),
        })
    last = state.get("last_bidder_id")
    return {
        "places": places,
        "bid": {"quantity": int(bid.get("quantity") or 0), "face": int(bid.get("face_value") or 0)},
        "dice_left": sum(int(value) for value in remaining.values()),
        "teams": teams,
        "round": int(state.get("round") or 1),
        "last_bidder": None if last is None else int(last),
    }


def private(env, seat: int) -> dict:
    state = env.state.game_state
    remaining = state.get("remaining_dice") or {}
    pools = state.get("team_dice") or {}
    team = TEAM_OF[int(seat)]
    partner = _partner(seat)
    return {
        "dice": _own_dice(env, seat),
        "dice_left": int(remaining.get(seat, 0)),
        "team": team,
        "team_dice": int(pools.get(team, 0)),
        "partner": partner,
        "partner_dice": int(remaining.get(partner, 0)),
        "other_team_dice": int(pools.get(1 - team, 0)),
    }


def reveal(env, seat_ids, meta) -> dict:
    del meta
    state = env.state.game_state
    rolls = state.get("dice_rolls") or {}
    remaining = state.get("remaining_dice") or {}
    pools = state.get("team_dice") or {}
    rewards = env.state.rewards or {}
    reason = ""
    for pid in range(env.state.num_players):
        found = env.state.game_info.get(pid, {}).get("reason")
        if found:
            reason = str(found)
            break
    best = max((float(rewards.get(seat, 0)) for seat in seat_ids), default=0.0)
    return {
        "dice": [{"seat": seat, "dice": [int(v) for v in rolls.get(seat, [])],
                  "left": int(remaining.get(seat, 0))} for seat in seat_ids],
        "teams": [{"team": team, "dice": int(pools.get(team, 0))} for team in (0, 1)],
        "winners": [seat for seat in seat_ids if best > 0 and float(rewards.get(seat, 0)) == best],
        "reason": reason or "The last team with dice in its pool wins.",
    }


def scores(env, seat_ids, meta) -> dict[int, float]:
    del meta
    rewards = env.state.rewards or {}
    return {seat: float(rewards.get(seat, 0)) for seat in seat_ids}


def estimate(seats: int, model_seats: int) -> int:
    del seats
    return max(1, model_seats) * TURNS_PER_SEAT


def beat(env) -> str:
    state = env.state.game_state
    return f"round-{int(state.get('round') or 1)}"
