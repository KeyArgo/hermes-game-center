#!/usr/bin/env python3
"""Stage a REAL referee refusal for the README screenshot. No product code is touched.

    python3 tools/referee_refusal_stage.py <root>

It drives the plugin's own command handlers (dashboard/plugin_api.py) against a scratch data
root, with the model call standing in for "Your agent" via api._complete. The stand-in answers
with two illegal chess moves, so the referee does what it really does: it names each proposal
and its reason, refuses them, and lets the built-in player move instead. The refusal is written
by the real referee into the game's own state (`refusals`), and the browser then draws it.

It writes <root>/staged.json with the recorded sentence, and exits non-zero if no refusal was
recorded — a screenshot must never be taken of a board that was not really refused.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GAME = "chessboard"


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: referee_refusal_stage.py <root>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    root.mkdir(parents=True, exist_ok=True)

    spec = importlib.util.spec_from_file_location("qa_plugin_api", ROOT / "dashboard" / "plugin_api.py")
    assert spec and spec.loader
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    # Same scratch wiring tests/browser_table_server.py uses: the real handlers, this root only.
    api._data_root = lambda: root / "data"
    api._config = lambda: {"plugins": {"entries": {"hermes-gameshelf": {"settings": {"allow_ai": True}}}}}

    # The model seat: two illegal replies, exactly the shape kit.py asks a model for.
    replies = iter(["a8a1", "e8e8"])

    def fake_complete(prompt: str, max_tokens: int = 0) -> dict:
        try:
            move = next(replies)
        except StopIteration:
            move = "a8a1"
        return {"move": move, "remark": "", "tokens": 1}

    api._complete = lambda: fake_complete

    def run(line: str) -> dict:
        answer = api.command({"line": line})
        print(f"  {line} -> {str(answer.get('text'))[:70]!r} ok={answer.get('ok')}")
        return answer

    run("name Browser QA")
    run(f"install {GAME}")
    run(f"allow-ai {GAME} black=agent")
    legal = (api.board(GAME).get("picture") or {}).get("legal") or []
    if not legal:
        print("no legal move offered: the staged game did not open", file=sys.stderr)
        return 1
    run(f"{GAME} move {legal[0]}")

    picture = api.board(GAME).get("picture") or {}
    refusals = picture.get("refusals") or []
    plies = int(picture.get("plies") or 0)
    record = refusals[-1] if refusals else {}
    message = str(record.get("message") or "")
    staged = {
        "ok": bool(message and record.get("proposals")),
        "game": GAME,
        "plies": plies,
        "newest_ply": plies - 1,
        "refusal_ply": record.get("ply"),
        "message": message,
        "proposals": record.get("proposals") or [],
        "played": record.get("played") or "",
    }
    (root / "staged.json").write_text(json.dumps(staged, indent=2), encoding="utf-8")
    print(json.dumps(staged, indent=2))
    if not staged["ok"]:
        print("the referee recorded no refusal: refusing to pose a screenshot", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
