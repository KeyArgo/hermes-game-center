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
    "Split two cards of the same rank into two hands, each with a bet of its own; split aces "
    "take one card each and a 21 there is not a blackjack.",
]

_BETS = (10, 25, 50, 100, 500, 1000)
_RANKS = ("A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K")
_SUITS = ("S", "H", "D", "C")

# --- the house rules --------------------------------------------------------------
# A pair splits on the same RANK only (A/A, 8/8, K/K). A king and a queen are both ten and
# some casinos split those too; that sits behind this flag, off by default, because a table
# that splits two different-looking cards surprises the person holding them.
SPLIT_EQUAL_VALUE = False
# Splitting aces is dealt the casino way: exactly one card to each split ace, no further hit
# and no double, and an ace with a ten is 21 rather than a natural blackjack. Splitting the
# ace pair that comes back is a separate flag, off by default as at most tables.
RESPLIT_ACES = False
# One round holds the first hand and its resplits: four hands at most.
MAX_HANDS = 4
# Double after a split is allowed, except on split aces, which take one card only.
DOUBLE_AFTER_SPLIT = True

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
        # The felt's one hand, kept as a mirror of the hand being played: older surfaces and
        # states written before Split read this field, so it is never the whole truth now.
        "hand": [],
        "dealer": [],
        "deck": [],
        "bet": 0,
        "outcome": "",
        "note": "",
        # The round's hands in the order they are played, and which one is being played. A
        # round with no split holds exactly one; a split holds two or more.
        "player_hands": [],
        "active_hand": 0,
    }


def parse(words: list[str]) -> str | None:
    if not words:
        return None
    if len(words) == 1:
        word = words[0].lower()
        if word in {"hit", "stand", "double", "split", "topup"}:
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


def _is_soft(cards: list[str]) -> bool:
    """An ace still counted as 11 because the total fits: a soft hand."""
    aces = sum(1 for card in cards if card[:-1] == "A")
    hard = sum(1 if card[:-1] == "A" else _card_value(card) for card in cards)
    return aces > 0 and hard + 10 <= 21


def _is_natural(hand: dict) -> bool:
    """A blackjack, which only the two cards dealt can be.

    A hand that came out of a split is never one, whatever it totals: an ace and a ten after
    a split is 21 and pays even money, not 3:2.
    """
    cards = hand.get("cards") or []
    return not hand.get("from_split") and len(cards) == 2 and _hand_value(cards) == 21


def _make_hand(cards, wager: int, *, base: int | None = None, from_split: bool = False,
               split_aces: bool = False) -> dict:
    """One hand of a round: its cards, what is staked on it, and how it finished."""
    return {
        "cards": [str(card) for card in cards],
        "wager": int(wager),
        # What the hand was bet before any double, so the felt can show both numbers.
        "base": int(wager if base is None else base),
        "doubled": False,
        "from_split": bool(from_split),
        "split_aces": bool(split_aces),
        "done": False,
        "result": "",
    }


def _plain_hand(record: object) -> dict | None:
    """One saved hand record in the shape the rules read. None when it holds no cards.

    A record that is already in this shape is handed back as the same dict, so an edit the
    caller made to a hand is still there after the next read: rebuilding the record would
    quietly drop it, which is how a split hand kept coming back unfinished.
    """
    if not isinstance(record, dict) or not isinstance(record.get("cards"), list):
        return None
    wager = record.get("wager")
    base = record.get("base")
    if (all(isinstance(card, str) for card in record["cards"])
            and isinstance(wager, int) and not isinstance(wager, bool) and 0 <= wager
            and isinstance(base, int) and not isinstance(base, bool) and base > 0
            and isinstance(record.get("done"), bool) and isinstance(record.get("result"), str)):
        return record
    wager = wager if isinstance(wager, int) and not isinstance(wager, bool) and wager >= 0 else 0
    base = base if isinstance(base, int) and not isinstance(base, bool) and base > 0 else wager
    hand = _make_hand([str(card) for card in record["cards"]], wager, base=base,
                      from_split=record.get("from_split") is True,
                      split_aces=record.get("split_aces") is True)
    hand["doubled"] = record.get("doubled") is True
    hand["done"] = record.get("done") is True
    hand["result"] = str(record.get("result") or "")[:16]
    return hand


def _active(state: dict) -> int:
    """Which hand the next move plays: the stored index when it still points at one."""
    hands = state.get("player_hands") or []
    index = state.get("active_hand")
    if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < len(hands):
        return 0
    return index


