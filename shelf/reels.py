"""Reel machines, described as data, with exact odds and a per-session chance.

Two machines live here:

- ``fruit9`` - the classic nine-window fruit machine: 3 reels x 3 rows, five paylines.
- ``robot3`` - Hermes Olympus: 3 reels x 1 row, one payline, its own Greek faces,
  its own paytable and its own colours. It is a different machine, not a re-skin.

Every machine is mechanical: each reel is a fixed strip of stops, a spin picks one
stop per reel uniformly, and the odds below are computed by walking *every* stop
combination. Nothing is weighted behind the player's back.

**The chance of winning is drawn per session.** Each machine picks a target hit
rate uniformly in [0.50, 0.52] when this module is first imported - that is, when
Hermes starts - and keeps it until Hermes is restarted. The target is reached
honestly: extra blank stops are added to the reels for the session, which is a real
change to the reels, not a hidden veto on a win. The published odds are the session's
own, enumerated exactly, and the paytable is solved each session so the return to
player lands on the machine's target.

**A win is a spin that pays back at least the bet** (owner's ask, 2026-11-11). Every
paytable in ``SPECS`` is built so that a line pays the whole stake or more, which is
what makes that number and the machine's own hit rate the same number: no spin is
called a win for paying five chips on a twenty-five chip bet.

**The return is on target, not above it** (owner's ask, 2026-11-11): the everyday pays
carry as much of the target as they can while the jackpot stays the machine's top
prize, and the jackpot is then solved to add exactly the remainder. The session
reports what it measured, so the person is still told the machine's own number.
"""

from __future__ import annotations

import itertools
import math
import random
import secrets
from functools import lru_cache

# What a spin can cost, in chips: eight steps, 25 chips apart, so the smallest spin is 25.
MIN_BET = 25
BETS = tuple(MIN_BET * level for level in range(1, 9))

CHERRY, LEMON, ORANGE, PLUM, BELL, BAR, SEVEN = "🍒", "🍋", "🍊", "🍇", "🔔", "BAR", "7"
# The second machine's faces are Greek, not workshop props (owner's ask, 2026-11-09: Hermes
# god and Greek references instead of disks and wrenches). A temple, an owl, an amphora, a
# drachma, a trident and Zeus' bolt - the things the myths are made of.
OWL, AMPHORA, DRACHMA, TRIDENT, ZEUS_BOLT = "🦉", "🏺", "🪙", "🔱", "⚡"
# The caduceus is Hermes' own staff, and the owner asked for it as the second prize on the Greek
# machine, above the wing and in place of the temple (2026-11-10: "remove the greek building").
CADUCEUS = "⚕️"
# Plain-string tokens: the desktop draws a picture for each (assets/slots/nous.png, wing.png).
NOUS, WING = "NOUS", "WING"
# A blank is a reel position that shows nothing and pays nothing. Sessions add a few of
# these to dilute the win rate to the drawn target.
BLANK = "▫"

# One NOUS per strip (where the 7 used to be) and one WING per strip (replacing one
# LEMON). Strip lengths stay at 20; the session solver only ever appends blanks.
FRUIT_STRIPS = (
    (CHERRY, WING, ORANGE, BAR, PLUM, LEMON, BELL, ORANGE, LEMON, CHERRY,
     PLUM, ORANGE, LEMON, NOUS, ORANGE, PLUM, LEMON, BELL, ORANGE, PLUM),
    (WING, ORANGE, CHERRY, PLUM, BELL, LEMON, ORANGE, BAR, PLUM, LEMON,
     ORANGE, PLUM, CHERRY, LEMON, BELL, ORANGE, NOUS, PLUM, LEMON, ORANGE),
    (ORANGE, WING, PLUM, BELL, ORANGE, LEMON, PLUM, ORANGE, BAR, LEMON,
     PLUM, ORANGE, LEMON, CHERRY, PLUM, BELL, ORANGE, LEMON, NOUS, PLUM),
)

