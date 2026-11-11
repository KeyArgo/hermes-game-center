// Prove the Chess Coach with a real browser and a real mouse.
//
//   node tools/coach_proof.mjs --url http://127.0.0.1:18783/ --out proof/cc
//
// Every press is a mouse press and release at the square's own centre, after
// document.elementFromPoint said what is really there. Nothing calls
// element.click(). The moves themselves are chosen by tools/coach_mover.py
// (the game's own search): the judgement is ours, the input is a person's.
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const URL_BASE = arg('url', process.env.GAMESHELF_QA_URL || 'http://127.0.0.1:18783/')
const OUT = path.resolve(arg('out', 'proof/cc'))
let PORT = Number(arg('port', String(9600 + (process.pid % 300))))
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-coach-'))
process.on('exit', () => { try { chrome.kill('SIGKILL') } catch {} try { fs.rmSync(profile, { recursive: true, force: true }) } catch {} }); for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => process.exit(130)) // delete the ~200 MB Chrome profile when the run ends
const chrome = spawn('google-chrome', [
  '--headless=new', '--mute-audio', '--no-sandbox', '--disable-gpu',
  '--window-size=1400,1000', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' })

let tabs = []
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    if (tabs.some(tab => tab.type === 'page')) break
  } catch { /* not up yet */ }
  await sleep(400)
}
const page = tabs.find(tab => tab.type === 'page')
if (!page) {
  console.error('chrome did not open a page')
  chrome.kill()
  process.exit(1)
}
const socket = new WebSocket(page.webSocketDebuggerUrl)
// Never leave a headless chrome behind: on any exit path, take it down with us.
process.on('exit', () => { try { chrome.kill() } catch { } })
process.on('unhandledRejection', error => { console.error('unhandled', error); try { chrome.kill() } catch { } process.exit(1) })
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
const cdp = (method, params = {}) => new Promise(resolve => {
  const id = ++counter
  const timer = setTimeout(() => { if (waiting.delete(id)) resolve({ __timeout: true, method }) }, 30000)
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
  const taken = await cdp('Page.captureScreenshot', { format: 'png' })
  if (!taken || !taken.data) { console.log('shot skipped (browser quiet)', name); return }
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(taken.data, 'base64'))
  shots.push(`${name}.png`)
  console.log('shot', name)
}

const hits = []
const clickAt = async (point, what) => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point[0], y: point[1] })
  const under = await evaluate(`(() => { const n = document.elementFromPoint(${point[0]}, ${point[1]}); return n ? n.tagName + ':' + (n.getAttribute && n.getAttribute('aria-label') || n.id || '') : '' })()`)
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: point[0], y: point[1], button: 'left', buttons: 1, clickCount: 1 })
  await sleep(30)
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point[0], y: point[1], button: 'left', buttons: 0, clickCount: 1 })
  await sleep(320)
  hits.push({ what, point, under })
}

const clickText = async (text, { exact = true, required = true } = {}) => {
  const spot = await evaluate(`(() => {
    const wanted = ${JSON.stringify(text)}
    const nodes = [...document.querySelectorAll('button,a,[role=button],summary,label')].filter(node => {
      const said = (node.textContent || '').trim()
      return ${exact ? 'said === wanted' : 'said.includes(wanted)'} && !node.disabled
    })
    let fallback = null
    const diag = []
    for (const found of nodes) {
      const box0 = found.getBoundingClientRect()
      found.scrollIntoView({ block: 'center' })
      const box = found.getBoundingClientRect()
      if (!box.width && !box.height) { diag.push({ t: (found.textContent || '').slice(0, 12), zero: true, w: Math.round(box0.width) }); continue }
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      const under = document.elementFromPoint(x, y)
      const owns = !!under && (under === found || found.contains(under))
      const probe = { x, y, owns, under: under ? under.tagName + ':' + (under.textContent || '').trim().slice(0, 30) : '', disabled: found.disabled === true }
      diag.push({ t: (found.textContent || '').slice(0, 12), owns, under: probe.under })
      if (owns) { window.__clickDiag = JSON.stringify(diag); return probe }
      if (!fallback) fallback = probe
    }
    window.__clickDiag = JSON.stringify(diag)
    return fallback
  })()`)
  if (!spot) {
    if (required) throw new Error(`no clickable button says ${JSON.stringify(text)}`)
    console.log('  ..click diag:', await evaluate('window.__clickDiag'))
    return false
  }
  if (!spot.owns) {
    // a hidden twin (template, pane copy) matched first: not truly clickable
    if (required) throw new Error(`${JSON.stringify(text)} is covered by ${spot.under}`)
    console.log('  ..click diag:', await evaluate('window.__clickDiag'))
    return false
  }
  if (spot.disabled) throw new Error(`${JSON.stringify(text)} is disabled`)
  await clickAt([spot.x, spot.y], `button:${text}`)
  return true
}

