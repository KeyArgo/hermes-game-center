"""Every credential this plugin stores is declared in plugin.yaml.

``HERMES_GAMESHELF_BOT_KEY`` and ``HERMES_GAMESHELF_STAFF_KEY`` are written with Hermes's own credential route
(``save_env_value``), while only ``lobby_key`` was declared in the manifest's
``config_schema``. An undeclared secret is invisible: it exists in the person's
credentials but Settings has no field for it, so it cannot be read back, pasted
by hand or cleared there, and a reviewer has to read the source to learn that the
plugin keeps a key at all.

The rule these tests lock: the manifest declares exactly the credentials the code
stores, each as ``type: secret`` under the same environment variable name. A new
key introduced later fails here until it is declared.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from shelf import online_source  # noqa: E402

MANIFEST = ROOT / "plugin.yaml"


def _schema_fields(text: str) -> dict[str, dict[str, str]]:
    """``config_schema``'s entries as ``{key: {field: value}}``.

    A small reader rather than a YAML dependency: the manifest is a flat mapping
    of two-space-indented keys, each holding ``field: value`` lines, and the
    plugin ships no YAML parser.
    """
    lines = text.splitlines()
    try:
        start = next(index for index, line in enumerate(lines) if line.strip() == "config_schema:")
    except StopIteration:  # pragma: no cover - the manifest always has one
        raise AssertionError("plugin.yaml has no config_schema block")
    fields: dict[str, dict[str, str]] = {}
    current: str | None = None
    for line in lines[start + 1:]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        if indent == 0:
            break
        if indent == 2 and line.rstrip().endswith(":"):
            current = line.strip()[:-1]
            fields[current] = {}
            continue
        if indent >= 4 and current is not None and ":" in line:
            name, _, value = line.strip().partition(":")
            fields[current][name.strip()] = value.strip().strip("\"'")
    return fields


def _stored_credentials() -> set[str]:
    """Every env name ``shelf/online_source.py`` reads or writes as a secret.

    The module keeps them together as ``*_ENV`` constants precisely so the set is
    readable; scanning the module's own attributes means a fourth key added to
    that list is covered without editing this test.
    """
    names = {
        value for name, value in vars(online_source).items()
        if name.endswith("_ENV") and isinstance(value, str) and value.startswith("HERMES_GAMESHELF_")
    }
    assert names, "online_source.py declares no credential env names"
    return names


def test_every_stored_credential_is_declared_in_the_manifest():
    declared = {field.get("env", "") for field in _schema_fields(MANIFEST.read_text(encoding="utf-8")).values()}
    missing = sorted(_stored_credentials() - declared)
    assert not missing, (
        "plugin.yaml config_schema does not declare the credential(s) the plugin stores: "
        f"{missing}. Declare each one as `type: secret` with its env name, like lobby_key."
    )


def test_every_declared_credential_is_a_secret_field_under_its_own_env():
    schema = _schema_fields(MANIFEST.read_text(encoding="utf-8"))
    secrets = {key: field for key, field in schema.items() if field.get("env", "").startswith("HERMES_GAMESHELF_")}
    assert secrets, "the manifest declares no credential fields at all"
    for key, field in secrets.items():
        assert field.get("type") == "secret", f"{key} declares {field.get('env')} but is type: {field.get('type')!r}"
        assert field.get("label"), f"{key} has no label, so Settings would show it unnamed"
        assert field.get("description"), f"{key} has no description, so a person cannot tell what it is for"


def test_the_two_credentials_from_the_review_are_named_and_declared():
    """The review's own list, pinned by name so a rename is a deliberate change."""
    schema = _schema_fields(MANIFEST.read_text(encoding="utf-8"))
    by_env = {field.get("env", ""): field for field in schema.values()}
    for env in ("HERMES_GAMESHELF_BOT_KEY", "HERMES_GAMESHELF_STAFF_KEY"):
        assert env in by_env, f"{env} is stored by the plugin but not declared in plugin.yaml"
        assert by_env[env].get("type") == "secret", f"{env} must be declared type: secret"


def test_the_manifest_does_not_declare_a_credential_the_code_never_stores():
    """A declared secret nobody stores is a field that saves a key to no effect."""
    declared = {field.get("env", "") for field in _schema_fields(MANIFEST.read_text(encoding="utf-8")).values()}
    declared = {name for name in declared if name.startswith("HERMES_GAMESHELF_")}
    unused = sorted(declared - _stored_credentials())
    assert not unused, f"plugin.yaml declares credentials the plugin never reads: {unused}"
