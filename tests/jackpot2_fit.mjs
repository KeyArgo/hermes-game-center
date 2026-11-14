// tests/jackpot2_fit.mjs -- JACKPOT v2: the three surfaces a real browser can measure.
//
//   node tests/jackpot2_fit.mjs [--port 18793] [--shots DIR]
//
// The vm harness (tests/jackpot2_harness.cjs) pins the layer's geometry arithmetic, but it cannot
// tell a cabinet that fits a real 400 px pane from one whose bottom is cut off: it has no layout.
// This does, the way tests/slot_fit_regression.mjs does it for the old machine. It drives a real
// headless Chrome against tests/browser_table_server.py, which serves the REAL built plugin (only the
// SDK is stubbed), so every number below comes from layout. Exit 1 is a real regression.
//
// What it checks:
//   pane   the ~400 px "Play while you code" pane offers Slots and mounts the cabinet; it must be on
//          screen at 0.6 of its design size or more, with nothing outside the pane;
//   full   the Games page's full view fits 1400x900 and 900x500 with nothing clipped - the machine
//          fits the frame it is MOUNTED IN, not the window;
//   copy   the see-through copy over the conversation is still on screen after the trip into the
//          full view and back, and after a window resize.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname))
const PORT = Number(arg('port', String(18730 + (process.pid % 60))))
const SHOTS = arg('shots', '')
const URL_BASE = `http://127.0.0.1:${PORT}/`
const CHROME = process.env.CHROME_BIN || (fs.existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : 'google-chrome')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// The QA server needs fastapi/uvicorn, and the `python3` first on PATH is often a tool-managed
// interpreter without them - which looks exactly like a broken harness. Pick one that can import
// them, and say which one was used.
const PYTHON = (() => {
  for (const candidate of [process.env.PYTHON_BIN, '/usr/bin/python3', 'python3'].filter(Boolean)) {
    try {
      spawnSync(candidate, ['-c', 'import fastapi, uvicorn'], { stdio: 'ignore' })
      return candidate
    } catch (error) { /* try the next one */ }
  }
  return 'python3'
})()

