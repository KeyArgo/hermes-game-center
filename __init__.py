"""Hermes Agent plugin: Game Shelf. /games is the only game command."""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

try:
    from .shelf.catalog import Catalog, plugin_roots
    from .shelf.commands import run
    from .shelf.setup import apply_choice
    from .shelf.who import NameBook, identify
    from .shelf.fresh import load_fresh
    from .shelf import diagnostics
except ImportError:
    from shelf.fresh import load_fresh
    from shelf.catalog import Catalog, plugin_roots
    from shelf.commands import run
    from shelf.setup import apply_choice
    from shelf.who import NameBook, identify
    from shelf import diagnostics


def open_catalog(
    data_root: Path,
    settings: dict[str, Any] | None = None,
    roots: list[Path] | None = None,
    enabled=None,
) -> Catalog:
    return Catalog(roots if roots is not None else plugin_roots(), data_root, settings, enabled=enabled)


def register(ctx: Any, *, data_root: Path | None = None, roots: list[Path] | None = None) -> None:
    def root() -> Path:
        if data_root is not None:
            return data_root
        from plugins.plugin_storage import plugin_data_dir
        return plugin_data_dir("hermes-gameshelf")

    def settings() -> dict[str, Any]:
        # The person's choice in Game Center's Settings wins over the plugin config here
        # too: turning AI seats off has to mean off in chat and in the plugin's tool,
        # not only on the Desktop page.
        return apply_choice({
            "allow_ai": ctx.get_config("allow_ai", default=True),
            "role": "referee",
            "doom_wad": ctx.get_config("doom_wad", default="") or "",
        }, root())

    def enabled(plugin_id: str) -> bool:
        has = getattr(ctx, "has_plugin", None)
        if not callable(has):
            return True
        return bool(has(plugin_id))

    def catalog() -> Catalog:
        return open_catalog(root(), settings(), roots, enabled=enabled)

    _register_model_slot(ctx)

    # The diagnostic log lives in the plugin's own data folder, beside its state.
    # Opening it must never stop the plugin from loading.
    try:
        diagnostics.attach(root())
        diagnostics.start_health()
    except Exception:
        log.debug("the diagnostic log could not be opened", exc_info=True)

    # Slots: with auto-spin on, a spin happens at the moment the person's turn starts, and only
    # while the machine is on screen AND only for the chat on screen. Nothing is banked: a turn with
    # the machine closed costs nothing and earns nothing, and neither does a turn in a chat nobody is
    # looking at. The hook returns no text, so the prompt is untouched, and any failure is swallowed
    # rather than breaking the turn.
    seen_turns: list[str] = []
    # What the last turn spent, per chat, so the person's own message bets in proportion to the turn
    # before it: a message is sent before the model is asked anything, so the turn's own cost is not
    # known yet - the previous one's is the only honest number there is. Cleared as it is read.
    spent_by_session: dict[str, int] = {}

    def on_screen(wallet, kwargs: dict[str, Any], wallets) -> bool:
        """Whether this hook belongs to the chat the person is looking at.

        Every hook fires for every chat on this Hermes - a workturn, a delegated subagent, a review
        pane - which is how the machine used to turn over while the owner was reading something else.
        The desktop says which chat is on screen (``/jackpot/visible`` carries the runtime id and a
        stamp); a subagent, a missing report and a report older than ``wallet.FOCUS_TTL`` are all a
        no. One debug line when it says no, so a live run can prove the match instead of trusting it.
        """
        session = str(kwargs.get("session_id") or "")
        parent = str(kwargs.get("parent_session_id") or "")
        if parent:
            # A delegated child is not the person: whatever it costs, it never turns their machine.
            log.debug("the automatic spin skipped: chat %r is a subagent of %r", session or "none", parent)
            return False
        held = wallet.read()
        if not wallets.focused(held, session):
            log.debug("the automatic spin skipped: chat %r is not the focused chat (%r), or the report is stale",
                      session or "none", held.get("focus_session") or "none")
            return False
        return True

    def earn_pull(**kwargs: Any) -> None:
        turn = str(kwargs.get("turn_id") or "")
        if turn:
            # One spin per turn, even if Hermes asks twice for the same turn.
            if turn in seen_turns:
                return None
            seen_turns.append(turn)
            del seen_turns[:-50]
        session = str(kwargs.get("session_id") or "")
        try:
            here = Path(__file__).resolve().parent / "shelf"
            wallets = load_fresh("hermes_gameshelf_wallet", here / "wallet.py")
            slots = load_fresh("hermes_gameshelf_slotplay", here / "slotplay.py")
            wallet = wallets.Wallet(wallets.wallet_path(root()))
            if not on_screen(wallet, kwargs, wallets):
                spent_by_session.pop(session, None)
                return None
            # The person's own message: one spin, at least double the smallest bet, sized by what the
            # turn before it cost.
            tokens = spent_by_session.pop(session, 0)
            slots.autospin(wallet, kind="message", tokens=tokens, session_id=session)
        except Exception:
            diagnostics.log.error("the automatic spin after a turn did not run", exc_info=True)

    # Tokens: every API reply the person spends pays points - 10 per 1M tokens in or out, one
    # whole point per 100k - because points are the account currency that shows how much Hermes is
    # being used. A reply is counted once, judged by its own api_request_id; failures are
    # swallowed, and only the local person's wallet (the auto-spin one) ever moves. A reply does NOT
    # spin: the spin for the turn already happened when the person sent their message, and one spin
    # per intermediate model reply turned the machine into a machine gun.
    seen_requests: list[str] = []

    def earn_tokens(**kwargs: Any) -> None:
        request_id = str(kwargs.get("api_request_id") or "")
        if request_id:
            # One count per request, even if Hermes delivers the same reply twice.
            if request_id in seen_requests:
                return None
            seen_requests.append(request_id)
            del seen_requests[:-50]
        session = str(kwargs.get("session_id") or "")
        try:
            here = Path(__file__).resolve().parent / "shelf"
            wallets = load_fresh("hermes_gameshelf_wallet", here / "wallet.py")
            wallet = wallets.Wallet(wallets.wallet_path(root()))
            spent = wallets.usage_tokens(kwargs.get("usage") or {})
            # Points belong to the chat on screen too: a background chat's tokens are not something
            # the person is spending in front of this machine.
            if spent > 0 and on_screen(wallet, kwargs, wallets):
                wallet.add_tokens(spent)
                if len(spent_by_session) > 64:
                    spent_by_session.clear()
                spent_by_session[session] = spent_by_session.get(session, 0) + spent
        except Exception:
            diagnostics.log.error("the automatic spin after a reply did not run", exc_info=True)

    # Tools: the most frequent hook there is, and the cheapest, so it pays the smallest automatic
    # bet. One spin per burst: a run of parallel tool calls is one moment to the ear, and spinning
    # on each of them turns the machine into a machine gun. Before this hook existed nothing spun
    # while tools ran: no tool hook was registered at all.
    last_tool_spin = [0.0]

    def earn_tool(**kwargs: Any) -> None:
        now = time.monotonic()
        if now - last_tool_spin[0] < 1.2:
            return None
        last_tool_spin[0] = now
        try:
            here = Path(__file__).resolve().parent / "shelf"
            wallets = load_fresh("hermes_gameshelf_wallet", here / "wallet.py")
            slots = load_fresh("hermes_gameshelf_slotplay", here / "slotplay.py")
            wallet = wallets.Wallet(wallets.wallet_path(root()))
            if not on_screen(wallet, kwargs, wallets):
                return None
            slots.autospin(wallet, kind="tool", session_id=str(kwargs.get("session_id") or ""))
        except Exception:
            diagnostics.log.error("the automatic spin after a tool call did not run", exc_info=True)

    register_hook = getattr(ctx, "register_hook", None)
    if callable(register_hook):
        register_hook("pre_llm_call", earn_pull)
        register_hook("pre_tool_call", earn_tool)
        register_hook("post_api_request", earn_tokens)

    # Winning a game is worth 100 bonus points to the person who won it. kit calls this
    # sink with the finished state of every won game; the wallet is the local person's,
    # so a win on this machine credits them. Bonus points convert at 75% either way.
    WIN_BONUS = 100

    def award_win(state: dict) -> None:
        try:
            here = Path(__file__).resolve().parent / "shelf"
            wallets = load_fresh("hermes_gameshelf_wallet", here / "wallet.py")
            wallets.Wallet(wallets.wallet_path(root())).award_bonus(WIN_BONUS)
        except Exception:
            diagnostics.log.error("the win bonus was not awarded", exc_info=True)

    try:
        import kit as kit_module
        kit_module.set_bonus_sink(award_win)
    except Exception:
        log.debug("the win-bonus sink could not be registered", exc_info=True)

    def on_games(raw: str = "", **kwargs: Any) -> str:
        book = NameBook(root() / "players.json")
        player = identify(kwargs.get("platform") or "", kwargs.get("source"), book)
        return run(
            catalog(),
            raw,
            source="command",
            complete=_complete(ctx, settings),
            player=player,
            names=book,
        )

    ctx.register_command(
        "games",
        on_games,
        "Game Center. /games lists the store. /games install connect4. /games connect4 new",
        args_hint="install connect4 | connect4 new | looking reversi",
        argument_mode="text",
    )

    def games_play(args: dict, **kwargs: Any) -> str:
        del kwargs
        if not isinstance(args, dict):
            return json.dumps({"ok": False, "reason": "bad_args"})
        game_id = str(args.get("game") or "")
        line = str(args.get("line") or "")
        text = run(catalog(), f"{game_id} {line}".strip(), source="tool", complete=_complete(ctx, settings))
        return json.dumps({"ok": True, "text": text})

    ctx.register_tool(
        name="games_play",
        toolset="hermes_gameshelf",
        schema={
            "name": "games_play",
            "description": (
                "Play a game on the Game Shelf. The person plays, or they type "
                "/games allow-ai before an AI takes a seat."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "game": {"type": "string"},
                    "line": {"type": "string", "description": "The game command, such as move e4"},
                },
                "required": ["game", "line"],
            },
        },
        handler=games_play,
    )