# One NOUS per strip, one CADUCEUS per strip (where the temple stood) and one WING per strip, on all
# three reels. NOUS is the jackpot on every machine now, not just the classic one (owner's ask,
# 2026-11-10: "make the nous logo the top valued spin on all"). Strip lengths stay at 20.
OLYMPUS_STRIPS = (
    (NOUS, WING, BLANK, AMPHORA, TRIDENT, OWL, DRACHMA, ZEUS_BOLT, OWL, TRIDENT,
     AMPHORA, DRACHMA, OWL, CADUCEUS, ZEUS_BOLT, TRIDENT, OWL, DRACHMA, ZEUS_BOLT, AMPHORA),
    (TRIDENT, AMPHORA, WING, NOUS, DRACHMA, TRIDENT, AMPHORA, OWL, DRACHMA, ZEUS_BOLT,
     CADUCEUS, OWL, TRIDENT, ZEUS_BOLT, DRACHMA, AMPHORA, OWL, ZEUS_BOLT, TRIDENT, DRACHMA),
    (DRACHMA, WING, NOUS, TRIDENT, AMPHORA, OWL, DRACHMA, ZEUS_BOLT, TRIDENT, OWL,
     AMPHORA, DRACHMA, CADUCEUS, ZEUS_BOLT, OWL, TRIDENT, DRACHMA, AMPHORA, OWL, ZEUS_BOLT),
)

SPECS = {
    "fruit9": {
        "id": "fruit9",
        "name": "Classic",
        "rows": 3,
        "lines": (
            ("Middle", (1, 1, 1)),
            ("Top", (0, 0, 0)),
            ("Bottom", (2, 2, 2)),
            ("Down diagonal", (0, 1, 2)),
            ("Up diagonal", (2, 1, 0)),
        ),
        "strips": FRUIT_STRIPS,
        # Pays per line, in line bets, for three of a symbol on a line. NOUS is the
        # jackpot, so its pay below is only the starting guess: the session solver
        # re-solves it each session, exactly as the 7's was before.
        #
        # Every value here is at or above the stake the five lines share, so a spin that
        # pays anything at all pays the bet back (owner's ask, 2026-11-11: about half the
        # spins should give the wager back). The handful of big pays are small next to the
        # frequent ones on purpose: the return should arrive as money the person sees, not
        # as one line that has to land (owner's ask, 2026-11-10).
        "pays": {NOUS: 525, WING: 120, BAR: 90, BELL: 60, CHERRY: 40,
                 PLUM: 26, ORANGE: 18, LEMON: 14},
        # A single leading cherry pays the stake back and two pay a little over it; a leading BAR
        # pays the stake as well. These are the machine's frequent wins, and they are what makes a
        # spin that wins a spin that is not worse off for it (owner's ask, 2026-11-09: "even out the
        # slot machine, I need to not go broke"). The solver pays for them out of the big pays.
        "short": {CHERRY: {1: 5, 2: 8}},
        "lead": {BAR: 5},
        "jackpot": NOUS,
        # 1.10 rather than 1.03: the person should trend up while playing, not bleed between
        # jackpots (owner's ask, 2026-11-09).
        "rtp": 1.10,
        "theme": {"bg": "#2a0f3d", "accent": "#facc15", "edge": "#7c2d12", "blank": "🍉"},
    },
    "robot3": {
        "id": "robot3",
        "name": "Hermes Olympus",
        "rows": 1,
        "lines": (("The line", (0, 0, 0)),),
        "strips": OLYMPUS_STRIPS,
        # The jackpot pay (NOUS) is re-solved every session; the rest are small so the machine can
        # pay often (half its spins win something) and still return 110%. The order is the owner's,
        # 2026-11-10: the Nous stamp first, the caduceus second, the wing third.
        "pays": {NOUS: 600, CADUCEUS: 300, WING: 150, OWL: 30, AMPHORA: 18, DRACHMA: 12,
                 TRIDENT: 8, ZEUS_BOLT: 5},
        # Two caduceus from the left pay, and four of the six faces pay a line bet when they
        # lead. That is what makes a one-line machine win often enough to be worth playing, and
        # since this machine has one line, a leading face pays exactly the stake back.
        "short": {CADUCEUS: {2: 6}},
        "lead": {OWL: 1, AMPHORA: 1, DRACHMA: 1, TRIDENT: 1},
        "jackpot": NOUS,
        "rtp": 1.10,
        "theme": {"bg": "#0b1c2c", "accent": "#38bdf8", "edge": "#0e7490", "blank": "🌿"},
    },
}

