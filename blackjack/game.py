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
    "The dealer has no decisions: the house rules play its cards out at once, whoever the "
    "felt names in that seat (the built-in computer, your Hermes model, or the plain house).",
    "Two people can share this screen: allow-ai blackjack black=local players=2 seats a second "
    "player, whose chips are a table-only stack and never the Jackpot wallet's.",
]

_BETS = (10, 25, 50, 100, 500, 1000)
# A second person on this screen sits down with a stack of their own, kept in the table
# state and never in the Jackpot wallet: a guest at the table cannot spend the owner's chips,
# and the owner's chips cannot be won by a guest.
GUEST_CHIPS = 10_000
GUEST_NAME = "Player 2"
# What a seat at a lobby table sits down with. Online, both seats keep their own stack in the
# table's own state - never in a wallet file, and never the owner's Jackpot chips - and the table
# neither refills nor mints one: a lobby table is a game, not a way into somebody's wallet.
TABLE_CHIPS = 10_000
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
# True while the table being driven is a lobby table (a room passes settings["table_chips"]).
# ``create`` sets it for every command, exactly as it sets the wallet: a room builds a table,
# runs one command and lets it go. A lobby table's chips are in its own state, so the kit's
# save-undo doors must not read - or write - a wallet at all.
_TABLE_MODE = False


def use_wallet(path) -> None:
    global _WALLET
    _WALLET = wallet.Wallet(Path(path))


def _wallet() -> "wallet.Wallet":
    global _WALLET
    if _WALLET is None:
        _WALLET = wallet.Wallet(Path("wallet.json"))
    return _WALLET


def _stacks(state: dict) -> list[int] | None:
    """The two seats' own stacks, when this table keeps its chips in its own state."""
    stacks = state.get("stacks")
    if (isinstance(stacks, list) and len(stacks) == 2
            and all(isinstance(value, int) and not isinstance(value, bool) and value >= 0
                    for value in stacks)):
        return stacks
    return None


def _table_chips(state: dict) -> bool:
    """True for a lobby table: each seat's chips are the table's, not a wallet's."""
    return _stacks(state) is not None


def chips_now() -> int:
    """What the wallet holds, for the table's own undo when a save never lands.

    A lobby table has no wallet: its chips are in the table state, so there is nothing to read
    here and nothing for the kit to put back.
    """
    if _TABLE_MODE:
        return 0
    return int(_wallet().read()["chips"])


def chips_reclaim(chips: int) -> None:
    """Take back a payout made for a state that could not be written: the hand was never settled."""
    if _TABLE_MODE:
        return
    chips = int(chips)
    if chips > 0:
        held = int(_wallet().read()["chips"])
        _wallet().debit(min(chips, held))


def chips_refund(chips: int) -> None:
    """Put chips back after a state that could not be written: the bet was never staked.

    The table calls this when Windows refuses the state swap (a poll has the file open) after a
    bet has already left the wallet. It is a plain credit: no hand is counted, because no hand
    was played.
    """
    if _TABLE_MODE:
        return
    if int(chips) > 0:
        _wallet().credit(int(chips))


def create(root: Path, settings: dict | None = None):
    settings = settings or {}
    global _TABLE_MODE
    root = Path(root)
    _TABLE_MODE = bool(settings.get("table_chips"))
    # A table plays with one wallet. Locally that is the profile's shared chips file.
    # Online, the server passes its own wallet so one room's chips never reach another's.
    use_wallet(Path(settings.get("wallet") or (root.parent / "wallet.json")))
    table = kit.Table(root, kit.rules(globals()))
    # The table is live the moment it is placed: it waits on no "new" and no first
    # bet, and a table that reads as "idle" looks never started to a playthrough.
    if kit.load(root) is None:
        if not _TABLE_MODE:
            # A local table: a person with no chips left is given the starting stake back. A
            # lobby table never does this - nobody's wallet is opened for a room on a server.
            if _wallet().read()["chips"] <= 0:
                _wallet().refill()
        state = {
            "schema_version": 2, "table_id": uuid.uuid4().hex, "owner_id": "",
            "score": {"white": 0, "black": 0, "draws": 0}, "moves": [],
            "rematch": {"requested_by": []}, "draw_offer": "", "game": ID,
            "turn": "white", "white": "human", "black": "human",
            "status": "active", "winner": "", "plies": 0, "last": "", "result_detail": "",
            **fresh(),
        }
        if _TABLE_MODE:
            # Both seats sit down with a table-only stack, saved with the table.
            state["stacks"] = [TABLE_CHIPS, TABLE_CHIPS]
        kit.write(root, state)
    return table


def fresh() -> dict:
    # No wallet is read here: this shape is also built for a preview of a table nobody has
    # started, and looking at a board must never mint chips into somebody's wallet.
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
        # round with no split holds exactly one; a split holds two or more. A table with two
        # people holds one block per person, in seat order.
        "player_hands": [],
        "active_hand": 0,
        # One person on this table until a second sits down (setup, players=2).
        "players": 1,
    }


