"""No developer cheat ships in this source tree.

Owner's decision (2026-11-13), on the quality review's recommendation: the cheats were removed outright
rather than hidden. The security they relied on — a scrypt hash, a key file, a force file — was native
security against a copy of the source, and the owner no longer wants the cheats at all, so there is
nothing left to protect and nothing left to get wrong.

What went: `shelf/devgrant.py` (the key and passphrase), `scripts/dev-grant.py` (add play chips),
`scripts/dev-eggs.py` (list, force and reset eggs), the `/eggs` command, the forced-egg override in
`shelf/eggs.py`, the `HERMES_GAMESHELF_EGG*` variables and `Wallet.grant()`.

This test is the fence: a copy of these files must not carry a way to hand itself chips or to jump the
Easter-egg schedule, and a later change must not quietly bring one back.
"""

from __future__ import annotations

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

GONE = [
    "shelf/devgrant.py",
    "shelf/paths.py",
    "scripts/dev-grant.py",
    "scripts/dev-eggs.py",
]

# Names that only existed to serve a cheat. `paths.py` went with them: its only callers were the key file
# and the egg-force file.
NAMES = ["devgrant", "dev-grant", "dev-eggs", "force_path", "_forced", "HERMES_GAMESHELF_EGG",
         "gameshelf-dev.key", "gameshelf-egg-force", "egg_cheat_armed"]


@pytest.mark.parametrize("relative", GONE)
def test_the_cheat_modules_are_gone(relative: str) -> None:
    assert not (ROOT / relative).exists(), f"{relative} is a developer cheat and must not ship"


def test_no_command_or_env_variable_forces_an_egg_or_grants_chips() -> None:
    plugin = (ROOT / "__init__.py").read_text(encoding="utf-8")
    assert '"eggs"' not in plugin and "'eggs'" not in plugin, "the /eggs cheat command must not be registered"
    eggs = (ROOT / "shelf" / "eggs.py").read_text(encoding="utf-8")
    assert "force_path" not in eggs and "_forced" not in eggs, "the schedule has no override"
    assert "HERMES_GAMESHELF_EGG" not in eggs, "no environment variable jumps the schedule"
    wallet = (ROOT / "shelf" / "wallet.py").read_text(encoding="utf-8")
    assert "def grant(" not in wallet, "chips cannot be handed to a wallet from outside the games"


def test_nothing_in_the_plugin_source_names_a_removed_cheat() -> None:
    """A stray import is how a removed cheat comes back: scan the shipped source, not just entry points.

    The tests are left out on purpose — a test may keep its own helper called ``_forced`` for writing
    reproducible game states, which has nothing to do with forcing an Easter egg.
    """
    offenders = []
    shipped = [ROOT / "__init__.py", *(ROOT / "shelf").glob("*.py"), *(ROOT / "doctrine").glob("*.py"),
               *(ROOT / "scripts").glob("*"), *(ROOT / "desktop" / "src").glob("*.js")]
    for path in sorted(shipped):
        if not path.is_file() or path.suffix not in {".py", ".sh", ".js", ".yaml"}:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for name in NAMES:
            if name in text:
                offenders.append(f"{path.relative_to(ROOT)}: {name}")
    assert not offenders, "a removed developer cheat is still named in:\n" + "\n".join(offenders)