# The window a machine's usual session draws its chance from (owner's ask, 2026-11-11: about 51% of
# spins should pay the bet back, so the window is two points wide and centred on 51).
CHANCE_LOW, CHANCE_HIGH = 0.50, 0.52
# One session in fifty, a machine runs a bonus: 60% for that session. It is drawn with the chance
# itself, so it lasts exactly as long as the machine's session does (owner's ask, 2026-11-09).
BONUS_ODDS = 0.02
BONUS_CHANCE = 0.60
# And the other face of the same coin: one session in fifty runs cold, 40%. Same draw, same
# lifetime - a machine that is a bad idea to play this evening is a real thing in a casino
# (owner's ask, 2026-11-09).
COLD_ODDS = 0.02
COLD_CHANCE = 0.40
# A session may add up to this many blanks to each strip to reach its target.
MAX_BLANKS = 14


def _session_seed() -> int:
    """One number per process: a new session every time Hermes starts."""
    return int.from_bytes(secrets.token_bytes(8), "big")


SESSION_SEED = _session_seed()


@lru_cache(maxsize=8)
def target_chance(machine: str) -> float:
    """This session's drawn chance of winning for one machine.

    Drawn once per process from the same seed, so it is stable for the whole session
    and changes only when Hermes is restarted.
    """
    rng = random.Random(f"{SESSION_SEED}:{machine}")
    roll = rng.random()
    if roll < BONUS_ODDS:
        return BONUS_CHANCE
    if roll < BONUS_ODDS + COLD_ODDS:
        return COLD_CHANCE
    return round(rng.uniform(CHANCE_LOW, CHANCE_HIGH), 4)


@lru_cache(maxsize=8)
def is_bonus(machine: str) -> bool:
    """Whether this session is a bonus one for that machine - 60% instead of 50-55%."""
    return target_chance(machine) >= BONUS_CHANCE


@lru_cache(maxsize=8)
def is_cold(machine: str) -> bool:
    """Whether this session runs cold for that machine - 40% instead of 50-55%."""
    return target_chance(machine) <= COLD_CHANCE


@lru_cache(maxsize=8)
def mood(machine: str) -> str:
    """"bonus", "cold" or "usual" - what this session drew for that machine."""
    if is_bonus(machine):
        return "bonus"
    if is_cold(machine):
        return "cold"
    return "usual"


@lru_cache(maxsize=8)
def chance_window(machine: str) -> tuple[float, float]:
    """The window a session's chance may land in: the usual one, the bonus top, the cold floor."""
    if is_bonus(machine):
        return (COLD_CHANCE, BONUS_CHANCE)
    if is_cold(machine):
        return (COLD_CHANCE, CHANCE_HIGH)
    return (CHANCE_LOW, CHANCE_HIGH)


def _blank_counts(blanks) -> tuple:
    """The extra blank stops per reel: one count for all three reels, or one count each.

    ``0`` (or ``None``) means the machine's own strips, which is the session before any dilution.
    Anything else - an int from an older caller, a list read back out of the spin log, a per-reel
    tuple from this tuner - lands on three counts.
    """
    if blanks is None:
        return (0, 0, 0)
    if isinstance(blanks, (list, tuple)):
        counts = tuple(max(0, int(count)) for count in blanks)
        return counts if counts else (0, 0, 0)
    return (max(0, int(blanks)),) * 3


def strips(spec: dict, blanks) -> tuple:
    """The strips for this session: each reel with its own count of extra blank stops."""
    counts = _blank_counts(blanks)
    size = len(spec["strips"])
    if len(counts) != size:
        counts = (counts[0],) * size
    return tuple(tuple(strip) + (BLANK,) * count for strip, count in zip(spec["strips"], counts))


def _window(strip: tuple, stop: int) -> tuple:
    size = len(strip)
    return (strip[(stop - 1) % size], strip[stop], strip[(stop + 1) % size])


