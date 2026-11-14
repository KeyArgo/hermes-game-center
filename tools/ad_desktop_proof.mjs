// Desktop Admin tab proof: the real desktop/plugin.js rendered in muted headless
// Chrome against a live local lobby, driven with real pointer events only.
//
// The page is served by a small QA server in this file that maps the plugin's
// `ctx.rest('/online/...')` calls onto the lobby's /api/admin/... doors, exactly
// as dashboard/plugin_api.py does. Hermes itself is never started or restarted.
//
//   node tools/ad_desktop_proof.mjs --out proof/ad/desktop
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const ROOT = path.resolve('.')
const OUT = path.resolve(arg('out', 'proof/ad/desktop'))
fs.mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-ad-desktop-'))
const cli = execFileSync(process.env.PYTHON || 'python3',
  ['-m', 'online.admin', '--data', dataDir, 'grant-owner', 'Owner'], { cwd: ROOT, encoding: 'utf8' })
const staffKey = /Staff key \(shown once, keep it out of chat and the repo\): (\S+)/.exec(cli)[1]
const ownerKey = /Recovery key \(shown once, sign in with it\): (\S+)/.exec(cli)[1]

const PORT = await (async () => {
  const net = await import('node:net')
  for (let candidate = 18960 + (process.pid % 30); candidate < 19010; candidate += 1) {
    const free = await new Promise(resolve => {
      const probe = net.createServer()
      probe.once('error', () => resolve(false))
      probe.once('listening', () => probe.close(() => resolve(true)))
      probe.listen(candidate, '127.0.0.1')
    })
    if (free) return candidate
  }
  throw new Error('no free port for the lobby')
})()
const server = spawn(process.env.PYTHON || 'python3',
  ['-m', 'online.server', '--data', dataDir, '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' })
const LOBBY = `http://127.0.0.1:${PORT}`
for (let attempt = 0; attempt < 100; attempt += 1) {
  try { if ((await fetch(LOBBY + '/api/health', { signal: AbortSignal.timeout(400) })).ok) break } catch {}
  await sleep(200)
}

const HARNESS = `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{
  "@hermes/plugin-sdk":"/sdk.js",
  "react":"/vendor/react.mjs",
  "react/jsx-runtime":"/vendor/jsx-runtime.mjs",
  "react-dom/client":"/vendor/client.mjs"
}}</script>
<style>html,body,#root{height:100%;margin:0;background:#0f151d;color:#e8edf3;font:14px system-ui}</style>
</head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`

const SDK = `export const host = { navigate() {}, request: async () => ({}) }
export const useValue = value => value
export const PALETTE_AREA = 'palette'
export const PANES_AREA = 'panes'
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'nav'
export const STATUSBAR_AREAS = { right: 'right' }`

