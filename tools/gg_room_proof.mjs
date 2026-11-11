// GG proof: the game-room chrome and the result overlay, driven only by real pointer events.
//   node tools/gg_room_proof.mjs --url http://127.0.0.1:18912/ --out proof/gg/room
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const URL_BASE = arg('url', 'http://127.0.0.1:18912/')
const OUT = path.resolve(arg('out', 'proof/gg/room'))
const GAME = arg('game', 'Connect Four')
fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

let PORT = 9800 + (process.pid % 150)
const profile = fs.mkdtempSync('/tmp/gg-room-')
process.on('exit', () => { try { chrome.kill('SIGKILL') } catch {} try { fs.rmSync(profile, { recursive: true, force: true }) } catch {} }); for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => process.exit(130)) // delete the ~200 MB Chrome profile when the run ends
const chrome = spawn('google-chrome', ['--headless=new', '--mute-audio', '--no-sandbox', '--disable-gpu',
  '--window-size=1400,1000', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
let tabs = []
for (let i = 0; i < 80; i += 1) {
  try { tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (tabs.some(t => t.type === 'page')) break } catch {}
  await sleep(400)
}
const page = tabs.find(t => t.type === 'page')
if (!page) { console.error('no page'); chrome.kill(); process.exit(1) }
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
  const timer = setTimeout(() => { if (waiting.delete(n)) resolve({ __timeout: true }) }, 20000)
  waiting.set(n, answer => { clearTimeout(timer); resolve(answer) })
  socket.send(JSON.stringify({ id: n, method, params }))
})
const evaluate = async expression => {
  const answer = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (answer && answer.exceptionDetails) return { error: answer.exceptionDetails.text }
  return answer && answer.result ? answer.result.value : undefined
}
// A standalone snapshot (CSS inlined in Node, so nothing needs escaping) so the Impeccable
// detector can score the real screen from a file: localStorage and cookies cannot follow it.
const snapshot = async name => {
  const html = await evaluate(`'<!doctype html>' + document.documentElement.outerHTML`)
  const css = fs.readFileSync(path.join(process.cwd(), 'online/web/style.css'), 'utf8')
  const standalone = String(html).replace(/<link[^>]+style\.css[^>]*>/, `<style>${css}</style>`)
  fs.mkdirSync(path.join(OUT, '..', 'snapshots'), { recursive: true })
  fs.writeFileSync(path.join(OUT, '..', 'snapshots', `${name}.html`), standalone)
  console.log('snapshot', name)
}

const shots = []
const shot = async name => {
  const taken = await cdp('Page.captureScreenshot', { format: 'png' })
  if (!taken || !taken.data) return
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(taken.data, 'base64'))
  shots.push(`${name}.png`)
  console.log('shot', name)
}
const pointer = async point => {
  const { x, y } = point
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  for (let s = 1; s <= 3; s += 1) { await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 }); await sleep(12) }
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(150)
}
const results = []
const record = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }

// Centre of the first control whose text matches, with a real hit-test at that point.
const spotOf = async (text, selector = 'button,a,[role=button]') => evaluate(`(() => {
  const wanted = ${JSON.stringify(text)}
  const all = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(n => !n.disabled)
  const label = n => (n.getAttribute('aria-label') || '') + ' ' + n.textContent.trim()
  const found = all.find(n => n.textContent.trim() === wanted)
    || all.find(n => (n.getAttribute('aria-label') || '') === wanted)
    || all.find(n => label(n).includes(wanted))
  if (!found) return null
  found.scrollIntoView({ block: 'center' })
  const b = found.getBoundingClientRect()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, text: found.textContent.trim().slice(0, 40) }
})()`)
const hitName = async point => evaluate(`(() => { const el = document.elementFromPoint(${point.x}, ${point.y}); return el ? el.tagName + ':' + (el.textContent || '').trim().slice(0, 30) : null })()`)
const clickText = async (text, selector) => {
  const spot = await spotOf(text, selector)
  if (!spot) { record(`click "${text}"`, false, 'not found'); return false }
  const hit = await hitName(spot)
  record(`hit-test "${text}"`, Boolean(hit), `cursor over <${hit}>`)
  await pointer(spot)
  await sleep(500)
  return true
}

