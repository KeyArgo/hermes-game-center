// Drive the real Game Center page with a real headless Chrome over CDP and prove the
// play-test fixes with the mouse, not with element.click():
//
//   node tools/owner_fixes_drive.mjs [--url http://127.0.0.1:18799/] [--out test-artifacts/owner-fixes]
//
// With no --url it starts tests/browser_table_server.py itself on a scratch root.
// Every button press is a CDP Input.dispatchMouseEvent at the button's centre, and a
// press is only allowed after document.elementFromPoint at that point returns the
// button (or something inside it) — so a control the board floats over fails here.
//
//  1. More options open: Back, Resign and Leave seat are really hit-testable.
//  2. A finished game puts a big result card ON the board, with the deciding cell
//     ringed, the turn dot gone, and Rematch / New game (level) / Review / Back.
//     Chess says Check! while play goes on.
//  3. Leave seat: one press against the computer, one question with people, and
//     Close table with nothing in play.
//  4. Hex, Go and Breakthrough never mention a draw; Connect Four still offers one.
//  5. No <select> on the way to a game, in the table or in the pane.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const GIVEN_URL = arg('url', '')
const OUT = path.resolve(arg('out', 'test-artifacts/owner-fixes'))
const PORT = Number(arg('port', '18799'))
const PYTHON = arg('python', process.env.GAMESHELF_QA_PYTHON || 'python3')
const ROOT = path.resolve(arg('root', '/tmp/gameshelf-owner-fixes'))
fs.mkdirSync(OUT, { recursive: true })
fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(ROOT, { recursive: true })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = (...parts) => console.log(...parts)
const results = []
const hits = []

// ---- the QA server (only when no --url was given) ---------------------------
let server = null
if (!GIVEN_URL) {
  const script = path.join(import.meta.dirname, '..', 'tests', 'browser_table_server.py')
  server = spawn(PYTHON, [script, '--root', ROOT, '--port', String(PORT), '--game', 'connect4'], { stdio: 'ignore' })
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const answer = await fetch(`http://127.0.0.1:${PORT}/api/view`, { signal: AbortSignal.timeout(500) })
      if (answer.ok) break
    } catch { /* not up yet */ }
    await sleep(500)
  }
}
const URL_BASE = GIVEN_URL || `http://127.0.0.1:${PORT}/`

// ---- a real, muted headless Chrome ----------------------------------------
let PORT_CHROME = Number(arg('cdp', String(9500 + (process.pid % 300))))
for (let candidate = PORT_CHROME; candidate < PORT_CHROME + 40; candidate += 1) {
  try {
    await fetch(`http://127.0.0.1:${candidate}/json`, { signal: AbortSignal.timeout(300) })
  } catch { PORT_CHROME = candidate; break }
}
const profile = fs.mkdtempSync('/tmp/gameshelf-of-chrome-')
process.on('exit', () => { try { chrome.kill('SIGKILL') } catch {} try { fs.rmSync(profile, { recursive: true, force: true }) } catch {} }); for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => process.exit(130)) // delete the ~200 MB Chrome profile when the run ends
const chrome = spawn('google-chrome', [
  '--headless=new', '--mute-audio', '--no-sandbox', '--disable-gpu',
  '--window-size=1400,950', `--remote-debugging-port=${PORT_CHROME}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' })
let tabs = []
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    tabs = await (await fetch(`http://127.0.0.1:${PORT_CHROME}/json`)).json()
    if (tabs.some(tab => tab.type === 'page')) break
  } catch { /* chrome is starting */ }
  await sleep(300)
}
const page = tabs.find(tab => tab.type === 'page')
if (!page) throw new Error('no browser page')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
let nextId = 0
const waiting = new Map()
socket.onmessage = event => {
  const message = JSON.parse(event.data)
  const entry = waiting.get(message.id)
  if (!entry) return
  waiting.delete(message.id)
  if (message.error) entry.reject(new Error(message.error.message))
  else entry.resolve(message.result)
}
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId
  waiting.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const answer = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception && answer.exceptionDetails.exception.description || 'page error')
  return answer.result.value
}
const shot = async name => {
  const taken = await cdp('Page.captureScreenshot', { format: 'png' })
  if (!taken || !taken.data) return
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(taken.data, 'base64'))
  log('  shot', `${name}.png`)
}
const note = async (name, text) => fs.writeFileSync(path.join(OUT, `${name}.txt`), text)