def _line_pay(spec: dict, symbols: tuple) -> int:
    first = symbols[0]
    if first == BLANK:
        return 0
    pays = spec["pays"]
    short = spec.get("short") or {}
    if symbols[0] == symbols[1] == symbols[2]:
        return pays.get(first, 0)
    run = 1
    while run < 3 and symbols[run] == first:
        run += 1
    runs = short.get(first) or {}
    if run in runs:
        return runs[run]
    return (spec.get("lead") or {}).get(first, 0)


def result(spec: dict, stops: tuple, stake: int = 1, blanks=0, pays: dict | None = None) -> dict:
    """The win or loss for one set of stops, exactly as the player sees it."""
    table = dict(spec["pays"] if pays is None else pays)
    live = dict(spec, pays=table)
    reels = strips(spec, blanks)
    windows = [_window(strip, stop) for strip, stop in zip(reels, stops)]
    rows = spec["rows"]
    grid = [[windows[reel][row] for reel in range(3)] for row in range(rows)]
    wins = []
    for index, (name, line_rows) in enumerate(spec["lines"]):
        symbols = tuple(grid[row][reel] for reel, row in enumerate(line_rows))
        pay = _line_pay(live, symbols)
        if pay:
            wins.append({"line": index, "name": name, "rows": list(line_rows),
                         "symbol": symbols[0], "pay": pay * int(stake)})
    payout = sum(win["pay"] for win in wins)
    # The session retunes the jackpot pay. Comparing with the starting guess in SPECS
    # dropped the flag whenever that tune came out lower, so three of the symbol paid
    # and the table never called it a jackpot.
    jackpot_pay = int(table.get(spec["jackpot"]) or 0)
    jackpot = any(
        win["symbol"] == spec["jackpot"] and jackpot_pay and win["pay"] >= int(stake) * jackpot_pay
        for win in wins
    )
    return {"stops": list(stops), "grid": grid, "wins": wins, "payout": payout, "jackpot": jackpot}


def measure(spec_id: str, blanks, pays_items: tuple) -> dict:
    """Walk every stop combination once and count what it pays.

    ``blanks`` is the session's dilution: one count for every reel, or one count per reel. It is
    read through :func:`_blank_counts` before the walk is cached, so a caller may hand over an int, a
    tuple or the list a spin log read back - the cache is keyed on the counts, never on the shape.

    ``pays_items`` is a tuple of (symbol, pay) pairs so the result can be cached.
    """
    return _measure_cached(spec_id, _blank_counts(blanks), tuple(pays_items))


@lru_cache(maxsize=512)
def _measure_cached(spec_id: str, blanks: tuple, pays_items: tuple) -> dict:
    spec = SPECS[spec_id]
    pays = dict(pays_items)
    reels = strips(spec, blanks)
    windows = tuple(tuple(_window(strip, stop) for stop in range(len(strip))) for strip in reels)
    lines = spec["lines"]
    hits = 0
    total = 0
    jackpot_hits = 0
    combos = 0
    paid_lines = len(lines)
    # The paytable is read once per walk, not once per combination: the line reader needs the pays,
    # the short runs and the lead pays in one mapping, and copying it 40,000 times was most of the
    # cost of solving a session.
    live = dict(spec, pays=pays)
    # The rows each line reads, taken once: the window a reel shows is the same three rows whatever
    # the stop, so building a grid of the whole window for every combination was work the pay rules
    # never asked for.
    rows_by_line = [rows_of_line for _name, rows_of_line in lines]
    for stops in itertools.product(*(range(len(strip)) for strip in reels)):
        views = [windows[reel][stops[reel]] for reel in range(3)]
        paid = 0
        jack = 0
        for rows_of_line in rows_by_line:
            symbols = (views[0][rows_of_line[0]], views[1][rows_of_line[1]], views[2][rows_of_line[2]])
            pay = _line_pay(live, symbols)
            paid += pay
            # The jackpot is three of its symbol on a line, counted per line and regardless of
            # what it currently pays: the pay solve needs the count while the pay is still zero.
            if symbols[0] == symbols[1] == symbols[2] == spec["jackpot"]:
                jack += 1
        combos += 1
        # A hit is a spin that pays back the whole bet, not one that pays anything at all: with the
        # stake split over the machine's lines, that is `paid_lines` line bets (owner's ask,
        # 2026-11-11). Every paytable in SPECS is built so no line pays less than that, which is why
        # this and "pays anything" are the same count on both machines.
        if paid >= paid_lines:
            hits += 1
        total += paid
        jackpot_hits += jack
    return {
        "combos": combos,
        "lines": len(lines),
        "hits": hits,
        "hit": hits / combos,
        "total": total,
        # Chips paid per chip staked: the machine's return, on this session's strips and paytable.
        "rtp": total / (combos * len(lines)),
        "jackpot_hits": jackpot_hits,
    }


