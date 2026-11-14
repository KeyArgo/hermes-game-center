// tests/backgammon_play.mjs -- Backgammon is playable by pointing, in a real browser.
//
//   node tests/backgammon_play.mjs [--port 18720] [--shots DIR]
//
// Two things only a real layout and a real click can answer: whether a person can work out how to
// move a piece, and whether the dice visibly roll. So this drives headless Chrome against
// tests/browser_table_server.py --
// which serves the REAL built plugin and runs the REAL commands -- and plays the game by mouse:
//
//   roll   on your turn the dice wait behind Roll; pressing it lands two (or four, on a double)
//          dice on the values the ENGINE actually rolled, and while it is a fresh roll the board
//          will not move anything;
//   pick   clicking a checker lights the points its dice can reach, and clicking a lit point
//          (or dropping a dragged checker on it) sends `backgammon move <token>`;
//   play   at least three of the person's own moves are made this way, each one changing the
//          board the server reports back.
//
// Exit 1 is a real regression.
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
const PORT = Number(arg('port', String(18720 + (process.pid % 60))))
const SHOTS = arg('shots', '')
const URL_BASE = `http://127.0.0.1:${PORT}/`
const CHROME = process.env.CHROME_BIN || (fs.existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : 'google-chrome')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// The QA server needs fastapi/uvicorn; the python3 first on PATH often lacks them.
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-play-'))
const server = spawn(PYTHON, [path.join(ROOT, 'tests/browser_table_server.py'),
  '--root', path.join(scratch, 'root'), '--port', String(PORT), '--game', 'backgammon'],
{ cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
let serverLog = ''
server.stdout.on('data', chunk => { serverLog += chunk })
server.stderr.on('data', chunk => { serverLog += chunk })
const stopServer = () => { try { server.kill('SIGKILL') } catch { /* gone */ } }
process.on('exit', () => { stopServer(); try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ } })

let up = false
for (let attempt = 0; attempt < 120; attempt += 1) {
  try { const answer = await fetch(URL_BASE); if (answer.ok) { up = true; break } } catch { /* not listening yet */ }
  await sleep(500)
}
if (!up) { console.error('the QA server never answered on', URL_BASE, '\n', serverLog.slice(-2000)); process.exit(1) }

// ---------------------------------------------------------------- chrome
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-play-chrome-'))
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
// Wait until something is true, so a slow first paint is not read as a broken board.
const waitFor = async (fn, timeout = 20000, step = 300) => {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await fn()) return true
    await sleep(step)
  }
  return false
}
const clickText = async text => {
  const done = await evaluate(`(() => {
    const n = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === ${JSON.stringify(text)})
    if (!n) return false
    n.click()
    return true
  })()`)
  await sleep(2500)
  return done
}
// A real mouse click at the centre of an element, so hit-testing is exercised rather than
// Element.click() short-circuiting it.
const mouseClick = async selector => {
  const box = await evaluate(`(() => {
    const n = document.querySelector(${JSON.stringify(selector)})
    if (!n) return null
    const r = n.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  if (!box) return false
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(500)
  return true
}
// Drag a checker from one point to another with real mouse moves (the other boards drag; so
// does this one).
const mouseDrag = async (fromSelector, toSelector) => {
  const boxes = await evaluate(`(() => {
    const box = sel => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
    return { from: box(${JSON.stringify(fromSelector)}), to: box(${JSON.stringify(toSelector)}) }
  })()`)
  if (!boxes || !boxes.from || !boxes.to) return false
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: boxes.from.x, y: boxes.from.y })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: boxes.from.x, y: boxes.from.y, button: 'left', clickCount: 1 })
  for (let step = 1; step <= 4; step += 1) {
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseMoved', button: 'left',
      x: boxes.from.x + (boxes.to.x - boxes.from.x) * step / 4,
      y: boxes.from.y + (boxes.to.y - boxes.from.y) * step / 4
    })
  }
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: boxes.to.x, y: boxes.to.y, button: 'left', clickCount: 1 })
  await sleep(900)
  return true
}
const apiPicture = async () => (await (await fetch(`${URL_BASE}api/board?game=backgammon`)).json()).picture
const boardFacts = () => evaluate(`(() => {
  const svg = document.querySelector('svg[aria-label="Backgammon board"]')
  const status = document.querySelector('.games-status')
  const dice = [...document.querySelectorAll('[data-bg-die]')].map(n => Number(n.getAttribute('data-bg-die')))
  const polys = [...document.querySelectorAll('svg[aria-label="Backgammon board"] polygon[data-bg-point]')]
  return {
    svg: !!svg,
    dice,
    lit: polys.filter(n => String(n.getAttribute('fill')).toLowerCase() === '#e6c85a').map(n => n.getAttribute('data-bg-point')),
    marked: polys.filter(n => String(n.getAttribute('stroke')).toLowerCase() === '#ffe36a').map(n => n.getAttribute('data-bg-point')),
    movesLeft: (document.querySelector('[data-bg-moves-left]') || {}).getAttribute
      ? document.querySelector('[data-bg-moves-left]').getAttribute('data-bg-moves-left') : null,
    roll: !!document.querySelector('[data-bg-roll]'),
    turn: (() => { const n = document.querySelector('[data-bg-turn]'); return n ? n.getAttribute('data-bg-turn') : null })(),
    phase: (() => { const n = document.querySelector('[data-bg-phase]'); return n ? n.getAttribute('data-bg-phase') : null })(),
    hint: (document.querySelector('[data-bg-hint]') || {}).textContent || '',
    status: status ? status.textContent.trim().replace(/\\s+/g, ' ') : '',
    calls: (window.qa && window.qa.calls) || [],
    errors: (window.qa && window.qa.errors) || [],
    consoleErrors: (window.qa && window.qa.consoleErrors) || []
  }
})()`)

await cdp('Page.enable')
await cdp('Runtime.enable')
await cdp('Page.navigate', { url: URL_BASE })
await sleep(6000)
await evaluate(`(() => {
  const n = [...document.querySelectorAll('button')].find(b => ['Continue', 'Skip for now'].includes((b.textContent || '').trim()))
  if (n) n.click()
  return !!n
})()`)
await sleep(2500)

// ---------------------------------------------------------------- sit down
const offered = await waitFor(async () => evaluate('!!document.querySelector(\'[data-game-tile="backgammon"]\')'), 30000)
check('the Games page offers Backgammon', offered === true)
const opened = await click('[data-game-tile="backgammon"]')
check('Backgammon opens', opened === true)
await sleep(2500)
const started = await clickText('Play the computer')
check('Backgammon starts against the computer', started === true)
const drawn = await waitFor(async () => { const f = await boardFacts(); return Boolean(f && f.svg) }, 20000)
check('the backgammon board is drawn', drawn === true)
// The table is busy for a moment while the start command settles, so wait for the board to
// that person's turn before reading it: a person waits for their turn too.
const mine = await waitFor(async () => { const f = await boardFacts(); return f && f.turn === 'mine' }, 20000)
check('it is this person\'s turn at the board', mine === true)
let facts = await boardFacts()
check('the page reports no script errors', Boolean(facts && facts.errors.length === 0 && facts.consoleErrors.length === 0),
  JSON.stringify(facts && { errors: facts.errors, consoleErrors: facts.consoleErrors }))

// ---------------------------------------------------------------- the roll
// A fresh turn's dice wait behind Roll: the roll has to be seen.
check('a fresh turn offers a Roll button', Boolean(facts && facts.roll), JSON.stringify({ roll: facts.roll, dice: facts.dice, turn: facts.turn }))
check('the board says what to do with the dice', Boolean(facts && /Roll|move|Tap/i.test(facts.hint || '')), JSON.stringify(facts && facts.hint))
check('the status line names the roll', Boolean(facts && /Your turn — roll/.test(facts.status)), JSON.stringify(facts && facts.status))
await shot('bg-roll-waiting')

let before = await apiPicture()
check('the engine has already rolled two dice for the turn',
  Array.isArray(before.dice) && (before.dice.length === 2 || before.dice.length === 4), JSON.stringify(before.dice))
const double = before.dice.length === 4 && before.dice[0] === before.dice[1]

// Watch the board's own phase while the roll happens: the button must give way to a real tumble
// (the phase AND the CSS class the keyframes hang off), not just a swap of values.
await evaluate(`(() => {
  window.qa.bgPhases = []
  if (window.qa.bgWatch) window.qa.bgWatch.disconnect()
  const record = () => {
    const n = document.querySelector('[data-bg-phase]')
    if (!n) return
    window.qa.bgPhases.push(n.getAttribute('data-bg-phase') + (document.querySelector('.bg-die-rolling') ? '+tumble' : ''))
  }
  record()
  window.qa.bgWatch = new MutationObserver(record)
  window.qa.bgWatch.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-bg-phase'] })
  return true
})()`)
await click('[data-bg-roll]')
await shot('bg-rolling')
await sleep(1400)
const phases = await evaluate('window.qa.bgPhases')
check('pressing Roll tumbles the dice rather than just showing them',
  Array.isArray(phases) && phases.includes('rolling+tumble'), JSON.stringify(phases))
const motionRule = await evaluate(`(() => {
  const own = [...document.querySelectorAll('style')].map(n => String(n.textContent)).find(t => t.includes('bg-tumble'))
  if (!own) return 'no board stylesheet'
  const text = own.replace(/\\s+/g, ' ')
  const at = text.indexOf('prefers-reduced-motion')
  if (at < 0) return 'no reduced-motion query'
  const tail = text.slice(at, at + 160)
  return tail.includes('bg-die-rolling') && tail.includes('animation: none') ? true : tail
})()`)
check('the tumble is switched off under prefers-reduced-motion', motionRule === true, JSON.stringify(motionRule))
facts = await boardFacts()
const sorted = list => [...list].map(Number).sort().join(',')
check('the dice come to rest on the values the engine rolled',
  sorted(facts.dice) === sorted(before.dice), `board ${sorted(facts.dice)} vs engine ${sorted(before.dice)}`)
check('a double lands four dice', !double || facts.dice.length === 4, `dice ${facts.dice.length}`)
check('the Roll button is gone once the dice have landed', facts.roll === false, JSON.stringify({ roll: facts.roll, phase: facts.phase }))
check('the board counts the moves the dice leave',
  Number(facts.movesLeft) === facts.dice.length, JSON.stringify({ movesLeft: facts.movesLeft, dice: facts.dice }))
check('the status line turns to the move', Boolean(facts && /Your turn — move/.test(facts.status)), JSON.stringify(facts && facts.status))

// ---------------------------------------------------------------- pick and move
const pointSelector = name => `[data-bg-point="${name}"]`
const pick = async token => {
  const parts = String(token).split('-')
  const from = parts[0], to = parts[1]
  const before = await apiPicture()
  const callsBefore = (await boardFacts()).calls.length
  // The checker: a point's own checker when it has one, else the point itself.
  const source = from === 'bar'
    ? '[data-bg-point="bar"]'
    : (await evaluate(`(() => !!document.querySelector('[data-bg-checker="${from}"]'))()`)
      ? `[data-bg-checker="${from}"]` : pointSelector(from))
  await mouseClick(source)
  const picked = await boardFacts()
  if (to === 'off') {
    const armed = await evaluate(`(() => { const n = document.querySelector('[data-bg-off]'); return !!n && !n.disabled })()`)
    check(`picking point ${from} arms the Bear off button`, armed === true,
      JSON.stringify({ hint: picked.hint, roll: picked.roll, marked: picked.marked }))
  } else {
    check(`picking point ${from} lights its destination ${to}`, picked.lit.includes(String(to)),
      JSON.stringify({ source, turn: picked.turn, lit: picked.lit, marked: picked.marked, roll: picked.roll, hint: picked.hint, dice: picked.dice }))
  }
  await shot(`bg-picked-${from}`)
  if (to === 'off') await mouseClick('[data-bg-off]')
  else await mouseClick(pointSelector(to))
  await sleep(1400)
  const after = await apiPicture()
  const facts = await boardFacts()
  const moved = facts.calls.slice(callsBefore).some(line => line === `backgammon move ${token}`)
  const changed = JSON.stringify(after.points) !== JSON.stringify(before.points)
  return { token, moved, changed, points: after.points, dice: after.dice, status: facts.status }
}

// ---------------------------------------------------------------- three of your own moves
let played = 0
const attempts = []
for (let step = 0; step < 10 && played < 3; step += 1) {
  // A person waits for their turn before touching the board; so does this.
  await waitFor(async () => { const f = await boardFacts(); return f.turn === 'mine' }, 12000)
  let state = await boardFacts()
  if (state.roll) {
    await click('[data-bg-roll]')
    await sleep(1200)
    state = await boardFacts()
  }
  const pictured = await apiPicture()
  const legal = (pictured.legal || []).filter(token => token !== 'pass')
  if (!legal.length) {
    // Nothing to do with these dice: the table's own rule is to pass.
    await click('[data-bg-pass]')
    await sleep(1500)
    attempts.push({ pass: true })
    continue
  }
  const token = legal[0]
  const attempt = await pick(token)
  attempts.push(attempt)
  if (attempt.moved && attempt.changed) played += 1
  await sleep(600)
}

check(`at least three of your own moves landed by clicking (played ${played})`, played >= 3,
  JSON.stringify(attempts))
check('every move the board sent was the engine\'s own token',
  attempts.filter(item => item.token).every(item => /^(bar|[1-9]|1[0-9]|2[0-4])-([1-9]|1[0-9]|2[0-4]|off)-\d$/.test(item.token)),
  JSON.stringify(attempts.map(item => item.token)))
const finalFacts = await boardFacts()
check('the page still reports no script errors',
  Boolean(finalFacts.errors.length === 0 && finalFacts.consoleErrors.length === 0),
  JSON.stringify({ errors: finalFacts.errors, consoleErrors: finalFacts.consoleErrors }))
await shot('bg-played')

// ---------------------------------------------------------------- a drag moves a checker too
await waitFor(async () => { const f = await boardFacts(); return f.turn === 'mine' }, 12000)
const dragState = await boardFacts()
if (dragState.roll) { await click('[data-bg-roll]'); await sleep(1200) }
const dragPic = await apiPicture()
const dragToken = (dragPic.legal || []).find(token => token !== 'pass' && String(token).split('-')[0] !== 'bar' && String(token).split('-')[1] !== 'off')
if (dragToken) {
  const [from, to] = String(dragToken).split('-')
  const before = JSON.stringify((await apiPicture()).points)
  const hasChecker = await evaluate(`(() => !!document.querySelector('[data-bg-checker="${from}"]'))()`)
  if (hasChecker) {
    await mouseDrag(`[data-bg-checker="${from}"]`, pointSelector(to))
    await sleep(1200)
    const draggedPic = await apiPicture()
    check('dragging a checker onto a lit point moves it', JSON.stringify(draggedPic.points) !== before,
      `token ${dragToken}, from ${from} to ${to}`)
  } else {
    console.log(`info drag skipped: point ${from} has no checker shape of its own`)
  }
} else {
  console.log('info drag skipped: no plain point-to-point move is on offer this turn')
}

// ---------------------------------------------------------------- verdict
stopChrome()
stopServer()
if (failures.length) {
  console.error(`\n${failures.length} backgammon play check(s) failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('\nall backgammon play checks passed')