const HARNESS_JS = `import plugin from '/plugin.js'
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
const LOBBY = location.origin + '/lobby'
const token = localStorage.getItem('qa.token') || ''
const staff = localStorage.getItem('qa.staff') || ''
let me = { role: '', name: '', powers: [] }
function headers(extra) {
  const out = { Accept: 'application/json', ...(extra || {}) }
  if (token) out.Authorization = 'Bearer ' + token
  if (staff) out['X-Staff-Key'] = staff
  return out
}
async function call(path, opts) {
  opts = opts || {}
  const response = await fetch(LOBBY + path, {
    method: opts.method || 'GET',
    headers: headers(opts.body ? { 'Content-Type': 'application/json' } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  })
  let data = {}
  try { data = await response.json() } catch {}
  return { status: response.status, data }
}
function fakeView() {
  return {
    player: { name: me.name || 'Owner', named: true, public: false },
    store: [], games: [], play: [], your_games: [], more: [], featured: [],
    get: [], submit: { url: '', docs: '' },
    community: { notice: '', games: [], problems: [] },
    makers: { notice: '', note: '', items: [], problems: [] },
    lobby: { lines: [], looking: [] },
    setup: { welcome_needed: false, ai_choice: true },
    alerts: { ok: false, count: 0, rows: [], paused: false, source: '' },
    online: {
      on: true, url: LOBBY, linked: true, name: me.name || 'Owner', disclosure: '',
      offline: false, game: '', looking: {}, waiting_names: [], match: null,
      alerts: {}, ladder: {}, league: {}, bot: { id: '', name: '' },
      staff: me
    },
    diagnostics: { setup: '', notes: [] }
  }
}
const ctx = {
  os: { openExternal: async () => false },
  rest: async (path, opts) => {
    window.__restCalls = (window.__restCalls || 0) + 1
    opts = opts || {}
    if (path === '/view') return fakeView()
    if (path === '/online/staff' && (opts.method || 'GET') === 'GET') return { ok: true, staff: me }
    if (path === '/online/staff' && opts.method === 'POST') {
      const candidate = String((opts.body || {}).key || '')
      localStorage.setItem('qa.staff', candidate)
      const answer = await call('/api/admin/me', {})
      if (answer.status !== 200) { localStorage.removeItem('qa.staff'); return { ok: false, text: 'That staff key does not work with this account.' } }
      me = { role: answer.data.role, name: answer.data.name, powers: answer.data.powers || [] }
      return { ok: true, text: 'Staff key saved. You are ' + me.role + '.', staff: me }
    }
    if (path === '/online/staff/clear') { localStorage.removeItem('qa.staff'); me = { role: '', name: '', powers: [] }; return { ok: true, text: 'Staff key forgotten.' } }
    if (path.startsWith('/online/admin/')) {
      const mapped = path.replace('/online/admin', '/api/admin')
      const answer = await call(mapped, opts)
      return { ...answer.data, ok: answer.status < 400 }
    }
    throw new Error('QA harness has no route for ' + path)
  }
}
let Page = null
ctx.registerMany = function (list) { for (const item of list) if (item.id === 'page') Page = item.render }
ctx.register = function () {}
plugin.register(ctx)
async function boot() {
  const answer = await call('/api/admin/me', {})
  if (answer.status === 200 && staff) me = { role: answer.data.role, name: answer.data.name, powers: answer.data.powers || [] }
  else me = { role: '', name: '', powers: [] }
  createRoot(document.getElementById('root')).render(h(Page || (() => null)))
  try {
    const element = Page && Page()
    window.__qaPageProps = element && element.props ? Object.keys(element.props) : null
    window.__qaSame = Boolean(element && element.props && element.props.ctx === ctx)
    window.__qaCtxKeys = element && element.props && element.props.ctx ? Object.keys(element.props.ctx) : null
  } catch (failure) { window.__qaSame = String(failure) }
  window.__qaCtx = ctx
  window.__qaReady = true
}
boot()`

const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.png': 'image/png' }
const qa = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  const send = (body, type) => { response.writeHead(200, { 'Content-Type': type }); response.end(body) }
  // Same-origin proxy to the lobby, so the page never needs CORS headers from it.
  if (url.pathname.startsWith('/lobby/')) {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const headers = {}
    for (const name of ['authorization', 'x-staff-key', 'content-type', 'accept']) {
      if (request.headers[name]) headers[name] = String(request.headers[name])
    }
    try {
      const answer = await fetch(LOBBY + url.pathname.slice('/lobby'.length) + url.search, {
        method: request.method, headers, body: body.length ? body : undefined
      })
      const text = await answer.text()
      response.writeHead(answer.status, { 'Content-Type': answer.headers.get('content-type') || 'application/json' })
      response.end(text)
    } catch (failure) {
      response.writeHead(502, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: String(failure && failure.message || failure) }))
    }
    return
  }
  if (url.pathname === '/') return send(HARNESS, 'text/html')
  if (url.pathname === '/harness.js') return send(HARNESS_JS, 'text/javascript')
  if (url.pathname === '/sdk.js') return send(SDK, 'text/javascript')
  if (url.pathname === '/plugin.js') return send(fs.readFileSync(path.join(ROOT, 'desktop/plugin.js')), 'text/javascript')
  if (url.pathname.startsWith('/vendor/')) {
    const file = path.join(ROOT, 'online/web/vendor', path.basename(url.pathname))
    if (fs.existsSync(file)) return send(fs.readFileSync(file), types[path.extname(file)] || 'text/javascript')
  }
  response.writeHead(404); response.end('no')
})
const QA_PORT = 18860 + (process.pid % 40)
await new Promise(resolve => qa.listen(QA_PORT, '127.0.0.1', resolve))
const QA = `http://127.0.0.1:${QA_PORT}/`

