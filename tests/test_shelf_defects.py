"""Code-review defects in shelf: frozen agent seats, hostile manifests, racing installs."""
from __future__ import annotations

import json
import subprocess
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shelf.catalog import Catalog  # noqa: E402
from shelf.commands import run  # noqa: E402
from shelf.library import Library  # noqa: E402
from shelf.who import Player  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


def test_agent_seats_freeze_when_allow_ai_turned_off(tmp_path):
    catalog = Catalog([ROOT.parent], tmp_path, {"allow_ai": True})
    ada = Player("Ada", "Ada", "irc")
    run(catalog, "install checkers", player=ada)
    run(catalog, "checkers new", player=ada)
    run(catalog, "checkers allow-ai black=agent", player=ada,
        complete=lambda prompt: {"move": "1", "remark": "", "tokens": 1})
    seats = (catalog.picture("checkers") or {}).get("seats") or []
    assert any(seat.get("kind") == "agent" for seat in seats), seats
    catalog.settings["allow_ai"] = False
    refused = run(
        catalog, "checkers move 1", player=ada,
        complete=lambda prompt: {"move": "1", "remark": "", "tokens": 1},
    )
    assert refused.startswith("AI is off"), refused
    assert catalog.picture("checkers")["plies"] == 0


def test_doctrine_import_command_keeps_the_json_whole(tmp_path):
    """/games doctrine import <json> lost every quote to shlex.split and was
    rejected as "not valid JSON"; the command path must pass the file through."""
    catalog = Catalog([ROOT], tmp_path, {"allow_ai": True})
    ada = Player("Ada", "Ada", "desktop")
    assert "library" in run(catalog, "install doctrine", player=ada).lower()
    card = json.loads((ROOT / "doctrine" / "cards" / "stone-bastion.json").read_text())
    payload = json.dumps({"kind": "doctrine-card", "data": card})
    answer = run(catalog, "doctrine import " + payload, player=ada)
    assert "Imported Stone Bastion" in answer, answer
    shown = catalog.picture("doctrine") or {}
    assert (shown.get("doctrine") or {}).get("your_card", {}).get("name") == "Stone Bastion"


def _plugin(root: Path, name: str, manifest) -> None:
    folder = root / name
    folder.mkdir(parents=True)
    payload = manifest if isinstance(manifest, str) else json.dumps(manifest)
    (folder / "game.json").write_text(payload, encoding="utf-8")
    (folder / "game.py").write_text("def create(root, settings):\n    return None\n", encoding="utf-8")


def test_non_object_game_json_is_skipped_with_a_friendly_note(tmp_path):
    root = tmp_path / "plugins"
    root.mkdir()
    _plugin(root, "goodones", {"id": "goodone", "title": "Good One", "entry": "game.py", "factory": "create"})
    _plugin(root, "listy", "[]")
    _plugin(root, "nully", "null")
    catalog = Catalog([root], tmp_path / "data", {"allow_ai": True})
    assert catalog.has("goodone")
    assert not catalog.has("listy") and not catalog.has("nully")
    notes = "\n".join(catalog.problems)
    assert "listy" in notes and "nully" in notes, notes
    assert "json" in notes.lower() and "object" in notes.lower()


def test_enabled_check_uses_the_folder_not_the_manifest_claim(tmp_path):
    root = tmp_path / "plugins"
    root.mkdir()
    _plugin(root, "myplug", {"id": "g1", "title": "G One", "entry": "game.py", "factory": "create", "plugin": "other"})
    mine = lambda plugin_id: plugin_id == "myplug"  # noqa: E731
    assert Catalog([root], tmp_path / "data", {"allow_ai": True}, enabled=mine).has("g1")
    theirs = lambda plugin_id: plugin_id == "other"  # noqa: E731
    assert not Catalog([root], tmp_path / "data", {"allow_ai": True}, enabled=theirs).has("g1")


def test_plugin_identity_ignores_an_inline_yaml_comment(tmp_path):
    root = tmp_path / "plugins"
    root.mkdir()
    _plugin(root, "commentplug", {"id": "c1", "title": "C One", "entry": "game.py", "factory": "create"})
    (root / "commentplug" / "plugin.yaml").write_text("name: classic-games # board games\n", encoding="utf-8")
    enabled = lambda plugin_id: plugin_id == "classic-games"  # noqa: E731
    assert Catalog([root], tmp_path / "data", {"allow_ai": True}, enabled=enabled).has("c1")


def test_plugin_name_ignores_a_nested_name_field(tmp_path):
    root = tmp_path / "plugins"
    root.mkdir()
    _plugin(root, "nestedplug", {"id": "n1", "title": "N One", "entry": "game.py", "factory": "create"})
    (root / "nestedplug" / "plugin.yaml").write_text(
        "some_section:\n  name: other-plugin\nname: nestedplug\n", encoding="utf-8")
    enabled = lambda plugin_id: plugin_id == "nestedplug"  # noqa: E731
    assert Catalog([root], tmp_path / "data", {"allow_ai": True}, enabled=enabled).has("n1")


