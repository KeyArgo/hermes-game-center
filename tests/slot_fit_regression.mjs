// Regression: the slot machine must fit the Games page at every size, keep its natural
// width, never scale itself away, and remeasure when the person switches machines.
//
//   node tests/slot_fit_regression.mjs [--port 18793] [--shots DIR]
//
// It drives a real headless Chrome against the real plugin module served by
// tests/browser_table_server.py (scratch config and storage only), so the numbers come
// from layout, not from a fake DOM. Exit code 1 means a real regression.
//
// Why these four checks exist — each is a defect that shipped once:
//   fit        the cabinet's bottom was clipped by the page
//   floor      an empty/very short page produced scale 0, an invisible machine
//   width      the wrapper forced width:100%, so the cabinet stretched full-bleed and the
//              width term of the fit was always 1
//   switch     the fit was measured once, so another machine kept the first one's scale
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
const PORT = Number(arg('port', String(18790 + (process.pid % 90))))
const SHOTS = arg('shots', '')
const URL_BASE = `http://127.0.0.1:${PORT}/`
const CHROME = process.env.CHROME_BIN || (fs.existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : 'google-chrome')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const failures = []
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`)
  if (!ok) failures.push(`${name} (${detail || ''})`)
}

// ---------------------------------------------------------------- QA server
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-fit-'))
const server = spawn('python3', [path.join(ROOT, 'tests/browser_table_server.py'), '--root', path.join(scratch, 'root'), '--port', String(PORT), '--game', 'slots'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-fit-chrome-'))
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

// ---------------------------------------------------------------- page facts
// One read of everything the checks need: the copy's box, the page's box, the applied
// scale (from the transform matrix, so it is the real rendered scale) and the machine id.
const GEOMETRY = `(() => {
  const table = document.querySelector('[data-slots="table"]')
  const machine = table && table.querySelector('.sm-machine')
  const frame = document.querySelector('.games-center-layout')
  if (!table || !machine || !frame) return null
  const box = machine.getBoundingClientRect(), area = frame.getBoundingClientRect()
  const scaled = machine.parentElement
  const matrix = scaled ? getComputedStyle(scaled).transform : 'none'
  const scale = matrix && matrix !== 'none' ? Number(new DOMMatrixReadOnly(matrix).a) : 1
  return {
    top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height,
    areaTop: area.top, areaBottom: area.bottom, areaWidth: area.width,
    // The element the fit measures (the wrapper React scales) versus the cabinet itself.
    // A wrapper forced to width:100% measures the page, so the width term of the fit dies.
    cabinetWidth: machine.offsetWidth, wrapperWidth: scaled ? scaled.offsetWidth : 0,
    scale, id: machine.getAttribute('data-slot-machine'),
    scroller: document.scrollingElement ? document.scrollingElement.scrollHeight : 0,
    view: innerHeight
  }
})()`

const resize = async (width, height) => {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await sleep(900)
}

await cdp('Page.enable')
await cdp('Runtime.enable')
await cdp('Page.navigate', { url: URL_BASE })
await sleep(6000)

// A fresh scratch root lands on the first-run card ("Pick a name"). Play only exists after
// it, and the card is finished by Continue (or Skip for now) — "Use this" only fills the name.
const welcomed = await evaluate(`(() => {
  const node = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Continue')
    || [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Skip for now')
  if (!node) return false
  node.click()
  return true
})()`)
if (welcomed) { console.log('ok   dismissed the first-run card'); await sleep(3000) }

const opened = await evaluate(`(() => {
  // The card's drawn art comes before its title ("777JACKPOTSlots"), so match on contains.
  const node = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('Slots'))
  if (!node) return false
  node.click()
  return true
})()`)
check('the Slots table opens', opened === true)
await sleep(2500)
// A failure here is usually a changed page, not a changed fit: say what the page does have.
const probe = await evaluate(`(() => ({
  slots: document.querySelectorAll('[data-slots]').length,
  tables: document.querySelectorAll('[data-slots="table"]').length,
  machines: document.querySelectorAll('.sm-machine').length,
  layout: document.querySelectorAll('.games-center-layout').length,
  playTable: document.querySelectorAll('.games-play-table').length,
  buttons: [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim().slice(0, 20))
}))()`)
if (!probe || !probe.tables) console.log('page:', JSON.stringify(probe))

// ---------------------------------------------------------------- fit at size
// kind: 'fit'   the whole cabinet is on screen, at every size a person actually uses
//       'floor' the window has no room at all, so the only demand is that the copy stays
//               visible (the page scrolls) instead of shrinking to nothing
const sizes = [
  { width: 1400, height: 950, kind: 'fit' },
  { width: 1200, height: 800, kind: 'fit' },
  { width: 1000, height: 700, kind: 'fit' },
  { width: 800, height: 600, kind: 'fit' },
  { width: 700, height: 520, kind: 'fit' },
  // 500x380 cannot hold both: the design width forces ~0.39, which is still taller than the
  // page. Below this the page scrolls, so only visibility is demanded.
  { width: 500, height: 380, kind: 'tiny' },
  { width: 320, height: 600, kind: 'fit' },
  { width: 900, height: 180, kind: 'floor' }
]
const designWidths = []
for (const size of sizes) {
  await resize(size.width, size.height)
  const facts = await evaluate(GEOMETRY)
  if (!facts) { check(`geometry at ${size.width}x${size.height}`, false, 'no table on the page'); continue }
  const label = `${size.width}x${size.height}`
  const detail = `copy ${Math.round(facts.top)}..${Math.round(facts.bottom)} in area ${Math.round(facts.areaTop)}..${Math.round(facts.areaBottom)}, x ${Math.round(facts.left)}..${Math.round(facts.right)}, scale ${facts.scale.toFixed(3)}`
  designWidths.push({ label, width: facts.cabinetWidth })
  if (size.kind === 'fit') {
    check(`fits the page at ${label}`, facts.bottom <= facts.areaBottom + 1 && facts.top >= facts.areaTop - 2, detail)
  } else if (size.kind === 'floor') {
    // 615 px of cabinet in ~180 px of window: the floor has to hold, nothing else can.
    check(`stays visible when the page has no room at ${label}`, facts.scale >= 0.444, detail)
  } else {
    console.log(`info ${label} :: ${detail}`)
  }
  // Horizontally the copy must never hang off the page: that is clipping by another name.
  check(`fits the page's width at ${label}`, facts.width <= facts.areaWidth + 1,
    `copy ${Math.round(facts.width)} wide in ${Math.round(facts.areaWidth)}`)
  // A hard sanity bound: no window, however odd, may shrink the copy to nothing.
  check(`never scales away at ${label}`, facts.scale >= 0.2, `scale ${facts.scale.toFixed(3)}`)
  await shot(`fit-${label}`)
}

