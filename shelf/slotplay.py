"""One slot spin against the wallet: the Slots table, auto-spin and the overlay all spin here.

Every machine costs the bet the player picked, split over the machine's paylines. Two machines:

- fruit9: Classic, the nine-window fruit machine, 3 reels x 3 rows, five paylines.
- robot3: Hermes Olympus, one row of three reels, one payline, its own Greek faces and theme.

Each machine draws its chance of winning once per session (50-55%) and keeps it until Hermes
restarts; the odds published here are the session's own, enumerated exactly.
"""

from __future__ import annotations

import importlib.util
import sys
import time
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent


def _load(name: str, path: Path):
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


reels = _load("hermes_gameshelf_reels", _ROOT / "shelf" / "reels.py")
autobet = _load("hermes_gameshelf_autobet", _ROOT / "shelf" / "autobet.py")
spinlog = _load("hermes_gameshelf_spinlog", _ROOT / "shelf" / "spinlog.py")

# Chips only: a spin costs the bet the player picked, and the bet is split over the machine's lines.
MIN_BET = reels.MIN_BET
BETS = reels.BETS
DEFAULT_MACHINE = "fruit9"

BLURBS = {
    "fruit9": "Nine windows, five paylines. Cherries pay from the left; three NOUS stamps on a line is the jackpot.",
    "robot3": "One line, three reels of Greek faces. The Nous stamp is the jackpot, the caduceus pays next, and two caduceus from the left still pay.",
}


def _machines() -> dict:
    """The machines as the desktop sees them, on this session's strips and jackpot."""
    found = {}
    for spec_id, spec in reels.SPECS.items():
        session = reels.variant(spec_id)
        theme = dict(spec.get("theme") or {})
        found[spec_id] = {
            "id": spec_id,
            "title": spec["name"],
            "rows": spec["rows"],
            "reels": 3,
            "blurb": BLURBS.get(spec_id, ""),
            "strips": [list(strip) for strip in reels.strips(spec, session["blanks"])],
            "lines": [{"name": name, "rows": list(rows)} for name, rows in spec["lines"]],
            "jackpot": int(session["jackpot_pay"]),
            # The jackpot's own symbol, so the machine can mark the jackpot row on its pay table
            # without guessing it from the payout (owner's ask, 2026-11-11: what it pays, from the
            # live table). NOUS on both machines.
            "jackpot_symbol": spec["jackpot"],
            "theme": theme,
            # The blank stop, drawn as its machine's face so an empty reel looks meant.
            "blank": reels.BLANK,
            "blank_face": theme["blank"],
            "session": {
                "win_chance": session["hit"],
                "return": session["return"],
                "target": session["target"],
                # "bonus", "cold" or "usual": what this session drew for this machine, so the picker
                # can say why one machine is worth playing tonight and another is not.
                "mood": reels.mood(spec_id),
                "range": list(reels.chance_window(spec_id)),
            },
        }
    return found


# Built once: the session's strips and jackpot do not change until Hermes restarts.
MACHINES = _machines()


def machine_list() -> list[dict]:
    return [dict(info) for info in MACHINES.values()]


def rtp(machine: str) -> float:
    """Exact return to player this session (paid chips per chip staked)."""
    if machine not in reels.SPECS:
        return 0.0
    return round(reels.variant(machine)["return"], 4)


def win_chance(machine: str) -> float:
    """How often a spin wins anything at all, this session."""
    if machine not in reels.SPECS:
        return 0.0
    return round(reels.variant(machine)["hit"], 4)


def paytable(machine: str = DEFAULT_MACHINE, stake: int = MIN_BET) -> list[dict]:
    """What each line pays, in chips, at the given stake per line."""
    if machine not in reels.SPECS:
        machine = DEFAULT_MACHINE
    return reels.paytable(machine, stake)


