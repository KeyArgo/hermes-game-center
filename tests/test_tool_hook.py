"""The tool hook spins too - the cheapest automatic bet, once per burst."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_the_plugin_registers_a_tool_hook() -> None:
    source = (ROOT / "__init__.py").read_text()
    assert 'register_hook("pre_tool_call", earn_tool)' in source, "tools were silent: no hook was registered"
    assert 'slots.autospin(wallet, kind="tool")' in source, "the tool spin is the cheap kind"


def test_the_manifest_declares_every_hook_it_uses() -> None:
    manifest = (ROOT / "plugin.yaml").read_text()
    for name in ("pre_llm_call", "pre_tool_call", "post_api_request"):
        assert f"- {name}" in manifest, f"{name} is used but not declared"
    source = (ROOT / "__init__.py").read_text()
    for name in ("pre_llm_call", "pre_tool_call", "post_api_request"):
        assert f'register_hook("{name}"' in source, f"{name} is declared but never registered"


def test_a_tool_call_is_the_smallest_bet() -> None:
    from shelf import autobet
    from shelf.slotplay import MIN_BET

    assert autobet.stake_for("tool", 0, MIN_BET) == MIN_BET
    assert autobet.stake_for("tool", 500_000, MIN_BET) == MIN_BET, "a tool is never an expensive hook"


def test_a_burst_of_tools_is_one_spin() -> None:
    source = (ROOT / "__init__.py").read_text()
    assert "1.2" in source, "a burst of parallel tools is debounced into one spin"
