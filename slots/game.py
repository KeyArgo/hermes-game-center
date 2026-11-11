"""Slots: the slot machines (Classic and Hermes Olympus). Every spin costs the bet in chips; wins pay chips."""

from __future__ import annotations

import importlib.util
import sys
import uuid
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
# Load this plugin's own kit.py under a name no other plugin can claim. A plain
# `import kit` would hand us another plugin's module when both ship a kit.py.
_KIT_NAME = "hermes_gameshelf_kit"
if _KIT_NAME not in sys.modules:
    _kit_spec = importlib.util.spec_from_file_location(_KIT_NAME, _ROOT / "kit.py")
    _kit_module = importlib.util.module_from_spec(_kit_spec)
    sys.modules[_KIT_NAME] = _kit_module
    _kit_spec.loader.exec_module(_kit_module)
kit = sys.modules[_KIT_NAME]

_FRESH_NAME = "hermes_gameshelf_fresh"
if _FRESH_NAME not in sys.modules:
    _fresh_spec = importlib.util.spec_from_file_location(_FRESH_NAME, _ROOT / "shelf" / "fresh.py")
    _fresh_module = importlib.util.module_from_spec(_fresh_spec)
    sys.modules[_FRESH_NAME] = _fresh_module
    _fresh_spec.loader.exec_module(_fresh_module)
# Shared helpers reload when their file changes, so an update never mixes old and new code.
load_fresh = sys.modules[_FRESH_NAME].load_fresh
wallet_module = load_fresh("hermes_gameshelf_wallet", _ROOT / "shelf" / "wallet.py")
slotplay = load_fresh("hermes_gameshelf_slotplay", _ROOT / "shelf" / "slotplay.py")

ID = "slots"
TITLE = "Slots"
MARKS = ("P", "H")
SIDE_WORDS = {"white": "You", "black": "House"}
EXAMPLE = "move spin"
MAX_PLIES = 100000
# A session game: spins settle and the machine stays open, so the Play contract counts spins
# rather than a winner.
SESSION = True
HELP = [
    "Press Spin. Every machine plays fixed reel strips at published, exact odds.",
    "Tick Auto-spin and every message you send spins once, paid from your chips.",
    f"Pick a bet from {slotplay.MIN_BET} chips up, then spin. Every spin costs the bet, paid from the same wallet Blackjack bets from.",
    "Pick a machine above the reels: Classic (nine windows, five lines) or Hermes Olympus (one line).",
]
BETS = slotplay.BETS
MIN_BET = slotplay.MIN_BET

# The one wallet this table plays with; use_wallet points it at a file.
_wallet = wallet_module.Wallet(_ROOT / "wallet.json")


def create(root: Path, settings: dict | None = None):
    settings = settings or {}
    root = Path(root)
    # A cabinet plays with one wallet. Locally that is the profile's shared chips file.
    # Online, the server passes its own wallet so one room's chips never reach another's.
    use_wallet(Path(settings.get("wallet") or (root.parent / "wallet.json")))
    table = kit.Table(root, kit.rules(globals()))
    # The cabinet is live the moment it is placed: it waits on no deal and no first
    # bet, and a table that reads as "idle" looks never started to a playthrough.
    if kit.load(root) is None:
        kit.write(root, {
            "schema_version": 2, "table_id": uuid.uuid4().hex, "owner_id": "",
            "score": {"white": 0, "black": 0, "draws": 0}, "moves": [],
            "rematch": {"requested_by": []}, "draw_offer": "", "game": ID,
            "turn": "white", "white": "human", "black": "human",
            "status": "active", "winner": "", "plies": 0, "last": "", "result_detail": "",
            **fresh(),
        })
    return table


def use_wallet(path: Path) -> None:
    """Point the rules' wallet at ``path``; every later spin reads and writes there."""
    global _wallet
    _wallet = wallet_module.Wallet(Path(path))


