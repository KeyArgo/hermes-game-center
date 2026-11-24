"""The Get online card's own doors: a rename that keeps the server's sentence, a key that is
readable on this computer and nowhere else, and the account file the card offers to save.

The card says the lobby's own words when it refuses a name (a taken one, or one changed too
recently); it shows the saved key only after a press, only on the computer that holds it; and
it can write the four fields it promises to the person's Downloads folder. None of that may
reach a snapshot, a log line, or another computer.
"""

from __future__ import annotations

import os
import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from shelf import online_source  # noqa: E402
from shelf.online_source import Online  # noqa: E402
from test_online_server import run, sign_in, started  # noqa: E402


def _pc(folder, base, token):
    source = Online(folder, url=base, secret=lambda _name: token)
    source.turn_on()
    return source


# ---- Change my name ---------------------------------------------------------


def test_a_rename_takes_effect_and_a_second_one_keeps_the_servers_words(tmp_path):
    """The server's own 429 sentence is what the card shows, word for word."""

    async def scenario():
        server, client = await started(tmp_path / "server")
        try:
            _player, token = await sign_in(client, "bluewren")
            base = str(client.make_url("/")).rstrip("/")
            one = _pc(tmp_path / "pc", base, token)

            renamed = await asyncio.to_thread(one.rename, "bluewren")
            assert renamed["ok"] is True, renamed
            assert renamed["name"] == "bluewren", renamed
            assert one.snapshot()["name"] == "bluewren"

            first = await asyncio.to_thread(one.rename, "swiftdove")
            assert first["ok"] is True, first
            assert first["name"] == "swiftdove", first
            assert one.snapshot()["name"] == "swiftdove", "the card reads the new name from the view"

            again = await asyncio.to_thread(one.rename, "greyheron")
            assert again["ok"] is False, again
            assert again["text"] == "Names stick for 30 days. You can rename again in 30 days.", again
        finally:
            await client.close()

    run(scenario())


def test_a_name_someone_else_holds_is_refused_in_the_servers_own_sentence(tmp_path):
    async def scenario():
        server, client = await started(tmp_path / "server")
        try:
            _taken, _token = await sign_in(client, "locutus")
            _me, token = await sign_in(client, "bluewren")
            base = str(client.make_url("/")).rstrip("/")
            one = _pc(tmp_path / "pc", base, token)
            await asyncio.to_thread(one.sign_in, "bluewren", token)
            refused = await asyncio.to_thread(one.rename, "locutus")
            assert refused["ok"] is False, refused
            assert refused["text"] == "That name is too close to one already taken. Pick another.", refused
            assert one.snapshot()["name"] == "bluewren", "a refused name changes nothing here"
        finally:
            await client.close()

    run(scenario())


def test_the_rename_route_does_not_rewrite_the_servers_sentence(monkeypatch):
    from dashboard import plugin_api

    words = "Names stick for 30 days. You can rename again in 12 days."

    class FakeSource:
        def __init__(self):
            self.asked = []

        def rename(self, name):
            self.asked.append(name)
            return {"ok": False, "text": words}

        def snapshot(self):
            return {}

    source = FakeSource()
    monkeypatch.setattr(plugin_api, "_online_pair", lambda: (source, None))
    answer = plugin_api.online_rename({"name": "  greyheron  "})
    assert answer["text"].split("\n")[0] == words, answer
    assert source.asked == ["  greyheron  "], "the route hands the name to the one source as it came"


# ---- Show my key ------------------------------------------------------------


def test_the_key_is_readable_on_this_computer_and_nowhere_else(tmp_path, monkeypatch):
    from dashboard import plugin_api

    source = Online(tmp_path / "pc", url="http://127.0.0.1:9", secret=lambda _name: "KEY-SECRET-1")
    source.turn_on()
    monkeypatch.setattr(plugin_api, "_online_pair", lambda: (source, None))

    mine = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    answer = plugin_api.online_key(mine)
    assert answer["ok"] is True and answer["key"] == "KEY-SECRET-1", answer

    other = SimpleNamespace(client=SimpleNamespace(host="192.168.1.44"))
    refused = plugin_api.online_key(other)
    assert refused["ok"] is False, refused
    assert "KEY-SECRET-1" not in json.dumps(refused), "another computer never reads the key"
    assert "This device" in refused["text"] or "this computer" in refused["text"], refused


