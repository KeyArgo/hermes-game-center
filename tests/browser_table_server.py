"""Isolated real-module browser QA server. No production config/storage is loaded.

Run: python tests/browser_table_server.py --root "$TMPDIR/gameshelf-browser" --port 18764
Requires existing fastapi/uvicorn and internet for pinned React ESM downloads.
Only SDK imports are stubbed; the complete actual plugin module is rendered.
"""
from pathlib import Path
import argparse
import base64
import importlib.util
import json
import os
import struct
import urllib.request
import zlib


def _qa_pet_thumb() -> str:
    """A made-up mascot for the QA page: drawn here, never a real Hermes pet.

    The plugin is only ever allowed to *display* the user's installed pet through
    the gateway, so the browser harness stands in for that gateway with a sprite
    of its own. Nothing is copied out of a Hermes home.
    """
    size = 32
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            dx, dy = x - 15.5, y - 15.5
            radius2 = dx * dx + dy * dy
            if radius2 <= 15.0 * 15.0:
                pixel = (18, 28, 44, 255) if radius2 > 13.0 * 13.0 else (110, 200, 255, 255)
                pixel = (60, 140, 230, 255) if 8.0 * 8.0 < radius2 <= 13.0 * 13.0 else pixel
                if (abs(dx - 5.0) < 1.6 or abs(dx + 5.0) < 1.6) and abs(dy + 2.0) < 2.6:
                    pixel = (12, 20, 34, 255)
                row.extend(pixel)
            else:
                row.extend((0, 0, 0, 0))
        rows.append(bytes(row))
    raw = b''.join(rows)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack('>I', len(data)) + kind + data + struct.pack(
            '>I', zlib.crc32(kind + data) & 0xFFFFFFFF
        )

    png = (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(raw, 9))
        + chunk(b'IEND', b'')
    )
    return 'data:image/png;base64,' + base64.b64encode(png).decode('ascii')


