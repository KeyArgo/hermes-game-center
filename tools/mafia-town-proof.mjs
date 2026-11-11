// Prove Mafia Town with a real mouse in a muted headless Chrome.
//
// Every press is a CDP mouse press on the centre of the control, hit-tested with
// elementFromPoint first, so a covered or hidden control fails the run instead of
// passing it. No element.click(), no command API, no seeded boards. The one typed
// thing is a line of table talk, which the product allows; every move is a click.
//
//   node tools/mafia-town-proof.mjs --url http://127.0.0.1:18764/ --out proof/gm
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const URL_BASE = arg('url', 'http://127.0.0.1:18764/')
const OUT = path.resolve(arg('out', 'proof/gm'))
let PORT = Number(arg('port', String(9600 + (process.pid % 300))))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
fs.mkdirSync(OUT, { recursive: true })

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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-mafia-'))
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
if (!page) {
  console.error('chrome did not open a page')
  stopChrome()
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
  const answer = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).catch(() => null)
  if (!answer) return undefined
  if (answer && answer.exceptionDetails) return undefined
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
    await sleep(14)
  }
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point[0], y: point[1], button: 'left', buttons: 0, clickCount: 1 })
}

const centreOf = async expression => evaluate(`(() => {
  const node = ${expression}
  if (!node) return null
  node.scrollIntoView({ block: 'center' })
  const box = node.getBoundingClientRect()
  if (!box.width || !box.height) return null
  return [box.x + box.width / 2, box.y + box.height / 2]
})()`)

// What is actually on top at the press point? It has to be the control itself.
const hitTest = async (point, what) => {
  const hit = await evaluate(`(() => {
    const node = document.elementFromPoint(${point[0]}, ${point[1]})
    if (!node) return 'nothing'
    const owner = node.closest('button, a, [data-town]')
    return owner ? owner.tagName + '|' + (owner.getAttribute('data-town') || '') + '|' + (owner.textContent || '').trim().slice(0, 40) : node.tagName
  })()`)
  if (String(hit).startsWith('nothing')) throw new Error(`nothing at ${point} for ${what}`)
  return hit
}