def fresh() -> dict:
    # A fresh table is playable right away: the spin costs the wallet's bet, so no
    # bet move is needed first. A table read as "idle" looks never started to the
    # person playthrough, so a fresh table reports active play. ``phase`` stays for
    # old saved states; nothing gates on it any more.
    return {"reels": ["", "", ""], "grid": [], "wins": [], "machine": "", "last_win": 0,
            "history": [], "note": "", "bet": 0, "phase": "bet", "status": "active"}


def _stake(state: dict) -> int:
    """What a spin costs here: the table's own bet, else the wallet's, else the minimum."""
    held = _wallet.read()
    return int(state.get("bet") or held.get("bet") or MIN_BET)


def parse(words: list[str]) -> str | None:
    if len(words) != 1:
        return None
    token = words[0].lower()
    if token == "spin":
        return "spin"
    if token.startswith("bet") and token[3:].isdigit() and int(token[3:]) in BETS:
        return token
    return None


def legal(state: dict) -> list[str]:
    # The bet lives in the wallet, so the spin is legal on a fresh table too: the
    # stake is the table's own bet or the wallet's. Chips are the only currency.
    held = _wallet.read()
    stake = int(state.get("bet") or held.get("bet") or MIN_BET)
    bets = [f"bet{amount}" for amount in BETS if amount <= int(held["chips"])]
    if int(held["chips"]) >= stake:
        return ["spin"] + bets
    if bets:
        return bets
    # Busted: the arcade hands over a fresh stack instead of leaving a dead table.
    return ["topup"]


def refusal(state: dict, move) -> str:
    """A short, true reason the move was refused."""
    held = _wallet.read()
    if move == "spin":
        stake = int(state.get("bet") or held.get("bet") or MIN_BET)
        if int(held["chips"]) < stake:
            return f"Not enough chips for a {stake} bet."
        return "That move isn't allowed."
    stake = int(state.get("bet") or held.get("bet") or MIN_BET)
    if int(held["chips"]) < stake:
        return f"Not enough chips to spin at {stake}. Pick a smaller bet."
    return "Pick a bet from the ladder, then spin."


def show(move: str) -> str:
    return str(move)


def play(state: dict, move: str) -> str:
    if move == "spin":
        state["spins"] = int(state.get("spins") or 0) + 1
    if move == "topup":
        given = _wallet.topup(MIN_BET)
        state["note"] = (
            f"Out of chips. A fresh {given:,} to play with." if given
            else "You still have chips to bet."
        )
        return state["note"]
    if move.startswith("bet") and move[3:].isdigit():
        amount = int(move[3:])
        if amount not in BETS:
            state["note"] = f"The bet goes up in steps of {MIN_BET} chips."
            return state["note"]
        # The bet lives in the wallet (auto-spin and the overlay play it too), and the
        # table remembers it as its own stake.
        state["bet"] = amount
        _wallet.set_bet(amount)
        state["phase"] = "spin"
        state["note"] = f"Bet {amount} chips. Spin when you are ready."
        return state["note"]
    if move != "spin":
        return "The only move is a bet or spin."
    if state.get("turn") == "black":
        # An AI seated as the House only hands the machine back: it never spends your chips.
        state["turn"] = "white"
        state["note"] = "The house hands the machine back to you."
        return state["note"]
    # The same spin as auto-play and the chat overlay: the bet is spent in chips, every time,
    # and the wallet's bet is the stake when this table has not picked one of its own.
    stake = _stake(state)
    row = slotplay.spin(_wallet, bet=stake)
    if row is None:
        state["note"] = f"Not enough chips for a {stake} bet."
        return state["note"]
    state["phase"] = "bet"
    state["reels"] = list(row["reels"])
    state["grid"] = [list(line) for line in row["grid"]]
    state["wins"] = list(row["wins"])
    state["machine"] = row["machine"]
    state["last_win"] = row["payout"]
    # Which spin this table has already shown, so a spin made elsewhere is adopted once.
    state["seen_at"] = float(row.get("at") or 0)
    state["history"].insert(0, {"reels": row["reels"], "payout": row["payout"], "paid_with": row["paid_with"]})
    del state["history"][10:]
    if row["jackpot"]:
        note = f"JACKPOT! {row['payout']:,} chips."
    elif row["payout"]:
        note = f"You win {row['payout']:,} chips."
    else:
        note = "No match. Spin again."
    state["note"] = note
    # The turn stays with you and the table never ends on its own. Only an AI seated as the
    # House gets a turn after each spin, so the kit's agent seat has something to answer.
    if kit.seat_kind(str(state.get("black") or "")) in kit.AI_KINDS:
        state["turn"] = "black"
    return note