def odds(machine: str = DEFAULT_MACHINE, wallet_path=None) -> dict:
    """The numbers a player is owed, plus what the machine drew for this session."""
    if machine not in reels.SPECS:
        machine = DEFAULT_MACHINE
    found = reels.variant(machine)
    return {
        "win_chance": round(found["hit"], 4),
        "return": round(found["return"], 4),
        "target": found["target"],
        # The window this session actually promises: a bonus session runs to 60%, a cold one
        # down to 40%. Quoting the usual 50-55 next to a 0.60 would be a promise contradicted by
        # the number beside it (found 2026-11-10: odds().range ignored the draw).
        "range": list(reels.chance_window(machine)),
        "draws_when": "when Hermes restarts",
        # What the log shows, when there is enough of it to mean anything. The UI says "promised"
        # beside "measured" rather than quoting the promise as if it were a result.
        "measured": spinlog.summary(wallet_path, machine) if wallet_path else None,
    }


def jackpot(machine: str = DEFAULT_MACHINE) -> int:
    if machine not in reels.SPECS:
        machine = DEFAULT_MACHINE
    return int(reels.variant(machine)["jackpot_pay"])


def _outcome(machine: str, per_line: int) -> dict:
    drawn = reels.spin(machine, per_line)
    return {
        "grid": drawn["grid"],
        # The middle row is the classic single line, for anything that shows one row.
        "reels": list(drawn["grid"][len(drawn["grid"]) // 2]),
        "stops": drawn["stops"],
        "wins": drawn["wins"],
        "payout": drawn["payout"],
        "jackpot": drawn["jackpot"],
        "session": drawn.get("session"),
    }


def bet_lines(machine: str) -> int:
    """How many paylines a machine has: the bet is split across them."""
    if machine not in reels.SPECS:
        machine = DEFAULT_MACHINE
    return len(reels.SPECS[machine]["lines"])


def spin(wallet, *, bet: int | None = None, auto: bool = False, machine: str | None = None) -> dict | None:
    """Spend the bet in chips, spin, pay. None when the wallet cannot cover the bet."""
    held = wallet.read()
    chosen = machine or held.get("machine") or DEFAULT_MACHINE
    if chosen not in reels.SPECS:
        chosen = DEFAULT_MACHINE
    stake = int(bet if bet is not None else (held.get("bet") or MIN_BET))
    stake = max(MIN_BET, min(stake, max(BETS)))
    lines = bet_lines(chosen)
    per_line = max(1, stake // lines)
    if not wallet.debit(stake):
        # Nothing is dealt silently any more: an empty wallet is the moment the comeback arcade
        # belongs to, and a hidden refill would rob the person of the game they were promised
        # (owner's ask, 2026-11-09: "make my chips run out so I can test the come back arcade").
        # The slot and blackjack tables still have their own top-up move; the overlay's answer is
        # the tray tap on the machine.
        return None
    row = dict(_outcome(chosen, per_line), machine=chosen, paid_with="chip", bet=stake,
               auto=bool(auto), at=time.time())
    held = wallet.record_spin(row)
    # One line per spin, beside the wallet, so a claim about payouts or odds can be checked instead of
    # argued about. Best-effort: it never raises and never touches a balance.
    spinlog.record(wallet.path, row, row.get("session"))
    return dict(row, chips=held["chips"])


def autospin(wallet, kind: str = "turn", tokens: int = 0) -> dict | None:
    """The automatic spin: only with auto-play on, only while the machine is on screen, and only
    with chips in the wallet. Nothing is banked, so nothing spins behind a closed machine.

    The bet sizes itself when auto-bet is on (the default): a frequent, cheap hook pays the
    smallest bet, a real inference reply pays more the more tokens it cost, never above the cap
    the person set. With auto-bet off it is the bet on the table, exactly as before.
    """
    held = wallet.read()
    if not held.get("autoplay") or not held.get("visible"):
        return None
    stake = int(held.get("bet") or MIN_BET)
    if held.get("autobet", True):
        stake = autobet.stake_for(kind, tokens, MIN_BET, held.get("autobet_max") or autobet.DEFAULT_CAP)
    if int(held.get("chips") or 0) < stake:
        # A bet the wallet cannot cover falls back to the smallest bet rather than skipping the spin,
        # and below even that the spin simply does not happen - the machine shows the comeback tray
        # instead of a dead table with nothing to click.
        stake = MIN_BET
    return spin(wallet, bet=stake, auto=True)
