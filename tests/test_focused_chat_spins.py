"""The over-chat machine spins for the chat the person is LOOKING AT, and for no other.

The coding lanes spin the owner's slot: every hook fires for every chat on the machine, so a
workturn in a side chat, a subagent, or a review pane turned the machine over and over while the
person was reading something else. The desktop already posts which surface is showing a machine;
it now says which chat is on screen too (the RUNTIME id the hooks carry), and the shelf refuses
every spin and every point that does not belong to that chat and that fresh report.

Pinned here:

* a chat that is not the focused one spins nothing and earns no points, and a subagent never spins;
* the focused chat spins: a tool call at the smallest bet, the person's own message at least double;
* an intermediate model reply credits points and does NOT spin a second time;
* a focus report older than the shelf's own window spins nothing, so a closed window cannot keep
  the machine turning;
* the skip is logged once at debug, so the match can be proved on a live run.
"""

from __future__ import annotations

import importlib.util
import logging
import time
from pathlib import Path
from types import SimpleNamespace

from shelf import autobet, wallet as wallets
from shelf.slotplay import MIN_BET, autospin
from shelf.wallet import Wallet, wallet_path

ROOT = Path(__file__).resolve().parents[1]

# The chat the person is looking at, in the runtime ids the hooks carry (never a stored id).
FOCUSED = "runtime-chat-a"
ELSEWHERE = "runtime-chat-b"


