// SP proof: the side pane gets out of the way, and the status bar says one thing.
//   node tools/sp_pane_proof.mjs --url http://127.0.0.1:18793/ --out proof/sp
//
// Real muted headless Chrome, real pointer and key events only (Input.dispatch*);
// every click audits elementFromPoint at the contact point. Screenshots land in
// proof/sp/. tests/browser_table_server.py must already be running (--url).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const URL_BASE = arg('url', 'http://127.0.0.1:18793/')
const OUT = path.resolve(arg('out', 'proof/sp'))
fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

let PORT = 9800 + (process.pid % 150)
const profile = fs.mkdtempSync('/tmp/sp-pane-')
process.on('exit', () => { try { chrome.kill('SIGKILL') } catch {} try { fs.rmSync(profile, { recursive: true, force: true }) } catch {} }); for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => process.exit(130)) // delete the ~200 MB Chrome profile when the run ends
const chrome = spawn('google-chrome', ['--headless=new', '--mute-audio', '--no-sandbox', '--disable-gpu',
  '--window-size=1400,900', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
process.on('exit', () => { try { chrome.kill() } catch {} })
let tabs = []
for (let i = 0; i < 80; i += 1) {
  try { tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (tabs.some(t => t.type === 'page')) break } catch {}
  await sleep(400)
}
const page = tabs.find(t => t.type === 'page')
if (!page) { console.error('no page'); process.exit(1) }
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { socket.onopen = r })
let counter = 0
const waiting = new Map()
const exceptions = []
socket.onmessage = m => {
  const d = JSON.parse(m.data)
  if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d.result || d.error || {}); waiting.delete(d.id); return }
  if (d.method === 'Runtime.exceptionThrown') exceptions.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text)
}
const cdp = (method, params = {}) => new Promise(resolve => {
  const n = ++counter
  const timer = setTimeout(() => { waiting.delete(n); resolve({ __timeout: true }) }, 20000)
  waiting.set(n, answer => { clearTimeout(timer); resolve(answer) })
  socket.send(JSON.stringify({ id: n, method, params }))
})
const evaluate = async expression => {
  const answer = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (answer && answer.exceptionDetails) return { error: answer.exceptionDetails.text }
  return answer && answer.result ? answer.result.value : undefined
}
const screenshot = async name => {
  const shot = await cdp('Page.captureScreenshot', { format: 'png' })
  if (shot && shot.data) fs.writeFileSync(path.join(OUT, name), Buffer.from(shot.data, 'base64'))
  console.log('shot', name)
}

// A real mousedown/mouseup at the target's centre, audited with elementFromPoint.
let clicks = 0
const press = async (label, finderSource) => {
  const probe = await evaluate(`(() => {
    const found = (${finderSource})
    if (!found) return null
    const box = found.getBoundingClientRect()
    const x = Math.round(box.left + box.width / 2)
    const y = Math.round(box.top + box.height / 2)
    const at = document.elementFromPoint(x, y)
    return { x, y, ok: Boolean(at && (at === found || found.contains(at))), at: at ? at.tagName : '' }
  })()`)
  if (!probe || !probe.ok) { check(`hit ${label}`, false, probe ? `elementFromPoint gave ${probe.at}` : 'not found'); return false }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp('Input.dispatchMouseEvent', { type, x: probe.x, y: probe.y, button: 'left', clickCount: 1 })
  }
  clicks += 1
  check(`hit ${label}`, true)
  return true
}
const keyEscape = async () => {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await cdp('Input.dispatchKeyEvent', {
      type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27
    })
  }
}
const until = async (source, timeout = 15000, step = 500) => {
  const end = Date.now() + timeout
  let value
  while (Date.now() < end) {
    value = await evaluate(source)
    if (value) return value
    await sleep(step)
  }
  return value
}
const PANE = `${URL_BASE.replace(/\/$/, '')}/pane`

