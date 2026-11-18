// tests/overchat_slot_live.mjs -- the over-chat machines, in a REAL React render: off -> on, resized, both
// on, and a host that traps fixed positioning.
//
//   node tests/overchat_slot_live.mjs [--port 18831] [--shots DIR]
//
// The machines are contributed to `COMPOSER_AREAS.underside`, and 78-overchat-slot.js hangs a fixed stage
// off that slot's own box so the cabinets draw at the top of the window, over the conversation, as wide as
// the composer and centred on it. None of that can be checked by reading the source: it is layout, and
// layout only exists after a real commit. This script drives the built bundle in headless Chrome against
// tests/browser_table_server.py:
//
//   1. the pane page opens with both switches off: no strip, no copy;
//   2. the switch is turned on by CLICKING the cabinet's own "Show as backdrop" checkbox — a real React
//      state change, no reload — and the copy must be drawn at the TOP of the window, centred over the
//      slot it hangs off, and at least 200 px tall at 1280x800;
//   3. the window is resized: the copy must re-measure to the new slot width and follow its centre;
//   4. both switches on: two machines, side by side, still at the top;
//   5. a host whose status bar has a transform traps even the stage: the placement check has to
//      see that and fall back to drawing in the slot, where the copy is still visible;
//   6. the switch is turned off again: the copy and the strip must both go.
//
// Exit code 1 means the machines really did not appear (or did not follow a resize).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = Number(arg('port', String(18830 + (process.pid % 60))))
const SHOTS = arg('shots', '')
const URL_BASE = `http://127.0.0.1:${PORT}/`
const CHROME = process.env.CHROME_BIN || (fs.existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : 'google-chrome')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const failures = []
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`)
  if (!ok) failures.push(detail ? `${name} (${detail})` : name)
}

// ---------------------------------------------------------------- the QA host
// The pinned React modules are served from the repo when they are there (no network), otherwise the
// server fetches them the way it always has.
const vendor = path.join(ROOT, 'online', 'web', 'vendor')
const env = { ...process.env }
if (!env.GAMESHELF_REACT_ASSETS && fs.existsSync(path.join(vendor, 'react.mjs'))) {
  env.GAMESHELF_REACT_ASSETS = vendor
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'overchat-live-'))
const server = spawn('python3', [path.join(ROOT, 'tests/browser_table_server.py'),
  '--root', path.join(scratch, 'root'), '--port', String(PORT), '--game', 'slots'],
  { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
let serverLog = ''
server.stdout.on('data', chunk => { serverLog += chunk })
server.stderr.on('data', chunk => { serverLog += chunk })
const stopServer = () => { try { server.kill('SIGKILL') } catch { /* gone */ } }
process.on('exit', () => { stopServer(); try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ } })

let up = false
for (let attempt = 0; attempt < 120; attempt += 1) {
  try {
    const answer = await fetch(URL_BASE)
    if (answer.ok) { up = true; break }
  } catch { /* not listening yet */ }
  await sleep(500)
}
if (!up) {
  // 77 is "this machine cannot run the check", which is not the same as "the machine is broken": the CI
  // runner has Chrome but no uvicorn, so the QA server cannot start there. The wrapper turns 77 into a skip
  // with the reason, instead of failing a build over a missing test dependency.
  const missing = /No module named '([^']+)'/.exec(serverLog)
  console.log(`skipped: the QA server did not start${missing ? ` (no ${missing[1]})` : ''}`)
  if (serverLog.trim()) console.log(serverLog.slice(-1200))
  process.exit(77)
}

// ---------------------------------------------------------------- Chrome, over CDP
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'overchat-live-chrome-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--mute-audio', '--no-sandbox', '--disable-gpu',
  '--window-size=1400,900', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' })
const stopChrome = () => { try { chrome.kill('SIGKILL') } catch { /* gone */ } }
process.on('exit', () => { stopChrome(); try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10 }) } catch { /* best effort */ } })

let page = null
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const tabs = await (await fetch(`http://127.0.0.1:${PORT + 1}/json`)).json()
    page = tabs.find(tab => tab.type === 'page')
    if (page) break
  } catch { /* not up yet */ }
  await sleep(500)
}
if (!page) { console.error('chrome did not open a page'); process.exit(1) }

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(resolve => { socket.onopen = resolve })
let counter = 0
const waiting = new Map()
socket.onmessage = message => {
  const data = JSON.parse(message.data)
  if (data.id && waiting.has(data.id)) { waiting.get(data.id)(data.result || data.error); waiting.delete(data.id) }
}
const cdp = (method, params = {}) => new Promise(resolve => {
  const id = ++counter
  const timer = setTimeout(() => { if (waiting.delete(id)) resolve({ __timeout: true, method }) }, 20000)
  waiting.set(id, answer => { clearTimeout(timer); resolve(answer) })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const answer = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (answer && answer.exceptionDetails) return undefined
  return answer && answer.result ? answer.result.value : undefined
}
const shot = async name => {
  if (!SHOTS) return
  fs.mkdirSync(SHOTS, { recursive: true })
  const taken = await cdp('Page.captureScreenshot', { format: 'png' })
  if (taken && taken.data) fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(taken.data, 'base64'))
}
const resize = async (width, height) => {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await sleep(2500)
}

