"""Wallet: the play-money chips one person holds on this Hermes.

Blackjack and the slot machines bet and pay chips from this one stack. With auto-spin
on, each message sent spins once (the pre_llm_call hook in __init__.py), paid from the
same chips. Chips are play money only and never become anything else.

The wallet is one small JSON file next to the game folders. Every change holds an
exclusive lock and rewrites the file whole, so a hook firing during a spin never
loses either change.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import time
from pathlib import Path

START_CHIPS = 10_000
# Chips only: no pulls, no earned counter. A spin costs the bet and pays chips.
MIN_BET = 25
# How long one change waits for another process's lock before giving up. A live
# holder (a stuck hook, a paused turn) used to block every bet and payout forever.
LOCK_TIMEOUT_SECONDS = 10.0

# The person earns 10 points per 1,000,000 tokens their chats spend, in or out: one whole point
# per 100k tokens. Points are the account currency that shows how much Hermes is being used and
# that other things (avatars, later) can spend - not chips.
TOKENS_PER_POINT = 100_000
# Points cash into chips at 75%, kept in whole numbers: 4 points buy 3 chips, and the points under
# one block wait for the next conversion (owner's ask, 2026-11-09).
POINTS_PER_CHIP_BLOCK = 4
CHIPS_PER_BLOCK = 3
# What the old token route minted: one reward chip per 100k tokens. Wallets from before the
# switch still hold those chips and can still cash them in; nothing mints new ones.
TOKENS_PER_CHIP = TOKENS_PER_POINT

_BLANK = {"chips": START_CHIPS, "spins": 0, "biggest": 0, "hands": 0, "bet": MIN_BET,
          # Bonus points: 100 for every game won, plus whatever tokens buy. A second
          # currency, not chips; it converts at 75% either way.
          "bonus": 0,
          # Tokens counted since the last whole point, and reward chips minted by the older
          # route that have not been cashed in yet. New usage pays points, not chips.
          "tokens": 0, "reward": 0, "tokens_total": 0,
          # How the see-through machine over the chat is drawn: whether it is shown at all, its
          # opacity and its size. Kept with the person's other slot settings so reloading the plugin
          # does not reset them - localStorage alone did not survive a plugin reload (owner's report,
          # 2026-11-09), and on/off was the one part still living only in the browser, which is why
          # the copy could vanish after a rebuild (owner's report, 2026-11-10).
          "overchat": False, "overchat_alpha": 0.2, "overchat_scale": 1.0,
          # The comeback loop, all in play chips: when the last bailout was handed out (epoch
          # seconds), how many days in a row the person has come back, and how many spins are still
          # paying the comeback bonus.
          "bailout_at": 0, "streak": 0, "streak_day": 0, "comeback": 0,
          # Which surfaces are showing a machine right now, by name: 'slots' for the original copy
          # over the chat, 'jackpot2' for the Jackpot cabinet. Two machines may be on screen at once
          # (owner's ask, 2026-11-11) and the automatic spin runs while ANY of them is. One boolean
          # that every surface wrote to was a flag the last surface to close could clear while
          # another was still drawing, which is how the Jackpot cabinet sat there spinning nothing.
          "visible_sources": {}}
# Keys the wallet stores as real numbers rather than whole counts. Everything else is an int, and
# a float in an int key is a corrupt file rather than a setting.
FLOAT_KEYS = frozenset({"overchat_alpha", "overchat_scale"})
# The slot machine a person last picked; auto-spin plays this one.
DEFAULT_MACHINE = "fruit9"
# The latest slot spins, newest first, for the Jackpot table and the overlay over the chat.
FEED_SIZE = 20


def wallet_path(data_root: Path) -> Path:
    return Path(data_root) / "wallet.json"


def usage_tokens(usage: object) -> int:
    """How many tokens one API reply spent, from whatever shape the usage report has.

    total_tokens wins; otherwise prompt+completion or input+output; anything missing,
    non-integer or negative counts as nothing. Never raises: a strange usage report
    just earns nothing.
    """
    if not isinstance(usage, dict):
        return 0

    def whole(key: str) -> int:
        value = usage.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            return 0
        return value

    total = whole("total_tokens")
    if total:
        return total
    prompt = whole("prompt_tokens") or whole("input_tokens")
    completion = whole("completion_tokens") or whole("output_tokens")
    return prompt + completion


class Wallet:
    def __init__(self, path: Path):
        self.path = Path(path)

    @contextlib.contextmanager
    def _held(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path.with_suffix(".lock"), "a+") as lock:
            deadline = time.monotonic() + LOCK_TIMEOUT_SECONDS
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError(
                            f"the wallet is locked by another process; gave up after "
                            f"{LOCK_TIMEOUT_SECONDS:g}s waiting for {self.path}"
                        ) from None
                    time.sleep(0.01)
            try:
                data = self._load()
                yield data
                tmp = self.path.with_suffix(".tmp")
                tmp.write_text(json.dumps(data), encoding="utf-8")
                os.replace(tmp, self.path)
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def _load(self) -> dict:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raw = {}
        data = dict(_BLANK)
        if isinstance(raw, dict):
            for key in _BLANK:
                value = raw.get(key)
                if key in FLOAT_KEYS:
                    # A stored opacity or size: a real number, kept as a float. This is the bug
                    # that made a reload reset them - the reader accepted ints only, so the saved
                    # 0.35 fell back to the blank default on the next load.
                    if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
                        data[key] = float(value)
                    continue
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                    data[key] = value
        data["autoplay"] = bool(isinstance(raw, dict) and raw.get("autoplay") is True)
        # Auto-bet is ON unless it was turned off: the owner's default (2026-11-09). Its cap is a
        # multiple of the table minimum, remembered with the rest of the table's settings.
        data["autobet"] = not (isinstance(raw, dict) and raw.get("autobet") is False)
        cap = raw.get("autobet_max") if isinstance(raw, dict) else None
        data["autobet_max"] = int(cap) if isinstance(cap, int) and not isinstance(cap, bool) and 1 <= cap <= 8 else 8
        # Which surfaces are showing a machine right now, and whether that means any of them is.
        # Auto-spin only runs while one is. A file written before surfaces could be named (or by an
        # older plugin) has only the one boolean, which is read as the original copy over the chat.
        stored = raw.get("visible_sources") if isinstance(raw, dict) else None
        sources = {}
        if isinstance(stored, dict):
            for name, on in stored.items():
                if on is True or on is False:
                    sources[str(name)[:32] or "slots"] = bool(on)
        if not sources and isinstance(raw, dict) and raw.get("visible") is True:
            sources["slots"] = True
        data["visible_sources"] = sources
        data["visible"] = any(sources.values())
        # Whether the see-through copy is shown over the chat. A boolean, so it needs its own line:
        # the integer branch above skips bools, which is exactly how this setting was dropped on the
        # next load even after it had been written (found 2026-11-10 while pinning the switch).
        data["overchat"] = bool(isinstance(raw, dict) and raw.get("overchat") is True)
        machine = raw.get("machine") if isinstance(raw, dict) else None
        data["machine"] = machine if isinstance(machine, str) and machine else DEFAULT_MACHINE
        feed = raw.get("feed") if isinstance(raw, dict) else None
        data["feed"] = [row for row in feed if isinstance(row, dict)][:FEED_SIZE] if isinstance(feed, list) else []
        # Easter eggs already found. A list of ids, not a count: the record is which ones, so a new
        # egg can be added to the catalogue and still pay this person once (owner's ask, 2026-11-09).
        found = raw.get("eggs_found") if isinstance(raw, dict) else None
        data["eggs_found"] = [str(item)[:64] for item in found][:500] if isinstance(found, list) else []
        # Keys this version does not know are carried through untouched. Without this, rolling the
        # plugin back to a commit from before a field existed would drop that field on the next write
        # - and an easter egg record is exactly the kind of thing a person could erase by
        # downgrading. The record has to outlive the code that wrote it (owner's ask, 2026-11-09:
        # "even if they go back and forth between commits or updates they cannot cheat").
        if isinstance(raw, dict):
            for key, value in raw.items():
                if key not in data:
                    data[key] = value
        return data

    def read(self) -> dict:
        return self._load()

    def set_bet(self, chips: int) -> dict:
        """The bet a spin costs, in chips; the table's ladder is 25 chips a step."""
        with self._held() as data:
            data["bet"] = max(MIN_BET, int(chips))
        return data

    def set_visible(self, on: bool, source: str = "slots") -> dict:
        """Whether a surface is showing a machine. Auto-spin refuses while none of them is.

        ``source`` names the surface doing the drawing: 'slots' is the original copy over the chat
        (the default, so an older caller and every existing test keep working) and 'jackpot2' is the
        Jackpot cabinet. Each surface keeps its own flag and the wallet's own truth is whether any of
        them is on, so a surface closing cannot switch the automatic spin off while another is still
        on screen (owner's ask, 2026-11-11: two machines may float at once).
        """
        name = str(source or "slots")[:32] or "slots"
        with self._held() as data:
            sources = dict(data.get("visible_sources") or {})
            if on:
                sources[name] = True
            else:
                sources.pop(name, None)
            data["visible_sources"] = sources
            data["visible"] = bool(sources)
        return data

    def debit(self, chips: int) -> bool:
        """Take chips for a bet. False, and nothing taken, when there are not enough."""
        chips = int(chips)
        if chips <= 0:
            return False
        with self._held() as data:
            if data["chips"] < chips:
                return False
            data["chips"] -= chips
        return True

    def credit(self, chips: int, *, hand: bool = False) -> dict:
        """Pay chips back (a win, a push, a slot payout). ``hand`` counts a finished blackjack hand."""
        chips = max(0, int(chips))
        with self._held() as data:
            data["chips"] += chips
            data["biggest"] = max(data["biggest"], chips)
            if hand:
                data["hands"] += 1
        return data

    # ---- the comeback loop -------------------------------------------------------------
    # A person who cannot cover the smallest bet is offered a skill tap rather than a silent
    # refill: three bars, graded miss / good / perfect, and the grade picks the stack. It is
    # deliberately engaging - a cooldown to come back to, a streak that grows, and ten spins at a
    # premium afterwards - but it pays only play chips and never points, so it cannot buy rank
    # (owner's ask, 2026-11-09: "really gamify this so its addictive to the user").
    BAILOUT_COOLDOWN = 8 * 60          # seconds between rescues
    BAILOUT_STACKS = {"miss": 1500, "good": 2500, "perfect": 4000}
    COMEBACK_SPINS = 10
    COMEBACK_TAKE = 5                  # +1/5 of every payout while the comeback lasts
    STREAK_CAP_TAKE = 2                # the streak never adds more than +2/10

    def bailout(self, grade: str, now: int | None = None) -> dict:
        """Hand out a rescue stack, if the person is actually out and the cooldown has passed.

        Returns a dict: ``given`` chips (0 when refused), ``reason`` for a refusal, ``streak``,
        ``next_at`` epoch seconds for the next tap, and ``comeback`` spins granted.
        """
        now = int(time.time()) if now is None else int(now)
        rank = str(grade or "miss").lower()
        base = self.BAILOUT_STACKS.get(rank, self.BAILOUT_STACKS["miss"])
        with self._held() as data:
            # Broke and cooldown are decided under the lock. Two taps at once used to
            # both pass a read taken beforehand and both pay.
            chips = int(data.get("chips") or 0)
            streak = int(data.get("streak") or 0)
            if chips >= MIN_BET:
                return {"given": 0, "reason": "not broke", "streak": streak, "next_at": 0}
            bailout_at = int(data.get("bailout_at") or 0)
            if now - bailout_at < self.BAILOUT_COOLDOWN:
                return {"given": 0, "reason": "cooling", "streak": streak,
                        "next_at": bailout_at + self.BAILOUT_COOLDOWN}
            # One streak tick per day, and only when the person comes back the next day: the
            # multiplier rewards returning, not grinding one evening.
            day = now // 86400
            last_day = int(data.get("streak_day") or 0)
            if last_day != day:
                streak = 1 if day - last_day > 1 or not last_day else streak + 1
                data["streak_day"] = day
            take = min(self.STREAK_CAP_TAKE, max(0, streak - 1)) / 10
            given = int(round(base * (1 + take)))
            data["chips"] = chips + given
            data["bailout_at"] = now
            data["streak"] = streak
            data["comeback"] = self.COMEBACK_SPINS
        return {"given": given, "reason": "", "streak": streak,
                "next_at": now + self.BAILOUT_COOLDOWN, "comeback": self.COMEBACK_SPINS}

    def eggs_found(self) -> list:
        return list(self.read().get("eggs_found") or [])

    def claim_egg(self, egg_id: str, points: int) -> dict:
        """Pay an easter egg to this person, once, ever.

        The check lives here rather than in the page, because this is where points are actually
        added: a UI that forgot, or a second tab, still cannot pay the same egg twice. Returns
        ``claimed`` and the new point total either way, so the page can say the truth.
        """
        egg_id = str(egg_id or "")[:64]
        try:
            points = max(0, int(points))
        except (TypeError, ValueError):
            points = 0
        with self._held() as data:
            found = list(data.get("eggs_found") or [])
            if not egg_id or points <= 0 or egg_id in found:
                return {"claimed": False, "points": 0, "bonus": int(data.get("bonus") or 0)}
            found.append(egg_id)
            data["eggs_found"] = found[-500:]
            data["bonus"] = int(data.get("bonus") or 0) + points
            return {"claimed": True, "points": points, "bonus": int(data["bonus"])}

    def grant(self, chips: int) -> dict:
        """A developer top-up: play chips added to the stack, nothing else touched.

        Deliberately not reachable from the plugin's HTTP surface or from any hook - the only caller
        is ``scripts/dev-grant.py``, which refuses to run without the developer key file in the
        person's own home directory. No passphrase, key or hash lives in this repository, so a copy
        of the source confers nothing on anyone else's machine.
        """
        chips = max(0, int(chips))
        with self._held() as data:
            data["chips"] += chips
        return data

    def topup(self, floor: int, stack: int = START_CHIPS) -> int:
        """A fresh stack when the player cannot cover the smallest bet.

        Chips are play money, so a table that has taken everything should deal the player
        another dollar rather than leave them at a dead table with no legal move. It only
        pays when the wallet is genuinely below ``floor``, so it cannot be farmed.
        """
        floor = max(1, int(floor))
        stack = int(stack)
        with self._held() as data:
            # The check and the add share the lock: two tables asking at once used to both
            # read "broke" and both pay, which is how a refill could be farmed. The check
            # and the credit were not one locked change (bughunter, 2026-11-09).
            held = int(data.get("chips") or 0)
            if held >= floor:
                return 0
            give = max(0, stack - held)
            if not give:
                return 0
            # A fresh stack is not a win, so it goes into the wallet directly rather than
            # through credit(), which records the biggest payout (grok, 2026-11-09).
            data["chips"] = held + give
        return give

    def add_tokens(self, n: int) -> dict:
        """Count tokens the person spent and pay points for them: 10 per 1M, in or out.

        ``n`` <= 0 changes nothing. Every whole 100k tokens pays one point into ``bonus``, the
        leftover stays in ``tokens`` and carries into the next count, and ``tokens_total`` keeps
        the lifetime count so the person can see how much Hermes they are using. Chips are not
        minted here any more: points are the account currency.
        """
        try:
            n = int(n)
        except (TypeError, ValueError):
            return self.read()
        if n <= 0:
            return self.read()
        with self._held() as data:
            data["tokens_total"] = int(data.get("tokens_total") or 0) + n
            tokens = int(data.get("tokens") or 0) + n
            points = 0
            while tokens >= TOKENS_PER_POINT:
                tokens -= TOKENS_PER_POINT
                points += 1
            if points:
                data["bonus"] = int(data.get("bonus") or 0) + points
            data["tokens"] = tokens
        return data

    def award_bonus(self, points: int) -> int:
        """Add bonus points for a won game. Returns the new total.

        Points are whole; a non-positive or nonsense number changes nothing. Nothing is
        converted here: they wait in ``bonus`` until the person converts them at 75%.
        """
        try:
            points = int(points)
        except (TypeError, ValueError):
            return int(self.read().get("bonus") or 0)
        if points <= 0:
            return int(self.read().get("bonus") or 0)
        with self._held() as data:
            data["bonus"] = int(data.get("bonus") or 0) + points
        return int(data["bonus"])

    def cash_in(self) -> int:
        """Move every waiting reward chip into the playing stack. Returns what moved.

        Reward chips are play money earned from tokens, held apart so the person can
        also spend them (through a later bonus-points store, e.g. avatars) instead.
        """
        with self._held() as data:
            amount = int(data.get("reward") or 0)
            if amount:
                data["chips"] = int(data["chips"]) + amount
                data["reward"] = 0
        return amount

    def cash_points(self, points: int | None = None) -> dict:
        """Turn waiting points into play chips at 75%: four points buy three chips.

        The person asked for a way back from a bad run at the tables that does not depend on luck
        (owner's ask, 2026-11-09: "more ways to make money or a faster way to make money if they
        lose at blackjack or our future poker"). Points are earned from chat use and from games won,
        so a bad streak at blackjack still leaves a route to chips that the luck of the cards cannot
        take away. The rate is exact in whole numbers - 4 points to 3 chips, no floating point - and
        the points under one block stay on the account for the next time.
        """
        with self._held() as data:
            held_points = int(data.get("bonus") or 0)
            # Points are the high score, so spending them is a deliberate choice rather than an
            # all-in button: the argument is how much of the balance the person chose to spend, and
            # the rest stays on the leaderboard (owner's ask, 2026-11-09). ``None`` means all of it,
            # which is what an older desktop asks for.
            spendable = held_points if points is None else max(0, min(int(points), held_points))
            blocks = spendable // POINTS_PER_CHIP_BLOCK if POINTS_PER_CHIP_BLOCK else 0
            chips = blocks * CHIPS_PER_BLOCK
            if chips:
                data["chips"] = int(data["chips"]) + chips
                data["bonus"] = held_points - blocks * POINTS_PER_CHIP_BLOCK
        return {"cashed": chips, "points_left": int(data.get("bonus") or 0), "chips": int(data["chips"])}

    def set_autoplay(self, on: bool) -> dict:
        with self._held() as data:
            data["autoplay"] = bool(on)
        return data

    def set_autobet(self, on=None, cap=None) -> dict:
        """Whether the automatic bet sizes itself, and how high it may go (1x-8x the minimum)."""
        with self._held() as data:
            if on is not None:
                data["autobet"] = bool(on)
            if cap is not None:
                try:
                    data["autobet_max"] = max(1, min(8, int(cap)))
                except (TypeError, ValueError):
                    pass
        return data

    def set_overchat(self, on=None, alpha=None, scale=None) -> dict:
        """Remember whether the over-chat machine is shown, and how it is drawn.

        Out-of-range values are refused. These are viewing preferences, not game rules: nothing here
        can move chips or odds. Both numbers are clamped to the range the controls offer, so a bad
        value cannot make the copy invisible or enormous.
        """
        with self._held() as data:
            if on is not None:
                data["overchat"] = bool(on)
            if alpha is not None:
                try:
                    value = round(float(alpha), 2)
                except (TypeError, ValueError):
                    value = None
                if value is not None and 0.05 <= value <= 0.6:
                    data["overchat_alpha"] = value
            if scale is not None:
                try:
                    value = round(float(scale), 2)
                except (TypeError, ValueError):
                    value = None
                if value is not None and 0.1 <= value <= 3.0:
                    data["overchat_scale"] = value
        return data

    def set_machine(self, machine: str) -> dict:
        with self._held() as data:
            data["machine"] = str(machine)
        return data

    def record_spin(self, row: dict) -> dict:
        """Credit a slot payout and put the spin at the top of the feed, in one locked change.

        While a comeback is running (the ten spins after a bailout) every payout pays a fifth more,
        which is what turns a rescue into a run rather than a single hand-out. The premium is paid
        here, in one locked change with the payout, so the feed shows what the person was actually
        given.
        """
        payout = max(0, int(row.get("payout") or 0))
        with self._held() as data:
            left = int(data.get("comeback") or 0)
            if left > 0 and payout:
                bonus = payout // self.COMEBACK_TAKE
                payout += bonus
                data["comeback"] = left - 1
                row = dict(row, payout=payout, comeback_bonus=bonus)
            data["chips"] += payout
            data["spins"] = int(data.get("spins") or 0) + 1
            data["biggest"] = max(data["biggest"], payout)
            data["feed"] = [dict(row, chips=data["chips"]), *data["feed"]][:FEED_SIZE]
        return data

    def refill(self) -> bool:
        """A broke player (no chips left) gets the starting stake back, so the games never dead-end."""
        with self._held() as data:
            if data["chips"] > 0:
                return False
            data["chips"] = START_CHIPS
        return True