def _migrate(state: dict) -> list[dict]:
    """The round's hands, from this state or lifted out of an older single-hand save.

    States written before Split keep the one hand in ``state["hand"]``. That list is still
    written on every move, because older surfaces read it, but the hand records are the
    truth: an old save becomes one record on the first read and plays on unchanged.
    """
    saved = state.get("player_hands")
    if isinstance(saved, list) and saved:
        hands = [hand for hand in (_plain_hand(item) for item in saved) if hand is not None]
        if hands:
            state["player_hands"] = hands
            state["active_hand"] = _active(state)
            return hands
    cards = state.get("hand")
    cards = [str(card) for card in cards] if isinstance(cards, list) else []
    state["player_hands"] = []
    state["active_hand"] = 0
    if not cards:
        return []
    bet = state.get("bet")
    bet = bet if isinstance(bet, int) and not isinstance(bet, bool) and bet >= 0 else 0
    saved_base = state.get("base_bet")
    base = saved_base if isinstance(saved_base, int) and saved_base > 0 else bet
    hand = _make_hand(cards, bet, base=base)
    hand["doubled"] = bool(saved_base) or bet > base
    if state.get("phase") == "bet" and state.get("outcome"):
        hand["done"] = True
        hand["result"] = str(state.get("outcome") or "")
    state["player_hands"] = [hand]
    return state["player_hands"]


def _live_hand(state: dict) -> dict | None:
    hands = _migrate(state)
    return hands[_active(state)] if hands else None


def _sync(state: dict) -> None:
    """Keep the old single-hand fields true: the felt and every older reader uses them."""
    hands = state.get("player_hands") or []
    if not hands:
        state["hand"] = []
        return
    hand = hands[_active(state)]
    state["hand"] = list(hand["cards"])
    state["bet"] = int(hand["wager"])


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
    hand = _live_hand(state)
    if hand is None:
        return
    hand["cards"].append(_draw(state))
    state["dealer"].append(_draw(state))
    hand["cards"].append(_draw(state))
    state["dealer"].append(_draw(state))
    _sync(state)


def _blackjack_win(stake: int) -> int:
    """3:2 on the stake, rounded up. Integer chips cannot pay a half, and bets that are not
    a multiple of 20 (25 is the slot minimum) would otherwise come up half a chip short."""
    return stake + (stake * 3 + 1) // 2


def _payout(result: str, wager: int) -> int:
    """What one finished hand gives back to the wallet: the stake plus what it won."""
    return {
        "blackjack": _blackjack_win(wager),
        "win": 2 * wager,
        "push": wager,
    }.get(result, 0)


_RESULT_WORDS = {
    "blackjack": "Blackjack! The dealer pays 3:2.",
    "win": "You beat the dealer.",
    "push": "Push. Your bet comes back.",
    "lose": "The dealer wins this hand.",
    "bust": "Bust. You went over 21.",
}
_RESULT_VERBS = {"blackjack": "blackjack", "win": "won", "push": "pushed",
                 "lose": "lost", "bust": "busted"}


def _round_outcome(results: list[str]) -> str:
    """One word for the felt when the hands agree, and 'mixed' when they do not."""
    if not results:
        return ""
    if all(result == results[0] for result in results):
        return results[0]
    return "mixed"


def _round_note(results: list[str], net: int) -> str:
    if len(results) <= 1:
        return _RESULT_WORDS.get(results[0] if results else "", "")
    said = ", ".join(f"Hand {number} {_RESULT_VERBS[result]}"
                     for number, result in enumerate(results, start=1))
    net_words = f"{net:+,}" if net else "0"
    return f"{said}. Net {net_words} chips."


