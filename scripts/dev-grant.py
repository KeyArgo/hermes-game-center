#!/usr/bin/env python3
"""Developer top-up for the Game Center wallet - local, keyed, and silent in the source.

    scripts/dev-grant.py --init            # choose the passphrase once (nothing is written to the repo)
    scripts/dev-grant.py --chips 50000     # add 50,000 play chips, after the passphrase
    scripts/dev-grant.py --status          # is this machine armed?

The lock lives in ``~/.hermes/gameshelf-dev.key``: a scrypt hash of the passphrase you choose, mode
600, outside every repository. There is no passphrase, key or hash in the source, no HTTP route and
no Hermes command for this - a copy of the repo gives nobody access to another machine's wallet.
"""

from __future__ import annotations

import argparse
import getpass
import importlib.util
import sys
from pathlib import Path

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
wallet = _load("hermes_gameshelf_wallet", ROOT / "shelf" / "wallet.py")


def live_wallet_path() -> Path:
    """The wallet the running plugin writes: its data root, not the repo's working copy."""
    candidates = [
        Path.home() / ".hermes" / "plugin-data" / "hermes-gameshelf",
        Path.home() / ".hermes" / "plugins" / "hermes-gameshelf",
        ROOT,
    ]
    for folder in candidates:
        if (folder / "wallet.json").exists():
            return folder / "wallet.json"
    return candidates[0] / "wallet.json"


def main() -> int:
    parser = argparse.ArgumentParser(description="Top up the local Game Center wallet (developer only).")
    parser.add_argument("--init", action="store_true", help="create or replace the key file")
    parser.add_argument("--chips", type=int, default=0, help="how many play chips to add")
    parser.add_argument("--status", action="store_true", help="say whether this machine is armed")
    parser.add_argument("--wallet", type=Path, default=None, help="wallet file to change")
    args = parser.parse_args()

    if args.init:
        first = getpass.getpass("New developer passphrase (8+ characters): ")
        second = getpass.getpass("Again: ")
        if first != second:
            print("They did not match. Nothing was written.")
            return 2
        try:
            path = devgrant.make_key(first)
        except ValueError as problem:
            print(f"{problem}. Nothing was written.")
            return 2
        print(f"Armed. The hash is in {path} (mode 600, outside the repository); the passphrase is not stored.")
        return 0

    if args.status:
        print("armed" if devgrant.armed() else "not armed - run --init first")
        return 0

    if args.chips <= 0:
        parser.print_help()
        return 2

    if not devgrant.armed():
        print("No developer key on this machine, so nothing can be granted. Run --init first.")
        return 2
    if not devgrant.check(getpass.getpass("Developer passphrase: ")):
        print("Wrong passphrase. Nothing was granted.")
        return 1

    path = args.wallet or live_wallet_path()
    held = wallet.Wallet(path).grant(args.chips)
    print(f"Granted {args.chips:,} chips to {path}. You now hold {held['chips']:,}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
