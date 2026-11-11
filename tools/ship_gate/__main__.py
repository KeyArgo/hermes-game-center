"""Run the browser ship gate against an isolated QA server."""
import argparse
import json
import os
import re
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

from .registry import BY_ID, SURFACES, CHECKS
from . import report

ROOT = Path(__file__).resolve().parents[2]
INSPECT = Path(os.environ.get('TASTE_INSPECT', 'inspect.mjs'))
TITLES = {'connect4':'Connect Four','chess':'Chess','doctrine':'Doctrine','doctrine-arena':'Doctrine Arena','talk-auction':'Blind Auction','talk-liarsdice':"Liar's Dice",'talk-prisoners-dilemma':"Prisoner's Dilemma",'talk-mafia':'Mafia','liars-dice-2v2':"Liar's Dice 2v2",'mafia-town':'Mafia Town','chess-coach':'Chess','sea-battle':'Sea Battle','champions':'Champions'}
TALKS = {'talk-auction':'blind-auction','talk-liarsdice':'liars-dice','talk-prisoners-dilemma':'prisoners-dilemma','talk-mafia':'mafia'}
DRIVERS = {'liars-dice-2v2':('ld_proof.mjs','ld-proof.json'),'mafia-town':('mafia-town-proof.mjs','mafia-town-proof.json'),'champions':('champions_proof.mjs','champions-proof.json'),'lobby':('browser_lobby_proof.mjs','proof.json'),'side-pane':('browser_drive.mjs','drive-results.json')}

PROFILE_PREFIXES = ('ship-gate-page-', 'gameshelf-drive-', 'gameshelf-ld-', 'gameshelf-mafia-',
                    'gameshelf-petb-', 'gameshelf-champions-', 'gameshelf-lobby-', 'gameshelf-sea-')

def _temp_profiles():
    try:
        return {name for name in os.listdir(tempfile.gettempdir()) if name.startswith(PROFILE_PREFIXES)}
    except OSError:
        return set()

def _sweep_profiles(before, started):
    """Delete Chrome profile folders this run's node driver created but failed to remove."""
    if os.name != 'nt':
        return
    for _ in range(20):
        fresh = [name for name in _temp_profiles() - before
                 if (Path(tempfile.gettempdir()) / name).is_dir()
                 and (Path(tempfile.gettempdir()) / name).stat().st_mtime >= started - 1]
        if not fresh:
            return
        for name in fresh:
            shutil.rmtree(Path(tempfile.gettempdir()) / name, ignore_errors=True)
        time.sleep(0.5)

