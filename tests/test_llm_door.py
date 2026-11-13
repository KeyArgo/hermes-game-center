"""The model door the plugin hands to the games, and what happens when there is no LLM surface at all.

Quality review, 2026-11-13: ``_complete()`` returned a closure unconditionally. On a context without
``ctx.llm`` that closure raised AttributeError the moment something asked for a completion, and the
Doctrine author reported it as "That profile did not answer." — advice about a profile that was never
involved, on a surface that has no model. This pins the honest behaviour on the REGISTERED command, which
is the path a person actually takes.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace
from typing import Any

ROOT = Path(__file__).resolve().parent.parent


def _registered(tmp_path: Path, **extra):
    """The plugin's real register(), on a context made only of what a bare surface gives.

    No ``llm`` attribute: that is the point. The browser page and a tool-only seat both look like this.
    """
    spec = importlib.util.spec_from_file_location("gameshelf_llm_door", ROOT / "__init__.py")
    assert spec and spec.loader
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    commands: dict[str, Any] = {}

    def register_command(name, handler, description="", **_kwargs):
        commands[name] = handler

    ctx = SimpleNamespace(
        get_config=lambda key, default=None: {"allow_ai": True}.get(key, default),
        has_plugin=lambda plugin_id: True,
        register_hook=lambda name, fn: None,
        register_command=register_command,
        register_tool=lambda *args, **kwargs: None,
        **extra,
    )
    plugin.register(ctx, data_root=tmp_path)
    return plugin, ctx, commands


def test_a_context_without_an_llm_gets_no_model_door(tmp_path: Path) -> None:
    plugin, ctx, _commands = _registered(tmp_path)
    assert plugin._complete(ctx, None) is None, "no ctx.llm means no door, not a door that raises"


def test_a_context_with_an_llm_gets_a_door_that_returns_text(tmp_path: Path) -> None:
    seen = {}

    class Seat:
        def complete(self, **kwargs):
            seen.update(kwargs)
            return SimpleNamespace(text="ok", usage={"total_tokens": 7})

    plugin, ctx, _commands = _registered(tmp_path, llm=Seat())
    door = plugin._complete(ctx, None)
    assert door is not None
    assert door("say something", max_tokens=40)["move"] == "ok"
    assert seen["max_tokens"] == 40 and seen["purpose"] == "hermes-gameshelf"


def test_authoring_without_an_llm_says_so_instead_of_blaming_a_profile(tmp_path: Path) -> None:
    """The registered command, a context with no LLM: one clear sentence, and no card."""
    _plugin, _ctx, commands = _registered(tmp_path)
    answer = commands["games"]("doctrine author ada")
    assert "needs one model" in answer
    assert "did not answer" not in answer.lower(), answer
    assert "profile" not in answer.lower(), "no profile is involved, so none is named"
