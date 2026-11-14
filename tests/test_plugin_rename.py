"""The plugin is called hermes-game-center now, and an old player's data still arrives.

The manifest name is what Hermes keys everything by: the install folder, the plugin-data folder,
the config entry and the `/api/plugins/<id>/` prefix the Desktop page calls. Renaming it is a
one-line change in `plugin.yaml` that would silently orphan every existing player's wallet, name,
champions and saved tables, and every Desktop choice the host stored under the old id. So these
tests hold two things at once:

* the old id is gone from the tree (the one place it may still be written is the migration's own
  `OLD_ID`, which reads the old folder once), and
* the migration copies the old plugin-data folder into the new one exactly once — never moving or
  deleting it — and the Desktop bundle copies old local-storage keys to their new names.

`CHANGELOG.md` is exempt: it is history, and its 1.0.0 entry has to name the old id so a player
upgrading knows where their saves came from.
"""

from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
NEW_ID = "hermes-game-center"
OLD_ID = "hermes-gameshelf"
OLD_MODULE = "hermes_gameshelf"
NEW_MODULE = "hermes_game_center"
MIGRATION = ROOT / "shelf" / "pluginid.py"
HARNESS = ROOT / "tests" / "legacy_storage_harness.cjs"
# The one line allowed to name the old id: the migration's constant.
OLD_ID_CONSTANT = re.compile(r"^\s*(?:const\s+)?OLD_ID\s*=")


def _tracked() -> list[str]:
    result = subprocess.run(
        ["git", "-C", str(ROOT), "ls-files", "-z"],
        capture_output=True, check=True, timeout=60,
    )
    return [name for name in result.stdout.decode("utf-8", "replace").split("\0") if name]


def test_no_tracked_file_still_carries_the_old_plugin_id() -> None:
    """A rename that leaves one id behind splits the plugin in two: one half cannot see the other."""
    exempt = {"CHANGELOG.md", "tests/test_plugin_rename.py"}
    offenders: list[str] = []
    for relative in _tracked():
        if relative in exempt:
            continue
        path = ROOT / relative
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for number, line in enumerate(text.splitlines(), start=1):
            if OLD_ID not in line and OLD_MODULE not in line:
                continue
            if OLD_ID_CONSTANT.match(line):
                continue
            offenders.append(f"{relative}:{number}: {line.strip()[:100]}")
    assert not offenders, "the old plugin id is still in:\n" + "\n".join(offenders)