// One read of the slot, the anchor, the stage, both cells and the copy — the boxes the checks compare.
const FACTS = `(() => {
  const slot = document.querySelector('#composer-slot')
  const strip = document.querySelector('[data-overchat="strip"]')
  const stage = document.querySelector('[data-overchat="stage"]')
  const copy = document.querySelector('[data-jp2-surface="copy"]')
  const box = copy ? copy.getBoundingClientRect() : null
  const slotBox = slot ? slot.getBoundingClientRect() : null
  const anchor = strip ? strip.getBoundingClientRect() : null
  const stageBox = stage ? stage.getBoundingClientRect() : null
  const cells = [...document.querySelectorAll('[data-overchat="slots"], [data-overchat="jackpot"]')].map(node => {
    const rect = node.getBoundingClientRect()
    const inner = node.querySelector('[data-jp2-surface="copy"], [data-jackpot="overchat"]')
    const innerBox = inner ? inner.getBoundingClientRect() : null
    return {
      kind: node.getAttribute('data-overchat'),
      left: rect.left, right: rect.right, width: rect.width,
      copy: innerBox ? { left: innerBox.left, right: innerBox.right, top: innerBox.top, width: innerBox.width, height: innerBox.height } : null
    }
  })
  return {
    slot: Boolean(slot),
    strip: Boolean(strip),
    place: strip ? strip.getAttribute('data-overchat-place') : null,
    stripWidth: strip ? Math.round(strip.getBoundingClientRect().width) : 0,
    anchorLeft: anchor ? anchor.left : null,
    anchorRight: anchor ? anchor.right : null,
    anchorHeight: anchor ? Math.round(anchor.height) : null,
    stage: Boolean(stage),
    stageTop: stageBox ? stageBox.top : null,
    stageLeft: stageBox ? stageBox.left : null,
    stageWidth: stageBox ? Math.round(stageBox.width) : 0,
    stageHeight: stageBox ? Math.round(stageBox.height) : 0,
    stagePosition: stage ? getComputedStyle(stage).position : null,
    cells,
    copy: Boolean(copy),
    copyWidth: box ? Math.round(box.width) : 0,
    copyHeight: box ? Math.round(box.height) : 0,
    copyTop: box ? box.top : null,
    copyBottom: box ? box.bottom : null,
    copyLeft: box ? box.left : null,
    copyRight: box ? box.right : null,
    copyInsideSlot: Boolean(copy && slot && slot.contains(copy)),
    copyPosition: copy ? getComputedStyle(copy).position : null,
    // The cabinet is a picture: the scale it is drawn at has to be the same in both axes, so nothing is
    // stretched into a squashed machine. Read from the transform matrix, which is what is really applied.
    copyScale: (() => {
      const stage = copy ? copy.querySelector('[data-jp2-stage]') : null
      const matrix = stage ? getComputedStyle(stage).transform : 'none'
      if (!matrix || matrix === 'none') return null
      const parsed = new DOMMatrixReadOnly(matrix)
      return { x: parsed.a, y: parsed.d, design: [stage.offsetWidth, stage.offsetHeight] }
    })(),
    slotTop: slotBox ? slotBox.top : null,
    slotWidth: slotBox ? Math.round(slotBox.width) : 0,
    view: { width: innerWidth, height: innerHeight },
    switchOn: Boolean(document.querySelector('[data-jp2-oc-box="overchat"]'))
      ? document.querySelector('[data-jp2-oc-box="overchat"]').checked
      : null,
    errors: (window.qa && window.qa.errors) || []
  }
})()`