// ---------------------------------------------------------------- one design width
// The cabinet is drawn at one width and scales as a picture. A wrapper forced to width:100%
// makes it reflow to the page instead, so its layout changes with the window even though the
// outer box still "fits". Measured on offsetWidth, which no transform touches.
const widths = designWidths.map(entry => entry.width)
const spreadWide = widths.length ? Math.max(...widths) - Math.min(...widths) : Infinity
check('the cabinet keeps one design width at every window size', spreadWide <= 2,
  designWidths.map(entry => `${entry.label}=${entry.width}`).join(' '))

// ---------------------------------------------------------------- machine switch
// Switching machines must remeasure without waiting for a window resize.
await resize(800, 600)
const before = await evaluate(GEOMETRY)
const picks = await evaluate(`[...document.querySelectorAll('[data-sm-pick]')].map(n => n.getAttribute('data-sm-pick'))`)
if (!picks || picks.length < 2) {
  check('a second machine exists to switch to', false, `picks: ${JSON.stringify(picks)}`)
} else {
  const other = picks.find(id => id !== before.id)
  await evaluate(`(() => { const n = document.querySelector('[data-sm-pick="${other}"]'); if (n) n.click(); return !!n })()`)
  await sleep(1200)
  const after = await evaluate(GEOMETRY)
  check('the switch changes the machine', after && after.id === other, `${before.id} -> ${after && after.id}`)
  check('the switch refits without a window resize', after && after.bottom <= after.areaBottom + 1,
    after ? `copy ${Math.round(after.top)}..${Math.round(after.bottom)} in area ..${Math.round(after.areaBottom)} scale ${after.scale.toFixed(3)}` : 'no geometry')
  check('the switched machine is not scaled away', after && after.scale >= 0.449, after ? `scale ${after.scale.toFixed(3)}` : 'no geometry')
  await shot('fit-switched')
}

