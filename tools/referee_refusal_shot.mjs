// tools/referee_refusal_shot.mjs — the README's referee-refusal screenshot, from the real plugin.
//
//   node tools/referee_refusal_shot.mjs [--port 18764] [--out screenshots/07-referee-refusal.png]
//
// It serves the REAL built plugin with tests/browser_table_server.py (only the SDK is stubbed),
// stages a genuine refusal with tools/referee_refusal_stage.py, opens Chess, and screenshots the
// board in headless Chrome (muted). The refusal is the referee's own recorded sentence — if the
// staging step records no refusal, this exits non-zero and writes nothing, rather than posing one.
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
const PORT = Number(arg('port', '18864'))
const OUT = arg('out', path.join(ROOT, 'screenshots', '07-referee-refusal.png'))
const MAX_BYTES = 300 * 1024
const MAX_WIDTH = 1200
const URL_BASE = `http://127.0.0.1:${PORT}/`
const CHROME = process.env.CHROME_BIN || (fs.existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : 'google-chrome')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const PYTHON = (() => {
  for (const candidate of [process.env.PYTHON_BIN, '/usr/bin/python3', 'python3'].filter(Boolean)) {
    const probe = spawnSync(candidate, ['-c', 'import fastapi, uvicorn'], { stdio: 'ignore' })
    if (!probe.error && probe.status === 0) return candidate
  }
  return 'python3'
})()

const die = message => { console.error(message); process.exit(1) }

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'refusal-shot-'))
const root = path.join(scratch, 'root')
const cleanup = []
process.on('exit', () => {
  for (const stop of cleanup) { try { stop() } catch { /* gone */ } }
  try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10 }) } catch { /* best effort */ }
})

// ---------------------------------------------------------------- stage the refusal
console.log(`staging a real refusal with ${PYTHON}`)
const staged = spawnSync(PYTHON, [path.join(ROOT, 'tools', 'referee_refusal_stage.py'), root], { cwd: ROOT, encoding: 'utf-8' })
process.stdout.write(staged.stdout || '')
if (staged.status !== 0) die(`referee_refusal_stage.py failed (exit ${staged.status}):\n${staged.stderr || ''}`)
let record
try { record = JSON.parse(fs.readFileSync(path.join(root, 'staged.json'), 'utf-8')) } catch (error) { die(`no staged.json: ${error.message}`) }
if (!record.ok || !record.message) die('the staging step recorded no refusal — refusing to pose a screenshot')
console.log(`staged refusal at ply ${record.refusal_ply} of ${record.plies}: ${record.message}`)

