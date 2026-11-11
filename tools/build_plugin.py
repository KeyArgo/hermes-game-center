#!/usr/bin/env python3
"""Build desktop/plugin.js from the parts in desktop/src/.

Hermes loads one ES module per Desktop plugin, and that module may import only
``@hermes/plugin-sdk``, ``react`` and ``react/jsx-runtime``. Keeping the code in
one file made it 6,000 lines long, so the file is written as numbered parts
under ``desktop/src/`` and this script glues them back together in order.

The parts are plain JavaScript, not modules: only ``00-header.js`` carries the
imports, and nothing carries its own ``export``. That is what lets the built
file stay a single module with the same import surface as before, which is what
the plugin catalog checks (rule 8) and what ``online/web/sdk-shim.js`` mirrors.

    python3 tools/build_plugin.py            # write desktop/plugin.js
    python3 tools/build_plugin.py --check    # exit 1 if desktop/plugin.js is stale

The built file is committed, so the plugin works with no build step.
``tests/test_plugin_bundle.py`` runs ``--check`` on every test run.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "desktop" / "src"
OUT = ROOT / "desktop" / "plugin.js"

HEADER = """\
// Built by tools/build_plugin.py from the parts in desktop/src/. Edit those, then run
// the build; tests/test_plugin_bundle.py fails while this file is out of date.
"""

# A part is "NN-name.js". The number is where it sits in the bundle, so the order is the
# file listing and never a list to keep in step by hand.
PART = re.compile(r"^\d{2}[a-z]?-[a-z0-9]+(?:-[a-z0-9]+)*\.js$")
# Only the header may import, and only the last part may export. One module, one surface.
IMPORT = re.compile(r"^import\s")
EXPORT = re.compile(r"^export\s")
MODULE_STATEMENT = re.compile(r"^(?:import|export)\s")


class BuildError(Exception):
    pass


def parts() -> list[Path]:
    if not SRC.is_dir():
        raise BuildError(f"no parts folder at {SRC}")
    found = sorted(SRC.glob("*.js"))
    if not found:
        raise BuildError(f"no parts in {SRC}")
    for path in found:
        if not PART.match(path.name):
            raise BuildError(f"{path.name} is not named NN-name.js, so its place in the bundle is unclear")
    return found


def bundle() -> str:
    found = parts()
    if found[0].name != "00-header.js":
        raise BuildError("the first part must be 00-header.js: it holds the doc comment and the imports")
    chunks: list[str] = []
    for path in found:
        text = path.read_text(encoding="utf-8")
        lines = text.split("\n")
        for number, line in enumerate(lines, start=1):
            if MODULE_STATEMENT.match(line) and not (
                (path.name == "00-header.js" and IMPORT.match(line))
                or (path.name == found[-1].name and EXPORT.match(line))
            ):
                raise BuildError(
                    f"{path.name}:{number} is a module statement ({line.strip()[:40]}…); "
                    "only 00-header.js may import and only the last part may export"
                )
        if not text.endswith("\n"):
            raise BuildError(f"{path.name} must end with a newline")
        chunks.append(text.rstrip("\n"))
    return HEADER + "\n" + "\n\n".join(chunks) + "\n"


def main(argv: list[str]) -> int:
    try:
        built = bundle()
    except BuildError as error:
        print(f"build failed: {error}", file=sys.stderr)
        return 2
    if "--check" in argv:
        current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if current == built:
            print(f"desktop/plugin.js is up to date ({len(built.splitlines())} lines from {len(parts())} parts)")
            return 0
        print(
            "desktop/plugin.js is out of date with desktop/src/; run python3 tools/build_plugin.py",
            file=sys.stderr,
        )
        return 1
    OUT.write_text(built, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(built.splitlines())} lines from {len(parts())} parts)")
    return 0


if __name__ == "__main__":
    if any(arg not in ("--check",) for arg in sys.argv[1:]):
        print(__doc__, file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1:]))
