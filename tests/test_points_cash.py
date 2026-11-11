"""Points into chips: the person chooses how much of their score to spend.

Points are the leaderboard score, so spending them is a decision rather than an all-in button. These
tests hold both halves: the arithmetic (four points buy three chips, remainders stay) and the choice
(a slice spends only that slice, and never more than is held).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from shelf.wallet import CHIPS_PER_BLOCK, POINTS_PER_CHIP_BLOCK, Wallet


def wallet_with(tmp_path: Path, chips: int = 0, points: int = 0) -> Wallet:
    path = tmp_path / "wallet.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"chips": chips, "bonus": points}), encoding="utf-8")
    return Wallet(path)


def test_cashing_nothing_given_spends_every_whole_block(tmp_path: Path) -> None:
    wallet = wallet_with(tmp_path, chips=100, points=3_642)
    answer = wallet.cash_points()
    assert answer["cashed"] == (3_642 // POINTS_PER_CHIP_BLOCK) * CHIPS_PER_BLOCK
    assert answer["points_left"] == 3_642 % POINTS_PER_CHIP_BLOCK
    assert wallet.read()["chips"] == 100 + answer["cashed"]


def test_a_slice_spends_only_that_slice_and_keeps_the_score(tmp_path: Path) -> None:
    wallet = wallet_with(tmp_path, chips=0, points=2_000)
    answer = wallet.cash_points(500)
    assert answer["cashed"] == (500 // POINTS_PER_CHIP_BLOCK) * CHIPS_PER_BLOCK
    assert answer["points_left"] == 1_500, "the rest of the score is kept for the leaderboard"
    assert wallet.read()["bonus"] == 1_500


def test_asking_for_more_than_is_held_spends_what_is_held(tmp_path: Path) -> None:
    wallet = wallet_with(tmp_path, chips=0, points=40)
    answer = wallet.cash_points(100_000)
    assert answer["cashed"] == (40 // POINTS_PER_CHIP_BLOCK) * CHIPS_PER_BLOCK
    assert answer["points_left"] == 40 % POINTS_PER_CHIP_BLOCK


def test_a_number_that_is_not_a_whole_block_spends_the_blocks(tmp_path: Path) -> None:
    wallet = wallet_with(tmp_path, chips=0, points=1_000)
    answer = wallet.cash_points(7)
    assert answer["cashed"] == CHIPS_PER_BLOCK, "seven points is one block of four, not one and three quarters"
    assert wallet.read()["bonus"] == 996, "four points are spent, the odd three stay"


def test_a_negative_or_zero_request_changes_nothing(tmp_path: Path) -> None:
    wallet = wallet_with(tmp_path, chips=55, points=1_000)
    for wanted in (0, -500):
        answer = wallet.cash_points(wanted)
        assert answer["cashed"] == 0
    held = wallet.read()
    assert held["chips"] == 55 and held["bonus"] == 1_000