def test_the_manifest_the_dashboard_and_the_desktop_agree_on_the_one_id() -> None:
    """The host addresses the plugin by this id, so every file that names it must say the same."""
    assert re.search(rf"^name:\s*{re.escape(NEW_ID)}$", (ROOT / "plugin.yaml").read_text(encoding="utf-8"), re.MULTILINE), \
        "plugin.yaml does not name the plugin hermes-game-center"
    manifest = json.loads((ROOT / "dashboard" / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["name"] == NEW_ID, "the dashboard manifest still mounts the API under another id"

    sys.path.insert(0, str(ROOT))
    from shelf import pluginid  # noqa: PLC0415 - the path has to be right first

    assert pluginid.NEW_ID == NEW_ID
    assert pluginid.OLD_ID == OLD_ID, "the migration must remember the id it copies from"

    bundle = (ROOT / "desktop" / "plugin.js").read_text(encoding="utf-8")
    assert f"const PLUGIN_ID = '{NEW_ID}'" in bundle, "the Desktop bundle does not know this plugin's id"
    assert "id: PLUGIN_ID," in bundle, "the plugin object the Desktop registers is not the new id"
    assert f"id: '{OLD_ID}'," not in bundle


def _migration():
    spec = importlib.util.spec_from_file_location("pluginid_under_test", MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _old_and_new(tmp_path: Path) -> tuple[Path, Path]:
    # A name with a space and a name outside ASCII: nothing here may be built by gluing strings.
    old = tmp_path / "plugin-data" / OLD_ID
    new = tmp_path / "plugin-data" / NEW_ID
    (old / "save games" / "战争 2026").mkdir(parents=True)
    (old / "wallet.json").write_text('{"points": 4200}', encoding="utf-8")
    (old / "players.json").write_text('{"me": "Argo"}', encoding="utf-8")
    (old / "save games" / "战争 2026" / "state.json").write_text('{"turn": 3}', encoding="utf-8")
    return old, new


def test_the_old_folder_is_copied_and_left_exactly_where_it_was(tmp_path: Path) -> None:
    module = _migration()
    old, new = _old_and_new(tmp_path)

    assert module.migrate(new, old) is True, "the first run did not report the copy"

    assert (new / "wallet.json").read_text(encoding="utf-8") == '{"points": 4200}'
    assert (new / "players.json").read_text(encoding="utf-8") == '{"me": "Argo"}'
    assert (new / "save games" / "战争 2026" / "state.json").read_text(encoding="utf-8") == '{"turn": 3}'
    assert (new / module.MARKER).is_file(), "no marker, so the copy would run again on every start"
    # Copy, never move, never delete: the old folder is the only backup there is.
    assert (old / "wallet.json").read_text(encoding="utf-8") == '{"points": 4200}'
    assert (old / "save games" / "战争 2026" / "state.json").is_file()


def test_a_file_already_in_the_new_folder_wins(tmp_path: Path) -> None:
    module = _migration()
    old, new = _old_and_new(tmp_path)
    new.mkdir(parents=True)
    (new / "wallet.json").write_text('{"points": 7}', encoding="utf-8")

    module.migrate(new, old)

    assert (new / "wallet.json").read_text(encoding="utf-8") == '{"points": 7}', "the copy overwrote the player's new wallet"
    assert (new / "players.json").exists(), "a file only the old folder had is still worth copying"


def test_no_old_folder_is_a_quiet_no_op(tmp_path: Path) -> None:
    module = _migration()
    new = tmp_path / "plugin-data" / NEW_ID

    assert module.migrate(new, tmp_path / "plugin-data" / OLD_ID) is False
    assert not (new / module.MARKER).exists(), "a marker with nothing copied would stop a later, real copy"
    assert not new.exists() or not list(new.iterdir())


def test_a_second_call_copies_nothing(tmp_path: Path) -> None:
    module = _migration()
    old, new = _old_and_new(tmp_path)
    assert module.migrate(new, old) is True
    (old / "champions").mkdir()
    (old / "champions" / "board.json").write_text("{}", encoding="utf-8")

    assert module.migrate(new, old) is False, "the marker did not stop the second run"

    assert not (new / "champions").exists(), "a file appeared in the new folder after the one copy"


def test_a_copy_that_fails_leaves_no_marker_and_retries(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    module = _migration()
    old, new = _old_and_new(tmp_path)

    def broken(source, target, *args, **kwargs):
        Path(target).write_text("half a file", encoding="utf-8")  # a partial write must not survive
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(module.shutil, "copy2", broken)
    assert module.migrate(new, old) is False, "a failed copy must not crash the plugin"
    assert not (new / module.MARKER).exists(), "a marker after a failed copy stops the retry"
    assert not (new / "wallet.json").exists(), "a half-written file was left in the data folder"

    monkeypatch.undo()
    assert module.migrate(new, old) is True, "the next start did not retry"
    assert (new / "wallet.json").read_text(encoding="utf-8") == '{"points": 4200}'


def test_the_plugin_asks_hermes_for_the_new_folder_and_never_creates_the_old_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`plugin_data_dir` creates what it is asked for, so asking for the old id would leave a stray folder."""
    module = _migration()
    old, _ = _old_and_new(tmp_path)
    asked: list[str] = []

    def fake_plugin_data_dir(plugin_id: str) -> Path:
        asked.append(plugin_id)
        folder = tmp_path / "plugin-data" / plugin_id
        folder.mkdir(parents=True, exist_ok=True)
        return folder

    fake = types.SimpleNamespace(plugin_data_dir=fake_plugin_data_dir)
    monkeypatch.setitem(sys.modules, "plugins.plugin_storage", fake)

    root = module.data_dir()

    assert root == tmp_path / "plugin-data" / NEW_ID
    assert asked == [NEW_ID], f"the old folder was asked for by name (and so created): {asked}"
    assert (root / "wallet.json").read_text(encoding="utf-8") == '{"points": 4200}'
    assert (old / "wallet.json").exists()


def test_the_module_names_that_get_cached_use_the_new_id() -> None:
    """`load_fresh` caches by module name, so a half-renamed tree would load two copies of one module."""
    names = set()
    for relative in _tracked():
        if relative.endswith(".py"):
            names.update(re.findall(r"\bhermes_[a-z0-9_]+\b", (ROOT / relative).read_text(encoding="utf-8")))
    assert [name for name in names if name.startswith(NEW_MODULE)], "no cached module name carries the plugin id"
    assert not [name for name in names if name.startswith(OLD_MODULE)], "a module name still carries the old id"


def test_the_desktop_bundle_copies_a_key_saved_under_the_old_id() -> None:
    """The host keys what the browser saved by the plugin id; the old keys must follow the new id."""
    if not HARNESS.is_file():
        pytest.fail("tests/legacy_storage_harness.cjs is missing")
    result = subprocess.run(
        ["node", str(HARNESS)], capture_output=True, text=True, timeout=120,
        cwd=str(ROOT),
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "passed" in result.stdout
