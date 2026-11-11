// Drive the real Game Center page with a real headless Chrome over CDP.
//
// Everything a person does here is done the way a person does it: the mouse moves, presses,
// drags and releases on the drawn board, and buttons are clicked by their visible words.
// No command API, no typing into a move box, no seeded boards.
//
//   node tools/browser_drive.mjs --url http://127.0.0.1:18798/ --out test-artifacts/ux --game chess
//   node tools/browser_drive.mjs --url ... --out ... --tour            # every table game
//
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const URL_BASE = arg('url', process.env.GAMESHELF_QA_URL || 'http://127.0.0.1:18798/')
const OUT = path.resolve(arg('out', 'test-artifacts/ux'))
const GAME = arg('game', '')
const LEVEL = arg('level', '')
const LESSON = args.includes('--lesson')
const TOUR = args.includes('--tour')
const IA = args.includes('--ia')
const SHELVES = args.includes('--shelves')
const PANE = args.includes('--pane')
// A talking table has no board to drag: it is opened by its card and played by clicks.
const TALK = arg('talk', '')
const TALK_ALL = args.includes('--talk-all')
const WATCH = args.includes('--watch')
const FRIEND = args.includes('--friend')
const FIRST_RUN = args.includes('--first-run')
const SCREENS = args.includes('--screens')
const SWITCH = args.includes('--switch')
const DEBUG = args.includes('--debug')
const SEED = Number(arg('seed', '7'))
// A port of its own: a stale Chrome from an earlier run must never be mistaken for this one.
let PORT = Number(arg('port', String(9400 + (process.pid % 500))))
const freePort = async () => {
  for (let candidate = PORT; candidate < PORT + 40; candidate += 1) {
    try {
      await fetch(`http://127.0.0.1:${candidate}/json`, { signal: AbortSignal.timeout(300) })
    } catch {
      return candidate
    }
  }
  return PORT
}
PORT = await freePort()
fs.mkdirSync(OUT, { recursive: true })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-drive-'))
const stopChrome = () => { try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); else chrome.kill('SIGKILL') } catch {} }
process.on('exit', () => { stopChrome(); try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch {} }); for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => process.exit(130)) // delete the ~200 MB Chrome profile when the run ends
const chrome = spawn(process.env.CHROME_BIN || 'google-chrome', [
  '--headless=new', '--mute-audio', '--no-sandbox', '--disable-gpu',
  '--window-size=1400,950', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' })

let tabs = []
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    if (tabs.some(tab => tab.type === 'page')) break
  } catch { /* not up yet */ }
  await sleep(500)
}
const page = tabs.find(tab => tab.type === 'page')
if (!page) {
  console.error('chrome did not open a page')
  stopChrome()
  process.exit(1)
}
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(resolve => { socket.onopen = resolve })
let counter = 0
const waiting = new Map()
socket.onmessage = message => {
  const data = JSON.parse(message.data)
  if (data.id && waiting.has(data.id)) {
    waiting.get(data.id)(data.result || data.error)
    waiting.delete(data.id)
  }
}
// Every CDP call gives up after 20 s instead of hanging the whole tour when Chrome stops answering.
const cdp = (method, params = {}) => new Promise(resolve => {
  const id = ++counter
  const timer = setTimeout(() => {
    if (waiting.delete(id)) resolve({ __timeout: true, method })
  }, 20000)
  waiting.set(id, answer => { clearTimeout(timer); resolve(answer) })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const answer = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (answer && answer.exceptionDetails) return { error: answer.exceptionDetails.text }
  return answer && answer.result ? answer.result.value : undefined
}

const shots = []
const shot = async name => {
  // A link handed to the system browser opens a tab of its own, and Chrome then treats this page
  // as hidden and refuses a capture. Bring the page we are driving back to the front first.
  await cdp('Page.bringToFront')
  const taken = await cdp('Page.captureScreenshot', { format: 'png' })
  if (!taken || !taken.data) { console.log('shot skipped (browser quiet)', name); return }
  const file = path.join(OUT, `${name}.png`)
  fs.writeFileSync(file, Buffer.from(taken.data, 'base64'))
  shots.push(`${name}.png`)
  console.log('shot', name)
}

// A real pointer: press, a few moves, release. Used for both taps and drags.
const pointer = async (from, to = from) => {
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

// The parts of a gesture, so a drag can look at the board while the piece is still held.
const pressAt = async point => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point[0], y: point[1] })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: point[0], y: point[1], button: 'left', buttons: 1, clickCount: 1 })
}
const dragTo = async (point, from) => {
  const start = Array.isArray(from) ? from : point
  for (let step = 1; step <= 5; step += 1) {
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: start[0] + (point[0] - start[0]) * step / 5,
      y: start[1] + (point[1] - start[1]) * step / 5,
      button: 'left', buttons: 1
    })
    await sleep(18)
  }
}
const releaseAt = async point => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point[0], y: point[1], button: 'left', buttons: 0, clickCount: 1 })
}
// Leave the pointer over a square without pressing it: the hover preview, nothing played.
const hoverAt = async point => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point[0], y: point[1] })
  await sleep(200)
}

const clickText = async (text, { exact = false } = {}) => {
  const spot = await evaluate(`(() => {
    const wanted = ${JSON.stringify(text)}
    const found = [...document.querySelectorAll('button,a,[role=button],summary')].find(node => {
      const said = node.textContent.trim()
      return ${exact ? 'said === wanted' : 'said.includes(wanted)'} && !node.disabled
    })
    if (!found) return null
    found.scrollIntoView({ block: 'center' })
    const box = found.getBoundingClientRect()
    return [box.x + box.width / 2, box.y + box.height / 2]
  })()`)
  if (!spot) return false
  await pointer(spot)
  await sleep(350)
  return true
}

// Board geometry straight from the drawing, so the driver never guesses a game's layout.
const installHelpers = () => evaluate(`(() => {
  window.__bd = {
    board() {
      return [...document.querySelectorAll('svg')].find(svg => /board/.test(svg.getAttribute('aria-label') || '')) || null
    },
    screen(svg, x, y) {
      const matrix = svg.getScreenCTM()
      const point = svg.createSVGPoint()
      point.x = x; point.y = y
      const out = point.matrixTransform(matrix)
      return [out.x, out.y]
    },
    num(node, name) { return Number(node.getAttribute(name) || 0) },
    cells() {
      const svg = window.__bd.board()
      if (!svg) return []
      const view = svg.viewBox.baseVal
      const squares = [...svg.querySelectorAll(':scope > rect')]
        .filter(node => {
          const w = window.__bd.num(node, 'width')
          const h = window.__bd.num(node, 'height')
          return Math.abs(w - h) < 0.01 && w > 8 && w < view.width - 1
        })
      if (!squares.length) return []
      const cell = window.__bd.num(squares[0], 'width')
      const xs = [...new Set(squares.map(node => window.__bd.num(node, 'x')))].sort((a, b) => a - b)
      const ys = [...new Set(squares.map(node => window.__bd.num(node, 'y')))].sort((a, b) => a - b)
      const out = []
      ys.forEach((y, row) => xs.forEach((x, col) => {
        out.push({ row, col, x, y, cell, point: window.__bd.screen(svg, x + cell / 2, y + cell / 2) })
      }))
      return out
    },
    rings() {
      const svg = window.__bd.board()
      if (!svg) return []
      return [...svg.querySelectorAll('circle')]
        .filter(node => (node.getAttribute('stroke') || '') === '#7ec8ff' && node.getAttribute('fill') === 'none')
        .map(node => ({ r: window.__bd.num(node, 'r'), point: window.__bd.screen(svg, window.__bd.num(node, 'cx'), window.__bd.num(node, 'cy')) }))
    },
    // The pieces themselves: a nested svg per chess piece, a filled disc per checker.
    // Dragging has to start on one of these, not on a target marker.
    pieces() {
      const svg = window.__bd.board()
      if (!svg) return []
      const out = []
      ;[...svg.querySelectorAll(':scope > svg')].forEach(node => {
        const w = window.__bd.num(node, 'width')
        if (w < 8) return
        out.push({ point: window.__bd.screen(svg, window.__bd.num(node, 'x') + w / 2, window.__bd.num(node, 'y') + w / 2) })
      })
      ;[...svg.querySelectorAll(':scope > circle')].forEach(node => {
        const fill = node.getAttribute('fill') || ''
        const r = window.__bd.num(node, 'r')
        if (r < 8 || !['#f0d0b0', '#7a2018'].includes(fill)) return
        out.push({ point: window.__bd.screen(svg, window.__bd.num(node, 'cx'), window.__bd.num(node, 'cy')) })
      })
      return out
    },
    dots() {
      const svg = window.__bd.board()
      if (!svg) return []
      return [...svg.querySelectorAll('circle')]
        .filter(node => (node.getAttribute('fill') || '') === '#7ec8ff' && window.__bd.num(node, 'r') <= 7)
        .map(node => ({ point: window.__bd.screen(svg, window.__bd.num(node, 'cx'), window.__bd.num(node, 'cy')) }))
    },
    columnTargets() {
      const svg = window.__bd.board()
      if (!svg) return []
      const circles = [...svg.querySelectorAll('circle')].filter(node => window.__bd.num(node, 'r') === 14 && (node.getAttribute('stroke') || '') === '#7ec8ff')
      const seen = new Set()
      const out = []
      circles.forEach(node => {
        const cx = window.__bd.num(node, 'cx')
        if (seen.has(cx)) return
        seen.add(cx)
        out.push(window.__bd.screen(svg, cx, window.__bd.num(node, 'cy')))
      })
      return out
    },
    pitTargets() {
      const svg = window.__bd.board()
      if (!svg) return []
      return [...svg.querySelectorAll('ellipse')]
        .filter(node => (node.getAttribute('stroke') || '') === '#e0b36a')
        .map(node => window.__bd.screen(svg, window.__bd.num(node, 'cx'), window.__bd.num(node, 'cy')))
    },
    hexes() {
      const svg = window.__bd.board()
      if (!svg) return []
      return [...svg.querySelectorAll(':scope > polygon')].map(node => {
        const pairs = (node.getAttribute('points') || '').split(' ').map(part => part.split(',').map(Number))
        const cx = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length
        const cy = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length
        return { point: window.__bd.screen(svg, cx, cy) }
      })
    },
    state() {
      const svg = window.__bd.board()
      if (!svg) return ''
      // A cheap whole-board fingerprint: a move anywhere changes it, so a press can be told
      // from a hover without waiting for the status line to leave "Your turn".
      //
      // The highlight marks are left out on purpose. Pressing a piece lights its targets
      // (dots, capture rings, column rings) and a refused drop only clears them again — with
      // them in the fingerprint a rejected press looked exactly like a played move.
      const copy = svg.cloneNode(true)
      for (const node of [...copy.querySelectorAll('circle, ellipse')]) {
        const fill = node.getAttribute('fill') || ''
        const stroke = node.getAttribute('stroke') || ''
        if (fill === '#7ec8ff' || stroke === '#7ec8ff' || stroke === '#e0b36a') node.remove()
      }
      const text = copy.innerHTML
      let hash = 0
      for (let index = 0; index < text.length; index += 7) hash = (hash * 31 + text.charCodeAt(index)) | 0
      return text.length + ':' + hash + ':' + text.slice(0, 120)
    },
    status() {
      const node = document.querySelector('.games-status')
      return node ? node.textContent.trim() : ''
    },
    over() {
      try {
        return Boolean([...document.querySelectorAll('section')].find(node => node.getAttribute('aria-label') === 'Game over'))
      } catch { return false }
    }
  }
  return Boolean(window.__bd.board())
})()`)

