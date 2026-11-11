"""Blackjack against the house dealer, with chips from the Jackpot wallet."""

from __future__ import annotations

import importlib.util
import random
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
wallet = load_fresh("hermes_gameshelf_wallet", _ROOT / "shelf" / "wallet.py")

ID = "blackjack"
TITLE = "Blackjack"
MARKS = ("P", "D")
SIDE_WORDS = {"white": "You", "black": "Dealer"}
EXAMPLE = "move bet10"
# A session game, not a board: one ply is a bet or a card, so a hand is two or three
# plies. The generic move cap counts plies, and at 20 it declared the whole table a
# draw after five hands, which took the bet chips away mid-session. Slots sets the
# same high ceiling for the same reason.
MAX_PLIES = 100000
# A session game: hands settle, the table stays open, so the Play contract checks hands settled
# rather than a final winner.
SESSION = True
HELP = [
    "Bet chips from the Jackpot wallet, then hit or stand against the dealer.",
    "Blackjack pays 3:2. A win pays even money. A push returns your bet.",
    "Double doubles your bet for one more card. The dealer stands on all 17s.",
]

_BETS = (10, 25, 50, 100, 500, 1000)
_RANKS = ("A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K")
_SUITS = ("S", "H", "D", "C")

_WALLET = None


def use_wallet(path) -> None:
    global _WALLET
    _WALLET = wallet.Wallet(Path(path))


def _wallet() -> "wallet.Wallet":
    global _WALLET
    if _WALLET is None:
        _WALLET = wallet.Wallet(Path("wallet.json"))
    return _WALLET


def create(root: Path, settings: dict | None = None):
    settings = settings or {}
    root = Path(root)
    # A table plays with one wallet. Locally that is the profile's shared chips file.
    # Online, the server passes its own wallet so one room's chips never reach another's.
    use_wallet(Path(settings.get("wallet") or (root.parent / "wallet.json")))
    table = kit.Table(root, kit.rules(globals()))
    # The table is live the moment it is placed: it waits on no "new" and no first
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


def fresh() -> dict:
    held = _wallet().read()
    if held["chips"] <= 0:
        _wallet().refill()
    return {
        "shoe": uuid.uuid4().hex,
        "phase": "bet",
        "hand": [],
        "dealer": [],
        "deck": [],
        "bet": 0,
        "outcome": "",
        "note": "",
    }


def parse(words: list[str]) -> str | None:
    if not words:
        return None
    if len(words) == 1:
        word = words[0].lower()
        if word in {"hit", "stand", "double", "topup"}:
            return word
        if word.startswith("bet") and word[3:].isdigit() and int(word[3:]) in _BETS:
            return word
        return None
    if len(words) == 2 and words[0].lower() == "bet" and words[1].isdigit():
        amount = int(words[1])
        if amount in _BETS:
            return f"bet{amount}"
    return None


def show(move) -> str:
    return str(move)


def _card_value(card: str) -> int:
    rank = card[:-1]
    if rank == "A":
        return 11
    if rank in {"10", "J", "Q", "K"}:
        return 10
    return int(rank)


def _hand_value(hand: list[str]) -> int:
    total = 0
    aces = 0
    for card in hand:
        if card[:-1] == "A":
            aces += 1
            total += 11
        else:
            total += _card_value(card)
    while total > 21 and aces > 0:
        total -= 10
        aces -= 1
    return total


def _is_blackjack(hand: list[str]) -> bool:
    return len(hand) == 2 and _hand_value(hand) == 21


def _new_deck(seed: str = "") -> list[str]:
    """A shuffled 52-card shoe, reproducible from the table's own shoe seed.

    A SystemRandom shoe looked fine at the table but made the game unprovable: replaying
    the recorded moves re-dealt different cards, so the same log could not produce the same
    result. The seed lives in the state, so a replay follows the same shoe.
    """
    deck = [f"{rank}{suit}" for suit in _SUITS for rank in _RANKS]
    random.Random(f"shoe:{seed}").shuffle(deck)
    return deck


def _draw(state: dict) -> str:
    if not state["deck"]:
        state["deck"] = _new_deck(f"{state.get('shoe') or ''}:{int(state.get('hands') or 0)}")
    return state["deck"].pop()


def _deal(state: dict) -> None:
    if not state["deck"]:
        state["deck"] = _new_deck(f"{state.get('shoe') or ''}:{int(state.get('hands') or 0)}")
    state["hand"].append(_draw(state))
    state["dealer"].append(_draw(state))
    state["hand"].append(_draw(state))
    state["dealer"].append(_draw(state))


def _blackjack_win(stake: int) -> int:
    """3:2 on the stake, rounded up. Integer chips cannot pay a half, and bets that are not
    a multiple of 20 (25 is the slot minimum) would otherwise come up half a chip short."""
    return stake + (stake * 3 + 1) // 2