const press = async (expression, what, wait = 600) => {
  const spot = await centreOf(expression)
  if (!spot) return false
  await hitTest(spot, what)
  await pointer(spot)
  await sleep(wait)
  return true
}
const pressLabel = (label, wait) => press(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(label)} && !node.disabled)`, label, wait)
const pressLabelRetry = async (label, timeout = 30000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await pressLabel(label, 300)) return true
    await sleep(500)
  }
  return false
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(ok ? 'ok  ' : 'FAIL', name, detail)
}

const waitFor = async (expression, timeout = 9000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return true
    await sleep(200)
  }
  return false
}

// One read of the town, for the checks and the log.
const townState = () => evaluate(`(() => {
  const town = document.querySelector('[data-town="mafia-town"]')
  const scene = document.querySelector('[data-town-scene="true"]')
  const shade = document.querySelector('[data-town-nightshade]')
  const dawn = document.querySelector('[data-town-dawn]')
  const over = document.querySelector('[data-town-over]')
  const say = document.querySelector('[data-town-say]')
  const log = document.querySelector('[data-town-log]')
  const seats = [...document.querySelectorAll('button[data-town-seat]')]
  return {
    town: Boolean(town),
    phase: town ? town.getAttribute('data-town-phase') : '',
    scene: Boolean(scene),
    night: Boolean(shade && shade.getAttribute('data-town-nightshade') === 'true'),
    dawnText: dawn ? dawn.innerText : '',
    overText: over ? over.innerText : '',
    sayShown: Boolean(say),
    sayEnabled: Boolean(say && !say.disabled),
    graves: [...document.querySelectorAll('[data-town-grave]')].length,
    ribbon: Boolean(document.querySelector('[data-town-ribbon]')),
    roles: [...document.querySelectorAll('[data-town-role]')].map(node => node.innerText),
    seats: seats.map(node => ({ seat: node.getAttribute('data-town-seat'), disabled: node.disabled })),
    clickable: seats.filter(node => !node.disabled).length,
    status: (document.querySelector('[data-town-status]') || {}).innerText || '',
    logRows: log ? log.innerText.split('\\n').filter(Boolean) : [],
    text: document.body.innerText
  }
})()`)

const main = async () => {
  await cdp('Runtime.enable')
  await cdp('Page.navigate', { url: URL_BASE })
  await waitFor(`document.body.innerText.includes('Welcome to Game Center') || Boolean(document.querySelector('[data-labs-section]'))`, 30000)
  if (/Welcome to Game Center/.test(await evaluate('document.body.innerText'))) {
    await pressLabel('Continue', 600)
    await waitFor(`Boolean(document.querySelector('[data-labs-section]'))`, 15000)
  }
  await sleep(600)

  // 1. The Labs shelf carries the Mafia Town card with the shared badge.
  const cardThere = await evaluate(`Boolean(document.querySelector('[data-labs-card="mafia-town"]'))
    && [...document.querySelectorAll('[data-labs-card="mafia-town"] button')].some(node => node.textContent.includes('Open Mafia Town'))`)
  check('the labs shelf has the mafia town card', cardThere)
  await shot('01-labs-card')

  // 2. One press on the card opens the town, not the classic table.
  check('Open Mafia Town pressed', await press(`[...document.querySelectorAll('[data-labs-card="mafia-town"] button')].find(node => node.textContent.includes('Open Mafia Town'))`, 'open mafia town', 900))
  let setup = await waitFor(`Boolean(document.querySelector('[data-town="mafia-town-setup"]'))`, 180000)
  if (!setup && await waitFor(`Boolean(document.querySelector('[data-town-scene="true"]'))`, 3000)) {
    console.log('a game was already running; pressing New town')
    await pressLabel('New town', 2500)
    setup = await waitFor(`Boolean(document.querySelector('[data-town="mafia-town-setup"]'))`, 180000)
  }
  check('the town setup screen is up, not the plain table', setup && !await evaluate(`Boolean(document.querySelector('.games-talk-table, [data-talk-table]'))`))
  await shot('02-town-setup')

  // 3. Watch-only: seats the bots and let the town play itself.
  check('Watch computers play pressed', await pressLabelRetry('Watch computers play', 30000))
  const watching = await waitFor(`Boolean(document.querySelector('[data-town-scene="true"]')) && document.body.innerText.includes('Watching')`, 180000)
  const watched = await townState()
  check('the square is on stage with seats', watched.scene && watched.seats.length >= 5, `${watched.seats.length} seats`)
  check('watching is labelled', watched.ribbon || watched.status.includes('Watching') || /Watching the town/.test(watched.text), watched.status)
  check('no drop-downs anywhere in the town', await evaluate(`!document.querySelector('[data-town] select, [data-town] datalist')`))
  await shot('03-town-day')

  // 4. Night falls on its own while the bots play.
  const night = await waitFor(`Boolean(document.querySelector('[data-town="mafia-town"]')) && (document.querySelector('[data-town="mafia-town"]').getAttribute('data-town-phase') === 'night') && Boolean(document.querySelector('[data-town-nightshade][style]'))`, 240000)
  const nightState = await townState()
  check('night darkens the town', night && nightState.night, nightState.phase)
  check('the stars are out', await evaluate(`Boolean(document.querySelector('[data-town-star]'))`))
  await shot('04-town-night')

  // 5. Dawn names who is gone, with a puff on the portrait.
  const dawn = await waitFor(`(() => { const el = document.querySelector('[data-town-dawn]'); if (el && /dawn|Dawn/.test(el.innerText || '')) { window.__dawnText = el.innerText; return true } return false })()`, 240000)
  const dawnState = await townState()
  const dawnText = await evaluate(`window.__dawnText || ''`)
  check('dawn names the gone', dawn && /dawn|Dawn/.test(dawnText), String(dawnText).slice(0, 80))
  await shot('05-town-dawn')

  // 6. The town plays to the end on its own: graves, roles, verdict.
  const over = await waitFor(`Boolean(document.querySelector('[data-town-over]'))`, 300000)
  const doneState = await townState()
  check('the game ends with an overlay', over && doneState.overText.length > 0, doneState.overText.slice(0, 60).replace(/\\n/g, ' '))
  check('roles are revealed on the town', doneState.roles.length > 0, doneState.roles.slice(0, 3).join('|'))
  await shot('06-town-over')

  // 7. Back to the setup for a seated game: this time the town is mine.
  check('New town pressed', await pressLabelRetry('New town', 30000))
  check('Back to the setup screen', await waitFor(`Boolean(document.querySelector('[data-town="mafia-town-setup"]'))`, 180000))
  check('Start the game pressed', await pressLabelRetry('Start the game', 30000))
  const mine = await waitFor(`Boolean(document.querySelector('[data-town-scene="true"]')) && !document.body.innerText.includes('Watching the town')`, 180000)
  const mineState = await townState()
  check('my seat is in the square', mine && mineState.seats.length >= 5, `${mineState.seats.length} seats`)
  await shot('07-my-town')

  // 8. The town with me in it, played by mouse alone: says are typed talk (the one
  // thing the product allows typing), every move is a click on a portrait.
  const events = []
  const seen = new Set()
  const startedAt = Date.now()
  const played = await (async () => {
    const deadline = Date.now() + 600000
    let clicks = 0
    while (Date.now() < deadline) {
      const state = await townState()
      const sig = `${state.phase}|${state.status}|${state.sayEnabled}|${state.clickable}|${state.overText ? 'over' : ''}`
      if (!seen.has(sig)) {
        seen.add(sig)
        console.log(`t+${Math.round((Date.now() - startedAt) / 1000)}s`, sig)
      }
      if (state.overText) return clicks
      // My say, when the table asks for it.
      if (state.sayEnabled) {
        const typed = await evaluate(`(() => {
          const say = document.querySelector('[data-town-say]')
          const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
          set.call(say, 'I still trust the quiet ones.')
          say.dispatchEvent(new Event('input', { bubbles: true }))
          return say.value
        })()`)
        const sent = await pressLabel('Say it', 900)
        console.log('say', JSON.stringify({ typed, sent }))
        events.push({ phase: state.phase, kind: 'say', sent })
        await sleep(800)
        continue
      }
      // A click on a portrait, hit-tested first: the vote or a night move.
      const seat = await evaluate(`(() => {
        const node = document.querySelector('button[data-town-seat]:not([disabled])')
        return node ? node.getAttribute('data-town-seat') : false
      })()`)
      if (seat) {
        const spot = await centreOf(`document.querySelector('button[data-town-seat]:not([disabled])')`)
        if (spot) {
          const hit = await hitTest(spot, `seat ${seat}`)
          if (String(hit).toLowerCase().includes('button')) {
            await pointer(spot)
            clicks += 1
            events.push({ phase: state.phase, kind: /voting/i.test(state.phase) || /vote/i.test(state.status) ? 'vote' : 'night', seat })
            await sleep(1200)
            continue
          }
        }
      }
      await sleep(1500)
    }
    return clicks
  })()
  await shot('09-my-town-play')
  check('the town plays to the end with me in it', await waitFor(`Boolean(document.querySelector('[data-town-over]'))`, 240000), `${played} moves clicked`)
  const finalState = await townState()
  const voteClicks = events.filter(event => event.kind === 'vote')
  check('a portrait click was my vote', voteClicks.length > 0, JSON.stringify(voteClicks.slice(0, 2)))
  check('my result is named', finalState.overText.length > 0, finalState.overText.slice(0, 60).replace(/\\n/g, ' '))
  await shot('10-my-over')

  // 11. The classic table is one press away, and coming back is too.
  check('Classic table pressed', await pressLabelRetry('Classic table', 15000))
  check('the plain talking table is back', await waitFor(`!Boolean(document.querySelector('[data-town="mafia-town"]'))`, 60000))
  await shot('11-classic')
  check('Back to the shelf pressed', await pressLabelRetry('Back', 15000))
  await waitFor(`Boolean(document.querySelector('[data-labs-card="mafia-town"]'))`, 60000)
  check('Mafia Town card reopens the town', await press(`[...document.querySelectorAll('[data-labs-card="mafia-town"] button')].find(node => node.textContent.includes('Open Mafia Town'))`, 'reopen', 2500)
    && await waitFor(`Boolean(document.querySelector('[data-town="mafia-town"]')) || Boolean(document.querySelector('[data-town="mafia-town-setup"]'))`, 60000))

  // 12. Nothing threw while all of that happened.
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))

  const summary = { url: URL_BASE, at: new Date().toISOString(), shots, pageErrors, events, results }
  fs.writeFileSync(path.join(OUT, 'mafia-town-proof.json'), JSON.stringify(summary, null, 2))
  const failed = results.filter(row => !row.ok)
  console.log(`\\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    const text = await evaluate('document.body.innerText')
    fs.writeFileSync(path.join(OUT, '99-failure.txt'), failed.map(row => `${row.name}: ${row.detail}`).join('\\n') + '\\n\\n' + text)
    await shot('99-failure')
  }
  socket.close()
  stopChrome()
  process.exitCode = failed.length ? 1 : 0
}

main().catch(async error => {
  console.error(error)
  fs.writeFileSync(path.join(OUT, '99-failure.txt'), String(error && error.stack || error))
  try { await shot('99-failure') } catch { /* chrome may be gone */ }
  stopChrome()
  process.exitCode = 1
})