// ---- one browser -------------------------------------------------------------
const results = []
const record = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}
const profile = fs.mkdtempSync('/tmp/gameshelf-ad-desktop-chrome-')
process.on('exit', () => { try { chrome.kill('SIGKILL') } catch {} try { fs.rmSync(profile, { recursive: true, force: true }) } catch {} }); for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => process.exit(130)) // delete the ~200 MB Chrome profile when the run ends
let chromePort = 9800 + (process.pid % 80)
for (let candidate = chromePort; candidate < chromePort + 50; candidate += 1) {
  try { await fetch(`http://127.0.0.1:${candidate}/json`, { signal: AbortSignal.timeout(250) }) } catch { chromePort = candidate; break }
}
const chrome = spawn('google-chrome', ['--headless=new', '--mute-audio', '--no-sandbox', '--disable-gpu',
  '--window-size=1400,1000', `--remote-debugging-port=${chromePort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
let tabs = []
for (let attempt = 0; attempt < 80; attempt += 1) {
  try { tabs = await (await fetch(`http://127.0.0.1:${chromePort}/json`)).json(); if (tabs.some(t => t.type === 'page')) break } catch {}
  await sleep(250)
}
const page = tabs.find(tab => tab.type === 'page')
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
  const timer = setTimeout(() => { if (waiting.delete(id)) resolve({ __timeout: true }) }, 20000)
  waiting.set(id, answer => { clearTimeout(timer); resolve(answer) })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const answer = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (answer && answer.exceptionDetails) return { __error: answer.exceptionDetails.text }
  return answer && answer.result ? answer.result.value : undefined
}
await cdp('Page.enable')
await cdp('Runtime.enable')
const consoleLines = []
socket.addEventListener('message', message => {
  const data = JSON.parse(message.data)
  if (data.method === 'Runtime.consoleAPICalled') {
    consoleLines.push(data.params.type + ': ' + (data.params.args || []).map(arg => arg.value || arg.description || '').join(' '))
  }
  if (data.method === 'Runtime.exceptionThrown') {
    const details = data.params.exceptionDetails || {}
    consoleLines.push('EXCEPTION: ' + (details.exception && details.exception.description || details.text))
  }
})

const shot = async name => {
  const taken = await cdp('Page.captureScreenshot', { format: 'png' })
  if (!taken || !taken.data) { record(`shot ${name}`, false, 'browser quiet'); return }
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(taken.data, 'base64'))
  console.log('shot', name)
}
const pointer = async spot => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let step = 1; step <= 4; step += 1) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y, button: 'left', buttons: 1 })
    await sleep(15)
  }
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(160)
}
const find = async (label, { exact = false, nth = 0 } = {}) => evaluate(`(() => {
  const nodes = [...document.querySelectorAll('button,a,[role=button]')].filter(node => {
    const text = (node.textContent || '').trim()
    return (${exact} ? text === ${JSON.stringify(label)} : text.includes(${JSON.stringify(label)})) && !node.disabled
  })
  const found = nodes[${nth}]
  if (!found) return null
  found.scrollIntoView({ block: 'center' })
  const box = found.getBoundingClientRect()
  if (!box.width || !box.height) return null
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
})()`)
const hitTest = async spot => evaluate(`(() => { const el = document.elementFromPoint(${spot.x}, ${spot.y}); return el ? el.tagName + ':' + (el.textContent||'').trim().slice(0,40) : null })()`)
const click = async (label, options = {}) => {
  const spot = await find(label, options)
  if (!spot) { record(`found “${label}”`, false, 'control not found'); return false }
  const hit = await hitTest(spot)
  record(`hit-test “${label}”`, Boolean(hit && /^(BUTTON|A|SPAN|DIV|INPUT)/.test(hit)), `cursor over <${hit}>`)
  await pointer(spot)
  await sleep(options.wait || 700)
  return true
}
const type = async (selector, text) => {
  const spot = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const box = el.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  })()`)
  if (!spot) { record(`field ${selector}`, false, 'not found'); return false }
  const hit = await hitTest(spot)
  record(`hit-test field ${selector}`, Boolean(hit && /INPUT/.test(hit)), `cursor over <${hit}>`)
  await pointer(spot)
  await cdp('Input.insertText', { text })
  await sleep(200)
  return true
}
const has = async text => evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`)
const waitFor = async (test, seconds = 8) => {
  for (let attempt = 0; attempt < seconds * 4; attempt += 1) { if (await test()) return true; await sleep(250) }
  return false
}
const load = async (token, staff) => {
  await cdp('Page.navigate', { url: QA })
  await sleep(1200)
  await evaluate(`localStorage.setItem('qa.token', ${JSON.stringify(token)}); localStorage.setItem('qa.staff', ${JSON.stringify(staff)}); location.reload(); true`)
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await evaluate(`Boolean(window.__qaReady)`)) break
    await sleep(250)
  }
  await sleep(800)
}