const middle = (left, right) => (Number(left) + Number(right)) / 2

// The pane opens on its own lobby: pick Slots inside it, the way a person does, so the cabinet (and its
// own Show as backdrop switch) is on the page before anything is measured.
const openPane = async () => {
  const opened = await evaluate(`(() => {
    const cont = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Continue')
    if (cont) cont.click()
    const pane = document.querySelector('.games-wait-pane')
    const card = pane && [...pane.querySelectorAll('button')].find(b => (b.textContent || '').includes('Slots'))
    if (!card) return 'no Slots card in the pane'
    card.click()
    return 'picked'
  })()`)
  await sleep(3000)
  return opened
}

// ---------------------------------------------------------------- 1. both switches off at mount
// The pane page keeps plugin storage in its own localStorage, so this is the state a person has on a
// fresh install: nothing asked for, nothing drawn.
await cdp('Page.navigate', { url: `${URL_BASE}pane` })
await sleep(500)
await evaluate(`(() => { localStorage.removeItem('qa.jackpot2.overchat'); localStorage.removeItem('gameshelf.slots.overchat'); return true })()`)
await cdp('Page.navigate', { url: `${URL_BASE}pane` })
await sleep(7000)

const opened = await openPane()
const offAtMount = await evaluate(FACTS)
check('the pane drew the cabinet with its switches', opened === 'picked', String(opened))
check('both switches off at mount: no strip and no copy', Boolean(offAtMount && offAtMount.slot
  && !offAtMount.strip && !offAtMount.copy), JSON.stringify(offAtMount))

// ---------------------------------------------------------------- 2. the switch, clicked like a person
// 1280x800 is the window the size requirement is written against.
await resize(1280, 800)
const clicked = await evaluate(`(() => {
  const box = document.querySelector('[data-jp2-oc-box="overchat"]')
  if (!box) return 'no switch on the page'
  if (box.checked) return 'already on'
  box.click()
  return 'clicked'
})()`)
check('the cabinet offers its own Show as backdrop switch', clicked === 'clicked',
  `${clicked}: ${JSON.stringify(offAtMount && offAtMount.errors)}`)
await sleep(2500)

const onNow = await evaluate(FACTS)
// The composer dock is centred with a transform (as the Desktop's is), so the copy is drawn by the
// status-bar stage, not inside the slot: the slot keeps only the zero-height anchor.
check('turning it on draws the copy from the status-bar stage, with only an anchor left in the slot',
  Boolean(onNow && onNow.strip && onNow.copy && !onNow.copyInsideSlot && onNow.anchorHeight === 0
    && onNow.copyWidth > 40 && onNow.copyHeight > 40 && onNow.copyPosition !== 'fixed'),
  JSON.stringify(onNow))
// The fit has TWO limits and the tighter one wins: its share of the slot's width, or the height budget the
// stage hands it. A wide slot is therefore height-capped — that is the design, not a miss — and what must
// hold at every size is "inside the slot, never zero".
check('and it is fitted to the slot it was given: inside its share, capped by the height budget',
  Boolean(onNow && onNow.stripWidth > 0 && onNow.copyWidth > 40
    && onNow.copyWidth <= onNow.stripWidth + 1
    && onNow.copyHeight <= onNow.stageHeight + 1),
  `copy ${onNow && onNow.copyWidth}x${onNow && onNow.copyHeight} in strip ${onNow && onNow.stripWidth}`)
