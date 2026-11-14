"""Blackjack as a Game Center table: one hand per game, chips from the Jackpot wallet.

Contract (blackjack/game.py):
- Cards are strings: rank A 2..10 J Q K plus suit S H D C, e.g. "AS", "10H", "QD".
- state["deck"] is drawn with deck.pop() (from the end). A bet on a state whose deck is
  already filled uses that deck, so tests can stack it; otherwise the bet shuffles a fresh deck.
- Moves are single words: bet10 bet25 bet50 bet100 bet500 bet1000, then hit stand double (double on two cards only).
- Deal order after a bet: player, dealer, player, dealer.
- Dealer stands on all 17s. Blackjack pays 3:2, a win pays 1:1, a push returns the bet.
- The table never ends on its own: a finished hand sets state["outcome"] (win, blackjack, push,
  lose, bust) and state["won"] (net chips), and goes straight back to phase "bet" with
  status still "active", until the person leaves the table.
- use_wallet(path) points the rules at a wallet file; create(root) uses root.parent / "wallet.json".
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from shelf.wallet import START_CHIPS, Wallet  # noqa: E402

spec = importlib.util.spec_from_file_location("blackjack_rules", ROOT / "blackjack/game.py")
game = importlib.util.module_from_spec(spec)
spec.loader.exec_module(game)

ME = SimpleNamespace(id="u1", name="Ada", platform="desktop", bot=False)


def start(tmp_path: Path, deck: list[str] | None = None) -> dict:
    game.use_wallet(tmp_path / "wallet.json")
    state = {"turn": "white", "status": "active", "winner": "", "moves": [], "plies": 0, **game.fresh()}
    if deck is not None:
        # Deal order is player, dealer, player, dealer, then hits; pop() takes from the end.
        state["deck"] = list(reversed(deck))
    return state


def step(state: dict, move: str) -> str:
    assert move in game.legal(state), (move, game.legal(state))
    note = game.play(state, move)
    state["moves"].append(game.show(move))
    state["plies"] += 1
    return note


def chips(tmp_path: Path) -> int:
    return Wallet(tmp_path / "wallet.json").read()["chips"]


def test_grammar() -> None:
    for text in ("bet10", "bet25", "bet50", "bet100", "bet500", "bet1000", "hit", "stand", "double"):
        assert game.show(game.parse([text])) == text
    assert game.parse(["bet", "25"]) == "bet25"
    for bad in (["bet7"], ["bet", "x"], ["fold"], [], ["hit", "now"]):
        assert game.parse(bad) is None


def test_betting_phase_only_offers_affordable_bets(tmp_path: Path) -> None:
    state = start(tmp_path)
    assert game.legal(state) == ["bet10", "bet25", "bet50", "bet100", "bet500", "bet1000"]
    Wallet(tmp_path / "wallet.json").debit(START_CHIPS - 30)
    assert game.legal(state) == ["bet10", "bet25"]


def test_win_pays_even_money(tmp_path: Path) -> None:
    # You 10+9 = 19, dealer 10+7 = 17 stands.
    state = start(tmp_path, ["10S", "10H", "9S", "7H"])
    step(state, "bet10")
    assert chips(tmp_path) == START_CHIPS - 10
    assert set(game.legal(state)) >= {"hit", "stand"}
    step(state, "stand")
    assert (state["outcome"], state["won"]) == ("win", 10)
    assert chips(tmp_path) == START_CHIPS + 10


def test_bust_loses_the_bet(tmp_path: Path) -> None:
    state = start(tmp_path, ["10S", "10H", "6S", "7H", "KD"])
    step(state, "bet25")
    step(state, "hit")
    assert (state["outcome"], state["won"]) == ("bust", -25)
    assert chips(tmp_path) == START_CHIPS - 25
    assert state["status"] == "active" and state["phase"] == "bet"
    assert "bet10" in game.legal(state) and "hit" not in game.legal(state)


def test_blackjack_pays_three_to_two(tmp_path: Path) -> None:
    state = start(tmp_path, ["AS", "9H", "KS", "7H"])
    step(state, "bet10")
    assert (state["outcome"], state["won"]) == ("blackjack", 15)
    assert chips(tmp_path) == START_CHIPS + 15


def test_blackjack_rounds_the_half_chip_up(tmp_path: Path) -> None:
    # 3:2 on an odd stake is a half chip. Integer chips cannot pay it, and 25 is a real bet
    # size, so the table rounds up rather than pocketing the difference.
    state = start(tmp_path, ["AS", "9H", "KS", "7H"])
    step(state, "bet25")
    assert (state["outcome"], state["won"]) == ("blackjack", 38), state["won"]
    assert chips(tmp_path) == START_CHIPS + 38


def test_push_returns_the_bet(tmp_path: Path) -> None:
    state = start(tmp_path, ["10S", "10H", "8S", "8H"])
    step(state, "bet50")
    step(state, "stand")
    assert (state["outcome"], state["won"]) == ("push", 0)
    assert chips(tmp_path) == START_CHIPS


def test_dealer_draws_to_seventeen_and_can_bust(tmp_path: Path) -> None:
    # Dealer 10+6 = 16 must hit, draws K and busts.
    state = start(tmp_path, ["10S", "10H", "8S", "6H", "KD"])
    step(state, "bet10")
    step(state, "stand")
    assert state["outcome"] == "win"
    assert chips(tmp_path) == START_CHIPS + 10


def test_double_takes_one_card_and_doubles_the_stake(tmp_path: Path) -> None:
    # You 6+5 = 11, double draws a 10 for 21; dealer 10+7 = 17.
    state = start(tmp_path, ["6S", "10H", "5S", "7H", "10D"])
    step(state, "bet25")
    step(state, "double")
    assert (state["outcome"], state["won"]) == ("win", 50)
    assert chips(tmp_path) == START_CHIPS + 50


def test_double_needs_the_chips(tmp_path: Path) -> None:
    state = start(tmp_path, ["6S", "10H", "5S", "7H", "10D"])
    Wallet(tmp_path / "wallet.json").debit(START_CHIPS - 100)
    step(state, "bet100")
    assert "double" not in game.legal(state)


def test_aces_count_soft(tmp_path: Path) -> None:
    # A+5 = soft 16, hit 10 → 16 hard, not bust.
    state = start(tmp_path, ["AS", "10H", "5S", "7H", "10D"])
    step(state, "bet10")
    step(state, "hit")
    assert state["phase"] == "play"


def test_picture_hides_the_hole_card_until_the_hand_ends(tmp_path: Path) -> None:
    state = start(tmp_path, ["10S", "QH", "9S", "7H"])
    step(state, "bet10")
    pic = game.picture(state, player=ME)
    assert pic["view"] == "blackjack"
    assert pic["hand"] == ["10S", "9S"] and pic["player_total"] == 19
    assert pic["dealer"][0] == "QH" and pic["dealer"][1] == "??"
    assert "7H" not in json.dumps(pic)
    assert pic["chips"] == START_CHIPS - 10 and pic["bet"] == 10
    assert set(pic["legal"]) >= {"hit", "stand"}
    step(state, "stand")
    pic = game.picture(state, player=ME)
    assert pic["dealer"] == ["QH", "7H"] and pic["dealer_total"] == 17 and pic["phase"] == "bet"
    assert pic["outcome"] in {"win", "blackjack", "push", "lose", "bust"}


def test_bot_always_has_a_legal_move(tmp_path: Path) -> None:
    state = start(tmp_path)
    for _ in range(300):
        step(state, game.bot(state))
    assert state["status"] == "active" and state["hands"] >= 30


def test_keeps_playing_hand_after_hand(tmp_path: Path) -> None:
    state = start(tmp_path, ["10S", "10H", "9S", "7H"])
    step(state, "bet10")
    step(state, "stand")
    pic = game.picture(state, player=ME)
    assert pic["phase"] == "bet" and pic["outcome"] == "win" and pic["won"] == 10
    assert pic["hand"] == ["10S", "9S"] and pic["dealer"] == ["10H", "7H"]
    # The next hand's cards are fixed too: a random natural would settle at once.
    state["deck"] = ["2C"] * 12 + list(reversed(["5S", "6H", "9S", "7H"]))  # 15+ cards, or the shoe is reshuffled
    step(state, "bet25")
    assert len(state["hand"]) == 2 and state["outcome"] == "" and state["hands"] == 1


def test_plays_through_game_center(tmp_path: Path) -> None:
    table = game.create(tmp_path / "blackjack")
    table.command("new", player=ME)
    answer = table.command("move bet10", player=ME)
    assert "Refused" not in answer and "Could not read" not in answer, answer
    assert Wallet(tmp_path / "wallet.json").read()["chips"] in range(START_CHIPS - 10, START_CHIPS + 16)
    pic = table.picture(player=ME)
    assert pic["view"] == "blackjack"


def test_the_table_controls_seat_the_computer_and_the_model(tmp_path: Path) -> None:
    """The two controls the page offers are lines the table really accepts.

    Blackjack gets the same "New game vs computer" and "Play my Hermes model" controls the
    board games have. They are the same two lines every table
    takes - ``allow-ai blackjack black=local`` and ``allow-ai blackjack black=agent`` -
    with the dealer's seat as the seat they fill. A session already on the felt has to be
    ended first, which is why the page sends ``abandon`` before a new deal.
    """
    table = game.create(tmp_path / "blackjack")
    # Nothing staked yet: one line seats the built-in dealer at the level asked for.
    answer = table.command("allow-ai black=local level=intermediate", player=ME)
    assert "Dealer (D): Local" in answer, answer
    seats = {seat["side"]: seat for seat in table.picture(player=ME)["seats"]}
    assert seats["black"]["kind"] == "local" and seats["black"]["name"] == "Local"
    assert seats["white"]["kind"] == "human", "the person keeps their own seat"

    # A hand on the felt: the table refuses a new setup, so the page ends it first.
    table.command("move bet10", player=ME)
    assert json.loads((tmp_path / "blackjack" / "state.json").read_text())["plies"] >= 1
    assert "in progress" in table.command("allow-ai black=local level=beginner", player=ME)
    assert table.command("abandon", player=ME).startswith("Game abandoned")

    # Then the person's own model takes the dealer's seat, and really plays it.
    asked: list[str] = []

    def complete(prompt: str) -> dict:
        asked.append(prompt)
        return {"move": "stand"}

    answer = table.command("allow-ai black=agent", complete=complete, player=ME)
    seats = {seat["side"]: seat for seat in table.picture(player=ME)["seats"]}
    assert seats["black"]["kind"] == "agent" and seats["black"]["name"] == "Your agent", answer
    # A fixed deal: a natural settles the hand before the dealer is asked, so a
    # random shoe made this check fail roughly one run in ten.
    state_path = tmp_path / "blackjack" / "state.json"
    state = json.loads(state_path.read_text())
    state["deck"] = list(reversed(["10S", "10H", "9S", "7H"]))  # deal order: player, dealer, player, dealer
    state_path.write_text(json.dumps(state))
    table.command("move bet10", complete=complete, player=ME)
    assert asked, "the model seated as the dealer was never asked to play"
    assert table.picture(player=ME)["legal"], "the table is still playable after the dealer's turn"


def test_table_never_runs_out_of_bets(tmp_path: Path) -> None:
    # A hand is two or three plies, so the generic MAX_PLIES ceiling used to end the
    # session as a "draw" after five hands and drop every bet chip. Betting must stay
    # available however long the person sits at the table.
    state = start(tmp_path)
    step(state, "bet10")
    for _ in range(60):
        if state.get("phase") == "play":
            step(state, "stand")
        assert state["status"] == "active", state["status"]
        assert state["phase"] == "bet", state["phase"]
        pic = game.picture(state, player=ME)
        assert "bet10" in pic["legal"], pic["legal"]
        step(state, "bet10")
    assert state["status"] == "active" and state["hands"] >= 60


def test_push_leaves_the_bets_on_the_felt(tmp_path: Path) -> None:
    state = start(tmp_path, ["10S", "10H", "8S", "8H"])
    step(state, "bet50")
    step(state, "stand")
    assert (state["outcome"], state["won"]) == ("push", 0)
    state["deck"] = ["2C"] * 12 + list(reversed(["5S", "6H", "9S", "7H"]))  # 15+ cards, or the shoe is reshuffled
    step(state, "bet25")
    assert state["phase"] == "play" and state["bet"] == 25


def test_is_listed_and_curated() -> None:
    manifest = json.loads((ROOT / "blackjack/game.json").read_text())
    assert manifest["id"] == "blackjack" and manifest["kind"] == "table"
    assert "blackjack" in json.loads((ROOT / "shelf/curated.json").read_text())["games"]


def test_a_broke_player_is_never_stranded(tmp_path: Path) -> None:
    # The old table offered no bet it could afford and stayed "active" with legal() == [],
    # so the only way out was leaving the game. Now there is always one honest move.
    state = start(tmp_path)
    Wallet(tmp_path / "wallet.json").debit(chips(tmp_path) - 5)
    assert chips(tmp_path) == 5
    assert game.legal(state) == ["topup"]
    step(state, "topup")
    assert chips(tmp_path) == START_CHIPS
    assert game.legal(state)  # a real bet again
    assert any(word.startswith("bet") for word in game.legal(state))
