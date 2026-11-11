#!/usr/bin/env python3
"""Developer cheat for the easter eggs: list them, force one to show, reset what has been found.

    scripts/dev-eggs.py list           # every egg, its points, where it hides, and whether you found it
    scripts/dev-eggs.py show <id>      # make that egg the one showing, now (writes the force file)
    scripts/dev-eggs.py clear          # back to the real hourly schedule
    scripts/dev-eggs.py reset          # forget every find, so the same eggs can be tested again

It is inert on a machine without the developer key: exactly like ``scripts/dev-grant.py``, the first
thing it does is refuse without ``~/.hermes/gameshelf-dev.key``. Removing the cheat for everyone is
two deletions - this file and the force file it writes - because no part of the plugin knows about it.
"""

from __future__ import annotations

import argparse
import importlib.util
import logging
import sys
from pathlib import Path

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent


def _load(name: str, path: Path):
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load {path}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


devgrant = _load("hermes_gameshelf_devgrant", ROOT / "shelf" / "devgrant.py")
eggs = _load("hermes_gameshelf_eggs", ROOT / "shelf" / "eggs.py")
wallet_mod = _load("hermes_gameshelf_wallet", ROOT / "shelf" / "wallet.py")

FORCE = Path.home() / ".hermes" / "gameshelf-egg-force"


def live_wallet():
    for folder in (Path.home() / ".hermes" / "plugin-data" / "hermes-gameshelf",
                   Path.home() / ".hermes" / "plugins" / "hermes-gameshelf",
                   ROOT):
        if (folder / "wallet.json").exists():
            return wallet_mod.Wallet(folder / "wallet.json")
    return wallet_mod.Wallet(ROOT / "wallet.json")


def main() -> int:
    parser = argparse.ArgumentParser(description="Easter-egg cheats (developer only).")
    parser.add_argument("action", choices=("list", "show", "clear", "reset"))
    parser.add_argument("egg", nargs="?", default="", help="egg id, for show")
    parser.add_argument("--yes", action="store_true", help="confirm reset")
    args = parser.parse_args()

    # No passphrase gate here on purpose: this script only lists eggs, points the machine at one, or
    # forgets what has been found. It cannot add chips or points - a claim still goes through the real
    # endpoint - so there is nothing for a downloaded copy to exploit. The top-up script keeps the key
    # because it does move the balance.

    wallet = live_wallet()
    found = set(wallet.eggs_found())
    showing = eggs.current()

    if args.action == "list":
        print(f"{'id':26} {'points':>7}  {'live':4}  {'found':5}  where   hint")
        for egg in eggs.EGGS:
            live = "YES" if showing and showing["id"] == egg["id"] else ""
            print(f"{egg['id']:26} {egg['points']:>7}  {live:4}  {'yes' if egg['id'] in found else '':5}  "
                  f"{egg['where']:8}  {egg['hint']}")
        forced = showing and showing.get("forced")
        print(f"\nfound: {len(found)}/{len(eggs.EGGS)}   forced: {FORCE if forced else 'no (real schedule)'}")
        return 0

    if args.action == "show":
        if not args.egg or not eggs.find(args.egg):
            print("Give an id from `list`.")
            return 2
        FORCE.parent.mkdir(parents=True, exist_ok=True)
        FORCE.write_text(args.egg + "\n", encoding="utf-8")
        print(f"Forced. {args.egg} is showing now; reload the machine to see the mark.")
        return 0

    if args.action == "clear":
        try:
            FORCE.unlink()
            print("Force file removed: back to the hourly schedule.")
        except FileNotFoundError:
            log.debug("no force file was set", exc_info=True)
            print("No force file was set.")
        return 0

    if args.action == "reset":
        if not args.yes:
            print("This forgets every egg you have found, so they can be found again. Re-run with --yes.")
            return 2
        with wallet._held() as data:
            data["eggs_found"] = []
        print("Finds cleared. The same eggs will pay again.")
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
