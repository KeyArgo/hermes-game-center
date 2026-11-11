// Play & Learn proof: the Learn sheet, the narrated demo player, and the guided
// first game, pressed with a real mouse in muted headless Chrome.
//
// Every control is hit-tested with elementFromPoint at its centre and pressed
// with CDP pointer events; nothing here calls element.click(). The QA server is
// this repo's own isolated table server on scratch storage, started here and
// stopped here. Hermes itself is never touched.
//
//   node tools/tu_learn_proof.mjs --out proof/tu [--keep-server]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const ROOT = path.resolve('.')
const OUT = path.resolve(arg('out', 'proof/tu'))
const PYTHON = process.env.PYTHON || 'python3'
fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ---- the isolated QA server, on a free port, scratch root -------------------
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-tu-'))
const SERVER_PORT = await (async () => {
  for (let candidate = 18900 + (process.pid % 60); candidate < 18990; candidate += 1) {
    const free = await new Promise(resolve => {
      const probe = net.createServer()
      probe.once('error', () => resolve(false))
      probe.once('listening', () => probe.close(() => resolve(true)))
      probe.listen(candidate, '127.0.0.1')
    })
    if (free) return candidate
  }
  throw new Error('no free port for the QA server')
})()
const server = spawn(PYTHON, [
  'tests/browser_table_server.py', '--root', scratch, '--port', String(SERVER_PORT)
], { cwd: ROOT, stdio: 'ignore' })
const BASE = `http://127.0.0.1:${SERVER_PORT}`
for (let attempt = 0; attempt < 120; attempt += 1) {
  try {
    const probe = await fetch(BASE + '/', { signal: AbortSignal.timeout(500) })
    if (probe.ok) break
  } catch { /* booting */ }
  await sleep(250)
}

