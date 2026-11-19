"""L4: our own surfaces report their errors and heap to POST /log, rate limited.

The route writes into the same rotating log, masks secrets, and refuses more than
20 reports a minute. The desktop side is pinned at the source: only our own errors
are sent, the heap watch runs every five minutes while a surface is open, and the
host app's DOM is never touched.
"""

from __future__ import annotations

import logging
from pathlib import Path

import pytest

from dashboard import plugin_api
from shelf import diagnostics

ROOT = Path(__file__).resolve().parents[1]
MB = 1024 * 1024


@pytest.fixture(autouse=True)
def _clean():
    logger = logging.getLogger(diagnostics.LOGGER_NAME)
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
        handler.close()
    plugin_api._LOG_TIMES.clear()
    yield
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
        handler.close()
    plugin_api._LOG_TIMES.clear()


def _text(tmp_path: Path) -> str:
    return (tmp_path / diagnostics.LOG_NAME).read_text(encoding="utf-8")


def test_an_error_line_lands_in_the_same_log(tmp_path):
    diagnostics.attach(tmp_path)
    answer = plugin_api.log_report({"kind": "error", "message": "TypeError: x is not a function (plugin.js:12:3)"})
    assert answer["ok"] is True
    text = _text(tmp_path)
    assert "desktop error:" in text
    assert "TypeError: x is not a function" in text


def test_a_report_never_carries_a_secret_into_the_log(tmp_path):
    diagnostics.attach(tmp_path)
    plugin_api.log_report({"kind": "rejection", "message": "sign-in failed bot_key=supersecret123"})
    text = _text(tmp_path)
    assert "supersecret123" not in text
    assert "***" in text


def test_a_heap_sample_is_one_line_in_mb(tmp_path):
    diagnostics.attach(tmp_path)
    answer = plugin_api.log_report({"kind": "heap", "used": 123 * MB})
    assert answer["ok"] is True
    assert "desktop heap used=123.0MB" in _text(tmp_path)


def test_at_most_twenty_reports_a_minute(tmp_path, monkeypatch):
    diagnostics.attach(tmp_path)
    ticks = [0.0]
    monkeypatch.setattr(plugin_api.time, "monotonic", lambda: ticks[0])
    for number in range(20):
        assert plugin_api.log_report({"kind": "error", "message": f"line {number}"})["ok"] is True
    refused = plugin_api.log_report({"kind": "error", "message": "one too many"})
    assert refused["ok"] is False
    assert refused["reason"] == "rate_limited"
    assert "one too many" not in _text(tmp_path)
    ticks[0] = 61.0  # a minute later the window has moved on
    assert plugin_api.log_report({"kind": "error", "message": "fresh"})["ok"] is True


def test_a_bad_kind_or_a_long_line_is_refused_or_trimmed(tmp_path):
    diagnostics.attach(tmp_path)
    assert plugin_api.log_report({"kind": "anything", "message": "x"})["ok"] is False
    assert plugin_api.log_report(None)["ok"] is False
    answer = plugin_api.log_report({"kind": "error", "message": "y" * 5000})
    assert answer["ok"] is True
    line = [line for line in _text(tmp_path).splitlines() if "desktop error:" in line][-1]
    assert len(line) < 400  # the message was trimmed, not swallowed whole


def test_the_bundle_watches_its_own_surfaces_only():
    part = (ROOT / "desktop" / "src" / "09-diagnostics.js").read_text(encoding="utf-8")
    bundle = (ROOT / "desktop" / "plugin.js").read_text(encoding="utf-8")
    assert "unhandledrejection" in part
    assert "performance.memory" in part
    assert "usedJSHeapSize" in part
    assert "5 * 60 * 1000" in part, "the heap watch runs every five minutes"
    assert "hermes-gameshelf" in part, "only errors from our own code are reported"
    assert "'/log'" in part
    # Both surfaces open the watch, and the bundle carries it.
    assert bundle.count("diagSurfaceOpen(ctx)") >= 2
    assert "diagSurfaceOpen" in bundle
    # The host app's markup is never reached for (the review guards scan every part too).
    for forbidden in ("document.querySelector", "document.getElementById", "document.body"):
        assert forbidden not in part


def test_the_boundary_reports_the_crash_it_contained():
    boundary = (ROOT / "desktop" / "src" / "06-boundary.js").read_text(encoding="utf-8")
    assert "diagSend" in boundary, "a crash the boundary contains never reaches window.onerror"