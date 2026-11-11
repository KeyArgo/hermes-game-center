"""The chess pieces are the vendored chessnut drawings (Apache-2.0).

Three things must stay true: the art inlined in the one-file Desktop plugin still
matches the readable SVG source in vendor/chessnut, every one of the twelve
pieces has art, and the licence travels with the files.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor" / "chessnut"
PLUGIN = ROOT / "desktop" / "plugin.js"
LETTERS = ["K", "Q", "R", "B", "N", "P", "k", "q", "r", "b", "n", "p"]


def test_inlined_art_matches_the_vendored_svgs():
    result = subprocess.run(
        [sys.executable, str(ROOT / "tools" / "chess_pieces.py"), "--check"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_every_piece_has_a_readable_source():
    for letter in LETTERS:
        name = ("w" if letter.isupper() else "b") + letter.upper()
        svg = (VENDOR / f"{name}.svg").read_text(encoding="utf-8")
        assert svg.lstrip().startswith("<svg"), name
        assert "<path" in svg, name


def test_the_art_block_is_in_the_plugin_once():
    source = PLUGIN.read_text(encoding="utf-8")
    assert source.count("const PIECE_ART = {") == 1
    for letter in LETTERS:
        assert f"  {letter}: [" in source, letter
    # The pieces are drawings now, not the letters they used to be.
    assert "children: mark.toUpperCase()" not in source


def test_the_licence_travels_with_the_art():
    licence = (VENDOR / "LICENSE.txt").read_text(encoding="utf-8")
    assert "Apache License" in licence and "Version 2.0" in licence
    notices = (ROOT / "THIRD-PARTY-NOTICES.md").read_text(encoding="utf-8")
    assert "chessnut" in notices
    assert "Apache-2.0" in notices
    assert "vendor/chessnut" in notices
    assert "Alexis Luengas" in notices