// ---------------------------------------------------------------- no render loop
// The cabinet's own drawn art animates, so its height (and with it the fit) moves by a hair as it
// plays. What must not happen is a scale that runs away or ping-pongs: the 0.001 dead-band should
// keep it converging. Sampled at a width-bound size and a height-bound one, since the two take
// different paths through the fit.
const sampleScale = async count => {
  const seen = []
  for (let sample = 0; sample < count; sample += 1) {
    seen.push(await evaluate(`(() => { const m = document.querySelector('[data-slots="table"] .sm-machine'); const s = m && m.parentElement; const t = s ? getComputedStyle(s).transform : 'none'; return t === 'none' ? 1 : new DOMMatrixReadOnly(t).a })()`))
    await sleep(400)
  }
  return seen
}
for (const [width, height] of [[700, 520], [800, 600]]) {
  await resize(width, height)
  const seen = await sampleScale(6)
  const spread = Math.max(...seen) - Math.min(...seen)
  check(`the fit settles at ${width}x${height} instead of chasing the animation`, spread < 0.02,
    `scales ${seen.map(v => Number(v).toFixed(4)).join(' ')} (spread ${spread.toFixed(4)})`)
}

// ---------------------------------------------------------------- a broke table
// At 20 chips against a 25 bet the table is legally dead - it has to say why and offer the one-tap
// way out.
const WALLET = path.join(scratch, 'root', 'data', 'wallet.json')
const setChips = value => {
  const held = JSON.parse(fs.readFileSync(WALLET, 'utf8'))
  held.chips = value
  fs.writeFileSync(WALLET, JSON.stringify(held, null, 2))
}
const openSlots = async () => {
  await evaluate(`(() => {
    const node = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('Slots'))
    if (node) node.click()
    return !!node
  })()`)
  await sleep(1800)
}

// Auto-bet is on out of the box, and it locks the ladder: the reason must be on screen, not in a tooltip.
const hint = await evaluate(`(() => { const n = document.querySelector('[data-sm-bet-hint]'); return n ? n.textContent.trim() : null })()`)
check('an auto-bet lock says so on the table', Boolean(hint), String(hint))

// Seed a scratch wallet: 20 chips against the 25 minimum, and points to convert.
// (A read never creates the file, so the run has to write the blank shape itself.)
fs.mkdirSync(path.dirname(WALLET), { recursive: true })
fs.writeFileSync(WALLET, JSON.stringify({
  chips: 20, spins: 0, biggest: 0, hands: 0, bet: 25, bonus: 400,
  tokens: 0, reward: 0, tokens_total: 0,
  overchat: false, overchat_alpha: 0.2, overchat_scale: 1.0,
  bailout_at: 0, streak: 0, streak_day: 0, comeback: 0
}, null, 2))
await cdp('Page.reload', {})
await sleep(6000)
await openSlots()
const broke = await evaluate(`(() => {
  const row = document.querySelector('[data-sm-broke]')
  const button = document.querySelector('[data-sm-broke-cash]')
  const spin = document.querySelector('[data-sm-spin]')
  return {
    text: row ? row.textContent.trim() : null,
    button: button ? button.textContent.trim() : null,
    spinDisabled: spin ? !!spin.disabled : null
  }
})()`)
const diag = await evaluate(`(() => {
  const text = (document.body.innerText || '').replace(/\\s+/g, ' ')
  const m = text.match(/.{0,40}chips.{0,40}/i)
  return { walletLine: m ? m[0] : null, hasBroke: !!document.querySelector('[data-sm-broke]'), hasSpin: !!document.querySelector('[data-sm-spin]') }
})()`)
if (!diag.hasBroke) console.log('broke-diagnostics:', JSON.stringify(diag), 'wallet:', WALLET, 'exists:', fs.existsSync(WALLET))
check('a table that cannot afford a spin says so', Boolean(broke && broke.text && broke.text.includes('a spin costs')),
  broke ? String(broke.text) : 'no broke row')
