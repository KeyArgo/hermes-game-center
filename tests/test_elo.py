"""Elo: the maths behind the ratings, checked by hand."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf import elo  # noqa: E402


def test_equal_ratings_expect_a_coin_flip():
    assert elo.expected(1500, 1500) == 0.5
    assert elo.expected(1500, 1900) < 0.1
    assert elo.expected(1900, 1500) > 0.9
    assert abs(elo.expected(1800, 1600) + elo.expected(1600, 1800) - 1.0) < 1e-12


def test_a_win_gains_and_the_opponent_loses_the_same():
    winner, loser = elo.update(1500, 1500, 1.0)
    assert winner == 1512.0 and loser == 1488.0
    assert round(winner - 1500, 6) == round(1500 - loser, 6)


def test_an_upset_moves_the_rating_more_than_a_expected_win():
    upset, _ = elo.update(1400, 1800, 1.0)
    expected_win, _ = elo.update(1800, 1400, 1.0)
    assert upset - 1400 > expected_win - 1800


def test_a_draw_leaves_equal_ratings_alone_and_helps_the_underdog():
    assert elo.update(1500, 1500, 0.5) == (1500.0, 1500.0)
    underdog, favourite = elo.update(1400, 1800, 0.5)
    assert underdog > 1400 and favourite < 1800
    assert round(underdog - 1400, 6) == round(1800 - favourite, 6)


def test_ratings_never_fall_below_the_floor():
    low, _ = elo.update(elo.FLOOR_RATING, 2600, 0.0, k=1000)
    assert low == elo.FLOOR_RATING


def test_junk_input_does_not_raise():
    assert elo.update("x", None, "y") == (elo.START_RATING, elo.START_RATING)
    assert elo.update(1500, 1500, 7.0) == elo.update(1500, 1500, 1.0)
    assert elo.update(1500, 1500, -3) == elo.update(1500, 1500, 0.0)
    assert elo.expected(float("nan"), 1500) == 0.5
