// Prove the Sea Battle screen with a real headless Chrome and a real mouse.
//
// Everything here is done the way a person does it: a level button is pressed by its words, a
// ship is pressed in the tray, dragged across the board and released on a square, and a shot is a
// click on an enemy square. Nothing types a move and nothing calls the command API.
//
//   node tools/seabattle_drive.mjs --url http://127.0.0.1:18820/ --out proof/sb
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
const URL_BASE = arg('url', process.env.GAMESHELF_QA_URL || 'http://127.0.0.1:18820/')
const OUT = path.resolve(arg('out', 'proof/sb'))
let PORT = Number(arg('port', String(9600 + (process.pid % 300))))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
fs.mkdirSync(OUT, { recursive: true })

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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-sea-'))
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
  await sleep(400)
}
const page = tabs.find(tab => tab.type === 'page')
if (!page) { console.error('chrome did not open a page'); stopChrome(); process.exit(1) }
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
  if (answer && answer.exceptionDetails) return { error: answer.exceptionDetails.text }
  return answer && answer.result ? answer.result.value : undefined
}
const failures = []
const check = (ok, said) => {
  console.log(ok ? 'ok  ' : 'FAIL', said)
  if (!ok) failures.push(said)
}

const shots = []
const shot = async name => {
  const taken = await cdp('Page.captureScreenshot', { format: 'png' })
  if (!taken || !taken.data) { console.log('shot skipped', name); return }
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(taken.data, 'base64'))
  shots.push(`${name}.png`)
  console.log('shot', name)
}

const pointer = async (from, to = from) => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from[0], y: from[1] })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: from[0], y: from[1], button: 'left', buttons: 1, clickCount: 1 })
  await sleep(40)
  for (let step = 1; step <= 6; step += 1) {
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: from[0] + (to[0] - from[0]) * step / 6, y: from[1] + (to[1] - from[1]) * step / 6,
      button: 'left', buttons: 1
    })
    await sleep(18)
  }
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to[0], y: to[1], button: 'left', buttons: 0, clickCount: 1 })
  await sleep(120)
}
const pressAt = point => cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: point[0], y: point[1], button: 'left', buttons: 1, clickCount: 1 })
const dragTo = async (point, from) => {
  for (let step = 1; step <= 8; step += 1) {
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: from[0] + (point[0] - from[0]) * step / 8, y: from[1] + (point[1] - from[1]) * step / 8,
      button: 'left', buttons: 1
    })
    await sleep(20)
  }
}
const releaseAt = async point => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point[0], y: point[1], button: 'left', buttons: 0, clickCount: 1 })
  await sleep(140)
}
const hoverAt = async point => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point[0], y: point[1] })
  await sleep(150)
}

// The board can settle a few pixels while a view refresh paints. Ask for the
// square's centre until two reads agree, so a real release lands on the square
// the picture shows, not on a neighbour from a stale layout.
const settledCenter = async selector => {
  let last = null
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const now = await center(selector)
    if (now && last && Math.abs(now[0] - last[0]) < 1 && Math.abs(now[1] - last[1]) < 1) return now
    last = now
    await sleep(150)
  }
  return last
}

// Hold the pointer over the named square until the browser itself agrees the
// pointer is on it and its position has stopped moving. Only then release.
const aimAt = async (selector, name) => {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const point = await center(selector)
    if (!point) return null
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point[0], y: point[1], button: 'left', buttons: 1 })
    await sleep(120)
    const under = await evaluate(`(() => { const n = document.elementFromPoint(${point[0]}, ${point[1]}); const c = n && n.closest('[data-sea-cell]'); return c ? c.dataset.seaCell : 'none' })()`)
    const again = await center(selector)
    if (under === name && again && Math.abs(again[0] - point[0]) < 1 && Math.abs(again[1] - point[1]) < 1) return point
    await sleep(120)
  }
  return null
}

