"""Run via browser_exec with pre-imported browser helpers, after browser_table_server.py.

Example browser_exec code (local=True):
  exec(open('.../tests/browser_table_checks.py').read())

This is the quick check: a real browser, the real module, real commands and scratch state. It
covers what the Node harness cannot (a real page, real pointer events, real API writes). The
full per-game proof — every table game played to its winner screen with pointer input only,
with screenshots — is `tools/browser_drive.mjs` (see RESULTS.md).

The normal table has no move box and no move picker: a person presses the board. Anything that
used to be a typed or dropped-down control now sits behind the More options disclosure, which this
script opens by hand when it needs those controls.
"""
import json
import time
import os
from pathlib import Path

js, cdp, new_tab, goto_url, wait_for_load, click_at_xy, capture_screenshot = (
    globals()[name] for name in ('js', 'cdp', 'new_tab', 'goto_url', 'wait_for_load', 'click_at_xy', 'capture_screenshot')
)

BASE = 'http://127.0.0.1:18764/'
OUT = Path(os.environ.get('GAMESHELF_QA_OUT', str(Path(__file__).resolve().parent.parent / 'test-artifacts' / 'browser-qa')))
OUT.mkdir(parents=True, exist_ok=True)
results = []


def record(flow, **details):
    results.append({'flow': flow, 'passed': True, **details})
    print(results[-1])
    (OUT / 'checks.json').write_text(json.dumps(results, indent=2))


def button(label):
    js("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()===" + json.dumps(label) + ");if(!b||b.disabled)throw Error('Missing/enabled button: ' + " + json.dumps(label) + ");b.click()})()")
    time.sleep(.15)


def open_advanced():
    js("(()=>{const d=document.querySelector('.games-advanced');if(d)d.open=true})()")
    time.sleep(.1)


def state():
    return js("fetch('/qa/state').then(r=>r.json()).then(x=>x.picture)")


SVG = "[...document.querySelectorAll('svg')].find(x=>/board/.test(x.getAttribute('aria-label')||''))"


def press_column(token):
    """Press a Connect Four column on the drawn board, where a person would press it."""
    spot = js("(()=>{const s=" + SVG + ";const m=s.getScreenCTM();const p=s.createSVGPoint();"
              "p.x=10+(" + json.dumps(str(token)) + "-1)*36+18;p.y=110;const o=p.matrixTransform(m);return [o.x,o.y]})()")
    click_at_xy(spot[0], spot[1])
    time.sleep(.3)


cdp('Emulation.setDeviceMetricsOverride', width=1280, height=1000, deviceScaleFactor=1, mobile=False)
new_tab(BASE)
wait_for_load()
time.sleep(1.0)
assert js("qa.calls.length") == 0

# The library is a grid of games; a card opens that game's own screen.
js("[...document.querySelectorAll('button')].find(x=>x.innerText.includes('Connect Four')).click()")
time.sleep(1.0)
assert js("document.body.innerText.includes('Choose how to play')"), 'a game opens on its own screen'
assert not js("document.body.innerText.includes('Your library')"), 'the library is not underneath the game'
assert not js("!!document.querySelector('.games-play-table input[placeholder*=\"Your move\"]')"), 'no move box'
assert not js("!!document.querySelector('.games-play-table select[aria-label=\"Legal move\"]:not(details *)')"), \
    'the move picker, if present, is behind More options'
record('own game screen, no typing box, picker behind More options', screenshot=capture_screenshot())

button('Play the computer')
time.sleep(1.2)
assert js("document.body.innerText.includes('You vs Computer')"), js('document.body.innerText')[:200]
assert js("!!document.querySelector('.games-turn-dot')"), 'whose turn it is is shown as a dot'

press_column(4)
picture = state()
assert picture['moves'][:1] == ['4'], 'a press on the board submits the real move: ' + json.dumps(picture['moves'])
assert picture['status'] == 'active'
record('pointer press plays a move through the real API', moves=picture['moves'], first=capture_screenshot())

# Resign sits in the table's one action row under the board, and still asks first.
button('Resign')
assert js("!!document.querySelector('[role=alertdialog]')")
button('Confirm resign')
time.sleep(.6)
assert state()['status'] != 'active'
record('resign still confirms, and ends the match')

# The game screen fits the window: no sideways scrolling, the board is inside the viewport.
metrics = js("(()=>{const t=document.querySelector('.games-play-table');const s=" + SVG + ";"
             "const b=s.getBoundingClientRect();return {doc:document.documentElement.scrollWidth,width:innerWidth,"
             "tableScroll:t.scrollWidth,tableWidth:t.clientWidth,boardBottom:b.bottom,viewH:innerHeight}})()")
assert metrics['doc'] <= metrics['width'], metrics
assert metrics['tableScroll'] <= metrics['tableWidth'], metrics
assert metrics['boardBottom'] <= metrics['viewH'] + 1, 'the board is reachable without scrolling: ' + json.dumps(metrics)
record('the game screen fits the window', metrics=metrics, screenshot=capture_screenshot())

assert js('qa.errors') == [], js('qa.errors')
assert js('qa.consoleErrors') == [], js('qa.consoleErrors')
record('no browser console errors, uncaught errors, or unhandled rejections', errors=js('qa.errors'), console_errors=js('qa.consoleErrors'))
(OUT / 'commands.json').write_text(json.dumps(js('qa.calls'), indent=2))
print('ALL REAL-BROWSER CHECKS PASSED; evidence:', OUT)
