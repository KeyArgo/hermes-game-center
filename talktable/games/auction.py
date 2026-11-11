"""A blind auction on a talking table.

Two seats, five lots, private valuations. Talk first, then everyone sends one
secret set of bids. The vendored ``SimpleBlindAuctionEnv`` decides who won what
and what it was worth; this module only draws the table and offers the clicks.

Chosen over SimpleNegotiation because the auction's private valuations are real
hidden information, its bids are numbers the rules can check exactly, and its
reveal (who paid what for what) is worth watching. Negotiation's trades are
free text that the environment has to guess at, which makes a bad model reply
indistinguishable from a bad trade.
"""

from __future__ import annotations

import random
import re

from .. import common, ta_envs

ID = "blind-auction"
TITLE = "Blind Auction"
BLURB = (
    "Five lots, private values, one secret bid each. Talk first, then bid blind: "
    "the highest bid on a lot wins it, and the richer wallet wins the table."
)
MIN_SEATS = 2
MAX_SEATS = 2
DEFAULT_SEATS = 2
ITEMS = 5
CAPITAL = 1000
TALK_ROUNDS = 2

_BID = re.compile(r"\[bid\s+on\s+item\s+(\d+)\s*:\s*(\d+)\]", re.IGNORECASE)

_CHAT = (
    "I am only here for one lot, so bid high elsewhere.",
    "These prices look steep to me. I would keep your coins.",
    "Let us not ruin each other on the first lot.",
)


def sessions(seats: int) -> list[list[int]]:
    return [list(range(seats))]


def build(seats: int):
    return ta_envs.env_class("SimpleBlindAuctionEnv")(
        starting_capital=CAPITAL, num_items=ITEMS, conversation_rounds=TALK_ROUNDS)


def reset(env, seat_ids, seed) -> None:
    env.reset(num_players=len(seat_ids), seed=seed)


def done(env) -> bool:
    return bool(env.state.done)


def current(env) -> int:
    return int(env.state.current_player_id)


def _gs(env):
    return env.state.game_state


def phase(env) -> dict:
    gs = _gs(env)
    if gs.get("phase") == "conversation":
        done_turns = int(gs.get("conversations_completed", 0))
        total = TALK_ROUNDS * 2
        return {"label": f"Talking · {max(0, total - done_turns)} turns left", "kind": "talk"}
    return {"label": "Bidding · send your secret bids", "kind": "act"}


def can_say(env, seat: int) -> bool:
    return not done(env) and _gs(env).get("phase") == "conversation" and current(env) == seat


def _values(env, seat: int) -> dict[int, int]:
    values = (_gs(env).get("player_item_values") or {}).get(seat) or {}
    return {int(key): int(value) for key, value in values.items()}


def _capital(env, seat: int) -> int:
    return int((_gs(env).get("remaining_capital") or {}).get(seat, 0))


def _amounts(value: int, capital: int) -> list[int]:
    """Three plain amounts a person can click, all within the wallet."""
    found = []
    for share in (0.4, 0.6, 0.8):
        amount = int(round(value * share / 5.0)) * 5
        amount = max(5, amount)
        if amount <= capital and amount not in found:
            found.append(amount)
    return found


def actions(env, seat: int, draft=None) -> list[dict]:
    if done(env) or can_say(env, seat):
        return []
    values = _values(env, seat)
    names = list(_gs(env).get("item_names") or [])
    capital = _capital(env, seat)
    picked = {(int(item["item"]), int(item["amount"])) for item in (draft or [])
              if isinstance(item, dict) and "item" in item and "amount" in item}
    found = []
    for index in range(ITEMS):
        value = values.get(index, 0)
        for amount in _amounts(value, capital):
            # What the set would cost if this chip replaced the lot's current pick.
            others = sum(paid for lot, paid in picked if lot != index)
            chosen = any(lot == index and paid == amount for lot, paid in picked)
            found.append({
                "id": f"bid-{index}-{amount}",
                "label": f"{amount} for {names[index] if index < len(names) else 'Item ' + str(index)}",
                "hint": f"worth {value} to you",
                "raw": "",
                "group": f"Item {index}",
                "on": chosen,
                "disabled": not chosen and others + amount > capital,
            })
    found.append({"id": "send", "label": "Send these bids", "hint": "They stay secret", "raw": "",
                  "disabled": False})
    found.append({"id": "pass", "label": "Bid on nothing", "hint": "Keep every coin", "raw": "",
                  "disabled": False})
    return found