// ---- headless Chrome on its own free CDP port --------------------------------
let PORT = Number(arg('port', String(9400 + (process.pid % 300))))
for (let candidate = PORT; candidate < PORT + 60; candidate += 1) {
  try { await fetch(`http://127.0.0.1:${candidate}/json`, { signal: AbortSignal.timeout(250) }) } catch { PORT = candidate; break }
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-tu-'))
const CHROME = process.env.CHROME_BIN || 'google-chrome'
const chrome = spawn(CHROME, [
  '--headless=new', '--mute-audio', '--no-sandbox', '--disable-gpu',
  '--window-size=1400,1000', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' })
// On the way out (success, failure or signal): kill ONLY this Chrome by pid and
// delete its own profile. Never taskkill /IM chrome.exe - the owner's Chrome is
// open and must not be touched.
let chromeClosed = false
const cleanup = () => {
  if (chromeClosed) return
  chromeClosed = true
  try { chrome.kill('SIGKILL') } catch { /* already gone */ }
  try { chrome.pid && process.kill(chrome.pid, 'SIGKILL') } catch { /* already gone */ }
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* chrome still holds a lock */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* server still holds a lock */ }
  try { server.kill() } catch { /* already gone */ }
}
process.on('exit', code => { cleanup(); process.exitCode = code })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cleanup(); process.exit(130) })
chrome.on('exit', () => { chromeClosed = true })
// A spawned Chrome keeps Node alive, so a successful run must stop it on purpose.
// Kill only this process (never Chrome by name), then wait for its profile lock to
// clear before deleting the folder.
const shutdown = async code => {
  if (!chromeClosed) {
    chromeClosed = true
    try { chrome.kill('SIGKILL') } catch { /* already gone */ }
    try { chrome.pid && process.kill(chrome.pid, 'SIGKILL') } catch { /* already gone */ }
  }
  try { server.kill() } catch { /* already gone */ }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { fs.rmSync(profile, { recursive: true, force: true }); break } catch { await sleep(100) }
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { fs.rmSync(scratch, { recursive: true, force: true }); break } catch { await sleep(100) }
  }
  process.exit(code)
}
let tabs = []
for (let attempt = 0; attempt < 80; attempt += 1) {
  try {
    tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    if (tabs.some(tab => tab.type === 'page')) break
  } catch { /* not up yet */ }
  await sleep(400)
}
const page = tabs.find(tab => tab.type === 'page')
if (!page) { console.error('chrome did not open a page'); process.exit(1) }
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(resolve => { socket.onopen = resolve })
let counter = 0
const waiting = new Map()
socket.onmessage = message => {
  const data = JSON.parse(message.data)
  if (data.id && waiting.has(data.id)) { waiting.get(data.id)(data); waiting.delete(data.id) }
}
const cdp = (method, params = {}) => new Promise(resolve => {
  const id = ++counter
  waiting.set(id, data => resolve(data.result ?? { __error: data.error }))
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const answer = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (answer.__error) throw new Error(`${JSON.stringify(answer.__error)} for ${expression.slice(0, 90)}`)
  return answer.result?.value
}
const shot = async name => {
  const taken = await cdp('Page.captureScreenshot', { format: 'png' })
  const file = path.join(OUT, `${name}.png`)
  fs.writeFileSync(file, Buffer.from(taken.data, 'base64'))
  shots.push(file)
  return file
}
const pointer = async point => {
  const [x, y] = point
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}
// Press a button by exact label inside a scope: hit-test first, then a real press.
const pressLabel = async (label, scope = 'body', { timeoutMs = 0 } = {}) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await evaluate(`(() => {
      const root = document.querySelector(${JSON.stringify(scope)}) || document.body
      const node = [...root.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled)
      if (!node) return null
      node.scrollIntoView({ block: 'center' })
      const box = node.getBoundingClientRect()
      const x = box.x + box.width / 2, y = box.y + box.height / 2
      const hit = document.elementFromPoint(x, y)
      return { point: [x, y], hit: hit ? hit.tagName : '', inside: Boolean(hit && (node === hit || node.contains(hit))) }
    })()`)
    if (found) {
      if (!found.inside) throw new Error(`the centre of "${label}" is ${found.hit}, not the control`)
      await pointer(found.point)
      return true
    }
    if (Date.now() > deadline) return false
    await sleep(300)
  }
}
// A real press at a point of the hero board, computed inside the page.
const pressBoardPoint = async (expression, what) => {
  const point = await evaluate(`(() => {
    const svg = document.querySelector('.games-board-hero svg') || document.querySelector('main svg, [class*=board] svg')
    if (!svg) return null
    const box = svg.getBoundingClientRect()
    if (!box.width || !box.height) return null
    const spot = (${expression})(svg, box)
    if (!spot) return null
    const hit = document.elementFromPoint(spot[0], spot[1])
    if (!(hit === svg || svg.contains(hit))) return null
    return spot
  })()`)
  if (!point) throw new Error(`no pressable point for ${what}`)
  await pointer(point)
  return point
}
const waitFor = async (expression, seconds = 30) => {
  for (let attempt = 0; attempt < seconds * 2; attempt += 1) {
    if (await evaluate(expression)) return true
    await sleep(500)
  }
  return false
}
const bodyText = () => evaluate('(document.body.innerText || "").slice(0, 1200)')

const report = { games: {}, shots: [] }
const shots = report.shots
await cdp('Runtime.enable')
await cdp('Page.enable')
await cdp('Page.addScriptToEvaluateOnNewDocument', {
  source: "window.__errors = []; window.addEventListener('error', e => window.__errors.push(String(e.message))); window.addEventListener('unhandledrejection', e => window.__errors.push('rejected: ' + String(e.reason && e.reason.message || e.reason)));"
})
await cdp('Page.navigate', { url: BASE })
if (!await waitFor('document.body && document.body.innerText.length > 100', 60)) {
  await shot('00-page-not-loaded')
  console.error('BODY', await bodyText())
  throw new Error('the QA page never rendered')
}
if (/Welcome to Game Center/.test(await bodyText())) {
  await pressLabel('Continue')
  await sleep(1000)
}
const install = async id => {
  await evaluate(`fetch("/api/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ line: "install ${id}" }) }).then(r => r.json())`)
  await sleep(400)
}