// A real press: move, press, release, all as the browser dispatches them.
const pressAt = async point => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point[0], y: point[1] })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: point[0], y: point[1], button: 'left', buttons: 1, clickCount: 1 })
  await sleep(30)
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point[0], y: point[1], button: 'left', buttons: 0, clickCount: 1 })
}
const drag = async (from, to) => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from[0], y: from[1] })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: from[0], y: from[1], button: 'left', buttons: 1, clickCount: 1 })
  for (let step = 1; step <= 6; step += 1) {
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from[0] + (to[0] - from[0]) * step / 6,
      y: from[1] + (to[1] - from[1]) * step / 6,
      button: 'left', buttons: 1
    })
    await sleep(16)
  }
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to[0], y: to[1], button: 'left', buttons: 0, clickCount: 1 })
}

// Where a button is, and what is really at that point. A press is refused when anything
// else is on top — which is exactly what "the board floats over Back" looked like.
const spotOf = async (label, selector = 'button, summary') => evaluate(`(() => {
  const wanted = ${JSON.stringify(label)}
  const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find(item => (item.textContent || '').trim() === wanted || item.getAttribute('aria-label') === wanted)
  if (!node) return null
  if (node.disabled) return { disabled: true }
  node.scrollIntoView({ block: 'center' })
  const box = node.getBoundingClientRect()
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const at = document.elementFromPoint(x, y)
  return {
    x, y,
    onScreen: box.width > 0 && box.height > 0 && x > 0 && y > 0 && x < innerWidth && y < innerHeight,
    hit: at === node || node.contains(at),
    coveredBy: at ? (at.tagName + ' ' + (at.getAttribute('class') || '') + ' ' + (at.textContent || '').trim().slice(0, 40)) : 'nothing'
  }
})()`)

const press = async (label, { wait = 550, selector = 'button, summary', required = true } = {}) => {
  // A press that was just handled locks the pane for the length of the request,
  // so a control can read "disabled" for a beat while the page is working.
  // Wait out that beat rather than calling a working step a failure.
  const enableBy = Date.now() + 25000
  let spot = await spotOf(label, selector)
  while (spot && spot.disabled && Date.now() < enableBy) {
    await sleep(200)
    spot = await spotOf(label, selector)
  }
  if (!spot) {
    if (!required) return null
    throw new Error(`no button "${label}" on the screen`)
  }
  if (spot.disabled) throw new Error(`"${label}" is disabled`)
  if (!spot.onScreen) throw new Error(`"${label}" is off screen`)
  if (!spot.hit) throw new Error(`"${label}" is covered: at its centre is ${spot.coveredBy}`)
  hits.push({ label, x: Math.round(spot.x), y: Math.round(spot.y), hit: true })
  if (process.env.OF_TRACE) log('  press', label)
  await pressAt([spot.x, spot.y])
  await sleep(wait)
  return spot
}

// Press, and if the expected state never arrives (a POST dropped under machine
// load is the usual culprit), press again — up to `attempts` times.
const pressUntil = async (label, ready, { wait = 1200, selector = 'button, summary', attempts = 3, limit = 21000 } = {}) => {
  const budget = Math.floor(limit / attempts)
  const settled = async () => {
    const deadline = Date.now() + budget
    for (;;) {
      try { if (await ready()) return true } catch { /* page between renders */ }
      if (Date.now() >= deadline) return false
      await sleep(250)
    }
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await press(label, { wait, selector })
    if (await settled()) return
  }
  throw new Error(`pressing "${label}" never took effect after ${attempts} presses`)
}

// Prove a control can be hit, without pressing it yet.
const hitTest = async label => {
  const enableBy = Date.now() + 25000
  let spot = await spotOf(label)
  while (spot && spot.disabled && Date.now() < enableBy) {
    await sleep(200)
    spot = await spotOf(label)
  }
  if (!spot || spot.disabled) throw new Error(`no usable button "${label}": ${JSON.stringify(spot)}`)
  if (!spot.onScreen || !spot.hit) throw new Error(`"${label}" cannot be hit: ${JSON.stringify(spot)}`)
  hits.push({ label, x: Math.round(spot.x), y: Math.round(spot.y), hit: true })
  if (process.env.OF_TRACE) log('  hit-ok', label)
  return spot
}