let seed = SEED
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
const shuffled = list => {
  const copy = list.slice()
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    const swap = copy[i]
    copy[i] = copy[j]
    copy[j] = swap
  }
  return copy
}

// Rest the pointer on a square the board marks as legal, so the hover preview is on screen when
// the mid-game shot is taken. Nothing is pressed.
const hoverLegal = async () => {
  const listOf = async name => (await evaluate(`window.__bd.${name}()`)) || []
  const dots = await listOf('dots')
  if (dots.length) return hoverAt(dots[0].point)
  const columns = await listOf('columnTargets')
  if (columns.length) return hoverAt(columns[Math.floor(columns.length / 2)])
  const pits = await listOf('pitTargets')
  if (pits.length) return hoverAt(pits[0])
  const hexes = await listOf('hexes')
  if (hexes.length) return hoverAt(hexes[0].point)
  return null
}

// How the last move was made, so a proof can say a piece was really dragged rather than
// pressed. Set by playOne below.
let lastGesture = ''

// One move, made the way the game asks for it: drag a piece, or press an empty square, or
// press a column, or press a pit. True when the board visibly changed.
const playOne = async ({ drag = true } = {}) => {
  await installHelpers()
  const before = await evaluate('window.__bd.state()')
  const rings = await evaluate('window.__bd.rings()') || []
  const dots = await evaluate('window.__bd.dots()') || []
  const columns = await evaluate('window.__bd.columnTargets()') || []
  const pits = await evaluate('window.__bd.pitTargets()') || []
  const hexes = await evaluate('window.__bd.hexes()') || []
  const cells = await evaluate('window.__bd.cells()') || []

  // A move counts only when the game accepts it: the board itself changes (or the game ends).
  // Watching the status line is too slow and too racy — a bot that answers at once puts it back
  // to "Your turn" before the poll sees anything, which cost ~2.4 s on every single press.
  const settled = async (base = before) => {
    // A press that lands is drawn well inside half a second; waiting longer only makes a wrong
    // guess expensive, and on a grid most guesses are wrong.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (await evaluate('window.__bd.over()')) return true
      const now = await evaluate('window.__bd.state()')
      if (now && now !== base) return true
      const status = await evaluate('window.__bd.status()')
      if (status && !/Your turn/.test(status)) return true
      await sleep(100)
    }
    return false
  }
  const pieces = await evaluate('window.__bd.pieces()') || []
  if (DEBUG) console.log('  turn:', 'pieces', pieces.length, 'rings', rings.length, 'dots', dots.length, 'columns', columns.length, 'pits', pits.length, 'hexes', hexes.length, 'cells', cells.length, 'status', await evaluate('window.__bd.status()'))

  const tryEach = async (list, act) => {
    // A person tries a few spots, not all eighty-one. Twenty keeps a turn short on a big board
    // while still being able to find the handful of legal squares among a grid of empty ones.
    for (const item of shuffled(list).slice(0, 20)) {
      // Columns and pits come back as plain [x, y] points; pieces and hexes carry a .point.
      await hoverAt(item.point || item)
      // The baseline is taken after the hover: a hover highlight changes the drawing, and only
      // what the press itself changes may count as a move.
      const base = await evaluate('window.__bd.state()')
      await act(item)
      if (await settled(base)) return true
    }
    return false
  }

  if (pits.length && await tryEach(pits, point => { lastGesture = 'pit-press'; return pointer(point) })) return true
  if (columns.length && await tryEach(columns, point => { lastGesture = 'column-press'; return pointer(point) })) return true
  // A piece game (chess, checkers, breakthrough): press a piece, and while it is held look at
  // what the board itself lit up, then drop it on one of those squares. The board only marks
  // squares the move can land on, so the driver never guesses a target.
  const near = (a, b) => Math.abs(a.point[0] - b.point[0]) < 2 && Math.abs(a.point[1] - b.point[1]) < 2
  if (pieces.length || rings.some(ring => ring.r > 8)) {
    // Shuffle before slicing: the first sixteen pieces in drawing order are all one colour,
    // and the person may be playing the other one. In check the only piece that can move is
    // the king, so the sweep has to be able to reach every piece.
    const sources = shuffled(pieces.length ? pieces : rings.filter(ring => ring.r > 8)).slice(0, 30)
    for (const source of sources) {
      if (drag) {
        await pressAt(source.point)
        await sleep(150)
      } else {
        await pointer(source.point)
        await sleep(200)
      }
      const litDots = await evaluate('window.__bd.dots()') || []
      // Capture squares are rings that were not there before the press (the others are the
      // movable pieces and the marker on the last move).
      const litRings = (await evaluate('window.__bd.rings()') || []).filter(ring => !rings.some(before => near(ring, before)))
      const targets = litDots.concat(litRings).filter(target => !near(target, source))
      if (!targets.length) {
        // Nothing lit up under this piece: put it back and try another one.
        if (drag) await releaseAt(source.point)
        continue
      }
      const target = shuffled(targets)[0]
      // The press has already lit the targets; only the drop itself counts as the move.
      const base = await evaluate('window.__bd.state()')
      if (drag) {
        lastGesture = 'piece-drag'
        await dragTo(target.point, source.point)
        await releaseAt(target.point)
      } else {
        lastGesture = 'piece-press'
        await pointer(target.point)
      }
      if (await settled(base)) return true
      // The drop did not take. Put the piece back and let the next turn read a fresh board
      // instead of guessing a second square in the same gesture.
      if (drag) {
        await pressAt(source.point)
        await sleep(120)
        await releaseAt(source.point)
      }
      return false
    }
  }
  if (hexes.length && await tryEach(hexes, hex => { lastGesture = 'hex-press'; return pointer(hex.point) })) return true
  if (dots.length && await tryEach(dots, dot => { lastGesture = 'dot-press'; return pointer(dot.point) })) return true
  if (cells.length && await tryEach(cells, cell => { lastGesture = 'cell-press'; return pointer(cell.point) })) return true
  return false
}

// A bot answers on its own turn. Do not press the board again until it is the person's turn.
const waitTurn = async (limit = 40) => {
  for (let attempt = 0; attempt < limit; attempt += 1) {
    if (await evaluate('window.__bd.over()')) return 'over'
    const status = await evaluate('window.__bd.status()')
    if (/Your turn/.test(status)) return 'yours'
    if (/wins|draw/i.test(status)) return 'over'
    await sleep(500)
  }
  return 'waiting'
}

const openGame = async title => {
  const clicked = await evaluate(`(() => {
    const node = [...document.querySelectorAll('button')].find(button => button.textContent.includes(${JSON.stringify(title)}))
    if (!node) return false
    node.click()
    return true
  })()`)
  await sleep(900)
  return clicked
}

// The command a person would use to drop an old match. The study-frame's chess id is
// "chessboard", everything else matches its tile slug.
const resetTable = async slug => {
  const id = slug === 'chess' ? 'chessboard' : slug
  return evaluate(`fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ line: ${JSON.stringify(`${id} abandon`)} }) })
    .then(answer => answer.ok).catch(() => false)`)
}

