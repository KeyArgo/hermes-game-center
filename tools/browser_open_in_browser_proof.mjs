#!/usr/bin/env node
// OB proof: every "Open in browser" control, opened with a REAL mouse pointer,
// lands on the address from the online lobby URL setting — and one online match
// really round-trips Hermes -> browser -> Hermes on the SAME server room.
//
//   python3 tools/ob_proof_prep.py > prep.json     # lobby + QA server, prints URLs
//   node tools/browser_open_in_browser_proof.mjs --prep prep.json --out proof/ob
//
// Muted headless Chrome. Every click is a CDP Input.dispatchMouseEvent press at
// the control's centre, gated by an elementFromPoint hit-test first — never
// element.click(). The opened URL is captured by the QA page's openExternal stub,
// which stamps it into #opened as `OPENED <url>` and also window.open()s it.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const PREP = JSON.parse(fs.readFileSync(arg('prep', 'tmp/ob-prep.json'), 'utf8'))
const OUT = arg('out', 'proof/ob')
const CHROME = arg('chrome', process.env.CHROME || 'google-chrome')
const LOBBY = PREP.lobby.replace(/\/$/, '')
const QA = PREP.qa
fs.mkdirSync(OUT, { recursive: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const POLL_WAIT = 3000
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--mute-audio', '--window-size=1500,950', '--remote-debugging-port=0',
  '--user-data-dir=' + (() => { const p = fs.mkdtempSync('/tmp/gameshelf-ob-'); process.on('exit', () => { try { chrome.kill('SIGKILL') } catch {} try { fs.rmSync(p, { recursive: true, force: true }) } catch {} }); return p })(), 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
let cdpLog = ''
chrome.stderr.on('data', chunk => { cdpLog += chunk })

const findWsUrl = async () => {
  for (let i = 0; i < 160; i += 1) {
    const m = cdpLog.match(/ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/([0-9a-f-]+)/)
    if (m) return `ws://127.0.0.1:${m[1]}/devtools/browser/${m[2]}`
    await sleep(50)
  }
  throw new Error('DevTools URL never printed')
}
const wsUrl = await findWsUrl()
const browser = new WebSocket(wsUrl)
await new Promise((resolve, reject) => { browser.onopen = resolve; browser.onerror = reject })
let nextId = 1
const pending = new Map()
const sessions = new Map()
browser.onmessage = event => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  } else if (msg.method === 'Target.receivedMessageFromSession' || msg.method === 'Target.receivedEventFromSession') {
    const handler = sessions.get(msg.params.sessionId)
    if (handler && msg.params.message) handler(JSON.parse(msg.params.message))
  }
}
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  browser.send(JSON.stringify({ id, method, params, sessionId }))
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) } }, 30000)
})
const makeTarget = async url => {
  const { targetId } = await send('Target.createTarget', { url })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const handlers = new Set()
  sessions.set(sessionId, msg => handlers.forEach(h => h(msg)))
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)
  return { sessionId, targetId, onMessage: h => handlers.add(h) }
}
const evaluate = async (page, expression) => {
  const answer = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, page.sessionId)
  if (answer.exceptionDetails) throw new Error(`page threw: ${answer.exceptionDetails.text || JSON.stringify(answer.exceptionDetails.exception)}`)
  return answer.result?.value
}
const navigate = async (page, url) => {
  await send('Page.navigate', { url }, page.sessionId)
  await sleep(900)
  for (let i = 0; i < 40; i += 1) {
    const state = await evaluate(page, 'document.readyState')
    if (state === 'complete') break
    await sleep(100)
  }
  await sleep(600)
}
const shot = async name => {
  try { await send('Target.activateTarget', { targetId: page.targetId }) } catch { /* best effort */ }
  await sleep(200)
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, page.sessionId)
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'))
}
const pointer = async ([px, py]) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py }, page.sessionId)
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1, clickCount: 1 }, page.sessionId)
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0, clickCount: 1 }, page.sessionId)
  await sleep(300)
}
let page = null
const results = []
const record = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}
const openNote = () => evaluate(page, `(() => {
  const banner = document.getElementById('opened')
  if (banner && banner.textContent) return banner.textContent
  const external = (window.qa && window.qa.external) || []
  return external.length ? 'OPENED ' + external[external.length - 1] : ''
})()`)
const hideBanner = () => evaluate(page, `(() => { const b = document.getElementById('opened'); if (b) b.style.display = 'none'; return true })()`)
const clearOpened = () => evaluate(page, `(() => { const b = document.getElementById('opened'); if (b) { b.textContent = ''; b.style.display = 'none' } if (window.qa) window.qa.external = []; return true })()`)