// Twice the old 320 px copy at 100% (640 px), so in an 800 px window the copy fills its whole 60% share.
check('and at 100% it is twice the old 320 px copy, up to its 60% share of the window',
  Boolean(onNow && onNow.copyHeight >= Math.min(640, onNow.stageHeight) - 2),
  `copy ${onNow && onNow.copyHeight} tall, stage ${onNow && onNow.stageHeight}`)
// The point of the anchor: the machines are drawn at the TOP of the window, over the conversation, not in
// the composer's underside where the slot happens to sit.
check('the copy is drawn at the top of the window, over the conversation',
  Boolean(onNow && onNow.stage && onNow.stagePosition === 'fixed' && onNow.place === 'top'
    && onNow.copyTop !== null && onNow.copyTop < onNow.view.height / 2
    && Math.abs(onNow.stageTop - 56) <= 4),
  `place ${onNow && onNow.place}, stage top ${onNow && onNow.stageTop}, copy top ${onNow && onNow.copyTop} of ${onNow && onNow.view.height}`)
check('and centred over the composer slot it hangs off, within 4px',
  Boolean(onNow && onNow.copy && onNow.anchorLeft !== null
    && Math.abs(middle(onNow.copyLeft, onNow.copyRight) - middle(onNow.anchorLeft, onNow.anchorRight)) <= 4),
  `copy centre ${onNow && middle(onNow.copyLeft, onNow.copyRight)}, anchor centre ${onNow && middle(onNow.anchorLeft, onNow.anchorRight)}`)
check('and large enough to be worth looking at: at least 200px tall at 1280x800',
  Boolean(onNow && onNow.view.width === 1280 && onNow.view.height === 800 && onNow.copyHeight >= 200),
  `copy ${onNow && onNow.copyWidth}x${onNow && onNow.copyHeight} in ${onNow && onNow.view.width}x${onNow && onNow.view.height}`)
// A picture, not a box: the cabinet is scaled by the same factor on both axes, and its box keeps the
// cabinet's own 560x720 proportions. Stretching it to fill the slot is the regression this pins.
check('and the cabinet keeps its own proportions instead of being stretched to fill the slot',
  Boolean(onNow && onNow.copyScale && onNow.copyScale.design[0] === 560 && onNow.copyScale.design[1] === 720
    && Math.abs(onNow.copyScale.x - onNow.copyScale.y) < 0.002
    && Math.abs(onNow.copyHeight / onNow.copyWidth - 720 / 560) < 0.02),
  JSON.stringify(onNow && { scale: onNow.copyScale, copy: [onNow.copyWidth, onNow.copyHeight] }))
await shot('overchat-on')

// ---------------------------------------------------------------- 3. a resize, after the switch
// The observer and the window listener are what make a later width change reach the copy: without them the
// machine keeps the size it happened to be measured at.
// A resize only shows in the copy's WIDTH once the slot is narrower than the height-capped width (249 px
// for this cabinet), because above that the height budget decides. So the test goes there: a window narrow
// enough that the width is the binding limit. What must hold whatever happens is that the copy follows the
// anchor: same centre, inside its width.
const widthBefore = onNow ? onNow.copyWidth : 0
await resize(520, 880)
const narrower = await evaluate(FACTS)
check('a narrower window re-measures the copy instead of leaving it at the old width',
  Boolean(narrower && narrower.copy && widthBefore > 0 && narrower.copyWidth > 0
    && narrower.copyWidth < widthBefore && narrower.copyWidth <= narrower.stripWidth + 1),
  `before ${widthBefore}, after ${narrower && narrower.copyWidth}, strip ${narrower && narrower.stripWidth}`)