const playGame = async (title, slug) => {
  console.log('=== game', title)
  // The page loads its module from the QA server; wait until it has painted either the
  // first-run welcome or the library, or every button press lands on a loading screen.
  const settle = async (limit = 40) => {
    for (let attempt = 0; attempt < limit; attempt += 1) {
      const ready = await evaluate("document.body.innerText.includes('Welcome to Game Center') || document.body.innerText.includes('Ready to play') || document.body.innerText.includes('Play while you code')")
      if (ready) return true
      await sleep(500)
    }
    return false
  }
  await settle()
  // A fresh Chrome profile lands on the first-run welcome. Skip it the way a person does.
  const skipOnboarding = async () => {
    if (await evaluate("document.body.innerText.includes('Welcome to Game Center')")) {
      const skipped = (await clickText('Skip for now', { exact: true })) || (await clickText('Continue', { exact: true }))
      await sleep(1600)
      return skipped
    }
    return false
  }
  await skipOnboarding()
  // Leave whatever game is open, so every game starts from the library.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const wentBack = await evaluate(`(() => { const node = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Back')); if (node) { node.click(); return true } return false })()`)
    if (!wentBack) break
    await sleep(700)
  }
  // Start from a clean table the way a person would (abandon the old match), through the same
  // command door the screen's buttons use. Without this a match left by an earlier step — a
  // pass-and-play game, a finished series — hides "Choose how to play" and no button resets it.
  await resetTable(slug)
  await sleep(500)
  // The tile's own name, not a substring: "Go" would otherwise open "Gomoku" (it comes first).
  const openTile = () => evaluate(`(() => {
    const wanted = ${JSON.stringify(title)}
    const cards = [...document.querySelectorAll('button')]
    const node = cards.find(b => b.getAttribute('aria-label') === wanted)
      || cards.find(b => b.textContent.trim() === wanted)
      || cards.find(b => { const said = b.textContent.trim(); return said.startsWith(wanted) && !/[A-Za-z]/.test(said.charAt(wanted.length)) })
    if (!node) return false
    node.click()
    return true
  })()`)
  await openTile()
  await sleep(1600)
  // A game that is only in the store installs on the first press and opens on the second.
  if (!(await evaluate(`Boolean(document.querySelector('.games-status')) || document.body.textContent.includes('Choose how to play')`))) {
    await openTile()
    await sleep(1600)
  }
  // The game screen's own heading must be this game, so a substring match can never pass a
  // different game off as this one (Go vs Gomoku).
  const openedTitle = await evaluate(`(() => {
    const table = document.querySelector('.games-play-table')
    if (!table) return ''
    const heading = [...table.querySelectorAll('div')].find(d => d.children.length === 0 && d.textContent.trim() === ${JSON.stringify(title)})
    return heading ? heading.textContent.trim() : ''
  })()`)
  if (openedTitle !== title) console.log('opened', JSON.stringify(openedTitle), 'instead of', JSON.stringify(title))
  // A game left open by an earlier run would hide the start choices. End it and rematch with
  // ordinary buttons: Resign, Confirm resign, Rematch. The library has no detail pane to abandon from.
  const chooseShown = () => evaluate(`document.body.innerText.includes('Choose how to play')`)
  // An open confirmation swallows every press behind it (Rematch asks before replacing a match
  // with a bot at the table), so clear one before pressing anything else.
  const clearDialog = async () => {
    let cleared = false
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const open = await evaluate(`Boolean(document.querySelector('[role=alertdialog]'))`)
      if (!open) break
      cleared = true
      if (!(await clickText('Cancel', { exact: true }))) await evaluate(`(() => { const d = document.querySelector('[role=alertdialog]'); if (d) d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`)
      await sleep(400)
    }
    return cleared
  }
  for (let attempt = 0; attempt < 3 && !(await chooseShown()); attempt += 1) {
    await clearDialog()
    const resigned = await clickText('Resign', { exact: true })
    if (resigned) {
      await sleep(400)
      // The table's own button reads "Confirm resign" (the label is the plain words).
      await clickText('Confirm resign', { exact: true })
      await sleep(1200)
    }
    await clearDialog()
    if (await clickText('Rematch', { exact: true })) {
      await sleep(700)
      // Rematch with a bot seat asks first: press the confirm it offers.
      await clickText('Confirm rematch', { exact: true })
      await sleep(1200)
      continue
    }
    // The tile did not open the game screen yet (a slow first paint, or a store card that
    // installs on the first press). Press it again rather than giving up on the game.
    await openTile()
    await sleep(1600)
  }
  await clearDialog()
  if (!(await chooseShown())) throw new Error('no way back to a fresh game for ' + title)
  await shot(`${slug}-1-start`)
  fs.writeFileSync(path.join(OUT, `${slug}-1-start.txt`), await evaluate('document.body.textContent'))

  if (LESSON) {
    // A lesson is the "how to play" card: a few steps on a real board, then it ends.
    // Starting one can ask to replace an open match; confirm it like a person would.
    const openedAdvanced = await clickText('More options', { exact: true })
    await sleep(400)
    if (!(await clickText('Learn to play', { exact: true }))) throw new Error('no Learn to play' + (openedAdvanced ? '' : ' (More options not opened)'))
    await sleep(1200)
    await clickText('Confirm replace match', { exact: true })
    await sleep(1500)
    await installHelpers()
    await shot(`${slug}-lesson-1`)
    const lessonText = () => evaluate(`(() => { const n = document.querySelector('[aria-label="Lesson"]'); return n ? n.innerText : '' })()`)
    const stepOf = text => { const found = /step (\d+) of (\d+)/i.exec(text || ''); return found ? [Number(found[1]), Number(found[2])] : null }
    let steps = 0
    let done = false
    let seen = ''
    for (let round = 0; round < 60; round += 1) {
      const text = await lessonText()
      if (!text) { await sleep(700); if (round > 6) { done = steps > 0; break } continue }
      const at = stepOf(text)
      if (at && at[0] >= at[1] && steps > 0) { done = true; break }
      if (text !== seen) { seen = text; }
      if (await clickText('Next step', { exact: true })) { steps += 1; await sleep(1000); continue }
      // A lesson accepts only the move it teaches, so try one legal move, then every move
      // the screen's own picker offers, until the step text changes.
      const moved = (await playOne({ drag: true })) || (await playOne({ drag: false }))
      if (moved) { await sleep(900); if (await lessonText() !== text) continue }
      // The screen's legal-move picker is a select; choose each option, then press Play move,
      // until the lesson step changes. This is the only way to find the move it teaches.
      const optionCount = await evaluate(`(() => { const s = document.querySelector('select'); return s ? s.options.length : 0 })()`)
      for (let index = 1; index < optionCount; index += 1) {
        await evaluate(`(() => { const s = document.querySelector('select'); if (!s) return false; const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(s, s.options[${index}].value); s.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
        await sleep(200)
        if (!(await clickText('Play move', { exact: true }))) continue
        await sleep(1400)
        if (await lessonText() !== text) break
      }
    }
    const finalText = await lessonText()
    const at = stepOf(finalText)
    if (at && at[0] >= at[1]) done = true
    await shot(`${slug}-lesson-done`)
    return { game: title, opened: openedTitle, lesson: true, steps, done, lessonText: finalText }
  }

  const levelsOffered = await evaluate(`[...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => /^(Beginner|Intermediate|Advanced|Expert|Easy|Normal|Hard)$/.test(t))`)
  let levelUsed = ''
  if (WATCH) {
    // Watch bots lives inside More options, before any table starts; pressing a level would
    // replace the setup with a live human-vs-computer game and hide it.
    const openedAdvanced = await clickText('More options', { exact: true })
    await sleep(400)
    if (!(await clickText('Watch bots', { exact: true }))) throw new Error('no Watch bots control' + (openedAdvanced ? '' : ' (More options not opened)'))
    levelUsed = 'watch'
  } else {
    const wanted = LEVEL || 'Play the computer'
    // The screen names its levels Easy/Normal/Hard. The gate asks for Beginner/Expert,
    // so map those two ends and record the labels the screen actually offers.
    const alias = { Beginner: 'Easy', Intermediate: 'Normal', Advanced: 'Hard', Expert: 'Hard' }
    const label = levelsOffered.includes(wanted) ? wanted : (alias[wanted] || '')
    if (!label) throw new Error('no level button ' + wanted + ' (offered: ' + (levelsOffered.join('/') || 'none') + ')')
    const started = await clickText(label, { exact: true })
    if (!started) throw new Error('no level button ' + label)
    levelUsed = label
  }
  await sleep(1400)
  await installHelpers()
  await shot(`${slug}-2-playing`)

  const deadline = Date.now() + 240000
  let turns = 0
  let moved = 0
  while (turns < 700 && Date.now() < deadline) {
    if (WATCH) { if (await evaluate('window.__bd.over()')) break; await sleep(500); continue }
    turns += 1
    if (await evaluate('window.__bd.over()')) break
    const turn = await waitTurn(60)
    if (turn === 'over') break
    if (turn !== 'yours') { await sleep(800); continue }
    const ok = await playOne({ drag: true })
    if (ok) moved += 1
    else {
      await sleep(500)
      if (await evaluate('window.__bd.over()')) break
      const again = await playOne({ drag: false })
      if (!again) {
        // Some games ask you to pass when nothing is left to place (Go).
        const passed = await clickText('Pass', { exact: true })
        if (passed) {
          await sleep(700)
          if (await evaluate('window.__bd.over()')) break
          moved += 1
          continue
        }
        // The bot may still have been answering when the board was read. Give it time, try once more.
        const later = await waitTurn(40)
        if (later === 'over') break
        const third = later === 'yours' ? await playOne({ drag: true }) : false
        if (third) moved += 1
        else {
          const state = await evaluate('document.body.textContent')
          fs.writeFileSync(path.join(OUT, `${slug}-stuck.txt`), state)
          console.log('stuck after', moved, 'moves; status:', await evaluate('window.__bd.status()'))
          break
        }
      } else moved += 1
    }
    if (moved === 3) {
      await hoverLegal()
      await sleep(250)
      await shot(`${slug}-3-midgame`)
    }
    if (DEBUG && moved % 10 === 0) console.log('  moves', moved)
  }
  await sleep(700)
  const over = await evaluate('window.__bd.over()')
  await shot(`${slug}-4${over ? '-winner' : '-stopped'}`)
  fs.writeFileSync(path.join(OUT, `${slug}-4-final.txt`), await evaluate('document.body.textContent'))
  // The move box and the move picker live behind More options; open it once to prove they are there.
  const advanced = await clickText('More options', { exact: true })
  let backHit = null
  if (advanced) {
    await sleep(400)
    await shot(`${slug}-7-advanced`)
    // An open More options used to squeeze the board hero while the board kept its height, so the
    // board floated over the header and covered Back: a real press on Back landed on the board
    // and the game looked frozen. Ask the page which element is actually under the pointer.
    backHit = await evaluate(`(() => {
      const back = [...document.querySelectorAll('button')].find(node => node.textContent.trim().startsWith('Back'))
      if (!back) return { found: false, under: '' }
      const box = back.getBoundingClientRect()
      const under = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      const button = under && under.closest ? under.closest('button') : null
      return { found: true, under: button ? button.textContent.trim() : (under ? under.tagName : ''), covered: !button }
    })()`)
    if (backHit && backHit.found && backHit.under !== 'Back to games') {
      const diag = await evaluate(`(() => {
        const back = [...document.querySelectorAll('button')].find(node => node.textContent.trim().startsWith('Back'))
        const box = back ? back.getBoundingClientRect() : null
        return { box: box && { x: box.x, y: box.y, w: box.width, h: box.height }, connected: Boolean(back && back.isConnected),
          backHidden: back ? getComputedStyle(back).display + '/' + getComputedStyle(back).visibility + '/' + getComputedStyle(back).opacity : '',
          scrollY, innerWidth, innerHeight, docHeight: document.documentElement.scrollHeight,
          stack: box ? document.elementsFromPoint(box.x + box.width / 2, box.y + box.height / 2).slice(0, 4).map(e => e.tagName + '.' + String(e.className).slice(0, 40)) : null }
      })()`)
      console.log('BACK IS COVERED for', title, JSON.stringify({ backHit, diag }))
      throw new Error('Back is covered by ' + backHit.under + ' while More options is open for ' + title)
    }
    await evaluate(`(() => { const node = [...document.querySelectorAll('summary')].find(s => s.textContent.trim() === 'More options'); if (node) node.click(); return true })()`)
    await sleep(300)
  }
  if (!over) {
    // Come back to the library even when a game could not be finished, so the next one starts clean.
    await cdp('Page.navigate', { url: URL_BASE })
    await sleep(2500)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await evaluate(`Boolean(document.querySelector('button'))`)) break
      await sleep(500)
    }
    await sleep(600)
  }

  let rematchWorked = false, backWorked = false
  if (over) {
    const rematch = await clickText('Rematch', { exact: true })
    await sleep(700)
    // Rematch puts the same seats back and asks first when a bot is one of them.
    const confirmed = await clickText('Confirm rematch', { exact: true })
    await sleep(1400)
    await shot(`${slug}-5-rematch`)
    rematchWorked = Boolean(rematch && !(await evaluate('window.__bd.over()')))
    if (!rematch) console.log('no rematch button')
    await clearDialog()
    const backPressed = await clickText('Back to games')
    await sleep(900)
    backWorked = Boolean(backPressed && !(await evaluate("Boolean(document.querySelector('.games-play-table'))")))
    await shot(`${slug}-6-back`)
    if (!confirmed) console.log('rematch needed no confirmation for', title)
  }
  return { game: title, opened: openedTitle, moves: moved, over, backHit, rematchWorked, backWorked, watching: WATCH, levelsOffered, levelUsed }
}

await cdp('Page.enable')
await cdp('Runtime.enable')
await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false })
await cdp('Page.navigate', { url: URL_BASE })
const ready = async (limit = 20) => {
  for (let attempt = 0; attempt < limit; attempt += 1) {
    const rendered = await evaluate(`Boolean(document.querySelector('button'))`)
    if (rendered) return true
    await sleep(500)
  }
  return false
}
await sleep(3000)
await ready()
await installHelpers()
// A fresh install opens on the welcome before anything else; a person presses Continue once and
// the library is behind it. Without this a brand-new scratch root gives every mode a "no way back
// to a fresh game" (the library card is still hidden under the welcome).
const dismissWelcome = async () => {
  if (!/Welcome to Game Center/.test(await evaluate('document.body.innerText'))) return false
  const pressed = await clickText('Continue', { exact: true })
  await sleep(900)
  return pressed
}
// The first-run run has its own first screen; a library shot before it would be a blank tab.
if (!FIRST_RUN) {
  await dismissWelcome()
  await shot('library')
}

// Doctrine and Arena get the same treatment: their own screen, a plain main view, and the
// seed and card pickers behind More options. This visit proves the screen opens and a battle runs.
const visitScreen = async (title, slug, actionText) => {
  console.log('=== screen', title)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const wentBack = await evaluate(`(() => { const node = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Back')); if (node) { node.click(); return true } return false })()`)
    if (!wentBack) break
    await sleep(700)
  }
  const opened = await evaluate(`(() => {
    // A Play card is a button named after its game; a card in Your games puts the name on the
    // title attribute of its Open button. Both are the person's own press.
    const named = (b, wanted) => b.getAttribute('aria-label') === wanted || (b.getAttribute('title') || '') === wanted
    const node = [...document.querySelectorAll('button')].find(b => named(b, ${JSON.stringify(title)}))
      || [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(title)}))
    if (!node) return false
    node.click()
    return true
  })()`)
  await sleep(1600)
  if (!opened) throw new Error('no tile for ' + title)
  await shot(`${slug}-1-start`)
  fs.writeFileSync(path.join(OUT, `${slug}-1-start.txt`), await evaluate('document.body.innerText'))
  const ran = await clickText(actionText)
  await sleep(2600)
  await shot(`${slug}-2-battle`)
  fs.writeFileSync(path.join(OUT, `${slug}-2-battle.txt`), await evaluate('document.body.innerText'))
  const wentBack = await clickText('Back to games')
  await sleep(900)
  await shot(`${slug}-3-back`)
  return { screen: title, ran, back: wentBack }
}

// Play a friend: same screen, and the honest online route to games.hermesnet.xyz.
const switchProof = async () => {
  console.log('=== switching games')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const wentBack = await evaluate(`(() => { const node = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Back')); if (node) { node.click(); return true } return false })()`)
    if (!wentBack) break
    await sleep(700)
  }
  await openGame('Connect Four')
  await sleep(1400)
  const started = await clickText('Play the computer')
  await sleep(1800)
  await shot('switch-1-connect4')
  await clickText('Back to games')
  await sleep(700)
  // Open the next game and read the screen before its board has had time to arrive.
  await openGame('Chess')
  const early = await evaluate('document.body.innerText')
  await shot('switch-2-chess-opening')
  await sleep(2200)
  const settledText = await evaluate('document.body.innerText')
  await shot('switch-3-chess-loaded')
  const carriedOtherBoard = /Connect Four/.test(early) && !/Chess/.test(early)
  return { started, carriedOtherBoard, earlyHasChess: /Chess/.test(early), settledHasChess: /Chess/.test(settledText) }
}

const friendProof = async () => {
  console.log('=== friend invite')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const wentBack = await evaluate(`(() => { const node = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Back')); if (node) { node.click(); return true } return false })()`)
    if (!wentBack) break
    await sleep(700)
  }
  await evaluate(`(() => { const node = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Connect Four' || b.textContent.trim().startsWith('Connect Four')); if (node) node.click(); return Boolean(node) })()`)
  await sleep(1500)
  await shot('friend-1-options')
  // `innerText` can come back undefined if the page is mid-navigation; a proof file is a
  // convenience, never a reason to lose the run.
  fs.writeFileSync(path.join(OUT, 'friend-1-options.txt'), String(await evaluate('document.body.innerText') || ''))
  // The online route first: it only opens the site, so the choices stay on screen.
  const online = await clickText('Open in browser')
  await sleep(700)
  await shot('friend-2-online')
  const shared = await clickText('Same screen (pass and play)')
  await sleep(1200)
  await shot('friend-3-pass-play')
  await clickText('Back to games')
  await sleep(700)
  // "Open in browser" really opens the online lobby (the QA server's lobby_url),
  // so the tab may no longer be the QA page. Come back to it before anything else is pressed.
  await cdp('Page.navigate', { url: URL_BASE })
  await sleep(2500)
  await dismissWelcome()
  return { screen: 'friend', online, shared }
}

// Where games live: Play is the curated shelf, Your games is what this person installed, and
// Community is a side link of its own. Proof is the visible page, pressed with the pointer.
const sectionText = label => `(() => {
  const head = [...document.querySelectorAll('div')].find(node => node.children.length === 0 && node.textContent.trim() === ${JSON.stringify(label)})
  if (!head || !head.parentElement) return null
  return head.parentElement.innerText
})()`

const pressButtonWhere = async predicate => {
  const spot = await evaluate(`(() => {
    const found = [...document.querySelectorAll('button')].find(node => ${predicate})
    if (!found || found.disabled) return null
    found.scrollIntoView({ block: 'center' })
    const box = found.getBoundingClientRect()
    return [box.x + box.width / 2, box.y + box.height / 2]
  })()`)
  if (!spot) return false
  await pointer(spot)
  await sleep(500)
  return true
}

const iaProof = async () => {
  console.log('=== information architecture')
  await cdp('Page.navigate', { url: URL_BASE })
  await sleep(3500)
  const home = await evaluate('document.body.innerText')
  const play = await evaluate(sectionText('Play'))
  const yours = await evaluate(sectionText('Your games'))
  await shot('ia-1-home')

  const communityOnHomePage = /Nous Hermes Arcade|Clawpocalypse|ROO GANG|Brother Doge/.test(home)
  const linkOnHomePage = /Community creations/.test(home)
  await evaluate(`(() => {
    const head = [...document.querySelectorAll('div')].find(node => node.children.length === 0 && node.textContent.trim() === 'Your games')
    if (head) head.scrollIntoView({ block: 'start' })
    return Boolean(head)
  })()`)
  await sleep(400)
  await shot('ia-2-your-games')

  // Play: curated tables only, and no launch cards.
  const playOnlyCurated = Boolean(play) && /Connect Four/.test(play) && /Chess/.test(play) && !/Doom|OpenTTD|Luanti|Wesnoth/.test(play)
  // Your games: the installed programs and the two other plugins, each clearly outside code.
  const yourGamesLabelled = Boolean(yours) && /Doom/.test(yours) && /Fake Game/.test(yours)
    && /Broken Game/.test(yours) && /From fake-game/.test(yours)
    && /No lobby or matchmaking/.test(yours)
  const brokenNote = (yours || '').match(/cannot be opened here/g) || []
  const brokenCardSaysSo = brokenNote.length === 1 && !/desktop_route/.test(yours || '')
  const brokenOpenDisabled = await evaluate(`(() => {
    const node = [...document.querySelectorAll('button')].find(b => (b.getAttribute('title') || '').includes('desktop_route'))
    return node ? node.disabled : null
  })()`)

  // A working external card really hands its own route to the Desktop.
  const pressedFake = await pressButtonWhere(`(node.getAttribute('title') || '') === 'Fake Game'`)
  const nav = await evaluate('window.qa.nav || []')

  // Community is its own view, reached by a side link, with a Submit button on it.
  const wentCommunity = await clickText('Community creations', { exact: true })
  await sleep(900)
  const community = await evaluate('document.body.innerText')
  await shot('ia-3-community')
  const communityView = wentCommunity && /Nous Hermes Arcade/.test(community)
    && /made by the community/i.test(community) && !/Your games/.test(community)
  const submitted = await clickText('Submit your game', { exact: true })
  await sleep(700)
  const external = await evaluate('window.qa.external || []')
  const submittedBanner = await evaluate(`(() => { const node = document.getElementById('opened'); return node ? node.textContent : '' })()`)
  await shot('ia-4-submit')

  const backHome = await clickText('Back to Game Center', { exact: true })
  await sleep(900)
  const errors = await evaluate('({ page: window.qa.errors, console: window.qa.consoleErrors })')

  const passed = playOnlyCurated && yourGamesLabelled && brokenCardSaysSo && brokenOpenDisabled === true
    && communityOnHomePage === false && linkOnHomePage === true
    && pressedFake === true && nav.includes('/fake-screen')
    && wentCommunity === true && communityView === true
    && submitted === true && external.includes('https://games.hermesnet.xyz/submit')
    && submittedBanner.includes('OPENED https://games.hermesnet.xyz/submit')
    && backHome === true && errors.page.length === 0 && errors.console.length === 0
  if (!passed) console.log('IA PROOF FAILED', JSON.stringify({ playOnlyCurated, yourGamesLabelled, brokenCardSaysSo, brokenOpenDisabled, communityOnHomePage, linkOnHomePage, pressedFake, nav, wentCommunity, communityView, submitted, external, backHome, errors }))

  return {
    screen: 'information architecture',
    passed,
    playOnlyCurated,
    yourGamesLabelled,
    brokenCardSaysSo,
    brokenOpenDisabled,
    communityOnHomePage,
    linkOnHomePage,
    pressedFake,
    nav,
    wentCommunity,
    communityView,
    submitted,
    external,
    submittedBanner,
    backHome,
    errors,
    play: (play || '').split('\n').slice(0, 4),
    yours: (yours || '').split('\n').slice(0, 8)
  }
}

// Press the only button inside one card, with a real pointer, and prove the pointer landed on that
// button: elementFromPoint at its centre must be the button itself (or something inside it).
const clickInside = async selector => {
  const spot = await evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(selector)})
    if (!root) return null
    const node = [...root.querySelectorAll('button')].find(button => !button.disabled)
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const box = node.getBoundingClientRect()
    if (!box.width || !box.height) return null
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    const hit = document.elementFromPoint(x, y)
    return [x, y, hit === node || node.contains(hit), node.textContent.trim()]
  })()`)
  if (!spot) return { found: false }
  const [x, y, hit, label] = spot
  await pointer([x, y])
  await sleep(600)
  return { found: true, hit, label }
}

// Labs and the two new shelves: suggestions that are not installed, the Make games workshop, and
// the download/watch community cards. Every press is a real pointer at the button's own centre.
const shelvesProof = async () => {
  console.log('=== shelves: suggestions, Labs and community kinds')
  await cdp('Page.navigate', { url: URL_BASE })
  await sleep(3500)
  // A fresh storage folder opens on the welcome. Answer it the way a person does, with the name
  // already filled in, so the shelves are what is on screen.
  if (await clickText('Continue', { exact: true })) await sleep(1200)
  const home = await evaluate('document.body.innerText')
  const labsBadgeText = await evaluate(`(() => { const node = document.querySelector('[data-labs-badge]'); return node ? node.textContent.trim() : '' })()`)
  const suggestionCards = await evaluate(`[...document.querySelectorAll('[data-suggestion]')].map(node => [node.getAttribute('data-suggestion'), node.innerText])`)
  const labCards = await evaluate(`[...document.querySelectorAll('[data-labs-card]')].map(node => [node.getAttribute('data-labs-card'), node.innerText])`)
  await shot('shelves-1-home')

  // Your games: the suggestion row, capped at three, with the rest named in one line.
  await evaluate(`(() => {
    const head = [...document.querySelectorAll('div')].find(node => node.children.length === 0 && node.textContent.trim() === 'Your games')
    if (head) head.scrollIntoView({ block: 'start' })
    return Boolean(head)
  })()`)
  await sleep(400)
  await shot('shelves-2-your-games')
  const suggestionRow = /More in the Hermes catalog/i.test(home)
  const cappedAtThree = suggestionCards.length === 3
  const notInstalledSaid = suggestionCards.every(([, text]) => /Not installed/.test(text) && /catalog page is where Hermes installs it/.test(text))
  const restNamed = /2 more game plugins are on the Hermes catalog\./.test(home)
  const noInstallVerb = !/Install now|Install it|Get it now/.test(home)

  // Press a suggestion's only way out: it must hand the catalog page to the system browser.
  const before = await evaluate('(window.qa.external || []).length')
  const pressedSuggestion = await clickInside('[data-suggestion="agent-hold-em"]')
  const afterSuggestion = await evaluate('window.qa.external || []')
  await shot('shelves-3-suggestion-opened')
  const suggestionOpened = pressedSuggestion.found && pressedSuggestion.hit
    && afterSuggestion.slice(before).includes('https://hermes-agent.nousresearch.com/docs/plugins/agent-hold-em')

  // Labs: one badge, the Make games block, a plugin card and the skill card.
  await evaluate(`(() => {
    const shelf = document.querySelector('[data-labs-section]')
    if (shelf) shelf.scrollIntoView({ block: 'start' })
    return Boolean(shelf)
  })()`)
  await sleep(400)
  await shot('shelves-4-labs')
  const labsOnPage = labsBadgeText === 'Labs · experiment'
  const makeGames = /Make games/.test(home) && /GameForge/.test(home) && /Godot Studio/.test(home)
  const workshopLabelled = /community-made, not affiliated/.test(home)
  const skillLabelled = labCards.some(([id, text]) => id === 'pixel-art' && /Official skill/.test(text))
  const noSolidInstall = !labCards.some(([, text]) => /Install/.test(text))

  const beforeLabs = await evaluate('(window.qa.external || []).length')
  const pressedMaker = await clickInside('[data-labs-card="gameforge"]')
  const afterLabs = await evaluate('window.qa.external || []')
  await shot('shelves-5-maker-opened')
  const makerOpened = pressedMaker.found && pressedMaker.hit
    && afterLabs.slice(beforeLabs).includes('https://hermes-agent.nousresearch.com/docs/plugins/gameforge')

  // Community: the five web games keep their card, and the download and watch cards say so.
  const wentCommunity = await clickText('Community creations', { exact: true })
  await sleep(900)
  const community = await evaluate('document.body.innerText')
  await shot('shelves-6-community')
  const downloadCard = await evaluate(`(() => { const node = document.querySelector('[data-community-card="misty-mountain"]'); return node ? node.innerText : '' })()`)
  const watchCard = await evaluate(`(() => { const node = document.querySelector('[data-community-card="gladiator"]'); return node ? node.innerText : '' })()`)
  const downloadSaysSo = /Download/.test(downloadCard) && /does not play in the browser/.test(downloadCard)
  const watchSaysSo = /Watch demo/.test(watchCard) && /not a game you play/.test(watchCard)
  const keptFive = ['Nous Hermes Arcade', 'The Legends of Nous Research', 'Brother Doge', 'Clawpocalypse Now', 'ROO GANG']
    .every(title => community.includes(title))

  const beforeDownload = await evaluate('(window.qa.external || []).length')
  const pressedDownload = await clickInside('[data-community-card="misty-mountain"]')
  const afterDownload = await evaluate('window.qa.external || []')
  await shot('shelves-7-download-opened')
  const downloadOpened = pressedDownload.found && pressedDownload.hit
    && afterDownload.slice(beforeDownload).includes('https://github.com/123mikeyd/hermes-community-care-package/releases/tag/v0.1.0-prototype')

  const backHome = await clickText('Back to Game Center', { exact: true })
  await sleep(900)
  const errors = await evaluate('({ page: window.qa.errors, console: window.qa.consoleErrors })')

  const passed = suggestionRow && cappedAtThree && notInstalledSaid && restNamed && noInstallVerb
    && suggestionOpened && labsOnPage && makeGames && workshopLabelled && skillLabelled && noSolidInstall
    && makerOpened && wentCommunity && downloadSaysSo && watchSaysSo && keptFive && downloadOpened
    && backHome === true && errors.page.length === 0 && errors.console.length === 0
  if (!passed) console.log('SHELVES PROOF FAILED', JSON.stringify({
    suggestionRow, cappedAtThree, notInstalledSaid, restNamed, noInstallVerb, pressedSuggestion,
    afterSuggestion, suggestionOpened, labsOnPage, makeGames, workshopLabelled, skillLabelled,
    noSolidInstall, pressedMaker, makerOpened, wentCommunity, downloadCard, watchCard,
    downloadSaysSo, watchSaysSo, keptFive, pressedDownload, downloadOpened, backHome, errors
  }, null, 2))

  return {
    screen: 'shelves: suggestions, Labs and community kinds',
    passed,
    suggestionRow,
    cappedAtThree,
    notInstalledSaid,
    restNamed,
    noInstallVerb,
    suggestionHit: pressedSuggestion,
    suggestionOpened,
    labsBadgeText,
    labsOnPage,
    makeGames,
    workshopLabelled,
    skillLabelled,
    noSolidInstall,
    makerHit: pressedMaker,
    makerOpened,
    wentCommunity,
    downloadSaysSo,
    watchSaysSo,
    keptFive,
    downloadHit: pressedDownload,
    downloadOpened,
    backHome,
    errors
  }
}

// First run: the welcome, Settings, a name change, and the quiet alert on the status
// bar and the home page when a second person on this referee looks for a match.
const firstRunProof = async () => {
  console.log('=== first run, settings and quiet alerts')
  await cdp('Page.navigate', { url: URL_BASE })
  await sleep(3500)

  const typeInto = async (selector, text) => {
    const spot = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const box = el.getBoundingClientRect()
      return [box.x + box.width / 2, box.y + box.height / 2]
    })()`)
    if (!spot) return false
    await pointer(spot)
    await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); if (el.select) el.select(); return true })()`)
    for (const ch of text) await cdp('Input.dispatchKeyEvent', { type: 'char', text: ch })
    await sleep(250)
    return (await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.value : '' })()`)) === text
  }
  const setupNow = () => evaluate(`fetch('/qa/setup').then(r => r.json()).then(x => x.setup)`)
  const badge = () => evaluate(`(() => { const el = document.querySelector('#statusbar [data-badge="matches"]'); return el ? el.textContent.trim() : '' })()`)
  const line = async () => String(await evaluate(`(() => { const el = document.querySelector('.games-alert'); return el ? el.innerText : '' })()`))

  // 1. A fresh install opens on the welcome: what this is, a name already filled in.
  const welcome = await evaluate('document.body.innerText')
  const welcomeShown = /Welcome to Game Center/.test(welcome)
    && /board games that come with Hermes/.test(welcome)
    && /No account, no email/.test(welcome)
    && /About 20 seconds/.test(welcome)
  const prefill = await evaluate(`(() => { const el = document.querySelector('input[aria-label="Your name"]'); return el ? el.value : '' })()`)
  const canContinueAtOnce = Boolean(prefill) && await evaluate(`(() => Boolean([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Continue')))()`)
  await shot('fr-1-welcome')

  // 2. Pick a name, ask for Connect Four matches, press Continue. Real keystrokes.
  const typed = await typeInto('input[aria-label="Your name"]', 'Nova Otter')
  const pickedGame = await clickText('Connect Four', { exact: true })
  const continued = await clickText('Continue', { exact: true })
  await sleep(2500)
  const home = await evaluate('document.body.innerText')
  const homeAfterWelcome = /You are Nova Otter/.test(home)
  const afterSetup = (await setupNow()) || {}
  const welcomeGone = /Welcome to Game Center/.test(home) === false
  await shot('fr-2-home-after-welcome')

  // 3. Settings: the name, one switch per game, a pause, AI seats. The game chosen in
  // the welcome is the only one on; everything else starts off.
  const wentSettings = await clickText('Settings', { exact: true })
  await sleep(1200)
  const settingsText = await evaluate('document.body.innerText')
  const switches = await evaluate(`(() => {
    const box = document.querySelector('section[aria-label="Match alerts"]')
    if (!box) return null
    return [...box.querySelectorAll('button')]
      .filter(b => ['On', 'Off'].includes(b.textContent.trim()))
      .map(b => ({ label: b.getAttribute('aria-label') || b.textContent.trim(), said: b.textContent.trim() }))
  })()`)
  const switchFor = name => (switches || []).find(item => item.label.includes(name)) || {}
  const welcomeChoiceKept = switchFor('Connect Four').said === 'On'
  const othersStartOff = (switches || []).filter(item => !item.label.includes('Connect Four')).every(item => item.said === 'Off')
  await shot('fr-3-settings')

  // 4. Change the name here, then switch Connect Four off and on again: both saved.
  const renamed = await typeInto('input[aria-label="Your name"]', 'Argo')
  const savedName = await clickText('Save name', { exact: true })
  await sleep(1200)
  const afterRename = await evaluate('document.body.innerText')
  const readSwitch = () => evaluate(`(() => {
    const box = document.querySelector('section[aria-label="Match alerts"]')
    const node = box && [...box.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').includes('Connect Four'))
    return node ? node.textContent.trim() : ''
  })()`)
  const turnedOff = await pressButtonWhere(`(node.getAttribute('aria-label') || '') === 'Tell me when someone wants a match: Connect Four'`)
  await sleep(1200)
  const saidOff = await readSwitch()
  const turnedOn = await pressButtonWhere(`(node.getAttribute('aria-label') || '') === 'Tell me when someone wants a match: Connect Four'`)
  await sleep(1200)
  const saidOn = await readSwitch()
  await shot('fr-4-settings-on')
  const savedSettings = await setupNow()

  // Back to the games.
  const backHome = await clickText('Back to Game Center', { exact: true })
  await sleep(1200)
  const beforeAnyLook = await badge()
  const noLineYet = (await line()).length === 0

  // 5. A second person on this Hermes asks for a Connect Four match. Wait for the polls.
  await evaluate(`fetch('/qa/look', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bea', game: 'connect4', address: 'bea.example:2300' }) }).then(r => r.json())`)
  await sleep(7000)
  const badgeWithSomeone = await badge()
  const lineWithSomeone = await line()
  const popups = await evaluate(`document.querySelectorAll('[role=alertdialog], [role=dialog]').length`)
  await shot('fr-5-alert')

  // 6. Join opens that table, which is where a seat is taken.
  const joined = await clickText('Join', { exact: true })
  await sleep(2000)
  const atTable = await evaluate('document.body.innerText')
  const joinOpenedTable = /Connect Four/.test(atTable) && /Play the computer|Sit|Take a seat|Open seat|Join table|Your turn/i.test(atTable)
  await shot('fr-6-join')

  // 7. Dismiss clears the line and the badge, quietly.
  await clickText('Back to games')
  await sleep(1500)
  const dismissed = await clickText('Dismiss', { exact: true })
  // The home line clears with the page's own refresh; the badge has its own 5 s poll,
  // so give it one full turn before looking.
  await sleep(7000)
  const badgeAfterDismiss = await badge()
  const lineAfterDismiss = await line()
  await shot('fr-7-dismissed')

  // 8. The same person looking again straight away is the repeat that is rate-limited.
  await evaluate(`fetch('/qa/look', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bea', game: 'connect4', address: 'bea.example:2300' }) }).then(r => r.json())`)
  await sleep(6000)
  const badgeOnRepeat = await badge()
  await evaluate(`fetch('/qa/look', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bea', stop: true }) }).then(r => r.json())`)
  await sleep(4000)
  const badgeAfterStop = await badge()

  // 9. Settings can bring the welcome back, and it is on screen at once: the page reads
  // the saved answer rather than waiting for its next poll (which is 3 s away).
  const wentSettingsAgain = await clickText('Settings', { exact: true })
  await sleep(900)
  const reopened = await clickText('Show the welcome again', { exact: true })
  await sleep(1200)
  const welcomeAgain = /Welcome to Game Center/.test(await evaluate('document.body.innerText'))
  await shot('fr-8-welcome-again')
  const errors = await evaluate('({ page: window.qa.errors, console: window.qa.consoleErrors })')

  const passed = welcomeShown && canContinueAtOnce && typed && pickedGame && continued
    && homeAfterWelcome && welcomeGone && afterSetup.welcome_needed === false
    && afterSetup.watched.connect4 === true && afterSetup.name === 'Nova Otter'
    && wentSettings && Boolean(switches) && welcomeChoiceKept && othersStartOff
    && /Let AI seats play here/.test(settingsText) && /Pause all of these/.test(settingsText)
    && renamed && savedName && /You are Argo/.test(afterRename)
    && turnedOff && saidOff === 'Off' && turnedOn && saidOn === 'On'
    && savedSettings.watched.connect4 === true
    && savedSettings.paused === false && savedSettings.name === 'Argo'
    && backHome && beforeAnyLook === '' && noLineYet
    && badgeWithSomeone === '1' && /Bea is looking for a Connect Four match at bea\.example:2300\./.test(lineWithSomeone)
    && /People in this Hermes and the chats it shares\./.test(lineWithSomeone)
    && popups === 0
    && joined && joinOpenedTable
    && dismissed && badgeAfterDismiss === '' && lineAfterDismiss === ''
    && badgeOnRepeat === '' && badgeAfterStop === ''
    && wentSettingsAgain && reopened && welcomeAgain
    && errors.page.length === 0 && errors.console.length === 0
  if (!passed) console.log('FIRST RUN PROOF FAILED', JSON.stringify({
    welcomeShown, canContinueAtOnce, typed, pickedGame, continued, homeAfterWelcome, welcomeGone,
    afterSetup, switches, wentSettings, welcomeChoiceKept, othersStartOff, renamed, savedName,
    afterRename, turnedOff, saidOff, turnedOn, saidOn,
    savedSettings, backHome, beforeAnyLook, noLineYet, badgeWithSomeone, lineWithSomeone, popups,
    joined, joinOpenedTable, dismissed, badgeAfterDismiss, lineAfterDismiss, badgeOnRepeat,
    badgeAfterStop, wentSettingsAgain, reopened, welcomeAgain, errors
  }, null, 2))

  return {
    screen: 'first run and quiet alerts',
    passed,
    welcomeShown, canContinueAtOnce, suggestedName: prefill, typed, pickedGame, continued,
    nameAfterWelcome: afterSetup.name, gamesWatch: afterSetup.watched,
    switches, saidOff, saidOn, renamed,
    badgeWithSomeone, lineWithSomeone, popups,
    joined, joinOpenedTable, badgeAfterDismiss, lineAfterDismiss, badgeOnRepeat, badgeAfterStop,
    reopened, welcomeAgain, errors
  }
}
// Play while you code: the pane beside a stub chat, a quick game in one click, a move
// played by dragging a piece, the working and finished lines from the stub's own signals,
// and the same saved game back after a reload.
const paneProof = async () => {
  console.log('=== play while you code')
  const openPane = async () => {
    await cdp('Page.navigate', { url: URL_BASE + 'pane' })
    await sleep(3500)
    await installHelpers()
  }
  const paneText = () => evaluate('document.getElementById("pane").innerText')
  const paneButton = async label => evaluate(`(() => {
    const pane = document.getElementById('pane')
    const node = [...pane.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)})
    if (!node || node.disabled) return null
    node.scrollIntoView({ block: 'center' })
    const box = node.getBoundingClientRect()
    return [box.x + box.width / 2, box.y + box.height / 2]
  })()`)

  await evaluate('localStorage.clear()').catch(() => {})
  await openPane()
  await shot('ww-1-pane-beside-chat')
  const intro = await paneText()
  const quickLabels = ['Connect Four', 'Reversi', 'Gomoku', 'Breakthrough']
  const quickOffered = quickLabels.every(label => intro.includes(label))

  // One click: a quick game against the computer.
  const quickSpot = await paneButton('Connect Four')
  if (quickSpot) await pointer(quickSpot)
  await sleep(2200)
  await shot('ww-2-quick-game')
  const startedText = await paneText()
  const quickStarted = /Your turn/.test(startedText)

  // A move by drag, on a board that has pieces to lift: checkers, chosen by pressing its
  // tile in the pane's own row of games (no drop-down), then played with the pointer.
  const checkersSpot = await paneButton('Checkers')
  if (checkersSpot) await pointer(checkersSpot)
  await sleep(1600)
  const pressedTile = () => evaluate(`(() => {
    const pressed = [...document.querySelectorAll('#pane [aria-label="Game"] button')].find(button => button.getAttribute('aria-pressed') === 'true')
    return pressed ? pressed.textContent.trim() : ''
  })()`)
  const choseCheckers = (await pressedTile()) === 'Checkers'
  await sleep(1600)
  const newSpot = await paneButton('New game vs computer')
  if (newSpot) await pointer(newSpot)
  await sleep(1800)
  await installHelpers()
  const beforeMove = await evaluate('({ state: window.__bd.state(), status: window.__bd.status() })')
  const dragged = await playOne({ drag: true })
  const afterMove = await evaluate('({ state: window.__bd.state(), status: window.__bd.status() })')
  // The board drawing changed, and it changed because a piece was held and dropped. The
  // pane clears "Your turn" and the computer answers inside one poll, so the turn text is
  // not a reliable witness here; the drawing and the gesture are.
  const changed = beforeMove.state !== afterMove.state && lastGesture === 'piece-drag'
  await shot('ww-3-drag-move')

  // The agent line: the stub chat drives the same public signals the Desktop gives a plugin.
  const startTurn = await clickText('Start a Hermes turn')
  await sleep(700)
  const workingText = await paneText()
  await shot('ww-4-hermes-working')
  const finishTurn = await clickText('Finish the Hermes turn')
  await sleep(900)
  const finishedText = await paneText()
  await shot('ww-5-hermes-finished')
  const backSpot = await paneButton('Back to chat')
  const actionsBefore = await evaluate('(window.qa.actions || []).length')
  if (backSpot) await pointer(backSpot)
  await sleep(500)
  const actionsAfter = await evaluate('(window.qa.actions || [])')

  // The badge in the status bar, and the resume: reload the page, and the saved game is
  // the one that opens, with the same position.
  const ariaLabel = async () => {
    for (let attempt = 0; attempt < 18; attempt += 1) {
      const said = await evaluate(`(() => { const node = document.querySelector('#statusbar button'); return node ? node.getAttribute('aria-label') : null })()`)
      if (said && said !== 'Games') return said
      await sleep(1000)
    }
    return await evaluate(`(() => { const node = document.querySelector('#statusbar button'); return node ? node.getAttribute('aria-label') : null })()`)
  }
  const badge = await ariaLabel()
  const boardBefore = await evaluate(`(() => { const svg = document.querySelector('#pane svg[aria-label]'); return svg ? svg.getAttribute('aria-label') : '' })()`)
  await openPane()
  const resumedSelect = await pressedTile()
  const boardAfter = await evaluate(`(() => { const svg = document.querySelector('#pane svg[aria-label]'); return svg ? svg.getAttribute('aria-label') : '' })()`)
  await shot('ww-6-resumed')
  const resumed = resumedSelect === 'Checkers' && Boolean(boardAfter) && boardAfter === boardBefore

  const errors = await evaluate('({ page: window.qa.errors, console: window.qa.consoleErrors })')
  const passed = quickOffered && quickStarted && choseCheckers && changed && startTurn
    && /Hermes is working/.test(workingText) && finishTurn && /Hermes finished: back to chat/.test(finishedText)
    && backSpot !== null && actionsAfter.length > actionsBefore && actionsAfter.includes('composer.focus')
    && /Your turn/.test(badge || '') && resumed
    && errors.page.length === 0 && errors.console.length === 0
  if (!passed) {
    console.log('PANE PROOF FAILED', JSON.stringify({
      quickOffered, quickStarted, choseCheckers, dragged, changed, startTurn,
      working: /Hermes is working/.test(workingText), finishTurn,
      finished: /Hermes finished: back to chat/.test(finishedText),
      back: backSpot !== null, actionsAfter, badge, resumedSelect, resumed,
      boardBefore, boardAfter, errors
    }))
  }
  return {
    screen: 'play while you code',
    passed,
    quickOffered,
    quickStarted,
    choseCheckers,
    dragged,
    changed,
    gesture: lastGesture,
    working: /Hermes is working/.test(workingText),
    finished: /Hermes finished: back to chat/.test(finishedText),
    backToChat: backSpot !== null,
    actions: actionsAfter,
    badge,
    resumedSelect,
    resumed,
    shots: ['ww-1-pane-beside-chat', 'ww-2-quick-game', 'ww-3-drag-move', 'ww-4-hermes-working', 'ww-5-hermes-finished', 'ww-6-resumed'],
    errors
  }
}