def run(cmd, timeout=270):
    # Killing node alone would orphan the headless Chrome it spawned (and its temp profile):
    # on Windows kill the whole tree of the process we started, by PID, then remove any
    # Chrome profile folder that appeared during this run.
    before = _temp_profiles() if os.name == 'nt' else set()
    started = time.time()
    try:
        p = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             text=True, encoding='utf-8', errors='replace')
        out, _ = p.communicate(timeout=timeout)
        _sweep_profiles(before, started)
        return p.returncode, out
    except subprocess.TimeoutExpired:
        if os.name == 'nt':
            subprocess.run(['taskkill', '/pid', str(p.pid), '/T', '/F'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            p.kill()
        try:
            out, _ = p.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill(); out = ''
        _sweep_profiles(before, started)
        return 1, f'timed out after {timeout}s\n' + (out or '')
    except OSError as exc:
        return 1, str(exc)

def item(status, reason, evidence=()):
    return {'status':status, 'reason':reason, 'evidence':[str(x) for x in evidence]}

def evidence(out):
    return [str(p.relative_to(ROOT)) for p in sorted(out.rglob('*.png'))]

def read(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}

def model_pending():
    return 'agy (Gemini) not installed on this machine' if not shutil.which('agy') else 'model pass pending'

def page(surface, check, url, out):
    dest = out / (check + '.json')
    dest.unlink(missing_ok=True)
    cmd = ['node', 'tools/ship_gate/page.mjs', check, '--url', url, '--out', str(out), '--json', str(dest)]
    if surface.id == 'side-pane': cmd += ['--route', '/pane']
    if surface.id == 'admin': cmd += ['--route', '/setup']
    if surface.id not in ('lobby','side-pane','admin'): cmd += ['--surface', TITLES.get(surface.id,surface.id.title())]
    if check == 'play': cmd += ['--action', {'doctrine':'Play a battle','doctrine-arena':'Fight'}.get(surface.id,'^(Open|Start)$')]
    # Sea Battle's fleet screen renders 200+ cell buttons; pressing them all with the
    # before/after DOM comparison needs a bigger budget than a card-sized screen.
    code, log = run(cmd, 1800 if check == 'buttons' else 270)
    (out/(check + '.log')).write_text(log, encoding='utf-8')
    data = read(dest)
    if not data: return item('fail', 'browser check failed: ' + log[-300:])
    if data.get('error'): return item('fail', data['error'].splitlines()[0])
    if check == 'clear':
        if not data.get('found') or not data.get('completed'): return item('fail', data.get('reason','tutorial incomplete'), evidence(out))
        verdict = read(out / 'comprehension-verdict.json')
        if not isinstance(verdict.get('ok'), bool): return item('skip', model_pending(), evidence(out))
        return item('pass' if verdict['ok'] else 'fail', verdict.get('quote','model verdict'), evidence(out))
    if check == 'play':
        if data.get('result_overlay'): return item('pass','result overlay reached', evidence(out))
        return item('skip' if not data.get('moves') else 'fail', data.get('reason','no result'), evidence(out))
    if check == 'exit':
        bad = [f"{k}: {v.get('reason') or v.get('status')}" for k,v in data.items() if isinstance(v,dict) and v.get('status') != 'pass']
        return item('fail' if any(isinstance(v,dict) and v.get('status') == 'fail' for v in data.values()) else ('skip' if bad else 'pass'), '; '.join(bad) or 'exit checks passed', evidence(out))
    return item('pass' if data.get('pass') else 'fail', 'passed' if data.get('pass') else f'{check} findings in {dest.relative_to(ROOT)}', evidence(out))

def clear_board(surface, url, out):
    """A board game's How to play is its lesson: run it to the end with real moves."""
    dest = out / 'lesson'
    dest.mkdir(parents=True, exist_ok=True)
    (dest / 'drive-results.json').unlink(missing_ok=True)
    code, log = run(['node', 'tools/browser_drive.mjs', '--url', url, '--out', str(dest),
                     '--game', surface.directory, '--lesson'], 300)
    (dest / 'driver.log').write_text(log, encoding='utf-8')
    rows = read(dest / 'drive-results.json').get('results', [])
    row = rows[-1] if rows else {}
    if code or row.get('error'):
        return item('fail', 'lesson driver: ' + str(row.get('error') or log[-200:]), evidence(out))
    if not row.get('done'):
        return item('fail', 'lesson did not reach its end (%s steps)' % row.get('steps', 0), evidence(out))
    shot = dest / (surface.directory + '-lesson-1.png')
    if shot.exists():
        shutil.copyfile(shot, out / 'first-screen.png')
    lesson_text = row.get('lessonText') or ''
    (out / 'comprehension-prompt.txt').write_text(
        'How to play card (lesson) shown to the person:\n' + lesson_text +
        '\n\nGoal line from the screen:\n' + row.get('opened', '') +
        '\n\nScreenshot: ' + str(out / 'first-screen.png') + '\n', encoding='utf-8')
    verdict = read(out / 'comprehension-verdict.json')
    if not isinstance(verdict.get('ok'), bool):
        return item('skip', '%s (%d lesson steps completed)' % (model_pending(), row.get('steps', 0)), evidence(out))
    return item('pass' if verdict['ok'] else 'fail', verdict.get('quote', 'model verdict'), evidence(out))

def sea_battle(url, out):
    """The dedicated Sea Battle proof: placement by drag, battle to the end overlay, pass-and-play."""
    dest = out / 'drive-report.json'; dest.unlink(missing_ok=True)
    code, log = run(['node', 'tools/seabattle_drive.mjs', '--url', url, '--out', str(out)], 420)
    (out / 'driver.log').write_text(log, encoding='utf-8')
    data = read(dest)
    if not data: return item('fail', 'sea battle driver produced no report', [])
    failures = data.get('failures') or []
    return item('pass' if not failures else 'fail',
                '; '.join(failures[:3]) or 'beginner game to the result overlay, back out, pass-and-play cover',
                evidence(out))

def comprehend(out):
    """A fresh Gemini (different family from the builder) reads only the first screen and the
    how-to card, then states the goal and how to move. The verdict is recorded verbatim."""
    dest = out / 'comprehension-verdict.json'
    prompt = out / 'comprehension-prompt.txt'
    shot = out / 'first-screen.png'
    if not prompt.exists() or not shot.exists(): return None
    if dest.exists():
        data = read(dest)
        if isinstance(data.get('ok'), bool): return data
    if not shutil.which('agy'):
        (out / 'comprehension.log').write_text('agy (Gemini) is not installed on this machine; the model pass cannot be run.\n', encoding='utf-8')
        return None
    instruction = (
        "You are auditing a game's very first screen for a release gate. Look at the screenshot "
        "image file and the how-to-play text below, and answer two things: (1) the goal of the "
        "game, and (2) exactly how a player makes a move in the interface shown. If the text or "
        "the picture leaves you confused or they contradict each other, say so and set ok false.\n"
        'Reply with ONE JSON object on a single line and nothing else: {"ok":true,"quote":"<your answer>"}\n\n'
        + prompt.read_text()[:4000])
    code, log = run(['agy', '--mode', 'plan', '--model', 'gemini-4-argon-high',
                     '--print-timeout', '300s', '--add-dir', 'proof/ship_gate', '-p', instruction], 360)
    (out / 'comprehension.log').write_text(log, encoding='utf-8')
    match = None
    for candidate in reversed(re.findall(r'\{[^{}]*\}', log, re.S)):
        try:
            data = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(data.get('ok'), bool): match = data; break
    if match is None: return None
    write = json.dumps(match, ensure_ascii=False) + '\n'
    dest.write_text(write, encoding='utf-8')
    return match

def play(surface, url, out):

    if surface.kind == 'sea': return sea_battle(url, out)
    if surface.kind in ('board','talk') and surface.id != 'liars-dice-2v2':
        runs = ('beginner','expert','watch') if surface.kind == 'board' else ('play','watch')
        issues=[]
        for name in runs:
            dest=out/name; dest.mkdir(parents=True,exist_ok=True)
            (dest/'drive-results.json').unlink(missing_ok=True)
            cmd=['node','tools/browser_drive.mjs','--url',url,'--out',str(dest)]
            if surface.kind == 'board':
                cmd += ['--game', 'chess' if surface.id == 'chess' else surface.directory]
                cmd += ['--watch'] if name == 'watch' else ['--level',name.title()]
            else: cmd += ['--talk',TALKS[surface.id]] + (['--watch'] if name=='watch' else [])
            code, log=run(cmd, 270)
            (dest/'driver.log').write_text(log, encoding='utf-8')
            rows=read(dest/'drive-results.json').get('results',[])
            row=rows[-1] if rows else {}
            if code or row.get('error') or not (row.get('over') if surface.kind == 'board' else row.get('revealed')):
                issues.append(name+': '+str(row.get('error') or ('driver failed' if code else 'no result overlay')))
            elif name=='beginner' and not (row.get('rematchWorked') and row.get('backWorked')):
                issues.append('beginner: rematch or Back did not work')
            elif name=='beginner' and surface.kind=='board':
                offered=row.get('levelsOffered') or []
                required=['Beginner','Intermediate','Advanced','Expert']
                if not set(required).issubset(set(offered)):
                    issues.append('level buttons are '+('/'.join(offered) or 'none')+'; the rule wants Beginner/Intermediate/Advanced/Expert')
        return item('fail' if issues else 'pass', '; '.join(issues) or 'all runs reached result',evidence(out))
    if surface.id in DRIVERS:
        script, filename=DRIVERS[surface.id]; dest=out/filename;dest.unlink(missing_ok=True)
        cmd=['node','tools/'+script,'--url',url,'--out',str(out)]
        if surface.id=='side-pane': cmd+=['--pane']
        code, log=run(cmd);(out/'driver.log').write_text(log, encoding='utf-8');data=read(dest)
        # Specialized proofs have different contracts; do not infer a result from process exit.
        if not data: return item('fail','driver produced no proof JSON',evidence(out))
        return item('skip','driver proof does not establish all required play-to-finish conditions',evidence(out))
    return page(surface,'play',url,out)

def looks(surface, url, out):
    """Score the real screen with the Impeccable detector, on a signed-in snapshot.

    The detector launches its own Chrome profile, so it cannot inherit the QA session;
    GG's pass scored standalone DOM snapshots for the same reason. The bar is GG's:
    zero FAIL findings on a main screen.
    """
    if not shutil.which('node') or not INSPECT.exists(): return item('skip','detector or node missing')
    dest = out / 'looks-snapshot.json'
    dest.unlink(missing_ok=True)
    cmd = ['node','tools/ship_gate/page.mjs','snapshot','--url',url,'--out',str(out/'looks'),'--json',str(dest)]
    if surface.id == 'side-pane': cmd += ['--route','/pane']
    if surface.id == 'admin': cmd += ['--route','/setup']
    if surface.id not in ('lobby','side-pane','admin'): cmd += ['--surface', TITLES.get(surface.id, surface.id.title())]
    run(cmd)
    snapshot = read(dest).get('snapshot')
    if not snapshot: return item('skip','could not snapshot the screen',evidence(out))
    code, log = run(['node',str(INSPECT),snapshot,'--out',str(out/'looks'),'--app','--json'],240)
    (out/'looks.log').write_text(log, encoding='utf-8')
    findings = read(out/'looks'/'report.json').get('findings', [])
    failures = [f for f in findings if f.get('level') == 'FAIL']
    reason = f"{len(failures)} FAILs" + (': ' + ', '.join(sorted({f.get('id','unknown') for f in failures})) if failures else '')
    if code and not failures: reason = 'detector failed; see looks.log'
    return item('pass' if not failures and code == 0 else 'fail', reason, evidence(out) + [str(Path(snapshot).relative_to(ROOT))])

def main(argv=None):
    parser=argparse.ArgumentParser(description='Run the ship gate')
    parser.add_argument('--list',action='store_true');parser.add_argument('--game',choices=BY_ID);parser.add_argument('--url');parser.add_argument('--apply-flags',action='store_true')
    args=parser.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        try: stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError): pass
    if args.list:
        for s in SURFACES: print(f'{s.id}\t{s.kind}\t{s.directory or "-"}')
        return 0
    server=None; temp=None
    try:
        url=args.url
        if not url:
            with socket.socket() as sock:
                sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
            temp=tempfile.TemporaryDirectory(prefix=f'ship-gate-{os.getpid()}-')
            server=subprocess.Popen([sys.executable,'tests/browser_table_server.py','--root',temp.name,'--port',str(port)],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env={**os.environ,'GAMESHELF_IGNORE_SHIP':'1','PYTHONUTF8':'1'})
            url=f'http://127.0.0.1:{port}/'
            for _ in range(100):
                if server.poll() is not None: raise RuntimeError('QA server exited during startup')
                try:
                    with urllib.request.urlopen(url,timeout=1) as response:
                        if response.status==200: break
                except OSError: time.sleep(.2)
            else: raise RuntimeError('QA server did not become ready')
        selected=[BY_ID[args.game]] if args.game else SURFACES
        accumulated={}
        for surface in selected:
            out=ROOT/'proof'/'ship_gate'/surface.id;out.mkdir(parents=True,exist_ok=True)
            checks={}
            for check in CHECKS:
                try:
                    if surface.kind=='absent': result=item('skip','no such surface in the tree')
                    elif check=='play': result=play(surface,url,out)
                    elif check=='looks': result=looks(surface,url,out)
                    elif check=='clear':
                        result=clear_board(surface,url,out) if surface.kind=='board' else page(surface,'clear',url,out)
                        # The model leg: a fresh Gemini family model sees only the first screen
                        # plus the how-to card. Its verdict replaces the plain tutorial result
                        # (for boards, only when the lesson itself ran clean).
                        if (out/'comprehension-prompt.txt').exists() and (out/'first-screen.png').exists():
                            verdict=comprehend(out)
                            if verdict and (surface.kind!='board' or result['status']=='skip'):
                                result=item('pass' if verdict.get('ok') else 'fail', str(verdict.get('quote',''))[:300], evidence(out))
                    else: result=page(surface,check,url,out)
                except Exception as exc: result=item('fail',f'{type(exc).__name__}: {exc}')
                checks[check]=result
                print(f"[{surface.id}] {check} {result['status']} — {result['reason']}",flush=True)
            accumulated[surface.id]=checks
            report.save(ROOT, accumulated, merge=bool(args.game), apply_flags=args.apply_flags, directories={s.id:s.directory for s in SURFACES})
        return 0
    except (OSError, RuntimeError) as exc:
        print(f'ship gate: {exc}',file=sys.stderr);return 1
    finally:
        if server and server.poll() is None:
            if os.name == 'nt':
                # No ps/SIGTERM on Windows: stop the exact Popen object we started.
                server.terminate()
                try: server.wait(timeout=10)
                except subprocess.TimeoutExpired: server.kill();server.wait()
            else:
                ps=subprocess.run(['ps','-o','args=','-p',str(server.pid)],capture_output=True,text=True)
                if 'tests/browser_table_server.py' in ps.stdout:
                    server.send_signal(signal.SIGTERM)
                    try: server.wait(timeout=10)
                    except subprocess.TimeoutExpired: server.kill();server.wait()
        if temp: temp.cleanup()

if __name__=='__main__': raise SystemExit(main())
