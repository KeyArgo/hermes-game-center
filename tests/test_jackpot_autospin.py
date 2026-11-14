"""Jackpot v2 spins itself on the hook path, and only while a machine is on screen.

The automatic spin was not working, and it was not the hook path - that had been spinning the old
machine for days - it was the gate in front of it. Every automatic spin in
``shelf/slotplay.py`` refuses unless the wallet says a machine is on screen, and the only surface that
ever said so was the ORIGINAL copy over the chat (``19-jackpot-overlay.js``). With the Jackpot cabinet
up - the usual case, and the only case with the original copy off - nothing reported visibility, so
``autospin()`` returned None at every hook and the reels sat still through a whole conversation.

Three things are pinned here, in the order the brief asks for them:

* the hook path is the plugin's own (pre_llm_call for a turn, pre_tool_call for a tool call,
  post_api_request for the reply) and it is what spins: no timer, no polling loop, no route that
  spins on a clock;
* the Jackpot cabinet's own surface ('jackpot2') is enough on its own, and it is independent of the
  original copy's flag ('slots') - one closing cannot switch the automatic spin off while the other
  is still drawn;
* a wallet that cannot cover the bet does not spin at all, and nothing is taken.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest

from shelf.slotplay import MIN_BET, autospin
from shelf.wallet import START_CHIPS, Wallet, wallet_path

ROOT = Path(__file__).resolve().parents[1]


def _hooks(tmp_path: Path) -> dict:
    """The hooks the plugin really registers, taken from the real register()."""
    spec = importlib.util.spec_from_file_location("gameshelf_autospin_plugin", ROOT / "__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(plugin)
    hooks: dict[str, list] = {}

    def register_hook(name, fn):
        hooks.setdefault(name, []).append(fn)

    ctx = SimpleNamespace(
        get_config=lambda key, default=None: default,
        register_hook=register_hook,
        register_command=lambda *args, **kwargs: None,
        register_tool=lambda *args, **kwargs: None,
    )
    plugin.register(ctx, data_root=tmp_path)
    return hooks


def _armed(tmp_path: Path, source: str = "jackpot2") -> Wallet:
    """A wallet with auto-spin on and one surface on screen - the cabinet, by default."""
    wallet = Wallet(wallet_path(tmp_path))
    wallet.set_autoplay(True)
    wallet.set_bet(MIN_BET)
    wallet.set_visible(True, source)
    return wallet


# ---- the feed: the plugin's own hook path ------------------------------------


def test_the_plugin_registers_the_three_hooks_the_feed_comes_from(tmp_path: Path) -> None:
    hooks = _hooks(tmp_path)
    for name in ("pre_llm_call", "pre_tool_call", "post_api_request"):
        assert hooks.get(name), f"{name} is not registered: nothing would spin on it"


def test_the_cabinet_being_on_screen_is_enough_for_the_reply_to_spin(tmp_path: Path) -> None:
    """The defect, in one test: with only the Jackpot cabinet drawn, the reply hook spins."""
    hooks = _hooks(tmp_path)
    wallet = _armed(tmp_path, "jackpot2")
    assert wallet.read()["visible"] is True
    before = wallet.read()["chips"]
    hooks["post_api_request"][0](api_request_id="r1", usage={"total_tokens": 40_000})
    held = wallet.read()
    assert held["spins"] == 1, "the reply did not spin with the cabinet on screen"
    assert held["chips"] != before or held["feed"], held
    assert held["feed"] and held["feed"][0]["auto"] is True, "the spin the cabinet animates is the reply's"


def test_a_tool_call_spins_too_and_a_turn_starts_one(tmp_path: Path) -> None:
    hooks = _hooks(tmp_path)
    _armed(tmp_path, "jackpot2")
    hooks["pre_llm_call"][0](turn_id="t1")
    assert Wallet(wallet_path(tmp_path)).read()["spins"] == 1, "the turn did not spin"
    hooks["pre_tool_call"][0](tool_name="terminal", args={"command": "ls"})
    assert Wallet(wallet_path(tmp_path)).read()["spins"] == 2, "the tool call did not spin"


def test_nothing_spins_while_no_machine_is_on_screen(tmp_path: Path) -> None:
    """The gate that was in the way: no surface on screen, no automatic spin, nothing taken."""
    hooks = _hooks(tmp_path)
    wallet = Wallet(wallet_path(tmp_path))
    wallet.set_autoplay(True)
    wallet.set_visible(False, "jackpot2")
    before = wallet.read()["chips"]
    hooks["post_api_request"][0](api_request_id="r1", usage={"total_tokens": 40_000})
    hooks["pre_tool_call"][0](tool_name="terminal", args={"command": "ls"})
    held = wallet.read()
    assert held["spins"] == 0 and held["chips"] == before, "a spin happened with nothing on screen"
    assert held["bonus"] == 0 or held["tokens_total"] == 40_000, "the points still counted"


def test_the_points_still_rack_up_while_the_machine_is_shut(tmp_path: Path) -> None:
    """Shut machine: no spin, but the tokens the person spent are still worth points."""
    hooks = _hooks(tmp_path)
    hooks["post_api_request"][0](api_request_id="r1", usage={"total_tokens": 250_000})
    held = Wallet(wallet_path(tmp_path)).read()
    assert held["bonus"] == 2 and held["chips"] == START_CHIPS


def test_one_surface_closing_does_not_stop_the_other(tmp_path: Path) -> None:
    """Two machines may float at once, so the flags are separate."""
    wallet = _armed(tmp_path, "jackpot2")
    wallet.set_visible(True, "slots")
    assert wallet.read()["visible_sources"] == {"jackpot2": True, "slots": True}

    wallet.set_visible(False, "slots")
    assert wallet.read()["visible"] is True, "the cabinet is still drawn: the spin must still run"
    assert autospin(wallet, kind="turn") is not None

    wallet.set_visible(False, "jackpot2")
    assert wallet.read()["visible"] is False, "nothing is drawn now"
    assert autospin(wallet, kind="turn") is None


def test_the_original_copies_own_flag_is_what_an_older_caller_writes(tmp_path: Path) -> None:
    """set_visible(on) with no source is the original copy - the call the old overlay posts."""
    wallet = Wallet(wallet_path(tmp_path))
    wallet.set_autoplay(True)
    wallet.set_visible(True)
    assert wallet.read()["visible_sources"] == {"slots": True}
    assert autospin(wallet, kind="turn") is not None


def test_a_wallet_file_from_before_surfaces_existed_still_reads_as_visible(tmp_path: Path) -> None:
    path = wallet_path(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"chips": 500, "autoplay": true, "visible": true}', encoding="utf-8")
    wallet = Wallet(path)
    held = wallet.read()
    assert held["visible"] is True and held["visible_sources"] == {"slots": True}
    assert autospin(wallet, kind="turn") is not None, "an older wallet keeps spinning as it did"


# ---- chips short: no spin, and nothing taken --------------------------------


def test_a_wallet_that_cannot_cover_the_bet_does_not_spin(tmp_path: Path) -> None:
    hooks = _hooks(tmp_path)
    wallet = _armed(tmp_path, "jackpot2")
    wallet.debit(wallet.read()["chips"] - (MIN_BET - 1))
    before = wallet.read()
    hooks["post_api_request"][0](api_request_id="r1", usage={"total_tokens": 40_000})
    hooks["pre_tool_call"][0](tool_name="terminal", args={"command": "ls"})
    held = wallet.read()
    assert held["spins"] == 0, "a spin happened with less than the smallest bet in the wallet"
    assert held["chips"] == before["chips"], "chips were taken for a spin that did not happen"
    assert autospin(wallet, kind="turn") is None


def test_the_hook_path_never_waits_on_a_timer(tmp_path: Path) -> None:
    """No idle timer: the spin comes from the hooks, and the plugin starts no clock of its own.

    A machine that spins because time passed is the thing the brief forbids. The plugin's own source
    is the place that can be checked for it: nothing in it may schedule work (no thread, no timer, no
    sleep), so the only door to ``autospin`` is a hook Hermes called.
    """
    source = (ROOT / "__init__.py").read_text(encoding="utf-8")
    for forbidden in ("import threading", "import asyncio", "Timer(", "time.sleep", "while True", "schedule("):
        assert forbidden not in source, f"the plugin schedules work of its own: {forbidden!r}"
    # ...and every automatic spin sits inside a hook body, not in a registration or a command.
    assert source.count("slots.autospin(") == 3, "the automatic spin left the three hooks"
    for window in ("earn_pull", "earn_tool", "earn_tokens"):
        assert window in source


@pytest.mark.parametrize("kind", ["turn", "tool", "reply"])
def test_every_hook_kind_spends_the_bet_it_is_meant_to(tmp_path: Path, kind: str) -> None:
    """Auto-bet still sizes the stake per hook: the feed did not change what a spin costs."""
    wallet = _armed(tmp_path, "jackpot2")
    row = autospin(wallet, kind=kind, tokens=2_000_000 if kind == "reply" else 0)
    assert row is not None
    assert row["bet"] >= MIN_BET and row["bet"] % MIN_BET == 0, row
    if kind == "reply":
        assert row["bet"] > MIN_BET, "an expensive reply is worth more than the smallest bet"