def _settle_round(state: dict) -> str:
    """Settle every hand of the round against the dealer in one wallet change.

    The table stays open: a finished round goes straight back to betting, with the cards
    left face up so the result can be read, until the person leaves the table.
    """
    hands = _migrate(state)
    dealer_total = _hand_value(state["dealer"])
    dealer_natural = _is_blackjack(state["dealer"])
    paid = 0
    net = 0
    results = []
    for hand in hands:
        total = _hand_value(hand["cards"])
        natural = _is_natural(hand)
        if total > 21:
            result = "bust"
        elif natural and dealer_natural:
            result = "push"
        elif natural:
            result = "blackjack"
        elif dealer_natural:
            result = "lose"
        elif dealer_total > 21 or total > dealer_total:
            result = "win"
        elif total == dealer_total:
            result = "push"
        else:
            result = "lose"
        hand["done"] = True
        hand["result"] = result
        wager = int(hand["wager"])
        paid += _payout(result, wager)
        net += _payout(result, wager) - wager
        results.append(result)
    # One change for the round: the chips left the stack when the bet (and the split, and
    # the double) was taken, so only what is owed back moves here.
    _wallet().credit(paid, hand=True)
    state["phase"] = "bet"
    state["outcome"] = _round_outcome(results)
    state["won"] = net
    state["hands"] = int(state.get("hands") or 0) + 1
    # A doubled or split round put more on the felt for that round only; the next bet starts
    # from what the person chose, not from the wagers it grew to. No hand is being played any
    # more, so the felt reads them from the first.
    base = state.pop("base_bet", None)
    state["active_hand"] = 0
    _sync(state)
    if base:
        state["bet"] = int(base)
    state["note"] = _round_note(results, net)
    return state["note"]


def _dealer_plays(state: dict) -> str:
    while _hand_value(state["dealer"]) < 17:
        state["dealer"].append(_draw(state))
    return _settle_round(state)


def _resolve_natural(state: dict) -> str | None:
    """A natural settles at once: the house peeks, and a natural beats a drawn 21."""
    hands = _migrate(state)
    if len(hands) != 1:
        return None
    if _is_natural(hands[0]) or _is_blackjack(state["dealer"]):
        return _settle_round(state)
    return None


def _can_double(state: dict, hand: dict, chips: int | None = None) -> bool:
    """Double is for an untouched two-card hand, with the chips to match its wager."""
    if hand.get("done") or len(hand.get("cards") or []) != 2:
        return False
    # Split aces take exactly one card: no hit, no double, ever.
    if hand.get("split_aces"):
        return False
    if hand.get("from_split") and not DOUBLE_AFTER_SPLIT:
        return False
    held = _wallet().read()["chips"] if chips is None else chips
    return held >= int(hand.get("wager") or 0)


def _can_split(state: dict, hand: dict, chips: int | None = None) -> bool:
    cards = hand.get("cards") or []
    if hand.get("done") or len(cards) != 2:
        return False
    ranks = [card[:-1] for card in cards]
    if ranks[0] != ranks[1] and not (
        SPLIT_EQUAL_VALUE and _card_value(cards[0]) == _card_value(cards[1])
    ):
        return False
    # Splitting aces is the first split; splitting the ace that comes back is the flag.
    if ranks[0] == "A" and hand.get("from_split") and not RESPLIT_ACES:
        return False
    if len(_migrate(state)) >= MAX_HANDS:
        return False
    held = _wallet().read()["chips"] if chips is None else chips
    return held >= int(hand.get("wager") or 0)


def _split(state: dict) -> str:
    """Two cards of one rank become two hands, each with the first bet's wager on it."""
    hands = _migrate(state)
    index = _active(state)
    hand = hands[index]
    stake = int(hand["wager"])
    if not _wallet().debit(stake):
        state["note"] = "Not enough chips to split."
        return state["note"]
    cards = list(hand["cards"])
    aces = cards[0][:-1] == cards[1][:-1] == "A"
    first = _make_hand(cards[:1], stake, from_split=True, split_aces=aces)
    second = _make_hand(cards[1:], stake, from_split=True, split_aces=aces)
    # The first hand keeps the seat and the new one sits beside it, so the two read left to
    # right in the order they are played.
    hands[index:index + 1] = [first, second]
    state["player_hands"] = hands
    state["active_hand"] = index
    for split_hand in (first, second):
        split_hand["cards"].append(_draw(state))
    _sync(state)
    totals = ", ".join(str(_hand_value(split_hand["cards"])) for split_hand in (first, second))
    if aces:
        # The casino default: one card each, then both hands are finished. An ace and a ten
        # is 21 here, not a natural, so it never pays 3:2. The one thing left is a hand that
        # drew another ace: with RESPLIT_ACES on it may be split once more, and only that.
        for split_hand in (first, second):
            split_hand["done"] = not _can_split(state, split_hand)
        settled = _advance(state)
        if all(split_hand["done"] for split_hand in (first, second)):
            note = f"Split aces: one card each ({totals}), and both hands stand."
        else:
            note = f"Split aces: one card each ({totals}). An ace can be split again."
        state["note"] = f"{note} {settled}".strip() if settled else note
        return state["note"]
    state["note"] = (f"Split into two hands, {stake:,} more on the felt. "
                     f"Hand 1: {_hand_value(first['cards'])}. Your move.")
    return state["note"]


