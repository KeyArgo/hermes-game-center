"""Small, single-event-loop matchmaking queue."""

class MatchQueue:
    def __init__(self):
        self.entries = {}
        self.reports = {}

    def prune(self, now):
        self.entries = {k: v for k, v in self.entries.items() if now - v['seen'] < 600}
        self.reports = {k: v for k, v in self.reports.items() if now - v[0] < 180}

    def remove(self, player_id):
        self.entries = {k: v for k, v in self.entries.items() if v['player_id'] != player_id}
        self.reports.pop(player_id, None)

    def match(self, game, pool, now):
        self.prune(now)
        candidates = sorted((e for e in self.entries.values() if e['game'] == game and e['pool'] == pool), key=lambda e: (e['joined'], e['player_id']))
        pairs = []
        while candidates:
            a = candidates.pop(0)
            wait = now - a['joined']
            window = 150 if wait < 15 else 300 if wait < 30 else float('inf')
            eligible = [b for b in candidates if a['player_id'] != b['player_id'] and (pool != 'bot' or (a['owner_id'] and b['owner_id'] and a['owner_id'] != b['owner_id'])) and abs(a['rating'] - b['rating']) <= window]
            if not eligible:
                continue
            b = next((b for b in eligible if b['level'] == a['level']), eligible[0])
            candidates.remove(b)
            for e in (a, b):
                self.entries.pop((pool, game, e['player_id']), None)
            pairs.append((a, b))
        return pairs
