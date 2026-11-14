"""Guards for five rules the catalog entry must keep.

Each rule stands for a defect that a shipped build once had. Fixing a defect is not the same as
keeping it fixed, so each rule is a test that fails on the old code and passes on this tree:

1. A Doctrine card comes from the model the person already has, through ``ctx.llm.complete``, in this
   process. A child ``hermes -p <profile> chat`` with a copy of ``os.environ`` is a second Hermes: a
   card could reach whatever that profile's tools reached, and the run was only *asked* to disable
   its tools. No docstring may call that "tools disabled".
2. The Desktop plugin must not reach into the host app's markup. An earlier build found the chat
   column by enumerating every ``<textarea>`` in the app, walking its ancestors to the widest one and
   appending a ``position: fixed`` div to ``document.body``; an app update could break it and it
   could break the app. Now the over-chat machines render in ``COMPOSER_AREAS.underside``.
3. Every credential the code stores goes through ``save_env_value``; each one must be a ``type:
   secret`` field in ``plugin.yaml``, or it exists with no field to read it back.
4. No shipped code hardcodes ``~/.hermes``: the home comes from Hermes, so an isolated install or a
   profile is not written into by accident.
5. The ``agent.pet`` seam stays fail-soft, and every host the code contacts is named in the README's
   network section.

The scans read code, not strings in comments: JS comments and Python docstrings are stripped first,
so a file may explain the old approach without tripping the fence.
"""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

DESKTOP = ROOT / "desktop"
SRC = DESKTOP / "src"
BUNDLE = DESKTOP / "plugin.js"
MANIFEST = ROOT / "plugin.yaml"
README = ROOT / "README.md"

# Directories that are not shipped code: tests, build tooling, sample games, vendored copies and
# recorded evidence. Everything else in the tree runs on a person's machine.
_NOT_SHIPPED = {"tests", "tools", "examples", "docs", "third_party", "vendor", "node_modules",
                ".git", "assets", "screenshots", "proof", "test-artifacts", "scripts", "build",
                "dist", "__pycache__"}


def _python_files(*, developer_scripts: bool = False) -> list[Path]:
    blocked = set(_NOT_SHIPPED)
    if developer_scripts:
        blocked.discard("scripts")
    return sorted(
        path for path in ROOT.rglob("*.py")
        if not blocked.intersection(path.relative_to(ROOT).parts) and path.is_file()
    )


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _docstring_nodes(tree: ast.AST) -> set[int]:
    """The id() of every Constant that is a module, class or function docstring."""
    found: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", None) or []
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                if isinstance(body[0].value.value, str):
                    found.add(id(body[0].value))
    return found


def _code_strings(path: Path) -> list[str]:
    """Every string constant that is not a docstring: what the code does, not what it explains."""
    tree = ast.parse(_read(path), filename=str(path))
    skip = _docstring_nodes(tree)
    return [node.value for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in skip]


def _strip_js(text: str) -> str:
    """JS with comments removed and string literals blanked, keeping line numbers.

    A naive ``//`` strip would cut a URL in half, and a scan that reads comments would fail on a
    file that documents the approach it no longer takes. Strings are blanked so a selector only
    counts where it is used as a selector.
    """
    out: list[str] = []
    index, length = 0, len(text)
    quote = ""
    while index < length:
        char = text[index]
        nxt = text[index + 1] if index + 1 < length else ""
        if quote:
            if char == "\\":
                index += 2
                continue
            if char == quote:
                quote = ""
                out.append(char)
            elif char == "\n":
                out.append("\n")
            else:
                out.append(" ")
            index += 1
            continue
        if char in "'\"`":
            quote = char
            out.append(char)
            index += 1
            continue
        if char == "/" and nxt == "/":
            while index < length and text[index] != "\n":
                index += 1
            continue
        if char == "/" and nxt == "*":
            index += 2
            while index + 1 < length and not (text[index] == "*" and text[index + 1] == "/"):
                out.append("\n" if text[index] == "\n" else " ")
                index += 1
            index += 2
            continue
        out.append(char)
        index += 1
    return "".join(out)