def _advance(state: dict) -> str:
    """Play the next unfinished hand, or finish the round.

    The dealer plays only once every hand is done, and not at all when they all busted:
    there is nothing left to beat.
    """
    hands = _migrate(state)
    for index, hand in enumerate(hands):
        if not hand.get("done"):
            state["active_hand"] = index
            _sync(state)
            if len(hands) > 1:
                state["note"] = (f"Hand {index + 1} of {len(hands)}: "
                                 f"{_hand_value(hand['cards'])}. Your move.")
            return ""
    if hands and all(_hand_value(hand["cards"]) > 21 for hand in hands):
        return _settle_round(state)
    return _defer_or_play(state)


def _turn_line(state: dict) -> str:
    """The moves on offer, in words, so a note can never promise one the rules refuse."""
    offered = legal(state)
    if not offered:
        return "No moves are on offer."
    if len(offered) == 1:
        return f"Your move: {offered[0]}."
    return "Your move: " + ", ".join(offered[:-1]) + f" or {offered[-1]}."


def _after_hand(state: dict, said: str) -> str:
    """One hand is finished: say so, then the next hand or the settled round."""
    settled = _advance(state)
    if settled:
        state["note"] = f"{said} {settled}".strip()
    elif said:
        state["note"] = f"{said} {state['note']}".strip()
    return state["note"]


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
        hand = _live_hand(state)
        if hand is not None and hand.get("split_aces"):
            # A split ace has had its one card: it stands, unless a resplit is on offer.
            return ["stand"] + (["split"] if _can_split(state, hand, held["chips"]) else [])
        moves = ["hit", "stand"]
        if hand is not None:
            # Double and split are offered by the rules, never guessed at by the felt, and
            # both need the chips for the extra wager before they are on offer.
            if _can_double(state, hand, held["chips"]):
                moves.append("double")
            if _can_split(state, hand, held["chips"]):
                moves.append("split")
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
    _migrate(state)
    if state.get("phase") == "deal":
        state["phase"] = "play"
        state["turn"] = "white"
        state["note"] = _turn_line(state)
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
        state["dealer"] = []
        state["outcome"] = ""
        state["won"] = 0
        state["bet"] = amount
        state["player_hands"] = [_make_hand([], amount)]
        state["active_hand"] = 0
        # What the person chose is remembered for the whole round: a double or a split grows
        # the felt's wagers, and the next bet starts from this, not from them.
        state["base_bet"] = amount
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
        state["note"] = f"Bet {amount}. {_turn_line(state)}"
        return state["note"]
    if token == "hit":
        hand = _live_hand(state)
        if hand is None:
            state["note"] = "There is no hand to hit."
            return state["note"]
        hand["cards"].append(_draw(state))
        total = _hand_value(hand["cards"])
        _sync(state)
        if total > 21:
            hand["done"] = True
            hand["result"] = "bust"
            return _after_hand(state, f"Bust with {total}.")
        if total == 21:
            hand["done"] = True
            return _after_hand(state, f"Twenty-one: {total}. That hand stands.")
        if len(state["player_hands"]) > 1:
            state["note"] = (f"Hand {_active(state) + 1} draws: {total}.")
        else:
            state["note"] = f"You drew a card. Your total is {total}."
        return state["note"]
    if token == "double":
        hand = _live_hand(state)
        if hand is None:
            state["note"] = "There is no hand to double."
            return state["note"]
        stake = int(hand["wager"])
        if not _wallet().debit(stake):
            state["note"] = "Not enough chips to double."
            return state["note"]
        # A double is one extra card and then that hand stands — there is no third decision,
        # and it is not a split. The wager on this hand grows; the round's base bet does not.
        hand["wager"] = stake * 2
        hand["doubled"] = True
        hand["cards"].append(_draw(state))
        hand["done"] = True
        total = _hand_value(hand["cards"])
        if total > 21:
            hand["result"] = "bust"
        _sync(state)
        return _after_hand(
            state, f"You doubled to {stake * 2}: one card only, then you stood "
                   f"(hand total {total}).")
    if token == "split":
        return _split(state)
    if token == "stand":
        hand = _live_hand(state)
        if hand is not None:
            hand["done"] = True
        return _after_hand(state, "")
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
    hand = _live_hand(state)
    cards = list((hand or {}).get("cards") or [])
    total = _hand_value(cards)
    ranks = [card[:-1] for card in cards]
    # Basic strategy in one line: split aces and eights, and any pair small enough to improve
    # on a hit. Tens and fives are played as they are, because standing on 20 and doubling on
    # 10 are better than splitting them.
    if "split" in moves and len(cards) == 2:
        if ranks[0] in {"A", "8"} or _card_value(cards[0]) <= 9:
            return "split"
    if "double" in moves and 9 <= total <= 11:
        return "double"
    if total >= 17 or "hit" not in moves:
        return "stand"
    return "hit"