// A talking table, driven the way a person drives it: the card is clicked, the seats are
// chosen by pressing buttons, every move is a press, and a line of chat is typed into the
// box only while the game is in a talking phase.
const TALK_GAMES = {
  mafia: 'Mafia',
  'liars-dice': "Liar's Dice",
  'liars-dice-2v2': "Liar's Dice 2v2",
  'prisoners-dilemma': "Prisoner's Dilemma",
  'blind-auction': 'Blind Auction'
}

const talkState = () => evaluate(`(() => {
  const root = document.querySelector('.games-talk')
  const setup = document.querySelector('.games-talk-setup')
  const pageText = (root || document.body).innerText || ''
  if (!root) return { open: false, setup: Boolean(setup), over: false, text: pageText }
  const input = root.querySelector('input[maxlength="200"]')
  const actions = [...root.querySelectorAll('.games-talk-actions button')]
  return {
    open: true,
    setup: false,
    phase: (root.querySelector('.games-status') || {}).textContent || '',
    buttons: actions.filter(node => !node.disabled).map(node => node.textContent.trim()),
    canTalk: Boolean(input && !input.disabled),
    over: Boolean(document.querySelector('[aria-label="Reveal"]')),
    seats: root.querySelectorAll('.games-talk-seat').length,
    teams: [...root.querySelectorAll('.games-talk-team')].map(node => ({
      team: node.getAttribute('data-team'),
      dice: (node.querySelector('[data-team-dice]') || {}).textContent || '',
      seats: [...node.querySelectorAll('[data-team-seat]')].length
    })),
    outcome: (document.querySelector('[data-outcome]') || { dataset: {} }).dataset.outcome || '',
    bid: (root.querySelector('[data-talk-bid]') || {}).textContent || '',
    reveal: Boolean(document.querySelector('[aria-label="Reveal"]')),
    calls: (root.innerText.match(/Model calls: [0-9]+ of [0-9]+[^\\n]*/) || [''])[0],
    text: root.innerText
  }
})()`)