def _js_sources() -> list[tuple[str, str]]:
    """``(label, stripped source)`` for every shipped JS file: the parts and the built bundle."""
    sources = [(f"desktop/src/{path.name}", _strip_js(_read(path))) for path in sorted(SRC.glob("*.js"))]
    sources.append(("desktop/plugin.js", _strip_js(_read(BUNDLE))))
    return sources


# ---------------------------------------------------------------- 1. no child process, no environment


_PROCESS_MODULES = {"subprocess", "multiprocessing", "pty", "asyncio.subprocess"}
_PROCESS_CALLS = {"os.system", "os.popen", "os.spawnl", "os.spawnv", "os.execv", "os.execvp",
                  "os.fork", "subprocess.run", "subprocess.Popen", "subprocess.call",
                  "subprocess.check_output", "subprocess.check_call"}


def _dotted(node: ast.AST) -> str:
    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    return ".".join(reversed(parts))


def _doctrine_violations(path: Path) -> list[str]:
    """Every way this file could start a program or copy the process environment."""
    tree = ast.parse(_read(path), filename=str(path))
    found: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in _PROCESS_MODULES or alias.name.split(".")[0] == "subprocess":
                    found.append(f"line {node.lineno}: import {alias.name}")
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if module in _PROCESS_MODULES or module.split(".")[0] == "subprocess":
                found.append(f"line {node.lineno}: from {module} import ...")
        elif isinstance(node, ast.Call):
            name = _dotted(node.func)
            if name in _PROCESS_CALLS:
                found.append(f"line {node.lineno}: {name}(...)")
        elif isinstance(node, ast.Attribute):
            name = _dotted(node)
            if name in {"os.environ", "os.environb"}:
                found.append(f"line {node.lineno}: {name}")
    return found


def test_doctrine_starts_no_program_and_copies_no_environment():
    """A card is written by the person's own model in-process, never by a child Hermes.

    An earlier build created ``["hermes", "-p", profile, "chat", ...]``, copied ``os.environ`` into it
    and ran it. That is a second Hermes with its own tool set, reached from a card request.
    """
    offenders: list[str] = []
    for path in sorted((ROOT / "doctrine").rglob("*.py")) + sorted((ROOT / "doctrine_arena").rglob("*.py")):
        for problem in _doctrine_violations(path):
            offenders.append(f"{path.relative_to(ROOT)}: {problem}")
    assert not offenders, (
        "Doctrine must write cards through ctx.llm.complete, in this process:\n" + "\n".join(offenders)
    )


def test_no_doctrine_file_carries_a_hermes_command_line():
    """The CLI flags only a child Hermes takes, so any of them is a child Hermes by another name."""
    flags = {"--oneshot", "--query-file", "--toolsets", "--no-restore-cwd"}
    offenders: list[str] = []
    for path in sorted((ROOT / "doctrine").rglob("*.py")) + sorted((ROOT / "doctrine_arena").rglob("*.py")):
        for text in _code_strings(path):
            for flag in flags:
                if flag in text:
                    offenders.append(f"{path.relative_to(ROOT)}: {flag}")
    assert not offenders, "Doctrine builds a hermes command line:\n" + "\n".join(offenders)