def _settle(state: dict, outcome: str, winner: str) -> str:
    # The table stays open: a finished hand goes straight back to betting, with the hand
    # left face up so the result can be read, until the person leaves the table.
    del winner
    stake = int(state.get("bet") or 0)
    paid = {"blackjack": _blackjack_win(stake), "win": 2 * stake, "push": stake}.get(outcome, 0)
    state["phase"] = "bet"
    state["outcome"] = outcome
    state["won"] = paid - stake
    state["hands"] = int(state.get("hands") or 0) + 1
    # A doubled hand put the doubled stake on the felt only for that hand; the next bet
    # starts from what the person chose, not from the double.
    base = state.pop("base_bet", None)
    if base:
        state["bet"] = int(base)
    note = {
        "blackjack": "Blackjack! The dealer pays 3:2.",
        "win": "You beat the dealer.",
        "push": "Push. Your bet comes back.",
        "lose": "The dealer wins this hand.",
        "bust": "Bust. You went over 21.",
    }[outcome]
    state["note"] = note
    return note


def _dealer_plays(state: dict) -> str:
    bet = int(state["bet"])
    while _hand_value(state["dealer"]) < 17:
        state["dealer"].append(_draw(state))
    dealer = _hand_value(state["dealer"])
    player = _hand_value(state["hand"])
    if dealer > 21:
        _wallet().credit(2 * bet, hand=True)
        return _settle(state, "win", "white")
    if player > dealer:
        _wallet().credit(2 * bet, hand=True)
        return _settle(state, "win", "white")
    if player == dealer:
        _wallet().credit(bet, hand=True)
        return _settle(state, "push", "")
    _wallet().credit(0, hand=True)
    return _settle(state, "lose", "black")


def _resolve_natural(state: dict) -> str | None:
    player = _is_blackjack(state["hand"])
    dealer = _is_blackjack(state["dealer"])
    bet = int(state["bet"])
    if player and dealer:
        _wallet().credit(bet, hand=True)
        return _settle(state, "push", "")
    if player:
        _wallet().credit(_blackjack_win(bet), hand=True)
        return _settle(state, "blackjack", "white")
    if dealer:
        _wallet().credit(0, hand=True)
        return _settle(state, "lose", "black")
    return None


def _ai_dealer(state: dict) -> bool:
    """True when the dealer seat is the built-in player or the person's agent.

    A person plays only the white seat, so the dealer's two quiet turns (checking
    the deal, then playing out) are handed to an AI seat when one is seated. With
    a human dealer seat the rules resolve both inside this module at once.
    """
    return kit.seat_kind(str(state.get("black") or "")) in kit.AI_KINDS


def legal(state: dict) -> list[str]:
    if state.get("status") != "active":
        return []
    held = _wallet().read()
    if state.get("phase") == "bet":
        moves = [f"bet{amount}" for amount in _BETS if amount <= held["chips"]]
        # Out of chips: one honest move that deals a fresh stack, instead of a table with no
        # legal move at all (which is how a player got stranded before).
        return moves or ["topup"]
    if state.get("phase") in {"deal", "dealer"}:
        return ["stand"]
    if state.get("phase") == "play":
        moves = ["hit", "stand"]
        # Double is only offered on the first two cards, and only with the chips to match the bet.
        if len(state.get("hand") or []) == 2 and held["chips"] >= int(state.get("bet") or 0):
            moves.append("double")
        return moves
    return []


def _defer_or_play(state: dict) -> str:
    if _ai_dealer(state):
        state["phase"] = "dealer"
        state["turn"] = "black"
        state["note"] = "The dealer plays out the hand."
        return state["note"]
    return _dealer_plays(state)


