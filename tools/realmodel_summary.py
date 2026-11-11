"""Summarise the real-model ledgers written by tests/test_realmodel_play.py."""

import glob
import json

rows = []
for path in sorted(glob.glob("test-artifacts/tg/realmodel-*.json")):
    d = json.load(open(path))
    rows.append((d["game"], d["status"], d["plies"], d["agent_moves"], d["illegal"],
                 d["fallbacks"], d["average_seconds"], d["slowest_seconds"], d["calls"]))

print(f"{'game':13}{'status':8}{'plies':>6}{'agent':>7}{'ill':>5}{'fb':>4}{'avg_s':>7}{'slow':>7}{'calls':>7}")
for r in rows:
    print(f"{r[0]:13}{r[1]:8}{r[2]:>6}{r[3]:>7}{r[4]:>5}{r[5]:>4}{r[6]:>7}{r[7]:>7}{r[8]:>7}")

agent = sum(r[3] for r in rows)
illegal = sum(r[4] for r in rows)
fallbacks = sum(r[5] for r in rows)
calls = sum(r[8] for r in rows)
weighted = sum(r[6] * r[8] for r in rows) / calls
print(f"TOTAL: {agent} agent moves, {illegal} illegal, {fallbacks} fallbacks, "
      f"weighted avg {weighted:.3f}s over {calls} calls")