def test_the_key_is_never_in_a_snapshot_or_an_online_answer(tmp_path, monkeypatch):
    from dashboard import plugin_api

    source = Online(tmp_path / "pc", url="https://games.example", secret=lambda _name: "KEY-SECRET-2")
    source.turn_on()
    source._remember({"id": "p1", "name": "Ada"}, "Ada")
    monkeypatch.setattr(plugin_api, "_online_pair", lambda: (source, None))

    snapshot = source.snapshot()
    assert "KEY-SECRET-2" not in json.dumps(snapshot)
    for payload in (snapshot, plugin_api._online_payload(refresh=False)):
        assert "KEY-SECRET-2" not in json.dumps(payload)
    assert "key" not in source.snapshot(), "the view has no key field at all, masked or not"


# ---- Save my account file ---------------------------------------------------


def test_the_account_file_holds_the_four_fields_and_says_where_it_went(tmp_path):
    folder = tmp_path / "Downloads"
    source = Online(tmp_path / "pc", url="https://games.example", secret=lambda _name: "KEY-9")
    source.turn_on()
    source._remember({"id": "p1", "name": "Ada"}, "Ada")

    answer = source.account_file(folder)
    assert answer["ok"] is True, answer
    path = Path(answer["path"])
    assert path.name == "GameCenter-Ada.json", path.name
    assert path.parent == folder, path.parent
    held = json.loads(path.read_text(encoding="utf-8"))
    assert set(held) == {"name", "key", "server", "saved_at"}, held
    assert (held["name"], held["key"], held["server"]) == ("Ada", "KEY-9", "https://games.example")
    assert held["saved_at"] > 0
    assert str(folder) in answer["text"] and path.name in answer["text"], answer["text"]


def test_a_name_that_is_not_a_file_name_still_gives_one_file(tmp_path):
    folder = tmp_path / "Downloads"
    source = Online(tmp_path / "pc", url="https://games.example", secret=lambda _name: "KEY-9")
    source.turn_on()
    source._remember({"id": "p1", "name": "../../Ada Lovelace"}, "Ada")

    answer = source.account_file(folder)
    path = Path(answer["path"])
    assert path.parent == folder, "the file never lands outside the folder it was given"
    assert path.name.startswith("GameCenter-") and path.name.endswith(".json"), path.name
    assert "/" not in path.name and "\\" not in path.name and ".." not in path.name, path.name


def test_downloads_is_the_plain_folder_each_system_uses(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))  # Windows reads the home from here
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    assert online_source.downloads_folder() == tmp_path / "Downloads", "no setting means ~/Downloads"

    if os.name == "nt":
        return  # Windows has no user-dirs file; the plain folder is its whole answer
    xdg = tmp_path / ".config" / "user-dirs.dirs"
    xdg.parent.mkdir(parents=True, exist_ok=True)
    xdg.write_text('XDG_DOWNLOAD_DIR="$HOME/Telechargements"\n', encoding="utf-8")
    assert online_source.downloads_folder() == tmp_path / "Telechargements", "the desktop's own answer wins"


def test_the_account_file_route_writes_into_downloads_and_says_where(monkeypatch, tmp_path):
    from dashboard import plugin_api

    source = Online(tmp_path / "pc", url="https://games.example", secret=lambda _name: "KEY-9")
    source.turn_on()
    source._remember({"id": "p1", "name": "Ada"}, "Ada")
    monkeypatch.setattr(plugin_api, "_online_pair", lambda: (source, None))
    monkeypatch.setattr(plugin_api, "_downloads_dir", lambda: tmp_path / "Downloads")

    answer = plugin_api.online_account_file()
    assert answer["ok"] is True, answer
    assert Path(answer["path"]).parent == tmp_path / "Downloads"
    assert json.loads(Path(answer["path"]).read_text(encoding="utf-8"))["name"] == "Ada"


def test_same_name_exports_preserve_both_accounts(tmp_path):
    folder = tmp_path / "Downloads"
    paths = []
    for host in ("first", "second"):
        source = _pc(tmp_path / host, f"https://{host}.example", host)
        source._remember({"id": host, "name": "Ada"}, "Ada")
        answer = source.account_file(folder)
        assert answer["ok"]
        paths.append(Path(answer["path"]))
    assert paths[0] != paths[1]
    assert [json.loads(path.read_text())["key"] for path in paths] == ["first", "second"]


def test_failed_export_removes_temporary_key(tmp_path, monkeypatch):
    source = _pc(tmp_path / "pc", "https://games.example", "sample")
    source._remember({"id": "p1", "name": "Ada"}, "Ada")
    folder = tmp_path / "Downloads"
    first = Path(source.account_file(folder)["path"])
    original = first.read_bytes()

    def refuse(temporary, path):
        raise PermissionError("busy")

    monkeypatch.setattr(online_source.filelock, "replace", refuse)
    assert not source.account_file(folder)["ok"]
    assert first.read_bytes() == original
    assert list(folder.iterdir()) == [first]