const clickTalkButton = async label => {
  const spot = await evaluate(`(() => {
    const root = document.querySelector('.games-talk, .games-talk-setup')
    if (!root) return null
    const found = [...root.querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(label)} && !node.disabled)
    if (!found) return null
    found.scrollIntoView({ block: 'center' })
    const box = found.getBoundingClientRect()
    return [box.x + box.width / 2, box.y + box.height / 2]
  })()`)
  if (!spot) return false
  await pointer(spot)
  await sleep(500)
  return true
}

const clickFirstTalkAction = async () => {
  const spot = await evaluate(`(() => {
    const root = document.querySelector('.games-talk, .games-talk-setup')
    if (!root) return null
    const found = [...root.querySelectorAll('.games-talk-actions button')].find(node => !node.disabled)
    if (!found) return null
    found.scrollIntoView({ block: 'center' })
    const box = found.getBoundingClientRect()
    return [box.x + box.width / 2, box.y + box.height / 2]
  })()`)
  if (!spot) return false
  await pointer(spot)
  await sleep(600)
  return true
}

const clickTalkChip = async () => {
  const spot = await evaluate(`(() => {
    const root = document.querySelector('.games-talk, .games-talk-setup')
    if (!root) return null
    const found = [...root.querySelectorAll('.games-talk-actions button')].find(node => !node.disabled && /^\\d+ for /.test(node.textContent.trim()))
    if (!found) return null
    found.scrollIntoView({ block: 'center' })
    const box = found.getBoundingClientRect()
    return [box.x + box.width / 2, box.y + box.height / 2]
  })()`)
  if (!spot) return false
  await pointer(spot)
  await sleep(700)
  return true
}

