"""Add your own game is a form inside Game Center, and the issue it builds matches the forms on GitHub.

The form is the submission path the guide describes: two choices, the fields each one needs, and a
GitHub issue opened in the person's own browser to review and send. ``tests/submit_harness.cjs``
drives the built bundle for the behaviour — both cards, the plain messages, the Game Center gate and
the address it encodes — and this file drives the other half: the two issue forms in
``.github/ISSUE_TEMPLATE/`` really parse, carry the label their submissions are filed under, and use
the same field ids the plugin sends as query parameters. A renamed id on either side would silently
pre-fill nothing, so the two sides are compared here rather than trusted.
"""

from __future__ import annotations

import json
import pytest
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / ".github" / "ISSUE_TEMPLATE"
HARNESS = ROOT / "tests" / "submit_harness.cjs"
SUBMIT_SOURCE = ROOT / "desktop" / "src" / "21-submit.js"

# Which form belongs to which choice, and the label a submission is filed under.
FORMS = {
    "community": {"file": "submit-community-game.yml", "label": "community-game"},
    "center": {"file": "submit-game-center-game.yml", "label": "game-center-game"},
}

def _load(path: Path) -> dict:
    """The form as GitHub reads it."""
    yaml = pytest.importorskip("yaml")
    loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(loaded, dict), f"{path.name} is not a mapping"
    return {"top": loaded, "body": loaded.get("body") or []}


def _field_ids(loaded: dict) -> list[str]:
    return [item["id"] for item in loaded["body"] if item.get("type") in ("input", "textarea")]


def _run_harness() -> str:
    result = subprocess.run(["node", str(HARNESS)], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "submit form: passed" in result.stdout, result.stdout + result.stderr
    return result.stdout


def _harness_fields(stdout: str) -> dict:
    for line in stdout.splitlines():
        if line.startswith("submit fields: "):
            return json.loads(line[len("submit fields: "):])
    raise AssertionError("the harness did not report its field ids: " + stdout[-800:])


def test_the_form_opens_both_choices_and_builds_a_bounded_issue_link() -> None:
    """The behaviour contract, driven against the built bundle the desktop actually loads."""
    _run_harness()


def test_the_fields_the_plugin_sends_are_the_fields_the_issue_forms_declare() -> None:
    sent = _harness_fields(_run_harness())
    for kind, form in FORMS.items():
        loaded = _load(TEMPLATES / form["file"])
        assert _field_ids(loaded) == sent[kind], (
            f"{form['file']} declares {_field_ids(loaded)}, the plugin sends {sent[kind]}"
        )


def test_every_issue_form_parses_carries_its_label_and_names_itself() -> None:
    for kind, form in FORMS.items():
        loaded = _load(TEMPLATES / form["file"])
        top = loaded["top"]
        assert str(top.get("name", "")).strip(), f"{form['file']} has no name"
        assert str(top.get("description", "")).strip(), f"{form['file']} has no description"
        labels = top.get("labels")
        assert labels == [form["label"]], f"{form['file']} is filed under {labels}, not {form['label']}"
        assert loaded["body"], f"{form['file']} has no body"
        for item in loaded["body"]:
            assert item.get("type"), f"{form['file']} has a block with no type"
            if item["type"] in ("input", "textarea"):
                assert item.get("id"), f"{form['file']} has an {item['type']} with no id"
                assert item.get("attributes", {}).get("label"), f"{form['file']}:{item['id']} has no label"


def test_the_form_requires_the_answers_the_plugin_checks_for() -> None:
    """A required field on GitHub and a required field in the plugin are the same promise."""
    community = _load(TEMPLATES / FORMS["community"]["file"])
    required = {item["id"] for item in community["body"] if item.get("validations", {}).get("required")}
    assert required == {"game-title", "game-link", "submitter", "licence", "summary"}, required
    center = _load(TEMPLATES / FORMS["center"]["file"])
    required = {item["id"] for item in center["body"] if item.get("validations", {}).get("required")}
    assert required == {"game-title", "source-repo", "submitter", "licence"}, required
    # The Play contract and the checker are the Game Center form's own gates, as checkboxes.
    boxes = {item["id"]: item for item in center["body"] if item.get("type") == "checkboxes"}
    assert set(boxes) == {"contract-checks", "check-game"}, sorted(boxes)
    for item in boxes.values():
        options = item.get("attributes", {}).get("options") or []
        assert options and all(option.get("required") for option in options), f"{item['id']} can be skipped"
    contract = [option["label"] for option in boxes["contract-checks"]["attributes"]["options"]]
    assert len(contract) == 6, contract
    assert any("check_game.py" in option["label"] for option in boxes["check-game"]["attributes"]["options"])


def test_the_plugin_names_the_forms_it_opens() -> None:
    source = SUBMIT_SOURCE.read_text(encoding="utf-8")
    for form in FORMS.values():
        assert (TEMPLATES / form["file"]).is_file(), f"{form['file']} is missing"
        assert form["file"] in source, f"the plugin never opens {form['file']}"
    assert "GAMES_REPO + '/issues/new?'" in source, "the address is not the repository's new-issue page"