def _hooks(tmp_path: Path, name: str = "gameshelf_focus_plugin") -> dict:
    """The hooks the plugin really registers, taken from the real register()."""
    spec = importlib.util.spec_from_file_location(name, ROOT / "__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(plugin)
    hooks: dict[str, list] = {}

    def register_hook(hook, fn):
        hooks.setdefault(hook, []).append(fn)

    ctx = SimpleNamespace(
        get_config=lambda key, default=None: default,
        register_hook=register_hook,
        register_command=lambda *args, **kwargs: None,
        register_tool=lambda *args, **kwargs: None,
    )
    plugin.register(ctx, data_root=tmp_path)
    return hooks


def _armed(tmp_path: Path, session: str = FOCUSED) -> Wallet:
    """A wallet with auto-spin on, the cabinet on screen and `session` on the other side of it."""
    wallet = Wallet(wallet_path(tmp_path))
    wallet.set_autoplay(True)
    wallet.set_bet(MIN_BET)
    wallet.set_visible(True, "jackpot2", session_id=session)
    return wallet


def _turn(hooks: dict, session: str = FOCUSED, turn: str = "t1", **extra) -> None:
    hooks["pre_llm_call"][0](turn_id=turn, session_id=session, **extra)


def _tool(hooks: dict, session: str = FOCUSED) -> None:
    hooks["pre_tool_call"][0](tool_name="terminal", args={"command": "ls"}, session_id=session)


def _reply(hooks: dict, session: str = FOCUSED, request: str = "r1", tokens: int = 250_000) -> None:
    hooks["post_api_request"][0](api_request_id=request, session_id=session,
                                 usage={"total_tokens": tokens})


# ---- only the chat on screen ------------------------------------------------


def test_a_chat_that_is_not_focused_spins_nothing_and_earns_nothing(tmp_path: Path) -> None:
    hooks = _hooks(tmp_path)
    before = _armed(tmp_path).read()
    _turn(hooks, ELSEWHERE)
    _tool(hooks, ELSEWHERE)
    _reply(hooks, ELSEWHERE)
    held = Wallet(wallet_path(tmp_path)).read()
    assert held["spins"] == 0, "a chat nobody is looking at spun the machine"
    assert held["chips"] == before["chips"], held
    assert held["bonus"] == 0 and held["tokens_total"] == 0, \
        f"points were paid to a chat nobody is looking at: {held['bonus']} points"


def test_the_focused_chat_spins_a_turn_and_a_tool_call(tmp_path: Path) -> None:
    hooks = _hooks(tmp_path)
    _armed(tmp_path)
    _turn(hooks)
    assert Wallet(wallet_path(tmp_path)).read()["spins"] == 1, "the focused chat's turn did not spin"
    _tool(hooks)
    assert Wallet(wallet_path(tmp_path)).read()["spins"] == 2, "the focused chat's tool call did not spin"


def test_a_reply_credits_points_and_does_not_spin_a_second_time(tmp_path: Path) -> None:
    """One spin per turn - the person's message - not one per intermediate model reply."""
    hooks = _hooks(tmp_path)
    _armed(tmp_path)
    _turn(hooks)
    _tool(hooks)
    after_turn_and_tool = Wallet(wallet_path(tmp_path)).read()
    _reply(hooks, tokens=250_000)
    held = Wallet(wallet_path(tmp_path)).read()
    assert held["spins"] == after_turn_and_tool["spins"], "an intermediate reply spun the machine too"
    assert held["bonus"] == 2, f"the reply's 250k tokens did not pay two points: {held['bonus']}"


def test_a_focus_report_older_than_the_shelf_window_spins_nothing(tmp_path: Path) -> None:
    hooks = _hooks(tmp_path)
    wallet = _armed(tmp_path)
    with wallet._held() as data:  # noqa: SLF001 - the test ages the stamp the desktop wrote
        data["focus_at"] = int(time.time()) - (wallets.FOCUS_TTL + 1)
    _turn(hooks)
    _tool(hooks)
    _reply(hooks)
    held = Wallet(wallet_path(tmp_path)).read()
    assert held["spins"] == 0, "a stale focus report kept the machine spinning"
    assert held["bonus"] == 0, "points were paid off a stale focus report"


def test_a_subagent_never_spins(tmp_path: Path) -> None:
    """The person is looking at their own chat; a delegated child is not it, even stamped as it."""
    hooks = _hooks(tmp_path)
    _armed(tmp_path)
    _turn(hooks, session="runtime-child", parent_session_id=FOCUSED, turn="t1")
    _turn(hooks, session=FOCUSED, parent_session_id=FOCUSED, turn="t2")
    assert Wallet(wallet_path(tmp_path)).read()["spins"] == 0, "a subagent's turn spun the machine"
    # ...and the person's own turn still spins, so the gate is about the child, not about the focus.
    _turn(hooks, session=FOCUSED, turn="t3")
    assert Wallet(wallet_path(tmp_path)).read()["spins"] == 1


def test_no_focus_report_at_all_spins_nothing(tmp_path: Path) -> None:
    hooks = _hooks(tmp_path)
    wallet = Wallet(wallet_path(tmp_path))
    wallet.set_autoplay(True)
    wallet.set_bet(MIN_BET)
    wallet.set_visible(True, "jackpot2")  # an older desktop: it says the machine is up, not the chat
    _turn(hooks)
    _tool(hooks)
    held = wallet.read()
    assert held["spins"] == 0 and held["chips"] == wallet.read()["chips"]


def test_the_skip_is_logged_once_at_debug(tmp_path: Path, caplog) -> None:
    """So a live run can prove the match instead of being asked to trust it."""
    hooks = _hooks(tmp_path)
    _armed(tmp_path)
    with caplog.at_level(logging.DEBUG):
        _turn(hooks, ELSEWHERE)
    said = caplog.text.lower()
    assert "focus" in said and ELSEWHERE in caplog.text, \
        f"the skipped spin said nothing useful: {caplog.text!r}"


# ---- the bets: a tool call is cheap, the person's own message is not -------


def test_a_tool_call_is_the_smallest_bet_and_a_message_at_least_double(tmp_path: Path) -> None:
    hooks = _hooks(tmp_path)
    wallet = _armed(tmp_path)
    _turn(hooks)
    message = wallet.read()["feed"][0]
    _tool(hooks)
    tool = wallet.read()["feed"][0]
    assert tool["bet"] == MIN_BET, f"a tool call is the cheapest hook: {tool['bet']}"
    assert message["bet"] >= MIN_BET * 2, f"the person's own message bet only {message['bet']}"
    assert autobet.stake_for("message", 0, MIN_BET) >= MIN_BET * 2
    assert autobet.stake_for("message", 400_000, MIN_BET) > MIN_BET * 2


def test_a_bigger_turn_bets_more_than_a_small_one(tmp_path: Path) -> None:
    hooks = _hooks(tmp_path)
    wallet = _armed(tmp_path)
    _reply(hooks, request="r1", tokens=30_000)
    _turn(hooks, turn="t1")
    small = wallet.read()["feed"][0]["bet"]
    _reply(hooks, request="r2", tokens=900_000)
    _turn(hooks, turn="t2")
    big = wallet.read()["feed"][0]["bet"]
    assert big > small, f"a 900k turn bet {big} against a 30k turn's {small}"


# ---- the desktop's side of it ----------------------------------------------


def test_the_desktop_reports_the_runtime_chat_of_the_machine_on_screen() -> None:
    """The hooks carry a runtime id, so that is the id the page has to send - not a stored one."""
    machine = (ROOT / "desktop" / "src" / "18-jackpot2-machine.js").read_text(encoding="utf-8")
    assert "host.state.focusedSessionId" in machine, "the page never reads the focused chat"
    assert "host.state.focusedStoredSessionId" not in machine, "a stored id would never match the hooks"
    assert "session_id: gcFocusedChat()" in machine, "the visible report does not carry the chat"
    # Re-sent when the focus moves and every 20 s, so the 60 s stamp cannot go stale on its own.
    assert "gcRepeatFocus" in machine, "the report is sent once and then left to go stale"
    assert "gcRepeatFocus(() => jp2Visible(0, ctx))" in machine
    overlay = (ROOT / "desktop" / "src" / "19-jackpot-overlay.js").read_text(encoding="utf-8")
    assert "session_id: gcFocusedChat()" in overlay, "the original machine reports no chat either"
    assert "gcRepeatFocus" in overlay


def test_the_visible_route_stamps_the_chat_it_is_told(tmp_path: Path, monkeypatch) -> None:
    from dashboard import plugin_api

    monkeypatch.setattr(plugin_api, "_jackpot_wallet", lambda: Wallet(wallet_path(tmp_path)))
    plugin_api.jackpot_autoplay({"on": True})
    plugin_api.jackpot_visible({"on": True, "source": "jackpot2", "session_id": FOCUSED})
    wallet = Wallet(wallet_path(tmp_path))
    assert wallet.read()["focus_session"] == FOCUSED, "the route dropped the chat it was told"
    assert autospin(wallet, kind="tool", session_id=FOCUSED) is not None, "the stamped chat does not spin"
    assert autospin(wallet, kind="tool", session_id=ELSEWHERE) is None, "another chat spins too"


def test_a_report_without_a_chat_leaves_the_last_one_alone(tmp_path: Path) -> None:
    """The original machine's post says 'a machine is up', not 'this chat is the one'."""
    wallet = Wallet(wallet_path(tmp_path))
    wallet.set_visible(True, "jackpot2", session_id=FOCUSED)
    wallet.set_visible(True, "slots")
    assert wallet.read()["focus_session"] == FOCUSED
