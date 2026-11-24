import pytest

from blackjack import game


@pytest.mark.parametrize(("rank", "move"), [("4", "hit"), ("5", "double"), ("10", "stand")])
def test_hint_for_pairs_played_together(tmp_path, monkeypatch, rank, move):
    monkeypatch.setattr(game, "_WALLET", game.wallet.Wallet(tmp_path / "wallet.json"))
    state = {"status": "active", "turn": "white", **game.fresh()}
    state["deck"] = ["KH", rank + "D", "6C", rank + "S"]
    game.play(state, "bet10")
    assert "split" in game.legal(state)
    assert game.bot(state) == move