// ---- shared Learn-sheet walkthrough ------------------------------------------
// Open the Learn sheet from wherever the screen is, exercise all three tabs, and
// leave the sheet on the Play & Learn tab. Returns what the sheet showed.
const learnSheet = async (gameId, { expectDemo = true, captureDemo = false } = {}) => {
  const opened = await pressLabel('Learn', 'body', { timeoutMs: 6000 })
  if (!opened) throw new Error(`${gameId}: no Learn button on the screen`)
  if (!await waitFor(`Boolean(document.querySelector('.games-learn-sheet'))`, 12)) {
    await shot(`${gameId}-00-sheet-missing`)
    throw new Error(`${gameId}: the Learn sheet never opened`)
  }
  const sheet = {}
  sheet.title = await evaluate(`(document.querySelector('.games-learn-sheet') || {}).innerText.slice(0, 80)`)
  sheet.tabs = await evaluate(`[...document.querySelectorAll('.games-learn-sheet [role=tablist] button')].map(b => b.textContent.trim())`)
  // Wait for /learn to arrive; the sheet's head and tabs paint first.
  await waitFor(`/goal/i.test((document.querySelector('.games-learn-sheet') || { innerText: '' }).innerText)`, 12)
  sheet.goal = /goal/i.test(await evaluate(`(document.querySelector('.games-learn-sheet') || { innerText: '' }).innerText`))
  await shot(`${gameId}-01-rules`)
  // The sheet re-renders when /learn arrives, which can move a tab out from under
  // the pointer; press again only when the panel did not change.
  const openTab = async (label, ready) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await pressLabel(label, '.games-learn-sheet', { timeoutMs: 6000 })
      if (await waitFor(ready, 5)) return true
    }
    return false
  }
  await openTab('Watch it played', `Boolean(document.querySelector('.games-learn-demo'))`)
  if (expectDemo) {
    if (!await waitFor(`Boolean(document.querySelector('.games-learn-demo'))`, 12)) {
      const dump = await evaluate(`(() => { const s = document.querySelector('.games-learn-sheet') || { innerText: 'NONE' }; return s.innerText.slice(0, 400) + ' ||| ' + [...(s.querySelectorAll ? s.querySelectorAll('button') : [])].map(b => JSON.stringify([b.textContent.trim(), b.disabled])).join(',') })()`)
      await shot(`${gameId}-01b-no-demo`)
      throw new Error(`${gameId}: no demo player :: ${dump}`)
    }
    const counter = () => evaluate(`(() => { const d = document.querySelector('.games-learn-demo'); if (!d) return ''; return [...d.querySelectorAll('span')].map(s => (s.textContent || '').trim()).find(t => t.includes('/')) || '' })()`)
    sheet.demo_frames = await counter()
    const nextPressed = await pressLabel('Next', '.games-learn-demo')
    sheet.demo_after_next = await counter()
    if (sheet.demo_after_next === sheet.demo_frames) {
      const dump = await evaluate(`(() => { const d = document.querySelector('.games-learn-demo') || { innerText: 'NONE' }; return d.innerText.slice(0, 300) + ' ||| ' + [...(d.querySelectorAll ? d.querySelectorAll('button') : [])].map(b => JSON.stringify([b.textContent.trim(), b.disabled])).join(',') })()`)
      await shot(`${gameId}-01b-demo-stuck`)
      throw new Error(`${gameId}: Next did not move the demo (before=${JSON.stringify(sheet.demo_frames)} after=${JSON.stringify(sheet.demo_after_next)} pressed=${nextPressed} :: ${dump})`)
    }
    await pressLabel('Back', '.games-learn-demo')
    const speedBefore = await evaluate(`[...document.querySelectorAll('.games-learn-demo button')].map(b => b.textContent.trim()).join(',')`)
    await pressLabel('1x', '.games-learn-demo')
    const speedAfter = await evaluate(`[...document.querySelectorAll('.games-learn-demo button')].map(b => b.textContent.trim()).join(',')`)
    sheet.speed_cycles = speedBefore !== speedAfter
    if (captureDemo) {
      // Walk the whole demo with the mouse, one screenshot per position. The
      // first Back above put us on frame one.
      const total = Math.max(1, Number(String(sheet.demo_frames || '').split('/')[1]) || 0)
      for (let at = 0; at < total; at += 1) {
        await shot(`${gameId}-demo-${String(at + 1).padStart(2, '0')}`)
        if (at < total - 1) await pressLabel('Next', '.games-learn-demo')
      }
      sheet.demo_captured = total
      await pressLabel('Back', '.games-learn-demo')
    }
    // Let it autoplay for a beat, then pause.
    await pressLabel('Play', '.games-learn-demo')
    await sleep(2600)
    sheet.demo_autoplayed = (await counter()) !== sheet.demo_after_next
    await pressLabel('Pause', '.games-learn-demo')
  }
  await shot(`${gameId}-02-demo`)
  await openTab('Play & Learn', `(() => /Beginner|guide/i.test((document.querySelector('.games-learn-sheet') || { innerText: '' }).innerText))()`)
  sheet.guided_tab = /Beginner|guide/i.test(await evaluate(`(document.querySelector('.games-learn-sheet') || { innerText: '' }).innerText`))
  return sheet
}

