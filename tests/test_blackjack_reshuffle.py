from blackjack import game


def test_shoe_rebuilt_during_split_excludes_cards_on_table(tmp_path, monkeypatch):
    monkeypatch.setattr(game, "_WALLET", game.wallet.Wallet(tmp_path / "wallet.json"))
    state = {"status": "active", "turn": "white", **game.fresh()}
    state.update(shoe="split", deck=["KH", "8D", "6C", "8S"])
    game.play(state, "bet10")
    game.play(state, "split")

    assert len(state["player_hands"]) == 2
    on_table = [card for hand in state["player_hands"] for card in hand["cards"]]
    cards = on_table + state["dealer"] + state["deck"]
    assert len(cards) == len(set(cards)) == 52
