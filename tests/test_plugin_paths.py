"""Review item 4: this plugin's own files live in its plugin data folder, per profile.

Nous's review (2026-11-12): the egg-force file and the developer key were built from
``Path.home() / ".hermes"`` directly, so both ignored the active profile and sat loose in
``~/.hermes`` beside Hermes's own files. Hermes gives every plugin one folder per profile —
``plugin_data_dir("hermes-gameshelf")`` — and plugin state belongs there.

What these tests pin:

- the key file, the egg-force file and the data folder all resolve to
  ``<hermes home>/plugin-data/hermes-gameshelf/``, so switching profile switches them;
- ``/eggs`` is armed by a force file in the plugin's data folder and NOT by one left in the old
  ``<home>/.hermes`` place, which is the whole point of the move;
- nothing in the tree builds one of those paths out of ``Path.home()`` any more.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from shelf import devgrant, eggs, paths  # noqa: E402


@pytest.fixture()
def hermes_home(tmp_path, monkeypatch):
    """An empty Hermes home for this profile, so nothing on the machine leaks in."""
    home = tmp_path / "hermes-home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("HERMES_GAMESHELF_EGG_FORCE_FILE", raising=False)
    monkeypatch.delenv("HERMES_GAMESHELF_EGG", raising=False)
    return home


def _data(home: Path) -> Path:
    return home / "plugin-data" / "hermes-gameshelf"


def test_the_data_folder_is_the_plugins_own_folder_under_the_active_home(hermes_home):
    assert paths.data_dir() == _data(hermes_home)
    assert _data(hermes_home).is_dir(), "the folder Hermes would give us is what we resolve to"


def test_the_developer_key_lives_in_the_data_folder_not_in_the_home(hermes_home):
    path = devgrant.key_path()
    assert path == _data(hermes_home) / "gameshelf-dev.key"
    assert path.parent.parent != hermes_home / ".hermes", "not loose in the Hermes home"


def test_the_egg_force_file_lives_in_the_data_folder_not_in_the_home(hermes_home):
    path = eggs.force_path()
    assert path == _data(hermes_home) / "gameshelf-egg-force"
    assert path.parent.parent != hermes_home / ".hermes"


def test_a_key_armed_in_one_profile_does_not_arm_another(monkeypatch, tmp_path):
    first, second = tmp_path / "first", tmp_path / "second"
    monkeypatch.setenv("HERMES_HOME", str(first))
    devgrant.make_key("a long enough passphrase")
    assert devgrant.armed() is True
    monkeypatch.setenv("HERMES_HOME", str(second))
    assert devgrant.armed() is False, "the key followed the profile instead of the machine"


def test_no_module_still_builds_these_paths_from_the_home_directory():
    """The review's actual defect: a cheat file's name built onto ``Path.home() / ".hermes"``."""
    offenders = []
    for relative in ("__init__.py", "shelf/eggs.py", "shelf/devgrant.py",
                     "scripts/dev-eggs.py", "scripts/dev-grant.py"):
        for number, line in enumerate((ROOT / relative).read_text(encoding="utf-8").splitlines(), 1):
            names_a_cheat_file = any(name in line for name in ("gameshelf-dev.key", "gameshelf-egg-force"))
            builds_a_home_path = "Path.home" in line or '".hermes"' in line or "'~/.hermes'" in line
            if names_a_cheat_file and builds_a_home_path:
                offenders.append(f"{relative}:{number}: {line.strip()}")
    assert not offenders, f"these still build a cheat file's path from the home directory: {offenders}"


# ---------------------------------------------------------------------------
# The /eggs command, which is what the force file actually arms
# ---------------------------------------------------------------------------

class _Ctx:
    """Just enough of the plugin context for register(): commands, tools and config."""

    def __init__(self) -> None:
        self.commands: dict = {}
        self.tools: dict = {}

    def get_config(self, key, default=None):
        return {"allow_ai": False}.get(key, default)

    def has_plugin(self, plugin_id: str) -> bool:
        return False

    def register_command(self, name, handler, description="", **_kwargs):
        self.commands[name] = handler

    def register_tool(self, **kwargs):
        self.tools[kwargs["name"]] = kwargs["handler"]


def _register(data_root: Path):
    """Load the plugin as a package and register it against ``data_root``."""
    import importlib.util

    package = "_gameshelf_paths_under_test"
    for stale in [key for key in sys.modules if key == package or key.startswith(package + ".")]:
        del sys.modules[stale]
    spec = importlib.util.spec_from_file_location(
        package, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)]
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    module.__package__ = package
    module.__path__ = [str(ROOT)]  # type: ignore[attr-defined]
    sys.modules[package] = module
    spec.loader.exec_module(module)
    ctx = _Ctx()
    module.register(ctx, data_root=data_root, roots=[])
    return ctx


def test_the_plugin_data_folder_is_what_arms_the_eggs_command(hermes_home, tmp_path):
    data_root = _data(hermes_home)
    data_root.mkdir(parents=True, exist_ok=True)
    assert "eggs" not in _register(data_root).commands, "the cheat is off until a file arms it"

    (data_root / "gameshelf-egg-force").write_text("the-argo-stamp\n", encoding="utf-8")
    ctx = _register(data_root)
    assert "eggs" in ctx.commands, "a force file in the plugin's own data folder arms /eggs"
    assert "the-argo-stamp" in ctx.commands["eggs"]("list")


def test_a_force_file_left_in_the_old_home_place_arms_nothing(hermes_home):
    """The move is the fix: the old location must not keep working, or the profile is still ignored."""
    legacy = hermes_home / ".hermes"
    legacy.mkdir(parents=True, exist_ok=True)
    (legacy / "gameshelf-egg-force").write_text("the-argo-stamp\n", encoding="utf-8")
    ctx = _register(_data(hermes_home))
    assert "eggs" not in ctx.commands


def test_show_writes_the_force_file_where_the_plugin_reads_it(hermes_home, monkeypatch):
    data_root = _data(hermes_home)
    data_root.mkdir(parents=True, exist_ok=True)
    (data_root / "gameshelf-egg-force").write_text("the-argo-stamp\n", encoding="utf-8")
    ctx = _register(data_root)
    answer = ctx.commands["eggs"]("show nous-in-the-marquee")
    assert "Forced nous-in-the-marquee" in answer
    assert (data_root / "gameshelf-egg-force").read_text(encoding="utf-8").strip() == "nous-in-the-marquee"
    assert not (hermes_home / ".hermes" / "gameshelf-egg-force").exists()
