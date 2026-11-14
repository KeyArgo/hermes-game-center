// tests/pane_fill_checks.mjs -- the pane's contents fill the pane, measured in a real browser.
//
//   node tests/pane_fill_checks.mjs [--port 18840] [--shots DIR]
//
// The Node harness (tests/table_ui_harness.cjs) can read the style props a render hands back; only a
// browser can say what actually lays out. This starts the isolated QA server
// (tests/browser_table_server.py) and drives muted headless Chrome against its pane page, /pane?w=,
// whose own frame stands in for the Desktop's divider.
//
// The pane opens at 720 px and drags from 300 px to 1200 px, but its pieces were laid out for
// ~360 px - two small game columns and a board with a width of its own. At every width the lobby
// must fill the pane (>= 90% of it), nothing may scroll sideways, the game tiles must use the
// width, and the board must fill its column with the turn beside it once there is room.
//
// Exit code 1 means a width really does not fill. 77 means this machine cannot run the check (the QA
// server cannot start, usually no uvicorn), which the Python wrapper turns into a skip.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = Number(arg('port', String(18840 + (process.pid % 60))))
const SHOTS = arg('shots', '')
const URL_BASE = `http://127.0.0.1:${PORT}/`
const CHROME = process.env.CHROME_BIN || (fs.existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : 'google-chrome')
// The QA server is Python; the interpreter that started this check is the one that has uvicorn.
const PYTHON = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

// 300 px is the narrowest the divider goes, 720 px is where the pane opens, and 320 px and 1000 px are
// the two the check is asked for. 640 px is the frame the wide rules switch on at.
const WIDTHS = [300, 320, 640, 720, 1000]

