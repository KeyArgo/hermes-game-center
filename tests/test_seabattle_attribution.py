"""Who fired is read from the shots, not guessed from the order of the log.

A turn's own shot and the computer's answer arrive in the same request, so the newest
shot is always the computer's. Guessing the shooter by parity made the person's own kill
read as the computer's — they saw "your destroyer went down" but never "you sank their
destroyer" — and this pins the attribution to the shot records themselves.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def load():
    spec = importlib.util.spec_from_file_location("seabattle_attribution", REPO / "seabattle" / "game.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def state_with(sb, *, white_shots, black_shots, sunk_by_white):
    state = {"turn": "white", "status": "active", "winner": "", "moves": [], "plies": 0, **sb.fresh()}
    state["white"] = "human"
    state["black"] = "human"
    state["phase"] = "fire"
    state["fleets"] = {"white": sb.duplicate_fleet("white"), "black": sb.duplicate_fleet("black")}
    state["shots"] = {
        "white": [list(sb._square(s)) for s in white_shots],
        "black": [list(sb._square(s)) for s in black_shots],
    }
    state["moves"] = [f"fire {s}" for s in sorted(set(white_shots) | set(black_shots))]
    return state


def test_a_kill_the_person_made_is_credited_to_the_person(sb=None):
    sb = load()
    # Black's destroyer sits at a1/a2 in the duplicate pattern; white sank it, and black's
    # reply (a miss) came back in the same request and sits last in the log.
    targets = [sb._name(p) for ship in sb.duplicate_fleet("black") if ship["name"] == "destroyer" for p in ship["cells"]]
    white_shots = targets
    black_shots = ["j10"]
    state = state_with(sb, white_shots=white_shots, black_shots=black_shots, sunk_by_white=True)

    view = sb.picture(state, player="white")
    by_side = {(shot["side"], shot["square"]): shot for shot in view["last_shots"]}
    killed = [shot for shot in view["last_shots"] if shot["result"] == "sunk"]

    assert killed, f"the sinking must be reported: {view['last_shots']}"
    assert all(shot["side"] == "white" for shot in killed), (
        "the person's kill must be credited to the person, not to the computer: "
        f"{view['last_shots']}")
    assert any(shot["ship"] == "destroyer" for shot in killed)


def test_a_kill_the_computer_made_is_credited_to_the_computer():
    sb = load()
    targets = [sb._name(p) for ship in sb.duplicate_fleet("white") if ship["name"] == "destroyer" for p in ship["cells"]]
    state = state_with(sb, white_shots=["j10"], black_shots=targets, sunk_by_white=False)

    view = sb.picture(state, player="white")
    killed = [shot for shot in view["last_shots"] if shot["result"] == "sunk"]

    assert killed, view["last_shots"]
    assert all(shot["side"] == "black" for shot in killed), view["last_shots"]


def test_a_shot_is_credited_to_who_fired_it_even_on_a_square_both_sides_used() -> None:
    """The enemy's attack must never be drawn on ENEMY WATERS.

    Both seats can fire at the same square - the player misses, the computer answers on the same
    coordinate. Testing membership in the shot sets then credits the wrong seat, and the marker the
    person sees is their own attack where the enemy's belongs.
    """
    sb = load()
    state = state_with(sb, white_shots=["a1"], black_shots=["a2"], sunk_by_white=False)
    state["turn"] = "white"
    assert sb.play(state, ("fire", "e5"))
    state["phase"] = "fire"
    state["turn"] = "black"
    assert sb.play(state, ("fire", "e5"))

    assert state["shot_log"][-1] == {"side": "black", "square": "e5"}, state["shot_log"]
    picture = sb.picture(state, player={"id": ""})
    assert picture["last_shot"]["side"] == "black", picture["last_shot"]
    assert picture["last_shots"][-1]["side"] == "black"
    # Their shot is on the person's own water, and the person's own shot is on theirs - the newest
    # is the enemy's, so the lettering and the marker belong on YOUR WATERS.
    assert picture["own_cells"][5][4] == "M", picture["own_cells"]
    assert picture["your_side"] == "white", picture["your_side"]
    assert picture["last_shot"]["side"] != picture["your_side"], "the newest shot is theirs, not mine"


def test_the_sets_alone_would_credit_the_wrong_seat_which_is_why_there_is_a_log() -> None:
    """Pins the bug the log exists for: with no log, the same square credits white."""
    sb = load()
    state = state_with(sb, white_shots=["e5"], black_shots=["e5"], sunk_by_white=False)
    state.pop("shot_log", None)
    state["moves"] = ["fire e5", "fire e5"]
    picture = sb.picture(state, player={"id": ""})
    assert picture["last_shots"][-1]["side"] == "white", "the sets alone cannot tell who fired last"

    state["shot_log"] = [{"side": "white", "square": "e5"}, {"side": "black", "square": "e5"}]
    picture = sb.picture(state, player={"id": ""})
    assert picture["last_shots"][-1]["side"] == "black", "the log can"


def test_against_a_machine_the_person_stays_the_same_side_all_game() -> None:
    """Playing Hermes, the boards must not swap when the machine takes its turn.

    The viewer's seat used to be read as "whoever's turn it is" whenever one seat was unbound,
    which is right for pass-the-screen and wrong against an agent: on the machine's ply the person
    became black, so their own hits were drawn on ENEMY WATERS and their water showed the machine's
    marks, and nothing on either board looked like it had landed.
    """
    sb = load()
    state = state_with(sb, white_shots=[], black_shots=[], sunk_by_white=False)
    state["white"] = "human"
    state["black"] = "agent"
    state["turn"] = "white"

    mine = sb.picture(state, player={"id": ""})
    assert mine["your_side"] == "white", mine["your_side"]

    sb.play(state, ("fire", "a1"))
    machine = sb.picture(state, player={"id": ""})
    assert machine["your_side"] == "white", "the machine's ply must not make the person black"
    assert machine["enemy_cells"][9][0] in ("M", "H"), "my shot shows on their water"
    assert machine["own_cells"][9][0] != "M", "and their fire is not drawn on my water as mine"


def test_pass_the_screen_still_follows_the_turn() -> None:
    """Two humans on one keyboard: the board belongs to whoever is to move."""
    sb = load()
    state = state_with(sb, white_shots=[], black_shots=[], sunk_by_white=False)
    state["white"] = "human"
    state["black"] = "human"
    state["turn"] = "white"
    assert sb.picture(state, player={"id": ""})["your_side"] == "white"
    state["turn"] = "black"
    assert sb.picture(state, player={"id": ""})["your_side"] == "black"
