"""The README opens with the claim: the model proposes, the referee decides, the refusal is recorded."""

from __future__ import annotations

from pathlib import Path

README = Path(__file__).resolve().parent.parent / "README.md"


def _first_paragraph() -> str:
    lines = README.read_text(encoding="utf-8").splitlines()
    # The title and the currency stamp are metadata, not prose: the claim under test is the first
    # paragraph a reader meets.
    body = [
        line for line in lines[1:]
        if not line.startswith("#") and not (line.startswith("_") and line.rstrip().endswith("_"))
    ]
    text = "\n".join(body).strip()
    return text.split("\n\n", 1)[0].lower()


def test_head_states_the_referee_claim():
    head = "\n".join(README.read_text(encoding="utf-8").splitlines()[:8]).lower()
    assert "referee" in head
    assert "refuses" in head


def test_first_paragraph_is_governance_not_toys():
    first = _first_paragraph()
    assert "games hermes can actually play" in first, first
    for word in ("fun", "arcade", "board games"):
        assert word not in first, f"first paragraph says {word!r}"


def test_readme_keeps_its_existing_sections():
    text = README.read_text(encoding="utf-8")
    assert text.count("\n## ") >= 3
