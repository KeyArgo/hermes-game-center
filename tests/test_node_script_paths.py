"""Node helper scripts must turn their own URL into a path the Windows way.

`new URL(import.meta.url).pathname` gives `/D:/a/...` on Windows, which Node then reads as
`D:\\D:\\a\\...` and fails with ENOENT. `fileURLToPath` is right on every OS.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_no_script_builds_its_path_from_url_pathname():
    offenders = [
        str(p.relative_to(ROOT))
        for folder in ("tests", "tools")
        for p in sorted((ROOT / folder).rglob("*.*js"))
        if "URL(import.meta.url).pathname" in p.read_text(encoding="utf-8")
    ]
    assert not offenders, f"use fileURLToPath(import.meta.url) instead: {offenders}"
