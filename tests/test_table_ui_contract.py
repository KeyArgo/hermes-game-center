"""Exercise the shipped plain-JS UI with a dependency-free Node hook harness,
and the two backend contracts that UI depends on: what the page is told it may
offer, and which system message a model request gets."""
import importlib.util
import subprocess
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def test_table_ui_runtime():
    result = subprocess.run(
        ["node", str(ROOT / "tests" / "table_ui_harness.cjs")],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _table(game_id: str, root: Path):
    module = _load(f"ui_contract_{game_id}", ROOT / game_id / "game.py")
    return module.create(root / game_id)


ME = SimpleNamespace(id="u1", name="Ada", platform="desktop", bot=False)


class Model:
    """A Hermes model stub that records every request it is sent."""

    def __init__(self, calls):
        self.calls = calls

    def complete(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(text="It builds toward the middle.", usage={"total_tokens": 4})


def test_a_hint_asks_for_a_sentence_and_an_agent_move_asks_for_a_move(tmp_path):
    """kit.py sends both requests through one complete(); each needs its own system message.

    A move has to come back as a bare move. A hint's explanation has to come back
    as a sentence, so telling the model "one legal move" there breaks the hint.
    """
    plugin = _load("ui_contract_plugin", ROOT / "__init__.py")
    prompts = {}

    def capture(which, answer):
        def complete(prompt):
            prompts[which] = prompt
            return answer
        return complete

    hint_table = _table("connect4", tmp_path)
    hint_table.command("allow-ai black=local", player=ME)
    said = hint_table.command("hint", complete=capture("hint", {"move": "It builds toward the middle.", "tokens": 4}),
                              player=ME)
    assert "It builds toward the middle." in said

    agent_table = _table("checkers", tmp_path)
    agent_table.command("allow-ai white=agent black=human", complete=capture("move", {"move": ""}), player=ME)

    calls = []
    complete = plugin._complete(SimpleNamespace(llm=Model(calls)), None)

    complete(prompts["hint"])
    system = calls[-1]["messages"][0]["content"]
    assert "short, plain sentence" in system, system
    assert "one legal move" not in system, system
    assert 0 < calls[-1]["max_tokens"] <= 80, "an explanation needs only a sentence or two of room"

    complete(prompts["move"])
    move_system = calls[-1]["messages"][0]["content"]
    assert "one move" in move_system, move_system
    assert "short, plain sentence" not in move_system, move_system
    assert 0 < calls[-1]["max_tokens"] <= 80


def _load_api():
    if "fastapi" not in sys.modules:
        fake = ModuleType("fastapi")

        class APIRouter:
            def get(self, _path):
                return lambda handler: handler

            post = get

        fake.APIRouter = APIRouter
        sys.modules["fastapi"] = fake
    return _load("ui_contract_api", ROOT / "dashboard" / "plugin_api.py")


def test_dashboard_backend_uses_the_same_two_system_messages():
    api = _load_api()
    calls = []
    api._plugin_llm = lambda: Model(calls)
    complete = api._complete()
    complete("Board:\nExample\n\nIn one short sentence (under 25 words), say why it is a good idea.")
    assert "sentence" in calls[-1]["messages"][0]["content"]
    complete("Board:\nExample\n\nReply with exactly one legal move from that list and nothing else.")
    assert "one move" in calls[-1]["messages"][0]["content"]


def _finished(seats, status="win"):
    return {"status": status, "turn": "white", "winner": "white", "owner_id": "alice", "seats": seats}


def test_review_is_offered_to_the_one_person_who_played():
    api = _load_api()
    solo = [
        {"side": "white", "kind": "human", "id": "alice", "open": False},
        {"side": "black", "kind": "local", "id": "local", "open": False},
    ]
    assert api._permissions(_finished(solo), SimpleNamespace(id="alice", platform="desktop"),
                            allow_ai=True)["can_review"]
    assert not api._permissions(_finished(solo), SimpleNamespace(id="eve", platform="discord"),
                                allow_ai=True)["can_review"], "a spectator cannot review someone else's game"

    two_people = [
        {"side": "white", "kind": "human", "id": "alice", "open": False},
        {"side": "black", "kind": "human", "id": "bob", "open": False},
    ]
    assert not api._permissions(_finished(two_people), SimpleNamespace(id="alice", platform="desktop"),
                                allow_ai=True)["can_review"], "never a review for two people"

    assert not api._permissions(_finished(solo, status="active"), SimpleNamespace(id="alice", platform="desktop"),
                                allow_ai=True)["can_review"], "only after the game is over"
    assert not api._permissions(_finished(solo, status="lesson_done"), SimpleNamespace(id="alice", platform="desktop"),
                                allow_ai=True)["can_review"], "a review is not offered twice"


def test_board_marks_a_review_lesson_so_the_page_can_word_it_plainly(tmp_path, monkeypatch):
    api = _load_api()

    class Catalog:
        settings = {"allow_ai": True}

        def __init__(self, lesson):
            self.lesson = lesson

        def has(self, game):
            return True

        def kind(self, game):
            return "table"

        def picture(self, game):
            return {"status": "lesson_done", "view": game, "seats": [
                {"side": "white", "kind": "human", "id": "local", "open": False},
                {"side": "black", "kind": "local", "id": "local", "open": False}], "lesson": self.lesson}

        def _needs_install(self, game):
            return False

    def picture_with(lesson):
        monkeypatch.setattr(api, "_open", lambda: (Catalog(lesson), api.NameBook(tmp_path / "names.json")))
        monkeypatch.setattr(api, "_say", lambda line: "board")
        return api.board("connect4")["picture"]

    assert picture_with({"step": 1, "of": 1, "say": "You had a winning move.",
                         "custom": {"say": "You had a winning move."}})["review"] is True
    assert picture_with({"step": 2, "of": 5, "say": "A scripted lesson."})["review"] is False
    assert picture_with(None)["review"] is False


def test_the_board_can_never_draw_over_the_header():
    """The board keeps its own height, so opening More options cannot push it over Back.

    With ``flex: 1 1 auto`` and ``minHeight: 0`` the hero box shrank while the
    SVG kept its height: the board floated over the header and a real press on
    Back landed on the board (reproduced with elementFromPoint in
    tests/test_browser_click_play.py). The hero is not a flexible row any more.
    """
    for name in ("30-game-page.js", "45-arena.js"):
        source = (ROOT / "desktop" / "src" / name).read_text(encoding="utf-8")
        hero = [line for line in source.splitlines() if "games-board-hero" in line]
        assert hero, f"{name} has no board hero"
        for line in hero:
            following = source.split(line, 1)[1][:400]
            style = following.split("style:", 1)[1].split("}", 1)[0] if "style:" in following else ""
            assert "'1 1 auto'" not in style, f"{name}: the board hero is flexible again: {line.strip()}"
            assert "'0 0 auto'" in style, f"{name}: the board hero does not keep its height: {line.strip()}"


def _src(name: str) -> str:
    return (ROOT / "desktop" / "src" / name).read_text(encoding="utf-8")


def test_the_main_page_has_one_invite_switch_and_says_when_the_lobby_is_down():
    """Play with people carries its own ON/OFF switch, and "not connected" is not "off".

    A socket that never came up drew an empty accept list, and the card said "Online
    invites are off" - so a person turned the switch on, the press was refused, and both
    screens blamed their own setting. The switch is drawn from the Hall's state now, and a
    Hall that is not live says so with the one control that fixes it.
    """
    home = _src("70-home.js")
    assert "'Let people invite me'" in home, "the master switch is on the main page"
    assert "data-people-open" in home, "and it carries its own state for the page and the tests"
    # The reason a held switch is held is a sentence beside it, not a hover title: a dead box
    # with the reason on hover reads as simply dead (owner, 2026-11-18).
    assert "data-people-open-why" in home, "the switch says why it is held, for the page and the tests"
    assert "'Lobby not connected — Retry'" in home, "a Hall that is not live says so"
    assert "'Sign in above first.'" in home, "and a signed-out one asks for the sign-in"
    assert "'/online/hall/retry'" in home, "with the one press that dials again"
    assert "'Online invites are off — turn on to be asked'" not in home, \
        "the card no longer blames the person's own setting for a missing socket"
    # The switch reads the Hall's own state, so a blank snapshot cannot look like OFF.
    assert "const live = liveOf(snap)" in home
    # shown.open is the switch the person just pressed, until the lobby answers; it is prefs.open
    # otherwise. Either way a dead socket keeps the chips dark.
    assert "dim: !shown.open || !live" in home, "no chip looks live while the socket is down"

    lobby = _src("72-lobby.js")
    assert "data-hall-not-connected" in lobby, "the Hall panel says it too"
    assert "'/online/hall/retry'" in lobby
    # Joining is not a failure: while the socket is still coming up the Hall says it is joining,
    # and only a Hall that never answered offers the Retry. What is gone is the old blanket
    # fallback that sat on "Joining the Hall…" for every state that was not live.
    assert "if (state === 'connecting' && !stale) return note('Joining the Hall…')" in lobby, \
        "'connecting' still says it is joining"
    assert "if (state !== 'live') return note(" not in lobby, \
        "no state waits on 'Joining the Hall…' forever without saying so"


def test_one_name_at_a_time_when_signed_in():
    """Signed in to the lobby, the lobby account's name is the one the page shows.

    Two names lived side by side: this computer's name (players.json) and the lobby
    account's. Settings called the first "the name other players see", the chat used the
    second, and a person who renamed themselves locally was still called by the old name
    in #games.
    """
    home = _src("70-home.js")
    assert "You are ${onlineName} online" in home, "the Games header names the lobby account"
    assert "data-online-name-clash" in home, "and Get online says both names when they differ"
    settings = _src("60-settings-and-alerts.js")
    assert "This computer's name." in settings, "the local name is labelled as local"
    assert "Other people see your online name" in settings
    lobby = _src("72-lobby.js")
    assert "in this chat." in lobby, "the chat column says whose name a line carries"