const goto = async (url = URL_BASE) => {
  await cdp('Page.navigate', { url })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(250)
    const ready = await evaluate(`Boolean(document.querySelector('.games-center-shell') || document.querySelector('.games-wait-pane') || document.querySelector('.games-welcome'))`).catch(() => false)
    if (ready) return
  }
  const why = await evaluate(`(() => ({
    title: document.title,
    html: document.documentElement.innerHTML.slice(0, 700),
    text: (document.body && document.body.innerText || '').slice(0, 300),
    qa: (window.qa && { errors: window.qa.errors, console: window.qa.consoleErrors }) || null
  }))()`).catch(error => ({ evaluateError: error.message }))
  throw new Error('the page never painted: ' + JSON.stringify(why))
}
// A scratch install opens on the welcome. Answer it once, with the mouse, so every
// later screen is the real page.
const dismissWelcome = async () => {
  if (!(await evaluate(`Boolean(document.querySelector('.games-welcome'))`))) return false
  for (const label of ['Continue', 'Skip for now']) {
    const spot = await spotOf(label)
    if (spot && !spot.disabled && spot.hit) {
      await pressAt([spot.x, spot.y])
      await sleep(1200)
      break
    }
  }
  return true
}

const text = () => evaluate('document.body.innerText')

// The page polls, so a screen that is about to change needs a wait, not a guess.
const waitFor = async (predicate, { limit = 9000, what = 'the screen' } = {}) => {
  for (let waited = 0; waited < limit; waited += 250) {
    const value = await predicate()
    if (value) return value
    await sleep(250)
  }
  const pageText = await text().catch(() => '')
  throw new Error(`waited ${limit}ms for ${what}; page said: ${JSON.stringify(pageText.slice(0, 300))}`)
}
const waitForText = (pattern, options = {}) => waitFor(async () => {
  const shown = await text()
  return pattern.test(shown) ? shown : null
}, { what: `text matching ${pattern}`, ...options })
const board = async () => {
  await evaluate(`(() => {
    window.__of = {
      svg() { return [...document.querySelectorAll('svg')].find(node => /board/.test(node.getAttribute('aria-label') || '')) || null },
      cell(row, col) {
        const svg = this.svg()
        if (!svg) return null
        const all = [...svg.querySelectorAll(':scope > rect')].map(node => ({
          node, w: Number(node.getAttribute('width') || 0), h: Number(node.getAttribute('height') || 0),
          x: Number(node.getAttribute('x') || 0), y: Number(node.getAttribute('y') || 0)
        })).filter(entry => Math.abs(entry.w - entry.h) < 0.01 && entry.w > 8)
        if (!all.length) return null
        // The board also paints one full-size background rect; the cells are the
        // most common square size, and only those may define the grid.
        const counts = new Map()
        for (const entry of all) counts.set(entry.w, (counts.get(entry.w) || 0) + 1)
        const size = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
        const squares = all.filter(entry => Math.abs(entry.w - size) < 0.01)
        const xs = [...new Set(squares.map(entry => entry.x))].sort((a, b) => a - b)
        const ys = [...new Set(squares.map(entry => entry.y))].sort((a, b) => a - b)
        const matrix = svg.getScreenCTM()
        const point = svg.createSVGPoint()
        point.x = xs[col] + size / 2
        point.y = ys[row] + size / 2
        const out = point.matrixTransform(matrix)
        return [out.x, out.y]
      },
      square(name) {
        const file = 'abcdefgh'.indexOf(String(name)[0])
        const rank = Number(String(name)[1])
        return this.cell(8 - rank, file)
      }
    }
    return true
  })()`)
}
const square = async name => {
  // Keep the whole board inside the viewport first: the move-list auto-scroll
  // (and the side pane) can push top rows above y=0, and CDP mouse events are
  // viewport coordinates.
  await evaluate(`(() => {
    const svg = [...document.querySelectorAll('svg')].find(n => /board/.test(n.getAttribute('aria-label') || ''))
    if (svg) svg.scrollIntoView({ block: 'center', inline: 'center' })
    return Boolean(svg)
  })()`)
  await sleep(150)
  const point = await evaluate(`window.__of.square(${JSON.stringify(name)})`)
  if (!point) throw new Error('no board on the screen')
  return point
}
const playChess = async (from, to) => {
  const movesBefore = await evaluate(`fetch('/api/board?game=chessboard').then(r => r.json()).then(d => (d.picture.moves || []).length)`)
  const pointFrom = await square(from)
  await pressAt(pointFrom)
  await sleep(180)
  const pointTo = await square(to)
  await pressAt(pointTo)
  await sleep(700)
  for (let waited = 0; waited < 6000; waited += 300) {
    const now = await evaluate(`fetch('/api/board?game=chessboard').then(r => r.json()).then(d => (d.picture.moves || []).length)`)
    if (now > movesBefore) return
    await sleep(100)
  }
  const diag = await evaluate(`(() => {
    const svg = [...document.querySelectorAll('svg')].find(n => /board/.test(n.getAttribute('aria-label') || ''))
    const at = document.elementFromPoint(${pointTo[0]}, ${pointTo[1]})
    const notices = [...document.querySelectorAll('.games-notice, [role=status], [role=alert]')].map(n => n.textContent.trim()).filter(Boolean)
    return {
      svg: svg && svg.getAttribute('aria-label'),
      fromPoint: ${JSON.stringify(pointFrom)}, toPoint: ${JSON.stringify(pointTo)},
      onTop: at && (at.tagName + '.' + (at.getAttribute('class') || '') + '|' + (svg && svg.contains(at))),
      qaCalls: ((window.qa && window.qa.calls) || []).slice(-6),
      notices,
      text: document.querySelector('.games-play-table') ? document.querySelector('.games-play-table').innerText.slice(0, 300) : document.body.innerText.slice(0, 200)
    }
  })()`)
  throw new Error(`chess click ${from}-${to} registered no move: ${JSON.stringify(diag)}`)
}

