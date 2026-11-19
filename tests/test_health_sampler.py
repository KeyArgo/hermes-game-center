"""L2: one health line every five minutes, and a warning when memory keeps growing.

The sampler is judged with a fake RSS and a fake clock: six samples in a row that
each grow, more than 50 MB together, earn one WARNING; anything less stays quiet.
The thread must cost nothing between samples (it waits on an event, never spins)
and must stop when asked.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path

import pytest

from shelf import diagnostics

MB = 1024 * 1024


@pytest.fixture(autouse=True)
def _clean_logger():
    logger = logging.getLogger(diagnostics.LOGGER_NAME)
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
        handler.close()
    yield
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
        handler.close()
    diagnostics.stop_health()


def _text(tmp_path: Path) -> str:
    return (tmp_path / diagnostics.LOG_NAME).read_text(encoding="utf-8")


def _sampler(values, **kwargs):
    """A sampler whose RSS walks the given list (in MB), one value per sample."""
    walk = iter(values)
    return diagnostics.HealthSampler(rss=lambda: next(walk) * MB, **kwargs)


def test_one_sample_writes_one_line(tmp_path):
    diagnostics.attach(tmp_path)
    sampler = _sampler([100], threads=lambda: 7, sockets=lambda: 2)
    line = sampler.sample_once()
    assert "health" in line
    text = _text(tmp_path)
    assert "rss=100.0MB" in text
    assert "threads=7" in text
    assert "lobby_sockets=2" in text
    assert text.count("health") == 1


def test_six_growing_samples_over_50mb_warn_once(tmp_path):
    diagnostics.attach(tmp_path)
    sampler = _sampler([100, 110, 120, 130, 140, 160])
    for _ in range(6):
        sampler.sample_once()
    text = _text(tmp_path)
    assert "WARNING" in text
    assert "memory keeps growing" in text
    assert text.count("memory keeps growing") == 1
    # A seventh growing sample does not warn again right away: the streak restarts.
    sampler2 = _sampler([170])
    sampler.rss = sampler2.rss
    sampler.sample_once()
    assert _text(tmp_path).count("memory keeps growing") == 1


def test_growth_of_50mb_or_less_stays_quiet(tmp_path):
    diagnostics.attach(tmp_path)
    sampler = _sampler([100, 105, 110, 115, 120, 125])
    for _ in range(6):
        sampler.sample_once()
    assert "memory keeps growing" not in _text(tmp_path)


def test_a_dip_resets_the_streak(tmp_path):
    diagnostics.attach(tmp_path)
    sampler = _sampler([100, 110, 120, 115, 130, 160])
    for _ in range(6):
        sampler.sample_once()
    assert "memory keeps growing" not in _text(tmp_path)
    # Six fresh growing samples, more than 50 MB together, do warn.
    sampler.rss = _sampler([200, 212, 224, 236, 248, 260]).rss
    for _ in range(6):
        sampler.sample_once()
    assert "memory keeps growing" in _text(tmp_path)


def test_missing_rss_still_writes_the_line(tmp_path):
    diagnostics.attach(tmp_path)
    sampler = diagnostics.HealthSampler(rss=lambda: None, threads=lambda: 3, sockets=lambda: 0)
    sampler.sample_once()
    text = _text(tmp_path)
    assert "threads=3" in text
    assert "lobby_sockets=0" in text


def test_the_proc_parser_reads_vmrss():
    text = "Name:\tpython3\nVmPeak:\t 999999 kB\nVmRSS:\t  123456 kB\nThreads:\t4\n"
    assert diagnostics.parse_proc_status(text) == 123456 * 1024
    assert diagnostics.parse_proc_status("Name:\tpython3\n") is None


def test_the_thread_samples_and_stops_on_shutdown(tmp_path):
    diagnostics.attach(tmp_path)
    count = [0]

    def rss():
        count[0] += 1
        return 100 * MB

    sampler = diagnostics.HealthSampler(interval=0.02, rss=rss)
    sampler.start()
    sampler.start()  # idempotent: still one thread
    end = time.monotonic() + 3
    while time.monotonic() < end and count[0] < 2:
        time.sleep(0.01)
    assert count[0] >= 2, "the sampler never sampled"
    assert sampler.running
    sampler.stop()
    assert not sampler.running
    stopped = count[0]
    time.sleep(0.1)
    assert count[0] == stopped, "the sampler kept going after stop()"


def test_register_starts_the_health_sampler(tmp_path):
    import importlib.util
    from types import SimpleNamespace

    spec = importlib.util.spec_from_file_location("gameshelf_health_plugin", Path(__file__).resolve().parents[1] / "__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    ctx = SimpleNamespace(
        get_config=lambda key, default=None: default,
        register_hook=lambda *a: None,
        register_command=lambda *a, **k: None,
        register_tool=lambda *a, **k: None,
    )
    plugin.register(ctx, data_root=tmp_path)
    assert diagnostics.health_running()
    diagnostics.stop_health()
    assert not diagnostics.health_running()