const typeIntoTable = async text => {
  const spot = await evaluate(`(() => {
    const input = document.querySelector('.games-talk input[maxlength="200"]')
    if (!input || input.disabled) return null
    input.scrollIntoView({ block: 'center' })
    const box = input.getBoundingClientRect()
    return [box.x + box.width / 2, box.y + box.height / 2]
  })()`)
  if (!spot) return false
  await pointer(spot)
  await cdp('Input.insertText', { text })
  await sleep(150)
  for (const type of ['keyDown', 'keyUp']) {
    await cdp('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type === 'keyDown' ? '\r' : undefined })
  }
  await sleep(700)
  return true
}

const playTalking = async (slug, options = {}) => {
  const title = TALK_GAMES[slug] || slug
  const watch = Boolean(options.watch)
  // A watched game keeps its own screenshots, so a later played run cannot overwrite them.
  const prefix = watch ? `talk-${slug}-watch` : `talk-${slug}`
  console.log('=== talking table', title, watch ? '(watching computers)' : '(playing)')
  await cdp('Page.navigate', { url: URL_BASE })
  // The page pulls its React assets on a cold profile: wait for it to say something.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = await evaluate("document.body.innerText.length > 300")
    if (ready) break
    await sleep(500)
  }
  await sleep(600)
  // A fresh install opens on the welcome first. A person presses Continue with the name
  // already filled in; the talking table is behind it.
  if (/Welcome to Game Center/.test(await evaluate('document.body.innerText'))) {
    await clickText('Continue', { exact: true })
    await sleep(2200)
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const back = await clickText('Back to games')
    if (!back) break
    await sleep(500)
  }
  const findSpot = async () => evaluate(`(() => {
    // The Labs card for this experiment, a Play card carrying the game's name, or a
    // Your games row with an Open button. The centre of the control is returned so the
    // caller can press it with a real pointer event, not a scripted .click().
    let target = document.querySelector('[data-labs-play=' + JSON.stringify(${JSON.stringify(slug)}) + '] button')
    if (!target) {
      target = [...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(title)}))
    }
    if (!target) {
      const open = [...document.querySelectorAll('button')]
        .filter(b => b.textContent.trim() === 'Open')
        .find(b => {
          let node = b
          for (let step = 0; step < 4 && node; step += 1) {
            node = node.parentElement
            const text = ((node && node.innerText) || '').trim()
            if (text.toLowerCase().startsWith(${JSON.stringify(title.toLowerCase())})) return true
          }
          return false
        })
      target = open
    }
    if (!target) return null
    target.scrollIntoView({ block: 'center' })
    const box = target.getBoundingClientRect()
    return [box.x + box.width / 2, box.y + box.height / 2]
  })()`)
  let spot = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    spot = await findSpot()
    if (spot) break
    await sleep(500)
  }
  if (spot) await pointer(spot)
  await sleep(1500)
  const opened = Boolean(spot)
  if (!opened) {
    if (DEBUG) {
      console.log(await evaluate(`JSON.stringify({
        opens: [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Open').length,
        rows: [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Open')
          .map(b => ((b.parentElement && b.parentElement.innerText) || '').trim().slice(0, 40)),
        talk: [...document.querySelectorAll('button')].filter(b => /Mafia/i.test(b.textContent)).map(b => b.textContent.trim().slice(0, 60)),
        tail: (document.body.innerText || '').slice(-400)
      }, null, 1)`))
    }
    throw new Error('no card for ' + title)
  }
  let onSetup = await evaluate("Boolean(document.querySelector('.games-talk-setup'))")
  // A table from an earlier run may still be on the screen: close it and start from the seats.
  for (const label of ['New table', 'Set up a new table']) {
    if (onSetup) break
    if (await clickTalkButton(label)) {
      await sleep(1500)
      onSetup = await evaluate("Boolean(document.querySelector('.games-talk-setup'))")
    }
  }
  if (!onSetup) await shot(`${prefix}-0-nothing-to-open`)
  await shot(`${prefix}-1-setup`)
  fs.writeFileSync(path.join(OUT, `${prefix}-1-setup.txt`), await evaluate('document.body.innerText'))
  if (!onSetup) throw new Error('the setting-up screen did not open for ' + title)
  const started = watch ? await clickTalkButton('Watch computers play') : await clickTalkButton('Start the game')
  await sleep(1800)
  const shots = []
  let said = 0
  let moves = 0
  const sayLimit = slug === 'liars-dice-2v2' ? 2 : 40
  let state = await talkState()
  for (let turn = 0; turn < 160; turn += 1) {
    state = await talkState()
    if (!state.open && !state.setup) break
    if (state.over) break
    if (slug === 'liars-dice-2v2' && state.teams.length && !shots.includes('teams')) {
      await shot(`${prefix}-2-teams`)
      fs.writeFileSync(path.join(OUT, `${prefix}-2-teams.txt`), state.text || '')
      shots.push('teams')
    }
    if (state.buttons.some(label => /^\d+ for /.test(label)) && !shots.includes('bids')) {
      await shot(`${prefix}-3-bids`)
      fs.writeFileSync(path.join(OUT, `${prefix}-3-bids.txt`), state.text || '')
      shots.push('bids')
    }
    if (!watch && state.canTalk && said < sayLimit) {
      const line = ['I have nothing solid yet.', 'That is a fair point.', 'I would rather not guess.', 'Two of us doing well beats one of us winning.', 'I am watching what you do next.', 'Let us keep this simple.'][said % 6]
      if (await typeIntoTable(line)) {
        said += 1
        moves += 1
        if (shots.length === 0) {
          await shot(`${prefix}-2-first-turn`)
          fs.writeFileSync(path.join(OUT, `${prefix}-2-first-turn.txt`), (state.text || ''))
          shots.push('first')
        }
        continue
      }
    }
    if (slug === 'blind-auction' && state.buttons.some(label => label === 'Send these bids')) {
      if (!options.__picked) {
        options.__picked = await clickTalkChip()
        continue
      }
      await clickTalkButton('Send these bids')
      options.__picked = false
      moves += 1
      continue
    }
    if (await clickFirstTalkAction()) {
      moves += 1
      if (moves === 6 && shots.length < 2) {
        await shot(`${prefix}-3-midgame`)
        fs.writeFileSync(path.join(OUT, `${prefix}-3-midgame.txt`), (state.text || ''))
        shots.push('mid')
      }
      continue
    }
    // Nothing to press: the machine seats are playing their own turns.
    await sleep(1000)
    const now = await talkState()
    if (now.open && !now.over && moves === 0 && shots.length === 0) {
      await shot(`${prefix}-2-first-turn`)
      fs.writeFileSync(path.join(OUT, `${prefix}-2-first-turn.txt`), (now.text || ''))
      shots.push('first')
    }
  }
  await sleep(900)
  const final = await talkState()
  await shot(`${prefix}-4-reveal`)
  if (final.outcome) {
    await shot(`${prefix}-5-outcome-${final.outcome}`)
    fs.writeFileSync(path.join(OUT, `${prefix}-5-outcome.txt`), await evaluate('document.body.innerText'))
  }
  return {
    game: title,
    slug,
    watching: watch,
    started,
    seatsDrawn: final.seats,
    teams: final.teams,
    outcome: final.outcome,
    revealed: final.reveal,
    said,
    moves,
    calls: final.calls,
    status: final.phase,
    shots
  }
}