// ---- 1. Game Center page: idle status bar is empty; the way back is one link.
await cdp('Page.enable')
await cdp('Runtime.enable')
await cdp('Page.navigate', { url: `${URL_BASE}?fresh=${Date.now()}` })
await sleep(2500)
const idleBar = await evaluate(`(() => {
  const bar = document.getElementById('statusbar')
  if (!bar) return 'missing'
  return bar.textContent.replace(/Hermes desktop[^\\n]*/g, '').trim()
})()`)
check('status bar empty while idle', idleBar === '', `saw ${JSON.stringify(idleBar)}`)
await screenshot('01-home-idle-statusbar.png')
// The QA home opens on the welcome; both proofs below run on the real home page.
if (await evaluate(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Skip for now')`)) {
  await press('Skip for now (welcome)', `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Skip for now')`)
  await sleep(800)
}
const backLink = await evaluate(`(() => {
  const link = [...document.querySelectorAll('button, a')].find(node => node.textContent.trim() === 'Back to chat')
  if (!link) return null
  const box = link.getBoundingClientRect()
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
})()`)
if (backLink) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp('Input.dispatchMouseEvent', { type, x: backLink.x, y: backLink.y, button: 'left', clickCount: 1 })
  }
  await sleep(600)
  const went = await evaluate('window.qa.nav || []')
  check('Back to chat asks the host for the chat', (went || []).length > 0, JSON.stringify(went))
} else check('Back to chat link present', false)

// ---- 2. The pane: tiles not selects, level buttons, quiet header chrome.
await cdp('Page.navigate', { url: `${PANE}?fresh=${Date.now()}` })
await sleep(3000)
const paneShape = await evaluate(`(() => {
  const pane = document.querySelector('.games-wait-pane')
  if (!pane) return { error: 'no pane' }
  return {
    selects: pane.querySelectorAll('select').length,
    tiles: [...pane.querySelectorAll('[data-game-tile]')].map(node => node.textContent.trim()),
    levels: [...pane.querySelectorAll('[data-level]')].map(node => node.textContent.trim()),
    minimize: Boolean(pane.querySelector('[aria-label="Minimize"]')),
    close: Boolean(pane.querySelector('[aria-label="Close"]')),
    statusbar: (document.getElementById('statusbar') || { textContent: '?' }).textContent.trim()
  }
})()`)
check('pane renders', Boolean(paneShape && !paneShape.error), JSON.stringify(paneShape).slice(0, 120))
check('no drop-down in the pane', Boolean(paneShape) && paneShape.selects === 0)
check('game tiles instead', Boolean(paneShape && paneShape.tiles && paneShape.tiles.length >= 4), JSON.stringify(paneShape && paneShape.tiles))
const ownerWords = ['Beginner', 'Intermediate', 'Advanced', 'Expert']
check('strength buttons use the owner words', Boolean(paneShape && paneShape.levels && paneShape.levels.length)
  && paneShape.levels.every(label => ownerWords.indexOf(label) !== -1), JSON.stringify(paneShape && paneShape.levels))
check('Minimize and Close in the header', Boolean(paneShape && paneShape.minimize && paneShape.close))
check('status bar quiet before any game', Boolean(paneShape) && paneShape.statusbar === '', JSON.stringify(paneShape && paneShape.statusbar))
await screenshot('02-pane-open-tiles-levels.png')

// ---- 3. One press on Beginner starts the game; the status bar then carries
// exactly one actionable item and never a permanent Games label.
await press('Beginner level button', `[...document.querySelectorAll('[data-level]')].find(node => node.textContent.trim() === 'Beginner')`)
const started = await evaluate(`(window.qa.calls || []).filter(line => String(line).indexOf('allow-ai') === 0).join(' | ')`)
check('level press runs allow-ai at easy', /allow-ai \w+ black=local level=easy/.test(started || ''), started)
await until(`(() => {
  const bar = document.getElementById('statusbar')
  return bar && bar.querySelector('[data-games-status="action"]') ? bar.textContent.trim() : ''
})()`, 25000)
const alerted = await evaluate(`(() => {
  const items = [...document.querySelectorAll('#statusbar [data-games-status="action"]')]
  return { count: items.length, text: items.map(node => node.textContent.trim()) }
})()`)
check('exactly one status item once there is news', Boolean(alerted) && alerted.count === 1 && alerted.text.join('').indexOf('Your turn') !== -1, JSON.stringify(alerted))
await screenshot('03-your-turn-status-item.png')

// ---- 4. Minimize collapses to a strip and survives a reload (per session).
await press('Minimize', `document.querySelector('.games-wait-pane [aria-label="Minimize"]')`)
await sleep(400)
const strip = await evaluate(`(() => ({
  strip: Boolean(document.querySelector('.games-wait-pane-strip')),
  full: Boolean(document.querySelector('.games-wait-pane'))
}))()`)
check('minimize collapses to the strip', Boolean(strip) && strip.strip && !strip.full, JSON.stringify(strip))
await screenshot('04-minimized-strip.png')
await cdp('Page.navigate', { url: `${PANE}?again=${Date.now()}` })
await sleep(2500)
check('strip remembered after a reload', await evaluate('Boolean(document.querySelector(".games-wait-pane-strip"))'))

