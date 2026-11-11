"""Each online table keeps its own chips.

Before this fix, every room under one data root resolved its wallet to the same file
(``data_root/rooms/wallet.json``), so two tables spent one balance. These tests pin the
isolated online behaviour and the shared local behaviour it had to preserve.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

from online.rooms import Rooms
from online.store import Store

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


blackjack = _load("blackjack_rules_wallet", ROOT / "blackjack/game.py")


def chips_at(path: Path) -> int:
    return json.loads(path.read_text(encoding="utf-8"))["chips"]


def two_rooms(tmp_path):
    store = Store(tmp_path / "online.sqlite3")
    loaded = Rooms(store, tmp_path, games=None)
    alice, _ = store.create_player("Alice")
    bob, _ = store.create_player("Bob")
    a, why_a = loaded.create("blackjack", alice, public=True)
    b, why_b = loaded.create("blackjack", bob, public=True)
    assert a and b, (why_a, why_b)
    return loaded, a, b


def test_each_online_room_owns_a_distinct_wallet(tmp_path):
    loaded, a, b = two_rooms(tmp_path)

    wallet_a = loaded.table(a).rules._wallet().path
    wallet_b = loaded.table(b).rules._wallet().path

    assert wallet_a == loaded.folder(a["id"]) / "wallet.json"
    assert wallet_b == loaded.folder(b["id"]) / "wallet.json"
    assert wallet_a != wallet_b


def test_a_bet_in_one_room_does_not_spend_another_rooms_chips(tmp_path):
    loaded, a, b = two_rooms(tmp_path)

    wallet_a = loaded.table(a).rules._wallet()
    wallet_b = loaded.table(b).rules._wallet()
    assert wallet_a.path != wallet_b.path, "two rooms must not share one wallet file"

    before = wallet_b.read()["chips"]
    # Spend at table A only.
    assert wallet_a.debit(25) is True

    # B's balance is untouched, and A's file is the one that changed.
    assert wallet_b.read()["chips"] == before
    assert chips_at(wallet_a.path) == before - 25


def test_local_create_still_shares_the_profile_wallet(tmp_path):
    """Local play keeps one chips file per profile; only online is isolated."""
    root = tmp_path / "shelf" / "blackjack"
    blackjack.create(root)
    assert blackjack._wallet().path == root.parent / "wallet.json"


def test_create_honours_an_explicit_wallet_setting(tmp_path):
    root = tmp_path / "rooms" / "abc"
    given = root / "wallet.json"
    blackjack.create(root, {"wallet": str(given)})
    assert blackjack._wallet().path == given