def test_bare_game_dir_ignores_an_ancestor_plugin_yaml(tmp_path):
    root = tmp_path / "plugins"
    root.mkdir()
    # An unrelated plugin.yaml ABOVE the scan root must not claim a bare game.
    (tmp_path / "plugin.yaml").write_text("name: hermes-gameshelf\n", encoding="utf-8")
    _plugin(root, "baregame", {"id": "b1", "title": "B One", "entry": "game.py", "factory": "create"})
    enabled = lambda plugin_id: plugin_id == "hermes-gameshelf"  # noqa: E731
    assert not Catalog([root], tmp_path / "data", {"allow_ai": True}, enabled=enabled).has("b1"), (
        "a bare game must not inherit an ancestor's plugin.yaml"
    )


def test_plugin_identity_does_not_trust_a_nested_plugin_yaml(tmp_path):
    root = tmp_path / "plugins"
    root.mkdir()
    _plugin(root, "evilplug", {"id": "e1", "title": "E One", "entry": "game.py", "factory": "create", "plugin": "hermes-gameshelf"})
    (root / "evilplug" / "plugin.yaml").write_text("name: evilplug\n", encoding="utf-8")
    nested = root / "evilplug" / "games"
    nested.mkdir()
    (nested / "plugin.yaml").write_text("name: hermes-gameshelf\n", encoding="utf-8")
    (nested / "game.json").write_text(json.dumps({"id": "e2", "title": "E Two", "entry": "game.py", "factory": "create"}), encoding="utf-8")
    enabled = lambda plugin_id: plugin_id == "hermes-gameshelf"  # noqa: E731
    catalog = Catalog([root], tmp_path / "data", {"allow_ai": True}, enabled=enabled)
    assert not catalog.has("e1") and not catalog.has("e2")


def test_concurrent_installs_never_lose_each_other(tmp_path):
    library = Library(tmp_path)
    gate = threading.Barrier(32)
    errors = []

    def add(n):
        try:
            gate.wait()
            library.add(f"game-{n:02d}")
        except Exception as exc:  # pragma: no cover - only surfaces on a real crash
            errors.append(exc)

    threads = [threading.Thread(target=add, args=(n,)) for n in range(32)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert not errors, errors
    assert library.ids() == {f"game-{n:02d}" for n in range(32)}


WRITER = """
import json
import sys
import time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from shelf.filelock import file_lock
target = Path(sys.argv[2])
name = sys.argv[3]
folder = target.parent
stem = target.name
ready = folder / (stem + '.ready-' + name)
attempt = folder / (stem + '.attempt-' + name)
trace = folder / (stem + '.trace-' + name + '.json')
# Handshake 1: both have started.
ready.write_text('1', encoding='utf-8')
deadline = time.time() + 30
while len(list(folder.glob(stem + '.ready-*'))) < 2:
    if time.time() > deadline:
        raise SystemExit('peer never got ready')
    time.sleep(0.01)
# Handshake 2: record when this process starts contending, before it can block.
before = time.time()
attempt.write_text('1', encoding='utf-8')
with file_lock(target.with_suffix('.lock')):
    acquired = time.time()
    # The holder waits until the peer has also started contending, so the two
    # critical sections are provably attempted at the same time.
    deadline = time.time() + 30
    while len(list(folder.glob(stem + '.attempt-*'))) < 2:
        if time.time() > deadline:
            raise SystemExit('peer never contended')
        time.sleep(0.01)
    time.sleep(0.3)
    data = json.loads(target.read_text(encoding='utf-8')) if target.exists() else {'writers': []}
    data['writers'].append(name)
    target.write_text(json.dumps(data), encoding='utf-8')
released = time.time()
trace.write_text(json.dumps({'before': before, 'acquired': acquired, 'released': released}), encoding='utf-8')
"""


def test_two_processes_using_the_lock_keep_both_writes(tmp_path):
    """A real lock: without it both writers read the same file and one write is lost."""
    target = tmp_path / "shared.json"
    names = ("alpha", "beta")
    processes = [
        subprocess.Popen([sys.executable, "-c", WRITER, str(ROOT), str(target), name])
        for name in names
    ]
    try:
        for process in processes:
            assert process.wait(timeout=75) == 0
        written = json.loads(target.read_text(encoding="utf-8"))
        assert sorted(written["writers"]) == ["alpha", "beta"]
        traces = {
            name: json.loads((tmp_path / f"shared.json.trace-{name}.json").read_text(encoding="utf-8"))
            for name in names
        }
        for name, trace in traces.items():
            assert trace["before"] <= trace["acquired"] <= trace["released"], (name, trace)
        # Both processes had started contending before either one finished, so the
        # two critical sections really did overlap; a late starter cannot pass.
        overlap_start = max(trace["before"] for trace in traces.values())
        overlap_end = min(trace["released"] for trace in traces.values())
        assert overlap_start < overlap_end, (traces, "the processes never contended")
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def test_racing_add_and_discard_leave_valid_json(tmp_path):
    library = Library(tmp_path)
    library.add("seed")
    gate = threading.Barrier(8)
    errors = []

    def churn(n):
        try:
            gate.wait()
            for _ in range(5):
                library.add(f"churn-{n}")
                library.discard(f"churn-{(n + 1) % 8}")
        except Exception as exc:  # pragma: no cover
            errors.append(exc)

    threads = [threading.Thread(target=churn, args=(n,)) for n in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert not errors, errors
    assert "seed" in library.ids()
    assert library.ids() <= {"seed"} | {f"churn-{n}" for n in range(8)}