def draw(state: dict) -> list[str]:
    playing = state.get("phase") == "play"
    dealer_cards = list(state.get("dealer") or [])
    if playing and len(dealer_cards) > 1:
        dealer_cards[1] = "??"
    visible = [card for card in dealer_cards if card != "??"]
    dealer_total = _hand_value(visible) if visible else 0
    hands = _migrate(state)
    held = _wallet().read()
    lines = [
        f"Dealer: {' '.join(dealer_cards) or '(no cards)'}",
        f"Dealer shows: {dealer_total}",
        "",
    ]
    if len(hands) > 1:
        # A split round is read hand by hand: the cards, the wager on them and how each one
        # finished. The hand being played is named, so the next move is never a guess.
        for number, hand in enumerate(hands, start=1):
            cards = " ".join(hand["cards"]) or "(no cards)"
            wager = f"bet {int(hand['wager']):,}" + (" (doubled)" if hand.get("doubled") else "")
            result = f", {hand['result']}" if hand.get("result") else ""
            current = " <-- playing" if playing and number - 1 == _active(state) else ""
            lines.append(f"Hand {number}: {cards} = {_hand_value(hand['cards'])} "
                         f"({wager}{result}){current}")
        lines.append(f"Total bet: {sum(int(hand['wager']) for hand in hands):,} chips")
    else:
        lines.append(f"Your hand: {' '.join(state.get('hand') or []) or '(no cards)'}")
        lines.append(f"Your total: {_hand_value(state.get('hand') or [])}")
        lines.append(f"Bet: {state.get('bet') or 0} chips")
    lines.append(f"Chips: {held['chips']}")
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


def _shown_hand(hand: dict, number: int, active: int, playing: bool) -> dict:
    """One hand as the felt draws it: cards, total, what is staked, and how it went."""
    cards = list(hand.get("cards") or [])
    total = _hand_value(cards)
    return {
        "cards": cards,
        "total": total,
        "soft": _is_soft(cards),
        "wager": int(hand.get("wager") or 0),
        "original": int(hand.get("base") or hand.get("wager") or 0),
        "doubled": bool(hand.get("doubled")),
        "from_split": bool(hand.get("from_split")),
        "active": bool(playing and number == active),
        "done": bool(hand.get("done")),
        "bust": total > 21,
        # A split 21 is not a blackjack, so the felt never labels it one.
        "blackjack": _is_natural(hand),
        "result": str(hand.get("result") or ""),
    }


def picture(state: dict, player=None) -> dict:
    del player
    playing = state.get("phase") == "play"
    dealer = list(state.get("dealer") or [])
    if playing and len(dealer) > 1:
        dealer[1] = "??"
    visible = [card for card in dealer if card != "??"]
    held = _wallet().read()
    hands = _migrate(state)
    active = _active(state) if hands else 0
    return {
        "view": "blackjack",
        "phase": state.get("phase", "bet"),
        # The one hand on the felt, and every hand of the round: the first is what older
        # surfaces read, the second is what the felt draws when a hand was split.
        "hand": list(state.get("hand") or []),
        "dealer": dealer,
        "player_total": _hand_value(state.get("hand") or []),
        "dealer_total": _hand_value(visible) if visible else 0,
        "bet": int(state.get("bet") or 0),
        "chips": held["chips"],
        "outcome": str(state.get("outcome") or ""),
        "won": int(state.get("won") or 0),
        "hands": int(state.get("hands") or 0),
        "player_hands": [_shown_hand(hand, number, active, playing)
                         for number, hand in enumerate(hands)],
        "active_hand": int(active),
        "total_wager": sum(int(hand["wager"]) for hand in hands),
        "original_bet": int(state.get("base_bet") or (hands[0]["base"] if hands else 0) or 0),
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
    if token == "split":
        return "Two cards of one rank are two hands: split them and play each one."
    return "Play the hand the dealer deals you."
