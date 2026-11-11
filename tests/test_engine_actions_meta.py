"""A game's actions() takes meta only if that game declares it.

Only ``mafia`` accepts ``meta=``; every other game's signature is
``actions(env, seat, draft=None)``. The engine passed ``meta`` unconditionally, so a
machine move in any non-mafia game raised TypeError. These tests pin the adapter that
fixed it, so the asymmetry cannot come back silently.
"""
import inspect

from talktable import engine as engine_mod
from talktable.engine import GAMES


class NoMeta:
    @staticmethod
    def actions(env, seat, draft=None):
        return ['plain']


class WithMeta:
    @staticmethod
    def actions(env, seat, draft=None, meta=None):
        return ['meta'] if meta else []


def test_shipped_games_disagree_about_meta():
    """The reason the adapter exists: the game surface is not uniform."""
    takes = {gid: 'meta' in inspect.signature(game.actions).parameters
             for gid, game in GAMES.items()}
    assert takes.get('mafia') is True
    assert takes.get('liars-dice') is False
    assert True in takes.values() and False in takes.values()


def test_a_game_without_meta_is_called_without_it():
    assert engine_mod.call_actions(NoMeta(), None, 0, None, {'seat': 0}) == ['plain']


def test_a_game_with_meta_receives_it():
    assert engine_mod.call_actions(WithMeta(), None, 0, None, {'seat': 0}) == ['meta']


def test_a_game_with_meta_gets_none_when_no_meta_is_supplied():
    assert engine_mod.call_actions(WithMeta(), None, 0) == []