check('and the copy follows the slot to its new centre, still in the top half',
  Boolean(narrower && narrower.copy && Math.abs(narrower.stageLeft - narrower.anchorLeft) <= 1
    && Math.abs(middle(narrower.copyLeft, narrower.copyRight) - middle(narrower.anchorLeft, narrower.anchorRight)) <= 4
    && narrower.copyTop < narrower.view.height / 2),
  `stage left ${narrower && narrower.stageLeft}, anchor left ${narrower && narrower.anchorLeft}, ` +
    `copy centre ${narrower && middle(narrower.copyLeft, narrower.copyRight)}, copy top ${narrower && narrower.copyTop}`)
await shot('overchat-resized-narrow')

await resize(1400, 900)
const wider = await evaluate(FACTS)
check('and a wider one grows it back',
  Boolean(wider && wider.copy && wider.copyWidth > (narrower ? narrower.copyWidth : 0)),
  `narrow ${narrower && narrower.copyWidth}, wide ${wider && wider.copyWidth}`)

// ---------------------------------------------------------------- 4. off again
const clickedOff = await evaluate(`(() => {
  const box = document.querySelector('[data-jp2-oc-box="overchat"]')
  if (!box || !box.checked) return 'not on'
  box.click()
  return 'clicked'
})()`)
await sleep(2000)
const offAgain = await evaluate(FACTS)
check('turning it off takes the copy and the strip away',
  clickedOff === 'clicked' && Boolean(offAgain && !offAgain.copy && !offAgain.strip),
  JSON.stringify(offAgain))

// ---------------------------------------------------------------- 5. both machines at once
// Two switches, one stage: each machine gets its own cell, so two of them can never draw over each other.
await resize(1280, 800)
await evaluate(`(() => { localStorage.setItem('gameshelf.slots.overchat', '1'); localStorage.setItem('qa.jackpot2.overchat', 'true'); return true })()`)
await cdp('Page.navigate', { url: `${URL_BASE}pane` })
await sleep(7000)
const bothOpened = await openPane()
const both = await evaluate(FACTS)
const bothCells = (both && both.cells) || []
check('both switches on draws both machines, each in its own cell',
  bothOpened === 'picked' && Boolean(both && both.strip && both.place === 'top')
    && bothCells.length === 2 && bothCells.every(cell => cell.width > 40),
  JSON.stringify(both && { place: both.place, cells: bothCells.map(cell => [cell.kind, Math.round(cell.width)]) }))
check('and both are at the top of the window with the slot, not stacked on each other',
  Boolean(both && both.cells.length === 2
    && both.cells.every(cell => !cell.copy || cell.copy.top < both.view.height / 2)
    && both.cells[0].right <= both.cells[1].left + 1
    && both.cells.every(cell => cell.copy ? cell.copy.left >= both.stageLeft - 2
      && cell.copy.right <= both.stageLeft + both.stageWidth + 2 : true)),
  JSON.stringify(both && both.cells.map(cell => [cell.kind, Math.round(cell.left), Math.round(cell.right),
    cell.copy && Math.round(cell.copy.left), cell.copy && Math.round(cell.copy.right)])))
await shot('overchat-both')

// ---------------------------------------------------------------- 6. a host that traps fixed positioning
// `?trap=1` puts a transform on the status bar, which makes it the containing block for the fixed stage, and
// draws no titlebar (the HUD window has none), so no stage can reach the top of the window. The placement check has to
// notice from the stage's own rect and fall back to drawing in the slot — visible, just not at the top.
await cdp('Page.navigate', { url: `${URL_BASE}pane?trap=1` })
await sleep(7000)
const trappedOpened = await openPane()
const trappedNow = await evaluate(FACTS)
check('a host that traps fixed positioning is noticed and the slot layout takes over',
  trappedOpened === 'picked' && Boolean(trappedNow && trappedNow.strip && trappedNow.copy
    && trappedNow.place === 'slot'),
  `place ${trappedNow && trappedNow.place}, stage ${trappedNow && trappedNow.stage}, ` +
    `cells ${trappedNow && trappedNow.cells.length}`)
