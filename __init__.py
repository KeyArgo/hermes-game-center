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
except ImportError:
    from shelf.fresh import load_fresh
    from shelf.catalog import Catalog, plugin_roots
    from shelf.commands import run
    from shelf.setup import apply_choice
    from shelf.who import NameBook, identify


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

    # Slots: with auto-spin on, a spin happens at the moment the person's turn starts, and only
    # while the machine is on screen (the desktop reports that). Nothing is banked: a turn with
    # the machine closed costs nothing and earns nothing. The hook returns no text, so the prompt
    # is untouched, and any failure is swallowed rather than breaking the turn.
    seen_turns: list[str] = []

    def earn_pull(**kwargs: Any) -> None:
        turn = str(kwargs.get("turn_id") or "")
        if turn:
            # One spin per turn, even if Hermes asks twice for the same turn.
            if turn in seen_turns:
                return None
            seen_turns.append(turn)
            del seen_turns[:-50]
        try:
            here = Path(__file__).resolve().parent / "shelf"
            wallets = load_fresh("hermes_gameshelf_wallet", here / "wallet.py")
            slots = load_fresh("hermes_gameshelf_slotplay", here / "slotplay.py")
            wallet = wallets.Wallet(wallets.wallet_path(root()))
            slots.autospin(wallet, kind="turn")
        except Exception:
            log.debug("the automatic spin after a turn did not run", exc_info=True)

    # Tokens: every API reply the person spends pays points - 10 per 1M tokens in or out, one
    # whole point per 100k - because points are the account currency that shows how much Hermes is
    # being used. A reply is counted once, judged by its own api_request_id; failures are
    # swallowed, and only the local person's wallet (the auto-spin one) ever moves.
    seen_requests: list[str] = []

    def earn_tokens(**kwargs: Any) -> None:
        request_id = str(kwargs.get("api_request_id") or "")
        if request_id:
            # One count per request, even if Hermes delivers the same reply twice.
            if request_id in seen_requests:
                return None
            seen_requests.append(request_id)
            del seen_requests[:-50]
        try:
            here = Path(__file__).resolve().parent / "shelf"
            wallets = load_fresh("hermes_gameshelf_wallet", here / "wallet.py")
            wallet = wallets.Wallet(wallets.wallet_path(root()))
            spent = wallets.usage_tokens(kwargs.get("usage") or {})
            if spent > 0:
                wallet.add_tokens(spent)
                # The reply was expensive, so it is worth a bigger automatic bet than a turn
                # starting or a tool running (owner's ask, 2026-11-09). Same gate as any other
                # automatic spin: auto-play on and the machine on screen.
                slots = load_fresh("hermes_gameshelf_slotplay", here / "slotplay.py")
                slots.autospin(wallet, kind="reply", tokens=spent)
        except Exception:
            log.debug("the automatic spin after a reply did not run", exc_info=True)

    # Tools: the most frequent hook there is, and the cheapest, so it pays the smallest automatic
    # bet. One spin per burst: a run of parallel tool calls is one moment to the ear, and spinning
    # on each of them turns the machine into a machine gun. Owner's report, 2026-11-09: nothing was
    # spinning while tools ran, because no tool hook was registered at all.
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
            slots.autospin(wallet, kind="tool")
        except Exception:
            log.debug("the automatic spin after a tool call did not run", exc_info=True)

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
            log.debug("the win bonus was not awarded", exc_info=True)

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

    # ---- the egg cheat, armed by a file rather than shipped on ----------------------------------
    # `/eggs` exists only on a machine that carries the developer key or the egg force file. Delete
    # the file and the command is gone at the next reload: the hunt goes back to being a surprise
    # (owner's ask, 2026-11-09: "give me cheats so I can search for them and find them easily and
    # test them, then we can remove the cheats so its harder").
    def _eggs_module():
        here = Path(__file__).resolve().parent / "shelf"
        return load_fresh("hermes_gameshelf_eggs", here / "eggs.py")

    def _egg_cheat_armed() -> bool:
        try:
            here = Path(__file__).resolve().parent / "shelf"
            devgrant = load_fresh("hermes_gameshelf_devgrant", here / "devgrant.py")
            if devgrant.armed():
                return True
        except Exception:
            log.debug("the dev-grant cheat check could not be read", exc_info=True)
        try:
            # Both files live in this profile's plugin data folder, never in the person's home
            # directly (review, 2026-11-12): a cheat armed in one profile must not arm another.
            return _eggs_module().force_path(root()).exists()
        except Exception:
            log.debug("the egg-force cheat check could not be read", exc_info=True)
            return False

    if _egg_cheat_armed():
        def on_eggs(raw: str = "", **kwargs: Any) -> str:
            here = Path(__file__).resolve().parent / "shelf"
            eggs = _eggs_module()
            wallets = load_fresh("hermes_gameshelf_wallet", here / "wallet.py")
            wallet = wallets.Wallet(wallets.wallet_path(root()))
            words = str(raw or "").split()
            action = words[0] if words else "list"
            found = set(wallet.eggs_found())
            live = eggs.current()
            if action == "list":
                rows = [f"{'LIVE' if live and live['id'] == e['id'] else '    '} "
                        f"{'FOUND' if e['id'] in found else '     '} {e['points']:>6}  {e['id']:<22} {e['hint']}"
                        for e in eggs.EGGS]
                head = f"showing: {live['id']} ({live['points']} pts){' [forced]' if live.get('forced') else ''}" if live else "showing: nothing this hour"
                return "\n".join([head, f"found {len(found)}/{len(eggs.EGGS)}", *rows])
            if action == "show" and len(words) > 1:
                if not eggs.find(words[1]):
                    return f"No egg called {words[1]}."
                force = eggs.force_path(root())
                force.parent.mkdir(parents=True, exist_ok=True)
                force.write_text(words[1] + "\n", encoding="utf-8")
                return f"Forced {words[1]} — open the machine, the mark is at the top-left of the cabinet."
            if action == "clear":
                try:
                    eggs.force_path(root()).unlink()
                    return "Force cleared: back to the hourly schedule."
                except FileNotFoundError:
                    return "No force was set."
            if action == "claim" and len(words) > 1:
                if not live or live["id"] != words[1]:
                    return f"{words[1]} is not the egg showing."
                answer = wallet.claim_egg(words[1], eggs.points_for(words[1]))
                return f"+{answer['points']} points (total {answer['bonus']})" if answer["claimed"] else "Already found."
            if action == "reset":
                with wallet._held() as data:
                    data["eggs_found"] = []
                return "Finds cleared: every egg can be found again."
            return "Usage: /eggs list | show <id> | clear | claim <id> | reset"

        ctx.register_command(
            "eggs",
            on_eggs,
            "Easter-egg cheat (developer). /eggs list | show <id> | clear | claim <id> | reset",
            args_hint="list | show the-argo-stamp | claim the-argo-stamp | reset",
            argument_mode="text",
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
    del settings

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
