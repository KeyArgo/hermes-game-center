import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

spec = importlib.util.spec_from_file_location("slots_paytable_rules", ROOT / "slots/game.py")
game = importlib.util.module_from_spec(spec)
spec.loader.exec_module(game)


def test_picture_paytable_uses_the_shown_bet(tmp_path, monkeypatch):
    wallet = game.wallet_module.Wallet(tmp_path / "wallet.json")
    monkeypatch.setattr(game, "_wallet", wallet)
    wallet.set_bet(100)
    picture = game.picture(game.fresh())
    assert picture["bet"] == 100
    machine = picture["machine"]
    lines = len(game.slotplay.MACHINES[machine]["lines"])
    assert picture["paytable"] == game.slotplay.paytable(machine, picture["bet"] // lines)