def setup(state: dict, options: dict) -> str:
    """Table options that come on the same line as the seats.

    ``allow-ai blackjack black=local players=2`` seats a second person on this screen: both
    play against the dealer, each from their own stack, and the first person's chips are the
    Jackpot wallet's. Anything else is refused in words, so a typo never silently deals a
    table nobody asked for.
    """
    said = str(options.get("players") or "").strip().lower()
    chips = str(options.get("chips") or "").strip().lower()
    if chips and chips != "table":
        return ("Usage: /games blackjack allow-ai black=local players=2 chips=table "
                "(two people, a table stack each)")
    if not said:
        # A lone host at a lobby table: the shape waits for a person, the chips are the table's.
        if chips == "table":
            state["stacks"] = [TABLE_CHIPS, TABLE_CHIPS]
        return ""
    if said not in {"1", "2"}:
        return "Usage: /games blackjack allow-ai black=local players=1|players=2 (one or two people)"
    if said == "2":
        state["players"] = 2
        state["guest"] = {"name": GUEST_NAME, "chips": GUEST_CHIPS, "last_bet": 0}
        state["betting"] = 0
        state["round_bets"] = [0, 0]
    else:
        state["players"] = 1
        state.pop("guest", None)
        state.pop("betting", None)
        state.pop("round_bets", None)
    if chips == "table":
        # A lobby table: each seat keeps its own 10,000 in the table's state, never in a wallet.
        state["stacks"] = [TABLE_CHIPS, TABLE_CHIPS]
    return ""


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
               split_aces: bool = False, player: int = 0) -> dict:
    """One hand of a round: its cards, what is staked on it, and how it finished."""
    return {
        "cards": [str(card) for card in cards],
        "wager": int(wager),
        # What the hand was bet before any double, so the felt can show both numbers.
        "base": int(wager if base is None else base),
        # Which person at the table owns this hand: 0 is the wallet's player, 1 the guest.
        "player": 1 if player == 1 else 0,
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
                      split_aces=record.get("split_aces") is True,
                      player=1 if record.get("player") == 1 else 0)
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


# --- the people at the table -------------------------------------------------------
# Seat 0 is the person whose chips are the Jackpot wallet's. Seat 1 exists only on a table
# set up with players=2: a second person on this screen, with their own stack kept in the
# table state. Hands carry the seat they belong to, so a round is settled hand by hand,
# each to the person who owns it.

def _two_seats(state: dict) -> int:
    """The shape the table was set up with: one person, or a seat for a second."""
    value = state.get("players")
    if isinstance(value, bool) or value is None:
        return 2 if value is True else 1
    if isinstance(value, int):
        return 2 if value == 2 else 1
    return 2 if str(value).strip() == "2" else 1


def _occupied_owners(state: dict) -> list[int]:
    """Lobby seats that still have a person. A local table is not this list."""
    if not _table_chips(state):
        return []
    found = []
    if str(state.get("white_id") or ""):
        found.append(0)
    if str(state.get("black_id") or ""):
        found.append(1)
    return found


def _lone_owner(state: dict) -> int | None:
    """The one person left, when the other seat has got up. None when it is not that case."""
    occupied = _occupied_owners(state)
    if len(occupied) == 1:
        return occupied[0]
    return None


def _table_players(state: dict) -> int:
    """How many people are really at the table.

    ``players=2`` is the shape a table is set up with: a second stack and a bet each. A lobby
    table is set up before anybody has sat in that seat, and a seat with nobody in it is not a
    second player - the host plays their own hand until a person sits down between hands.
    The same is true the other way: if the first person gets up and the second stays, the
    second person plays on alone instead of waiting for an empty seat.

    A local two-person screen has no seat ids. Both people are at the keyboard, and the guest
    record is the second stack, so an empty ``black_id`` must not collapse that table to one.
    Only a lobby table (chips kept in the table's own stacks) counts occupied seats.
    """
    if _two_seats(state) != 2:
        return 1
    if _table_chips(state):
        return 2 if len(_occupied_owners(state)) >= 2 else 1
    return 2


def _guest(state: dict) -> dict:
    """The second person's table-only stack. Missing or broken reads as a fresh one."""
    guest = state.get("guest")
    if not isinstance(guest, dict):
        # The repair has to be as durable as the read. A thrown-away dict here made the guest's
        # bets free and their payouts vanish - the stack read 10,000 for ever - because every
        # caller worked on a copy nobody kept. ``setup`` is the only other writer of this record.
        guest = {}
        state["guest"] = guest
    guest["name"] = str(guest.get("name") or GUEST_NAME)
    chips = guest.get("chips")
    guest["chips"] = chips if isinstance(chips, int) and not isinstance(chips, bool) and chips >= 0 else GUEST_CHIPS
    return guest


def _owner(hand: dict) -> int:
    value = hand.get("player") if isinstance(hand, dict) else 0
    return 1 if value == 1 or value == "1" else 0