def _draft_list(draft) -> list[dict]:
    out = []
    for item in draft or []:
        if isinstance(item, dict) and "item" in item and "amount" in item:
            try:
                out.append({"item": int(item["item"]), "amount": int(item["amount"])})
            except (TypeError, ValueError):
                continue
    return out


def parse(env, seat: int, text: str, allowed: list[dict], draft=None):
    if can_say(env, seat):
        said = common.clean(text)
        return ("act", said) if said else None
    said = str(text or "").strip().lower()
    picked = _draft_list(draft)
    if said in {"send", "send these bids", "done"}:
        if not picked:
            return ("act", "I bid on nothing.")
        return ("act", " ".join(f"[Bid on Item {item['item']}: {item['amount']}]" for item in picked))
    if said in {"pass", "bid on nothing", "none"}:
        return ("act", "I bid on nothing.")
    for item in allowed:
        if said == item["id"] or said == item["label"].lower():
            parts = item["id"].split("-")
            if len(parts) == 3 and parts[0] == "bid":
                lot, amount = int(parts[1]), int(parts[2])
                already = any(entry["item"] == lot and entry["amount"] == amount for entry in picked)
                kept = [entry for entry in picked if entry["item"] != lot]
                if not already:
                    kept.append({"item": lot, "amount": amount})
                if sum(entry["amount"] for entry in kept) > _capital(env, seat):
                    return ("refuse", "Those bids add up to more than your coins. Drop one first.")
                return ("draft", kept)
    return None


def parse_free(env, seat: int, text: str):
    """A model's own sentence, with any bids inside it, checked against the rules."""
    raw = str(text or "")
    if can_say(env, seat):
        said = common.clean(raw)
        return said or None
    found = _BID.findall(raw)
    if not found:
        if "nothing" in raw.lower() or "pass" in raw.lower() or "no bid" in raw.lower():
            return "I bid on nothing."
        return None
    capital = _capital(env, seat)
    total = 0
    picks = []
    for item_text, amount_text in found:
        try:
            item, amount = int(item_text), int(amount_text)
        except ValueError:
            continue
        if item not in range(ITEMS) or amount <= 0:
            continue
        total += amount
        picks.append(f"[Bid on Item {item}: {amount}]")
    if not picks or total > capital:
        return None
    return " ".join(picks)


def bot(env, seat: int, rng: random.Random, history=None) -> str:
    del history
    if can_say(env, seat):
        return rng.choice(_CHAT)
    values = _values(env, seat)
    capital = _capital(env, seat)
    lots = sorted(values.items(), key=lambda pair: -pair[1])
    picks = []
    budget = capital
    # Buy the two lots it values most, at about two thirds of their worth.
    for index, value in lots[:2]:
        amount = max(5, int(round(value * 0.66 / 5.0)) * 5)
        if amount <= budget:
            picks.append((index, amount))
            budget -= amount
    if not picks:
        return "I bid on nothing."
    return " ".join(f"[Bid on Item {index}: {amount}]" for index, amount in picks)


def brief(env, seat: int) -> str:
    values = _values(env, seat)
    names = list(_gs(env).get("item_names") or [])
    lines = ["Only you know what these lots are worth to you:"]
    for index in range(ITEMS):
        name = names[index] if index < len(names) else f"Item {index}"
        lines.append(f"- {name}: worth {values.get(index, 0)} coins to you")
    lines.append(f"You have {_capital(env, seat)} coins. Net worth decides the table.")
    return "\n".join(lines)


def instruction(env, seat: int) -> tuple[str, str]:
    if can_say(env, seat):
        return ("Say one short line to the other bidder. Bids are secret; nothing you "
                "say changes what an item is worth.",
                "one short line of speech")
    values = _values(env, seat)
    capital = _capital(env, seat)
    names = list(_gs(env).get("item_names") or [])
    top = sorted(values.items(), key=lambda pair: -pair[1])[:2]
    examples = " ".join(
        f"[Bid on Item {index}: {max(5, int(round(value * 0.6 / 5.0)) * 5)}]"
        for index, value in top)
    return (f"You have {capital} coins. Send every bid in one line, like {examples}; "
            f"the whole set must not exceed your coins. Bidding on nothing is allowed. "
            f"The lots are {', '.join(names[:ITEMS])}.",
            "those bids, or a line saying you bid on nothing")