const gameText = () => evaluate(`(() => {
  const table = document.querySelector('.games-play-table')
  if (!table) return ''
  const copy = table.cloneNode(true)
  copy.querySelectorAll('pre').forEach(node => node.remove())
  return copy.innerText
})()`)

// A table that finished was only "closed", never abandoned — opening the game
// again resumes it and the start screen never shows. Make sure we reach the
// start screen from wherever we are (store, live table, or finished table).
const chessStatus = async () => {
  try {
    const data = await evaluate(`fetch('/api/board?game=chessboard').then(r => r.json()).then(d => d.picture && d.picture.status || 'none')`)
    return String(data)
  } catch { return 'unknown' }
}
const atStart = async () => {
  const ok = await evaluate(`(() => {
    const page = document.querySelector('.games-play-table')
    if (!page) return false
    return [...page.querySelectorAll('button')].some(n => (n.textContent || '').trim() === 'Play the computer' && !n.disabled)
  })()`)
  return Boolean(ok)
}
const freshChessTable = async () => {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const status = await chessStatus()
    if (status === 'active') {
      // Somebody is mid-game here; leaving it returns the page to the start screen.
      await pressUntil('Leave seat', () => atStart(), { wait: 700, limit: 12000 }).catch(() => {})
      if (!await atStart() && await evaluate(`Boolean([...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Keep playing'))`).catch(() => false)) {
        // A table with another person asks once; answer it in the table's own words.
        await press('Leave', { wait: 1200 }).catch(() => {})
      }
    } else if (status !== 'idle' && status !== 'none') {
      // A finished table still lives on the server and the header hides Close table
      // once the seat is left, so retry the press until the referee agrees it is gone.
      for (let tryClose = 0; tryClose < 3; tryClose += 1) {
        await press('Close table', { wait: 800, required: false })
        const after = await chessStatus()
        if (after === 'idle' || after === 'none') break
        await sleep(600)
      }
    }
    if (await atStart()) return
    await goto()
    await sleep(600)
    await waitFor(async () => evaluate(`Boolean([...document.querySelectorAll('button[aria-label]')].find(node => node.getAttribute('aria-label') === 'Chess'))`), { what: 'the store before the chess start screen' })
    await press('Chess', { selector: 'button[aria-label]', wait: 1400 })
    if (await atStart()) return
  }
  const where = await evaluate('JSON.stringify({url: location.pathname + location.hash, head: document.body.innerText.slice(0, 200)})').catch(() => '')
  throw new Error(`freshChessTable never reached a start screen with buttons (server status ${await chessStatus()}): ${where}`)
}

const run = async (name, work) => {
  log('===', name)
  const started = Date.now()
  try {
    const evidence = await work()
    results.push({ name, passed: true, ms: Date.now() - started, ...(evidence || {}) })
    log('  passed')
  } catch (error) {
    results.push({ name, passed: false, ms: Date.now() - started, error: error.message })
    log('  FAILED:', error.message)
    await shot(`failed-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`)
    throw error
  }
}

const assert = (condition, message) => { if (!condition) throw new Error(message) }