def _player_name(state: dict, owner: int) -> str:
    """What the felt calls one person.

    A lobby table names the people who sat down (their own names, from their seats). The local
    two-person screen keeps its plain "Player 1" and "Player 2".
    """
    if _table_chips(state):
        seat = str(state.get("black_name" if owner else "white_name") or "")
        if seat:
            return seat
    return str(_guest(state)["name"]) if owner else "Player 1"


def _stack(state: dict, owner: int) -> int:
    """What one person can bet from: a lobby table's own stack, or the wallet / the guest's."""
    stacks = _stacks(state)
    if stacks is not None:
        return int(stacks[1 if owner else 0])
    return int(_guest(state)["chips"]) if owner else int(_wallet().read()["chips"])


def _stake(state: dict, owner: int, amount: int) -> bool:
    """Take a wager from the person who made it: the wallet, or the seat's own stack."""
    amount = int(amount)
    stacks = _stacks(state)
    if stacks is not None:
        seat = 1 if owner else 0
        if int(stacks[seat]) < amount:
            return False
        stacks[seat] = int(stacks[seat]) - amount
        return True
    if not owner:
        return _wallet().debit(amount)
    guest = _guest(state)
    if int(guest["chips"]) < amount:
        return False
    guest["chips"] = int(guest["chips"]) - amount
    return True


def _credit(state: dict, owner: int, amount: int) -> None:
    """Pay a finished hand back to the stack it was staked from - never across people."""
    amount = int(amount)
    stacks = _stacks(state)
    if stacks is not None:
        seat = 1 if owner else 0
        stacks[seat] = int(stacks[seat]) + amount
        return
    if not owner:
        _wallet().credit(amount, hand=True)
        return
    guest = _guest(state)
    guest["chips"] = int(guest["chips"]) + amount


def _betting_owner(state: dict) -> int:
    """Whose bet the table is waiting for: seat 0 first, then the guest.

    One person left in the second seat bets from that seat, not from the empty one.
    """
    if _table_players(state) != 2:
        lone = _lone_owner(state)
        if lone is not None:
            return lone
        return 0
    return 1 if state.get("betting") == 1 else 0


def refund_undealt(state: dict) -> None:
    """Give back chips staked for a round that was never dealt."""
    bets = _round_bets(state)
    for owner, amount in enumerate(list(bets)):
        if amount:
            _credit(state, owner, int(amount))
    state["round_bets"] = [0, 0]
    state["mid_round"] = False
    state["betting"] = 0


def forfeit_seat(state: dict, owner: int) -> str:
    """This person left during a hand. Their unfinished hands are lost and the wager stays taken.

    Whoever is still sitting plays the rest of the hand. If nothing is left to play, the
    round settles, and the person who stayed is the one it pays.
    """
    seat = 1 if int(owner) == 1 else 0
    for hand in _migrate(state):
        if _owner(hand) != seat or hand.get("result"):
            continue
        hand["done"] = True
        hand["result"] = "lose"
    note = _advance(state)
    if note:
        state["note"] = note
    _sync_turn(state)
    return str(state.get("note") or "")


def _round_bets(state: dict) -> list[int]:
    bets = state.get("round_bets")
    if not isinstance(bets, list) or len(bets) != 2:
        bets = [0, 0]
    cleaned = [int(value) if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0
               for value in bets]
    state["round_bets"] = cleaned
    return cleaned


def _hand_net(hand: dict) -> int:
    """What one finished hand gave back over what it staked."""
    result = str(hand.get("result") or "")
    wager = int(hand.get("wager") or 0)
    return _payout(result, wager) - wager if result else 0


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


def _shoe(state: dict) -> list[str]:
    """One shuffled shoe for the next deal or rebuild, from the table's own seed.

    The seed carries the round count and a shoe count. The round count alone was not enough: it
    only moves at settlement, so a shoe rebuilt inside a round reproduced the hand that round
    started with, from the same end of the same order, and dealt a card twice. The count is kept
    in the state, so a replay of the same saves deals the same shoes.
    """
    state["shoes"] = int(state.get("shoes") or 0) + 1
    return _new_deck(f"{state.get('shoe') or ''}:{int(state.get('hands') or 0)}:{state['shoes']}")


def _draw(state: dict) -> str:
    if not state["deck"]:
        state["deck"] = _shoe(state)
    return state["deck"].pop()


def _deal(state: dict) -> None:
    """Two cards each, one to the dealer between rounds.

    A table with one player deals exactly as it always did: player, dealer, player,
    dealer. A second person sits between them in the deal, so the order is Player 1,
    Player 2, dealer, twice - every hand and the dealer's two cards from the same shoe.
    """
    if not state["deck"]:
        state["deck"] = _shoe(state)
    hands = _migrate(state)
    if not hands:
        return
    for _ in range(2):
        for hand in hands:
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