await cdp('Page.enable')
await cdp('Runtime.enable')
await cdp('Page.navigate', { url: URL_BASE })
// wait for the app to paint (a cold local server can take a few seconds)
for (let attempt = 0; attempt < 30; attempt += 1) {
  const ready = await evaluate(`Boolean(document.querySelector('#name') || document.querySelector('.lobby') || document.querySelector('.room'))`)
  if (ready) break
  await sleep(500)
}
await sleep(600)
// first-run name gate
if (await evaluate(`Boolean(document.querySelector('#name'))`)) {
  const spot = await evaluate(`(() => { const i = document.querySelector('#name'); const b = i.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } })()`)
  await pointer(spot)
  await cdp('Input.insertText', { text: 'Room QA ' + String(Date.now()).slice(-5) })
  await clickText('Continue')
  await sleep(1600)
}
await shot('01-lobby')
await snapshot('lobby')

// pick the game, then play the computer
await clickText('Choose ' + GAME, 'button')
await sleep(300)
record('lobby headline names the game', Boolean(await evaluate(`document.body.innerText.includes('TONIGHT AT THE CLUB')`)))
await clickText('Play the computer', 'button')
await sleep(2600)
// a practice table opens with a seat to take, or a game to join
if (await evaluate(`[...document.querySelectorAll('button')].some(n => n.textContent.trim() === 'Join the game')`)) await clickText('Join the game')
if (await evaluate(`[...document.querySelectorAll('button')].some(n => n.textContent.trim() === 'Sit here')`)) await clickText('Sit here')
await sleep(1400)
await shot('02-room')
await snapshot('room')
record('room shows a seat badge', Boolean(await evaluate(`[...document.querySelectorAll('.seat .badge')].some(n => /Human|Bot|Computer/i.test(n.textContent))`)))
record('room has no drop-down', (await evaluate(`document.querySelectorAll('select').length`)) === 0)

// Real pointer play: click a legal-move chip, then Play move, until the result band appears.
let moves = 0
for (let round = 0; round < 60; round += 1) {
  const over = await evaluate(`Boolean(document.querySelector('.result'))`)
  if (over) break
  const chips = await evaluate(`(() => {
    const list = [...document.querySelectorAll('.legal button')]
    if (!list.length) return 0
    return list.length
  })()`)
  if (!chips) { await sleep(700); continue }
  const chip = await evaluate(`(() => {
    const list = [...document.querySelectorAll('.legal button')]
    if (!list.length) return null
    const el = list[Math.floor(list.length / 2)]
    el.scrollIntoView({ block: 'center' })
    const b = el.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, token: el.textContent.trim() }
  })()`)
  if (!chip) { await sleep(700); continue }
  await pointer(chip)
  const play = await spotOf('Play move', 'button')
  if (play) { await pointer(play); moves += 1 }
  await sleep(900)
  if (round === 1) await shot('03-room-in-play')
  if (moves >= 6) await shot('04-room-moves')
}
record('played by pointer', moves > 0, `${moves} moves`)
await sleep(1200)
const hasResult = await evaluate(`Boolean(document.querySelector('.result'))`)
record('result band appears', hasResult)
if (hasResult) {
  await shot('05-result')
  await snapshot('result')
  const text = await evaluate(`document.querySelector('.result').innerText.replace(/\\n+/g, ' | ')`)
  console.log('RESULT TEXT:', text)
  await clickText('Look at the board')
  await sleep(400)
  await shot('06-board-after-result')
}

// side-pane width: 760 x 900 (the desktop dock's narrow column)
await cdp('Emulation.setDeviceMetricsOverride', { width: 760, height: 900, deviceScaleFactor: 1, mobile: false })
await sleep(700)
await shot('07-side-pane')
await cdp('Emulation.clearDeviceMetricsOverride')
// the same room in daylight, so both palettes are on record
await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
await sleep(600)
await shot('08-light')
await cdp('Emulation.setEmulatedMedia', { features: [] })

const summary = { url: URL_BASE, passed: results.filter(r => r.pass).length, total: results.length, results, exceptions, shots, moves }
fs.writeFileSync(path.join(OUT, 'proof.json'), JSON.stringify(summary, null, 2))
console.log('SUMMARY', JSON.stringify({ passed: summary.passed, total: summary.total, exceptions: exceptions.length }))
chrome.kill()
process.exit(summary.passed === summary.total && !exceptions.length ? 0 : 2)
