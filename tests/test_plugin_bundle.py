"""The Desktop module is written as parts and built into the one file Hermes loads.

Hermes loads a single ES module per Desktop plugin, and the plugin catalog only
allows that module to import ``@hermes/plugin-sdk``, ``react`` and
``react/jsx-runtime``. So the code lives in ``desktop/src/NN-name.js`` and
``tools/build_plugin.py`` glues the parts back together in order.

These tests keep that honest:

* the committed ``desktop/plugin.js`` is exactly what the parts build today, so a
  change to a part without a rebuild cannot ship;
* only the header part imports and only the last part exports, so the bundle stays
  one module with the import surface the catalog allows;
* the build refuses a part it cannot place, rather than silently dropping it.
"""

from __future__ import annotations

import importlib.util
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "desktop" / "src"
BUNDLE = ROOT / "desktop" / "plugin.js"
BUILD = ROOT / "tools" / "build_plugin.py"


def _load_build():
    spec = importlib.util.spec_from_file_location("build_plugin", BUILD)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_committed_bundle_is_what_the_parts_build_today():
    result = subprocess.run([sys.executable, str(BUILD), "--check"], capture_output=True, text=True)
    assert result.returncode == 0, (
        result.stdout + result.stderr
        + "\ndesktop/plugin.js is out of date: run python3 tools/build_plugin.py"
    )
    assert "up to date" in result.stdout


def test_the_parts_are_numbered_so_their_order_needs_no_separate_list():
    parts = sorted(path.name for path in SRC.glob("*.js"))
    assert parts, "desktop/src is empty"
    assert parts[0] == "00-header.js", "the header must come first: it holds the imports"
    for name in parts:
        assert re.match(r"^\d{2}[a-z]?-[a-z0-9-]+\.js$", name), name
    numbers = [name.split("-")[0] for name in parts]
    assert numbers == sorted(numbers), "two parts share a number"


def test_only_the_header_imports_and_only_the_last_part_exports():
    parts = sorted(SRC.glob("*.js"))
    for path in parts:
        for number, line in enumerate(path.read_text(encoding="utf-8").split("\n"), start=1):
            if line.startswith("import "):
                assert path.name == "00-header.js", (
                    f"{path.name}:{number} imports; only the header may, or the bundle stops being one module"
                )
            if line.startswith("export "):
                assert path == parts[-1], f"{path.name}:{number} exports; only the last part may"


def test_the_bundle_imports_nothing_but_the_sdk_and_react():
    # Catalog rule 8: a Desktop module may import the plugin SDK and React only.
    allowed = {"@hermes/plugin-sdk", "react", "react/jsx-runtime"}
    imports = re.findall(r"^import .* from '([^']+)'$", BUNDLE.read_text(encoding="utf-8"), re.MULTILINE)
    assert imports, "the bundle has no imports at all"
    assert set(imports) <= allowed, f"unexpected import: {sorted(set(imports) - allowed)}"
    assert imports.count("@hermes/plugin-sdk") == 1, "the SDK is imported in one named import"


def test_the_bundle_still_lands_a_plugin_object_and_the_shared_drawing():
    source = BUNDLE.read_text(encoding="utf-8")
    # The UI harness and the website both strip these lines, so their shape matters.
    assert re.search(r"^export default \{$", source, re.MULTILINE), "the plugin object is one export default"
    assert re.search(r"^export \{ BoardSvg, coverArt, startingPicture, tableAccess \}$", source, re.MULTILINE)
    assert "id: 'hermes-gameshelf'," in source


def test_the_bundle_says_it_is_built_so_nobody_edits_it_by_hand():
    head = BUNDLE.read_text(encoding="utf-8").split("\n")[:2]
    assert "tools/build_plugin.py" in head[0], "the built file must name its builder"
    assert "desktop/src/" in head[0], "and the folder the parts live in"


GAME_PAGE = SRC / "30-game-page.js"


def test_the_local_board_game_shell_wears_the_approved_words():
    """The agreed shell (ux/matrix.md, "Proposed game shell"), migration step 1.

    The local board-game screen carries one wording for the header, the one opponent line, the
    one status line and the one action row, and it carries no web-browser door any more: online
    play is the in-Hermes lobby now. This reads the game-page part *and* the shipped bundle (the
    first test proves the bundle is built from the parts), so a green test is a green build.
    """
    part = GAME_PAGE.read_text(encoding="utf-8")
    bundle = BUNDLE.read_text(encoding="utf-8")
    assert part.rstrip("\n") in bundle, "the game-page part is not in the shipped bundle"

    for word in [
        "Back to games",                                    # header, left to right
        "label: 'How to play'",
        "button('Settings'",
        "You vs ",                                          # the one opponent line
        "Your Hermes model",
        "Two models",
        "Person here",
        "Computer",                                         # the built-in player
        "Your turn",                                        # the one status line
        "is thinking…",
        "Waiting for ",
        "Undo move",                                        # the one action row, in order
        "button('Hint'",
        "Offer draw",
        "button('Resign'",
        "button('Leave table'",
    ]:
        assert word in part, f"the game page does not carry the approved words: {word!r}"

    # Placement: Back to games · name · How to play · settings. The header's own Back button is
    # the last one in the part (the result card/bar carry their own "Back to games" earlier).
    header_back = part.rindex("button('Back to games'")
    assert header_back < part.index("label: 'How to play'") < part.index("button('Settings'"), \
        "the header is not in the order Back to games · How to play · Settings"

    # The action row is one row, in the approved order: Undo move · Hint · Offer draw · Resign ·
    # Leave table. Reading their positions is what pins the order, not a loose membership check.
    order = [
        "button('Undo move",
        "button('Hint'",
        "'Offer draw'",
        "button('Resign'",
        "button('Leave table'",
    ]
    positions = [part.index(anchor) for anchor in order]
    assert positions == sorted(positions), f"the action row is out of order: {positions}"

    # And the browser invite path is gone from this screen, not hidden behind a fold.
    for gone in [
        "Open in browser",
        "Copy link",
        "Join table",
        "Online tables live on the lobby server",
        "in your browser — outside Hermes",
    ]:
        assert gone not in part, f"the game page still carries the removed browser path: {gone!r}"