// The pinned React modules come from the repo when they are there (no network), the way the other
// browser checks do it.
const vendor = path.join(ROOT, 'online', 'web', 'vendor')
const env = { ...process.env }
if (!env.GAMESHELF_REACT_ASSETS && fs.existsSync(path.join(vendor, 'react.mjs'))) {
  env.GAMESHELF_REACT_ASSETS = vendor
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-fill-'))
const server = spawn(PYTHON, [path.join(ROOT, 'tests/browser_table_server.py'),
  '--root', path.join(scratch, 'root'), '--port', String(PORT)],
  { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
let serverLog = ''
let serverGone = ''
server.on('error', error => { serverGone = String((error && error.message) || error) })
server.stdout.on('data', chunk => { serverLog += chunk })
server.stderr.on('data', chunk => { serverLog += chunk })
const stopServer = () => { try { server.kill('SIGKILL') } catch { /* gone */ } }
process.on('exit', () => { stopServer(); try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ } })

let up = false
for (let attempt = 0; attempt < 120; attempt += 1) {
  if (serverGone) break
  try {
    const answer = await fetch(URL_BASE)
    if (answer.ok) { up = true; break }
  } catch { /* not listening yet */ }
  await sleep(500)
}
if (!up) {
  const missing = /No module named '([^']+)'/.exec(serverLog)
  console.log(`skipped: the QA server did not start${missing ? ` (no ${missing[1]})` : serverGone ? ` (${serverGone})` : ''}`)
  if (serverLog.trim()) console.log(serverLog.slice(-1200))
  process.exit(77)
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-fill-chrome-'))
const chrome = spawn(CHROME, ['--headless=new', '--mute-audio', '--no-sandbox', '--disable-gpu',
  '--window-size=1500,900', `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
let chromeGone = ''
chrome.on('error', error => { chromeGone = String((error && error.message) || error) })
process.on('exit', () => { try { chrome.kill('SIGKILL') } catch { /* gone */ } try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10 }) } catch { /* best effort */ } })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(130))

let tabs = []
for (let i = 0; i < 80; i += 1) {
  if (chromeGone) break
  try {
    tabs = await (await fetch(`http://127.0.0.1:${PORT + 1}/json`)).json()
    if (tabs.some(tab => tab.type === 'page')) break
  } catch { /* Chrome is still coming up */ }
  await sleep(400)
}
const page = tabs.find(tab => tab.type === 'page')
if (!page) {
  if (chromeGone) {
    console.log(`skipped: no browser to lay the pane out (${chromeGone})`)
    process.exit(77)
  }
  console.error('no page: Chrome did not start')
  process.exit(1)
}
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(resolve => { socket.onopen = resolve })
let counter = 0
const waiting = new Map()
const exceptions = []
socket.onmessage = message => {
  const data = JSON.parse(message.data)
  if (data.id && waiting.has(data.id)) { waiting.get(data.id)(data.result || data.error || {}); waiting.delete(data.id); return }
  if (data.method === 'Runtime.exceptionThrown') exceptions.push(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text)
}
const cdp = (method, params = {}) => new Promise(resolve => {
  const id = ++counter
  const timer = setTimeout(() => { waiting.delete(id); resolve({ __timeout: true }) }, 20000)
  waiting.set(id, answer => { clearTimeout(timer); resolve(answer) })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const answer = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (answer && answer.exceptionDetails) return { error: answer.exceptionDetails.text }
  return answer && answer.result ? answer.result.value : undefined
}
const screenshot = async name => {
  if (!SHOTS) return ''
  fs.mkdirSync(SHOTS, { recursive: true })
  const shot = await cdp('Page.captureScreenshot', { format: 'png' })
  if (!shot || !shot.data) return ''
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(shot.data, 'base64'))
  return path.join(SHOTS, `${name}.png`)
}

// The page a check opens: the pane frame at this width, with a game chosen so the lobby and the
// board are both drawn.
const measure = () => evaluate(`(() => {
  const pane = document.querySelector('#pane')
  const root = pane && pane.querySelector('.games-wait-pane')
  const body = pane && pane.querySelector('.games-pane-body')
  const grid = pane && pane.querySelector('.games-pane-games')
  const board = pane && pane.querySelector('.games-pane-board')
  const main = pane && pane.querySelector('.games-pane-board-main')
  const status = pane && pane.querySelector('.games-pane-board-status')
  const stage = main && main.querySelector('.games-board-stage')
  const lobby = pane && pane.querySelector('.games-pane-lobby')
  const online = pane && pane.querySelector('.games-pane-online')
  const rect = element => {
    if (!element) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    const box = element.getBoundingClientRect()
    return { left: Math.round(box.left), top: Math.round(box.top), right: Math.round(box.right), bottom: Math.round(box.bottom), width: Math.round(box.width), height: Math.round(box.height) }
  }
  const tracks = element => (element ? getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length : 0)
  const columns = tracks(grid)
  const sections = tracks(body)
  // The board draws into its own aspect ratio inside the box it is given, so a box that is wider
  // than the drawn board is empty space the person sees. The artwork is what must fill the column.
  const box = stage && stage.querySelector('svg')
  let artwork = 0
  if (box) {
    const view = (box.getAttribute('viewBox') || '').split(/\s+/).map(Number)
    const ratio = view.length === 4 && view[3] ? view[2] / view[3] : 1
    const drawn = box.getBoundingClientRect()
    artwork = Math.round(Math.min(drawn.width, drawn.height * ratio))
  }
  return {
    hasBody: Boolean(body),
    hasBoardCells: Boolean(main && status),
    artwork,
    columns,
    sections,
    gridWidth: grid ? Math.round(grid.getBoundingClientRect().width) : 0,
    pane: rect(pane),
    root: rect(root),
    rootScrollWidth: root ? root.scrollWidth : 0,
    rootClientWidth: root ? root.clientWidth : 0,
    rootOverflowX: root ? root.scrollWidth - root.clientWidth : 0,
    body: rect(body),
    bodyOverflowX: body ? body.scrollWidth - body.clientWidth : 0,
    board: rect(board),
    main: rect(main),
    status: rect(status),
    stage: rect(stage),
    lobby: rect(lobby),
    online: rect(online),
    containerType: root ? getComputedStyle(root).containerType : '',
    rootContent: root && root.clientWidth
      ? Math.round(root.clientWidth - (parseFloat(getComputedStyle(root).paddingLeft) || 0) - (parseFloat(getComputedStyle(root).paddingRight) || 0))
      : 0,
    bodyColumns: body ? getComputedStyle(body).gridTemplateColumns : ''
  }
})()`)

for (const width of WIDTHS) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: width + 500, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp('Page.navigate', { url: `${URL_BASE.replace(/\/$/, '')}/pane?w=${width}` })
  // The pane reads /view, then the board: wait until the tiles are drawn.
  let drawn = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(250)
    // A game tile and a board: drawn in both the old layout and the new one, so a check that fails
    // below is failing on a measurement, not on a page that never arrived.
    drawn = await evaluate("!!(document.querySelector('.games-wait-pane [data-game-tile]') && document.querySelector('.games-wait-pane .games-board-stage'))")
    if (drawn) break
  }
  if (!drawn) {
    check(`the pane draws at ${width} px`, false, 'no tiles or board after ten seconds')
    continue
  }
  // The board is measured against its own cell, and that measurement arrives from a resize
  // observer, which lands a frame or so after the board is drawn: settle until the board's box has
  // held still for a second and a half before reading anything.
  let seen = await measure()
  let still = 0
  for (let settle = 0; settle < 30 && still < 6; settle += 1) {
    await sleep(250)
    const again = await measure()
    still = seen.stage && again.stage && seen.stage.height === again.stage.height && seen.stage.width === again.stage.width
      ? still + 1 : 0
    seen = again
  }
  const where = `${width} px`
  // A container query measures the container's content box, which is the pane minus its own padding:
  // that is the width the wide rules in the pane answer to.
  const wide = seen.rootContent >= 640
  check(`the pane root is its own container at ${where}`, seen.containerType === 'inline-size',
    `container-type: ${seen.containerType}`)
  check(`the pane is the frame it was given at ${where}`, Math.abs(seen.pane.width - width) <= 1,
    `pane is ${seen.pane.width} px`)
  check(`the pane's sections are one grid at ${where}`, seen.hasBody, 'no .games-pane-body in the pane')
  check(`the board has its own cells at ${where}`, seen.hasBoardCells,
    'no .games-pane-board-main / .games-pane-board-status in the pane')
  if (!seen.hasBody || !seen.hasBoardCells || !seen.pane.width) continue

  // The game view uses the pane's width, not a column of its own.
  const share = seen.body.width / seen.pane.width
  check(`the game view fills the pane at ${where}`, share >= 0.9,
    `game list ${seen.body.width} px of ${seen.pane.width} px (${(share * 100).toFixed(1)}%)`)
  check(`nothing in the game view scrolls sideways at ${where}`, seen.rootOverflowX <= 0 && seen.bodyOverflowX <= 0,
    `root ${seen.rootOverflowX} px, game list ${seen.bodyOverflowX} px over`)

  // The sections: one column in a narrow pane, two when there is room.
  if (wide) {
    check(`the sections sit side by side at ${where}`, seen.sections === 2, `${seen.sections} columns: ${seen.bodyColumns}`)
  } else {
    check(`the sections stack at ${where}`, seen.sections <= 1, `${seen.sections} columns: ${seen.bodyColumns}`)
  }

  // The tiles use the width: two to a row at 300-320 px, four or more across a wide pane (the tile
  // grid fills its own section column, and the sections themselves are two).
  const across = seen.columns * Math.max(1, seen.sections)
  const least = wide ? 4 : 2
  check(`the game tiles use the width at ${where}`, across >= least,
    `${seen.columns} tile columns x ${seen.sections} sections = ${across} across: ${seen.bodyColumns}`)
  const sectionWidth = wide ? (seen.body.width - 10) / 2 : seen.body.width
  check(`the tile grid fills its column at ${where}`, seen.gridWidth >= 0.9 * sectionWidth,
    `tiles ${seen.gridWidth} px in a section column of ${Math.round(sectionWidth)} px`)

  // The board grows with the pane, and the side info moves beside it when there is room. What must
  // fill the column is the drawn board, not the box it is drawn in.
  const boardShare = seen.main.width ? seen.artwork / seen.main.width : 0
  check(`the board fills its column at ${where}`, boardShare >= 0.8,
    `drawn board ${seen.artwork} px of a ${seen.main.width} px column`)
  if (wide) {
    check(`the turn sits beside the board at ${where}`, seen.status.left >= seen.main.right - 1,
      `status left ${seen.status.left}, board right ${seen.main.right}`)
    check(`the board keeps the room at ${where}`, seen.main.width > seen.status.width,
      `board ${seen.main.width} px, side ${seen.status.width} px`)
  } else {
    check(`the turn sits under the board at ${where}`, seen.status.top >= seen.main.bottom - 1,
      `status top ${seen.status.top}, board bottom ${seen.main.bottom}`)
  }
  const file = await screenshot(`pane-${width}`)
  if (file) console.log(`      screenshot ${file}`)

  // The lobby: the people beside you on the left, online play on the right. Two columns when the
  // pane is wide, one when it is narrow, and the pair must use the pane's width.
  await evaluate(`(() => {
    const tab = [...document.querySelectorAll('#pane button')].find(button => (button.textContent || '').trim() === 'Lobby')
    if (tab) tab.click()
    return Boolean(tab)
  })()`)
  await sleep(400)
  const lobby = await measure()
  if (!lobby.lobby.width || !lobby.online.width) {
    check(`the lobby draws at ${where}`, false, 'no .games-pane-lobby / .games-pane-online in the pane')
    continue
  }
  const lobbyShare = lobby.body.width / lobby.pane.width
  check(`the lobby fills the pane at ${where}`, lobbyShare >= 0.9,
    `lobby ${lobby.body.width} px of ${lobby.pane.width} px (${(lobbyShare * 100).toFixed(1)}%)`)
  check(`nothing in the lobby scrolls sideways at ${where}`, lobby.rootOverflowX <= 0 && lobby.bodyOverflowX <= 0,
    `root ${lobby.rootOverflowX} px, lobby ${lobby.bodyOverflowX} px over`)
  if (wide) {
    check(`the lobby sits in two columns at ${where}`,
      Math.abs(lobby.lobby.top - lobby.online.top) <= 1 && lobby.online.left >= lobby.lobby.right - 1,
      `left column ${lobby.lobby.left}-${lobby.lobby.right}, right column ${lobby.online.left}-${lobby.online.right}, tops ${lobby.lobby.top}/${lobby.online.top}`)
  } else {
    check(`the lobby stacks in one column at ${where}`, lobby.online.top >= lobby.lobby.bottom - 1,
      `first column ends at ${lobby.lobby.bottom}, second starts at ${lobby.online.top}`)
  }
  const lobbyFile = await screenshot(`pane-${width}-lobby`)
  if (lobbyFile) console.log(`      screenshot ${lobbyFile}`)
}

if (exceptions.length) check('no page exception while the pane lays out', false, exceptions.slice(0, 2).join(' | '))

const errors = await evaluate('(qa.errors || []).concat(qa.consoleErrors || [])')
if (Array.isArray(errors) && errors.length) check('no console errors from the pane', false, String(errors.slice(0, 2)))

socket.close()
if (failures.length) {
  console.error(`\n${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nall pane fill checks passed')
process.exit(0)