// ---- One real move, made with the mouse -------------------------------------
const boardFound = `(() => { const svg = [...document.querySelectorAll('.games-board-hero svg')].find(s => /board/.test(s.getAttribute('aria-label') || '')); return svg || null })()`
const boardDots = () => evaluate(`(() => {
  const svg = ${boardFound}
  if (!svg) return []
  return [...svg.querySelectorAll('circle')]
    .filter(node => (node.getAttribute('fill') || '') === '#7ec8ff' && Number(node.getAttribute('r') || 0) <= 7)
    .map(node => { const box = node.getBoundingClientRect(); return [box.x + box.width / 2, box.y + box.height / 2] })
})()`)
const boardPieces = () => evaluate(`(() => {
  const svg = ${boardFound}
  if (!svg) return []
  const out = []
  ;[...svg.querySelectorAll(':scope > svg')].forEach(node => {
    const box = node.getBoundingClientRect()
    if (box.width >= 8) out.push([box.x + box.width / 2, box.y + box.height / 2])
  })
  ;[...svg.querySelectorAll(':scope > circle')].forEach(node => {
    const fill = node.getAttribute('fill') || ''
    if (Number(node.getAttribute('r') || 0) < 8 || !['#f0d0b0', '#7a2018'].includes(fill)) return
    const box = node.getBoundingClientRect()
    out.push([box.x + box.width / 2, box.y + box.height / 2])
  })
  return out
})()`)
const kalahPits = () => evaluate(`(() => {
  const svg = ${boardFound}
  if (!svg) return []
  return [...svg.querySelectorAll('ellipse')]
    .filter(node => (node.getAttribute('stroke') || '') === '#e0b36a')
    .map(node => { const box = node.getBoundingClientRect(); return [box.x + box.width / 2, box.y + box.height / 2] })
})()`)
const pressPoint = async (point, what) => {
  if (!point) throw new Error(`no pressable point for ${what}`)
  await pointer(point)
  await sleep(250)
  return true
}
const squarePoint = async name => evaluate(`(() => {
  const svg = [...document.querySelectorAll('.games-board-hero svg')].find(s => /board/.test(s.getAttribute('aria-label') || ''))
  if (!svg) return null
  const vb = svg.viewBox.baseVal
  const cell = vb.width / 8
  const files = 'abcdefgh'
  const col = files.indexOf(${JSON.stringify(name)}[0])
  const row = 8 - Number(${JSON.stringify(name)}[1])
  const p = svg.createSVGPoint()
  p.x = col * cell + cell / 2
  p.y = row * cell + cell / 2
  const m = svg.getScreenCTM()
  if (!m) return null
  const o = p.matrixTransform(m)
  return [o.x, o.y]
})()`)
const playSeabattle = async () => {
  // Lay the fleet down in one press, wait for the computer's own fleet, then fire.
  if (!await pressLabel('Random fleet', '.games-board-hero', { timeoutMs: 4000 })) throw new Error('seabattle: no Random fleet button')
  if (!await waitFor(`(() => { const b = document.querySelector('[data-sea-board="enemy"] [data-sea-cell="e5"]'); return Boolean(b) && /Your turn/i.test((document.body.innerText || '')) })()`, 25)) throw new Error('seabattle: enemy waters never opened')
  const point = await evaluate(`(() => {
    const node = document.querySelector('[data-sea-board="enemy"] [data-sea-cell="e5"]')
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const box = node.getBoundingClientRect()
    return [box.x + box.width / 2, box.y + box.height / 2]
  })()`)
  await pressPoint(point, 'seabattle enemy square e5')
  return true
}
const playFirstMove = async id => {
  if (id === 'seabattle') return playSeabattle()
  if (id === 'chessboard') { await pressPoint(await squarePoint('e2'), 'e2'); await pressPoint(await squarePoint('e4'), 'e4'); return true }
  if (id === 'checkers') { await pressPoint(await squarePoint('c3'), 'c3'); await pressPoint(await squarePoint('b4'), 'b4'); return true }
  if (id === 'breakthrough') { await pressPoint(await squarePoint('e2'), 'e2'); await pressPoint(await squarePoint('e3'), 'e3'); return true }
  const pits = await kalahPits()
  if (pits.length) return pressPoint(pits[0], `${id} pit`)
  let dots = await boardDots()
  if (dots.length) return pressPoint(dots[0], `${id} legal square`)
  // A piece game may light its targets only after a piece is picked up.
  for (const piece of (await boardPieces()).slice(0, 12)) {
    await pointer(piece)
    await sleep(250)
    dots = await boardDots()
    if (dots.length) return pressPoint(dots[0], `${id} legal square`)
  }
  // Blank boards (Hex, Gomoku, Go) take a stone in the middle.
  return pressBoardPoint('svg => { const b = svg.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2] }', `${id} board centre`)
}