check('and offers a one-tap way out', Boolean(broke && broke.button), broke ? String(broke.button) : 'none')
check('SPIN is greyed while broke', broke && broke.spinDisabled === true, broke ? String(broke.spinDisabled) : 'no spin button')

if (broke && broke.button) {
  await evaluate(`(() => { const b = document.querySelector('[data-sm-broke-cash]'); if (b) b.click(); return !!b })()`)
  await sleep(2000)
  const after = await evaluate(`(() => {
    const spin = document.querySelector('[data-sm-spin]')
    const row = document.querySelector('[data-sm-broke]')
    const chips = (document.body.innerText || '').match(/[\\d,]+ chips/i)
    return { spinDisabled: spin ? !!spin.disabled : null, row: !!row, chips: chips ? chips[0] : null }
  })()`)
  check('converting points unblocks the machine', after && after.spinDisabled === false && after.row === false,
    JSON.stringify(after))
  await shot('broke-unblocked')
}

// ---------------------------------------------------------------- over-chat copy, and the pane
// Two surfaces, one switch. The see-through copy is drawn INSIDE the composer's underside slot now:
// the slot is part of the conversation's composer, so it exists exactly while the
// conversation is on screen and the copy can never be over the Games page, Settings or another plugin's
// page. What this page can prove is the shape of that: the copy is inside the slot the host draws, and it
// has no fixed position of its own. The same cabinet in the narrow pane has to be fitted to the pane,
// not drawn at 1183 px.
const setOverchat = on => {
  const held = JSON.parse(fs.readFileSync(WALLET, 'utf8'))
  held.overchat = on
  held.chips = 5000
  fs.writeFileSync(WALLET, JSON.stringify(held, null, 2))
}

setOverchat(true)
await cdp('Page.reload', {})
await sleep(6000)
await openSlots()
// NOTE: this page (/ · the Games page) has no composer and therefore no composer slot — the copy is
// STRUCTURALLY absent here, which is the point of the slot. The slot check runs on /pane, the page that
// does have a conversation.

