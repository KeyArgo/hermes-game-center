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