MODEL_SLOT = "gameshelf_opponent"
_MODEL_SLOT_REGISTERED = False


def _register_model_slot(ctx: Any) -> bool:
    """Give "Your agent" its own entry in Hermes's model picker. Unset, it follows the main model."""
    global _MODEL_SLOT_REGISTERED
    _MODEL_SLOT_REGISTERED = False
    register = getattr(ctx, "register_auxiliary_task", None)
    if not callable(register):
        return False
    try:
        register(
            MODEL_SLOT,
            display_name="Game Shelf opponent",
            description="The model that plays \"Your agent\" in Game Shelf board games. Pick a cheap or free one.",
        )
    except Exception:
        return False
    _MODEL_SLOT_REGISTERED = True
    return True


# kit.py asks for two different things with the same complete() call: a legal
# move (an agent seat) and one explaining sentence (a hint). The request's own
# last line says which, so the system message can match it. A move answer has to
# be a bare move; an explanation has to be a sentence, and telling the model
# "one legal move" would make it answer a hint with a move.
_MOVE_ASK = "Reply with exactly one legal move"
_EXPLAIN_ASK = "In one short sentence"

_GENERIC_SYSTEM = "You help with a board game. Follow the request exactly and keep it short."
_MOVE_SYSTEM = (
    "You play one seat in a board game. Reply with exactly one move from the "
    "legal moves you are given and nothing else: no sentence, no explanation."
)
_EXPLAIN_SYSTEM = (
    "You are a friendly board-game teacher talking to someone who has never "
    "played. Reply with one short, plain sentence of 25 words or fewer, and "
    "nothing else: no lists, no move numbers, no jargon."
)