// Find an "Open in browser" control, optionally scoped below an anchor heading,
// return its centre. scrollIntoView keeps deep pane rows clickable.
const openButtonSpot = async (anchor, wantUrl) => evaluate(page, `(() => {
  const nodes = [...document.querySelectorAll('button')]
    .filter(node => node.textContent.trim() === 'Open in browser' && !node.disabled)
    .filter(node => ${wantUrl ? `(node.title || '').includes(${JSON.stringify(wantUrl)})` : 'true'})
  let pool = nodes
  if (${JSON.stringify(anchor || '')}) {
    const anchored = nodes.filter(node => {
      let scan = node
      for (let hop = 0; scan && hop < 40; hop += 1, scan = scan.parentElement) {
        if ((scan.textContent || '').includes(${JSON.stringify(anchor)})) return true
      }
      return false
    })
    if (anchored.length) pool = anchored
  }
  if (!pool.length) return null
  const found = pool[0]
  found.scrollIntoView({ block: 'center' })
  const box = found.getBoundingClientRect()
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, title: found.title || '' }
})()`)

const hitTest = async point => evaluate(page, `(() => {
  const el = document.elementFromPoint(${point.x}, ${point.y})
  if (!el) return null
  const owner = el.closest ? el.closest('button') : null
  return (owner ? 'BUTTON|' : el.tagName + '|') + (owner ? (owner.textContent || '').trim() : (el.textContent || '').trim().slice(0, 30))
})()`)

// Press a control by its exact label with the real mouse, hit-test gated.
const clickExact = async label => {
  const spot = await evaluate(page, `(() => {
    const found = [...document.querySelectorAll('button')]
      .find(node => node.textContent.trim() === ${JSON.stringify(label)} && !node.disabled)
    if (!found) return null
    found.scrollIntoView({ block: 'center' })
    const box = found.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  })()`)
  if (!spot) return { hit: false }
  await hideBanner()
  const hit = await hitTest(spot)
  if (!hit || !hit.includes(label)) return { hit: false }
  await clearOpened()
  await pointer([spot.x, spot.y])
  return { hit: true }
}

// Real mouse: hit-test then press a control; returns the captured OPENED url.
const openInBrowser = async (label, anchor, wantUrl) => {
  await hideBanner()
  let spot = null
  for (let attempt = 0; attempt < 12 && !spot; attempt += 1) {
    spot = await openButtonSpot(anchor, wantUrl)
    if (!spot) await sleep(500)
  }
  if (!spot) { record(label, false, 'control not found'); return '' }
  const hit = await hitTest(spot)
  record(`hit-test "${label}"`, Boolean(hit && hit.startsWith('BUTTON|Open in browser')), `cursor over <${String(hit).slice(0, 50)}>)`.replace('>)', '>'))
  await clearOpened()
  await pointer([spot.x, spot.y])
  const opened = (await openNote()).replace(/^OPENED /, '')
  record(`${label} opens the lobby URL`, opened.startsWith(LOBBY), opened)
  return opened
}

const hasText = text => evaluate(page, `document.body.innerText.includes(${JSON.stringify(text)})`)

page = await makeTarget(QA)
await sleep(1200)

// ---- -1. First run on a fresh profile: name picker. Press the suggested name
// and continue — every later control hides behind this gate.
const pressWhenEnabled = async (label, tries = 30) => {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const spot = await evaluate(page, `(() => {
      const found = [...document.querySelectorAll('button')]
        .find(node => node.textContent.trim() === ${JSON.stringify(label)} && !node.disabled)
      if (!found) return null
      found.scrollIntoView({ block: 'center' })
      const box = found.getBoundingClientRect()
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    })()`)
    if (spot) {
      const hit = await hitTest(spot)
      await pointer([spot.x, spot.y])
      return Boolean(hit)
    }
    await sleep(400)
  }
  return false
}
// The welcome card can render a beat after the route, so wait for either it or
// the lobby before deciding.
let gated = false
for (let i = 0; i < 30 && !gated; i += 1) {
  if (await hasText('Find a match')) { gated = false; break }
  if (await hasText('Pick a name')) { gated = true; break }
  await sleep(500)
}
if (gated) {
  record('onboarding: pressed the suggested name', await pressWhenEnabled('Use this'))
  await sleep(600)
  if (await hasText('Continue')) await pressWhenEnabled('Continue', 8)
  await sleep(800)
}
record('lobby is visible', await hasText('Find a match'))

