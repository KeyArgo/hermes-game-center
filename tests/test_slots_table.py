"""Slots as a Game Center table: a bet ladder, chips spent, odds published."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from shelf.wallet import START_CHIPS, Wallet  # noqa: E402

spec = importlib.util.spec_from_file_location("slots_rules", ROOT / "slots/game.py")
game = importlib.util.module_from_spec(spec)
spec.loader.exec_module(game)

ME = SimpleNamespace(id="u1", name="Ada", platform="desktop", bot=False)


def start(tmp_path: Path) -> dict:
    game.use_wallet(tmp_path / "wallet.json")
    return {"turn": "white", "status": "active", "winner": "", "moves": [], "plies": 0, **game.fresh()}


def step(state: dict, move: str) -> str:
    assert move in game.legal(state), (move, game.legal(state))
    note = game.play(state, move)
    state["moves"].append(game.show(move))
    state["plies"] += 1
    return note


def chips(tmp_path: Path) -> int:
    return Wallet(tmp_path / "wallet.json").read()["chips"]


def test_a_fresh_table_offers_the_spin_at_once(tmp_path: Path) -> None:
    # The spin is never locked: the bet lives in the wallet, so a table nobody has
    # bet on yet still spins (at the wallet's bet). And a fresh table is active play.
    state = start(tmp_path)
    assert game.legal(state) == ["spin"] + [f"bet{n}" for n in (25, 50, 75, 100, 125, 150, 175, 200)]
    assert game.fresh()["status"] == "active", "never idle: a fresh table has started"


def test_two_spins_in_a_row_work_and_debit_twice(tmp_path: Path) -> None:
    state = start(tmp_path)
    before = chips(tmp_path)
    step(state, "spin")
    first = int(state["last_win"])
    step(state, "spin")  # no bet move in between: the second spin still spins
    second = int(state["last_win"])
    stake = Wallet(tmp_path / "wallet.json").read()["bet"]
    assert chips(tmp_path) == before - 2 * stake + first + second
    assert Wallet(tmp_path / "wallet.json").read()["spins"] == 2


def test_a_bet_moves_the_wallet_bet_too(tmp_path: Path) -> None:
    state = start(tmp_path)
    step(state, "bet50")
    assert state["bet"] == 50
    assert Wallet(tmp_path / "wallet.json").read()["bet"] == 50
    assert "spin" in game.legal(state)


def test_a_spin_costing_more_than_the_wallet_holds_is_not_offered(tmp_path: Path) -> None:
    wallet = Wallet(tmp_path / "wallet.json")
    wallet.set_bet(100)
    wallet.debit(START_CHIPS - 60)  # 60 chips, but the wallet's bet wants 100
    state = start(tmp_path)
    assert game.legal(state) == ["bet25", "bet50"]
    assert Wallet(tmp_path / "wallet.json").read()["chips"] == 60


def test_only_affordable_bets_are_offered(tmp_path: Path) -> None:
    state = start(tmp_path)
    Wallet(tmp_path / "wallet.json").debit(START_CHIPS - 60)
    assert game.legal(state) == ["spin", "bet25", "bet50"]


def test_every_spin_spends_the_bet_in_chips(tmp_path: Path) -> None:
    state = start(tmp_path)
    before = chips(tmp_path)
    step(state, "bet75")
    step(state, "spin")
    payout = int(state["last_win"])
    assert payout >= 0
    assert chips(tmp_path) == before - 75 + payout


def test_a_spin_never_ends_the_table(tmp_path: Path) -> None:
    state = start(tmp_path)
    for _ in range(30):
        step(state, "bet25")
        step(state, "spin")
        assert state["phase"] == "bet"
        assert game.legal(state), "there is always another bet to place"
        assert state["status"] == "active"


def _window(machine: str) -> tuple[float, float]:
    """The chance window this session drew for a machine: usual 50-55%, bonus to 60%, cold to 40%.

    Read it from ``slotplay.reels``, never from ``shelf.reels``: slotplay loads its own copy of the
    module under another name, so a plain ``import shelf.reels`` is a second session draw with a
    different seed (the trap test_bet_scaling.py already documents).
    """
    slotplay = importlib.import_module("shelf.slotplay")
    return slotplay.reels.chance_window(machine)


def test_the_picture_publishes_odds_and_no_pulls(tmp_path: Path) -> None:
    state = start(tmp_path)
    step(state, "bet25")
    step(state, "spin")
    pic = game.picture(state, player=ME)
    assert pic["view"] == "slots"
    assert pic["bet"] == 25 and pic["bets"][0] == 25 and len(pic["bets"]) == 8
    low, high = _window(pic["machine"])
    assert low <= pic["odds"]["win_chance"] <= high, pic["odds"]
    assert pic["odds"]["range"] == [low, high], pic["odds"]
    assert pic["odds"]["return"] > 1.0, pic["odds"]
    assert "pulls" not in pic and "earned" not in pic
    assert {m["id"] for m in pic["machines"]} == {"fruit9", "robot3"}
    assert pic["paytable"], "the scoring table is part of the picture"


def test_the_machine_pays_more_than_it_takes(tmp_path: Path) -> None:
    # The owner's rule: the machine should not bleed a player who keeps spinning.
    state = start(tmp_path)
    pic = game.picture(state, player=ME)
    # The owner's rule: the machine returns more than it takes, and the chance of winning
    # is drawn per session somewhere in 50-55% - never a number the house picked to suit it.
    assert round(pic["odds"]["return"], 2) >= 1.02
    # The draw is per session and may be a bonus (to 60%) or cold (to 40%) one; the window the
    # plugin publishes has to be the one this session actually drew, not the usual 50-55.
    low, high = _window(pic["machine"])
    assert low <= pic["odds"]["win_chance"] <= high, pic["odds"]
    assert pic["odds"]["range"] == [low, high], pic["odds"]
    assert "restart" in pic["odds"]["draws_when"]


def test_the_drawn_chance_is_stable_for_the_whole_session(tmp_path: Path) -> None:
    slotplay = importlib.import_module("shelf.slotplay")
    first = slotplay.odds("fruit9")
    for _ in range(20):
        assert slotplay.odds("fruit9") == first, "the drawn chance must not drift between spins"


def test_the_two_machines_draw_their_own_chance(tmp_path: Path) -> None:
    slotplay = importlib.import_module("shelf.slotplay")
    fruit = slotplay.odds("fruit9")
    robot = slotplay.odds("robot3")
    for machine, drawn in (("fruit9", fruit), ("robot3", robot)):
        low, high = _window(machine)
        assert low <= drawn["win_chance"] <= high, drawn
    # Independent draws: the same seed cannot give both machines the same number by design
    # unless it does by chance, so compare the targets the reels were tuned to.
    assert fruit["target"] != robot["target"]


def test_a_spin_from_the_sidebar_shows_on_the_table(tmp_path: Path) -> None:
    state = start(tmp_path)
    slotplay = importlib.import_module("shelf.slotplay")
    slotplay._load("hermes_gameshelf_wallet", ROOT / "shelf/wallet.py")
    row = slotplay.spin(Wallet(tmp_path / "wallet.json"), bet=25)
    pic = game.picture(state, player=ME)
    assert list(pic["reels"]) == list(row["reels"]), (pic["reels"], row["reels"])
    assert pic["last_win"] == row["payout"]


def test_is_listed_and_curated() -> None:
    manifest = json.loads((ROOT / "slots/game.json").read_text())
    assert manifest["id"] == "slots" and manifest["kind"] == "table"
    assert "slots" in json.loads((ROOT / "shelf/curated.json").read_text())["games"]


def test_a_broke_player_is_never_stranded(tmp_path: Path) -> None:
    state = start(tmp_path)
    Wallet(tmp_path / "wallet.json").debit(chips(tmp_path) - 5)
    assert game.legal(state) == ["topup"]
    step(state, "topup")
    assert chips(tmp_path) == START_CHIPS
    assert game.legal(state)

import importlib


def test_auto_spin_can_be_turned_on_and_off(tmp_path: Path) -> None:
    """The reply hook follows the switch, and the switch is remembered.

    The hook only spins while the machine is on screen; that visibility gate is what
    "no spinning while the slot is closed" means, and it is posted by the desktop.
    """
    slotplay = importlib.import_module("shelf.slotplay")
    from shelf.wallet import Wallet

    wallet = Wallet(tmp_path / "wallet.json")
    wallet.set_visible(True)
    wallet.set_bet(25)
    assert slotplay.autospin(wallet) is None, "auto-spin is off until someone turns it on"

    wallet.set_autoplay(True)
    spun = slotplay.autospin(wallet)
    assert spun is not None and spun["auto"] is True
    assert wallet.read()["chips"] <= 10_000 - 25 + int(spun["payout"])

    wallet.set_autoplay(False)
    assert slotplay.autospin(wallet) is None, "turning it off stops the next reply spinning"
    assert wallet.read()["autoplay"] is False


def test_auto_spin_never_fires_while_the_machine_is_closed(tmp_path: Path) -> None:
    slotplay = importlib.import_module("shelf.slotplay")
    from shelf.wallet import Wallet

    wallet = Wallet(tmp_path / "wallet.json")
    wallet.set_autoplay(True)
    wallet.set_visible(False)
    assert slotplay.autospin(wallet) is None
    wallet.set_visible(True)
    assert slotplay.autospin(wallet) is not None


def test_robot3_is_its_own_machine_not_a_reskin() -> None:
    slotplay = importlib.import_module("shelf.slotplay")
    robot = slotplay.MACHINES["robot3"]
    fruit = slotplay.MACHINES["fruit9"]
    # One row, one line, Greek faces on its own strips, its own colours.
    assert robot["rows"] == 1 and fruit["rows"] == 3
    assert len(robot["lines"]) == 1 and len(fruit["lines"]) == 5
    assert robot["theme"]["accent"] != fruit["theme"]["accent"]
    assert slotplay.reels.CADUCEUS in robot["strips"][0] and "🍒" not in robot["strips"][0]
    assert "🍋" not in " ".join(robot["strips"][0]), "no fruit on the robot reels"


def test_robot3_odds_are_its_own() -> None:
    slotplay = importlib.import_module("shelf.slotplay")
    drawn = slotplay.odds("robot3")
    low, high = _window("robot3")
    assert low <= drawn["win_chance"] <= high, drawn
    # Both machines give back a little more than they take: the owner's ask, 2026-11-09, so a
    # player is earning rather than losing the longer they play. It is a floor, not a target: since
    # 2026-11-10 the everyday pays carry the return and the jackpot only tops it up, which lifts the
    # measured figure slightly above the old 1.10. Asserting equal-to would fail as generosity rose.
    assert round(drawn["return"], 3) >= 1.10, drawn


def test_the_nous_and_wing_symbols_are_on_the_strips_and_pay() -> None:
    # The two picture tokens the desktop draws (assets/slots/nous.png, wing.png).
    slotplay = importlib.import_module("shelf.slotplay")
    reels = slotplay.reels
    fruit = reels.SPECS["fruit9"]
    assert fruit["jackpot"] == reels.NOUS
    for strip in fruit["strips"]:
        assert len(strip) == 20
        assert strip.count(reels.NOUS) == 1 and strip.count(reels.WING) == 1
    robot = reels.SPECS["robot3"]
    # The Nous stamp is the jackpot on both machines, not just the classic one (owner's ask,
    # 2026-11-10).
    assert robot["jackpot"] == reels.NOUS and fruit["jackpot"] == reels.NOUS
    for strip in robot["strips"]:
        assert len(strip) == 20
        assert strip.count(reels.NOUS) == 1 and strip.count(reels.WING) == 1
        assert strip.count(reels.CADUCEUS) == 1, "the caduceus replaces the temple"
    # The pays the session actually plays, and the target it still lands on. The everyday pays are
    # scaled by one factor each session to carry the machine's return, so their absolute values move
    # - asserting 300 or 420 here passes or fails depending on the process's session seed (found
    # 2026-11-10: this test read SEVEN as 342 in one run and 300 in the next). What must hold every
    # session is the ORDER the owner asked for, which a single multiplier cannot change.
    fruit_session = reels.variant("fruit9")
    fruit_pays = fruit_session["pays"]
    assert fruit_pays[reels.NOUS] == fruit_session["jackpot_pay"]
    assert fruit_pays[reels.NOUS] > fruit_pays[reels.WING] > fruit_pays[reels.BAR], fruit_pays
    assert fruit_session["return"] >= 1.10, fruit_session
    # The everyday pays alone must already pay back more than they take, so an ordinary session -
    # one that never hits the jackpot - still ends up ahead (owner, 2026-11-10: "im still losing
    # money and not making money"). This is the invariant that keeps the machine from being a
    # lottery ticket.
    spec = reels.SPECS["fruit9"]
    everyday = reels.measure("fruit9", fruit_session["blanks"], tuple(
        (symbol, 0 if symbol == spec["jackpot"] else pay)
        for symbol, pay in fruit_session["pays"].items()))
    # The everyday pays must stand on their own - except on a cold session (40% window), where they
    # may fall short and the jackpot carries the return instead. Either way the player is not bled:
    # the session's own return is held at >= 1.10.
    assert everyday["rtp"] > 1.0 or (reels.is_cold("fruit9") and fruit_session["return"] >= 1.10), everyday
    low, high = _window("fruit9")
    assert low <= fruit_session["hit"] <= high, fruit_session
    robot_session = reels.variant("robot3")
    pays = robot_session["pays"]
    # The order the owner asked for on 2026-11-10: Nous stamp, caduceus, wings, then the minor faces.
    assert pays[reels.NOUS] == robot_session["jackpot_pay"]
    assert pays[reels.NOUS] > pays[reels.CADUCEUS] > pays[reels.WING] > pays[reels.OWL], pays
    assert robot_session["return"] >= 1.10, robot_session
    robot_spec = reels.SPECS["robot3"]
    robot_everyday = reels.measure("robot3", robot_session["blanks"], tuple(
        (symbol, 0 if symbol == robot_spec["jackpot"] else pay)
        for symbol, pay in robot_session["pays"].items()))
    assert robot_everyday["rtp"] > 1.0 or (reels.is_cold("robot3") and robot_session["return"] >= 1.10), robot_everyday
    low, high = _window("robot3")
    assert low <= robot_session["hit"] <= high, robot_session
    # Both tokens are quoted on every paytable, as the tokens themselves.
    for machine_id, tokens in (("fruit9", ("NOUS", "WING")), ("robot3", ("NOUS", "WING"))):
        symbols = " ".join(row["symbol"] for row in slotplay.paytable(machine_id))
        for token in tokens:
            assert token in symbols, (machine_id, symbols)


def test_a_slots_picture_after_choosing_robot3_shows_robot3(tmp_path: Path) -> None:
    # The wallet's machine choice is what the table plays; read shelf/wallet.py.
    slotplay = importlib.import_module("shelf.slotplay")
    Wallet(tmp_path / "wallet.json").set_machine("robot3")
    state = start(tmp_path)
    step(state, "bet25")
    step(state, "spin")
    pic = game.picture(state, player=ME)
    assert pic["machine"] == "robot3", pic["machine"]
    assert pic["machine"] in slotplay.MACHINES
    assert {item["id"] for item in pic["machines"]} == {"fruit9", "robot3"}
    assert pic["machines"][0]["rows"] == 1 or any(item["rows"] == 1 for item in pic["machines"])
    assert len(pic["grid"]) == 1, pic["grid"]
    symbols = " ".join(row["symbol"] for row in pic["paytable"])
    assert "⚕️" in symbols, symbols
    assert "🍋" not in symbols, symbols


def test_every_machine_publishes_a_blank_face_outside_its_pays(tmp_path: Path) -> None:
    slotplay = importlib.import_module("shelf.slotplay")
    Wallet(tmp_path / "wallet.json")
    for machine_id, info in slotplay.MACHINES.items():
        face = info["blank_face"]
        assert face, machine_id
        pays = slotplay.paytable(machine_id)
        assert any(row["payout"] == 0 for row in pays), (machine_id, pays)
        assert face not in slotplay.reels.SPECS[machine_id]["pays"], machine_id


def test_the_overchat_look_is_remembered_and_out_of_range_values_refused(tmp_path: Path) -> None:
    """A reload must not reset the see-through machine's opacity or size."""
    from shelf.wallet import Wallet, wallet_path

    wallet = Wallet(wallet_path(tmp_path))
    held = wallet.set_overchat(alpha=0.35, scale=0.6)
    assert held["overchat_alpha"] == 0.35 and held["overchat_scale"] == 0.6
    held = wallet.set_overchat(alpha=9, scale=0.01)
    assert held["overchat_alpha"] == 0.35, "out of range is refused, not stored"
    assert held["overchat_scale"] == 0.6
    again = Wallet(wallet_path(tmp_path)).read()
    assert again["overchat_alpha"] == 0.35 and again["overchat_scale"] == 0.6, "the file holds them"


def test_the_overchat_copy_alone_earns_a_spin_per_reply(tmp_path: Path) -> None:
    """Owner's note 2026-11-09: with the machine over the chat they hear it spin while playing
    Sea Battle - the Slots table does not have to be open. Visibility is all auto-spin needs."""
    import importlib

    play = importlib.import_module("shelf.slotplay")
    from shelf.wallet import Wallet, wallet_path

    wallet = Wallet(wallet_path(tmp_path))
    wallet.set_autoplay(True)
    wallet.set_visible(True)  # what the over-chat copy reports while it is drawn
    first = play.autospin(wallet)
    assert first is not None, "a reply spins the machine when the copy is on screen"
    assert first["auto"] is True
    wallet.set_visible(False)
    assert play.autospin(wallet) is None, "nothing spins once the copy is off screen"