def test_the_build_refuses_a_part_whose_place_is_unclear(tmp_path):
    build = _load_build()
    build.SRC = tmp_path
    build.OUT = tmp_path / "plugin.js"
    (tmp_path / "00-header.js").write_text("import { host } from '@hermes/plugin-sdk'\n")
    (tmp_path / "notes.js").write_text("const x = 1\n")
    try:
        build.bundle()
    except build.BuildError as error:
        assert "NN-name.js" in str(error)
    else:
        raise AssertionError("a part with no number was let into the bundle")


def test_the_build_refuses_an_import_outside_the_header(tmp_path):
    build = _load_build()
    build.SRC = tmp_path
    build.OUT = tmp_path / "plugin.js"
    (tmp_path / "00-header.js").write_text("import { host } from '@hermes/plugin-sdk'\n")
    (tmp_path / "10-part.js").write_text("import { useState } from 'react'\nconst x = 1\n")
    try:
        build.bundle()
    except build.BuildError as error:
        assert "10-part.js:1" in str(error)
    else:
        raise AssertionError("a second module statement was let into the bundle")


def test_the_build_refuses_an_empty_parts_folder(tmp_path):
    build = _load_build()
    build.SRC = tmp_path / "missing"
    build.OUT = tmp_path / "plugin.js"
    try:
        build.bundle()
    except build.BuildError as error:
        assert "no parts folder" in str(error)
    else:
        raise AssertionError("an empty parts folder built a plugin")


def test_the_bundle_carries_the_three_extras_the_owner_asked_for():
    """Three contracts, all in the one shipped file.

    Backgammon's Play tile draws its own board instead of the dark stand-in scene an unknown id
    gets; the main screen carries one row of links out to the project; and the version chip copies
    its own line on a click or a key. The behaviour is driven in tests/table_ui_harness.cjs — this
    is the contract that they are in the built desktop/plugin.js at all, so a part edited without a
    rebuild cannot pass.
    """
    bundle = BUNDLE.read_text(encoding="utf-8")
    art = (SRC / "14b-backgammon-svg.js").read_text(encoding="utf-8")
    boards = (SRC / "10-boards.js").read_text(encoding="utf-8")
    library = (SRC / "20-library.js").read_text(encoding="utf-8")
    home = (SRC / "70-home.js").read_text(encoding="utf-8")
    version = (SRC / "79-version.js").read_text(encoding="utf-8")

    # 1. A backgammon cover, drawn as its own SVG and reached from coverArt before the BoardSvg grid.
    for part in (art, boards, library, version):
        assert part.rstrip("\n") in bundle, "a part is not in the shipped bundle"
    assert "function backgammonCover(" in bundle, "the backgammon cover is not in the bundle"
    assert "pictured.view === 'backgammon'" in bundle, "coverArt does not route backgammon to its cover"
    assert "backgammon" in boards and "view: 'backgammon'" in boards, \
        "backgammon has no starting picture, so its tile would draw the stand-in scene"

    # 2. One link row out to the project, each address a fixed https page, opened through the one
    #    browser door the Submit button already uses.
    assert "const GAMES_REPO = 'https://github.com/KeyArgo/hermes-game-center'" in bundle, \
        "the repository the links point at is not in the bundle"
    for suffix in ("/issues/new", "/blob/main/docs/SUBMIT-A-GAME.md"):
        assert suffix in library, f"the link row does not carry {suffix}"
    assert "href: GAMES_REPO" in library, "a link does not point at the repository"
    assert "'data-games-links': 'repo'" in bundle, "the row is not one marked row"
    assert "function GameCenterLinks(" in library, "the row is not a component"
    assert "jsx(GameCenterLinks," in home, "the main screen does not draw the link row"
    assert "openInBrowser(ctx, link.href, onNote)" in library, "the links use the shared browser door"

    # 3. The chip copies its own line, through the SDK's clipboard door with the browser's own as a
    #    fallback — never a hidden textarea appended to the app's <body> — and a key
    #    reaches it too.
    assert "function copyChipText(" in version and "function copyWithNavigator(" in version
    assert "ctx.os.writeClipboard" in version, "the SDK's own clipboard door is not used"
    assert "navigator.clipboard.writeText" in version, "the browser's clipboard is not the fallback"
    assert "execCommand('copy')" not in version, "no hidden-textarea copy: a plugin does not write to the app's body"
    assert "'Click to copy the version'" in bundle, "the chip's tooltip does not say what a click does"
    assert "CHIP_COPIED_MS" in version, "the chip has no \"Copied\" window"
    assert "onKeyDown" in version, "the chip is not reachable from the keyboard"


def test_close_game_center_sits_top_right_not_bottom():
    """Close Game Center at the top right (the tab row on Games, floated top
    right elsewhere), never the old fixed bottom-right corner."""
    home = (SRC / "70-home.js").read_text(encoding="utf-8")
    route = (SRC / "80-plugin.js").read_text(encoding="utf-8")
    assert "'data-gc-close-header': '1', style: { marginLeft: 'auto' }" in home
    assert "position: 'absolute', right: 16, top: 12" in route
    assert "bottom: 40" not in route
