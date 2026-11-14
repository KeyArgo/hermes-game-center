"""How big an automatic bet is, decided by what the hook cost the person.

Auto-bet is on by default, and it sizes itself: frequent, cheap hooks pay the smallest bet, a real
inference reply pays more, because that is the moment the person spent something. The machine then keeps turning on its own rather than waiting for a hand on the
lever.

Rules, in one place so the table, the hooks and the tests cannot drift:

- A cheap, frequent hook (a turn starting, a tool call) is worth the smallest bet on the table.
- A reply is worth more the more tokens it cost, one step per doubling past 20k, up to the cap.
- Nothing here decides whether a spin happens, only how much it costs. Odds are untouched: the
  return is the same at every bet, so a bigger bet is a bigger swing, never a better chance.
"""

from __future__ import annotations

import math

# Kinds that fire often and cost little: the turn starting, a tool running.
CHEAP_KINDS = ("turn", "tool", "hook", "start")

# A multiple of the table's minimum bet. 1 is the smallest bet the machine offers.
MULTIPLES = (1, 2, 3, 4, 6, 8)
DEFAULT_CAP = 8          # the whole ladder out of the box; the person can lower it
STEPS_AT_TOKENS = 20_000  # below this a reply is barely a reply


def multiple_for(kind: str, tokens: int = 0) -> int:
    """The bet multiple for one hook. Cheap hooks are always the smallest bet."""
    if str(kind).lower() in CHEAP_KINDS:
        return MULTIPLES[0]
    tokens = int(tokens or 0)
    if tokens <= 0:
        return MULTIPLES[0]
    if tokens <= STEPS_AT_TOKENS:
        return MULTIPLES[1]
    # 20k -> 2x, 40k -> 3x, 80k -> 4x, 160k -> 6x, 320k+ -> 8x
    step = 1 + int(math.log2(tokens / STEPS_AT_TOKENS))
    return MULTIPLES[min(step, len(MULTIPLES) - 1)]


def stake_for(kind: str, tokens: int, minimum: int, cap: int = DEFAULT_CAP) -> int:
    """The chips one automatic spin costs at this hook, clamped to what the person allowed."""
    multiple = multiple_for(kind, tokens)
    allowed = max(1, min(int(cap or DEFAULT_CAP), max(MULTIPLES)))
    return int(minimum) * min(multiple, allowed)
