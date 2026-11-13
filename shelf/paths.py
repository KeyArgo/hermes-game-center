"""Where this plugin keeps its own files: the active profile's plugin data folder.

Hermes gives every plugin one folder per profile: ``plugin_data_dir("hermes-gameshelf")``, which is
``<hermes home>/plugin-data/hermes-gameshelf/`` — ``~/.hermes/…`` by default, and
``<profile>/…`` under a named profile. Everything this plugin writes for itself belongs there, so a
second profile (or a second machine) never sees this one's state.

The review that this module answers (2026-11-12): the developer key and the egg-force file were
built from ``Path.home()`` directly, so they ignored the active profile and sat loose in ``~/.hermes``
beside Hermes's own files. Neither is a credential — no secret is written by this plugin — but both
are plugin state, and plugin state has one home.

Read-only callers must not create anything: only :func:`data_dir` itself creates the folder, exactly
like Hermes's own ``plugin_data_dir``.
"""

from __future__ import annotations

import os
from pathlib import Path

PLUGIN = "hermes-gameshelf"


def data_dir() -> Path:
    """This plugin's data folder for the active profile (created on demand)."""
    try:
        from plugins.plugin_storage import plugin_data_dir
    except Exception:
        # Outside Hermes — the browser page, a bare import in a test, a checkout on its own. The
        # convention is the same one, built from HERMES_HOME by hand rather than guessed, and created
        # here because Hermes's own helper creates it too.
        home = os.environ.get("HERMES_HOME", "").strip()
        root = Path(os.path.expanduser(os.path.expandvars(home))) if home else Path.home() / ".hermes"
        folder = root / "plugin-data" / PLUGIN
        folder.mkdir(parents=True, exist_ok=True)
        return folder
    return plugin_data_dir(PLUGIN)