def _two_player_note(state: dict, hands: list[dict]) -> str:
    """One sentence per person: what their own hands came to, and their own net."""
    parts = []
    for owner in (0, 1):
        mine = [hand for hand in hands if _owner(hand) == owner]
        if not mine:
            continue
        results = [str(hand.get("result") or "") for hand in mine]
        net = sum(_hand_net(hand) for hand in mine)
        said = _round_outcome(results)
        word = _RESULT_VERBS.get(said, said)
        if len(mine) > 1:
            word = ", ".join(f"hand {number} {_RESULT_VERBS.get(result, result)}"
                             for number, result in enumerate(results, start=1))
        parts.append(f"{_player_name(state, owner)} {word} ({net:+,})")
    return " · ".join(parts) + "." if parts else ""


def _settle_round(state: dict) -> str:
    """Settle every hand of the round against the dealer, each to the person who owns it.

    The table stays open: a finished round goes straight back to betting, with the cards
    left face up so the result can be read, until the person leaves the table.
    """
    hands = _migrate(state)
    dealer_total = _hand_value(state["dealer"])
    dealer_natural = _is_blackjack(state["dealer"])
    paid = [0, 0]
    net = [0, 0]
    results = []
    for hand in hands:
        owner = _owner(hand)
        wager = int(hand["wager"])
        if hand.get("result"):
            # Already settled and paid: a save that still reads phase "play" must never collect
            # this hand's chips twice. The result it carries is the one that was paid.
            results.append(str(hand["result"]))
            net[owner] += _hand_net(hand)
            hand["done"] = True
            continue
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
        paid[owner] += _payout(result, wager)
        net[owner] += _payout(result, wager) - wager
        results.append(result)
    # One change per person for the round: the chips left that person's stack when the bet
    # (and the split, and the double) was taken, so only what is owed back moves here. A
    # guest's winnings go back to the guest's table stack, never into the wallet. The
    # wallet's own count of finished hands moves on every round, lost or won.
    _credit(state, 0, paid[0])
    if paid[1]:
        _credit(state, 1, paid[1])
    state["phase"] = "bet"
    # One person left in the second seat: the felt, the outcome and the chips that
    # moved are theirs. Reading seat 0 here named an empty chair and a net of nothing.
    lone = _lone_owner(state)
    focus = lone if lone is not None else 0
    told = [str(hand.get("result") or "") for hand in hands if _owner(hand) == focus] or results
    state["outcome"] = _round_outcome(told)
    state["won"] = net[focus]
    state["hands"] = int(state.get("hands") or 0) + 1
    state["betting"] = 0
    state["round_bets"] = [0, 0]
    state["mid_round"] = False
    # A doubled or split round put more on the felt for that round only; the next bet starts
    # from what the person chose, not from the wagers it grew to. No hand is being played any
    # more, so the felt reads them from the first.
    base = state.pop("base_bet", None)
    state["active_hand"] = 0
    _sync(state)
    if base:
        state["bet"] = int(base)
    if _table_players(state) == 2:
        state["note"] = _two_player_note(state, hands)
        return state["note"]
    if focus == 1:
        mine = [hand for hand in hands if _owner(hand) == 1]
        state["note"] = _two_player_note(state, mine) or _round_note(told, net[1])
        return state["note"]
    state["note"] = _round_note(told, net[focus])
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
    held = _stack(state, _owner(hand)) if chips is None else chips
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
    # Four hands is one person's ceiling, not the table's: a guest splitting must never
    # cost the other person a split of their own.
    owner = _owner(hand)
    if len([item for item in _migrate(state) if _owner(item) == owner]) >= MAX_HANDS:
        return False
    held = _stack(state, owner) if chips is None else chips
    return held >= int(hand.get("wager") or 0)


def _split(state: dict) -> str:
    """Two cards of one rank become two hands, each with the first bet's wager on it."""
    hands = _migrate(state)
    index = _active(state)
    hand = hands[index]
    stake = int(hand["wager"])
    owner = _owner(hand)
    if not _stake(state, owner, stake):
        state["note"] = "Not enough chips to split."
        return state["note"]
    cards = list(hand["cards"])
    aces = cards[0][:-1] == cards[1][:-1] == "A"
    first = _make_hand(cards[:1], stake, from_split=True, split_aces=aces, player=owner)
    second = _make_hand(cards[1:], stake, from_split=True, split_aces=aces, player=owner)
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


def _own_hand_number(state: dict, hand: dict) -> tuple[int, int]:
    """This hand's number among its own person's hands, and how many that person holds.

    The felt numbers each person's hands from one, so a note must too: with two people at the
    table, Player 2's only hand was called "Hand 3 of 3" (or "Hand 5 of 5" after splits) because
    the numbering counted every hand on the table.
    """
    mine = [item for item in (_migrate(state) or []) if _owner(item) == _owner(hand)]
    number = next((index for index, item in enumerate(mine, start=1) if item is hand), 1)
    return number, len(mine)