def test_the_author_docstring_does_not_claim_tools_are_disabled():
    """The old docstring promised "tools disabled" about a run that only passed ``--toolsets ""``."""
    path = ROOT / "doctrine" / "profiles.py"
    tree = ast.parse(_read(path), filename=str(path))
    docstrings = [ast.get_docstring(tree) or ""]
    docstrings += [ast.get_docstring(node) or "" for node in ast.walk(tree)
                   if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
    claims = [text for text in docstrings if "tools disabled" in text.lower()]
    assert not claims, (
        "doctrine/profiles.py says 'tools disabled': the in-process model door is what makes a card "
        "text-only, so the claim cannot be made about a process"
    )
    module_doc = ast.get_docstring(tree) or ""
    assert "ctx.llm.complete" in module_doc, (
        "the module docstring must state the door a card is written through, so the next reader "
        "does not reach for a child process"
    )


def test_the_card_writer_calls_the_model_door_it_is_given():
    """The only way out is the callable handed in: no model door, no card, and a sentence saying so."""
    from doctrine import profiles

    seen: list[tuple[str, int]] = []

    def complete(prompt: str, max_tokens: int = 0) -> dict:
        seen.append((prompt, max_tokens))
        return {"move": json.dumps({
            "schema": "doctrine-card/1", "name": "Test card", "author": "tester",
            "personality": "A test.", "weights": {key: 50 for key in profiles_card_weights()},
        })}

    reply, error = profiles.author("tester", profiles.prompt("tester"), complete)
    assert error == "", error
    assert reply is not None
    assert json.loads(reply)["author"] == "tester"
    assert len(seen) == 1 and seen[0][1] == profiles.MAX_TOKENS

    reply, error = profiles.author("tester", profiles.prompt("tester"), None)
    assert reply is None and "model" in error.lower(), (reply, error)


def profiles_card_weights() -> tuple[str, ...]:
    from doctrine.card import WEIGHTS
    return WEIGHTS


# ------------------------------------------------------- 2. the host app's markup is not the plugin's


_HOST_DOM = [
    (re.compile(r"\bdocument\s*\.\s*(head|body|documentElement|forms|images|links)\b"),
     "reaches for the host document's own nodes"),
    (re.compile(r"\bdocument\s*\.\s*(querySelector|querySelectorAll|getElementById|getElementsBy\w+)\b"),
     "looks the app's markup up by selector"),
    (re.compile(r"\.(querySelector|querySelectorAll|getElementById|getElementsBy\w+)\s*\(\s*"
                r"['\"][^'\"]*\b(textarea|contenteditable)\b"),
     "scans the app's text fields"),
    (re.compile(r"(while|for)\s*\([^)]*\.parentElement"),
     "walks up the app's ancestors"),
]


@pytest.mark.parametrize("label,text", _js_sources(), ids=[label for label, _ in _js_sources()])
def test_the_desktop_plugin_never_reaches_for_the_host_markup(label: str, text: str):
    """The plugin renders into the slots it is given and measures only its own elements.

    One read-only exception is deliberate and not a violation: a window key listener asks
    ``event.target.closest('input, textarea, select, [contenteditable]')`` whether the keystroke
    belongs to a text field, so typing in the chat composer does not move a board's cursor. That
    asks about the one element the event names; it never enumerates or climbs the app's tree, which
    is what the patterns below catch.
    """
    problems = [f"{label}: {why} -> {match.group(0)[:70]!r}"
                for pattern, why in _HOST_DOM for match in pattern.finditer(text)]
    assert not problems, (
        "the plugin must not touch the host app's markup; put the view in a slot instead:\n"
        + "\n".join(problems)
    )


def test_the_over_chat_machines_render_in_a_composer_area():
    """The see-through machines are a slot contribution, which is why no DOM scan is needed."""
    slot = _read(SRC / "78-overchat-slot.js")
    registration = _read(SRC / "80-plugin.js")
    assert "COMPOSER_AREAS.underside" in slot, "the over-chat strip must render into the composer slot"
    assert "COMPOSER_AREAS.underside" in registration, (
        "80-plugin.js must register the over-chat strip in COMPOSER_AREAS.underside or the status item"
    )
    assert "OverChatStrip" in registration, "the registered component is the slot strip"


# ------------------------------------------------------------------------- 3. declared credentials


def _schema_fields(text: str) -> dict[str, dict[str, str]]:
    """``config_schema`` as ``{key: {field: value}}``; the manifest is a flat two-space mapping."""
    lines = text.splitlines()
    start = next((index for index, line in enumerate(lines) if line.strip() == "config_schema:"), None)
    assert start is not None, "plugin.yaml has no config_schema block"
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
    """Every ``HERMES_GAMESHELF_*`` name the shipped code stores or reads as a credential.

    Two shapes, because the writer takes a variable: a module constant named ``*_ENV`` holds the
    name, and a literal first argument to ``save_env_value`` is the name itself.
    """
    names: set[str] = set()
    for path in _python_files():
        tree = ast.parse(_read(path), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign) and len(node.targets) == 1:
                target = node.targets[0]
                if (isinstance(target, ast.Name) and target.id.endswith("_ENV")
                        and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)
                        and node.value.value.startswith("HERMES_GAMESHELF_")):
                    names.add(node.value.value)
            if isinstance(node, ast.Call) and _dotted(node.func).endswith("save_env_value"):
                first = node.args[0] if node.args else None
                if isinstance(first, ast.Constant) and isinstance(first.value, str):
                    names.add(first.value)
    assert names, "no stored credential was found; the scan is not reading the code it should"
    return names


