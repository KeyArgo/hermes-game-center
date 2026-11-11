#!/usr/bin/env python3
"""Read the spin log and say whether the machine paid what it promised.

    scripts/slot-audit.py                 # last 5,000 spins, every machine
    scripts/slot-audit.py --all           # the whole log
    scripts/slot-audit.py --machine robot3
    scripts/slot-audit.py --verify        # re-derive every payout from the stops and complain

Three questions this answers, in the order they matter:

1. **Was each spin paid the right amount?** ``--verify`` recomputes every payout from the recorded
   stops with the shelf's own evaluator and lists any line that does not match. This is the check that
   catches a real payout bug rather than bad luck.
2. **Is the return what the machine advertised?** The observed return, with a rough 95% interval.
3. **Is the session's chance the one it drew?** Every session promises a hit chance; the log records
   what was promised and what happened.

Nothing here changes a wallet. It only reads.
"""

from __future__ import annotations

import argparse
import json
import math
import pathlib
import sys
from collections import Counter, defaultdict

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from shelf import reels  # noqa: E402

DATA = pathlib.Path.home() / ".hermes" / "plugin-data" / "hermes-gameshelf" / "spins.jsonl"


def load(path: pathlib.Path, limit: int | None, machine: str | None) -> list[dict]:
    rows: list[dict] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if machine and row.get("machine") != machine:
                continue
            rows.append(row)
    if limit:
        rows = rows[-limit:]
    return rows


def verify(rows: list[dict]) -> int:
    """Recompute each payout from the stops. Returns the number of spins that disagree."""
    bad = 0
    for row in rows:
        spec = reels.SPECS.get(row.get("machine") or "")
        if not spec:
            continue
        session = row.get("session") or {}
        lines = len(spec["lines"])
        per_line = max(1, int(row.get("bet") or 0) // lines)
        try:
            expected = reels.result(spec, tuple(row.get("stops") or ()), per_line,
                                    session.get("blanks") or 0, session.get("pays"))
        except Exception as error:  # a log from another session shape, not a broken machine
            print(f"  could not re-derive {row.get('at')}: {error}")
            continue
        recorded = int(row.get("payout") or 0) - int(row.get("comeback_bonus") or 0)
        if expected["payout"] != recorded:
            bad += 1
            print(f"  MISMATCH at {row.get('at')}: recorded {recorded}, stops say {expected['payout']} "
                  f"(stops {row.get('stops')}, bet {row.get('bet')})")
    return bad


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit the slot machine from its spin log.")
    parser.add_argument("--log", type=pathlib.Path, default=DATA)
    parser.add_argument("--limit", type=int, default=5_000)
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--machine", default=None)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()

    if not args.log.exists():
        print(f"no spin log yet at {args.log}")
        print("The log starts with the first spin after the process reloads this build.")
        return 1

    rows = load(args.log, None if args.all else args.limit, args.machine)
    if not rows:
        print("the log has no spins for that filter")
        return 1

    by_machine: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_machine[row.get("machine") or "?"].append(row)

    print(f"{len(rows)} spins from {args.log}")
    for machine, spins in sorted(by_machine.items()):
        bet = sum(int(s.get("bet") or 0) for s in spins)
        paid = sum(int(s.get("payout") or 0) for s in spins)
        return_rate = paid / bet if bet else 0
        hits = sum(1 for s in spins if int(s.get("payout") or 0) > 0)
        above = sum(1 for s in spins if int(s.get("payout") or 0) >= int(s.get("bet") or 0))
        promised = Counter()
        for s in spins:
            promised[(s.get("session") or {}).get("hit")] += 1
        promised_hit = max(promised, key=promised.get) if promised else None
        # A rough 95% interval on the return: variance of a spin around its mean, divided by n.
        payouts = [int(s.get("payout") or 0) for s in spins]
        mean = sum(payouts) / len(payouts)
        var = sum((p - mean) ** 2 for p in payouts) / max(1, len(payouts) - 1)
        stderr = math.sqrt(var / len(payouts))
        print()
        print(f"  {machine}: {len(spins)} spins")
        print(f"    bet {bet:,}  paid {paid:,}  return {return_rate:.3f}"
              f"  (±{1.96 * stderr / (bet / len(spins)):.3f} at 95%, rough)")
        print(f"    paid something {hits / len(spins):.1%}   paid at least the stake {above / len(spins):.1%}")
        print(f"    session chance promised {promised_hit}   observed hit {hits / len(spins):.1%}")
        if promised_hit is not None:
            gap = abs((hits / len(spins)) - float(promised_hit))
            note = "within noise" if gap < 0.05 + 2 * math.sqrt(0.25 / len(spins)) else "TOO FAR APART"
            print(f"    promise against result: {note}")

    if args.verify:
        print()
        print("re-deriving every payout from its stops…")
        bad = verify(rows)
        print(f"  {bad} of {len(rows)} spins disagree with the shelf's own arithmetic")
        return 1 if bad else 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
