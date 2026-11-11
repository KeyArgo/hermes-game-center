"""Persist gate results without discarding other surfaces on a single-surface run."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import tempfile

from .registry import CHECKS


def read_json(path, default):
    try:
        with Path(path).open(encoding='utf-8') as source:
            value = json.load(source)
        if not isinstance(value, dict):
            raise ValueError(f'{path}: expected an object')
        return value
    except FileNotFoundError:
        return default


def write_json(path, value):
    write_text(path, json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def write_text(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix='.' + path.name + '-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as output:
            output.write(text)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def markdown(results):
    lines = ['# Ship gate', '', '| Surface | ' + ' | '.join(CHECKS) + ' | Failure reasons | Screenshots |',
             '| --- | ' + ' | '.join('---' for _ in CHECKS) + ' | --- | --- |']
    for surface, checks in results.items():
        values = [checks.get(check, {}).get('status', 'skip') for check in CHECKS]
        reasons = '; '.join(f"{name}: {entry.get('reason', '')}" for name, entry in checks.items() if entry.get('status') != 'pass')
        screenshots = sorted({str(path) for entry in checks.values() for path in entry.get('evidence', []) if str(path).endswith('.png')})
        lines.append('| ' + surface.replace('|', '\\|') + ' | ' + ' | '.join(values) + ' | ' + reasons.replace('|', '\\|').replace('\n', ' ') + ' | ' + ', '.join(screenshots).replace('|', '\\|') + ' |')
    lines.extend(['', '## Details', ''])
    for surface, checks in results.items():
        lines.append(f'### {surface}')
        lines.append('')
        for check in CHECKS:
            result = checks.get(check, {'status': 'skip', 'reason': 'not run', 'evidence': []})
            evidence = result.get('evidence', [])
            if isinstance(evidence, str):
                evidence = [evidence]
            suffix = '; evidence: ' + ', '.join(str(item) for item in evidence) if evidence else ''
            lines.append(f"- {check}: {result['status']} — {result.get('reason', '')}{suffix}")
        lines.append('')
    return '\n'.join(lines)


def save(root, results, *, merge=False, apply_flags=False, directories=None):
    root = Path(root)
    all_results = read_json(root / 'ship_gate.json', {}) if merge else {}
    all_results.update(results)
    write_json(root / 'ship_gate.json', all_results)
    write_text(root / 'SHIP-GATE.md', markdown(all_results))
    ship = read_json(root / 'shelf/ship.json', {}) if merge else {}
    for surface, checks in results.items():
        failures = [f"{name}: {checks.get(name, {}).get('reason') or checks.get(name, {}).get('status', 'not run')}"
                    for name in CHECKS if checks.get(name, {}).get('status') != 'pass']
        ship[surface] = {'ship': not failures, 'checked': datetime.now(timezone.utc).isoformat(), 'fails': failures}
        directory = (directories or {}).get(surface)
        if apply_flags and directory:
            manifest = root / directory / 'game.json'
            if manifest.exists():
                data = read_json(manifest, {})
                data['ship'] = not failures
                write_json(manifest, data)
    write_json(root / 'shelf/ship.json', ship)