def test_every_stored_credential_is_a_secret_field_in_the_manifest():
    """A key stored with ``save_env_value`` and not declared cannot be read back or cleared."""
    schema = _schema_fields(_read(MANIFEST))
    declared = {field.get("env", ""): key for key, field in schema.items() if field.get("env")}
    missing = sorted(_stored_credentials() - set(declared))
    assert not missing, (
        f"plugin.yaml config_schema does not declare {missing}; each needs `type: secret` and its env "
        "name, or Settings has no field for a credential the plugin keeps"
    )
    for env in sorted(_stored_credentials()):
        key = declared[env]
        assert schema[key].get("type") == "secret", f"{key} declares {env} as {schema[key].get('type')!r}"
        assert schema[key].get("label"), f"{key} has no label"


# ------------------------------------------------------------------- 4. no hardcoded Hermes home


def test_no_shipped_code_hardcodes_a_hermes_home():
    """The home is Hermes's answer, not a literal: an isolated install must not be written into.

    ``~/.hermes`` is wrong for a profile (``<home>/profiles/<name>``), for a container
    (``HERMES_HOME=/opt/data``) and on Windows (``%LOCALAPPDATA%\\hermes``).
    """
    offenders: list[str] = []
    home_literal = re.compile(r"(?<![A-Za-z0-9])\.hermes(?![A-Za-z0-9])")
    for path in _python_files(developer_scripts=True):
        for text in _code_strings(path):
            if home_literal.search(text):
                offenders.append(f"{path.relative_to(ROOT)}: {text.strip()[:80]!r}")
        tree = ast.parse(_read(path), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and _dotted(node.func) in {"Path.home", "pathlib.Path.home"}:
                offenders.append(f"{path.relative_to(ROOT)}:{node.lineno}: Path.home()")
    for path in sorted(ROOT.glob("scripts/*.sh")):
        for number, line in enumerate(_read(path).splitlines(), 1):
            if ".hermes" in line and not line.lstrip().startswith("#"):
                offenders.append(f"{path.relative_to(ROOT)}:{number}: {line.strip()[:80]!r}")
    assert not offenders, (
        "use plugin_data_dir / the profile's home instead of a literal path:\n" + "\n".join(offenders)
    )


def test_the_catalog_asks_hermes_where_its_home_is(monkeypatch, tmp_path):
    """Discovery of sibling installs follows Hermes's answer, and never guesses a path.

    A guessed default is wrong for a profile, a container and Windows alike, so with no variable and
    no resolver the answer is no home at all rather than a literal one.
    """
    import types

    from shelf import catalog

    monkeypatch.delenv("HERMES_HOME", raising=False)
    monkeypatch.setitem(sys.modules, "hermes_constants",
                        types.SimpleNamespace(get_hermes_home=lambda: tmp_path))
    assert catalog._homes() == [tmp_path]

    monkeypatch.setitem(sys.modules, "hermes_constants", None)  # the import raises ImportError
    assert catalog._homes() == []

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    assert catalog._homes() == [tmp_path]


# ------------------------------------------------------- 5. fail-soft pet seam, disclosed hosts


def test_the_pet_seam_degrades_when_its_imports_raise(monkeypatch):
    """``agent.pet`` is private: a release may move it, and the shelf must lose a toy, not load.

    The import is made to raise ImportError, the way a renamed module does, and every pet entry
    point must answer without raising and without a pet.
    """
    import builtins

    from shelf import pet

    real_import = builtins.__import__

    def failing_import(name, *args, **kwargs):
        if name == "agent.pet" or name.startswith("agent.pet."):
            raise ImportError(f"no module named {name}")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", failing_import)
    for module in [name for name in sys.modules if name == "agent.pet" or name.startswith("agent.pet.")]:
        monkeypatch.delitem(sys.modules, module, raising=False)
    monkeypatch.setattr(pet, "_AVAILABLE", None, raising=False)

    assert pet.available() is False
    assert pet._resolve({}) == (None, None, None, "no-pet")
    shelf = pet.gallery({})
    assert shelf["enabled"] is False and shelf["gallery"] == [], shelf
    assert pet.thumb("nonesuch") == {"ok": False, "slug": "nonesuch"}


def test_the_plugin_loads_and_registers_with_the_pet_seam_missing(monkeypatch):
    """The whole backend still loads and registers when the host has no pet modules at all."""
    import builtins
    import importlib.util

    from types import SimpleNamespace

    real_import = builtins.__import__

    def failing_import(name, *args, **kwargs):
        if name == "agent.pet" or name.startswith("agent.pet."):
            raise ImportError(f"no module named {name}")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", failing_import)
    for module in [name for name in sys.modules if name == "agent.pet" or name.startswith("agent.pet.")]:
        monkeypatch.delitem(sys.modules, module, raising=False)

    spec = importlib.util.spec_from_file_location("gameshelf_petless_plugin", ROOT / "__init__.py")
    assert spec is not None and spec.loader is not None
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    seen: set[str] = set()
    ctx = SimpleNamespace(
        get_config=lambda key, default=None: default,
        register_hook=lambda name, fn: seen.add(name),
        register_command=lambda *a, **k: None,
        register_tool=lambda *a, **k: None,
        has_plugin=lambda name: True,
        llm=None,
    )
    plugin.register(ctx)
    assert seen, "the plugin registered no hook at all with the pet seam missing"
    assert sys.modules["shelf.pet"].available() is False


def test_every_host_the_code_contacts_is_named_in_the_network_section():
    """A disclosure that misses one request is worse than none, so the scan covers Python and JS."""
    readme = _read(README)
    bullet = re.search(r"(?ms)^- \*\*Network:\*\*.*?(?=^- |\Z)", readme)
    assert bullet, "README.md has no **Network:** bullet"
    text = bullet.group(0)
    # https://github.com is a link target the README already lists in its project sections; it is
    # never fetched, so it needs no privacy bullet of its own.
    links = {"https://github.com"}
    found: set[str] = set()
    for path in _python_files():
        for match in re.finditer(r"https?://[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", _read(path)):
            found.add(match.group(0).rstrip("."))
    for _, source in _js_sources():
        for match in re.finditer(r"https?://[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", source):
            found.add(match.group(0).rstrip("."))
    hosts = {url.split("://", 1)[1].split("/")[0] for url in found if url not in links}
    assert hosts, "the scan found no host at all; it is not reading the code"
    missing = sorted(host for host in hosts if host not in text)
    assert not missing, (
        f"the README's network section does not name {missing}, so the disclosure is incomplete"
    )
