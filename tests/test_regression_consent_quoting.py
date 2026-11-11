"""A line the consent gate cannot read must not be treated as harmless.

`fair.blocked()` decides whether a model-initiated line may seat an AI opposite a
person. It splits the line with shlex; an unbalanced quote made the split fail and
the gate returned None — "allow". Today `/games` refuses to parse the same line
before the gate is reached, so nothing is exploitable through that door; but the
gate is the documented enforcement point, and it must not answer "fine" to a line
it could not read. A game with a more forgiving parser would seat the AI.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf import fair  # noqa: E402


def test_an_unreadable_line_is_refused_not_passed_through() -> None:
    refusal = fair.blocked("new white=human black=agent'", "tool")
    assert refusal, "an unbalanced quote was treated as harmless"


def test_a_readable_ai_line_is_still_refused_for_a_model() -> None:
    refusal = fair.blocked("new white=human black=agent", "tool")
    assert refusal and "person" in refusal.lower(), refusal


def test_a_person_typing_the_same_line_is_not_blocked_by_the_gate() -> None:
    # The floor is consent, not syntax: a typed line is a person's own decision.
    assert fair.blocked("new white=human black=agent", "command") is None