// ---------------------------------------------------------------- QA server
console.log(`QA server on ${PYTHON}`)
const server = spawn(PYTHON, [path.join(ROOT, 'tests', 'browser_table_server.py'), '--root', root, '--port', String(PORT), '--game', 'chessboard'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
let serverLog = ''
server.stdout.on('data', chunk => { serverLog += chunk })
server.stderr.on('data', chunk => { serverLog += chunk })
cleanup.push(() => server.kill('SIGKILL'))

let up = false
for (let attempt = 0; attempt < 120; attempt += 1) {
  try { if ((await fetch(URL_BASE)).ok) { up = true; break } } catch { /* not listening yet */ }
  await sleep(500)
}
if (!up) die(`the QA server never answered on ${URL_BASE}\n${serverLog.slice(-2000)}`)

// Answer the first-run welcome once, through the real /setup handler, so the page opens on the
// library rather than the welcome (the refusal is what this shot is about, not onboarding).
try {
  const answered = await fetch(`${URL_BASE}api/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: true })
  })
  console.log(`welcome answered: ${answered.status}`)
} catch (error) {
  console.log(`welcome answer failed: ${error.message}`)
}

// ---------------------------------------------------------------- chrome
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'refusal-chrome-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--mute-audio', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1200,1300', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' })
cleanup.push(() => chrome.kill('SIGKILL'))

let page = null
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const tabs = await (await fetch(`http://127.0.0.1:${PORT + 1}/json`)).json()
    page = tabs.find(tab => tab.type === 'page')
    if (page) break
  } catch { /* not up yet */ }
  await sleep(500)
}
if (!page) die('chrome did not open a page')

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
const click = selector => evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; n.click(); return true })()`)

await cdp('Page.enable')
await cdp('Runtime.enable')
await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1300, deviceScaleFactor: 1, mobile: false })

// ---------------------------------------------------------------- open Chess
await cdp('Page.navigate', { url: URL_BASE })
await sleep(6000)
// The first-run welcome is its own screen; skip it (or answer it) until the library is showing.
for (let attempt = 0; attempt < 12; attempt += 1) {
  const state = await evaluate(`(() => {
    if (!/Welcome to Game Center/.test(document.body.innerText || '')) return 'gone'
    const node = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Skip for now')
      || [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Continue')
    if (!node) return 'none'
    node.click()
    return 'clicked'
  })()`)
  if (state === 'gone') break
  await sleep(1200)
}
await sleep(2000)

let opened = false
for (let attempt = 0; attempt < 40; attempt += 1) {
  if (await click('[data-game-tile="chessboard"]')) { opened = true; break }
  await sleep(500)
}
if (!opened) {
  const diag = await evaluate(`(() => ({
    tiles: [...document.querySelectorAll('[data-game-tile]')].map(n => n.getAttribute('data-game-tile')),
    buttons: [...document.querySelectorAll('button')].slice(0, 40).map(n => (n.textContent || '').trim().slice(0, 30)),
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 600),
    errors: (window.qa && window.qa.errors) || [], consoleErrors: (window.qa && window.qa.consoleErrors) || []
  }))()`)
  die(`navigate: the Chess tile never appeared on the Play shelf\n${JSON.stringify(diag, null, 2)}`)
}

let board = null
for (let attempt = 0; attempt < 60; attempt += 1) {
  board = await evaluate(`(() => {
    const table = document.querySelector('.games-play-table')
    const badge = document.querySelector('.games-refusal-badge')
    const banner = document.querySelector('.games-refusal-banner')
    const line = [...document.querySelectorAll('.games-move-history div')].find(n => (n.textContent || '').includes('Illegal move'))
    if (!table || !badge) return null
    const box = n => { const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height } }
    return {
      table: box(table), badge: box(badge), banner: banner ? box(banner) : null, line: line ? box(line) : null,
      innerHeight: window.innerHeight, innerWidth: window.innerWidth,
      badgeText: (badge.textContent || '').trim(),
      bannerText: banner ? (banner.textContent || '').trim() : '',
      lineText: line ? (line.textContent || '').trim() : '',
      scrollHeight: table.scrollHeight, clientHeight: table.clientHeight
    }
  })()`)
  if (board && board.badge) break
  await sleep(500)
}
if (!board || !board.badge) die('the board never showed the referee\'s refusal badge')

console.log('board:', JSON.stringify(board, null, 2))
if (!/Referee said no/.test(board.badgeText)) die(`the badge is not the referee's refusal: ${board.badgeText}`)
const refusalSeen = board.bannerText.includes('Illegal move') || board.lineText.includes('Illegal move')
if (!refusalSeen) die('the refusal sentence is not on the board — refusing to shoot')

// ---------------------------------------------------------------- shoot
fs.mkdirSync(path.dirname(OUT), { recursive: true })
const capture = async scale => {
  const box = await evaluate(`(() => {
    const table = document.querySelector('.games-play-table')
    const r = table.getBoundingClientRect()
    const bottom = Math.min(r.bottom, window.innerHeight - 1)
    return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(r.width, window.innerWidth), height: Math.max(1, bottom - r.top) }
  })()`)
  const shot = await cdp('Page.captureScreenshot', {
    format: 'png',
    clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale }
  })
  if (!shot || !shot.data) return null
  const buffer = Buffer.from(shot.data, 'base64')
  return { buffer, width: Math.round(box.width * scale), height: Math.round(box.height * scale) }
}

let best = null
for (const scale of [1, 0.9, 0.8, 0.7, 0.6, 0.5]) {
  const taken = await capture(scale)
  if (!taken) continue
  best = taken
  if (taken.width <= MAX_WIDTH && taken.buffer.length <= MAX_BYTES) break
}
if (!best) die('Page.captureScreenshot returned nothing')
if (best.width > MAX_WIDTH) die(`the screenshot is ${best.width} px wide (max ${MAX_WIDTH})`)
if (best.buffer.length > MAX_BYTES) die(`the screenshot is ${(best.buffer.length / 1024).toFixed(0)} KB (max 300 KB)`)
fs.writeFileSync(OUT, best.buffer)
console.log(`wrote ${OUT} — ${best.width}x${best.height} px, ${(best.buffer.length / 1024).toFixed(0)} KB`)
cleanup.forEach(stop => stop())
console.log('DONE')
