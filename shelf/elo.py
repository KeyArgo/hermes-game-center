"""Elo rating calculations."""

from __future__ import annotations

import math

START_RATING = 1500.0
K_FACTOR = 24
FLOOR_RATING = 100.0


def expected(rating_a: float, rating_b: float) -> float:
    try:
        exponent = (float(rating_b) - float(rating_a)) / 400.0
        if math.isnan(exponent):
            return 0.5
        if exponent > 300:
            return 0.0
        if exponent < -300:
            return 1.0
        return 1.0 / (1.0 + 10.0 ** exponent)
    except (TypeError, ValueError, OverflowError):
        return 0.5


def update(rating_a: float, rating_b: float, score_a: float, k: int = K_FACTOR) -> tuple[float, float]:
    try:
        a, b, score, factor = float(rating_a), float(rating_b), float(score_a), float(k)
        if not all(math.isfinite(x) for x in (a, b, score, factor)):
            raise ValueError
        score = min(1.0, max(0.0, score))
        change = factor * (score - expected(a, b))
        return round(max(FLOOR_RATING, a + change), 1), round(max(FLOOR_RATING, b - change), 1)
    except (TypeError, ValueError, OverflowError):
        return START_RATING, START_RATING