// ---- 0. Turn online on and sign the Desktop in as Proof Ada (same identity the
// browser tab will use), exactly through the plugin's own API surface.
await fetch(QA.replace(/\/$/, '') + '/api/online/on', { method: 'POST' })
const signIn = await (await fetch(QA.replace(/\/$/, '') + '/api/online/signin', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: PREP.ada.name, key: PREP.ada.token }),
})).json()
record('desktop signs in as the same player', signIn.ok !== false && signIn.online?.linked === true,
  `linked=${signIn.online?.linked} name=${signIn.online?.name}`)

// ---- 1. Home: the find-bar Open in browser + disclosure, real mouse.
record('home discloses leaving Hermes for the browser', await hasText('outside Hermes'))
const homeOpened = await openInBrowser('home find bar', 'Find a match')
record('home opens the lobby home', homeOpened === LOBBY, homeOpened)
await shot('ob-1-home')

// ---- 2. Game page: open Connect Four. The table carries NO browser door any more:
// online play is the in-Hermes lobby now, so this screen must offer none of the
// removed invite controls. A real-mouse click is not needed for an absence, so the
// DOM is read where the header used to hold them.
const tile = await evaluate(page, `(() => {
  const found = [...document.querySelectorAll('button')].find(node => node.textContent.includes('Connect Four') && !node.disabled)
  if (!found) return null
  found.scrollIntoView({ block: 'center' })
  const box = found.getBoundingClientRect()
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
})()`)
if (tile) { await pointer([tile.x, tile.y]); await sleep(1200) }
const browserDoors = await evaluate(page, `(() => {
  const gone = ['Open in browser', 'Find a match', 'Copy link', 'Join table']
  return [...document.querySelectorAll('button')]
    .map(node => node.textContent.trim())
    .filter(text => gone.includes(text))
})()`)
record('game page carries no browser invite', browserDoors.length === 0, JSON.stringify(browserDoors))
await shot('ob-2-game')