def _write_demo_pet(folder: Path, slug: str) -> None:
    """Write a small synthetic Hermes pet (8 columns x 9 rows of 192x208) into *folder*.

    Hermes's own renderer reads it exactly as it reads an installed pet: the QA run only
    needs a real atlas shape, not real art. Written with the standard library so this
    harness keeps working on a machine with no image libraries.
    """
    import struct
    import zlib

    width, height = 192 * 8, 208 * 9
    frame_w, frame_h = 192, 208
    rows = bytearray()
    poses = [(0, 0), (0, 4), (3, 0), (0, 8), (0, 0), (1, 0), (2, 0), (0, 2), (1, 3)]
    for y in range(height):
        rows.append(0)  # filter: none
        row_y = y % frame_h
        row_index = y // frame_h
        lift, wobble = poses[min(row_index, len(poses) - 1)]
        for x in range(width):
            col = x // frame_w
            in_x, in_y = x % frame_w, row_y
            # A body, two eyes and a pair of ears: enough to see a frame move.
            body = 46 <= in_y - lift <= 150 and 40 + wobble * col <= in_x <= 152 + wobble * col
            eyes = body and 88 <= in_y - lift <= 104 and (in_x in range(64, 76) or in_x in range(116, 128))
            ears = 26 <= in_y - lift < 52 and (in_x in range(60, 76) or in_x in range(116, 132))
            if eyes:
                rows += bytes((16, 20, 28, 255))
            elif body:
                tint = 40 if col % 2 else 70
                rows += bytes((110 + tint, 168, 206, 255))
            elif ears:
                rows += bytes((110, 168, 206, 220))
            else:
                rows += bytes((0, 0, 0, 0))
    raw = zlib.compress(bytes(rows), 6)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (struct.pack('>I', len(data)) + kind + data
                + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF))

    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'spritesheet.png').write_bytes(
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
        + chunk(b'IDAT', raw) + chunk(b'IEND', b''))
    (folder / 'pet.json').write_text(json.dumps({
        'id': slug, 'displayName': slug.replace('-', ' ').title(),
        'description': 'Synthetic QA pet drawn by the browser harness.',
        'spritesheetPath': 'spritesheet.png',
    }), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--port', type=int, default=18764)
    parser.add_argument('--game', default='connect4',
                        help='the game /qa/state reads; the page itself still lists every game')
    parser.add_argument('--ia-games', action='store_true', help='plant one working and one broken installed plugin')
    parser.add_argument('--lobby-url', default='', help='point online play at this lobby server (localhost only)')
    parser.add_argument('--fake-model', action='store_true', help='stand in for the model, so a ladder game can be proved')
    parser.add_argument('--fake-talk', action='store_true',
                        help='stand in for a talking-table model seat, answering in the Read/scratchpad/action shape')
    parser.add_argument('--pet', default='', metavar='SLUG',
                        help='plant a synthetic Hermes pet of this slug in the scratch home, so the pet sprite can be proved')
    parser.add_argument('--first-run', action='store_true',
                        help='open on the welcome with no name set, as a fresh install does')
    args = parser.parse_args()
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    plugin = Path(__file__).resolve().parents[1]
    if args.ia_games:
        # A Hermes home of its own, so these plugins are "installed" and the real
        # ~/.hermes plugins stay out of the run.
        os.environ['HERMES_HOME'] = str(root / 'home')
        fake = root / 'home' / 'plugins' / 'fake-game'
        fake.mkdir(parents=True, exist_ok=True)
        (fake / 'plugin.yaml').write_text('name: fake-game\nversion: "0.1.0"\n', encoding='utf-8')
        (fake / 'game.json').write_text(json.dumps({
            'id': 'fake-game', 'schema_version': 1, 'plugin_id': 'fake-game',
            'title': 'Fake Game', 'summary': 'A working game from another plugin.',
            'kind': 'external', 'desktop_route': '/fake-screen',
        }), encoding='utf-8')
        broken = root / 'home' / 'plugins' / 'broken-game'
        broken.mkdir(parents=True, exist_ok=True)
        (broken / 'plugin.yaml').write_text('name: broken-game\nversion: "0.1.0"\n', encoding='utf-8')
        (broken / 'game.json').write_text(json.dumps({
            'id': 'broken-game', 'schema_version': 1, 'plugin_id': 'broken-game',
            'title': 'Broken Game', 'summary': 'A game whose own screen has no usable address.',
            'kind': 'external', 'desktop_route': 'https://example.invalid/screen',
        }), encoding='utf-8')
    if args.pet:
        # A pet atlas drawn here, in a scratch Hermes home: the page proves the real
        # sprite path (cells -> canvas-free DOM) without touching the person's own pets.
        os.environ.setdefault('HERMES_HOME', str(root / 'home'))
        _write_demo_pet(Path(os.environ['HERMES_HOME']) / 'pets' / args.pet, args.pet)
    spec = importlib.util.spec_from_file_location('qa_plugin_api', plugin / 'dashboard/plugin_api.py')
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    api._data_root = lambda: root / 'data'
    api._config = lambda: {
        **({'model': {'default': 'Hermes-4-70B', 'provider': 'nous'}} if args.fake_model else {}),
        'plugins': {'entries': {'hermes-gameshelf': {'settings': {
            'allow_ai': True, **({'lobby_url': args.lobby_url} if args.lobby_url else {})}}}},
        **({'display': {'pet': {'enabled': True, 'slug': args.pet, 'scale': 0.5}}} if args.pet else {}),
    }
    if args.lobby_url:
        # The QA run must not touch the person's own credential store, and this build has
        # no writer for it anyway. Keep the online keys in this process's memory so the
        # pane can reach the *linked* state a real sign-up reaches.
        keys: dict[str, str] = {}
        source, _ladder = api._online_pair()
        source.secret = lambda name: keys.get(name, '')
        source.store_secret = lambda name, value: bool(keys.__setitem__(name, value)) or True
        original_forget = source.forget

        def forget() -> dict:
            answer = original_forget()
            keys.clear()  # this process keeps the keys; sign-out has to clear them too
            return answer

        source.forget = forget
    if args.fake_model:
        # A stand-in model for the ladder and playbook proofs: it reads the legal moves out of
        # the prompt and answers with the first one, exactly as a model would — and, when the
        # prompt asks for a private read, writes those lines first and the move on a MOVE: line.
        def fake_ask(entrant, system, prompt):
            legal = prompt.split('Legal moves: ', 1)[-1].split('\n', 1)[0].split(', ')
            move = legal[0] if legal else ''
            if 'Before you move' in prompt:
                return {'move': 'Their side is open. Take the middle first.\nMOVE: ' + move, 'tokens': 3}
            return {'move': move, 'tokens': 3}

        api._model_ready = lambda config: True
        api._champion_ask = lambda config, division='prompt': fake_ask
    if args.fake_talk:
        # A stand-in model seat for a talking table. It answers in the shape the
        # real prompt asks for, and only ever plays the action it names, so the
        # panel and the whisper can be proved without a model account.
        def fake_talk(prompt, max_tokens=0):
            if 'either [Cooperate] or [Defect]' in prompt:
                action = '[Cooperate]'
            elif 'The rules allow only these right now:' in prompt:
                allowed = prompt.split('The rules allow only these right now:', 1)[1]
                first = allowed.split(']', 1)[0] + ']'
                action = first.strip() or '[Cooperate]'
            else:
                action = 'I am watching what you do.'
            said = ('coach: I keep to the line you whispered. ' if 'corner coach whispered' in prompt.lower()
                    else '')
            read = ('<read>\n'
                    'know: only my own side of this table is mine to see.\n'
                    'saw: they spoke first and said little.\n'
                    'believe: they want me to think they will play it safe.\n'
                    'safe: keep this round cheap and fair.\n'
                    '</read>\n')
            scratch = (f'<think_scratchpad>{said}My own read says this round is worth more '
                       f'to both of us than a cheap trick. I take the line that keeps the '
                       f'table talking, and I watch the next move closely.</think_scratchpad>\n')
            return {'move': read + scratch + f'<action>{action}</action>', 'tokens': 26}

        api._complete = lambda: fake_talk
    # All setup runs through real command handlers, in scratch storage only.
    def install(line: str) -> None:
        answer = api.command({'line': line})
        if not answer.get('ok'):
            raise SystemExit(f"browser_table_server: {line} failed: {answer.get('text')}")
    if not args.first_run:
        install('name Browser QA')
    # The board is only interactive for an installed game (desktop/src/14-board-svg
    # gate), so a QA store that installs one game silently turns every other
    # game's board into a picture. Install everything the repo actually ships.
    # Use the manifest ids (hyphens, not folder names) and stop loudly if one
    # is refused, so a typo cannot leave a game silently uninstalled.
    for line in ['install connect4', 'install chessboard', 'install checkers', 'install gomoku',
                 'install hex', 'install reversi', 'install breakthrough',
                 'install seabattle', 'install liars-dice', 'install doctrine-arena',
                 'install mafia']:
        install(line)
    if args.game and args.game not in {'connect4'}:
        install(f'install {args.game}')
    if args.fake_talk:
        # A talking table on the shelf, so the private panel and the whisper can be
        # pressed through the real screen.
        install('install prisoners-dilemma')
    from fastapi import FastAPI
    from fastapi.responses import HTMLResponse, Response
    import uvicorn
    app = FastAPI()
    app.include_router(api.router, prefix='/api')
    pet_thumb = _qa_pet_thumb()
    assets = {}
    for name, url in {
        'react': 'https://esm.sh/react@19.1.0/es2022/react.mjs',
        'jsx': 'https://esm.sh/react@19.1.0/es2022/jsx-runtime.mjs',
        'dom': 'https://esm.sh/react-dom@19.1.0/es2022/react-dom.mjs',
        'client': 'https://esm.sh/react-dom@19.1.0/es2022/client.mjs',
        'scheduler': 'https://esm.sh/scheduler@0.26.0/es2022/scheduler.mjs',
    }.items():
        local = os.environ.get('GAMESHELF_REACT_ASSETS')
        filenames = {'react': 'react.mjs', 'jsx': 'jsx-runtime.mjs', 'dom': 'react-dom.mjs', 'client': 'client.mjs', 'scheduler': 'scheduler.mjs'}
        data = (Path(local) / filenames[name]).read_text(encoding='utf-8') if local else urllib.request.urlopen(url, timeout=30).read().decode('utf-8')
        data = data.replace('/react@19.1.0/es2022/react.mjs', '/asset/react')
        data = data.replace('/react-dom@19.1.0/es2022/react-dom.mjs', '/asset/dom')
        data = data.replace('/scheduler@0.26.0/es2022/scheduler.mjs', '/asset/scheduler')
        data = data.replace('/scheduler@^0.26.0?target=es2022', '/asset/scheduler')
        data = data.replace('"./react-dom.mjs"', '"/asset/dom"')
        for filename, asset_name in [('react.mjs', 'react'), ('react-dom.mjs', 'dom'), ('scheduler.mjs', 'scheduler')]:
            data = data.replace('./' + filename, '/asset/' + asset_name)
        assets[name] = data

    @app.get('/asset/{name}')
    def asset(name: str):
        return Response(assets[name], media_type='text/javascript')

    @app.get('/plugin.js')
    def module():
        source = (plugin / 'desktop/plugin.js').read_text(encoding='utf-8')
        source = source.replace("from '@hermes/plugin-sdk'", "from '/sdk.js'")
        source = source.replace("from 'react'", "from '/asset/react'")
        source = source.replace("from 'react/jsx-runtime'", "from '/asset/jsx'")
        return Response(source, media_type='text/javascript')

    @app.get('/sdk.js')
    def sdk():
        return Response('''
import React from '/asset/react'
const qa = (globalThis.qa = globalThis.qa || {})
const listeners = (qa.listeners = qa.listeners || {})
const busy = {
  value: false,
  seen: new Set(),
  get() { return this.value },
  subscribe(fn) { this.seen.add(fn); return () => this.seen.delete(fn) },
  set(next) { this.value = Boolean(next); this.seen.forEach(fn => fn(this.value)) }
}
qa.busy = busy
export const useValue = atom => {
  const [value, setValue] = React.useState(atom.get())
  React.useEffect(() => atom.subscribe(setValue), [atom])
  return value
}
export const PANES_AREA = 'panes'
export const PALETTE_AREA = 'palette'
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'nav'
export const STATUSBAR_AREAS = { right: 'right' }
export const host = {
  state: { busy },
  onEvent(type, fn) {
    (listeners[type] = listeners[type] || []).push(fn)
    return () => { listeners[type] = (listeners[type] || []).filter(item => item !== fn) }
  },
  notify(input) { (qa.notices = qa.notices || []).push(input) },
  navigate(route) { (qa.nav = qa.nav || []).push(route) },
  revealPane(id) { (qa.revealed = qa.revealed || []).push(id) },
  // The two gateway methods the arena may use to DISPLAY the person's own pet.
  // The page decides whether a pet is installed (?pet=1) and the thumbnail is a
  // mascot drawn by the harness, never a real pet file.
  request(method, params) {
    const pet = globalThis.qaPet || { enabled: false }
    if (method === 'pet.info') {
      return Promise.resolve(pet.enabled
        ? { enabled: true, slug: 'qa-pet', displayName: 'Pip', frameW: 32, frameH: 32 }
        : { enabled: false })
    }
    if (method === 'pet.thumb') {
      return Promise.resolve(pet.enabled ? { ok: true, dataUri: pet.thumb } : { ok: false })
    }
    return Promise.reject(new Error('no such gateway method: ' + method))
  }
}
'''.replace('__QA_PET_THUMB__', pet_thumb), media_type='text/javascript')

    @app.get('/')
    def index():
        return HTMLResponse('''<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Isolated Game Center QA</title>
<style>:root{--ui-text-primary:#e8edf4;--ui-text-secondary:#b4becc;--ui-text-tertiary:#7d8796;--ui-text-on-accent:#0b1220;--ui-stroke-secondary:#394656;--ui-accent:#7ec8ff}*{box-sizing:border-box}html,body,#root{height:100%;margin:0}body{font-family:system-ui;background:#101820;color:#e8edf4}#label{position:fixed;bottom:0;right:0;background:#503610;padding:3px 8px;z-index:10;font-size:10px}</style>
<div id="root"></div><div id="statusbar"></div><div id="label">ISOLATED QA · real commands · scratch storage</div>
<style>#statusbar{position:fixed;left:0;right:0;bottom:0;display:flex;gap:10px;align-items:center;padding:4px 10px;background:#18212c;border-top:1px solid #394656;font:12px system-ui;color:#7d8796;z-index:9}#statusbar:before{content:'Hermes desktop · status bar';letter-spacing:.08em;text-transform:uppercase;font-size:9px;color:#5d6675}#root{height:calc(100% - 28px)}</style>
<script>window.qa={errors:[],consoleErrors:[],calls:[]};window.qaPet={enabled:new URLSearchParams(location.search).get('pet')==='1',thumb:'__QA_PET_THUMB__'};const originalError=console.error.bind(console);console.error=(...args)=>{qa.consoleErrors.push(args.map(String).join(' '));originalError(...args)};addEventListener('error',e=>qa.errors.push(e.message));addEventListener('unhandledrejection',e=>qa.errors.push(String(e.reason)));</script>
<script type="module">
import React from '/asset/react';import {createRoot} from '/asset/client';import plugin from '/plugin.js';
const ctx={os:{openExternal(url){qa.external=(qa.external||[]).concat([url]);let b=document.getElementById('opened');if(!b){b=document.createElement('div');b.id='opened';b.style.cssText='position:fixed;top:8px;left:50%;transform:translateX(-50%);background:#503610;color:#fff;padding:6px 10px;border-radius:6px;font:12px system-ui;z-index:20';document.body.appendChild(b)}b.textContent='OPENED '+url;window.open(url,'_blank','noopener');return Promise.resolve(true)}},registerMany(entries){const bar=document.getElementById('statusbar');for(const entry of entries){if(entry.area==='routes')createRoot(document.getElementById('root')).render(entry.render());if(entry.area==='right'){const holder=document.createElement('span');holder.style.cssText='display:inline-flex;align-items:center;gap:8px';bar.appendChild(holder);createRoot(holder).render(entry.render())}}},async rest(path,opts={}){if(opts.body&&opts.body.line)qa.calls.push(opts.body.line);const r=await fetch('/api'+path,{...opts,headers:{'Content-Type':'application/json'},body:opts.body?JSON.stringify(opts.body):undefined});if(!r.ok)throw Error(await r.text());return r.json()}};plugin.register(ctx);
</script>'''.replace('__QA_PET_THUMB__', pet_thumb))

    @app.get('/pane')
    def pane_page():
        # The pane beside a stub chat. Only the SDK is stubbed: the pane component,
        # the board and every command are the real ones, and the chat itself is a
        # drawing, because the native Desktop cannot be opened here.
        return HTMLResponse('''<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Play while you code — isolated QA</title>
<style>
:root{--ui-text-primary:#e8edf4;--ui-text-secondary:#b4becc;--ui-text-tertiary:#7d8796;--ui-text-on-accent:#0b1220;--ui-stroke-secondary:#394656;--ui-accent:#7ec8ff;--ui-bg-editor:#101820;--ui-bg-elevated:#161e28}
*{box-sizing:border-box}html,body,#app{height:100%;margin:0}
body{font-family:system-ui;background:#0b1220;color:#e8edf4}
#app{display:grid;grid-template-columns:minmax(0,1fr) 400px;height:100%}
#chat{display:flex;flex-direction:column;gap:12px;padding:22px;min-width:0;overflow:auto;border-right:1px solid var(--ui-stroke-secondary)}
#chat h1{font-size:15px;margin:0 0 4px}
.bubble{max-width:620px;padding:10px 14px;border-radius:14px;font-size:14px;line-height:1.45}
.mine{background:#1d3a56;align-self:flex-end}
.theirs{background:#161e28;border:1px solid var(--ui-stroke-secondary)}
#chat-turn{font-size:12px;color:#7d8796}
.controls{display:flex;gap:8px;flex-wrap:wrap;margin-top:auto;border-top:1px dashed #394656;padding-top:14px}
.controls button{font:inherit;font-size:12px;padding:7px 11px;border-radius:8px;border:1px solid #394656;background:#161e28;color:#e8edf4;cursor:pointer}
.controls span{font-size:11px;color:#7d8796;width:100%}
#pane{min-width:0;height:100%;overflow:hidden}
#statusbar{position:fixed;left:0;right:0;bottom:0;height:24px;display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:0 10px;background:#0e141c;border-top:1px solid #394656;font-size:11px;color:#7d8796}
#label{position:fixed;bottom:24px;right:0;background:#503610;padding:3px 8px;z-index:30;font-size:10px;color:#fff}
</style>
<div id="app">
  <section id="chat" aria-label="Stub chat">
    <h1>Hermes — stub chat (not the real Desktop)</h1>
    <div class="bubble mine">Refactor the shelf tests, then run the full suite. Say "ok continue" when the plan is ready.</div>
    <div class="bubble theirs">Plan: split test_center.py, add a fixture for the catalog. Running the suite now.</div>
    <div id="chat-turn">nothing is running</div>
    <!-- The conversation's composer, as a real textarea: the over-chat copies find the chat column
         by walking up from the first textarea that is not one of the games' (see JP_chatColumn /
         jp2LChatColumn), and a stub chat with no composer could not test that at all. -->
    <textarea id="composer" rows="2" aria-label="Message Hermes" placeholder="Message Hermes"
      style="width:100%;resize:none;font:inherit;font-size:13px;padding:8px 10px;border-radius:10px;border:1px solid #394656;background:#101820;color:#e8edf4"></textarea>
    <div class="controls">
      <button id="working">Start a Hermes turn</button>
      <button id="finished">Finish the Hermes turn</button>
      <button id="approval">Hermes asks for approval</button>
      <span>These three drive the same public signals the Desktop gives a plugin: host.state.busy, message.complete and approval.request.</span>
    </div>
  </section>
  <section id="pane" aria-label="Game pane"></section>
</div>
<div id="statusbar"></div>
<div id="label">ISOLATED QA · real pane and board · stub chat</div>
<script>window.qa={errors:[],consoleErrors:[],calls:[],notices:[],actions:[],revealed:[]};const originalError=console.error.bind(console);console.error=(...args)=>{qa.consoleErrors.push(args.map(String).join(' '));originalError(...args)};addEventListener('error',e=>qa.errors.push(e.message));addEventListener('unhandledrejection',e=>qa.errors.push(String(e.reason)));</script>
<script type="module">
import React from '/asset/react'
import { createRoot } from '/asset/client'
import plugin from '/plugin.js'
import { host } from '/sdk.js'
const store = {
  get(key, fallback) {
    try { const raw = localStorage.getItem('qa.' + key); return raw === null ? fallback : JSON.parse(raw) } catch { return fallback }
  },
  set(key, value) { try { localStorage.setItem('qa.' + key, JSON.stringify(value)) } catch {} },
  remove(key) { try { localStorage.removeItem('qa.' + key) } catch {} }
}
const ctx = {
  storage: store,
  os: { notify: input => qa.notices.push(input), openExternal: url => { qa.external = (qa.external || []).concat([url]); return Promise.resolve(true) } },
  runAction: id => { qa.actions.push(id); document.getElementById('chat-turn').textContent = 'chat focused by the pane'; return { ok: true } },
  rest: async (path, options = {}) => {
    if (options.body) qa.calls.push(options.body.line)
    const answer = await fetch('/api' + path, { ...options, headers: { 'Content-Type': 'application/json' }, body: options.body ? JSON.stringify(options.body) : undefined })
    if (!answer.ok) throw Error(await answer.text())
    return answer.json()
  },
  registerMany(entries) {
    // The host calls this once per contribution batch: the pane arrives on its own (mountWaitPane),
    // the rest with the plugin's own list. Each area is drawn from ITS batch - a batch with no pane
    // (or no status item) is normal, and treating it as an error stopped the whole bar from drawing.
    const pane = entries.find(entry => entry && entry.area === 'panes')
    if (pane) createRoot(document.getElementById('pane')).render(React.createElement(pane.render))
    // EVERY status-bar item the plugin contributes, each in its own holder. The real desktop
    // renders them all in one bar (useStatusbarContributions reads the whole area); a QA page that
    // keeps only the first one hides whatever the later items draw - including the see-through slot
    // machine the over-chat switch is about, which is why it could never be seen here.
    const bar = document.getElementById('statusbar')
    const rights = entries.filter(item => item && item.area === 'right')
    for (const entry of rights) {
      try {
        const holder = document.createElement('span')
        holder.style.cssText = 'display:inline-flex;align-items:center;gap:8px'
        bar.appendChild(holder)
        createRoot(holder).render(React.createElement(entry.render))
      } catch (error) {
        console.error('QA: status-bar item ' + entry.id + ' failed: ' + (error && error.message))
        throw error
      }
    }
  }
}
plugin.register(ctx)
const fire = type => (qa.listeners[type] || []).forEach(fn => fn({ type }))
document.getElementById('working').onclick = () => { host.state.busy.set(true); document.getElementById('chat-turn').textContent = 'Hermes is working' }
document.getElementById('finished').onclick = () => { host.state.busy.set(false); fire('message.complete'); document.getElementById('chat-turn').textContent = 'Hermes finished' }
document.getElementById('approval').onclick = () => { fire('approval.request'); document.getElementById('chat-turn').textContent = 'waiting for an approval' }
</script>''')

    @app.get('/favicon.ico')
    def favicon():
        return Response(status_code=204)

    @app.get('/qa/state')
    def state(game: str = ''):
        return api.board(game or args.game)

    @app.post('/qa/arena')
    def arena_battle(body: dict | None = None):
        """Play one seeded Doctrine Arena battle, so the browser proof is repeatable."""
        try:
            seed = int((body or {}).get('seed', 7))
        except (TypeError, ValueError):
            seed = 7
        return api.command({'line': f'doctrine-arena play {seed}'})

    @app.post('/qa/open-seat')
    def open_seat():
        from shelf.who import Player
        catalog, book = api._open()
        return {'text': api.run(catalog, 'connect4 new', source='command', player=Player('discord:qa-other', 'Remote QA', 'discord'), names=book)}

    @app.post('/qa/second-seat')
    def second_seat(body: dict | None = None):
        """Another person starts a table here, so "with people" can be played in a browser.

        They go through the real command handler with their own player id, exactly as
        someone in another chat on the same Hermes would: they take white and leave the
        other seat open for the page to sit in.
        """
        from shelf.who import Player
        body = body or {}
        catalog, book = api._open()
        game = str(body.get('game') or 'chessboard')
        who = str(body.get('name') or 'Bea')
        player = Player(f'desktop:qa-{who.lower()}', who, 'desktop', named=True)
        text = api.run(catalog, f'{game} new white=human black=human', source='command', player=player, names=book)
        return {'text': text}

    @app.post('/qa/other-move')
    def other_move(body: dict | None = None):
        """The other person plays a move, so a table with people can be mid-game."""
        from shelf.who import Player
        body = body or {}
        catalog, book = api._open()
        game = str(body.get('game') or 'chessboard')
        token = str(body.get('move') or '')
        player = Player('desktop:qa-bea', 'Bea', 'desktop', named=True)
        return {'text': api.run(catalog, f'{game} move {token}', source='command', player=player, names=book)}

    @app.post('/qa/look')
    def look(body: dict | None = None):
        """A second person on this referee writes a /games looking line.

        It goes through the real lobby handler with its own player id, exactly as
        someone in another chat on the same Hermes would. ``{"stop": true}`` removes it.
        """
        from shelf.lobby import looking
        from shelf.who import Player
        body = body or {}
        catalog, _book = api._open()
        who = str(body.get('name') or 'Bea')
        game = 'stop' if body.get('stop') else str(body.get('game') or 'connect4')
        player = Player(f'desktop:qa-{who.lower()}', who, 'desktop', named=True)
        return {'text': looking(catalog.data_root, player, game, True,
                                address=str(body.get('address') or ''))}

    @app.get('/qa/setup')
    def setup_state():
        return api.setup_state()

    uvicorn.run(app, host='127.0.0.1', port=args.port)


if __name__ == '__main__':
    main()
