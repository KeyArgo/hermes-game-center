"""The website ships the Desktop module as its board drawing, so its stand-in for
the plugin SDK must export every name the module imports.

A missing name is not a small error: the whole module fails to load and the site
sits on "Loading Game Center…" for ever. That is exactly what happened when the
pane added two imports and the stand-in was not updated, so this test pins the
two files together. The address in the test is localhost only.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "desktop" / "plugin.js"
SHIM = ROOT / "online" / "web" / "sdk-shim.js"
INDEX = ROOT / "online" / "server.py"


def _imported() -> set[str]:
    source = PLUGIN.read_text(encoding="utf-8")
    match = re.search(r"^import \{([^}]*)\} from '@hermes/plugin-sdk'$", source, re.MULTILINE)
    assert match, "desktop/plugin.js must import the plugin SDK in one named import"
    return {name.strip() for name in match.group(1).split(",") if name.strip()}


def _exported() -> set[str]:
    source = SHIM.read_text(encoding="utf-8")
    return set(re.findall(r"^export const (\w+)", source, re.MULTILINE))


def test_the_site_stand_in_exports_everything_the_desktop_module_imports():
    imported = _imported()
    exported = _exported()
    missing = imported - exported
    assert not missing, f"online/web/sdk-shim.js is missing {sorted(missing)}; the site cannot load"


def test_the_shim_gives_the_drawing_the_doors_it_uses():
    exported = _exported()
    assert "host" in exported
    assert "useValue" in exported, "the module reads host.state.busy through useValue"


def test_the_site_serves_the_desktop_module_as_its_board():
    source = INDEX.read_text(encoding="utf-8")
    assert 'BOARD_JS = _SHELF / "desktop" / "plugin.js"' in source, "the board drawing is the plugin module"
    assert 'add_get("/board.js"' in source
    assert 'add_get("/sdk-shim.js"' in source