def _advance(state: dict) -> str:
    """Play the next unfinished hand, or finish the round.

    The dealer plays only once every hand is done, and not at all when they all busted:
    there is nothing left to beat. A round of nothing but naturals has nothing for the
    dealer to beat either, so it settles without drawing a card.
    """
    hands = _migrate(state)
    for index, hand in enumerate(hands):
        if not hand.get("done"):
            state["active_hand"] = index
            _sync(state)
            if len(hands) > 1:
                whose = (f"{_player_name(state, _owner(hand))}, "
                         if _table_players(state) == 2 else "")
                number, count = _own_hand_number(state, hand)
                state["note"] = (f"{whose}Hand {number} of {count}: "
                                 f"{_hand_value(hand['cards'])}. Your move.")
            return ""
    if hands and all(_hand_value(hand["cards"]) > 21 for hand in hands):
        return _settle_round(state)
    if hands and all(_is_natural(hand) for hand in hands):
        return _settle_round(state)
    return _defer_or_play(state)


def _turn_line(state: dict) -> str:
    """The moves on offer, in words, so a note can never promise one the rules refuse."""
    offered = legal(state)
    hands = _migrate(state)
    # Two people on this screen: name the one whose move it is, so a note is never
    # addressed to the wrong person.
    who = "Your move"
    if _table_players(state) == 2 and hands:
        who = f"{_player_name(state, _owner(hands[_active(state)]))}'s move"
    if not offered:
        return "No moves are on offer."
    if len(offered) == 1:
        return f"{who}: {offered[0]}."
    return who + ": " + ", ".join(offered[:-1]) + f" or {offered[-1]}."


def _after_hand(state: dict, said: str) -> str:
    """One hand is finished: say so, then the next hand or the settled round."""
    settled = _advance(state)
    if settled:
        state["note"] = f"{said} {settled}".strip()
    elif said:
        state["note"] = f"{said} {state['note']}".strip()
    return state["note"]


def _repeat_bet(state: dict, seat: int) -> int:
    """What this seat bet last time. A double grew the felt, not the next bet."""
    if seat == 1:
        return int((_guest(state) or {}).get("last_bet") or 0)
    return int(state.get("bet") or 0)


def _dealer_seat(state: dict) -> str:
    """Who is dealing: the built-in computer, the person's Hermes model, or the house.

    The dealer's seat is the black side. ``local`` is the built-in player, ``agent`` is
    the person's own model, and anything else is the plain house: the rules deal and
    play out those cards themselves, with nobody to wait for.
    """
    kind = kit.seat_kind(str(state.get("black") or ""))
    return kind if kind in {"local", "agent"} else "house"


# The one line the felt reads next to its DEALER label. It names the dealer in every
# setup, including a table that has not seated a machine yet (the house), because a
# table that names nobody leaves a person unable to tell whether their own model is
# the one playing the dealer's cards.
_DEALER_LINES = {
    "local": "Dealer: Computer (instant)",
    # A model in the dealer's seat is named, and the line says what it really does: the house
    # rules are the whole of a dealer's play, so there is nothing for the model to decide and
    # nothing to wait for. "Thinks each turn" promised a turn that was never the model's.
    "agent": "Dealer: Hermes model (follows house rules, instant)",
    "house": "Dealer: Computer (house rules, instant)",
}


def _ai_dealer(state: dict) -> bool:
    """True when a machine is seated in the dealer's seat (the built-in one or a model)."""
    return _dealer_seat(state) in {"local", "agent"}


def legal(state: dict) -> list[str]:
    if state.get("status") != "active":
        return []
    if state.get("phase") == "bet":
        # The bet on offer is the one the person whose turn it is to bet can afford: the
        # wallet for seat 0, the guest's table stack for seat 1.
        owner = _betting_owner(state)
        held = _stack(state, owner)
        moves = [f"bet{amount}" for amount in _BETS if amount <= held]
        # Out of chips: one honest move that deals a fresh stack, instead of a table with no
        # legal move at all (which is how a player got stranded before).
        return moves or ["topup"]
    if state.get("phase") in {"deal", "dealer"}:
        return ["stand"]
    if state.get("phase") == "play":
        hand = _live_hand(state)
        if hand is not None and hand.get("done"):
            # A finished hand has no move left. A save that still reads "play" (a write cut
            # short) must not let a paid hand be played, or collected, a second time.
            return []
        held = _stack(state, _owner(hand)) if hand is not None else 0
        if hand is not None and hand.get("split_aces"):
            # A split ace has had its one card: it stands, unless a resplit is on offer.
            return ["stand"] + (["split"] if _can_split(state, hand, held) else [])
        moves = ["hit", "stand"]
        if hand is not None:
            # Double and split are offered by the rules, never guessed at by the felt, and
            # both need the chips for the extra wager before they are on offer.
            if _can_double(state, hand, held):
                moves.append("double")
            if _can_split(state, hand, held):
                moves.append("split")
        return moves
    return []


def _defer_or_play(state: dict) -> str:
    """Hand the dealer's cards out by the house rules, whoever is named in that seat.

    The dealer has no choices in blackjack: its play is the rules, not a decision. Asking a
    seated model for that turn cost two model calls a hand, delayed every hand behind the
    person's own request, and wrote a "Referee said no" badge for a seat the model was never
    offered a move in. So the dealer plays out inside the same request for every seat - the
    built-in computer, the person's model, and the plain house - and the felt names which
    one it was (`_DEALER_LINES`).
    """
    return _dealer_plays(state)


