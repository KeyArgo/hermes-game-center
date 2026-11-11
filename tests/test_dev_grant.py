"""The developer top-up is local, keyed, and leaves nothing usable in the source.

Owner's requirement, 2026-11-09: "add a developer cheat so I can inject myself with more tokens ...
has to be hackproof for anyone who downloads the source code, so the password must not be seen in
the repo". These tests pin the three properties that make that true: no secret in the repo, no key
means no grant, and a wrong passphrase grants nothing.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from shelf import devgrant  # noqa: E402
from shelf.wallet import START_CHIPS, Wallet, wallet_path  # noqa: E402


def test_no_secret_is_stored_in_the_repository() -> None:
    """The repo may describe the scheme but must never contain a working key or passphrase."""
    for path in (ROOT / "shelf" / "devgrant.py", ROOT / "scripts" / "dev-grant.py"):
        text = path.read_text(encoding="utf-8")
        assert '"hash":' not in text or 'base64.b64decode(raw["hash"])' in text, path
        assert "gameshelf-dev.key" in text, "the key file's location is named, its contents are not"
    # Nothing that looks like a written key has been committed anywhere in the tree.
    for path in (ROOT).rglob("*.key"):
        raise AssertionError(f"a key file is inside the repository: {path}")


def test_without_a_key_nothing_is_armed_or_accepted(tmp_path: Path) -> None:
    assert devgrant.armed(tmp_path) is False
    assert devgrant.check("anything at all", tmp_path) is False
    assert devgrant.read_key(tmp_path) is None


def test_a_key_holds_a_hash_not_the_passphrase(tmp_path: Path) -> None:
    passphrase = "correct horse battery staple"
    path = devgrant.make_key(passphrase, tmp_path)
    text = path.read_text(encoding="utf-8")
    assert passphrase not in text, "the passphrase itself is never written"
    raw = json.loads(text)
    assert raw["kdf"] == "scrypt" and raw["salt"] and raw["hash"]
    assert devgrant.armed(tmp_path) is True
    assert devgrant.check(passphrase, tmp_path) is True
    assert devgrant.check(passphrase + "x", tmp_path) is False
    assert devgrant.check("", tmp_path) is False


def test_a_short_passphrase_is_refused(tmp_path: Path) -> None:
    for weak in ("", "short", "1234567"):
        try:
            devgrant.make_key(weak, tmp_path)
        except ValueError:
            continue
        raise AssertionError(f"a short passphrase was accepted: {weak!r}")


def test_a_grant_adds_chips_and_nothing_else(tmp_path: Path) -> None:
    wallet = Wallet(wallet_path(tmp_path))
    before = wallet.read()
    held = wallet.grant(50_000)
    assert held["chips"] == before["chips"] + 50_000
    assert held["bonus"] == before["bonus"] and held["tokens_total"] == before["tokens_total"]
    assert held["spins"] == before["spins"], "a top-up is not a spin and must not touch the feed"
    # And the stack stays where it was put: the next read, a fresh Wallet, sees it.
    assert Wallet(wallet_path(tmp_path)).read()["chips"] == START_CHIPS + 50_000


def test_a_grant_of_nothing_changes_nothing(tmp_path: Path) -> None:
    wallet = Wallet(wallet_path(tmp_path))
    before = wallet.read()
    assert wallet.grant(0)["chips"] == before["chips"]
    assert wallet.grant(-500)["chips"] == before["chips"]


def test_the_overlay_does_not_refill_behind_the_arcade(tmp_path: Path) -> None:
    """An empty wallet stays empty, so the comeback tray is the way back.

    Owner's ask, 2026-11-09: "make my chips run out so I can test the come back arcade". A silent
    refill would reset the wallet mid-session and the tray would never appear.
    """
    from shelf import slotplay

    for autobet in (True, False):
        wallet = Wallet(wallet_path(tmp_path / f"broke-{autobet}"))
        with wallet._held() as data:
            data["chips"] = 10
            data["bet"] = 25
            data["autoplay"] = True
            data["visible"] = True
            data["autobet"] = autobet
        assert slotplay.spin(wallet, bet=25) is None, "no spin is dealt on credit"
        assert slotplay.autospin(wallet, kind="turn") is None, "nor on the automatic path"
        held = wallet.read()
        assert held["chips"] == 10, "the wallet is left exactly as it was"
        assert held["spins"] == 0, "nothing was recorded"
