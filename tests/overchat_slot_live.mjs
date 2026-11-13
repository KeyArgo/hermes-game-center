// tests/overchat_slot_live.mjs -- the over-chat strip, in a REAL React render, off -> on and resized.
//
//   node tests/overchat_slot_live.mjs [--port 18831] [--shots DIR]
//
// Why this file exists (quality review, 2026-11-13). The strip that holds the two see-through machines
// attaches its ResizeObserver in an effect. With `[]` deps that effect ran once, at a mount where both
// switches were off and the strip's div did not exist yet; turning a machine on afterwards rendered it at
// width 0 for ever, and the Jackpot v2 copy (which needs a width to fit itself) drew nothing at all.
//
// A stubbed-hooks harness cannot see that: those harnesses call components and read the tree they return,
// so a ref they fill in by hand is always "there". Only a real commit can show the difference, so this
// script drives the real module in headless Chrome against tests/browser_table_server.py:
//
//   1. the pane page opens with both switches off: no strip, no copy;
//   2. the switch is turned on by CLICKING the cabinet's own "Show over chat" checkbox — a real React
//      state change, no reload;
//   3. the copy must appear, inside the composer's underside slot, at a size a person can see;
//   4. the window is resized: the copy must re-measure to the new slot width (the observer is attached);
//   5. the switch is turned off again: the copy and the strip must both go.
//
// Exit code 1 means the machine really did not appear (or did not follow a resize).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname))
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

// One read of the strip, the copy and the two boxes the checks compare.
const FACTS = `(() => {
  const slot = document.querySelector('#composer-slot')
  const strip = document.querySelector('[data-overchat="strip"]')
  const copy = document.querySelector('[data-jp2-surface="copy"]')
  const box = copy ? copy.getBoundingClientRect() : null
  const slotBox = slot ? slot.getBoundingClientRect() : null
  return {
    slot: Boolean(slot),
    strip: Boolean(strip),
    stripWidth: strip ? Math.round(strip.getBoundingClientRect().width) : 0,
    copy: Boolean(copy),
    copyWidth: box ? Math.round(box.width) : 0,
    copyHeight: box ? Math.round(box.height) : 0,
    copyInsideSlot: Boolean(copy && slot && slot.contains(copy)),
    copyPosition: copy ? getComputedStyle(copy).position : null,
    slotWidth: slotBox ? Math.round(slotBox.width) : 0,
    switchOn: Boolean(document.querySelector('[data-jp2-oc-box="overchat"]'))
      ? document.querySelector('[data-jp2-oc-box="overchat"]').checked
      : null,
    errors: (window.qa && window.qa.errors) || []
  }
})()`

// ---------------------------------------------------------------- 1. both switches off at mount
// The pane page keeps plugin storage in its own localStorage, so this is the state a person has on a
// fresh install: nothing asked for, nothing drawn.
await cdp('Page.navigate', { url: `${URL_BASE}pane` })
await sleep(500)
await evaluate(`(() => { localStorage.removeItem('qa.jackpot2.overchat'); localStorage.removeItem('gameshelf.slots.overchat'); return true })()`)
await cdp('Page.navigate', { url: `${URL_BASE}pane` })
await sleep(7000)

// The pane opens on its own lobby: pick Slots inside it, the way a person does, so the cabinet (and its
// own Show over chat switch) is on the page before anything is measured.
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

const offAtMount = await evaluate(FACTS)
check('the pane drew the cabinet with its switches', opened === 'picked', String(opened))
check('both switches off at mount: no strip and no copy', Boolean(offAtMount && offAtMount.slot
  && !offAtMount.strip && !offAtMount.copy), JSON.stringify(offAtMount))

// ---------------------------------------------------------------- 2. the switch, clicked like a person
// This is the case that was broken: the component mounted with no strip to measure, and the effect never
// ran again. Clicking the cabinet's own checkbox flips the stored switch through the real hook.
const clicked = await evaluate(`(() => {
  const box = document.querySelector('[data-jp2-oc-box="overchat"]')
  if (!box) return 'no switch on the page'
  if (box.checked) return 'already on'
  box.click()
  return 'clicked'
})()`)
check('the cabinet offers its own Show over chat switch', clicked === 'clicked',
  `${clicked}: ${JSON.stringify(offAtMount && offAtMount.errors)}`)
await sleep(2500)

const onNow = await evaluate(FACTS)
check('turning it on draws the copy inside the composer slot, at a size a person can see',
  Boolean(onNow && onNow.strip && onNow.copy && onNow.copyInsideSlot
    && onNow.copyWidth > 40 && onNow.copyHeight > 40 && onNow.copyPosition !== 'fixed'),
  JSON.stringify(onNow))
// The fit has TWO limits and the tighter one wins: its share of the slot's width, or the strip's height
// budget (320 px, which for the 560x720 cabinet is 249 px wide). A wide slot is therefore height-capped
// — that is the design, not a miss — and what must hold at every size is "inside the slot, never zero".
check('and it is fitted to the slot it was given: inside its share, capped by the height budget',
  Boolean(onNow && onNow.stripWidth > 0 && onNow.copyWidth > 40
    && onNow.copyWidth <= Math.min(onNow.stripWidth, 249) + 1
    && onNow.copyHeight <= 321),
  `copy ${onNow && onNow.copyWidth}x${onNow && onNow.copyHeight} in strip ${onNow && onNow.stripWidth}`)
await shot('overchat-on')

// ---------------------------------------------------------------- 3. a resize, after the switch
// The observer is what makes a later width change reach the copy: without it the machine keeps the size
// it happened to be measured at.
// A resize only shows in the copy once the slot is NARROWER than the height-capped width (249 px for
// this cabinet), because above that the height budget is what decides. So the test goes there: a window
// narrow enough that the width is the binding limit, then back.
const widthBefore = onNow ? onNow.copyWidth : 0
await cdp('Emulation.setDeviceMetricsOverride', { width: 520, height: 880, deviceScaleFactor: 1, mobile: false })
await sleep(2500)
const narrower = await evaluate(FACTS)
check('a narrower window re-measures the copy instead of leaving it at the old width',
  Boolean(narrower && narrower.copy && widthBefore > 0 && narrower.copyWidth > 0
    && narrower.copyWidth < widthBefore && narrower.copyWidth <= narrower.stripWidth + 1),
  `before ${widthBefore}, after ${narrower && narrower.copyWidth}, strip ${narrower && narrower.stripWidth}`)
await shot('overchat-narrower')

await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
await sleep(2500)
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