def table(env, seat_ids, meta) -> dict:
    gs = _gs(env)
    capital = gs.get("remaining_capital") or {}
    places = []
    # While bidding, a seat's coins would reveal how much the other bidder just
    # spent. They are shown during the talk and at the reveal, never in between.
    talking = gs.get("phase") == "conversation"
    for pid in range(len(seat_ids)):
        places.append({"seat": pid, "out": False,
                       "note": f"{int(capital.get(pid, 0))} coins" if talking else "", "role": ""})
    return {"places": places}


def private(env, seat: int) -> dict:
    names = list(_gs(env).get("item_names") or [])
    values = _values(env, seat)
    return {
        "items": [{"item": index, "name": names[index] if index < len(names) else f"Item {index}",
                   "value": values.get(index, 0)} for index in range(ITEMS)],
        "capital": _capital(env, seat),
    }


def _name(seat: int, meta) -> str:
    row = (meta or {}).get(seat) or {}
    if row.get("you"):
        return "you"
    return str(row.get("name") or "") or common.seat_name(seat)


def _join(names: list[str]) -> str:
    if len(names) == 1:
        return names[0]
    return ", ".join(names[:-1]) + " and " + names[-1]


def plain_reason(env, seat_ids, meta) -> str:
    """The auction's finish in the table's words, naming the winner by seat.

    The vendored result reads "Player 1 won with a final net worth of ...", which
    is the engine's zero-based bookkeeping. The card names seats the way the
    table does, so the winner and the amount are said in plain words here.
    """
    results = _gs(env).get("auction_results") or {}
    worth = results.get("player_net_worth") or {}
    rewards = env.state.rewards or {}
    best = max((float(rewards.get(seat, 0)) for seat in seat_ids), default=0.0)
    winners = [seat for seat in seat_ids if best > 0 and float(rewards.get(seat, 0)) == best]
    if not winners:
        top = max((int(worth.get(seat, 0)) for seat in seat_ids), default=0)
        winners = [seat for seat in seat_ids if int(worth.get(seat, 0)) == top] if top else []
    if not winners:
        return "The auction ended with no winner."
    amount = int(worth.get(winners[0], 0))
    named = _join([_name(seat, meta) for seat in winners])
    if len(winners) == 1:
        return f"{named} wins the auction with a final net worth of {amount} coins."
    return f"{named} tie the auction with a final net worth of {amount} coins."


def reveal(env, seat_ids, meta) -> dict:
    gs = _gs(env)
    results = gs.get("auction_results") or {}
    winners = results.get("item_winners") or {}
    bids = results.get("winning_bids") or {}
    worth = results.get("player_net_worth") or {}
    names = list(gs.get("item_names") or [])
    rewards = env.state.rewards or {}
    lots = []
    for index in range(ITEMS):
        won = winners.get(index)
        lots.append({
            "item": index,
            "name": names[index] if index < len(names) else f"Item {index}",
            "winner": int(won) if won is not None else None,
            "paid": int(bids.get(index, 0)) if index in bids else 0,
        })
    return {
        "lots": lots,
        "worth": [{"seat": pid, "net": int(worth.get(pid, 0))} for pid in range(len(seat_ids))],
        "winners": [pid for pid in range(len(seat_ids)) if rewards.get(pid, 0) > 0],
        "reason": plain_reason(env, seat_ids, meta),
    }


def scores(env, seat_ids, meta) -> dict[int, float]:
    worth = (_gs(env).get("auction_results") or {}).get("player_net_worth") or {}
    return {pid: float(worth.get(pid, 0)) for pid in range(len(seat_ids))}


def estimate(seats: int, model_seats: int) -> int:
    # One turn per talk round, then one bidding turn.
    return model_seats * (TALK_ROUNDS + 1)


def beat(env) -> str:
    """One beat per talk turn, and one for the bidding phase."""
    gs = _gs(env)
    return f"{gs.get('phase')}-round-{int(gs.get('round') or 1)}-conv-{int(gs.get('conversations_completed') or 0)}"
