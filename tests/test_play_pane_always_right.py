"""The Play pane ALWAYS opens on the right of the chat (owner, 2026-11-18: "#4 pane always right").

The host adopts a contributed pane once and then remembers where the person put it, so a pane that
was ever dragged - or that a host update re-homed into the wrong group - stayed wrong for good. The
host has an enforced dock for exactly that: a `panes` contribution whose `dock` hint carries
`enforce: true` is re-homed onto the hint's anchor at every boot's first adoption pass, with no
one-time token and no user-placement exemption
(``apps/desktop/src/components/pane-shell/tree/store.ts``, ``enforceDockedPanes``).

Asserted here on the part the plugin is written in, because that is where the hint lives: the built
``desktop/plugin.js`` is rebuilt once, on the merged tree.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PART = ROOT / "desktop" / "src" / "80-plugin.js"


def test_the_dock_hint_asks_the_host_to_enforce_the_right_edge() -> None:
    source = PART.read_text(encoding="utf-8")
    assert "dock: { pane: 'workspace', pos: 'right', enforce: true }" in source, (
        "the dock hint does not carry enforce: true, so a host update or an earlier drag can leave "
        "the Play pane anywhere"
    )


def test_the_pane_is_still_registered_the_way_the_rest_of_it_expects() -> None:
    """enforce rides beside the hint; it does not replace the placement facts the pane needs."""
    source = PART.read_text(encoding="utf-8")
    assert "id: 'pane'" in source
    assert "placement: 'right'" in source
    # A pane that is minimized on install never reshapes a layout, and hide-only keeps the plugin's
    # own × as the only way to take it off the screen.
    assert "defaultCollapsed: true" in source
    assert "hideOnly: true" in source
