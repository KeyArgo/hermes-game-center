// GG proof: the Doctrine Arena stage (the desktop plugin's canvas), in a real muted headless Chrome.
// Serves the built plugin.js + the sdk shim + the vendored react modules, renders
// coverArt('doctrine-arena', 560) and drives the replay controls with real pointer events.
//   node tools/gg_arena_proof.mjs --out proof/gg/arena
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const OUT = path.resolve(arg('out', 'proof/gg/arena'))
fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Doctrine Arena</title>
<style>
  body { margin: 0; background: #0b0a09; color: #f7f3ec; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; padding: 22px; }
  .frame { max-width: 980px; }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; margin-bottom: 10px; }
  .head h1 { font-family: "Iowan Old Style", Palatino, Georgia, serif; font-size: 26px; font-weight: 600; margin: 0; letter-spacing: -.015em; }
  .head span { font-size: 11px; letter-spacing: .09em; text-transform: uppercase; color: #948d80; }
</style>
<script type="importmap">{"imports":{"react":"/vendor/react.mjs","react/jsx-runtime":"/vendor/jsx-runtime.mjs","react-dom/client":"/vendor/client.mjs","@hermes/plugin-sdk":"/sdk-shim.js"}}</script>
</head><body>
<div class="frame"><div class="head"><h1>Doctrine Arena</h1><span>replay · muted</span></div><div id="root"></div></div>
<script type="module">
import { createElement } from '/vendor/react.mjs'
import { createRoot } from '/vendor/client.mjs'
import { coverArt } from '/plugin.js'
createRoot(document.getElementById('root')).render(createElement('div', null, coverArt('doctrine-arena', 560)))
</script></body></html>`

const ROOT = process.cwd()
const FILES = {
  '/': () => ['text/html', PAGE],
  '/plugin.js': () => ['text/javascript', fs.readFileSync(path.join(ROOT, 'desktop/plugin.js'))],
  '/sdk-shim.js': () => ['text/javascript', fs.readFileSync(path.join(ROOT, 'online/web/sdk-shim.js'))],
  '/vendor/react.mjs': () => ['text/javascript', fs.readFileSync(path.join(ROOT, 'online/web/vendor/react.mjs'))],
  '/vendor/jsx-runtime.mjs': () => ['text/javascript', fs.readFileSync(path.join(ROOT, 'online/web/vendor/jsx-runtime.mjs'))],
  '/vendor/client.mjs': () => ['text/javascript', fs.readFileSync(path.join(ROOT, 'online/web/vendor/client.mjs'))],
  '/vendor/scheduler.mjs': () => ['text/javascript', fs.readFileSync(path.join(ROOT, 'online/web/vendor/scheduler.mjs'))],
  '/vendor/react-dom.mjs': () => ['text/javascript', fs.readFileSync(path.join(ROOT, 'online/web/vendor/react-dom.mjs'))]
}
const server = createServer((request, response) => {
  const route = FILES[request.url.split('?')[0]]
  if (!route) { response.writeHead(404); response.end('no'); return }
  const [type, body] = route()
  response.writeHead(200, { 'Content-Type': type })
  response.end(body)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const PORT = server.address().port

const profile = fs.mkdtempSync('/tmp/gg-arena-')

process.on('exit', () => { try { chrome.kill('SIGKILL') } catch {} try { fs.rmSync(profile, { recursive: true, force: true }) } catch {} }); for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => process.exit(130)) // delete the ~200 MB Chrome profile when the run ends
const debugPort = 9900 + (process.pid % 90)
const chrome = spawn('google-chrome', ['--headless=new', '--mute-audio', '--no-sandbox', '--disable-gpu',
  '--window-size=1100,820', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
let tabs = []
for (let attempt = 0; attempt < 80; attempt += 1) {
  try { tabs = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json(); if (tabs.some(t => t.type === 'page')) break } catch {}
  await sleep(400)
}
const page = tabs.find(t => t.type === 'page')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(resolve => { socket.onopen = resolve })
let counter = 0
const waiting = new Map()
const exceptions = []
socket.onmessage = message => {
  const data = JSON.parse(message.data)
  if (data.id && waiting.has(data.id)) { waiting.get(data.id)(data.result || {}); waiting.delete(data.id); return }
  if (data.method === 'Runtime.exceptionThrown') exceptions.push(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text)
}
const cdp = (method, params = {}) => new Promise(resolve => {
  const id = ++counter
  const timer = setTimeout(() => { if (waiting.delete(id)) resolve({}) }, 20000)
  waiting.set(id, answer => { clearTimeout(timer); resolve(answer) })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const answer = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  return answer && answer.result ? answer.result.value : undefined
}
const shots = []
const shot = async name => {
  const taken = await cdp('Page.captureScreenshot', { format: 'png' })
  if (!taken.data) return
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(taken.data, 'base64'))
  shots.push(`${name}.png`)
  console.log('shot', name)
}
const pointer = async spot => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(40)
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(250)
}
const results = []
const record = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }
const spotOf = async text => evaluate(`(() => {
  const found = [...document.querySelectorAll('button')].find(n => n.textContent.trim().startsWith(${JSON.stringify(text)}))
  if (!found) return null
  found.scrollIntoView({ block: 'center' })
  const box = found.getBoundingClientRect()
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
})()`)
const hitName = async spot => evaluate(`(() => { const el = document.elementFromPoint(${spot.x}, ${spot.y}); return el ? el.tagName + ':' + el.textContent.trim().slice(0, 24) : null })()`)

await cdp('Page.enable')
await cdp('Runtime.enable')
await cdp('Log.enable')
socket.addEventListener('message', message => {
  const data = JSON.parse(message.data)
  if (data.method === 'Log.entryAdded') console.log('LOG', data.params.entry.level, data.params.entry.text, data.params.entry.url || '')
})
await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(2500)
record('canvas painted', (await evaluate(`document.querySelectorAll('canvas').length`)) > 0, `${await evaluate(`document.querySelectorAll('canvas').length`)} canvas`)
await shot('01-arena-opening')
await sleep(5000)
await shot('02-arena-fight')

// the controls: no bracket labels, and each one is a real button under the pointer
const labels = await evaluate(`[...document.querySelectorAll('button')].map(n => n.textContent.trim())`)
record('no bracket state labels', !labels.some(text => text.includes('[')), labels.join(' | ').slice(0, 120))
for (const wanted of ['Half speed']) {
  const spot = await spotOf(wanted)
  if (!spot) { record(`control "${wanted}"`, false, 'not found'); continue }
  const hit = await hitName(spot)
  record(`hit-test "${wanted}"`, Boolean(hit && /BUTTON/i.test(hit.split(':')[0])), `cursor over <${hit}>`)
  await pointer(spot)
}
await sleep(400)
// This stage has no frames (a preview, not a stored battle), so the motion controls are
// correctly disabled: assert that rather than pretending a replay ran.
record('motion controls disabled without a replay', await evaluate(`[...document.querySelectorAll('button')].filter(n => /Half speed|Pause|Play|Replay/.test(n.textContent)).every(n => n.disabled)`))
await shot('03-arena-half-speed')
for (const wanted of ['Sound', 'Pause', 'Replay']) {
  const spot = await spotOf(wanted)
  if (!spot) { record(`control "${wanted}"`, false, 'not found'); continue }
  const hit = await hitName(spot)
  record(`hit-test "${wanted}"`, Boolean(hit && /BUTTON/i.test(hit.split(':')[0])), `cursor over <${hit}>`)
  await pointer(spot)
  await sleep(250)
}

// narrow column, the size of the side pane
await cdp('Emulation.setDeviceMetricsOverride', { width: 700, height: 900, deviceScaleFactor: 1, mobile: false })
await sleep(800)
await shot('04-arena-narrow')
await cdp('Emulation.clearDeviceMetricsOverride')

// A standalone DOM snapshot of the real stage, so the Impeccable detector can score the
// screen from a file (the page's CSS is already inline in the template).
const arenaHtml = await evaluate(`'<!doctype html>' + document.documentElement.outerHTML`)
fs.mkdirSync(path.join(OUT, '..', 'snapshots'), { recursive: true })
fs.writeFileSync(path.join(OUT, '..', 'snapshots', 'arena.html'), String(arenaHtml))

fs.writeFileSync(path.join(OUT, 'proof.json'), JSON.stringify({ passed: results.filter(r => r.pass).length, total: results.length, results, exceptions, shots }, null, 2))
console.log('SUMMARY', JSON.stringify({ passed: results.filter(r => r.pass).length, total: results.length, exceptions: exceptions.slice(0, 3) }))
chrome.kill()
server.close()
process.exit(results.every(r => r.pass) && !exceptions.length ? 0 : 2)