def smallest_pay(spec: dict, pays: dict | None = None) -> int:
    """The smallest pay in a session's table, in line bets, ignoring the blank stop.

    The number the machine's promise rests on: a line pays at least this, so a spin that wins at
    all pays at least this many line bets back. The tests hold every machine to it.
    """
    table = dict(spec["pays"] if pays is None else pays)
    values = [value for value in table.values() if value]
    for runs in (spec.get("short") or {}).values():
        values.extend(pay for pay in runs.values() if pay)
    values.extend(pay for pay in (spec.get("lead") or {}).values() if pay)
    return min(values) if values else 0


# How far the jackpot has to stand above the best everyday pay to still be the machine's top prize
# (owner's rule, 2026-11-09: the NOUS logo pays the most on every machine). The jackpot is solved
# against this, so being the top prize and hitting the machine's return are the same solve.
MARGIN = 1.25
# The multiple of the machine's own table the everyday pays play at. Found per session; these are
# only the rails the search may not run past.
SCALE_MIN, SCALE_MAX = 0.10, 8.0


def _scaled(spec: dict, scale: float) -> dict:
    """The machine's everyday pays at one multiple of its own table.

    One factor for the whole table, so the order the owner asked for cannot change from session to
    session. The jackpot is carried through untouched here: the caller zeroes or solves it.
    """
    return {symbol: (value if symbol == spec["jackpot"] else max(1, int(round(value * scale))))
            for symbol, value in spec["pays"].items()}


def _everyday(spec_id: str, blanks: tuple, spec: dict, scale: float) -> dict:
    """The everyday pays at one multiple with the jackpot zeroed, and the best pay among them."""
    pays = _scaled(spec, scale)
    pays[spec["jackpot"]] = 0
    best = max(value for symbol, value in _scaled(spec, scale).items() if symbol != spec["jackpot"])
    return measure(spec_id, blanks, tuple(pays.items())), best