await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
await cdp('Page.navigate', { url: `${URL_BASE}pane` })
await sleep(6000)
// The copy's switch, in the one place the QA page's SDK keeps plugin storage: its own localStorage.
// (The wallet's `overchat` flag is the shelf's copy of the same setting; this page has no shelf.)
await evaluate(`(() => { localStorage.setItem('gameshelf.slots.overchat', '1'); return true })()`)
await cdp('Page.reload', {})
await sleep(6000)
await evaluate(`(() => {
  const node = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Continue')
  if (node) node.click()
  return !!node
})()`)
await sleep(2000)
// The pane opens on its lobby: pick Slots inside the pane, the way a person would.
const openedInPane = await evaluate(`(() => {
  const pane = document.querySelector('.games-wait-pane')
  if (!pane) return false
  const card = [...pane.querySelectorAll('button')].find(b => (b.textContent || '').includes('Slots'))
  if (card) { card.click(); return true }
  return false
})()`)
// Give the pane a picture to draw: the copy has nothing to show until a snapshot arrives.
await evaluate(`(() => { const b = document.querySelector('[data-sm-spin]'); if (b && !b.disabled) { b.click(); return true } return false })()`)
await sleep(2500)
const paneFacts = await evaluate(`(() => {
  const pane = document.querySelector('.games-wait-pane')
  // The pane's cabinet is Jackpot v2 (class jp2-machine); sm-machine is the original machine's class.
  const machine = pane && (pane.querySelector('.jp2-machine') || pane.querySelector('.sm-machine'))
  const overlay = document.querySelector('[data-jackpot="overchat"]')
  const copyMachine = overlay ? overlay.querySelector('.sm-machine') : null
  const chat = document.querySelector('#chat')
  if (!pane) return { pane: false }
  const o = overlay ? overlay.getBoundingClientRect() : null
  const c = copyMachine ? copyMachine.getBoundingClientRect() : null
  const h = chat ? chat.getBoundingClientRect() : null
  // The composer's underside slot: the only place a see-through copy is drawn. It is checked HERE,
  // because this is the page with a conversation on it.
  const slot = document.querySelector('#composer-slot')
  const strip = slot && slot.firstElementChild
  const style = overlay ? getComputedStyle(overlay) : null
  const copy = {
    overlay: !!overlay,
    slot: !!slot,
    strip: !!(strip && strip.getAttribute('data-overchat') === 'strip'),
    insideSlot: !!(overlay && slot && slot.contains(overlay)),
    position: style ? style.position : null,
    copyWidth: c ? c.width : null,
    copyLeft: c ? c.left : null,
    copyRight: c ? c.right : null,
    chatLeft: h ? h.left : null,
    chatRight: h ? h.right : null
  }
  if (!machine) return { pane: true, machine: false, ...copy,
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 200) }
  const scaled = machine.parentElement
  const m = machine.getBoundingClientRect(), p = pane.getBoundingClientRect()
  const matrix = scaled ? getComputedStyle(scaled).transform : 'none'
  return {
    pane: true, machine: true, ...copy,
    overlayLeft: o ? o.left : null, overlayWidth: o ? o.width : null,
    scale: matrix && matrix !== 'none' ? Number(new DOMMatrixReadOnly(matrix).a) : 1,
    left: m.left, right: m.right, width: m.width,
    paneLeft: p.left, paneRight: p.right, paneWidth: p.width
  }
})()`)
if (!paneFacts.pane || !paneFacts.machine) {
  console.log('pane-diagnostics:', JSON.stringify(paneFacts), 'opened:', openedInPane)
  check('the pane shows the slot cabinet', false, JSON.stringify(paneFacts))
} else {
  check('the over-chat copy is drawn inside the composer slot, not floated over the page',
    Boolean(paneFacts.slot && paneFacts.strip && paneFacts.overlay && paneFacts.insideSlot
      && paneFacts.position !== 'fixed'),
    `slot ${paneFacts.slot}, strip ${paneFacts.strip}, overlay ${paneFacts.overlay}, ` +
      `inside ${paneFacts.insideSlot}, position ${paneFacts.position}`)
  check('the pane cabinet fits the column width',
    paneFacts.width <= paneFacts.paneWidth + 1 && paneFacts.left >= paneFacts.paneLeft - 2 && paneFacts.right <= paneFacts.paneRight + 4,
    `copy ${Math.round(paneFacts.width)} across ${Math.round(paneFacts.left)}..${Math.round(paneFacts.right)} in pane ${Math.round(paneFacts.paneLeft)}..${Math.round(paneFacts.paneRight)} scale ${paneFacts.scale.toFixed(3)}`)
  // Beside the chat the pane is open, and the copy is still wanted: it is drawn in the composer's slot,
  // which is inside the conversation column and left of the pane. It used to not appear at all in the
  // real app; the slot is what makes that structural.
  check('the over-chat copy is drawn in the composer slot, inside the conversation',
    Boolean(paneFacts.overlay && paneFacts.copyWidth > 0
      && paneFacts.copyLeft >= paneFacts.chatLeft - 2 && paneFacts.copyRight <= paneFacts.chatRight + 2),
    `copy ${paneFacts.copyWidth && Math.round(paneFacts.copyWidth)} across ${paneFacts.copyLeft && Math.round(paneFacts.copyLeft)}..${paneFacts.copyRight && Math.round(paneFacts.copyRight)} in chat ${paneFacts.chatLeft && Math.round(paneFacts.chatLeft)}..${paneFacts.chatRight && Math.round(paneFacts.chatRight)}`)
  if (paneFacts.copyWidth) await shot('pane-fit-copy')
  await shot('pane-fit')
}

// ---------------------------------------------------------------- verdict
stopChrome()
stopServer()
if (failures.length) {
  console.error(`\n${failures.length} fit check(s) failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('\nall slot fit checks passed')