def play(state: dict, move) -> str:
    token = str(move)
    if state.get("phase") == "deal":
        state["phase"] = "play"
        state["turn"] = "white"
        state["note"] = "Dealer checks. Your turn: hit, stand or double."
        return state["note"]
    if state.get("phase") == "dealer":
        state["turn"] = "white"
        return _dealer_plays(state)
    # A move the table is not offering is refused here too, not only hidden in the UI:
    # after a hand is settled the phase goes back to betting, so a stray "double" must
    # never touch a finished hand's chips or stake.
    offered = legal(state)
    if offered and token not in offered:
        state["note"] = "That move is not on offer. " + ", ".join(offered) + "."
        return state["note"]
    if token == "topup":
        given = _wallet().topup(min(_BETS))
        state["note"] = (
            f"Out of chips. A fresh {given:,} to play with." if given
            else "You still have chips to bet."
        )
        return state["note"]
    if token.startswith("bet"):
        amount = int(token[3:])
        if not _wallet().debit(amount):
            state["note"] = "Not enough chips for that bet."
            return state["note"]
        # A new hand clears the last one off the felt. The shoe carries over between
        # hands and is reshuffled once it runs low.
        if int(state.get("hands") or 0) and len(state.get("deck") or []) < 15:
            state["deck"] = []
        state["hand"] = []
        state["dealer"] = []
        state["outcome"] = ""
        state["won"] = 0
        state["bet"] = amount
        state["phase"] = "play"
        _deal(state)
        natural = _resolve_natural(state)
        if natural is not None:
            return natural
        if _ai_dealer(state):
            state["phase"] = "deal"
            state["turn"] = "black"
            state["note"] = "Dealer checks the deal."
            return state["note"]
        state["note"] = f"Bet {amount}. Your turn: hit, stand or double."
        return state["note"]
    if token == "hit":
        state["hand"].append(_draw(state))
        total = _hand_value(state["hand"])
        if total > 21:
            _wallet().credit(0, hand=True)
            return _settle(state, "bust", "black")
        if total == 21:
            return _defer_or_play(state)
        state["note"] = f"You drew a card. Your total is {total}."
        return state["note"]
    if token == "double":
        bet = int(state["bet"])
        if not _wallet().debit(bet):
            state["note"] = "Not enough chips to double."
            return state["note"]
        # A double is one extra card and then you stand — there is no third decision, and
        # it is not a split. The original stake is remembered so the next hand does not
        # silently start at the doubled amount.
        state["base_bet"] = bet
        state["bet"] = bet * 2
        state["hand"].append(_draw(state))
        if _hand_value(state["hand"]) > 21:
            _wallet().credit(0, hand=True)
            note = _settle(state, "bust", "black")
        else:
            note = _defer_or_play(state)
        state["note"] = f"{note} You doubled to {bet * 2}: one card only, then you stood."
        return state["note"]
    if token == "stand":
        return _defer_or_play(state)
    state["note"] = "That is not a move in this game."
    return state["note"]


def bot(state: dict):
    moves = legal(state)
    if not moves:
        return None
    if state.get("phase") == "bet":
        return moves[0]
    if state.get("phase") in {"deal", "dealer"}:
        return "stand"
    total = _hand_value(state["hand"])
    if "double" in moves and 9 <= total <= 11:
        return "double"
    if total >= 17:
        return "stand"
    return "hit"


def draw(state: dict) -> list[str]:
    playing = state.get("phase") == "play"
    dealer_cards = list(state.get("dealer") or [])
    if playing and len(dealer_cards) > 1:
        dealer_cards[1] = "??"
    visible = [card for card in dealer_cards if card != "??"]
    dealer_total = _hand_value(visible) if visible else 0
    player_total = _hand_value(state.get("hand") or [])
    held = _wallet().read()
    lines = [
        f"Dealer: {' '.join(dealer_cards) or '(no cards)'}",
        f"Dealer shows: {dealer_total}",
        "",
        f"Your hand: {' '.join(state.get('hand') or []) or '(no cards)'}",
        f"Your total: {player_total}",
        f"Bet: {state.get('bet') or 0} chips",
        f"Chips: {held['chips']}",
    ]
    if state.get("note"):
        lines.append("")
        lines.append(str(state["note"]))
    if state.get("status") not in {None, "", "active"}:
        lines.append("")
        if state.get("winner") == "white":
            lines.append("You win.")
        elif state.get("winner") == "black":
            lines.append("The dealer wins.")
        else:
            lines.append("Push.")
    return lines


def picture(state: dict, player=None) -> dict:
    del player
    playing = state.get("phase") == "play"
    dealer = list(state.get("dealer") or [])
    if playing and len(dealer) > 1:
        dealer[1] = "??"
    visible = [card for card in dealer if card != "??"]
    held = _wallet().read()
    return {
        "view": "blackjack",
        "phase": state.get("phase", "bet"),
        "hand": list(state.get("hand") or []),
        "dealer": dealer,
        "player_total": _hand_value(state.get("hand") or []),
        "dealer_total": _hand_value(visible) if visible else 0,
        "bet": int(state.get("bet") or 0),
        "chips": held["chips"],
        "outcome": str(state.get("outcome") or ""),
        "won": int(state.get("won") or 0),
        "hands": int(state.get("hands") or 0),
        "bets": list(_BETS),
        "note": str(state.get("note") or ""),
        "legal": legal(state),
        "status": state.get("status", ""),
        "winner": state.get("winner", ""),
    }


def explain(move, state) -> str:
    token = str(move)
    if token.startswith("bet"):
        return "A modest bet keeps chips for another hand."
    if token == "hit":
        return "Take another card while your total is still low."
    if token == "stand":
        return "Stand when your total is strong enough to beat the dealer."
    if token == "double":
        return "Doubling at this total is worth the extra stake."
    return "Play the hand the dealer deals you."
