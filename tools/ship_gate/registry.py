"""The explicitly reviewed surface inventory."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Surface:
    id: str
    kind: str
    directory: str | None = None


BOARDS = ('connect4', 'reversi', 'checkers', 'gomoku', 'chess', 'go', 'hex', 'breakthrough')
SURFACES = tuple(Surface(name, 'board', 'chessboard' if name == 'chess' else name) for name in BOARDS) + (
    Surface('doctrine', 'card', 'doctrine'),
    Surface('doctrine-arena', 'card', 'doctrine_arena'),
    Surface('talk-auction', 'talk', 'blind_auction'),
    Surface('talk-liarsdice', 'talk', 'liars_dice'),
    Surface('talk-prisoners-dilemma', 'talk', 'prisoners_dilemma'),
    Surface('talk-mafia', 'talk', 'mafia'),
    Surface('liars-dice-2v2', 'talk', 'liars_dice_2v2'),
    Surface('mafia-town', 'town', 'mafia'),
    Surface('chess-coach', 'coach', 'chessboard'),
    Surface('lobby', 'lobby'),
    Surface('champions', 'champions'),
    Surface('side-pane', 'pane'),
    Surface('admin', 'admin'),
    Surface('sea-battle', 'sea', 'seabattle'),
    Surface('blackjack', 'table', 'blackjack'),
    Surface('slots', 'table', 'slots'),
)
BY_ID = {surface.id: surface for surface in SURFACES}
# The curated catalog ids the game 'seabattle'; the gate reports it as 'sea-battle'. Keep the
# alias resolvable so `--game seabattle` and the curated-set test both work.
BY_ID['seabattle'] = Surface('seabattle', 'sea', 'seabattle')
CHECKS = ('play', 'exit', 'hygiene', 'clear', 'looks', 'buttons')