try {
  await goto()
  await evaluate('localStorage.clear()').catch(() => {})
  await goto()
  await dismissWelcome()
  await goto()

  // -------------------------------------------------------------------------
  // Warm-up, untimed: on a cold server the first built-in bot move costs more
  // than any check's patience (engine import, first search). Pay it once here
  // so every timed check below sees a warm engine.
  await press('Chess', { selector: 'button[aria-label]', wait: 1400 })
  await waitForText(/Choose how to play/, { what: 'the chess start screen (warm-up)' })
  await press('Play the computer', { wait: 1000 })
  await waitForText(/Your turn/, { what: 'the first cold computer move', limit: 40000 })
  await press('Leave seat', { wait: 1400 })
  await waitForText(/Choose how to play/, { what: 'the game start screen after warm-up' })
  await press('Back', { wait: 900 })
  await waitFor(async () => evaluate(`Boolean([...document.querySelectorAll('button[aria-label]')].find(node => node.getAttribute('aria-label') === 'Chess'))`), { what: 'the store after warm-up' })

  // -------------------------------------------------------------------------
  await run('advanced open: Back, Resign and Leave seat are clickable', async () => {
    await press('Chess', { selector: 'button[aria-label]', wait: 1400, required: false })
    await freshChessTable()
    await pressUntil('Play the computer', async () => /Your turn/.test(await text()), { wait: 1600, attempts: 3, limit: 30000 })
    const started = await waitForText(/Your turn/, { what: 'the chess board' })
    const calls = await evaluate('(window.qa && window.qa.calls) || []').catch(() => [])
    assert(started, 'the computer game did not start')
    await shot('01-chess-in-play')
    // The bug: opening More options pushed the board over the header.
    await press('More options', { wait: 500 })
    const header = await evaluate(`(() => {
      const bar = [...document.querySelectorAll('.games-play-table > div')][0]
      const hero = document.querySelector('.games-board-hero')
      if (!bar || !hero) return null
      const a = bar.getBoundingClientRect()
      const b = hero.getBoundingClientRect()
      const back = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Back')
      const c = back.getBoundingClientRect()
      return { barBottom: Math.round(a.bottom), heroTop: Math.round(b.top), backBottom: Math.round(c.bottom), backTop: Math.round(c.top) }
    })()`)
    assert(header && header.heroTop >= header.backBottom - 1, `the board starts above the Back button: ${JSON.stringify(header)}`)
    for (const label of ['Back', 'Resign', 'Leave seat']) await hitTest(label)
    await shot('02-advanced-open-header-clear')
    await note('02-advanced-open-header-clear', JSON.stringify({ header, hits }, null, 2))
    // Resign still opens its own question, pressed with the mouse.
    await press('Resign', { wait: 400 })
    const asked = await text()
    assert(/Resigning ends this match/.test(asked), 'Resign did not open its question')
    await shot('03-resign-question-reachable')
    await press('Cancel', { wait: 300 })
    assert(!/Resigning ends this match/.test(await text()), 'Cancel did not close the question')
    return { header }
  })

  // -------------------------------------------------------------------------
  await run('result card: checkmate on the board, ringed king, no turn dot', async () => {
    // Pass and play, so the ending is the same every run: Fool's mate in four moves.
    await press('Leave seat', { wait: 1400 })
    await freshChessTable()
    await pressUntil('Same screen (pass and play)', () => waitForText(/Your turn/, { what: 'the shared board' }), { wait: 1400, attempts: 3, limit: 30000 })
    await board()
    for (const [from, to] of [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]) {
      await playChess(from, to)
    }
    const title = await waitFor(async () => {
      const said = await evaluate(`(() => { const node = document.querySelector('.games-result-title'); return node ? node.textContent.trim() : '' })()`)
      return said || null
    }, { what: 'the result card' })
    const shown = await gameText()
    assert(/Checkmate!/.test(shown), 'no checkmate on the screen: ' + shown.slice(0, 240))
    assert(/^Checkmate!/.test(title), 'the result card does not lead with Checkmate!: ' + title)
    assert(/Black wins/.test(title), 'the result card does not name the winner: ' + title)
    assert(await evaluate(`Boolean(document.querySelector('.games-board-hero .games-result'))`), 'the result card is not ON the board')
    assert(await evaluate(`document.querySelectorAll('.games-decider').length > 0`), 'the mated king is not ringed')
    assert(await evaluate(`!document.querySelector('.games-turn-dot')`), 'the turn dot is still there after the game ended')
    const buttons = await evaluate(`[...document.querySelectorAll('.games-result button')].map(node => node.textContent.trim())`)
    for (const label of ['Rematch', 'New game', 'Back to games']) {
      assert(buttons.some(item => item === label || item.startsWith(label)), `the result card has no ${label}: ${JSON.stringify(buttons)}`)
    }
    await shot('04-checkmate-result-card')
    await note('04-checkmate-result-card', JSON.stringify({ title, buttons }, null, 2))
    // The card is not dismissed by itself: it is still there a few seconds later.
    await sleep(2500)
    assert(await evaluate(`Boolean(document.querySelector('.games-result'))`), 'the result card went away by itself')
    // Every control on the card answers the mouse.
    for (const label of buttons) await hitTest(label)
    // Look at the board puts the card away by hand and leaves the result on the page.
    await press('Look at the board', { wait: 400 })
    assert(await evaluate(`!document.querySelector('.games-result')`), 'the card did not go away when asked')
    assert(await evaluate(`Boolean(document.querySelector('.games-result-bar'))`), 'the result left the page with the card')
    await shot('05-result-put-away-by-hand')
    await press('Show result', { wait: 400 })
    assert(await evaluate(`Boolean(document.querySelector('.games-result'))`), 'the result did not come back')
    return { title, buttons }
  })

  // -------------------------------------------------------------------------
  await run('result card: draw by repetition', async () => {
    // Pass and play again, so the knight dance is scripted by the harness and not
    // by an uncooperative engine: against the computer the scripted black moves
    // never reach the table and no repetition is ever recorded.
    await press('Back to games', { wait: 1200, required: false })
    await freshChessTable()
    await pressUntil('Same screen (pass and play)', () => waitForText(/Your turn/, { what: 'the fresh shared board' }), { wait: 1400, attempts: 3, limit: 30000 })
    await board()
    // Record what the page itself sends while the dance plays out, so a failure
    // says whether the clicks reached the table at all.
    await evaluate(`(() => {
      window.__flog2 = []
      if (!window.__ofHooked) {
        window.__ofHooked = true
        const orig = window.fetch
        window.fetch = async (u, o) => {
          const entry = { u: String(u), m: (o && o.method) || 'GET', body: o && o.body ? String(o.body).slice(0, 90) : null, state: 'start' }
          window.__flog2.push(entry)
          try { const r = await orig(u, o); entry.state = 'done:' + r.status; return r }
          catch (e) { entry.state = 'ERR:' + String(e); throw e }
        }
      }
      return true
    })()`)
    // Out and back twice repeats the position three times.
    for (const [from, to] of [['g1', 'f3'], ['g8', 'f6'], ['f3', 'g1'], ['f6', 'g8'],
      ['g1', 'f3'], ['g8', 'f6'], ['f3', 'g1'], ['f6', 'g8']]) {
      await playChess(from, to)
    }
    const readTitle = () => evaluate(`(() => { const node = document.querySelector('.games-result-title'); return node ? node.textContent.trim() : '' })()`)
    let title = await readTitle()
    if (!/Draw by repetition/.test(title)) {
      // The page polls; give the picture one more beat before calling it a miss.
      for (let waited = 0; waited < 6000 && !/Draw by repetition/.test(title); waited += 400) {
        await sleep(400)
        title = await readTitle()
      }
    }
    if (!/Draw by repetition/.test(title)) {
      const diag = await evaluate(`JSON.stringify({
        server: null,
        flog: (window.__flog2 || []).slice(-14),
        qa: ((window.qa && window.qa.calls) || []).slice(-6),
        caption: (() => { const n = document.querySelector('.games-board-hero'); return n && n.parentElement ? n.parentElement.innerText.split('\\n').slice(0, 10).join('|') : '' })(),
        alerts: [...document.querySelectorAll('[role=alert]')].map(n => n.textContent.trim()).slice(0, 3),
        resultBar: (() => { const n = document.querySelector('.games-result-bar'); return n ? n.innerText.slice(0, 120) : null })()
      })`)
      throw new Error(`no draw by repetition on the board: ${JSON.stringify(title)} diag=${diag}`)
    }
    await shot('06-draw-by-repetition')
    await note('06-draw-by-repetition', title)
    // The finished shared table closes in one press (nothing to confirm once the
    // game is over — the button reads Close table, not Leave seat) and returns
    // to the store, so the next proof opens on a fresh game page.
    await press('Close table', { wait: 1400 })
    await press('Back', { wait: 900, required: false })
    return { title }
  })

  // -------------------------------------------------------------------------
  await run('check: a chess king in check is said out loud', async () => {
    await freshChessTable()
    await pressUntil('Same screen (pass and play)', () => board(), { wait: 1400, attempts: 3, limit: 30000 })
    // 1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6?? 4. Qxf7# — first a plain check: 2... Qh4+ needs
    // a position; the shortest is 1. f3 e5 2. g4 Qh4#. Instead ask for a check with
    // 1. e4 f5 2. Qh5+ (the queen checks the king through the f-pawn).
    for (const [from, to] of [['e2', 'e4'], ['f7', 'f5'], ['d1', 'h5']]) {
      await playChess(from, to)
    }
    const shown = await gameText()
    assert(/Check!/.test(shown), 'the check is not visible: ' + shown.slice(0, 240))
    assert(await evaluate(`Boolean(document.querySelector('.games-check'))`), 'no Check! badge')
    await shot('07-check-badge')
    await note('07-check-badge', shown.slice(0, 400))
    return { sawCheck: true }
  })

  // -------------------------------------------------------------------------
  await run('leave seat: one press against the computer', async () => {
    // Start a game against the built-in player, then leave it with the mouse.
    await press('Leave seat', { wait: 1400 })   // the shared-keyboard game from the check
    assert(/Choose how to play/.test(await text()), 'the shared game did not close in one press')
    await pressUntil('Play the computer', async () => /Your turn/.test(await text()), { wait: 1600, attempts: 3, limit: 30000 })
    assert(/Your turn/.test(await text()), 'the computer game did not start')
    await press('Leave seat', { wait: 1500 })
    assert(!/Leave this game\? It counts as a resignation/.test(await text()), 'the computer table asked a question')
    assert(/Choose how to play/.test(await text()), 'leaving did not bring the game start screen back')
    const status = await evaluate(`fetch('/api/board?game=chessboard').then(r => r.json()).then(x => x.picture && x.picture.status)`)
    assert(status === 'idle', 'the table was not closed: ' + status)
    await shot('08-leave-seat-against-computer')
    return { status }
  })

  // -------------------------------------------------------------------------
  await run('leave seat: one question with people, then the start screen', async () => {
    // Another person starts a chess table here and takes white; the page sits black.
    const seated = await (await fetch(`http://127.0.0.1:${PORT}/qa/second-seat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game: 'chessboard', name: 'Bea' })
    })).json()
    assert(/Bea/.test(seated.text || ''), 'the second person could not start a table: ' + (seated.text || '').slice(0, 200))
    await sleep(3600)                       // one poll of the page
    await press('More options', { wait: 400 })
    await press('Sit as Black', { wait: 1500 })
    const moved = await (await fetch(`http://127.0.0.1:${PORT}/qa/other-move`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game: 'chessboard', move: 'e2e4' })
    })).json()
    assert(/Played/.test(moved.text || ''), 'the other person could not move: ' + (moved.text || '').slice(0, 200))
    await sleep(3600)
    await press('Leave seat', { wait: 400 })
    const asked = await text()
    assert(/Leave this game\? It counts as a resignation/.test(asked), 'the question is not in the owner\'s words: ' + asked.slice(-300))
    assert(await evaluate(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'Leave')`), 'no Leave button')
    assert(await evaluate(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'Keep playing')`), 'no Keep playing button')
    await shot('09-leave-seat-question')
    await press('Keep playing', { wait: 400 })
    assert(!/Leave this game\?/.test(await text()), 'Keep playing did not close the question')
    await press('Leave seat', { wait: 400 })
    await press('Leave', { wait: 1800 })
    const after = await text()
    assert(/You left the table/.test(after), 'leaving did not return to the start screen: ' + after.slice(0, 300))
    assert(/Choose how to play/.test(after), 'no start screen after leaving with people')
    const status = await evaluate(`fetch('/api/board?game=chessboard').then(r => r.json()).then(x => x.picture && x.picture.status)`)
    assert(status === 'resigned', 'the game was not resigned: ' + status)
    await shot('10-left-seat-start-screen')
    return { status }
  })

  // -------------------------------------------------------------------------
  await run('close table with nothing in play closes immediately', async () => {
    await press('Close table', { wait: 1200 })
    const shelf = await evaluate(`Boolean(document.querySelector('.games-center-shell')) && !document.querySelector('.games-play-table')`)
    assert(shelf, 'Close table did not go back to the shelf')
    await shot('11-close-table-back-to-shelf')
    return { shelf }
  })

  // -------------------------------------------------------------------------
  await run('games that cannot be drawn never mention a draw', async () => {
    const seen = {}
    for (const [title, slug] of [['Hex', 'hex'], ['Go', 'go'], ['Breakthrough', 'breakthrough']]) {
      await press(title, { selector: 'button[aria-label]', wait: 1300 })
      await press('Play the computer', { wait: 1600 })
      await press('More options', { wait: 400 })
      const shown = await gameText()
      assert(!/draw/i.test(shown), `${title} still mentions a draw: ` + shown.match(/.{0,60}draw.{0,60}/i)?.[0])
      assert(await evaluate(`!document.querySelector('.games-table-leave') || [...document.querySelectorAll('.games-table-leave button')].every(node => !/draw/i.test(node.textContent))`), `${title} still has a draw button`)
      seen[slug] = true
      await shot(`12-${slug}-no-draw`)
      await note(`12-${slug}-no-draw`, shown.slice(0, 600))
      await press('Leave seat', { wait: 1400 })
      await press('Close table', { wait: 1200 })
    }
    // Connect Four can be drawn, so it still offers one (with a human opponent).
    await press('Connect Four', { selector: 'button[aria-label]', wait: 1300 })
    await press('Same screen (pass and play)', { wait: 1500 })
    const shown = await gameText()
    assert(/Offer draw/.test(shown), 'Connect Four lost its draw: ' + shown.slice(0, 300))
    await shot('13-connect4-still-offers-a-draw')
    await press('Leave seat', { wait: 400 })
    await press('Leave', { wait: 1500 })
    await press('Close table', { wait: 1200 })
    return seen
  })

  // -------------------------------------------------------------------------
  await run('no drop-down on the way to a game', async () => {
    await press('Gomoku', { selector: 'button[aria-label]', wait: 1300 })
    const before = await evaluate(`document.querySelectorAll('.games-play-table select').length`)
    assert(before === 0, 'the table has a drop-down before More options is opened')
    await shot('14-table-without-drop-downs')
    await press('More options', { wait: 400 })
    const legacy = await evaluate(`[...document.querySelectorAll('.games-play-table select')].map(node => node.getAttribute('aria-label'))`)
    assert(JSON.stringify(legacy) === JSON.stringify(['Legal move']), 'the only drop-down left should be the keyboard move list: ' + JSON.stringify(legacy))
    // The pane: its game picker is tiles, pressed with the mouse.
    await press('Close table', { wait: 1200 })
    await cdp('Page.navigate', { url: `${URL_BASE}pane` })
    await sleep(3500)
    const paneSelects = await evaluate(`document.querySelectorAll('#pane select').length`)
    assert(paneSelects === 0, 'the pane still has a drop-down')
    const tile = await spotOf('Chess', '#pane button')
    assert(tile && tile.hit, 'the pane\'s Chess tile cannot be hit: ' + JSON.stringify(tile))
    hits.push({ label: 'pane Chess tile', x: Math.round(tile.x), y: Math.round(tile.y), hit: true })
    await pressAt([tile.x, tile.y])
    await sleep(1800)
    const pressed = await evaluate(`(() => { const node = [...document.querySelectorAll('#pane [aria-label="Game"] button')].find(b => b.getAttribute('aria-pressed') === 'true'); return node ? node.textContent.trim() : '' })()`)
    assert(pressed === 'Chess', 'pressing the Chess tile did not pick chess: ' + pressed)
    const boardLabel = await evaluate(`(() => { const svg = document.querySelector('#pane svg[aria-label]'); return svg ? svg.getAttribute('aria-label') : '' })()`)
    assert(/chess/.test(boardLabel), 'the pane is not drawing a chess board: ' + boardLabel)
    await shot('15-pane-games-as-tiles')
    return { paneSelects, pressed }
  })

  // ---- the evidence file ---------------------------------------------------
  fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify({ url: URL_BASE, hits, results }, null, 2))
  log('\nALL PASSED', results.length, 'checks;', hits.length, 'real hit-tests')
  for (const row of results) log(` ${row.passed ? 'ok  ' : 'FAIL'} ${row.name}`)
} catch (error) {
  log('\nFAILED:', error.message)
  fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify({ url: URL_BASE, hits, results, error: error.message }, null, 2))
  process.exitCode = 1
} finally {
  try { chrome.kill() } catch { /* already gone */ }
  if (server) { try { server.kill() } catch { /* already gone */ } }
  await sleep(300)
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* chrome still holding it */ }
}