const games = [
  ['Connect Four', 'connect4'], ['Reversi', 'reversi'], ['Gomoku', 'gomoku'], ['Hex', 'hex'],
  ['Go', 'go'], ['Checkers', 'checkers'], ['Chess', 'chess'], ['Breakthrough', 'breakthrough'],
  ['Kalah', 'kalah']
]
const results = []
if (TOUR) {
  // Play a friend first, while the shelf is fresh: the two routes live on a game's start
  // screen, which a finished table no longer shows.
  try {
    results.push(await friendProof())
  } catch (error) {
    console.log('FAILED friend', error.message)
    results.push({ screen: 'friend', error: error.message })
  }
  for (const [title, slug] of games) {
    try {
      results.push(await playGame(title, slug))
    } catch (error) {
      console.log('FAILED', title, error.message)
      results.push({ game: title, error: error.message })
      await shot(`${slug}-failed`)
      await cdp('Page.navigate', { url: URL_BASE })
      await sleep(3500)
    }
  }
  for (const [title, slug, action] of [['Doctrine', 'doctrine', 'Play a battle'], ['Doctrine Arena', 'arena', 'Fight']]) {
    try {
      results.push(await visitScreen(title, slug, action))
    } catch (error) {
      console.log('FAILED', title, error.message)
      results.push({ screen: title, error: error.message })
      await shot(`${slug}-failed`)
      await cdp('Page.navigate', { url: URL_BASE })
      await sleep(3500)
    }
  }
} else if (TALK) {
  results.push(await playTalking(TALK, { watch: WATCH }))
} else if (TALK_ALL) {
  for (const slug of Object.keys(TALK_GAMES)) {
    try {
      results.push(await playTalking(slug, { watch: WATCH }))
    } catch (error) {
      console.log('FAILED', slug, error.message)
      results.push({ game: TALK_GAMES[slug], slug, error: error.message })
      await shot(`talk-${slug}-failed`)
    }
  }
} else if (GAME) {
  const found = games.find(([, slug]) => slug === GAME) || [GAME, GAME]
  results.push(await playGame(found[0], found[1]))
} else if (IA) {
  results.push(await iaProof())
} else if (SHELVES) {
  results.push(await shelvesProof())
} else if (FIRST_RUN) {
  results.push(await firstRunProof())
} else if (PANE) {
  results.push(await paneProof())
} else if (FRIEND) {
  results.push(await friendProof())
} else if (SCREENS) {
  for (const [title, slug, action] of [['Doctrine', 'doctrine', 'Play a battle'], ['Doctrine Arena', 'arena', 'Fight']]) {
    results.push(await visitScreen(title, slug, action))
  }
} else if (SWITCH) {
  results.push(await switchProof())
}
// One record for every game, across runs: a single-game run replaces that game's line and
// leaves the other games' lines in place.
const board = path.join(OUT, 'drive-results.json')
let kept = { shots: [], results: [] }
try { kept = JSON.parse(fs.readFileSync(board, 'utf8')) } catch { /* first run writes a fresh file */ }
const keyOf = row => (row.game ? `game:${row.game}:${row.watching ? 'watch' : 'play'}`
  : row.screen ? `screen:${row.screen}` : JSON.stringify(row))
const merged = kept.results.filter(row => !results.some(fresh => keyOf(fresh) === keyOf(row))).concat(results)
fs.writeFileSync(board, JSON.stringify({ shots, results: merged }, null, 2))
console.log(JSON.stringify({ shots: shots.length, results }, null, 2))
stopChrome()
await sleep(400)
// Chrome's user-data directory is ~200 MB a run; leaving it behind fills the temp quota
// after a dozen runs.
try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch { /* chrome still holds a lock */ }
process.exit(0)
