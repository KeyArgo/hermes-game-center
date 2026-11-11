"""Champions: what a champion is, what a hostile champion file can do, and sharing."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf import champions  # noqa: E402


def sample(**overrides) -> dict:
    raw = {
        "name": "Rook",
        "motto": "Hold the line.",
        "brief": "You are patient and never rush a winning position.",
        "avatar": "rook",
        "color": "amber",
        "brain": {"kind": "model"},
    }
    raw.update(overrides)
    return raw


def test_a_champion_needs_a_name_and_a_brief():
    champion, error = champions.validate(sample())
    assert error == "" and champion is not None
    assert champion["id"].startswith("champ-") and len(champion["id"]) == 14
    assert champion["brain"] == {"kind": "model", "model": "", "provider": ""}
    assert set(champion) == {"schema_version", "id", "name", "motto", "avatar", "color",
                             "brief", "brain", "created_at", "playbook", "pet", "model"}

    assert champions.validate(sample(name=""))[1]
    assert champions.validate(sample(brief="   "))[1]
    assert champions.validate("not a champion")[1]
    assert champions.validate(None)[1]


def test_sizes_are_limited_and_plain_text_only():
    champion, error = champions.validate(sample(
        name="N" * 200, motto="m" * 500, brief="b" * 5000,
        extra="ignored", **{"nested": {"x": 1}}
    ))
    assert error == ""
    assert len(champion["name"]) == champions.MAX_NAME
    assert len(champion["motto"]) == champions.MAX_MOTTO
    assert len(champion["brief"]) == champions.MAX_BRIEF
    assert "extra" not in champion and "nested" not in champion

    messy, error = champions.validate(sample(brief="hello\x00\x07  world\n\nnext\ttab"))
    assert error == ""
    assert messy["brief"] == "hello world next tab"


def test_avatars_and_colours_are_from_the_built_in_lists():
    assert champions.validate(sample(avatar="dragon"))[1]
    assert champions.validate(sample(color="#000000"))[1]
    champion, _ = champions.validate(sample(avatar="queen", color="jade"))
    assert champions.avatar_glyph(champion) == "\u265b"
    assert champions.color_hex(champion) == "#3fa66a"
    assert champions.avatar_glyph({}) == "\u265e"


def test_profiles_are_not_accepted_as_a_brain():
    champion, error = champions.validate(sample(brain={"kind": "profile", "profile": "argo"}))
    assert champion is None
    assert "Profiles are not supported" in error
    champion, error = champions.validate(sample(brain={"kind": "model", "model": "a b"}))
    assert champion is None and error


def test_persona_carries_the_brief_and_never_an_opponent():
    champion, _ = champions.validate(sample())
    said = champions.persona(champion)
    assert "Rook" in said and "Hold the line." in said
    assert "patient" in said
    assert "Reply with exactly one move" in said
    for word in ("opponent", "Mallory", "rating"):
        assert word not in said


def test_store_saves_lists_and_deletes(tmp_path):
    store = champions.ChampionStore(tmp_path)
    saved, error = store.save(sample())
    assert error == "" and saved is not None
    assert store.ids() == [saved["id"]]
    assert store.get(saved["id"])["name"] == "Rook"
    assert store.list()[0]["name"] == "Rook"
    assert store.delete(saved["id"]) is True
    assert store.list() == []
    assert store.delete("champ-../../etc") is False
    assert store.get("champ-../../etc") is None


def test_a_corrupt_file_is_skipped_not_raised(tmp_path):
    store = champions.ChampionStore(tmp_path)
    saved, _ = store.save(sample())
    (tmp_path / "champions" / "champ-deadbeef.json").write_text("{not json", encoding="utf-8")
    (tmp_path / "champions" / "champ-00000000.json").write_text("[1,2]", encoding="utf-8")
    assert set(store.ids()) == {saved["id"], "champ-00000000", "champ-deadbeef"}
    assert [item["id"] for item in store.list()] == [saved["id"]]


def test_the_store_holds_a_bounded_number_of_champions(tmp_path, monkeypatch):
    monkeypatch.setattr(champions, "MAX_CHAMPIONS", 2)
    store = champions.ChampionStore(tmp_path)
    first, _ = store.save(sample(name="One"))
    second, _ = store.save(sample(name="Two"))
    third, error = store.save(sample(name="Three"))
    assert first and second and third is None
    assert "full" in error


def test_export_and_import_round_trip_to_a_new_champion(tmp_path):
    store = champions.ChampionStore(tmp_path)
    saved, _ = store.save(sample())
    text, error = store.export(saved["id"])
    assert error == "" and "gamecenter-champion" in text

    imported, error = store.import_text(text)
    assert error == "" and imported is not None
    assert imported["id"] != saved["id"]
    assert imported["name"] == "Rook (2)"
    assert imported["brief"] == saved["brief"]

    fresh = champions.ChampionStore(tmp_path / "other")
    kept, error = fresh.import_text(text)
    assert error == "" and kept["id"] == saved["id"]


def test_hostile_imports_are_refused_or_cleaned(tmp_path):
    store = champions.ChampionStore(tmp_path)
    assert store.import_text("not json")[1] == "That is not a champion file."
    assert store.import_text("[]")[1] == "That is not a champion file."
    assert store.import_text(json.dumps({"kind": "other", "champion": {}}))[1]
    assert store.import_text("x" * (champions.MAX_IMPORT_BYTES + 1))
    assert store.import_text(None)[1]
    assert store.import_text(b"{}")[1]

    evil = sample(id="../../../../home/user/.hermes/config", name="Evil", brief="be evil")
    champion, error = store.import_text(json.dumps({"kind": "gamecenter-champion",
                                                    "schema_version": 1, "champion": evil}))
    assert error == "" and champion is not None
    assert champion["id"].startswith("champ-")
    assert store.path(champion["id"]).parent == tmp_path / "champions"
    assert not (tmp_path / "champions" / ".." / ".." / "config").exists()