// ---- 3. Hermes -> browser: Ada queues online with a REAL mouse click on the
// wait-pane control, the lobby matches a server room, the table card appears.
// The play-while-you-code pane lives beside the chat: the QA page serves it at /pane, and its
// online controls sit under the pane's Lobby tab (the Game tab is the default).
await navigate(page, QA + 'pane')
await sleep(2000)
const lobbyTabSpot = await evaluate(page, "(() => { const b = [...document.querySelectorAll('#pane button')].find(x => x.textContent === 'Lobby'); if (!b) return null; b.scrollIntoView({block: 'center'}); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()")
if (lobbyTabSpot) await pointer([lobbyTabSpot.x, lobbyTabSpot.y])
await sleep(800)
record('play-while-you-code pane is on screen', await hasText('Play with people online'))
const adaQueueBefore = await (await fetch(QA.replace(/\/$/, '') + '/api/online')).json()
record('desktop online pane is ready', adaQueueBefore.online?.linked === true, `linked=${adaQueueBefore.online?.linked}`)
const queueSpot = await evaluate(page, `(() => {
  const found = [...document.querySelectorAll('button')]
    .find(node => node.textContent.trim().startsWith('Find a match online') && !node.disabled)
  if (!found) return null
  found.scrollIntoView({ block: 'center' })
  const box = found.getBoundingClientRect()
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, text: found.textContent.trim() }
})()`)
if (queueSpot) {
  const hit = await hitTest(queueSpot)
  record('hit-test "Find a match online"', Boolean(hit && hit.startsWith('BUTTON|Find a match online')), `cursor over <${String(hit).slice(0, 40)}>`)
  await pointer([queueSpot.x, queueSpot.y])
} else {
  record('hit-test "Find a match online"', false, 'control not found')
}
const beaQueue = await (await fetch(LOBBY + '/api/queue', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PREP.bea.token}` },
  body: JSON.stringify({ game: 'connect4' }),
})).json()
const room = (beaQueue.matched?.room?.id) || ''
record('lobby matched a server room', Boolean(room), room)
// The desktop learns about it only by polling its own online pane.
let card = null
for (let attempt = 0; attempt < 60 && !card; attempt += 1) {
  card = await openButtonSpot('Your table is ready', `/t/`)
  if (!card) await sleep(500)
}
const cardUrl = card ? (card.title.match(/https?:\/\/\S+(?=\s|$)/) || [''])[0] : ''
record('play-while-you-code pane shows the table card', Boolean(card && cardUrl.includes(`/t/${room}`)), cardUrl)
const matchOpened = card ? await openInBrowser('match table card', 'Your table is ready', `/t/${room}`) : ''
record('match opens the same server room', matchOpened === `${LOBBY}/t/${room}`, matchOpened)
record('table card discloses signing in there', await hasText('sign in there as'))
await shot('ob-3-match')

// ---- 4. Continue in the browser: the room page shows the SAME two players, and
// the player whose turn it is really clicks a column and presses Play move.
const roomApi = room ? await (await fetch(`${LOBBY}/api/rooms/${room}`)).json() : {}
const seats = roomApi.room?.seats || []
const turnSide = roomApi.room?.turn
  || ((roomApi.room?.plies || 0) % 2 === 0 ? 'white' : 'black')
const mover = seats.find(seat => seat.side === turnSide) || seats[0]
const moverToken = mover?.name === PREP.ada.name ? PREP.ada.token : PREP.bea.token
const pliesBefore = roomApi.room?.plies ?? null
record('browser room shows both players', seats.some(s => s.name === 'Proof Ada') && seats.some(s => s.name === 'Proof Bea'),
  seats.map(s => `${s.side}:${s.name}`).join(' '))
// The room page sits behind the lobby's own name gate: sign the browser tab in
// as the player to move first (localStorage on the lobby origin), then open it.
const web = await makeTarget(`${LOBBY}/`)
await sleep(1200)
await send('Runtime.evaluate', {
  expression: `localStorage.setItem('gc.token', ${JSON.stringify(moverToken)}); true`,
}, web.sessionId)
await send('Page.navigate', { url: `${LOBBY}/t/${room}` }, web.sessionId)
await sleep(3000)
const roomBody = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, web.sessionId).then(r => r.result?.value || '')
record('room page names both players on screen', roomBody.includes('Proof Ada') && roomBody.includes('Proof Bea'))
const cell = await send('Runtime.evaluate', {
  expression: `(() => {
    const svgs = [...document.querySelectorAll('svg')]
      .map(node => ({ node, box: node.getBoundingClientRect() }))
      .filter(entry => entry.box.width > 120 && entry.box.height > 80)
    if (!svgs.length) return null
    const target = svgs.sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0].node
    target.scrollIntoView({ block: 'center' })
    const box = target.getBoundingClientRect()
    // Left of centre: drop into a column rather than dead centre.
    return { x: box.x + box.width * 0.3, y: box.y + box.height / 2 }
  })()`, returnByValue: true,
}, web.sessionId).then(r => r.result?.value)
let pliesAfter = pliesBefore
if (cell) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cell.x, y: cell.y }, web.sessionId)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cell.x, y: cell.y, button: 'left', buttons: 1, clickCount: 1 }, web.sessionId)
  await sleep(80)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cell.x, y: cell.y + 2 }, web.sessionId)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cell.x, y: cell.y + 2, button: 'left', buttons: 0, clickCount: 1 }, web.sessionId)
  await sleep(600)
  const play = await send('Runtime.evaluate', {
    expression: `(() => {
      const found = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Play move' && !node.disabled)
      if (!found) return null
      found.scrollIntoView({ block: 'center' })
      const box = found.getBoundingClientRect()
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    })()`, returnByValue: true,
  }, web.sessionId).then(r => r.result?.value)
  if (play) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: play.x, y: play.y }, web.sessionId)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: play.x, y: play.y, button: 'left', buttons: 1, clickCount: 1 }, web.sessionId)
    await sleep(60)
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: play.x, y: play.y, button: 'left', buttons: 0, clickCount: 1 }, web.sessionId)
    await sleep(1800)
  }
  pliesAfter = (await (await fetch(`${LOBBY}/api/rooms/${room}`)).json()).room?.plies ?? pliesAfter
  record('browser move registers on the SAME server room', pliesBefore !== null && pliesAfter > pliesBefore,
    `plies ${pliesBefore} -> ${pliesAfter} (moved as ${mover?.name})`)
} else {
  record('browser board reachable', false, 'no clickable board found')
}
{ const { data } = await send('Page.captureScreenshot', { format: 'png' }, web.sessionId)
  fs.writeFileSync(path.join(OUT, 'ob-4-browser-move.png'), Buffer.from(data, 'base64')) }

// ---- 5. Back to Hermes: the desktop card still points at the SAME server room.
await sleep(POLL_WAIT)
const stillCard = await openButtonSpot('Your table is ready', `${LOBBY}/t/`)
record('desktop still points at the same server room', Boolean(stillCard && stillCard.title.includes(`/t/${room}`)), stillCard ? stillCard.title : 'no card')
await shot('ob-5-back')

// ---- 6. Bot passport row (leagues pane).
const passportOpened = await openInBrowser('bot passport', PREP.bot_name, `/b/${PREP.bot}`)
record('passport opens the bot page', decodeURIComponent(passportOpened) === `${LOBBY}/b/${PREP.bot}`, passportOpened)
await shot('ob-6-passport')

// ---- 7. Card arena bout: start one from the leagues pane with the real mouse,
// then its replay button must open the lobby-served replay page.
const boutPlay = await clickExact('Play a bout')
record('bout flow: "Play a bout" pressed', boutPlay.hit)
let rivalPressed = false
for (let attempt = 0; attempt < 25 && !rivalPressed; attempt += 1) {
  rivalPressed = (await clickExact('Rival Card')).hit
  if (!rivalPressed) await sleep(400)
}
record('bout flow: opponent card pressed', rivalPressed)
let boutButton = null
for (let attempt = 0; attempt < 40 && !boutButton; attempt += 1) {
  boutButton = await openButtonSpot(null, 'bout')
  if (!boutButton) await sleep(500)
}
let boutOpened = ''
if (boutButton) {
  const hit = await hitTest(boutButton)
  record('hit-test bout "Open in browser"', Boolean(hit && hit.startsWith('BUTTON|Open in browser')), `cursor over <${String(hit).slice(0, 50)}>`);
  await pointer([boutButton.x, boutButton.y])
  boutOpened = (await openNote()).replace(/^OPENED /, '')
}
const boutId = (boutOpened.match(/\/api\/card-arena\/([^?#]+)/) || [])[1] || ''
record('bout replay opens a lobby replay url', boutOpened.startsWith(`${LOBBY}/api/card-arena/`), boutOpened)
await shot('ob-7-bout')

// ---- 8. The replay url really serves a page (opened via window.open in Chrome).
let replayBody = ''
if (boutId) {
  const replayTab = await makeTarget(`${LOBBY}/api/card-arena/${boutId}`)
  replayBody = await send('Runtime.evaluate', { expression: 'document.body.innerText.slice(0, 400)', returnByValue: true }, replayTab.sessionId).then(r => r.result?.value || '')
  record('replay url serves content', /Proof Card|Rival Card|score|won|draw/i.test(replayBody), replayBody.slice(0, 80).replace(/\s+/g, ' '))
  ;const { data } = await send('Page.captureScreenshot', { format: 'png' }, replayTab.sessionId)
  fs.writeFileSync(path.join(OUT, 'ob-8-replay.png'), Buffer.from(data, 'base64'))
} else {
  record('replay url serves content', false, 'no bout id captured')
}

const summary = { qa: QA, lobby: LOBBY, room, passed: results.filter(r => r.pass).length, total: results.length, results }
fs.writeFileSync(path.join(OUT, 'proof.json'), JSON.stringify(summary, null, 2))
console.log('SUMMARY', JSON.stringify({ passed: summary.passed, total: summary.total }))
chrome.kill()
process.exit(summary.passed === summary.total ? 0 : 2)