const center = async selector => evaluate(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)})
  if (!node) return null
  const box = node.getBoundingClientRect()
  if (!box.width || !box.height) return null
  return [box.x + box.width / 2, box.y + box.height / 2]
})()`)

// The hit test the product rules ask for: whatever sits under the pointer at that point must be
// the control the script thinks it is about to press.
const hitAt = async (point, selector) => evaluate(`(() => {
  const node = document.elementFromPoint(${point[0]}, ${point[1]})
  if (!node) return false
  return Boolean(node.closest(${JSON.stringify(selector)})) ||
    [...document.querySelectorAll(${JSON.stringify(selector)})].some(other => other.contains(node))
})()`)

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
  await sleep(600)
  return true
}

const waitFor = async (expression, timeout = 20000, every = 150) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return true
    await sleep(every)
  }
  return false
}

// The table briefly says "not ready" while a move is being applied. A person
// waits for the board to settle before dragging; so does this driver: three
// clean checks in a row, not one lucky frame.
const waitStable = async (expression, timeout = 25000) => {
  const started = Date.now()
  let streak = 0
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) {
      streak += 1
      if (streak >= 3) return true
    } else {
      streak = 0
    }
    await sleep(250)
  }
  return false
}
const readyToPlace = `document.querySelector('.games-seabattle')?.dataset.seaCanplace === '1'`
const readyToFire = `document.querySelector('.games-seabattle')?.dataset.seaCanfire === '1'`

const text = () => evaluate('document.body.innerText')
const shotCount = async () => {
  const said = await evaluate(`(() => {
    const node = [...document.querySelectorAll('span')].find(n => /^Shots \\d+–\\d+$/.test(n.textContent.trim()))
    return node ? node.textContent.trim() : ''
  })()`)
  const found = /Shots (\d+)–(\d+)/.exec(String(said || ''))
  return found ? [Number(found[1]), Number(found[2])] : [0, 0]
}

// ---------------------------------------------------------------- the run
await cdp('Page.enable')
await cdp('Runtime.enable')
await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false })
await cdp('Page.navigate', { url: URL_BASE })
await sleep(2500)
if (!(await waitFor('document.body.innerText.length > 40', 20000))) {
  console.error('the page never rendered'); stopChrome(); process.exit(1)
}
// First run: one welcome panel, one Continue.
await waitFor(`document.body.innerText.includes('Welcome') || [...document.querySelectorAll('button')].some(n => n.textContent.includes('Sea Battle'))`, 30000)
if ((await text()).includes('Welcome')) {
  check(await clickText('Continue'), 'welcome: pressed Continue')
  await sleep(800)
}
await waitFor(`[...document.querySelectorAll('button')].some(n => n.textContent.includes('Sea Battle'))`, 40000)
check(await clickText('Sea Battle'), 'store: pressed the Sea Battle card')
// The level buttons arrive with the board picture. Under a loaded machine the first picture can
// take a while, so wait generously before falling back to the plain "Play the computer" door.
if (!(await waitFor(`[...document.querySelectorAll('button')].some(n => n.textContent.trim() === 'Beginner')`, 30000))) {
  check(await clickText('Play the computer'), 'started a game against the computer')
  await sleep(1200)
}
await waitFor(`[...document.querySelectorAll('button')].some(n => n.textContent.trim() === 'Beginner')`, 20000)
await sleep(600)
await shot('01-choose-levels')

// Four level buttons, no drop-down anywhere.
const levels = await evaluate(`[...document.querySelectorAll('button')].map(n => n.textContent.trim()).filter(t => ['Beginner','Intermediate','Advanced','Expert'].includes(t))`)
check(JSON.stringify(levels) === JSON.stringify(['Beginner', 'Intermediate', 'Advanced', 'Expert']), `four level buttons: ${JSON.stringify(levels)}`)
check(!(await evaluate(`Boolean(document.querySelector('.games-play-table select'))`)), 'no drop-down menu in the play screen')

check(await clickText('Beginner'), 'pressed Beginner')
await sleep(1500)
check(await waitFor(`Boolean(document.querySelector('[data-sea-board="own"]'))`, 20000), 'the placement board is on screen')
await shot('02-placement-empty')
check(await waitStable(readyToPlace), 'the placement board is ready for a drag')

// Drag the carrier from the tray onto a1, with the pointer held over the square for a picture.
const chip = await center('[data-sea-chip="carrier"]')
check(Boolean(chip), 'the carrier chip is in the tray')
const a1Selector = '[data-sea-board="own"] [data-sea-cell="a1"]'
let a1 = await settledCenter(a1Selector)
check(Boolean(a1) && Boolean(await hitAt(a1, '[data-sea-cell="a1"]')), 'a1 is under the pointer where the cell says it is')
await hoverAt(chip)
await pressAt(chip)
await sleep(120)
await dragTo(a1, chip)
a1 = await aimAt(a1Selector, 'a1')
check(Boolean(a1), 'the pointer is held over a1')
await shot('03-dragging-carrier')
await releaseAt(a1)
check(await waitFor(`!document.querySelector('[data-sea-chip="carrier"]')`), 'the carrier left the tray')
check(await waitStable(readyToPlace), 'the table is ready for the next ship')

const drops = [
  ['battleship', 'a3', 'h'],
  ['cruiser', 'a5', 'h'],
  // An upright ship hangs from the square it is dropped on, so its top square
  // is the anchor: f3 covers f3, f4 and f5 without leaving the board.
  ['submarine', 'f3', 'v'],
  ['destroyer', 'h7', 'v']
]
for (const [name, square, orient] of drops) {
  const start = await center(`[data-sea-chip="${name}"]`)
  if (!start) { check(false, `${name}: chip missing`); continue }
  if (orient === 'v') {
    // A click on the chip turns it: press and release in place, no drag.
    await pointer(start)
    await sleep(250)
  }
  const targetSelector = `[data-sea-board="own"] [data-sea-cell="${square}"]`
  let target = await settledCenter(targetSelector)
  if (!target) { check(false, `${name}: ${square} missing`); continue }
  const seaState = () => evaluate(`(() => { const n = document.querySelector('.games-seabattle'); return n ? n.dataset.seaHeld + '|' + n.dataset.seaCanplace + '|' + n.dataset.seaInteractive : 'none' })()`)
  console.log('debug', name, 'before press', await seaState())
  await pressAt(start)
  await sleep(80)
  console.log('debug', name, 'after press', await seaState())
  await dragTo(target, start)
  target = await aimAt(targetSelector, square)
  if (!target) { check(false, `${name}: the pointer never settled on ${square}`); continue }
  const under = square
  console.log('debug', name, 'over target', await seaState(), 'under', under)
  await releaseAt(target)
  await sleep(400)
  console.log('debug', name, 'after drop', await seaState())
  check(await waitFor(`!document.querySelector('[data-sea-chip="${name}"]')`), `${name} placed at ${square}`)
  await waitStable(readyToPlace)
}
await sleep(900)
await waitFor(`document.querySelectorAll('.games-sea-chip').length === 0`, 15000)
const placed = await evaluate(`document.querySelectorAll('.games-sea-chip').length`)
check(placed === 0, 'the tray is empty')
const hullCells = await evaluate(`document.querySelectorAll('[data-sea-board="own"] [data-sea-cell] span').length`)
check(hullCells > 0, 'hulls are drawn on your own board')
await shot('04-fleet-placed')

// The other side places, then the battle starts.
check(await waitFor(`document.body.innerText.includes('Your turn: fire at enemy waters')`, 30000), 'the battle started by itself')
check(await waitStable(readyToFire), 'the enemy waters accept a click')

// Fire real clicks, one square after another, until the fleet is down.
let fired = 0
let won = false
let stalled = 0
const startedFiring = Date.now()
outer: for (let row = 0; row < 10; row += 1) {
  for (let col = 0; col < 10; col += 1) {
    if (await evaluate(`Boolean([...document.querySelectorAll('div[role=status]')].find(n => /win|wins/i.test(n.textContent)))`)) { won = true; break outer }
    if (Date.now() - startedFiring > 600000) { console.log('firing took too long; stopping'); break outer }
    const name = `${'abcdefghij'[col]}${10 - row}`
    const enemySelector = `[data-sea-board="enemy"] [data-sea-cell="${name}"]`
    const spot = await aimAt(enemySelector, name)
    if (!spot) break
    const before = await shotCount()
    await pointer(spot)
    fired += 1
    // Wait for the table to answer: the shot counter moves, or the game ends.
    const moved = await waitFor(`(() => {
      const node = [...document.querySelectorAll('span')].find(n => /^Shots \\d+–\\d+$/.test(n.textContent.trim()))
      const found = node ? /Shots (\\d+)–(\\d+)/.exec(node.textContent.trim()) : null
      return Boolean(found) && (Number(found[1]) > ${before[0]} || Boolean([...document.querySelectorAll('div[role=status]')].find(x => /win|wins/i.test(x.textContent))))
    })()`, 6000)
    if (!moved) {
      stalled += 1
      if (stalled >= 2) { console.log('the table stopped answering at', name); break outer }
    } else {
      stalled = 0
    }
    // Wait until the table is ready for the next shot (the computer has answered).
    await waitStable(`document.querySelector('.games-seabattle')?.dataset.seaCanfire === '1' ||
      Boolean([...document.querySelectorAll('div[role=status]')].find(x => /win|wins/i.test(x.textContent)))`, 12000)
    if (fired === 1) await shot('05-first-shot')
    if (fired === 12) await shot('06-battle-midgame')
    if (fired > 110) break outer
  }
}
check(fired > 0, `fired ${fired} shots with the mouse`)
if (!won) won = await waitFor(`Boolean([...document.querySelectorAll('div[role=status]')].find(n => /win|wins|Game over/i.test(n.textContent)))`, 12000)
check(won, 'the game ended with a clear result')
await sleep(600)
await shot('07-result')
const ending = await text()
check(/You win|computer wins|Game over/.test(ending), 'the end overlay says who won')

// Narrow window: the same table at 640x900, boards stacked.
await cdp('Emulation.setDeviceMetricsOverride', { width: 640, height: 900, deviceScaleFactor: 1, mobile: false })
await sleep(700)
const wideSide = await evaluate(`(() => {
  const own = document.querySelector('[data-sea-board="own"]')
  const enemy = document.querySelector('[data-sea-board="enemy"]')
  if (!own || !enemy) return 'missing'
  const a = own.getBoundingClientRect()
  const b = enemy.getBoundingClientRect()
  return b.top >= a.bottom - 2 ? 'stacked' : 'side by side'
})()`)
check(wideSide === 'stacked', `narrow window stacks the boards (${wideSide})`)
const overflow = await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1')
check(Boolean(overflow), 'no horizontal scroll at 640 px')
await shot('08-narrow')
await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false })
await sleep(500)

// Two people on one keyboard: the pass-the-screen cover after the first fleet.
await clickText('Back')
// Coming back from a finished game the store card can take a moment to appear again on a busy
// machine, so wait for each door instead of sleeping a fixed time.
check(await waitFor(`Boolean([...document.querySelectorAll('button')].find(n => n.textContent.trim().startsWith('Sea Battle')))`, 25000), 'back on the store with the Sea Battle card')
check(await clickText('Sea Battle'), 'store: the Sea Battle card again')
check(await waitFor(`[...document.querySelectorAll('button')].some(n => n.textContent.trim() === 'Same screen (pass and play)')`, 25000), 'the pass-and-play door is on screen')
check(await clickText('Same screen (pass and play)', { exact: true }), 'pressed Same screen (pass and play)')
await sleep(1200)
if (await waitFor(`Boolean(document.querySelector('[aria-label="Ship tray"]'))`, 15000)) {
  await waitStable(readyToPlace)
  const random = await evaluate(`(() => {
    const found = [...document.querySelectorAll('button')].find(n => n.textContent.trim() === 'Random fleet')
    if (!found) return null
    const box = found.getBoundingClientRect()
    return [box.x + box.width / 2, box.y + box.height / 2]
  })()`)
  if (random) { await pointer(random); await sleep(1200) }
  await waitFor(`/Pass the screen|Both fleets are hidden/.test(document.body.innerText)`, 20000)
  await shot('09-pass-the-screen')
  const covered = await text()
  check(/Pass the screen|Both fleets are hidden/.test(covered), 'the second player gets a cover, not the first fleet')
  console.log('debug cover buttons', await evaluate(`[...document.querySelectorAll('button')].map(n => n.textContent.trim() + (n.disabled ? ' [off]' : '')).filter(t => /screen|cover|fleet|hidden/i.test(t))`))
  check(await waitFor(`Boolean([...document.querySelectorAll('button')].find(n => n.textContent.includes('I have the screen') && !n.disabled))`, 10000), 'the cover offers the screen button')
  check(await clickText('I have the screen'), 'pressed I have the screen')
  check(await waitFor(`!document.body.innerText.includes('Pass the screen')`, 15000), 'the cover lifted')
  check(await waitFor(`Boolean(document.querySelector('[aria-label="Ship tray"]'))`, 15000), 'the second fleet tray is on screen')
  await shot('10-second-fleet')
} else {
  check(false, 'pass-and-play never reached a ship tray')
}

stopChrome()
const report = { shots, failures, url: URL_BASE }
fs.writeFileSync(path.join(OUT, 'drive-report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))
process.exit(failures.length ? 1 : 0)