def _after_deal(state: dict) -> str | None:
    """The first look at a dealt round: a natural finishes a hand before anybody plays.

    One person at the table keeps the old rule: a natural (or a dealer natural) settles the
    hand at once. With two people the round can only settle at once when the dealer has a
    natural - otherwise each natural hand simply stands and the other person still plays.
    """
    hands = _migrate(state)
    if len(hands) <= 1:
        return _resolve_natural(state)
    if _is_blackjack(state["dealer"]):
        return _settle_round(state)
    for hand in hands:
        if _is_natural(hand):
            hand["done"] = True
    settled = _advance(state)
    return settled or None


def _start_round(state: dict, bets: list[int]) -> str:
    """Both bets are in: clear the felt, deal, and say whose move it is."""
    two = _table_players(state) == 2
    # A new hand clears the last one off the felt. The shoe carries over between
    # hands and is reshuffled once it runs low.
    if int(state.get("hands") or 0) and len(state.get("deck") or []) < 15:
        state["deck"] = []
    state["dealer"] = []
    state["outcome"] = ""
    state["won"] = 0
    if two:
        state["bet"] = int(bets[0])
        state["player_hands"] = [_make_hand([], int(bets[0]), player=0)]
        state["player_hands"].append(_make_hand([], int(bets[1]), player=1))
        guest = _guest(state)
        guest["last_bet"] = int(bets[1])
        state["base_bet"] = int(bets[0])
    else:
        owner = _lone_owner(state)
        if owner is None:
            owner = 0
        stake = int(bets[owner] if owner < len(bets) else 0)
        state["bet"] = stake
        state["player_hands"] = [_make_hand([], stake, player=owner)]
        state["base_bet"] = stake
    state["active_hand"] = 0
    # What the person chose is remembered for the whole round: a double or a split grows
    # the felt's wagers, and the next bet starts from this, not from them.
    state["betting"] = 0
    state["mid_round"] = True
    state["phase"] = "play"
    _deal(state)
    settled = _after_deal(state)
    if settled is not None:
        return settled
    # The deal check is the rules' own work: it is not a turn, and it never was.
    # A model dealer is handed the cards at the end of the round, once.
    if two:
        state["note"] = (f"Bets in: {_player_name(state, 0)} {int(bets[0]):,}, "
                         f"{_player_name(state, 1)} {int(bets[1]):,}. {_turn_line(state)}")
    else:
        state["note"] = f"Bet {int(bets[0])}. {_turn_line(state)}"
    return state["note"]


def _acting_owner(state: dict) -> int:
    """Which person's move is on the felt: the bet being waited for, or the hand being played."""
    if state.get("phase") == "play":
        hands = _migrate(state)
        return _owner(hands[_active(state)]) if hands else 0
    return _betting_owner(state)


def _sync_turn(state: dict) -> None:
    """The kit's turn follows the person whose move it is.

    White is the first seat, black the second. Blackjack's own turn is a hand - or a bet - and not
    a colour, so the seat is read from the move on offer. That is what lets the table refuse a
    move from the other person, and what makes an online seat's permissions follow the acting
    seat instead of a board game's white and black.
    """
    if _table_players(state) != 2 or kit.seat_kind(str(state.get("black") or "")) != "human":
        # One person at the table, or the local two-person screen where the second seat is the
        # machine's: the move stays on the human side, as it always did. The person who stayed
        # in the second seat is that human side now.
        state["turn"] = "black" if _lone_owner(state) == 1 else "white"
        return
    state["turn"] = "black" if _acting_owner(state) else "white"


def play(state: dict, move) -> str:
    """One move, then point the turn at the person whose move is next.

    Every return path of the rules goes through here, so the seat that may act is never stale.
    """
    note = _play(state, move)
    _sync_turn(state)
    return note


