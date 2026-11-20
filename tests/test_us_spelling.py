"""Words a player reads are spelled one way: "color", never "colour" (owner, 2026-11-20)."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Every string literal on a line, read left to right, so the code between two strings is never one.
QUOTED = re.compile(r"""'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`""")


def _strings_saying_colour(path):
    hits = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        stripped = line.strip()
        if stripped.startswith(("//", "#", "*")):
            continue
        for match in QUOTED.finditer(line):
            text = match.group(0)
            # A template's ${colour} is a variable name, not a word on screen.
            if re.search(r"\bcolours?\b", re.sub(r"\$\{[^}]*\}", "", text), re.IGNORECASE):
                hits.append(f"{path.relative_to(ROOT)}:{number}: {text}")
    return hits


def test_no_player_facing_string_says_colour():
    files = list((ROOT / "desktop" / "src").glob("*.js")) + list((ROOT / "shelf").rglob("*.py"))
    hits = [hit for path in sorted(files) for hit in _strings_saying_colour(path)]
    assert not hits, "spell it color:\n" + "\n".join(hits)
