"""The shared-helper cache must key on the file, not only on its timestamp.

`load_fresh` keeps one module per name and reuses it when the file's modification
time is unchanged. The key was the timestamp alone, so a *different* file loaded
under the same name — same mtime, which a copy or a tarball with preserved times
produces — got the previously loaded module instead of its own code. One file's
module would then run as another's.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf import fresh  # noqa: E402

NAME = "gameshelf_helper_under_test"


def _write(folder: Path, value: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "helper.py"
    path.write_text(f"VALUE = {value!r}\n", encoding="utf-8")
    return path


def test_two_files_with_one_timestamp_are_two_modules(tmp_path: Path) -> None:
    first = _write(tmp_path / "one", "first")
    second = _write(tmp_path / "two", "second")
    stamp = 1_600_000_000_000_000_000
    os.utime(first, ns=(stamp, stamp))
    os.utime(second, ns=(stamp, stamp))

    assert fresh.load_fresh(NAME, first).VALUE == "first"
    assert fresh.load_fresh(NAME, second).VALUE == "second", "the cache served the other file's module"


def test_the_same_file_is_only_loaded_once(tmp_path: Path, monkeypatch) -> None:
    path = _write(tmp_path / "same", "only")
    loaded = fresh.load_fresh(NAME, path)
    calls: list[str] = []
    original = fresh.importlib.util.spec_from_file_location

    def counted(name, target):
        calls.append(str(target))
        return original(name, target)

    monkeypatch.setattr(fresh.importlib.util, "spec_from_file_location", counted)
    assert fresh.load_fresh(NAME, path) is loaded
    assert calls == []
