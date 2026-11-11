"""Turn the vendored chessnut SVGs into the shape data inlined in the Desktop module.

The Desktop plugin is a single ESM file, so the piece art cannot live in a module
of its own: it is written into one of the parts that make up that file. This script
is the one place that knows how an SVG becomes a list of jsx-ready shapes: it reads
vendor/chessnut/*.svg (the readable source, kept in the repo) and prints the block
that desktop/src/08-piece-art.js carries between the two markers below.

    python3 tools/chess_pieces.py            # print the block
    python3 tools/chess_pieces.py --check    # exit 1 if the part drifted

Run --check after editing the vendored art; tests/test_piece_art.py does the same on
every test run, and tools/build_plugin.py copies the part into desktop/plugin.js.
"""

from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor" / "chessnut"
PLUGIN = ROOT / "desktop" / "src" / "08-piece-art.js"
BEGIN = "// BEGIN vendored chessnut piece art (tools/chess_pieces.py)"
END = "// END vendored chessnut piece art"

# A cell holds one letter: uppercase is white, lowercase is black.
PIECES = {
    "wK": "K", "wQ": "Q", "wR": "R", "wB": "B", "wN": "N", "wP": "P",
    "bK": "k", "bQ": "q", "bR": "r", "bB": "b", "bN": "n", "bP": "p",
}

# SVG presentation attributes worth keeping, mapped to the React prop name.
ATTRS = {
    "fill": "fill",
    "stroke": "stroke",
    "stroke-width": "strokeWidth",
    "stroke-linecap": "strokeLinecap",
    "stroke-linejoin": "strokeLinejoin",
    "stroke-miterlimit": "strokeMiterlimit",
    "fill-rule": "fillRule",
    "opacity": "opacity",
}
TAGS = {"path": "path", "circle": "circle", "ellipse": "ellipse"}


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def collect(node, inherited: dict, out: list) -> None:
    """Walk the SVG, passing group attributes down to every shape."""
    here = dict(inherited)
    for name, value in node.attrib.items():
        if name in ATTRS:
            here[ATTRS[name]] = value
    tag = local(node.tag)
    if tag in TAGS:
        shape = dict(here)
        for name in ("d", "cx", "cy", "r", "rx", "ry"):
            if name in node.attrib:
                shape[name] = node.attrib[name]
        # A path with no fill and no stroke is solid black by SVG's own default.
        if tag == "path" and "fill" not in shape and "stroke" not in shape:
            shape["fill"] = "#000"
        out.append((TAGS[tag], shape))
        return
    for child in node:
        collect(child, here, out)


def shapes_for(name: str) -> list:
    tree = ET.parse(VENDOR / f"{name}.svg")
    out: list = []
    collect(tree.getroot(), {}, out)
    return out


def js_literal(value) -> str:
    if value.isdigit():
        return value
    if value.replace(".", "", 1).isdigit():
        return value
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def block() -> str:
    lines = [BEGIN]
    lines.append("const PIECE_ART = {")
    for svg_name, letter in PIECES.items():
        lines.append(f"  // {svg_name}.svg — chessnut by Alexis Luengas, Apache-2.0 (vendor/chessnut).")
        lines.append(f"  {letter}: [")
        for tag, shape in shapes_for(svg_name):
            body = ", ".join(f"{key}: {js_literal(value)}" for key, value in shape.items())
            lines.append(f"    ['{tag}', {{ {body} }}],")
        lines.append("  ],")
    lines.append("}")
    lines.append(END)
    return "\n".join(lines)


def strip_pieces(value: str) -> str:
    return "\n".join(line.rstrip() for line in value.strip().splitlines())


def in_plugin() -> str | None:
    source = PLUGIN.read_text(encoding="utf-8")
    start = source.find(BEGIN)
    end = source.find(END)
    if start < 0 or end < 0:
        return None
    return source[start:end + len(END)]


def main(argv: list[str]) -> int:
    wanted = block()
    if "--check" not in argv:
        print(wanted)
        return 0
    found = in_plugin()
    if found is None:
        print("desktop/plugin.js has no piece art block")
        return 1
    if strip_pieces(found) != strip_pieces(wanted):
        print("desktop/plugin.js piece art does not match vendor/chessnut; run tools/chess_pieces.py")
        return 1
    print("piece art matches vendor/chessnut")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