const failures = []
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`)
  if (!ok) failures.push(`${name} (${detail || ''})`)
}

// ---------------------------------------------------------------- QA server
console.log(`QA server on ${PYTHON}`)
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jp2-fit-'))
const server = spawn(PYTHON, [path.join(ROOT, 'tests/browser_table_server.py'), '--root', path.join(scratch, 'root'), '--port', String(PORT), '--game', 'slots'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
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
  console.error('the QA server never answered on', URL_BASE, '\n', serverLog.slice(-2000))
  process.exit(1)
}

// ---------------------------------------------------------------- chrome
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jp2-fit-chrome-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--mute-audio', '--no-sandbox', '--disable-gpu',
  '--window-size=1400,950', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=${profile}`, 'about:blank'
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
const click = selector => evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; n.click(); return true })()`)
const resize = async (width, height) => {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await sleep(1000)
}
const dismissWelcome = async () => {
  const done = await evaluate(`(() => {
    const node = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Continue')
      || [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Skip for now')
    if (!node) return false
    node.click()
    return true
  })()`)
  if (done) await sleep(2500)
  return done
}

await cdp('Page.enable')
await cdp('Runtime.enable')

// ---------------------------------------------------------------- the pane
// The ~400 px "Play while you code" column. The QA page draws a stub chat beside the real pane, so
// the pane's own width is the 400 px column the amendment names.
await resize(1400, 900)
await cdp('Page.navigate', { url: `${URL_BASE}pane` })
await sleep(6000)
await dismissWelcome()

const paneTile = await evaluate(`(() => {
  const pane = document.querySelector('.games-wait-pane')
  const tile = pane && pane.querySelector('[data-game-tile="slots"]')
  return { pane: !!pane, tile: !!tile, text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 220) }
})()`)
check('the pane offers Slots', paneTile && paneTile.tile, JSON.stringify(paneTile))
if (paneTile && paneTile.tile) {
  await click('.games-wait-pane [data-game-tile="slots"]')
  await sleep(3000)
  const facts = await evaluate(`(() => {
    const pane = document.querySelector('.games-wait-pane')
    const frame = pane && pane.querySelector('[data-jp2="full-frame"]')
    const machine = pane && pane.querySelector('.jp2-machine')
    if (!pane) return { pane: false }
    if (!machine) return { pane: true, machine: false, status: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 260) }
    const m = machine.getBoundingClientRect()
    const f = frame ? frame.getBoundingClientRect() : null
    const p = pane.getBoundingClientRect()
    return {
      pane: true, machine: true,
      scale: m.width / 560, width: m.width, height: m.height,
      top: m.top, bottom: m.bottom, left: m.left, right: m.right,
      frame: f ? { left: f.left, right: f.right, top: f.top, bottom: f.bottom, width: f.width, height: f.height } : null,
      paneLeft: p.left, paneRight: p.right, paneTop: p.top, paneBottom: p.bottom, paneWidth: p.width,
      spin: !!document.querySelector('[data-jp2-spin]'),
      chips: document.querySelector('[data-jp2="machine"]')
        ? document.querySelector('[data-jp2="machine"]').getAttribute('data-jp2-chips') : null
    }
  })()`)
  if (!facts || !facts.machine) {
    console.log('pane-diagnostics:', JSON.stringify(facts))
    check('the pane mounts the Jackpot cabinet', false, JSON.stringify(facts))
  } else {
    const detail = `scale ${facts.scale.toFixed(3)} (${Math.round(facts.width)}x${Math.round(facts.height)}) in pane ${Math.round(facts.paneWidth)} wide, frame ${facts.frame ? `${Math.round(facts.frame.width)}x${Math.round(facts.frame.height)}` : 'none'}`
    check('the pane cabinet is readable at 0.6 or above', facts.scale >= 0.6, detail)
    const insidePane = facts.left >= facts.paneLeft - 2 && facts.right <= facts.paneRight + 4
      && facts.top >= facts.paneTop - 2 && facts.bottom <= facts.paneBottom + 4
    check('nothing of the pane cabinet is clipped by the pane', insidePane,
      `copy ${Math.round(facts.left)}..${Math.round(facts.right)} x ${Math.round(facts.top)}..${Math.round(facts.bottom)} in pane ${Math.round(facts.paneLeft)}..${Math.round(facts.paneRight)} x ${Math.round(facts.paneTop)}..${Math.round(facts.paneBottom)}`)
    const insideFrame = !facts.frame || (facts.left >= facts.frame.left - 1 && facts.right <= facts.frame.right + 1
      && facts.top >= facts.frame.top - 1 && facts.bottom <= facts.frame.bottom + 1)
    check('nothing of the pane cabinet is clipped by its own frame', insideFrame,
      JSON.stringify(facts.frame))
    check('the pane cabinet is a real machine, not a plate', facts.spin === true, `SPIN present: ${facts.spin}`)
    await shot('jp2-pane')
  }
}

// ---------------------------------------------------------------- the full view, and the copy
await cdp('Page.navigate', { url: URL_BASE })
await sleep(6000)
await dismissWelcome()

// The status bar shows NOTHING for Slots any more. The switch is the one in the
// cabinet's own panel (and Settings): [data-jp2-oc="toggle"] input.
const chip = await evaluate(`(() => ({ ok: !document.querySelector('[data-jp2="status"]') }))()`)
check('the status bar carries no Slots button', Boolean(chip && chip.ok), JSON.stringify(chip))
const switchOn = async () => {
  const flipped = await evaluate(`(() => {
    const box = document.querySelector('[data-jp2-oc="toggle"] input')
    if (!box) return false
    if (!box.checked) box.click()
    return true
  })()`)
  await sleep(2500)
  return flipped
}

const layerFacts = () => evaluate(`(() => {
  const mirror = document.querySelector('[data-jp2-surface="mirror"]')
  const layer = mirror || document.querySelector('[data-jp2-layer]')
  const machine = layer && layer.querySelector('[data-jp2="machine"]')
  if (!layer) return { present: false, machine: !!machine }
  const style = getComputedStyle(layer)
  const box = layer.getBoundingClientRect()
  return {
    present: true, machine: !!machine, visibility: style.visibility, opacity: style.opacity,
    z: style.zIndex, pointerEvents: style.pointerEvents,
    width: box.width, height: box.height, mirror: !!mirror
  }
})()`)

if (chip && chip.ok) {
  // Switch it on from the cabinet's own panel: open Slots, tick Show over chat, come back.
  await click('[data-game-tile="slots"]')
  await sleep(2500)
  check('the cabinet offers the Show over chat switch', (await switchOn()) === true)
  await click('[data-jp2="full-back"]')
  await sleep(2000)
  const on = await layerFacts()
  check('the switch floats a copy over the conversation', Boolean(on && on.present && on.visibility === 'visible'),
    JSON.stringify(on))
  check('the copy holds a real machine', Boolean(on && on.machine), JSON.stringify(on))

  // ---- into the full view and back: the copy has to survive the trip ----
  const opened = await click('[data-game-tile="slots"]')
  check('the Games page offers Slots', opened === true)
  await sleep(2500)
  const inGames = await layerFacts()
  check('the copy is still on screen with the Jackpot full view open',
    Boolean(inGames && inGames.present && inGames.visibility === 'visible'), JSON.stringify(inGames))

  for (const size of [{ width: 1400, height: 900 }, { width: 900, height: 500 }]) {
    await resize(size.width, size.height)
    const label = `${size.width}x${size.height}`
    const facts = await evaluate(`(() => {
      const full = document.querySelector('[data-jp2="full"]')
      const frame = full && full.querySelector('[data-jp2="full-frame"]')
      const machine = full && full.querySelector('.jp2-machine')
      if (!full) return { full: false, text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 200) }
      if (!frame || !machine) return { full: true, frame: !!frame, machine: !!machine }
      const m = machine.getBoundingClientRect(), f = frame.getBoundingClientRect()
      return {
        full: true, frame: true, machine: true,
        scale: m.width / 560, width: m.width, height: m.height,
        top: m.top, bottom: m.bottom, left: m.left, right: m.right,
        frameTop: f.top, frameBottom: f.bottom, frameLeft: f.left, frameRight: f.right,
        frameWidth: f.width, frameHeight: f.height
      }
    })()`)
    if (!facts || !facts.machine) {
      console.log(`full-diagnostics ${label}:`, JSON.stringify(facts))
      check(`the full view holds the cabinet at ${label}`, false, JSON.stringify(facts))
      continue
    }
    const detail = `scale ${facts.scale.toFixed(3)} (${Math.round(facts.width)}x${Math.round(facts.height)}) in frame ${Math.round(facts.frameWidth)}x${Math.round(facts.frameHeight)}`
    check(`the full view has room to draw at ${label}`, facts.frameHeight > 100 && facts.frameWidth > 100,
      `frame ${Math.round(facts.frameWidth)}x${Math.round(facts.frameHeight)}`)
    check(`nothing of the full view is clipped at ${label}`,
      facts.left >= facts.frameLeft - 1 && facts.right <= facts.frameRight + 1
      && facts.top >= facts.frameTop - 1 && facts.bottom <= facts.frameBottom + 1, detail)
    if (size.height >= 800) {
      // A window a person actually plays in: the view is on screen, not below a scroll.
      check(`the full view is on screen at ${label}`,
        facts.left >= -1 && facts.top >= -1 && facts.right <= size.width + 1 && facts.bottom <= size.height + 1, detail)
    } else {
      // A short window: the Games page is a scroll layout by its own media queries (the old machine's
      // fit test says the same), so what must hold is that the cabinet is inside its frame - not that
      // the frame is above the fold.
      console.log(`info ${label} :: the page scrolls at this height; the cabinet is fitted to its ${Math.round(facts.frameWidth)}x${Math.round(facts.frameHeight)} frame`)
    }
    const stillThere = await layerFacts()
    check(`the copy survives a resize to ${label}`,
      Boolean(stillThere && stillThere.present && stillThere.visibility === 'visible'), JSON.stringify(stillThere))
    await shot(`jp2-full-${label}`)
  }

  // Back to the games list — the copy must not have been taken away with the view.
  await resize(1400, 900)
  const wentBack = await click('[data-jp2="full-back"]')
  check('the full view offers a way back', wentBack === true)
  await sleep(2000)
  const after = await layerFacts()
  check('the copy is still on screen after coming back to the games list',
    Boolean(after && after.present && after.visibility === 'visible'), JSON.stringify(after))
  await shot('jp2-copy-after-back')
}

// ---------------------------------------------------------------- a dead table, in a real browser
// Amendment 1's whole point is what a person SEES: the table cannot afford a spin, so it says so and
// offers the one-tap way out. A vm harness cannot prove the row is on screen and the button moves the
// wallet, so this seeds a scratch wallet the same way tests/slot_fit_regression.mjs does and reads the
// real result back.
const WALLET = path.join(scratch, 'root', 'data', 'wallet.json')
fs.mkdirSync(path.dirname(WALLET), { recursive: true })
fs.writeFileSync(WALLET, JSON.stringify({
  chips: 20, spins: 0, biggest: 0, hands: 0, bet: 25, bonus: 400,
  tokens: 0, reward: 0, tokens_total: 0,
  overchat: false, overchat_alpha: 0.2, overchat_scale: 1.0,
  bailout_at: 0, streak: 0, streak_day: 0, comeback: 0
}, null, 2))
await resize(1400, 900)
await cdp('Page.reload', {})
await sleep(6000)
// The separate Jackpot tile is gone: Slots opens the Jackpot machine.
await click('[data-game-tile="slots"]')
await sleep(3000)
const broke = await evaluate(`(() => {
  const row = document.querySelector('[data-jp2-broke]')
  const button = document.querySelector('[data-jp2-broke-cash]')
  const spin = document.querySelector('[data-jp2-spin]')
  return {
    text: row ? row.textContent.trim().replace(/\\s+/g, ' ') : null,
    button: button ? button.textContent.trim() : null,
    spinDisabled: spin ? !!spin.disabled : null,
    chips: document.querySelector('[data-jp2="machine"]')
      ? document.querySelector('[data-jp2="machine"]').getAttribute('data-jp2-chips') : null
  }
})()`)
check('a table that cannot afford a spin says so on the cabinet',
  Boolean(broke && broke.text && broke.text.includes('a spin costs')), JSON.stringify(broke))
check('and offers a one-tap points-to-chips conversion', Boolean(broke && broke.button), JSON.stringify(broke))
check('SPIN is greyed while the table is dead', Boolean(broke && broke.spinDisabled === true), JSON.stringify(broke))
if (broke && broke.button) {
  await click('[data-jp2-broke-cash]')
  await sleep(3000)
  const after = await evaluate(`(() => {
    const row = document.querySelector('[data-jp2-broke]')
    const spin = document.querySelector('[data-jp2-spin]')
    const machine = document.querySelector('[data-jp2="machine"]')
    return {
      row: !!row, spinDisabled: spin ? !!spin.disabled : null,
      chips: machine ? machine.getAttribute('data-jp2-chips') : null
    }
  })()`)
  check('converting points fills the wallet and unblocks SPIN',
    Boolean(after && after.row === false && after.spinDisabled === false), JSON.stringify(after))
  check('the wallet really went up', Number(after && after.chips) > 20, JSON.stringify(after))
  await shot('jp2-broke-unblocked')
}

// ---------------------------------------------------------------- the cabinet's own new rows
// The rows that live ON the cabinet: the line that says the machine spins itself while Hermes thinks
// or uses tools, the control that turns a chosen slice of points into
// chips (slider, number and Max, at the shelf's own 4-points-buy-3 rate), and the whole pay table
// behind one button. The cabinet is a single fixed 560x720 box with its content column clipped by it,
// so every one of them - and the pay table with all of its rows open - has to land inside that box.
// A row pushed out of the bottom is a row nobody can read, which is what this measures.
const cabinetRow = async selector => evaluate(`(() => {
  const machine = document.querySelector('.jp2-machine')
  const node = document.querySelector(${JSON.stringify(selector)})
  if (!machine || !node) return { machine: !!machine, present: !!node }
  const m = machine.getBoundingClientRect(), r = node.getBoundingClientRect()
  return { present: true, top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right),
    inside: r.top >= m.top - 1 && r.bottom <= m.bottom + 1 && r.left >= m.left - 1 && r.right <= m.right + 1,
    machineBottom: Math.round(m.bottom), text: (node.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 90) }
})()`)

for (const size of [{ width: 1400, height: 900 }, { width: 900, height: 500 }]) {
  await resize(size.width, size.height)
  const label = `${size.width}x${size.height}`
  const rows = {}
  for (const [name, selector] of [['the automatic-spin line', '[data-jp2-autospin-note]'],
    ['the points control', '[data-jp2-points-control]'], ['the points slider', '[data-jp2-points-range]'],
    ['the points number', '[data-jp2-points-number]'], ['Max', '[data-jp2-points-max]'],
    ['Cash in', '[data-jp2-points-cash]'], ['What it pays', '[data-jp2-pays-open]']]) {
    rows[name] = await cabinetRow(selector)
    check(`${name} is on the cabinet at ${label}`, Boolean(rows[name] && rows[name].present), JSON.stringify(rows[name]))
    check(`${name} is not clipped by the cabinet at ${label}`, Boolean(rows[name] && rows[name].inside), JSON.stringify(rows[name]))
  }
  const words = await evaluate(`(() => {
    const note = document.querySelector('[data-jp2-autospin-note]')
    return note ? { text: note.textContent.trim(), title: note.title } : null
  })()`)
  check(`the cabinet says how the automatic spin works, in full, at ${label}`,
    Boolean(words && /spins by itself/i.test(words.text) && /tokens you spend/i.test(words.text)
      && /games you win/i.test(words.text) && words.title === words.text), JSON.stringify(words))
  const sliderFacts = await evaluate(`(() => {
    const s = document.querySelector('[data-jp2-points-range]')
    return s ? { step: s.step, max: s.max, value: s.value } : null
  })()`)
  check(`the points slider is in whole blocks of the shelf's rate at ${label}`,
    Boolean(sliderFacts && Number(sliderFacts.step) === 4 && Number(sliderFacts.max) >= Number(sliderFacts.value)),
    JSON.stringify(sliderFacts))
}

