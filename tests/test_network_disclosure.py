"""The network section names every outbound request the plugin can make.

The catalog review (2026-11-12) caught a promise the README made and the code did not keep: "the plugin
makes no network calls of its own — the one exception is online play", while the **Experimental** pet
gallery also reads the public Petdex manifest. The fallback stays (it is the same document Hermes's own
pet picker reads), so the disclosure has to name it.

These tests are the disclosure's gate: if another outbound address is added, or the Petdex line is
dropped from the network section, this fails.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
README = (ROOT / "README.md").read_text(encoding="utf-8")
SECURITY = (ROOT / "SECURITY.md").read_text(encoding="utf-8")


def _network_bullet(text: str) -> str:
    """The README's `- **Network:**` bullet, up to the next bullet."""
    match = re.search(r"(?ms)^- \*\*Network:\*\*.*?(?=^- |\Z)", text)
    assert match, "README.md has no **Network:** bullet"
    return match.group(0)


def test_the_network_section_names_the_pet_gallery():
    bullet = _network_bullet(README)
    assert "petdex.dev" in bullet, (
        "the pet gallery reads https://petdex.dev/api/manifest, so the network section must name it "
        "next to online play — a disclosure that misses a request is worse than none"
    )
    assert "Experimental" in bullet, "and say where it is (the Experimental shelf), so nobody trips over it"
    assert "online play" in bullet.lower(), "online play is still the other exception"


def test_every_address_the_plugin_can_fetch_is_disclosed():
    """Scan the shipped Python for outbound http(s) literals and require each to be named."""
    allowed = {
        "https://games.hermesnet.xyz",   # the lobby, named in the network section and configurable
        "https://petdex.dev",            # the public pet manifest
        "https://github.com",            # the project links the README already lists
    }
    found = set()
    for path in sorted((ROOT / "shelf").glob("*.py")):
        # A real host has a dot in it: ``https://host`` in a docstring is a placeholder, not a call.
        for match in re.finditer(r"https?://[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", path.read_text(encoding="utf-8")):
            found.add(match.group(0).rstrip("."))
    unexplained = sorted(url for url in found if not any(url.startswith(allowed_url) for allowed_url in allowed))
    assert not unexplained, f"shelf/ fetches addresses the README does not account for: {unexplained}"


def test_security_md_names_the_same_two_exceptions():
    assert "petdex.dev" in SECURITY, "SECURITY.md makes the same promise and needs the same exception"
    assert "online play" in SECURITY.lower()
