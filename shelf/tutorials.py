"""Load and check the small, offline tutorials shipped beside games."""

from __future__ import annotations

import json
from pathlib import Path

from .kitref import kit


def learn_for(rules) -> dict | None:
    try:
        path = Path(str(getattr(rules, "__file__", "") or "")).with_name("learn.json")
        if not path.is_file():
            # Launch cards carry no files but their own code, so their tutorial
            # text ships in shelf/learn/<card>.json instead of the card folder.
            path = Path(__file__).with_name("learn") / f"{path.parent.name}.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def demo_frames(rules, data) -> list[dict]:
    demo = data.get("demo") or {}
    if "frames" in demo:
        return demo["frames"]
    state = kit.lesson_position(rules, {"setup": []})
    # A demo is two machines playing, so a game that hides a hand-over screen
    # between two people must not raise one here.
    if demo.get("seats") == "computer":
        state["white"] = state["black"] = "local"
    lines = {line.get("at"): line for line in demo.get("lines", []) if isinstance(line, dict)}
    frames = []
    def add(index, label):
        frames.append({"picture": rules.picture(state), "say": str(lines.get(index, {}).get("say") or ""), "label": label})
    add(0, "Start")
    for index, token in enumerate(demo.get("moves") or [], 1):
        legal = {str(rules.show(move)).lower(): move for move in rules.legal(state)}
        if state.get("status") != "active" or str(token).lower() not in legal:
            raise ValueError(f"demo move {index} ({token}) is not legal")
        move = legal[str(token).lower()]
        rules.play(state, move)
        shown = str(rules.show(move))
        state["plies"] += 1
        state["moves"].append(shown)
        state["last"] = shown
        add(index, shown)
    return frames


def problems(rules, data) -> list[str]:
    found = []
    if not isinstance(data, dict):
        return ["tutorial must be an object"]
    howto = data.get("howto")
    if not isinstance(howto, dict):
        found.append("missing howto")
        howto = {}
    if not howto.get("goal"):
        found.append("missing goal")
    sections = howto.get("sections")
    if not isinstance(sections, list) or not 2 <= len(sections) <= 6:
        found.append("sections must have 2 to 6 entries")
    controls = howto.get("controls")
    if not isinstance(controls, list) or not controls:
        found.append("missing controls")
    elif len(controls) > 6:
        found.append("controls must have at most 6 entries")
    coach = data.get("coach") if isinstance(data.get("coach"), dict) else {}
    steps = coach.get("steps")
    if not isinstance(steps, list) or not 3 <= len(steps) <= 7:
        found.append("coach steps must have 3 to 7 entries")
    def check_say(value, where):
        if isinstance(value, dict):
            for key, item in value.items():
                if key == "say" and len(str(item or "").split()) > 40:
                    found.append(f"{where}.say is over 40 words")
                check_say(item, f"{where}.{key}")
        elif isinstance(value, list):
            for index, item in enumerate(value):
                check_say(item, f"{where}[{index}]")
    check_say(data, "tutorial")
    demo = data.get("demo") if isinstance(data.get("demo"), dict) else {}
    moves = demo.get("moves") or []
    if not isinstance(moves, list):
        found.append("demo moves must be a list")
        moves = []
    for line in demo.get("lines") or []:
        at = line.get("at") if isinstance(line, dict) else None
        if type(at) is not int or not 0 <= at <= len(moves):
            found.append(f"demo line at {at!r} is outside the moves")
    if moves:
        try:
            demo_frames(rules, {"demo": {"moves": moves, "seats": demo.get("seats")}})
        except Exception as error:
            found.append(f"demo does not replay: {error}")
    return found