def _play(state: dict, move) -> str:
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
    # A settled hand is not playable, whatever the phase says: a save that still reads "play"
    # with a paid hand in it (a write cut short, a hand-edited file) is refused here too, before
    # any move can add a card or take chips for it.
    finished = _live_hand(state) if state.get("phase") == "play" else None
    if finished is not None and finished.get("done"):
        state["note"] = "That hand is finished. Place your next bet."
        return state["note"]
    # A move the table is not offering is refused here too, not only hidden in the UI:
    # after a hand is settled the phase goes back to betting, so a stray "double" must
    # never touch a finished hand's chips or stake.
    offered = legal(state)
    if offered and token not in offered:
        state["note"] = "That move is not on offer. " + ", ".join(offered) + "."
        return state["note"]
    if token == "topup":
        owner = _betting_owner(state)
        stacks = _stacks(state)
        if stacks is not None:
            # A lobby table: a fresh table stack, never a fresh wallet.
            stacks[1 if owner else 0] = TABLE_CHIPS
            state["note"] = (f"{_player_name(state, owner)} is out of chips. "
                             f"A fresh {TABLE_CHIPS:,} table chips.")
            return state["note"]
        if owner:
            guest = _guest(state)
            guest["chips"] = GUEST_CHIPS
            state["note"] = f"{guest['name']} is out of chips. A fresh {GUEST_CHIPS:,} table chips."
            return state["note"]
        given = _wallet().topup(min(_BETS))
        state["note"] = (
            f"Out of chips. A fresh {given:,} to play with." if given
            else "You still have chips to bet."
        )
        return state["note"]
    if token.startswith("bet"):
        amount = int(token[3:])
        owner = _betting_owner(state)
        two = _table_players(state) == 2
        if not _stake(state, owner, amount):
            state["note"] = "Not enough chips for that bet."
            return state["note"]
        if two:
            bets = _round_bets(state)
            bets[owner] = amount
            if owner == 0:
                # The first person's bet is taken, and the table waits for the second: the
                # deal needs both, so nothing is staked on cards nobody has been dealt.
                state["betting"] = 1
                state["mid_round"] = True
                state["bet"] = amount
                state["note"] = (f"{_player_name(state, 0)} bets {amount:,}. "
                                 f"{_player_name(state, 1)} to bet.")
                return state["note"]
            return _start_round(state, bets)
        bets = [0, 0]
        bets[owner] = amount
        return _start_round(state, bets)
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
        if _table_players(state) == 2:
            number, count = _own_hand_number(state, hand)
            state["note"] = (f"{_player_name(state, _owner(hand))}, Hand {number} of {count} "
                             f"draws: {total}.")
        elif len(state["player_hands"]) > 1:
            # One person at the table: the table's order is their own, so the phase's own
            # hand order numbers it.
            state["note"] = f"Hand {_active(state) + 1} draws: {total}."
        else:
            state["note"] = f"You drew a card. Your total is {total}."
        return state["note"]
    if token == "double":
        hand = _live_hand(state)
        if hand is None:
            state["note"] = "There is no hand to double."
            return state["note"]
        stake = int(hand["wager"])
        if not _stake(state, _owner(hand), stake):
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
    held = None if _table_chips(state) else _wallet().read()
    two = _table_players(state) == 2
    lines = [
        f"Dealer: {' '.join(dealer_cards) or '(no cards)'}",
        f"Dealer shows: {dealer_total}",
        f"Dealing: {_DEALER_LINES[_dealer_seat(state)].split(': ', 1)[-1]}",
        "",
    ]
    if two:
        # Two people at one table read their own hands by name, and their own stack.
        for owner in (0, 1):
            mine = [(number, hand) for number, hand in enumerate(hands, start=1)
                    if _owner(hand) == owner]
            lines.append(f"{_player_name(state, owner)} — chips {_stack(state, owner):,}")
            if not mine:
                lines.append("  no bet yet")
                continue
            for number, hand in mine:
                cards = " ".join(hand["cards"]) or "(no cards)"
                wager = f"bet {int(hand['wager']):,}" + (" (doubled)" if hand.get("doubled") else "")
                result = f", {hand['result']}" if hand.get("result") else ""
                current = " <-- playing" if playing and number - 1 == _active(state) else ""
                lines.append(f"  Hand {number}: {cards} = {_hand_value(hand['cards'])} "
                             f"({wager}{result}){current}")
        lines.append(f"Total bet: {sum(int(hand['wager']) for hand in hands):,} chips")
    elif len(hands) > 1:
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
    if not two:
        lines.append(f"Chips: {held['chips'] if held is not None else _stack(state, 0)}")
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


def _shown_hand(hand: dict, number: int, active: int, playing: bool, state: dict | None = None) -> dict:
    """One hand as the felt draws it: cards, total, what is staked, and how it went."""
    cards = list(hand.get("cards") or [])
    total = _hand_value(cards)
    owner = _owner(hand)
    return {
        "cards": cards,
        "total": total,
        "soft": _is_soft(cards),
        "wager": int(hand.get("wager") or 0),
        "original": int(hand.get("base") or hand.get("wager") or 0),
        "doubled": bool(hand.get("doubled")),
        "from_split": bool(hand.get("from_split")),
        # Which person at the table owns this hand, and what the felt calls them.
        "seat": owner,
        "name": _player_name(state, owner) if state is not None else "",
        "active": bool(playing and number == active),
        "done": bool(hand.get("done")),
        "bust": total > 21,
        # A split 21 is not a blackjack, so the felt never labels it one.
        "blackjack": _is_natural(hand),
        "result": str(hand.get("result") or ""),
    }