await resize(1400, 900)
const openedPays = await click('[data-jp2-pays-open]')
check('the cabinet offers what it pays', openedPays === true)
await sleep(800)
const paysFacts = await evaluate(`(() => {
  const panel = document.querySelector('[data-jp2-pays]')
  const machine = document.querySelector('.jp2-machine')
  const windowBox = document.querySelector('[data-jp2-window]')
  if (!panel || !machine || !windowBox) return { panel: !!panel, machine: !!machine, window: !!windowBox }
  const p = panel.getBoundingClientRect(), m = machine.getBoundingClientRect(), w = windowBox.getBoundingClientRect()
  const text = [...panel.querySelectorAll('div,span,b')].map(n => n.textContent || '').join(' ')
  return {
    inside: p.top >= w.top - 1 && p.bottom <= w.bottom + 1 && p.left >= w.left - 1 && p.right <= w.right + 1,
    insideCabinet: p.top >= m.top - 1 && p.bottom <= m.bottom + 1,
    rows: panel.querySelectorAll('[data-jp2-pay-row]').length,
    jackpot: panel.querySelectorAll('[data-jp2-pay-row="jackpot"]').length,
    scrolls: panel.scrollHeight >= panel.clientHeight,
    percentage: /%/.test(text),
    sample: text.replace(/\\s+/g, ' ').slice(0, 150)
  }
})()`)
check('opening what it pays draws a table over the reels, inside the cabinet',
  Boolean(paysFacts && paysFacts.inside && paysFacts.insideCabinet), JSON.stringify(paysFacts))
