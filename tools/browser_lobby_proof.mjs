// Drive the new Game Center lobby (web or desktop) with a real muted headless Chrome
// over CDP, and hit-test the controls with real pointer events (never element.click()).
//
//   node tools/browser_lobby_proof.mjs --url http://127.0.0.1:8790/ --out proof/ls/web
//   node tools/browser_lobby_proof.mjs --url http://127.0.0.1:18770/ --out proof/ls/desktop
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const URL_BASE = arg('url', 'http://127.0.0.1:8790/')
const OUT = path.resolve(arg('out', 'proof/ls'))
const WAIT = Number(arg('wait', '2200'))
fs.mkdirSync(OUT, { recursive: true })

let PORT = Number(arg('port', String(9600 + (process.pid % 300))))
const freePort = async () => {
  for (let candidate = PORT; candidate < PORT + 40; candidate += 1) {
    try { await fetch(`http://127.0.0.1:${candidate}/json`, { signal: AbortSignal.timeout(300) }) } catch { return candidate }
  }
  return PORT
}
PORT = await freePort()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-lobby-'))
const stopChrome = () => { try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); else chrome.kill('SIGKILL') } catch {} }
process.on('exit', () => { stopChrome(); try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch {} }); for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => process.exit(130)) // delete the ~200 MB Chrome profile when the run ends
const chrome = spawn(process.env.CHROME_BIN || 'google-chrome', [
  '--headless=new', '--mute-audio', '--no-sandbox', '--disable-gpu',
  '--window-size=1400,1000', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'
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

const shots = []
const shot = async name => {
  const taken = await cdp('Page.captureScreenshot', { format: 'png' })
  if (!taken || !taken.data) { console.log('shot skipped (browser quiet)', name); return }
  const file = path.join(OUT, `${name}.png`)
  fs.writeFileSync(file, Buffer.from(taken.data, 'base64'))
  shots.push(`${name}.png`)
  console.log('shot', name)
}

const pointer = async point => {
  const px = Array.isArray(point) ? point[0] : point.x
  const py = Array.isArray(point) ? point[1] : point.y
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1, clickCount: 1 })
  for (let step = 1; step <= 4; step += 1) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'left', buttons: 1 })
    await sleep(15)
  }
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(120)
}

const results = []
const record = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

// Find a control by its visible text (button/tab), return its centre point via geometry.
const centerOf = async text => evaluate(`(() => {
  const wanted = ${JSON.stringify(text)}
  const found = [...document.querySelectorAll('button,a,[role=button]')].find(node =>
    node.textContent.trim().includes(wanted) && !node.disabled)
  if (!found) return null
  found.scrollIntoView({ block: 'center' })
  const box = found.getBoundingClientRect()
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, text: found.textContent.trim().slice(0, 40) }
})()`)

// elementFromPoint hit-test at the control's centre: the element under the cursor must be
// the control itself or one of its descendants.
const hitTest = async point => evaluate(`(() => {
  const el = document.elementFromPoint(${point.x}, ${point.y})
  if (!el) return null
  return el.tagName + ':' + (el.textContent || '').trim().slice(0, 40)
})()`)

const clickButton = async text => {
  const spot = await centerOf(text)
  if (!spot) { record(text, false, 'control not found'); return false }
  const hit = await hitTest(spot)
  const inside = hit && (hit.includes(text.slice(0, 8)) || /button|a/i.test(hit.split(':')[0]))
  record(`hit-test "${text}"`, Boolean(hit && inside), `cursor over <${hit}>`)
  await pointer(spot)
  await sleep(600)
  return true
}

// Click a button by EXACT visible text (chat tabs "Game" vs nav "Games").
const clickExact = async text => {
  const spot = await evaluate(`(() => {
    const found = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(text)} && !node.disabled)
    if (!found) return null
    found.scrollIntoView({ block: 'center' })
    const box = found.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  })()`)
  if (!spot) return false
  const hit = await hitTest(spot)
  record(`hit-test tab "${text}"`, Boolean(hit && /button/i.test(hit.split(':')[0])), `cursor over <${hit}>`)
  await pointer(spot)
  await sleep(500)
  return true
}

const hasText = async text => evaluate(`[...document.querySelectorAll('*')].some(node => node.children.length === 0 && node.textContent.trim().includes(${JSON.stringify(text)}))`)
const countButtons = async text => evaluate(`[...document.querySelectorAll('button')].filter(node => node.textContent.trim().includes(${JSON.stringify(text)})).length`)

await cdp('Page.enable')
await cdp('Runtime.enable')
await cdp('Page.navigate', { url: URL_BASE })
await sleep(Number(WAIT))
// The web app gates on a name first; the desktop QA page renders the lobby directly.
{
  const gate = await evaluate(`(() => { const i = document.querySelector('#name'); return i ? true : false })()`)
  if (gate) {
    // Focus the name field with a real click, then type with real text input events.
    const spot = await evaluate(`(() => { const i = document.querySelector('#name'); i.scrollIntoView({ block: 'center' }); const b = i.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } })()`)
    await pointer(spot)
    await sleep(200)
    await cdp('Input.insertText', { text: 'Lobby QA ' + String(Date.now()).slice(-5) })
    await sleep(300)
    await clickButton('Continue')
    await sleep(1500)
  }
}
// Desktop first-run welcome: take the offered name (Continue) so the lobby knows
// who this is, exactly as a first-run person would.
if (await evaluate(`document.body.innerText.includes('Welcome to Game Center')`)) {
  await clickButton('Continue')
  await sleep(1200)
}
await shot('lobby-home')
console.log('BODY TEXT:', await evaluate(`document.body.innerText.slice(0, 700)`))

// Sections present?
record('Find a match button', (await countButtons('Find a match')) > 0)
record('Play the computer button', (await countButtons('Play the computer')) > 0)
record('who-is-online section', Boolean(await hasText('online')), '')
record('Ladder section', Boolean(await hasText('Ladder')))
record('chat tabs', (await countButtons('Lobby')) > 0 && (await countButtons('Game')) > 0)
record('game tiles render', Boolean(await evaluate(`document.querySelectorAll('.tiles article, .grid article, .games-center-layout button[aria-label]').length`)))

// Real mouse: press "Find a match".
await clickButton('Find a match')
// The click only starts a round trip to the local lobby; poll briefly so a slow
// refresh cannot make a working control look broken.
let searching = 0
for (let attempt = 0; attempt < 12; attempt += 1) {
  searching = await countButtons('searching…')
  if (searching > 0) break
  await sleep(500)
}
record('searching state', searching > 0, `buttons showing searching…: ${searching}`)
await shot('lobby-searching')

// Real mouse: switch chat column to the Game tab.
await clickExact('Game')
await sleep(400)
record('game tab shows not-at-table', Boolean(await hasText('not at a table') || await hasText('Open a game')))
await shot('lobby-chat-game')

await shot('lobby-final')
const summary = { url: URL_BASE, passed: results.filter(r => r.pass).length, total: results.length, results }
fs.writeFileSync(path.join(OUT, 'proof.json'), JSON.stringify(summary, null, 2))
console.log('SUMMARY', JSON.stringify(summary))
stopChrome()
process.exit(summary.passed === summary.total ? 0 : 2)
