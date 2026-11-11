// Prove the Lobby tab's "Bots and leagues" area with a real mouse, in a muted headless
// Chrome, against a real (local) lobby server with two bots and a live rated table.
//
//   node tools/leagues_proof.mjs --url http://127.0.0.1:18813/pane --out proof/bo
//
// Every press is a real CDP mouse press on the control's own centre, hit-tested with
// elementFromPoint first, so a covered or hidden control fails the run instead of passing it.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const URL_BASE = arg('url', 'http://127.0.0.1:18813/pane')
const OUT = path.resolve(arg('out', 'proof/bo'))
const ROOM = arg('room', '')
const WHITE = arg('white', 'Proof Robo')
const BLACK = arg('black', 'House Hound')
const NAME = arg('name', `Proof Ada ${Date.now() % 100000}`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
fs.mkdirSync(OUT, { recursive: true })

let PORT = Number(arg('port', String(9700 + (process.pid % 200))))
const freePort = async () => {
  for (let candidate = PORT; candidate < PORT + 40; candidate += 1) {
    try {
      await fetch(`http://127.0.0.1:${candidate}/json`, { signal: AbortSignal.timeout(250) })
    } catch {
      return candidate
    }
  }
  return PORT
}
PORT = await freePort()
const profile = fs.mkdtempSync('/tmp/gameshelf-leagues-')
process.on('exit', () => { try { chrome.kill('SIGKILL') } catch {} try { fs.rmSync(profile, { recursive: true, force: true }) } catch {} }); for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => process.exit(130)) // delete the ~200 MB Chrome profile when the run ends
const chrome = spawn('google-chrome', [
  '--headless=new', '--mute-audio', '--no-sandbox', '--disable-gpu',
  '--window-size=1500,1000', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'
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
await new Promise(resolve => { socket.onopen = resolve })
let counter = 0
const waiting = new Map()
const pageErrors = []
socket.onmessage = message => {
  const data = JSON.parse(message.data)
  if (data.method === 'Runtime.exceptionThrown') {
    const detail = data.params && data.params.exceptionDetails
    pageErrors.push((detail && (detail.exception && detail.exception.description || detail.text)) || 'exception')
  }
  if (data.id && waiting.has(data.id)) {
    waiting.get(data.id)(data.result || data.error)
    waiting.delete(data.id)
  }
}
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
  if (answer && answer.exceptionDetails) throw new Error(String(answer.exceptionDetails.text))
  return answer && answer.result ? answer.result.value : undefined
}

const shots = []
const shot = async name => {
  await cdp('Page.bringToFront')
  const taken = await cdp('Page.captureScreenshot', { format: 'png' })
  if (!taken || !taken.data) throw new Error(`screenshot refused: ${name}`)
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(taken.data, 'base64'))
  shots.push(`${name}.png`)
  console.log('shot', name)
}

const pointer = async point => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point[0], y: point[1] })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: point[0], y: point[1], button: 'left', buttons: 1, clickCount: 1 })
  for (let step = 1; step <= 4; step += 1) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point[0] + step * 0.4, y: point[1] + step * 0.4, button: 'left', buttons: 1 })
    await sleep(12)
  }
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point[0], y: point[1], button: 'left', buttons: 0, clickCount: 1 })
}

const hitTest = async (point, label) => {
  const hit = await evaluate(`(() => {
    const node = document.elementFromPoint(${point[0]}, ${point[1]})
    if (!node) return 'nothing'
    const owner = node.closest('button, input, section, a')
    return owner ? owner.tagName + '|' + (owner.textContent || '').trim().slice(0, 48) : node.tagName
  })()`)
  if (String(hit).startsWith('nothing')) throw new Error(`nothing at ${point} for ${label}`)
  return hit
}

const centreOf = async expression => {
  // Scroll first, then measure: the box taken before the scroll settles points at
  // whatever used to be there, and the press would land on it instead.
  await evaluate(`(() => { const node = ${expression}; if (node) node.scrollIntoView({ block: 'center' }); return true })()`)
  await sleep(180)
  return evaluate(`(() => {
    const node = ${expression}
    if (!node) return null
    const box = node.getBoundingClientRect()
    if (!box.width || !box.height) return null
    return [box.x + box.width / 2, box.y + box.height / 2, box.width]
  })()`)
}

const pressButton = async (label, wait = 700) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const spot = await centreOf(`[...document.querySelectorAll('button')]
      .find(node => node.textContent.trim() === ${JSON.stringify(label)} && !node.disabled)`)
    if (spot) {
      // A real press inside the control, a little left of centre: the QA page parks its
      // own corner label at the bottom right, and a control must be pressable anywhere.
      const point = [spot[0] - Math.min(60, Math.max(6, Math.round((spot[2] || 20) / 3))), spot[1]]
      const inside = await evaluate(`(() => {
        const node = document.elementFromPoint(${point[0]}, ${point[1]})
        if (!node) return 'nothing'
        const owner = node.closest('button')
        return owner ? 'BUTTON|' + (owner.textContent || '').trim().slice(0, 40) : node.tagName
      })()`)
      if (!String(inside).startsWith('BUTTON|') || !String(inside).includes(label.slice(0, 18))) {
        await evaluate('(() => { const pane = document.querySelector(".games-wait-pane"); if (pane) pane.scrollTop -= 40; return true })()')
        await sleep(200)
        continue
      }
      await hitTest(spot, label)
      await pointer(point)
      await sleep(wait)
      return inside
    }
    await sleep(400)
  }
  return ''
}

