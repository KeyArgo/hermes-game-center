"""Regression: plugin.yaml must declare every hook the plugin registers (A51).

`hermes plugins validate` fails to install a plugin whose ``provides_hooks``
declaration does not match the hooks it registers at runtime. A missing or
wrong hook declaration is a P0 install blocker for a judge. This locks the two
in agreement: the set declared in plugin.yaml equals the set the real
``register()`` wires up, and in particular that both ``post_api_request`` and
``pre_llm_call`` are present.
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]

EXPECTED = {"pre_llm_call", "pre_tool_call", "post_api_request"}


def _declared_hooks() -> set[str]:
    text = (ROOT / "plugin.yaml").read_text(encoding="utf-8")
    block = re.search(r"(?m)^provides_hooks:\n((?:\s*-\s*\S+\n)+)", text)
    assert block, "plugin.yaml has no provides_hooks block"
    return set(re.findall(r"-\s*(\S+)", block.group(1)))


def _registered_hooks(tmp_path: Path) -> set[str]:
    spec = importlib.util.spec_from_file_location("gameshelf_hooks_plugin", ROOT / "__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(plugin)
    seen: set[str] = set()
    ctx = SimpleNamespace(
        get_config=lambda key, default=None: default,
        register_hook=lambda name, fn: seen.add(name),
        register_command=lambda *a, **k: None,
        register_tool=lambda *a, **k: None,
    )
    plugin.register(ctx, data_root=tmp_path)
    return seen


def test_provides_hooks_declares_the_required_install_hooks():
    declared = _declared_hooks()
    assert "post_api_request" in declared, declared
    assert "pre_llm_call" in declared, declared
    assert EXPECTED <= declared, declared


def test_declared_hooks_match_registered_hooks(tmp_path):
    assert _declared_hooks() == _registered_hooks(tmp_path)
