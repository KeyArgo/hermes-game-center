"""This plugin's own kit.py, loaded under a name no other plugin can claim.

Every game used to run ``import kit`` after putting its parent folder on
``sys.path``. When a second plugin (say classic-games) also ships ``kit.py``,
whichever module reached ``sys.modules["kit"]`` first wins and the other plugin's
games break. Loading by file path under ``KIT_NAME`` keeps our games on our kit
no matter what else is installed.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

KIT_NAME = "hermes_gameshelf_kit"
_KIT_PATH = Path(__file__).resolve().parent.parent / "kit.py"


def kit_module():
    """Our kit, loaded once per process."""
    found = sys.modules.get(KIT_NAME)
    if found is not None:
        return found
    spec = importlib.util.spec_from_file_location(KIT_NAME, _KIT_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {_KIT_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[KIT_NAME] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(KIT_NAME, None)
        raise
    return module


kit = kit_module()