const typeInto = async (placeholder, text) => {
  const spot = await centreOf(`document.querySelector('input[placeholder=${JSON.stringify(placeholder)}]')`)
  if (!spot) return false
  await hitTest(spot, placeholder)
  await pointer(spot)
  await cdp('Input.insertText', { text })
  await sleep(200)
  return true
}

const bodyText = () => evaluate('document.body.innerText')
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(ok ? 'ok  ' : 'FAIL', name, detail)
}

const waitFor = async (expression, attempts = 40) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await evaluate(expression)) return true
    await sleep(400)
  }
  return false
}

const main = async () => {
  await cdp('Runtime.enable')
  await cdp('Page.navigate', { url: URL_BASE })
  await sleep(3500)

  // The pane opens on its Game tab; the leagues live on the Lobby tab.
  await pressButton('Lobby', 900)
  check('lobby tab opened', (await evaluate(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'Lobby')`)))

  await pressButton('Turn on online play', 900)
  check('online play turned on', (await bodyText()).includes('Play with people online'))

  // A QA server reused between runs may still be signed in as an earlier proof name.
  if ((await bodyText()).includes('Sign out here')) {
    await pressButton('Sign out here', 1200)
    await waitFor(`!((document.body.innerText || '').includes('Sign out here'))`, 20)
  }
  await typeInto('Your name online', NAME)
  const typed = await evaluate(`(() => { const node = document.querySelector('input[placeholder="Your name online"]'); return node ? node.value : 'NO INPUT' })()`)
  const createState = await evaluate(`(() => { const node = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Create my player'); return node ? (node.disabled ? 'disabled' : 'enabled') : 'MISSING' })()`)
  check('typed a name into the online form', typed === NAME, `${typed} / create: ${createState}`)
  await pressButton('Create my player', 1200)
  const signedIn = await waitFor(`(document.body.innerText || '').includes('You are ${NAME} online.')`, 30)
  check('signed in as a new player', signedIn, signedIn ? '' : (await bodyText()).slice(-400))
  await waitFor(`(document.body.innerText || '').includes('Bots and leagues')`, 30)
  await shot('01-lobby-signed-in')

  const text = await bodyText()
  const lower = text.toLowerCase()
  check('bots and leagues area is on the Lobby tab', text.includes('Bots and leagues') && text.includes('Labs · experiment'))
  check('ranked pair rule is stated', lower.includes('seats swapped'))
  check('live bot table is listed', text.includes(WHITE) && text.includes(BLACK))
  check('bot passports are listed', lower.includes('bot passports') && lower.includes('house hound'))
  check('open league is labelled unverified', lower.includes('self-hosted, unverified'))
  check('stock league is shown as a design page', lower.includes('stock league') && lower.includes('needs a server-side model'))
  await shot('02-bots-and-leagues')

  // Watch: opens the live table in the browser (ctx.os.external records it).
  const watched = await pressButton('Watch', 900)
  const external = await evaluate('window.qa && window.qa.external ? window.qa.external : []')
  const target = ROOM ? `/t/${ROOM}` : '/t/'
  check('watch opened the live table in the browser', Array.isArray(external) && external.some(url => String(url).includes(target)),
        `${watched} ${JSON.stringify(external || [])}`)
  await shot('03-watch-opened')

  // Challenge: a real mouse path through the in-pane card.
  await pressButton('Challenge', 800)
  const cardOpen = await waitFor(`(document.body.innerText || '').includes('Pick the game. The invitation goes')`, 10)
  check('challenge card opened', cardOpen)
  await shot('04-challenge-card')
  const picked = await pressButton('Hex', 500)
  const sent = await pressButton('Send challenge', 1400)
  const after = await bodyText()
  check('challenge game picked with a button', Boolean(picked))
  check('challenge sent', Boolean(sent) && /Invitation sent/i.test(after),
        after.split('\n').filter(line => line.includes('Invitation')).join(' | '))
  await shot('05-challenge-sent')

  // The open league's own entry button is a real control, not a drop-down.
  const openLeague = await evaluate(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'Enter the open league' && !node.disabled)`)
  check('open league entry is a button', Boolean(openLeague))

  // The stock league opens its design in place.
  await pressButton('Read the design', 600)
  const design = await bodyText()
  check('stock league design opens in the pane', design.includes('What it needs:') && design.includes('model budget'))
  await shot('06-stock-design')

  check('no page exceptions', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  const errors = await evaluate('window.qa && window.qa.errors ? window.qa.errors : []')
  check('no window errors', !errors || errors.length === 0, JSON.stringify((errors || []).slice(0, 3)))
  const consoleErrors = await evaluate('window.qa && window.qa.consoleErrors ? window.qa.consoleErrors : []')
  check('no console errors', !consoleErrors || consoleErrors.length === 0, JSON.stringify((consoleErrors || []).slice(0, 3)))

  const summary = { url: URL_BASE, room: ROOM, shots, results, pageErrors, errors, consoleErrors }
  fs.writeFileSync(path.join(OUT, 'leagues-proof.json'), JSON.stringify(summary, null, 2))
  fs.writeFileSync(path.join(OUT, 'leagues-proof.txt'), results.map(row => `${row.ok ? 'ok  ' : 'FAIL'} ${row.name}${row.detail ? ` — ${row.detail}` : ''}`).join('\n') + '\n')
  chrome.kill()
  const failed = results.filter(row => !row.ok)
  console.log(failed.length ? `${failed.length} check(s) failed` : 'all checks passed')
  process.exit(failed.length ? 1 : 0)
}

main().catch(async error => {
  console.error('proof failed:', error)
  try { await shot('99-failure') } catch { /* nothing to save */ }
  chrome.kill()
  process.exit(1)
})