// ---- 5. One press on the strip restores the pane.
await press('strip restore', `document.querySelector('.games-wait-pane-strip button')`)
await sleep(400)
check('strip press restores the pane', await evaluate('Boolean(document.querySelector(".games-wait-pane"))'))
const revealed = await evaluate('window.qa.revealed || []')
check('restore asks the desktop to reveal the pane', (revealed || []).length > 0, JSON.stringify(revealed))
await screenshot('05-restored-from-strip.png')

// ---- 6. Esc closes the pane while focus is inside it.
await press('the Game tab (focus inside the pane)', `[...document.querySelectorAll('.games-wait-pane button')].find(node => node.textContent.trim() === 'Game')`)
await keyEscape()
await sleep(400)
check('Esc with focus inside closes the pane', await evaluate('Boolean(document.querySelector(".games-wait-pane-strip"))'))

// ---- 7. The strip comes back, then Close hides it the same way.
await press('strip again', `document.querySelector('.games-wait-pane-strip button')`)
await sleep(300)
await press('Close', `document.querySelector('.games-wait-pane [aria-label="Close"]')`)
await sleep(400)
const closed = await evaluate(`(() => ({
  strip: Boolean(document.querySelector('.games-wait-pane-strip')),
  pref: sessionStorage.getItem('gameshelf-pane-chrome')
}))()`)
check('Close collapses and remembers', Boolean(closed) && closed.strip && closed.pref === 'closed', JSON.stringify(closed))

// ---- 8. The start-over dialog: Esc and a click outside both dismiss it.
await press('strip once more', `document.querySelector('.games-wait-pane-strip button')`)
await sleep(400)
const startOver = await until(`(() => {
  const node = [...document.querySelectorAll('.games-wait-pane button')].find(b => ['Start over', 'New game vs computer'].indexOf(b.textContent.trim()) !== -1)
  return node ? 'yes' : ''
})()`, 8000)
check('start-over control reachable', startOver === 'yes')
const startOverButton = `[...document.querySelectorAll('.games-wait-pane button')].find(b => ['Start over', 'New game vs computer'].indexOf(b.textContent.trim()) !== -1 && !b.disabled)`
await until(`(() => { const node = ${startOverButton}; return node ? 'yes' : '' })()`, 10000)
await press('start-over control', startOverButton)
await sleep(600)
const dialogShown = await until('Boolean(document.querySelector(\'.games-wait-pane [role="alertdialog"]\'))', 4000)
check('confirm dialog shown', dialogShown === true || dialogShown === 'true' || Boolean(dialogShown), String(dialogShown))
await screenshot('06-confirm-dialog.png')
await keyEscape()
await sleep(300)
check('Esc dismisses the dialog', await evaluate('!document.querySelector(\'.games-wait-pane [role="alertdialog"]\')'))
await press('start-over control again', startOverButton)
await sleep(600)
check('confirm dialog shown again', await evaluate('Boolean(document.querySelector(\'.games-wait-pane [role="alertdialog"]\'))'))
// A click on the pane header is outside the dialog box.
await press('header (outside the dialog)', `document.querySelector('.games-wait-pane').firstElementChild`)
await sleep(300)
check('click-outside dismisses the dialog', await evaluate('!document.querySelector(\'.games-wait-pane [role="alertdialog"]\')'))

// ---- 9. Leave the pane open and healthy: no exceptions, real clicks happened.
await screenshot('07-pane-final.png')
const errors = await evaluate('({ page: window.qa.errors, console: (window.qa.consoleErrors || []).slice(0, 4) })')
check('no page errors', Boolean(errors) && !(errors.page || []).length && !(errors.console || []).length, JSON.stringify(errors))
check('real clicks happened', clicks >= 8, `count ${clicks}`)

console.log(exceptions.length ? 'exceptions: ' + exceptions.join(' | ').slice(0, 400) : '')
console.log(failures.length ? `FAILURES: ${failures.join(', ')}` : 'ALL PASS')
try { await cdp('Browser.close', {}) } catch {}
chrome.kill()
process.exit(failures.length ? 1 : 0)