def _shown_players(state: dict, hands: list[dict], active: int, playing: bool) -> list[dict]:
    """One entry per person at the table: their name, their stack and their round.

    A single-player table answers with one entry too, so the felt reads the same shape in
    every setup; ``wallet`` says whose chips are the Jackpot wallet's.
    """
    phase = str(state.get("phase") or "bet")
    bets = _round_bets(state)
    current = _owner(hands[active]) if hands and 0 <= active < len(hands) else -1
    saying = []
    if _table_players(state) == 2:
        owners = (0, 1)
    else:
        lone = _lone_owner(state)
        owners = (lone if lone is not None else 0,)
    for owner in owners:
        mine = [hand for hand in hands if _owner(hand) == owner]
        results = [str(hand.get("result") or "") for hand in mine if hand.get("result")]
        net = sum(_hand_net(hand) for hand in mine)
        staked = sum(int(hand.get("wager") or 0) for hand in mine)
        saying.append({
            "seat": owner,
            "name": _player_name(state, owner),
            "chips": _stack(state, owner),
            # Whose chips are the Jackpot wallet's. A lobby table has no wallet: both seats
            # are the table's own stacks.
            "wallet": owner == 0 and not _table_chips(state),
            "bet": int(bets[owner]) or staked,
            "wager": staked,
            "net": net,
            "outcome": _round_outcome(results),
            "done": bool(mine) and all(bool(hand.get("done")) for hand in mine) and not playing,
            "active": bool(playing and current == owner),
            "betting": phase == "bet" and _betting_owner(state) == owner,
        })
    return saying


def _seat_of(state: dict, player) -> int | None:
    """Which seat the person looking holds, from their id. None for a watcher.

    A watcher has no seat: their picture is the public one, and the chips it shows are the
    first seat's rather than anybody's private stack being handed to them.
    """
    pid = getattr(player, "id", None) if player is not None else None
    if isinstance(player, dict):
        pid = player.get("id")
    pid = str(pid or "")
    if not pid:
        return None
    if str(state.get("white_id") or "") == pid:
        return 0
    if str(state.get("black_id") or "") == pid:
        return 1
    return None


def picture(state: dict, player=None) -> dict:
    # Who is looking decides which stack and which hand are theirs: online, seat 2's chips are
    # theirs and nobody else's. A picture with no player is the table's public view.
    seat = _seat_of(state, player)
    playing = state.get("phase") == "play"
    dealer = list(state.get("dealer") or [])
    if playing and len(dealer) > 1:
        dealer[1] = "??"
    visible = [card for card in dealer if card != "??"]
    hands = _migrate(state)
    active = _active(state) if hands else 0
    dealer_seat = _dealer_seat(state)
    return {
        "view": "blackjack",
        "phase": state.get("phase", "bet"),
        # Who is dealing, in one line for the felt next to its DEALER label, and in a word
        # for anything that wants to branch. Never blank: the plain house is a dealer too.
        "dealer_kind": dealer_seat,
        "dealer_line": _DEALER_LINES[dealer_seat],
        # A save written before the dealer stopped being asked for a turn can still read
        # phase "dealer": the next move hands those cards out at once. The note says what is
        # happening, never that a model is thinking.
        "dealer_note": ("The dealer is playing its cards out." if state.get("phase") == "dealer"
                        else ""),
        # The one hand on the felt, and every hand of the round: the first is what older
        # surfaces read, the second is what the felt draws when a hand was split.
        "hand": list(state.get("hand") or []),
        "dealer": dealer,
        "player_total": _hand_value(state.get("hand") or []),
        "dealer_total": _hand_value(visible) if visible else 0,
        "bet": int(state.get("bet") or 0),
        # The stack of whoever is looking, or the first seat's for a watcher.
        "chips": _stack(state, 0 if seat is None else seat),
        # Which seat the picture was drawn for: 0 or 1 for a person at this table, -1 for
        # somebody watching. Nothing else in the picture depends on it.
        "your_seat": -1 if seat is None else seat,
        "table_chips": _table_chips(state),
        "outcome": str(state.get("outcome") or ""),
        "won": int(state.get("won") or 0),
        "hands": int(state.get("hands") or 0),
        "player_hands": [_shown_hand(hand, number, active, playing, state)
                         for number, hand in enumerate(hands)],
        "active_hand": int(active),
        # The people at this table: one entry on a single-player table, two when a second
        # person sat down. Each carries their own stack, their own bet and their own round.
        "players": _shown_players(state, hands, active, playing),
        # What this table can seat (a second person, or not) and what it has seated now,
        # so the page offers the three ways in without naming any game itself.
        "two_players": True,
        "table_players": _table_players(state),
        "betting": _betting_owner(state),
        # Chips already staked in a round that has not been dealt: leaving is not free then.
        "mid_round": bool(state.get("mid_round")),
        "total_wager": sum(int(hand["wager"]) for hand in hands),
        "original_bet": int(state.get("base_bet") or (hands[0]["base"] if hands else 0) or 0),
        "bets": list(_BETS),
        # The bet the last hand used, so the next one can start on its own.
        "next_bet": (_repeat_bet(state, seat) if state.get("phase") == "bet"
                     and int(state.get("hands") or 0) and not state.get("mid_round")
                     and seat is not None else 0),
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
