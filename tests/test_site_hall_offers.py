"""The website's Hall, checked against the file the site actually serves.

An offer is one person's ask: the server only lets the person asked answer it, so the
page must only offer them Join / Not now. The seeker sees who is being asked and how
long is left, with a cancel. tests/site_hall_harness.cjs draws online/web/app.js in
Node with React stubbed out, so these are the site's own words and controls.
"""
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_site_hall_offer_sides():
    result = subprocess.run(
        ["node", str(ROOT / "tests" / "site_hall_harness.cjs")],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