const tableGames = [
  { id: 'connect4', title: 'Connect Four' },
  { id: 'reversi', title: 'Reversi' },
  { id: 'checkers', title: 'Checkers' },
  { id: 'gomoku', title: 'Gomoku' },
  { id: 'kalah', title: 'Kalah' },
  { id: 'chessboard', title: 'Chess' },
  { id: 'go', title: 'Go' },
  { id: 'hex', title: 'Hex', captureDemo: true },
  { id: 'breakthrough', title: 'Breakthrough' },
  { id: 'seabattle', title: 'Sea Battle' },
]

for (const game of tableGames) {
  const record = {}
  report.games[game.id] = record
  await install(game.id)
  await cdp('Page.navigate', { url: BASE })
  await waitFor('document.body && document.body.innerText.length > 100', 40)
  await sleep(900)
  if (/Welcome to Game Center/.test(await bodyText())) { await pressLabel('Continue'); await sleep(900) }
  // Play cards name themselves for accessibility, so "Go" can never open "Gomoku".
  const openedCard = await evaluate(`(() => {
    const node = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(game.title)} && !b.disabled)
      || [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === ${JSON.stringify(game.title)} && !b.disabled)
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const box = node.getBoundingClientRect()
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    const hit = document.elementFromPoint(x, y)
    if (!(hit && (node === hit || node.contains(hit) || hit.contains(node)))) return null
    return [x, y]
  })()`)
  if (!openedCard) { await shot(`${game.id}-00-no-card`); throw new Error(`${game.id}: no shelf card`) }
  await pointer(openedCard)
  if (!await waitFor(`(document.body.innerText || '').includes('Choose how to play') || Boolean(document.querySelector('.games-board-hero'))`, 20)) {
    await shot(`${game.id}-00-no-setup`)
    console.error('BODY', await bodyText())
    throw new Error(`${game.id}: the game screen never opened`)
  }
  record.sheet = await learnSheet(game.id, { captureDemo: Boolean(game.captureDemo) })
  // Start the guided game from the sheet.
  const started = await pressLabel('Start guided game vs Beginner', '.games-learn-sheet', { timeoutMs: 4000 })
  if (!started) throw new Error(`${game.id}: no Start guided game button`)
  if (!await waitFor(`Boolean(document.querySelector('[aria-label="Guide"]')) && Boolean(document.querySelector('.games-board-hero'))`, 25)) {
    await shot(`${game.id}-03-no-guide`)
    console.error('BODY', await bodyText())
    throw new Error(`${game.id}: the guided game or its guide never appeared`)
  }
  record.guide = await evaluate(`(document.querySelector('[aria-label="Guide"]') || { innerText: '' }).innerText.slice(0, 200)`)
  await shot(`${game.id}-04-guided`)
  // Play one real move with the mouse.
  record.move_played = await playFirstMove(game.id)
  // Wait for the machine's answer and its own words.
  record.computer_spoke = await waitFor(`(() => { const c = document.querySelector('[aria-label="Coach"]'); return c && /The computer says/.test(c.innerText) })()`, 30)
  record.coach_text = await evaluate(`(() => { const c = document.querySelector('[aria-label="Coach"]'); return c ? c.innerText.slice(0, 220) : '' })()`)
  record.guide_after = await evaluate(`(document.querySelector('[aria-label="Guide"]') || { innerText: '' }).innerText.slice(0, 200)`)
  await shot(`${game.id}-05-computer-explains`)
  record.page_errors = await evaluate('JSON.stringify(window.__errors || [])')
  console.log(`${game.id}:`, JSON.stringify({ tabs: record.sheet.tabs, guide: record.guide.slice(0, 40), guide_after: record.guide_after.slice(0, 40), computer: record.computer_spoke, move: record.move_played }))
}

