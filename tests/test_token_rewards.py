"""Points from the tokens the person spends: 10 points per 1,000,000, in or out."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from shelf.wallet import (  # noqa: E402
    START_CHIPS,
    TOKENS_PER_POINT,
    Wallet,
    usage_tokens,
    wallet_path,
)


def fresh(tmp_path: Path) -> Wallet:
    return Wallet(wallet_path(tmp_path))


def test_a_million_tokens_are_ten_points(tmp_path: Path) -> None:
    held = fresh(tmp_path).add_tokens(1_000_000)
    assert held["bonus"] == 10 and held["tokens"] == 0
    assert held["tokens_total"] == 1_000_000
    assert held["chips"] == START_CHIPS, "points are not chips: the playing stack is untouched"
    assert held["reward"] == 0, "nothing mints reward chips any more"


def test_the_remainder_under_a_whole_point_carries_over(tmp_path: Path) -> None:
    wallet = fresh(tmp_path)
    held = wallet.add_tokens(250_000)
    assert held["bonus"] == 2 and held["tokens"] == 50_000
    held = wallet.add_tokens(50_000)
    assert held["bonus"] == 3 and held["tokens"] == 0
    assert held["tokens_total"] == 300_000


def test_bad_counts_are_ignored_not_stored(tmp_path: Path) -> None:
    wallet = fresh(tmp_path)
    before = wallet.read()
    assert wallet.add_tokens(0) == before
    assert wallet.add_tokens(-25) == before
    assert wallet.add_tokens(None) == before
    assert wallet.add_tokens("a lot") == before


def test_an_old_wallets_reward_chips_can_still_be_cashed_in(tmp_path: Path) -> None:
    """Wallets that earned reward chips before the switch keep them, and can still cash them."""
    path = wallet_path(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"chips": START_CHIPS, "bet": 25, "reward": 3, "tokens": 50_000}), encoding="utf-8")
    wallet = Wallet(path)
    assert wallet.cash_in() == 3
    held = wallet.read()
    assert held["reward"] == 0 and held["tokens"] == 50_000
    assert held["chips"] == START_CHIPS + 3
    assert wallet.cash_in() == 0, "cashing in twice does not pay twice"


def test_new_usage_never_mints_reward_chips(tmp_path: Path) -> None:
    wallet = fresh(tmp_path)
    wallet.add_tokens(1_500_000)
    held = wallet.read()
    assert held["reward"] == 0, "tokens pay points now"
    assert held["bonus"] == 15


def test_an_old_wallet_file_learns_the_new_keys(tmp_path: Path) -> None:
    path = wallet_path(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"chips": 300, "bet": 25, "spins": 4}), encoding="utf-8")
    held = Wallet(path).read()
    assert held["chips"] == 300
    assert held["tokens"] == 0 and held["reward"] == 0 and held["tokens_total"] == 0


def test_the_point_rate_is_one_point_per_hundred_thousand_tokens() -> None:
    assert TOKENS_PER_POINT * 10 == 1_000_000, "10 points per 1M: the rate quoted is the rate paid"


def test_many_small_replies_add_up_exactly(tmp_path: Path) -> None:
    """Real traffic is thousands of small replies, mostly under one point each.

    The person's points must equal floor(total tokens / 100k) with the remainder carried - no point
    lost to a rounding step and none invented. Owner's ask, 2026-11-09: "make sure the points are
    being accurately accumulated".
    """
    wallet = fresh(tmp_path)
    total = 0
    for index in range(200):
        spent = 3_000 + (index % 7) * 1_013
        wallet.add_tokens(spent)
        total += spent
    held = wallet.read()
    assert held["tokens_total"] == total, "every token is counted, exactly once"
    assert held["bonus"] == total // TOKENS_PER_POINT, "points are the exact whole-point count"
    assert held["tokens"] == total % TOKENS_PER_POINT, "the remainder carries, it is not rounded"


def test_a_huge_single_reply_pays_every_whole_point(tmp_path: Path) -> None:
    held = fresh(tmp_path).add_tokens(12_345_678)
    assert held["bonus"] == 123 and held["tokens"] == 45_678
    assert held["tokens_total"] == 12_345_678


def test_usage_reports_are_read_in_every_shape() -> None:
    assert usage_tokens({"total_tokens": 123}) == 123
    assert usage_tokens({"total_tokens": 0, "prompt_tokens": 80, "completion_tokens": 20}) == 100
    assert usage_tokens({"input_tokens": 70, "output_tokens": 30}) == 100
    assert usage_tokens({"prompt_tokens": 10, "completion_tokens": "many"}) == 10
    assert usage_tokens({"total_tokens": "many"}) == 0
    assert usage_tokens({"prompt_tokens": -5, "completion_tokens": 10}) == 10
    assert usage_tokens({}) == 0
    assert usage_tokens(None) == 0
    assert usage_tokens(["total_tokens", 5]) == 0


def _reply_hook(tmp_path: Path):
    """The post_api_request hook the plugin registers, taken from the real register()."""
    spec = importlib.util.spec_from_file_location("gameshelf_token_plugin", ROOT / "__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    hooks: dict[str, list] = {}

    def register_hook(name, fn):
        hooks.setdefault(name, []).append(fn)

    ctx = SimpleNamespace(
        get_config=lambda key, default=None: default,
        register_hook=register_hook,
        register_command=lambda *args, **kwargs: None,
        register_tool=lambda *args, **kwargs: None,
    )
    plugin.register(ctx, data_root=tmp_path)
    return hooks["post_api_request"][0]


def test_the_reply_hook_makes_a_million_tokens_ten_points(tmp_path: Path) -> None:
    earn = _reply_hook(tmp_path)
    earn(api_request_id="r1", usage={"total_tokens": 1_000_000})
    held = Wallet(wallet_path(tmp_path)).read()
    assert held["bonus"] == 10 and held["tokens"] == 0 and held["tokens_total"] == 1_000_000
    assert held["chips"] == START_CHIPS, "usage pays points, not chips"


def test_the_reply_hook_counts_each_request_once_and_ignores_garbage(tmp_path: Path) -> None:
    earn = _reply_hook(tmp_path)
    wallet = Wallet(wallet_path(tmp_path))
    earn(api_request_id="r1", usage={"total_tokens": 150_000})
    held = wallet.read()
    assert held["bonus"] == 1 and held["tokens"] == 50_000
    earn(api_request_id="r1", usage={"total_tokens": 150_000})
    assert wallet.read() == held, "a repeated api_request_id is not counted twice"
    earn(api_request_id="r2", usage={"prompt_tokens": 40_000, "completion_tokens": 60_000})
    held = wallet.read()
    assert held["bonus"] == 2 and held["tokens"] == 50_000 and held["tokens_total"] == 250_000
    earn(api_request_id="r3", usage="not a usage report at all")
    earn(api_request_id="r4")
    earn(api_request_id="r5", usage={"total_tokens": None, "completion_tokens": True})
    assert wallet.read() == held, "garbage earns nothing and never raises"
