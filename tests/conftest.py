"""Two slow suites that stay out of the ordinary run unless asked for.

``pytest tests`` runs everything that is self-contained in this process. Two
kinds of test need something outside it, so each has its own switch:

* ``-m realmodel`` / ``--realmodel`` — calls the local GLM for a real model
  answer. Skipped by default: the model server lives on another machine and may
  be off, and a game against it takes minutes.
* ``--browser`` — drives real headless Chrome against the isolated QA page.
  Skipped by default: it needs Chrome and takes several minutes for every table
  game.

Both are still ordinary pytest tests, so ``pytest --realmodel`` or
``pytest --browser`` runs them with the usual output and markers.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Running one test file puts only tests/ on sys.path, so imports like `from shelf import ...`
# failed whenever a file was run on its own even though the suite as a whole worked. Put the
# package roots on the path once, for every way of invoking the suite.
_ROOT = Path(__file__).resolve().parents[1]
for _extra in (_ROOT, _ROOT / "online"):
    if str(_extra) not in sys.path:
        sys.path.insert(0, str(_extra))


def pytest_addoption(parser):
    parser.addoption("--realmodel", action="store_true", default=False,
                     help="run the tests that play a whole game against the local GLM")
    parser.addoption("--browser", action="store_true", default=False,
                     help="run the tests that drive headless Chrome against the QA page")


def pytest_configure(config):
    config.addinivalue_line("markers",
                            "realmodel: plays a real game against the local GLM (needs --realmodel)")
    config.addinivalue_line("markers",
                            "browser: drives real headless Chrome over the QA page (needs --browser)")


def pytest_collection_modifyitems(config, items):
    for item in items:
        marks = {mark.name for mark in item.iter_markers()}
        if "realmodel" in marks and not config.getoption("--realmodel"):
            item.add_marker(pytest.mark.skip(reason="realmodel test: pass --realmodel to run it"))
        if "browser" in marks and not config.getoption("--browser"):
            item.add_marker(pytest.mark.skip(reason="browser test: pass --browser to run it"))