// ---- Liar's Dice: the talking table -------------------------------------------
{
  const record = {}
  report.games['liars-dice'] = record
  await install('liars-dice')
  await cdp('Page.navigate', { url: BASE })
  await waitFor('document.body && document.body.innerText.length > 100', 40)
  await sleep(900)
  if (/Welcome to Game Center/.test(await bodyText())) { await pressLabel('Continue'); await sleep(900) }
  const openedCard = await evaluate(`(() => {
    // A talking table lives in Your games: its Open button carries the title.
    const node = [...document.querySelectorAll('button')].find(b => (b.getAttribute('title') || '') === "Liar's Dice" && !b.disabled)
      || [...document.querySelectorAll('button')].find(b => /Liar/.test((b.textContent || '').trim()) && !b.disabled)
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const box = node.getBoundingClientRect()
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    const hit = document.elementFromPoint(x, y)
    if (!(hit && (node === hit || node.contains(hit) || hit.contains(node)))) return null
    return [x, y]
  })()`)
  if (!openedCard) { await shot('liars-dice-00-no-card'); throw new Error("liars-dice: no shelf card") }
  await pointer(openedCard)
  if (!await waitFor(`Boolean(document.querySelector('.games-talk-setup'))`, 20)) {
    await shot('liars-dice-00-no-setup')
    console.error('BODY', await bodyText())
    throw new Error("liars-dice: the setup never opened")
  }
  record.sheet = await learnSheet('liars-dice', { expectDemo: true })
  const started = await pressLabel('Start guided game vs Beginner', '.games-learn-sheet', { timeoutMs: 4000 })
  if (!started) throw new Error("liars-dice: no Start guided game button")
  if (!await waitFor(`Boolean(document.querySelector('[aria-label="Guide"]'))`, 25)) {
    await shot('liars-dice-03-no-guide')
    console.error('BODY', await bodyText())
    throw new Error("liars-dice: the guide never appeared")
  }
  record.guide = await evaluate(`(document.querySelector('[aria-label="Guide"]') || { innerText: '' }).innerText.slice(0, 200)`)
  await shot('liars-dice-04-guided')
  // Play through with the table's own buttons until the computer has spoken.
  let spoke = false
  for (let turn = 0; turn < 40 && !spoke; turn += 1) {
    const coach = await evaluate(`(() => { const c = document.querySelector('[aria-label="Coach"]'); return c && /The computer says/.test(c.innerText) ? c.innerText.slice(0, 220) : '' })()`)
    if (coach) { record.coach_text = coach; spoke = true; break }
    const stepped = await pressLabel('Step', '.games-talk', { timeoutMs: 3000 })
    if (stepped) { await sleep(1400); continue }
    const acted = await evaluate(`(() => {
      const node = [...document.querySelectorAll('.games-talk-actions button')].find(b => !b.disabled)
      if (!node) return null
      node.scrollIntoView({ block: 'center' })
      const box = node.getBoundingClientRect()
      const x = box.x + box.width / 2, y = box.y + box.height / 2
      const hit = document.elementFromPoint(x, y)
      if (!(hit && (node === hit || node.contains(hit)))) return null
      return [x, y]
    })()`)
    if (acted) { await pointer(acted); await sleep(1400); continue }
    await sleep(700)
  }
  record.computer_spoke = spoke
  await shot('liars-dice-05-computer-explains')
  // The guide advances by mouse too.
  record.next_rule = await pressLabel('Next rule', '[aria-label="Guide"]')
  await shot('liars-dice-06-guide-step')
  record.page_errors = await evaluate('JSON.stringify(window.__errors || [])')
  console.log('liars-dice:', JSON.stringify({ tabs: record.sheet.tabs, guide: (record.guide || '').slice(0, 40), computer: spoke }))
}