try {
  // A player (no staff key): the Admin tab must not exist.
  const playerAnswer = await fetch(LOBBY + '/api/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Mallory' })
  })
  const playerText = await playerAnswer.text()
  if (!playerAnswer.ok) throw new Error(`player sign-up failed: ${playerAnswer.status} ${playerText}`)
  const player = JSON.parse(playerText)
  await load(player.token, '')
  console.log('BODY:', await evaluate('document.body.innerText.slice(0, 400)'))
  console.log('CONSOLE:', consoleLines.slice(-8).join(' | '))
  console.log('DEBUG:', await evaluate('JSON.stringify({ ctx: typeof window.__qaCtx, calls: window.__restCalls || 0, props: window.__qaPageProps, same: window.__qaSame, keys: window.__qaCtxKeys })'))
  record('player sees Games and Champions tabs', await waitFor(async () => (await has('Games')) && (await has('Champions'))))
  record('player has no Admin tab', !(await has('Admin')))
  await shot('01-player-no-admin-tab')

  // The admin, signed in with the staff key: the tab appears and every panel works.
  await load(ownerKey, staffKey)
  record('admin tab appears for staff', await waitFor(() => has('Admin')))
  await shot('02-admin-tab-visible')
  await click('Admin', { exact: true, wait: 1400 })
  record('admin panel opens', await waitFor(() => has('Labs · experiment')))
  record('empty reports queue says so', await waitFor(() => has('Nothing to look at')))
  await shot('03-admin-reports-empty')

  // A report to act on: Mallory says something in the lobby and Trent reports it
  // (nobody may report their own message).
  const posted = await (await fetch(LOBBY + '/api/lobby/chat', {
    method: 'POST', headers: { 'Authorization': `Bearer ${player.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'desktop admin test message' })
  })).json()
  const trentAnswer = await fetch(LOBBY + '/api/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Trent' })
  })
  const trent = await trentAnswer.json()
  const reported = await fetch(LOBBY + '/api/reports', {
    method: 'POST', headers: { 'Authorization': `Bearer ${trent.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'message', message_id: posted.message.id, reason: 'Spam' })
  })
  if (!reported.ok) throw new Error(`report failed: ${reported.status} ${await reported.text()}`)
  await click('Refresh', { wait: 1600 })
  record('report card renders on the desktop', await waitFor(() => has('desktop admin test message')))
  await shot('04-admin-reports')
  await click('Delete message', { wait: 1200 })
  record('delete-message works from the desktop', await waitFor(() => has('Message removed')))
  await shot('05-admin-after-delete')

  await click('Look up', { exact: true, wait: 800 })
  await type('input[aria-label="Name to look up"]', 'Mallory')
  await click('Look up', { exact: true, nth: 1, wait: 1200 })
  record('lookup shows the player', await waitFor(() => has('joined')))
  await shot('05-admin-lookup')

  await click('Audit log', { wait: 1000 })
  record('audit panel opens', await waitFor(async () => !(await has('Loading the audit log'))))
  await shot('06-admin-audit')

  await click('Team', { exact: true, wait: 1000 })
  record('team panel lists the owner', await waitFor(() => has('Owner')))
  await shot('07-admin-team')
} catch (failure) {
  record('desktop scenario completed', false, String(failure && failure.stack || failure))
} finally {
  const summary = { url: QA, passed: results.filter(row => row.pass).length, total: results.length, results }
  fs.writeFileSync(path.join(OUT, 'proof.json'), JSON.stringify(summary, null, 2))
  console.log('SUMMARY', JSON.stringify({ passed: summary.passed, total: summary.total }))
  chrome.kill()
  qa.close()
  try {
    const cmdline = execFileSync('ps', ['-o', 'args=', '-p', String(server.pid)], { encoding: 'utf8' })
    if (cmdline.includes(`--data ${dataDir}`)) server.kill()
    else console.log('not stopping pid', server.pid, '— unexpected:', cmdline.trim())
  } catch {}
  process.exit(summary.passed === summary.total ? 0 : 2)
}
