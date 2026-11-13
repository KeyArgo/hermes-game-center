"""Easter eggs pay once per person, only when they are the egg actually showing.

Owner's ask, 2026-11-09: "find easter eggs that show up randomly through game center that gives the
user points if they find. we can update them every now and again but one user can use them once, and
each can pay out as much as 10k in points or as little as 1k."

These tests pin the three rules that make that a real find rather than a button: the catalogue pays
inside 1,000-10,000, the wallet refuses a second find of the same egg, and the schedule cannot be
rerolled by asking again in the same hour.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from shelf import eggs  # noqa: E402
from shelf.wallet import Wallet, wallet_path  # noqa: E402


def test_every_egg_pays_between_one_and_ten_thousand_points() -> None:
    assert len(eggs.EGGS) >= 5, "a catalogue worth updating"
    for egg in eggs.EGGS:
        assert 1000 <= egg["points"] <= 10000, egg
        assert egg["hint"] and egg["where"], egg
    assert len({egg["id"] for egg in eggs.EGGS}) == len(eggs.EGGS), "ids are unique"


def test_the_same_hour_always_shows_the_same_answer() -> None:
    """Refreshing cannot reroll the schedule: the hour is the unit of the draw."""
    hour = 486_000
    first = eggs.current(hour)
    for _ in range(20):
        assert eggs.current(hour) == first
    if first is not None:
        assert first["ends_at"] == (hour + 1) * 3600


def test_about_one_hour_in_eight_has_an_egg() -> None:
    hours = [eggs.current(hour) for hour in range(486_000, 486_000 + 4000)]
    out = sum(1 for egg in hours if egg is not None)
    share = out / len(hours)
    assert 0.06 <= share <= 0.20, f"one hour in eight was promised, got {share:.1%}"


def test_a_person_finds_each_egg_once(tmp_path: Path) -> None:
    wallet = Wallet(wallet_path(tmp_path))
    before = wallet.read()["bonus"]
    first = wallet.claim_egg("wing-in-the-glass", 1000)
    assert first["claimed"] is True and first["points"] == 1000
    assert wallet.read()["bonus"] == before + 1000
    second = wallet.claim_egg("wing-in-the-glass", 1000)
    assert second["claimed"] is False and second["points"] == 0
    assert wallet.read()["bonus"] == before + 1000, "the second click pays nothing"


def test_a_new_egg_still_pays_someone_who_found_an_old_one(tmp_path: Path) -> None:
    """The record is which eggs, not how many: the catalogue can grow without re-paying."""
    wallet = Wallet(wallet_path(tmp_path))
    assert wallet.claim_egg("wing-in-the-glass", 1000)["claimed"] is True
    assert wallet.claim_egg("the-argo-stamp", 10000)["claimed"] is True
    assert sorted(wallet.eggs_found()) == ["the-argo-stamp", "wing-in-the-glass"]


def test_nonsense_claims_pay_nothing(tmp_path: Path) -> None:
    wallet = Wallet(wallet_path(tmp_path))
    assert wallet.claim_egg("", 5000)["claimed"] is False
    assert wallet.claim_egg("wing-in-the-glass", 0)["claimed"] is False
    assert wallet.claim_egg("wing-in-the-glass", -50)["claimed"] is False
    assert wallet.read()["bonus"] == 0


def test_the_found_list_survives_a_reload(tmp_path: Path) -> None:
    path = wallet_path(tmp_path)
    Wallet(path).claim_egg("quiet-owl", 2500)
    assert Wallet(path).eggs_found() == ["quiet-owl"]


def test_a_find_survives_a_downgrade(tmp_path: Path) -> None:
    """Rolling the plugin back must not erase a find.

    The record lives in the wallet file, and a version that has never heard of a key still writes the
    file when anything changes. Unknown keys are carried through for exactly this reason: without it,
    going back to an older commit and spending a chip would drop `eggs_found` and let the same egg pay
    twice (owner's ask, 2026-11-09: "even if they go back and forth between commits or updates they
    cannot cheat as we keep records of which easter eggs they redeemed").
    """
    import json

    path = wallet_path(tmp_path)
    Wallet(path).claim_egg("the-argo-stamp", 10000)

    # An older build, driven through the same file: it knows nothing about eggs, so stand in for it by
    # touching a field it does know and letting the loader carry the rest.
    older = Wallet(path)
    older.set_bet(50)
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["eggs_found"] == ["the-argo-stamp"], "the record outlived the write"
    assert saved["bonus"] == 10000, "and so did the points it paid"


def test_an_unknown_future_key_is_kept_verbatim(tmp_path: Path) -> None:
    import json

    path = wallet_path(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"chips": 500, "bet": 25, "league_rank": {"season": 3}}), encoding="utf-8")
    wallet = Wallet(path)
    wallet.set_bet(100)
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["league_rank"] == {"season": 3}, "a key this version does not use is not deleted"


def test_the_rebellion_mark_is_a_five_thousand_point_picture_egg() -> None:
    egg = eggs.find("rebellion-mark")
    assert egg and egg["points"] == 5000, "the owner priced it at 5k"
    assert egg["art"] == "NOUS", "it is drawn as the Nous stamp the reels already use"
    assert not egg.get("word"), "the artwork carries its own slogan: nothing is printed over it"


def test_the_rebellion_mark_pays_once_like_any_other(tmp_path: Path) -> None:
    wallet = Wallet(wallet_path(tmp_path))
    first = wallet.claim_egg("rebellion-mark", 5000)
    assert first["claimed"] is True and first["points"] == 5000
    assert wallet.claim_egg("rebellion-mark", 5000)["claimed"] is False