// ---- verdict -------------------------------------------------------------------
const failures = []
const curated = JSON.parse(fs.readFileSync(path.join(ROOT, 'shelf/curated.json'), 'utf8')).games || []
for (const game of curated) {
  if (!report.games[game]) failures.push(`${game}: on the front shelf but not proved`)
}
for (const [id, record] of Object.entries(report.games)) {
  if (!record.sheet?.tabs?.join('|').includes('How to play')) failures.push(`${id}: no rules tab`)
  if (!record.sheet?.goal) failures.push(`${id}: rules card shows no Goal`)
  if (!record.sheet?.demo_frames) failures.push(`${id}: the demo showed no positions`)
  if (record.sheet?.demo_frames && record.sheet.demo_after_next === record.sheet.demo_frames) failures.push(`${id}: Next did not advance the demo`)
  if (!record.sheet?.demo_autoplayed) failures.push(`${id}: the demo did not play by itself`)
  if (!record.sheet?.guided_tab) failures.push(`${id}: no Play & Learn tab`)
  if (!record.computer_spoke) failures.push(`${id}: the computer never explained its move`)
  if (!record.guide) failures.push(`${id}: no guide in the guided game`)
  if (record.move_played === false) failures.push(`${id}: no mouse move was played`)
}
// The Hex demo must be captured end to end, or the proof cannot say it played.
const hexCaptured = Number(report.games.hex?.sheet?.demo_captured || 0)
if (hexCaptured < 2) failures.push('hex: the full demo was not captured')
for (let at = 1; at <= hexCaptured; at += 1) {
  if (!fs.existsSync(path.join(OUT, `hex-demo-${String(at).padStart(2, '0')}.png`))) failures.push(`hex: demo frame ${at} screenshot is missing`)
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
console.log('SHOTS', shots.length, 'OUT', OUT)
socket.close()
if (failures.length) {
  console.error('FAILURES', JSON.stringify(failures))
  await shutdown(1)
}
console.log('TU PROOF PASSED')
await shutdown(0)