check('and the machines are still drawn: in the slot, visible, inside it',
  Boolean(trappedNow && trappedNow.copy && trappedNow.copyInsideSlot
    && trappedNow.copyWidth > 40 && trappedNow.copyHeight > 40
    && trappedNow.copyPosition !== 'fixed'),
  `copy ${trappedNow && trappedNow.copyWidth}x${trappedNow && trappedNow.copyHeight} ` +
    `at ${trappedNow && trappedNow.copyTop}, inside ${trappedNow && trappedNow.copyInsideSlot}, ` +
    `place ${trappedNow && trappedNow.place}`)
await shot('overchat-trap-fallback')

// ---------------------------------------------------------------- 7. no status bar (Simple mode)
// Simple mode rests the status bar hidden, so its stage never mounts. The machines must still be drawn at
// the top of the window - from the titlebar stand-in - not dropped into the slot under the composer.
await cdp('Page.navigate', { url: `${URL_BASE}pane?nobar=1` })
await sleep(7000)
const barlessOpened = await openPane()
const barless = await evaluate(FACTS)
check('with no status bar the copy is still drawn at the top of the window, over the conversation',
  barlessOpened === 'picked' && Boolean(barless && barless.stage && barless.stagePosition === 'fixed'
    && barless.place === 'top' && barless.copy && barless.copyTop !== null
    && barless.copyTop < barless.view.height / 2),
  `place ${barless && barless.place}, stage ${barless && barless.stage}, copy top ${barless && barless.copyTop} of ${barless && barless.view.height}`)
const stageCount = await evaluate("document.querySelectorAll('[data-overchat=\"stage\"]').length")
check('and only one stage draws, never two copies', stageCount === 1, `${stageCount} stages`)
await shot('overchat-nobar-top')

// ---------------------------------------------------------------- 8. both stages present: the status bar draws
await cdp('Page.navigate', { url: `${URL_BASE}pane` })
await sleep(7000)
await openPane()
const owner = await evaluate("(() => { const s = document.querySelectorAll('[data-overchat=\"stage\"]'); return { count: s.length, inBar: s.length === 1 && Boolean(s[0].closest('#statusbar')) } })()")
check('with a status bar the status-bar stage draws, and the titlebar stand-in draws nothing',
  Boolean(owner && owner.count === 1 && owner.inBar), JSON.stringify(owner))

// ---------------------------------------------------------------- 9. the Games-page Size slider grows it
// Size 1 is today's size and the smallest; 2 must draw the machine clearly taller, still at the top and
// inside the window (owner, 2026-11-17: "make bigger or smaller, but right now the size is the smallest").
const before = await evaluate(FACTS)
await evaluate("localStorage.setItem('gameshelf.backdrop.size', '2'); 1")
await cdp('Page.navigate', { url: `${URL_BASE}pane` })
await sleep(7000)
await openPane()
const grown = await evaluate(FACTS)
check('a bigger backdrop size draws the machine clearly taller, still at the top and inside the window',
  Boolean(before && grown && grown.copy && before.copy && grown.place === 'top'
    && grown.copyHeight > before.copyHeight * 1.25 && grown.copyBottom <= grown.view.height),
  `before ${before && before.copyHeight}, after ${grown && grown.copyHeight}, bottom ${grown && grown.copyBottom} of ${grown && grown.view.height}`)
await shot('overchat-size-2')
await evaluate("localStorage.removeItem('gameshelf.backdrop.size'); 1")

const errors = await evaluate('(window.qa && window.qa.errors) || []')
check('the page logged no JavaScript error through all of that',
  Array.isArray(errors) && errors.length === 0, JSON.stringify(errors))

// ---------------------------------------------------------------- verdict
socket.close()
stopChrome()
stopServer()
if (failures.length) {
  console.error(`\n${failures.length} over-chat check(s) failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('\nall over-chat live checks passed')