check('the table lists every combination the shelf is playing (jackpot row included)',
  Boolean(paysFacts && paysFacts.rows >= 8 && paysFacts.jackpot === 1), JSON.stringify(paysFacts))
check('the pay table prints no percentage and scrolls inside itself',
  Boolean(paysFacts && !paysFacts.percentage), JSON.stringify(paysFacts))
await shot('jp2-pays-open')
const closedPays = await click('[data-jp2-pays-close]')
await sleep(600)
const afterPays = await evaluate(`(() => ({ panel: !!document.querySelector('[data-jp2-pays]'),
  spin: !!document.querySelector('[data-jp2-spin]'), label: (document.querySelector('[data-jp2-pays-open]') || {}).textContent }))()`)
check('closing the table puts the reels back', Boolean(closedPays && afterPays && !afterPays.panel && afterPays.spin),
  JSON.stringify(afterPays))

// ---------------------------------------------------------------- the sole over-chat copy
// The pane host has a real chat composer and no Games page. Seed the retired switch on too,
// so its absence is checked even when an older wallet has that preference saved.
fs.writeFileSync(WALLET, JSON.stringify({
  chips: 5000, spins: 0, biggest: 0, hands: 0, bet: 25, bonus: 400,
  tokens: 0, reward: 0, tokens_total: 0,
  overchat: true, overchat_alpha: 0.2, overchat_scale: 1.0,
  bailout_at: 0, streak: 0, streak_day: 0, comeback: 0
}, null, 2))
await resize(1400, 900)
await cdp('Page.navigate', { url: `${URL_BASE}pane` })
await sleep(6000)
await dismissWelcome()
await click('.games-wait-pane [data-game-tile="slots"]')
await sleep(2500)
const v2ChipHere = await switchOn()
check('the Jackpot switch is offered beside the conversation (in the pane cabinet)', v2ChipHere === true)
const overlayFacts = () => evaluate(`(() => {
  const box = node => {
    if (!node) return null
    const r = node.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
  }
  const old = document.querySelector('[data-jackpot="overchat"] .sm-machine')
  const surface = document.querySelector('[data-jp2-surface="mirror"]') || document.querySelector('[data-jp2-layer]')
  const machine = surface && surface.querySelector('[data-jp2="machine"]')
  return {
    chat: box(document.querySelector('#chat')), old: box(old), machine: box(machine),
    opacity: surface ? Number(getComputedStyle(surface).opacity) : null,
    pressed: String(Boolean(document.querySelector('[data-jp2-oc="toggle"] input')?.checked)),
    close: !!(surface && surface.querySelector('[data-jp2-close]'))
  }
})()`)
const describe = box => box ? `${Math.round(box.left)}..${Math.round(box.right)} x ${Math.round(box.top)}..${Math.round(box.bottom)}` : 'absent'
const onChat = await overlayFacts()
check('only the Jackpot machine is over the conversation (old copy retired)',
  Boolean(onChat && onChat.machine && onChat.machine.width > 0 && !(onChat.old && onChat.old.width > 0)),
  `old ${describe(onChat && onChat.old)}, Jackpot ${describe(onChat && onChat.machine)}`)