def _style(prompt: str) -> tuple[str, int]:
    """The system message and token budget for the request in ``prompt``."""
    if _EXPLAIN_ASK in prompt:
        return _EXPLAIN_SYSTEM, 60
    if _MOVE_ASK in prompt:
        return _MOVE_SYSTEM, 80
    return _GENERIC_SYSTEM, 80


def _complete(ctx: Any, settings):
    """The model door, or None when this context has no LLM surface at all.

    This once returned a closure unconditionally, so on a context without ``ctx.llm`` the call raised
    AttributeError deep inside whatever asked for a completion, and the Doctrine author turned that
    into "That profile did not answer." — advice about a profile that was never involved. None is the
    honest answer, and every caller already has a sentence for it.
    """
    del settings
    if getattr(ctx, "llm", None) is None:
        return None

    def complete(prompt: str, max_tokens: int = 0) -> dict[str, Any]:
        system, budget = _style(prompt)
        if max_tokens:
            budget = int(max_tokens)
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ]
        kwargs: dict[str, Any] = {"messages": messages, "max_tokens": budget, "purpose": "hermes-gameshelf"}
        if _MODEL_SLOT_REGISTERED:
            kwargs["task"] = MODEL_SLOT
        result = ctx.llm.complete(**kwargs)
        usage = getattr(result, "usage", None)
        tokens = int(usage.get("total_tokens") or 0) if isinstance(usage, dict) else int(getattr(usage, "total_tokens", 0) or 0)
        return {"move": str(getattr(result, "text", "") or ""), "remark": "", "tokens": tokens}

    return complete
