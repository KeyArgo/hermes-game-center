"""Play while you code: the pane's quick game, and a game that comes back later.

The pane sends exactly two kinds of line: a quick game against the built-in
player, and the move itself. Both go through the same /games door as the full
table, so these tests drive the real catalog rather than a mock.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf.catalog import Catalog  # noqa: E402
from shelf.commands import run  # noqa: E402

from tests.test_center import _own  # noqa: E402

CURATED = [str(item) for item in json.loads((ROOT / "shelf" / "curated.json").read_text(encoding="utf-8"))["games"]]


def _catalog(tmp_path: Path) -> Catalog:
    return Catalog([ROOT], tmp_path / "data", {"allow_ai": True})


def test_every_curated_game_starts_against_the_computer_in_one_line(tmp_path: Path) -> None:
    """The pane's one click, for every game Play offers — nothing typed, no setup."""
    catalog = _catalog(tmp_path)
    assert CURATED, "Play has games to offer"
    for game_id in CURATED:
        _own(catalog, game_id)
        run(catalog, f"allow-ai {game_id} black=local level=intermediate", source="command")
        picture = catalog.picture(game_id)
        assert picture is not None, f"{game_id} has a board"
        assert picture["status"] == "active", f"{game_id} started"
        seats = {seat["side"]: seat for seat in picture["seats"]}
        assert seats["black"]["kind"] == "local", f"{game_id} seats the built-in player"
        assert seats["white"]["kind"] == "human", f"{game_id} leaves white to the person"
        assert picture["turn"] == "white", f"{game_id} waits for the person's first move"


def test_a_quick_game_never_seats_the_person_agent_by_itself(tmp_path: Path) -> None:
    """Only the explicit 'Play my Hermes model' line spends the person's model."""
    catalog = _catalog(tmp_path)
    _own(catalog, "reversi")
    run(catalog, "allow-ai reversi black=local level=intermediate", source="command")
    seats = {seat["side"]: seat for seat in catalog.picture("reversi")["seats"]}
    assert seats["black"]["kind"] == "local"
    assert seats["black"]["kind"] != "agent"


def test_a_game_left_mid_move_is_still_there_later(tmp_path: Path) -> None:
    """Leaving the pane does not lose the game: the table lives on the server."""
    catalog = _catalog(tmp_path)
    _own(catalog, "connect4")
    run(catalog, "allow-ai connect4 black=local level=intermediate", source="command")
    started = catalog.picture("connect4")
    run(catalog, "connect4 move 4", source="command")
    later = catalog.picture("connect4")
    assert later["table_id"] == started["table_id"], "the same table, not a new one"
    assert later["status"] == "active"
    # The person's move and the computer's answer are both on the board.
    assert later["plies"] >= 2
    assert "4" in [str(move) for move in later["moves"]]


def test_the_pane_is_play_while_you_code_and_wears_an_obvious_door() -> None:
    """Owner's ask 2026-11-11: renamed, and the way back in is visible.

    The pane could be reopened only from the command palette, so a button now stands in the
    Games header beside the chips and a status-bar item carries a small game icon and the same
    words while the pane is closed. The pane's internal ids are unchanged.
    """
    src = (ROOT / "desktop" / "plugin.js").read_text(encoding="utf-8")
    # 1. The rename, in every title, label and tooltip a person reads.
    for titled in ("title: 'Play while you code'", "label: 'Play while you code'",
                   "title: 'Play while you code — restore the pane'", "children: 'Play while you code'",
                   "'aria-label': 'Play while you code'"):
        assert titled in src, f"the pane is not renamed here: {titled}"
    for old in ("title: 'Play while you wait'", "label: 'Play while you wait'",
                "children: 'Play while you wait'", 'open Play while you wait'):
        assert old not in src, f"the old words are still drawn: {old}"
    # 2. The ids stay as they were, so nothing else that points at the pane moves.
    assert "id: 'pane'" in src
    assert "'hermes-gameshelf.wait'" in src
    assert "'hermes-gameshelf.open'" in src
    # 3. The door: two faces, one state, and the pane's own two functions behind it.
    assert "function paneOnScreen()" in src, "one read says whether the pane is on the screen"
    assert "if (paneChromePref() === 'closed') return false" in src, "a closed session counts as closed"
    assert "function usePaneOnScreen()" in src, "and a component can follow that read"
    assert "function paneDoorWords(onScreen)" in src
    assert "return onScreen ? 'Close side pane' : 'Play while you code'" in src, "the open pane's button says what its press does"
    assert "onClick: () => (onScreen ? closeWaitPane() : (onOpen ? onOpen() : openWaitPane()))" in src, "the header button opens and closes the pane"
    home = (ROOT / "desktop" / "src" / "70-home.js").read_text(encoding="utf-8")
    assert "paneDoorButtonElement(paneOn, null, () => paneFromPage(ctx, selected))" in home, \
        "from full screen the door leaves Game Center for the chat and opens the pane on the same game"
    # 4. The status-bar item: a small game icon and the words, and nothing while the pane is open.
    assert "'data-games-pane-door': 'status'" in src
    assert "function paneDoorItemElement(onScreen) {\n  if (onScreen) return null" in src, "it hides while the pane is open"
    assert "'data-games-pane-icon': '1'" in src, "it wears a small game icon"
    assert "onClick: () => openWaitPane()" in src, "and one press opens the pane"
    assert "const door = paneDoorItemElement(onScreen)" in src, "the door is drawn by the one status item"
    assert "if (!door && !news) return null" in src, "and it renders nothing at all when it has neither"
    status_block = src[src.index("function GamesStatusItem"):src.index("function GamesStatusItem") + 5000]
    assert "GamesVersionChip" not in status_block, "no version chip in the status bar"
    # 5. The header button stands in the page's own header row, beside the wallet chip.
    assert "const paneOn = usePaneOnScreen()" in src
    assert "paneDoorButtonElement(paneOn, null, () => paneFromPage(ctx, selected))" in src
    assert "GameCenterPage" in src


def test_the_pane_is_a_right_hand_pane_with_a_quick_game_and_an_agent_line() -> None:
    src = (ROOT / "desktop" / "plugin.js").read_text(encoding="utf-8")
    assert "PANES_AREA" in src, "the pane is registered through the SDK's panes area"
    assert "id: 'pane'" in src
    assert "placement: 'right'" in src
    assert "dock: { pane: 'workspace', pos: 'right' }" in src
    # One click, the four quick games, the computer at Normal.
    assert "const QUICK_GAMES = ['connect4', 'reversi', 'gomoku', 'breakthrough']" in src
    assert "item.title || item.id" in src, "the tiles carry the game's own title"
    assert "level=${level || QUICK_LEVEL}" in src
    assert "const QUICK_LEVEL = 'intermediate'" in src
    # Strength buttons in the owner's words, on tiles never a drop-down.
    assert "LEVEL_LABELS" in src
    assert "data-game-tile" in src
    assert "data-level" in src
    # The agent line, and the one-click way back.
    assert "Hermes is working…" in src
    assert "Hermes finished: back to chat" in src
    assert "composer.focus" in src
    # The explicit model choice, and the computer as the default.
    assert "Play my Hermes model" in src
    assert "black=${who === 'agent' ? 'agent' : 'local'}" in src
    # The same board component the full table draws.
    assert src.count("jsx(BoardSvg, {") >= 4
    # It saves the game it is on, so a person can come back to it.
    assert "rememberPaneGame" in src
    assert "pane-game" in src