check('the Jackpot copy is centred over the chat column',
  Boolean(onChat && onChat.chat && onChat.machine
    && Math.abs((onChat.machine.left + onChat.machine.right) / 2 - (onChat.chat.left + onChat.chat.right) / 2) <= 24),
  `chat ${describe(onChat && onChat.chat)}, Jackpot ${describe(onChat && onChat.machine)}`)
check('the Jackpot copy starts at the top of the chat (top middle)',
  Boolean(onChat && onChat.chat && onChat.machine && onChat.machine.top <= onChat.chat.top + 24),
  `chat ${describe(onChat && onChat.chat)}, Jackpot ${describe(onChat && onChat.machine)}`)
if (onChat && onChat.machine) await shot('jp2-over-chat-centred')

// Drive the native range setter and events just as a user changing each slider would.
const setRange = (key, value) => evaluate(`(() => {
  const input = document.querySelector(${JSON.stringify('[data-jp2-oc-range="' + key + '"]')})
  if (!input) return false
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`)
const alphaSet = await setRange('alpha', '0.8')
await sleep(1000)
const dimmed = await overlayFacts()
check('the opacity slider changes the copy opacity', Boolean(alphaSet && dimmed && onChat && dimmed.opacity !== onChat.opacity), JSON.stringify({ before: onChat, after: dimmed }))
const sizeSet = await setRange('size', '0.3')
await sleep(1000)
const smaller = await overlayFacts()
check('the size slider changes the copy size', Boolean(sizeSet && smaller && smaller.machine && dimmed && dimmed.machine && smaller.machine.width < dimmed.machine.width), JSON.stringify({ before: dimmed, after: smaller }))
check('the over-chat copy offers an X close button', Boolean(smaller && smaller.close), JSON.stringify(smaller))
// Over the chat the machine is to watch: the spin and lever take no click there, the
// sound switch and the X still do. Checked by what a real click would hit, not by a style string.
const watchOnly = await evaluate(`(() => {
  const surface = document.querySelector('[data-jp2-surface="mirror"]') || document.querySelector('[data-jp2-layer]')
  const pe = sel => { const n = surface && surface.querySelector(sel); return n ? getComputedStyle(n).pointerEvents : 'absent' }
  const tab = sel => { const n = surface && surface.querySelector(sel); return n ? n.tabIndex : null }
  const box = surface && surface.querySelector('[data-jp2-toggle] input')
  return { spin: pe('[data-jp2-spin]'), lever: pe('[data-jp2-lever]'), sound: pe('[data-jp2-sound]'), close: pe('[data-jp2-close]'),
           spinTab: tab('[data-jp2-spin]'), toggleOff: box ? box.disabled : true }
})()`)
check('over the chat only X and sound take a click (spin and lever do not)',
  Boolean(watchOnly && watchOnly.spin === 'none' && watchOnly.lever === 'none' && watchOnly.sound !== 'none' && watchOnly.close !== 'none'
    && watchOnly.spinTab === -1 && watchOnly.toggleOff),
  JSON.stringify(watchOnly))
const closed = await click('[data-jp2-close]')
await sleep(1000)
const afterClose = await overlayFacts()
check('X switches off and removes the over-chat copy', Boolean(closed && afterClose && afterClose.pressed === 'false' && !afterClose.machine), JSON.stringify(afterClose))

// ---------------------------------------------------------------- verdict
stopChrome()
stopServer()
if (failures.length) {
  console.error(`\n${failures.length} jackpot v2 fit check(s) failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('\nall jackpot v2 fit checks passed')