const waitFor = async (expression, what, seconds = 30) => {
  for (let step = 0; step < seconds * 4; step += 1) {
    const value = await evaluate(expression)
    if (value) return value
    if (step % 8 === 7) console.log(`  ..still waiting for ${what} (${step / 4}s)`)
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}`)
}

const debugState = async label => {
  const dbg = await evaluate('(() => ({ url: location.href, p: !!document.querySelector("[data-coach-panel]"), svg: !!document.querySelector(\'svg[aria-label^=chess]\'), t: document.body.innerText.slice(0, 300) }))()')
  console.log(`  state at ${label}:`, JSON.stringify(dbg))
}
const text = () => evaluate('document.body.innerText')

// A stuck proof ends itself: write what it saw and leave nonzero.
setTimeout(() => {
  console.log('FAIL proof watchdog: 35 minutes without finishing')
  console.log('last hits:', JSON.stringify(hits.slice(-4)))
  fs.writeFileSync(path.join(OUT, 'coach-proof.json'), JSON.stringify({ url: URL_BASE, shots, hits, failures: ['watchdog: proof exceeded 12 minutes'] }, null, 2))
  try { chrome.kill() } catch { }
  process.exit(1)
}, 2100000)

const failures = []
const check = (okay, message) => {
  if (!okay) failures.push(message)
  console.log(okay ? 'ok  ' : 'FAIL', message)
}

// The player: a python child that answers one line per move.
const mover = spawn('python3', [path.resolve('tools/coach_mover.py')], { cwd: process.cwd() })
const moverLines = readline.createInterface({ input: mover.stdout })
const moverQueue = []
moverLines.on('line', line => { if (moverQueue.length) moverQueue.shift()(JSON.parse(line)) })
const askMover = async moves => new Promise(resolve => {
  moverQueue.push(resolve)
  mover.stdin.write(JSON.stringify({ moves }) + '\n')
})

// --- the board: squares by name, pressed where they are drawn -----------------
// Scope to the play screen's own board: the home pane's mini chessboard is
// also an svg whose label starts "chess", and pressing ITS squares is pressing
// nothing a player meant to press.
const boardSvg = '.games-board-hero svg[aria-label^="chess"]'
const squarePoint = async name => {
  const spot = await evaluate(`(() => {
    const svg = document.querySelector(${JSON.stringify(boardSvg)})
    if (!svg) return null
    const vb = svg.viewBox.baseVal
    const cell = 36, pad = (vb.width - 8 * cell) / 2
    const files = 'abcdefgh'
    const col = files.indexOf(${JSON.stringify(name)}[0])
    const row = 8 - Number(${JSON.stringify(name)}[1])
    if (col < 0 || row < 0 || row > 7) return null
    const p = svg.createSVGPoint()
    p.x = pad + col * cell + cell / 2
    p.y = pad + row * cell + cell / 2
    const m = svg.getScreenCTM()
    if (!m) return null
    const o = p.matrixTransform(m)
    return [o.x, o.y]
  })()`)
  return spot && spot.length === 2 ? spot : null
}
const press = async name => {
  const point = await squarePoint(name)
  if (!point) {
    const dbg = await evaluate('(() => JSON.stringify({ svg: !!document.querySelector("svg[aria-label^=chess]"), t: document.body.innerText.slice(0, 200) }))()')
    console.log(`  no point for square ${name}, page state:`, dbg)
    throw new Error(`no point for square ${name}`)
  }
  await clickAt(point, `square ${name}`)
}
const playMove = async move => {
  await press(move.slice(0, 2))
  await press(move.slice(2, 4))
  // a pawn to the last rank asks which piece: the answer is always the queen here
  await clickText('Queen', { required: false })
}
const picture = async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const seen = await evaluate('fetch("/api/board?game=chessboard").then(r => r.json()).then(d => d.picture || d)')
    if (seen && seen.status !== undefined) return seen
    await sleep(600)
  }
  return {}
}

await cdp('Page.enable')
await cdp('Runtime.enable')
await cdp('Page.navigate', { url: URL_BASE })
await waitFor('document.readyState === "complete" && !!document.body.innerText', 'the page')
await sleep(1200)

// 0. The table is the real module on scratch storage; chess is installed by command.
await evaluate('fetch("/api/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ line: "install chessboard" }) }).then(r => r.json())')
await sleep(400)

// 1+2. Find where the app is, open chess, and reach a live board. A resumed session
// sits in one of several states: the library, the setup panel (maybe with its level
// buttons still disabled while the picture loads), a live board, or the result
// overlay of the last game (Rematch / Back). Each is handled the way a person
// would: press what is pressable, wait for the picture, and start over if the
// press did nothing.
const where = () => evaluate(`(() => {
  const t = document.body.innerText || ''
  const buttons = [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim())
  if (buttons.includes('Rematch')) return 'result'
  if (document.querySelector(${JSON.stringify(boardSvg)})) return 'board'
  if (t.includes('Choose how to play')) return 'setup'
  if (!t.includes('You vs Computer') && [...document.querySelectorAll('button,a,[role=button]')].some(b => /^Chess/.test((b.textContent || '').trim()))) return 'library'
  return ''
})()`)
const pressEnabled = async labels => {
  for (const label of labels) {
    const done = await evaluate(`(() => {
      const found = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === ${JSON.stringify(label)} && !b.disabled)
      if (!found) return null
      found.scrollIntoView({ block: 'center' })
      const box = found.getBoundingClientRect()
      const x = box.x + box.width / 2, y = box.y + box.height / 2
      const under = document.elementFromPoint(x, y)
      if (!(under && (under === found || found.contains(under)))) return null
      return { x, y }
    })()`)
    if (done) { await clickAt([done.x, done.y], `button:${labels[0]}`); return true }
  }
  return false
}
const confirmDialogOnce = async () => { try { await clickText('Confirm replace match', { required: false }) } catch { } }
const onBoardNow = async () => {
  const state = await evaluate(`(() => ({ svg: !!document.querySelector(${JSON.stringify(boardSvg)}), setup: (document.body.innerText || '').includes('Choose how to play') }))()`)
    || {}
  await confirmDialogOnce()
  const live = await evaluate('fetch("/api/board?game=chessboard").then(r => r.json()).then(d => { const p = d.picture || {}; return p.status }).catch(() => "")')
  return Boolean(state.svg) && !state.setup && live === 'active'
}
let seen = ''
for (let attempt = 0; attempt < 40 && !seen; attempt += 1) { seen = await where(); if (!seen) await sleep(500) }
if (!seen) throw new Error('the table never showed library, setup, board or result')
let opened = seen !== 'library'
if (seen === 'library') {
  opened = await clickText('Chess', { exact: true, required: false }) || await clickText('Chess', { exact: false })
  for (let attempt = 0; attempt < 40; attempt += 1) { const now = await where(); if (now) { seen = now; break }; await sleep(500) }
}
check(Boolean(opened), 'the chess card opened its own screen')

// The press that starts the match: Easy if the panel offers it, the panel's own
// button otherwise, Rematch when the last result is showing. Disabled buttons
// get one grace period (the picture fetch), then a reload, the way a person
// retries a stuck screen.
let boardShown = false
for (let round = 0; round < 4 && !boardShown; round += 1) {
  seen = (await where()) || seen
  if (seen === 'result') {
    await pressEnabled(['Rematch'])
  } else if (seen === 'setup') {
    const enabled = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'Easy'); return b ? !b.disabled : null })()`)
    if (enabled === false) {
      let free = false
      for (let wait = 0; wait < 20 && !free; wait += 1) {
        await sleep(1500)
        free = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'Easy'); return b ? !b.disabled : null })()`) === true
      }
      if (!free && round > 0) { await cdp('Page.reload'); await waitFor('document.readyState === "complete"', 'the reload'); await sleep(3000) }
    }
    if (!(await pressEnabled(['Easy', 'Normal', 'Hard']))) await pressEnabled(['Play the computer'])
  } else if (seen === 'board') {
    boardShown = await onBoardNow()
    if (boardShown) break
    // a board that is not live: end it, the overlay's Rematch then starts clean
    await evaluate('fetch("/api/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ line: "chessboard resign" }) }).then(r => r.json())')
    await sleep(1500)
    continue
  } else if (seen === 'library') {
    await clickText('Chess', { exact: true, required: false }) || await clickText('Chess', { exact: false })
  }
  for (let wait = 0; wait < 24; wait += 1) {
    if (await onBoardNow()) { boardShown = true; break }
    await sleep(2500)
    await confirmDialogOnce()
  }
  if (!boardShown) console.log(`  ..no live board on round ${round + 1}, state:`, JSON.stringify(await evaluate('(() => ({ t: document.body.innerText.slice(0, 120), dis: [...document.querySelectorAll("button")].filter(b => b.disabled).map(b => b.textContent.slice(0, 12)) }))()')))
}
check(boardShown, 'the chess board is on screen with a live match')
console.log('nav hits:', JSON.stringify(hits), '| seen:', seen)

// resume-proofing: the seat may be either colour and a half-played game may be
// showing; always begin the proof from a fresh board.
let pic0 = await picture()
if ((pic0.plies || 0) > 1 || pic0.status !== 'active') {
  // a half-played game is showing: resign it, then start clean the way the button does
  await evaluate('fetch("/api/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ line: "chessboard resign" }) }).then(r => r.json())')
  await sleep(600)
  await evaluate('fetch("/api/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ line: "allow-ai chessboard black=local" }) }).then(r => r.json())')
  await sleep(1500)
  pic0 = await picture()
}
check((pic0.seats || []).length >= 2 && pic0.status === 'active', 'the table seats a player and the machine')
const mine = (pic0.seats || []).find(seat => seat.kind === 'human')
const mySide = mine ? mine.side : 'white'

// 3. The coach names the opening and draws the book's moves as arrows.
// An opening begins with the first move (chessboard/coach.py): on an untouched board
// the card honestly says "No opening named yet". Press the book's own first move with
// the mouse, then ask the card for the name it can really give.
let picStart = await picture()
if (picStart.status === 'active' && picStart.turn === mySide && (picStart.plies || 0) === 0) {
  const first = ((picStart.coach || {}).book || []).filter(move => (picStart.legal || []).includes(move))[0]
  if (first) await playMove(first)
}
const coachPanel = () => evaluate('(() => { const p = document.querySelector("[data-coach-panel]"); return p ? p.innerText : "" })()')
let panelNow = ''
for (let wait = 0; wait < 24; wait += 1) {
  panelNow = await coachPanel()
  if (/[A-E]\d\d · /.test(panelNow || '') && /chess coach/i.test(panelNow || '')) break
  await sleep(1500)
}
if (!/chess coach/i.test(panelNow || '')) {
  const dbg = await evaluate('(() => JSON.stringify({ url: location.href, buttons: [...document.querySelectorAll("button")].map(b => b.textContent.trim()).slice(0, 25), t: document.body.innerText.slice(0, 400) }))()')
  console.log('  panel missing, page state:', dbg)
}
check(/chess coach/i.test(panelNow), 'the panel says what it is')
check(/[A-E]\d\d · /.test(panelNow), `the panel names an opening: ${(panelNow.match(/[A-E]\d\d · [^\n]+/) || [''])[0]}`)
const arrowsWhileBook = await evaluate(`(() => {
  const svg = document.querySelector(${JSON.stringify(boardSvg)})
  return svg ? svg.querySelectorAll('polygon').length : -1
})()`)
check(arrowsWhileBook >= 2, `the book moves are drawn as arrows (${arrowsWhileBook} arrowheads)`)
await shot('01-book-arrows')

// 4. Follow the book for as long as the tree agrees with the engine's replies.
let pic = await picture()
let bookPlies = 0
let bookOpen = true
for (let turn = 0; turn < 10; turn += 1) {
  if (!pic.coach || !pic.coach.in_book || pic.status !== 'active') { bookOpen = false; break }
  const book = (pic.coach.book || []).filter(move => (pic.legal || []).includes(move))
  if (!book.length) { bookOpen = false; break }
  if (pic.turn !== mySide) { await sleep(500); pic = await picture(); continue }
  await playMove(book[0])
  bookPlies += 1
  for (let wait = 0; wait < 12; wait += 1) {
    pic = await picture()
    if (pic.status !== 'active' || pic.turn === mySide) break
    await sleep(800)
  }
}
check(bookPlies >= 1, `the book was followed by mouse (${bookPlies} of our moves)`)

// 5. Then leave it, on purpose: a move no arrow pointed at.
let left = false
if (bookOpen && pic.status === 'active') {
  for (let attempt = 0; attempt < 6 && !left; attempt += 1) {
    pic = await picture()
    if (pic.status !== 'active') break
    if (pic.turn !== mySide) { await sleep(500); continue }
    const book = pic.coach && pic.coach.in_book ? pic.coach.book || [] : []
    if (!(pic.legal || []).length) break
    const options = (pic.legal || []).filter(move => !book.includes(move) && !move.startsWith('h2') && move !== 'a2a3')
    const choice = options.find(move => move[1] === '2' && move[3] === '4') || options[0]
    if (!choice) break
    await playMove(choice)
    for (let wait = 0; wait < 12; wait += 1) {
      pic = await picture()
      if (pic.status !== 'active' || pic.turn === mySide) break
      await sleep(800)
    }
    left = pic.coach && pic.coach.in_book === false
  }
} else {
  left = pic.coach ? pic.coach.in_book === false : false
}
let panelLeft = ''
if (left) {
  for (let wait = 0; wait < 10; wait += 1) {
    panelLeft = await coachPanel()
    if (/You left the book here/.test(panelLeft || '')) break
    await sleep(1500)
  }
}
check(left && /You left the book here/.test(panelLeft), `the panel says where the book ended: ${(panelLeft.match(/You left the book here[^\n]*/) || [(panelLeft || '').slice(0, 60)])[0]}`)
await shot('02-left-book')

// 6. Play on to an end. The mover chooses; the mouse does every press.
let games = 1
let result = ''
let hintDone = false
let hintBefore = ''
let hintSeen = false
while (games <= 3) {
  let guard = 0
  pic = await picture()
  while (pic.status === 'active' && guard < 220) {
    guard += 1
    if (pic.turn !== mySide) { await sleep(400); pic = await picture(); continue }
  // the model speaks only when asked: once, mid-game, on our turn, via Hint
  if (!hintDone && (pic.plies || 0) >= 2 && pic.turn === mySide) {
    hintDone = true
    hintBefore = await text()
    let hintClick = false
    for (let att = 0; att < 4 && !hintClick; att += 1) {
      hintClick = await clickText('Hint', { required: false })
      if (!hintClick) await sleep(1200)
    }
    console.log('  ..hint click:', hintClick)
    if (!hintClick) console.log('  ..buttons at hint time:', await evaluate("JSON.stringify([...document.querySelectorAll('button')].map(b=>(b.disabled?'!':'')+b.textContent.trim().slice(0,12)))"))
    if (hintClick) {
      for (let wait = 0; wait < 40; wait += 1) {
        if (/Hint: try /.test(await text())) { hintSeen = true; break }
        await sleep(2000)
      }
    }
  }
    const answer = await askMover(pic.moves || [])
    const move = answer && answer.move
    if (!move || !(pic.legal || []).includes(move)) {
      if (guard < 4) console.log('  ..mover answer unusable:', JSON.stringify({ answer, legal: (pic.legal || []).slice(0, 4), moves: (pic.moves || []).length }))
      await sleep(400); pic = await picture(); continue
    }
  await playMove(move)
    for (let wait = 0; wait < 20; wait += 1) {
      pic = await picture()
      if (pic.status !== 'active' || pic.turn === mySide) break
      await sleep(800)
    }
  }
  pic = await picture()
  result = pic.status || ''
  if (guard >= 220) console.log('  ..game loop hit its guard at status', result, 'turn', pic.turn, 'plies', pic.plies)
  if (result === 'win' || result === 'draw') break
  games += 1
  if (!(await clickText('Rematch', { required: false }))) break
  await waitFor(`!!document.querySelector(${JSON.stringify(boardSvg)})`, 'the next game', 20)
  await sleep(800)
}
check(result === 'win' || result === 'draw', `the game ended (${result}, ${games} game(s))`)
await shot('03-result')

// 7. Review: the coach names the opening, the leaving, the worst move and the better one.
if (result === 'win' || result === 'draw') {
  await clickText('Review my game')
  const review = await waitFor('document.querySelector("[data-coach-review]") && document.querySelector("[data-coach-review]").innerText', 'the review', 240)
  check(/Opening: /.test(review), 'the review names the opening')
  check(/Biggest mistake: move \d+/.test(review), `the review names the mistake: ${(review.match(/Biggest mistake[^\n]*/) || [''])[0]}`)
  check(/was better/.test(review), 'the review names the better move')
  check(/evaluated by/.test(review), `the review says who evaluated: ${(review.match(/evaluated by[^\n]*/) || [''])[0]}`)
  await shot('04-review')

  // 8. What the model said, only once asked, and the review's link is wired.
  check(hintSeen, 'the Hint ask answers with a concrete move')
  check(!/Hint: try /.test(hintBefore), 'nothing spoke before the ask')
  await shot('05-hint')

  const reviewBefore = await text()
  let whyClick = false
  for (let att = 0; att < 4 && !whyClick; att += 1) {
    whyClick = await clickText('Why this move?', { required: false })
    if (!whyClick) await sleep(1200)
  }
  console.log('  ..why click:', whyClick)
  let spoke = false
  for (let wait = 0; wait < 10 && !spoke; wait += 1) {
    spoke = (await text()).length > reviewBefore.length + 10
    if (!spoke) await sleep(1000)
  }
  if (!spoke) console.log('  ..page tail after why:', JSON.stringify(await evaluate('document.body.innerText.slice(-260)')))
  check(spoke, 'the review Why link answers when pressed')
}

const report = {
  url: URL_BASE, shots, hits, bookPlies, result, games, failures,
  errors: await evaluate('({ page: window.qa && window.qa.errors, console: window.qa && window.qa.consoleErrors })')
}
fs.writeFileSync(path.join(OUT, 'coach-proof.json'), JSON.stringify(report, null, 2))
console.log('\n' + (failures.length ? `FAILURES (${failures.length}):\n- ` + failures.join('\n- ') : 'every check passed'))
console.log('page errors:', JSON.stringify(report.errors))
console.log('shots:', shots.join(', '))

mover.kill()
await cdp('Browser.close').catch(() => {})
chrome.kill()
process.exit(failures.length ? 1 : 0)

// A timeout SIGTERMs the wrapper, not us — but if we get signalled, still bury the
// browser and mover, or orphaned chromes drown the QA server for the next run.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  try { mover.kill() } catch {}
  try { chrome.kill('SIGKILL') } catch {}
  process.exit(130)
})