def bot(state: dict) -> str:
    """The house spins when it can pay; otherwise it takes the smallest legal stake."""
    offered = legal(state)
    if "spin" in offered:
        return "spin"
    bets = [move for move in offered if str(move).startswith("bet")]
    return bets[0] if bets else (offered[0] if offered else "spin")


def draw(state: dict) -> list[str]:
    reels = state["reels"]
    lines = [f"Reels: {reels[0]} {reels[1]} {reels[2]}" if all(reels) else "Reels: - - -"]
    if state["last_win"]:
        lines.append(f"Last win: {state['last_win']} chips")
    wallet = _wallet.read()
    stake = int(state.get("bet") or wallet.get("bet") or MIN_BET)
    lines.append(f"Chips {wallet['chips']}  Bet {stake}")
    return lines


def picture(state: dict, player=None) -> dict:
    wallet = _wallet.read()
    history = [dict(entry) for entry in state["history"]]
    machine = wallet.get("machine") or slotplay.DEFAULT_MACHINE
    if machine not in slotplay.MACHINES:
        machine = slotplay.DEFAULT_MACHINE
    # One machine, two views: the sidebar overlay and auto-spin write their spin to the
    # wallet's feed, so this table shows the newest spin from anywhere rather than only
    # the spins it made itself. A switched machine still starts blank.
    feed = [row for row in wallet.get("feed") or [] if isinstance(row, dict)]
    newest = feed[0] if feed else None
    adopt = newest if newest and float(newest.get("at") or 0) > float(state.get("seen_at") or 0) else None
    shown = adopt or state
    # A machine switch still starts blank, but a spin made elsewhere counts as this table's own.
    same = shown.get("machine") == machine
    payout = int(shown.get("payout") or 0) if adopt else state["last_win"]
    note = state["note"]
    if adopt:
        note = (f"JACKPOT! {payout:,} chips." if shown.get("jackpot")
                else f"You win {payout:,} chips." if payout else "No match. Spin again.")
    return {
        "view": "slots",
        "machine": machine,
        # Every machine the shelf has, Classic and Hermes Olympus alike: this table is
        # where every slot machine lives, not one cabinet of its own.
        "machines": slotplay.machine_list(),
        "grid": [list(line) for line in (shown.get("grid") or [])] if same else [],
        "wins": list(shown.get("wins") or []) if same else [],
        "bets": list(BETS),
        "bet": int(state.get("bet") or wallet.get("bet") or MIN_BET),
        "reels": list(shown.get("reels") or state["reels"]),
        "chips": wallet["chips"],
        "last_win": payout,
        # Quoted at the stake this bet puts on each line.
        "paytable": slotplay.paytable(machine, max(1, int(state.get("bet") or MIN_BET) // max(1, len(slotplay.MACHINES[machine]["lines"])))),
        "odds": slotplay.odds(machine),
        "theme": dict(slotplay.MACHINES[machine].get("theme") or {}),
        "legal": legal(state),
        "history": history,
        "note": note,
        "spins": wallet["spins"],
        "biggest": wallet["biggest"],
        "autoplay": wallet["autoplay"],
        # Spins from anywhere (auto-play, the chat overlay, this table), newest first.
        "feed": wallet["feed"][:10],
        "status": "active",
    }


def explain(move: str, state: dict) -> str:
    # Only ever asked about legal moves (legal() above is the gate), and every one of
    # them is playable from a fresh table: the wallet already carries a bet.
    if move != "spin":
        return "Pick what a spin is worth first."
    return f"Spin: costs {_stake(state)} chips, paid from your wallet."