def _solved_pays(spec_id: str, blanks: tuple, spec: dict) -> dict:
    """The session's paytable: the everyday pays at one multiple, and the jackpot on top of them.

    The multiple is the largest one whose solved jackpot still stands MARGIN above the best everyday
    pay - so the everyday pays carry as much of the machine's return as they can while the jackpot
    stays its top prize - and the jackpot is then solved to add exactly the rest. That is the owner's
    ask of 2026-11-11 (the return is on target, not above it) worked out in the way that keeps the
    money where the person can see it (owner's ask, 2026-11-10): an ordinary session, one that never
    hits the jackpot, still ends up ahead.

    Returns the pays and what the solve measured: the everyday return alone, the smallest and
    largest pay, and whether the jackpot had to be lifted instead of solved.
    """
    jackpot = spec["jackpot"]
    zeroed = tuple({symbol: 0 for symbol in spec["pays"]}.items())
    fixed = measure(spec_id, blanks, zeroed)
    hits = fixed["jackpot_hits"]
    want = spec["rtp"] * fixed["combos"] * fixed["lines"]

    def clears(scale: float) -> bool:
        """Would the jackpot solved at this multiple still stand above the best everyday pay?"""
        if not hits:
            return False
        found, best = _everyday(spec_id, blanks, spec, scale)
        return (want - found["total"]) >= MARGIN * best * hits

    # The crossover, estimated in one step of arithmetic: the everyday pays grow with the multiple
    # and the jackpot the remainder leaves shrinks, so the multiple where the two meet is a division.
    one, best_one = _everyday(spec_id, blanks, spec, 1.0)
    everyday_total = max(0, one["total"] - fixed["total"])
    estimate = SCALE_MIN
    if everyday_total and hits:
        estimate = (want - fixed["total"]) / (everyday_total + MARGIN * best_one * hits)
    estimate = max(SCALE_MIN, min(SCALE_MAX, estimate))
    # The estimate is a rate, and the pays are whole chips, which rounds the crossover into a step
    # function: it is settled by bisection in a bracket around it - not across the whole rail, which
    # was ten measures of walking every stop combination again for nothing.
    low, high = max(SCALE_MIN, estimate * 0.75), min(SCALE_MAX, estimate * 1.35)
    if clears(low):
        if clears(high):
            scale = high
        else:
            for _ in range(7):
                mid = (low + high) / 2
                if clears(mid):
                    low = mid
                else:
                    high = mid
            scale = low
    else:
        # Even the low end of the bracket spends too much on the everyday money, so the crossover is
        # below it: fall back to the whole rail rather than run off the end of the bracket.
        low, high = SCALE_MIN, max(SCALE_MIN, estimate * 0.75)
        if clears(low):
            for _ in range(7):
                mid = (low + high) / 2
                if clears(mid):
                    low = mid
                else:
                    high = mid
            scale = low
        else:
            scale = SCALE_MIN
    everyday, best = _everyday(spec_id, blanks, spec, scale)
    remaining = want - everyday["total"]
    # Rounded UP - and the remainder is rounded up BEFORE it is divided: truncating it first left a
    # session one chip short of its own promise (measured 2026-11-11: a usual fruit9 session paid
    # 1.09998 where the machine says 1.10, which is exactly one chip on 53,240 line bets). One chip
    # over is what a whole-chip jackpot costs, and it is a hundredth of a percent on the return.
    jackpot_pay = max(1, -(-math.ceil(remaining) // int(hits))) if hits else 1
    if jackpot_pay <= best:
        # The everyday money has outgrown the jackpot (a session whose small pays already return
        # everything). Then the jackpot is lifted back to the top prize and the return is reported
        # as measured - a generous session, never a mean one (owner's ask, 2026-11-09).
        jackpot_pay = max(1, int(round(best * MARGIN)))
    pays = _scaled(spec, scale)
    pays[jackpot] = jackpot_pay
    return {
        "pays": pays,
        "scale": scale,
        "jackpot_pay": jackpot_pay,
        "everyday_rtp": everyday["rtp"],
        "floor_pay": smallest_pay(spec, pays),
        "top_pay": best,
        "jackpot_is_top": bool(jackpot_pay > best),
    }


def _dilutions(spec_id: str, target: float, pays_items: tuple) -> tuple:
    """The blank stops each reel carries this session, and the measurement they land on.

    The coarse ladder is one count for all three reels - the machine the person knows, and the
    ladder the bonus and cold sessions are reached with. One blank on every reel moves the hit rate
    about three points, which is wider than the two-point window a usual session promises, so the
    ladder is then refined by one blank on ONE reel: a third of a step, which is the resolution that
    window needs. The session plays the counts whose hit lands inside its own window, nearest the
    drawn chance; only when nothing lands inside it does the nearest count of any rung play.
    """
    coarse = []
    for blanks in range(MAX_BLANKS + 1):
        found = measure(spec_id, blanks, pays_items)
        coarse.append(((blanks,) * 3, found))
        if found["hit"] <= target:
            break
    # The centre of the refinement: the coarse rung nearest the drawn chance.
    centre = min(coarse, key=lambda item: (abs(item[1]["hit"] - target), item[0][0]))
    fine = []
    for reel in range(3):
        for delta in (-1, 1):
            counts = list(centre[0])
            counts[reel] = max(0, min(MAX_BLANKS, counts[reel] + delta))
            counts = tuple(counts)
            if counts == centre[0]:
                continue
            fine.append((counts, measure(spec_id, counts, pays_items)))
    # Coarse first on a tie, so a session that already landed on its target plays exactly what it
    # played before this refinement existed.
    pool = [(counts, found, 0) for counts, found in coarse] + [(counts, found, 1) for counts, found in fine]
    low, high = chance_window(spec_id)
    inside = [item for item in pool if low <= item[1]["hit"] <= high]
    counts, found, _ = min(inside or pool, key=lambda item: (abs(item[1]["hit"] - target), item[2]))
    return counts, found


@lru_cache(maxsize=32)
def variant(spec_id: str) -> dict:
    """The session's strips and paytable.

    The dilution that lands the hit rate on the drawn chance (inside the session's own window), then
    the paytable that puts the return on the machine's target with the jackpot as its top prize.
    Both are re-solved per session and both are published as measured, so the numbers a player is
    owed are this session's own.
    """
    spec = SPECS[spec_id]
    target = target_chance(spec_id)
    blanks, _ladder = _dilutions(spec_id, target, tuple(spec["pays"].items()))
    solve = _solved_pays(spec_id, blanks, spec)
    pays = solve["pays"]
    tuned = measure(spec_id, blanks, tuple(pays.items()))
    return {
        "machine": spec_id,
        # A list of three counts - one per reel - because this value is recorded in the spin log and
        # read back as JSON: a tuple and a list of the same counts compared unequal was a test that
        # failed on a session that had paid correctly (found 2026-11-11).
        "blanks": list(blanks),
        "pays": pays,
        "hit": round(tuned["hit"], 4),
        "return": round(tuned["rtp"], 4),
        "target": target,
        "jackpot_pay": solve["jackpot_pay"],
        "combos": tuned["combos"],
        "lines": tuned["lines"],
        # What the session's promise rests on, published so a test - or a person reading the spin
        # log - can check it instead of trusting it: the smallest pay in the table (in line bets,
        # and it must be at least the number of lines), the everyday pays' own return, and whether
        # the jackpot came out on top.
        "floor_pay": solve["floor_pay"],
        "everyday_rtp": round(solve["everyday_rtp"], 4),
        "top_pay": solve["top_pay"],
        "jackpot_is_top": solve["jackpot_is_top"],
        "scale": round(solve["scale"], 4),
    }


def spin(spec_id: str, stake: int = 1, rng=None) -> dict:
    """One spin on the session's strips, paying the session's paytable."""
    spec = SPECS[spec_id]
    found = variant(spec_id)
    reels = strips(spec, found["blanks"])
    pick = rng.randrange if rng is not None else secrets.randbelow
    stops = tuple(pick(len(strip)) for strip in reels)
    out = result(spec, stops, stake, found["blanks"], found["pays"])
    # The session this spin actually used. Without it, a log has to guess, and a guess at the
    # paytable turns a correct payout into a reported mismatch (found 2026-11-10: 184 of 592
    # spins "disagreed" only because the log had drawn a second variant of its own).
    out["session"] = {"hit": found["hit"], "return": found["return"],
                      "blanks": found["blanks"], "pays": found["pays"]}
    return out


def paytable(spec_id: str, stake: int = 1) -> list[dict]:
    """The pays, quoted at this stake, on the session's paytable."""
    spec = SPECS[spec_id]
    pays = variant(spec_id)["pays"]
    rows = [{"symbol": f"{symbol} {symbol} {symbol}", "payout": value * int(stake)}
            for symbol, value in sorted(pays.items(), key=lambda item: -item[1])]
    for symbol, runs in (spec.get("short") or {}).items():
        for run, pay in sorted(runs.items(), reverse=True):
            shown = " ".join([symbol] * run + ["–"] * (3 - run))
            rows.append({"symbol": shown, "payout": pay * int(stake)})
    for symbol, pay in (spec.get("lead") or {}).items():
        rows.append({"symbol": f"{symbol} – –", "payout": pay * int(stake)})
    # The blank stop: a real reel stop that wins nothing, shown as the machine's own face.
    face = (spec.get("theme") or {}).get("blank") or BLANK
    rows.append({"symbol": f"{face} – –", "payout": 0})
    return rows


def jackpot_chips(spec_id: str, stake: int = 1) -> int:
    return variant(spec_id)["jackpot_pay"] * int(stake)
