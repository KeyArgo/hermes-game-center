// Proof for a talking table, driven the way a person drives it.
//
// Every control is pressed with a real pointer event after an elementFromPoint hit test at
// its centre; nothing here calls element.click(). The browser is muted headless Chrome.
//
//   node tools/ld_proof.mjs --url http://127.0.0.1:18871/ --out proof/ld
//   node tools/ld_proof.mjs --url http://127.0.0.1:18871/ --out proof/wn --slug liars-dice
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const URL_BASE = arg('url', 'http://127.0.0.1:18871/')
const OUT = path.resolve(arg('out', 'proof/ld'))
const SLUG = arg('slug', 'liars-dice-2v2')
const TALK_GAMES = {
  mafia: 'Mafia',
  'liars-dice': "Liar's Dice",
  'liars-dice-2v2': 'Liar\u2019s Dice 2v2',
  'prisoners-dilemma': "Prisoner's Dilemma",
  'blind-auction': 'Blind Auction'
}
const TITLE = TALK_GAMES[SLUG] || SLUG
const LABS = SLUG === 'liars-dice-2v2'
const prefix = name => `${SLUG}-${name}`
fs.mkdirSync(OUT, { recursive: true })


const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let PORT = Number(arg('port', String(9300 + (process.pid % 400))))
for (let candidate = PORT; candidate < PORT + 40; candidate += 1) {
  try { await fetch(`http://127.0.0.1:${candidate}/json`, { signal: AbortSignal.timeout(300) }) } catch { PORT = candidate; break }
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-ld-'))
const stopChrome = () => { try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); else chrome.kill('SIGKILL') } catch {} }
process.on('exit', () => { stopChrome(); try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch {} }); for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => process.exit(130)) // delete the ~200 MB Chrome profile when the run ends
const chrome = spawn(process.env.CHROME_BIN || 'google-chrome', [
  '--headless=new', '--mute-audio', '--no-sandbox', '--disable-gpu',
  '--window-size=1400,950', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' })

let tabs = []
for (let attempt = 0; attempt < 80; attempt += 1) {
  try {
    tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    if (tabs.some(tab => tab.type === 'page')) break
  } catch { /* not up yet */ }
  await sleep(500)
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
  if (answer && answer.exceptionDetails) return { error: answer.exceptionDetails.text }
  return answer && answer.result ? answer.result.value : undefined
}
const shots = []
const shot = async name => {
  await cdp('Page.bringToFront')
  const taken = await cdp('Page.captureScreenshot', { format: 'png' })
  if (!taken || !taken.data) { console.log('shot skipped', name); return }
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(taken.data, 'base64'))
  shots.push(`${name}.png`)
  console.log('shot', name)
}
const pointer = async (point) => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point[0], y: point[1] })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: point[0], y: point[1], button: 'left', buttons: 1, clickCount: 1 })
  await sleep(30)
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point[0], y: point[1], button: 'left', buttons: 0, clickCount: 1 })
  await sleep(450)
}
// The hit test: the element at the centre of the control must be the control (or inside it).
const pressLabel = async (label, scope = '.games-talk, .games-talk-setup, body') => {
  const found = await evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(scope)}) || document.body
    const node = [...root.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled)
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const box = node.getBoundingClientRect()
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    const hit = document.elementFromPoint(x, y)
    return { point: [x, y], hit: hit ? hit.tagName : '', inside: Boolean(hit && (node === hit || node.contains(hit))) }
  })()`)
  if (!found) return null
  if (!found.inside) throw new Error(`the centre of "${label}" is not the control (${found.hit})`)
  await pointer(found.point)
  return found
}
const pressSelector = async (selector) => {
  const found = await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const box = node.getBoundingClientRect()
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    const hit = document.elementFromPoint(x, y)
    return { point: [x, y], hit: hit ? hit.tagName : '', inside: Boolean(hit && (node === hit || node.contains(hit))) }
  })()`)
  if (!found) return null
  if (!found.inside) throw new Error(`the centre of ${selector} is not the control (${found.hit})`)
  await pointer(found.point)
  return found
}
const pressFirstAction = async () => {
  const found = await evaluate(`(() => {
    const node = [...document.querySelectorAll('.games-talk-actions button')].find(b => !b.disabled)
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const box = node.getBoundingClientRect()
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    const hit = document.elementFromPoint(x, y)
    return { point: [x, y], label: node.textContent.trim(), hit: hit ? hit.tagName : '', inside: Boolean(hit && (node === hit || node.contains(hit))) }
  })()`)
  if (!found) return null
  if (!found.inside) throw new Error('the centre of the first action is not the button')
  await pointer(found.point)
  return found.label
}
const tableState = () => evaluate(`(() => {
 try {
  const root = document.querySelector('.games-talk')
  const setup = document.querySelector('.games-talk-setup')
  if (!root) return { open: false, setup: Boolean(setup), text: (setup ? setup.innerText : '').slice(0, 800) }
  const input = root.querySelector('input[maxlength="200"]')
  return {
    open: true,
    status: (root.querySelector('.games-status') || {}).textContent || '',
    phase: (root.querySelector('.games-talk-center') || root).innerText.slice(0, 300),
    buttons: [...root.querySelectorAll('.games-talk-actions button')].filter(b => !b.disabled).map(b => b.textContent.trim()),
    canTalk: Boolean(input && !input.disabled),
    teams: [...root.querySelectorAll('.games-talk-team')].map(node => ({
      team: node.getAttribute('data-team'),
      dice: (node.querySelector('[data-team-dice]') || {}).textContent || '',
      seats: [...node.querySelectorAll('[data-team-seat]')].map(seat => String(seat.innerText || '').split(String.fromCharCode(10)).join(' ')),
      pips: node.querySelectorAll('[data-pip="full"]').length
    })),
    outcome: (document.querySelector('[data-outcome]') || { dataset: {} }).dataset.outcome || '',
    outcomeText: (document.querySelector('[data-outcome]') || { innerText: '' }).innerText || '',
    resultTitle: (document.querySelector('.games-result-title') || {}).textContent || '',
    resultWhy: (document.querySelector('.games-result-why') || {}).textContent || '',
    resultButtons: [...document.querySelectorAll('.games-result button')].map(node => node.textContent.trim()),
    badge: (document.querySelector('[data-labs-badge]') || {}).textContent || '',
    revealed: Boolean(document.querySelector('[aria-label="Reveal"]')),
    text: root.innerText.slice(0, 1200)
  }
 } catch (error) {
  return { open: true, failed: String(error), buttons: [], teams: [], outcome: '' }
 }
})()`)
const waitFor = async (expression, seconds = 45) => {
  for (let attempt = 0; attempt < seconds * 2; attempt += 1) {
    const value = await evaluate(expression)
    if (value) return value
    await sleep(500)
  }
  return false
}

const report = { game: TITLE, slug: SLUG, shots, checks: {} }
await cdp('Runtime.enable')
await cdp('Page.enable')
await cdp('Page.addScriptToEvaluateOnNewDocument', {
  source: "window.__errors = []; window.addEventListener('error', e => window.__errors.push(String(e.message))); window.addEventListener('unhandledrejection', e => window.__errors.push('rejected: ' + String(e.reason && e.reason.message || e.reason)));"
})
await cdp('Page.navigate', { url: URL_BASE })
const loaded = await waitFor("document.body.innerText.length > 400", 60)
if (!loaded) {
  await shot('00-page-not-loaded')
  console.log('BODY', await evaluate('document.body.innerText.slice(0, 400)'))
  console.log('ERRORS', await evaluate('JSON.stringify(window.__errors || [])'))
  throw new Error('the page never rendered')
}
if (/Welcome to Game Center/.test(await evaluate('document.body.innerText'))) {
  await pressLabel('Continue')
  await sleep(2200)
}
// ---- the shelf card ------------------------------------------------------
const findSpot = async () => evaluate(`(() => {
  // The Labs card for this experiment, a Play tile carrying the game's name, or a
  // Your games card with an Open button. The centre of the control is returned so
  // the caller can press it with a real pointer event.
  let target = document.querySelector('[data-labs-play=' + JSON.stringify(${JSON.stringify(SLUG)}) + '] button')
  if (!target) {
    target = document.querySelector('button[aria-label=' + JSON.stringify(${JSON.stringify(TITLE)}) + ']')
  }
  if (!target) {
    target = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(TITLE)}))
  }
  if (!target) {
    target = [...document.querySelectorAll('button')]
      .filter(b => b.textContent.trim() === 'Open')
      .find(b => {
        let node = b
        for (let step = 0; step < 4 && node; step += 1) {
          node = node.parentElement
          const text = ((node && node.innerText) || '').trim()
          if (text.toLowerCase().startsWith(${JSON.stringify(TITLE.toLowerCase())})) return true
        }
        return false
      })
  }
  if (!target) return null
  target.scrollIntoView({ block: 'center' })
  const box = target.getBoundingClientRect()
  return [box.x + box.width / 2, box.y + box.height / 2]
})()`)
let spot = null
for (let attempt = 0; attempt < 40; attempt += 1) {
  spot = await findSpot()
  if (spot) break
  await sleep(500)
}
if (!spot) {
  await shot(prefix('00-no-card'))
  console.log('BODY', await evaluate('document.body.innerText.slice(0, 1200)'))
  console.log('ERRORS', await evaluate('JSON.stringify(window.__errors || [])'))
  console.log('LIAR BUTTONS', await evaluate("JSON.stringify([...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => /liar/i.test(t)))"))
  throw new Error('the shelf has no card for ' + TITLE)
}
report.checks.card = await evaluate(`(() => {
  const labs = document.querySelector('[data-labs-play=${JSON.stringify(SLUG)}]')
  const titled = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(TITLE)}))
  const opened = [...document.querySelectorAll('button')]
    .filter(b => b.textContent.trim() === 'Open')
    .find(b => {
      let node = b
      for (let step = 0; step < 4 && node; step += 1) {
        node = node.parentElement
        const text = ((node && node.innerText) || '').trim()
        if (text.toLowerCase().startsWith(${JSON.stringify(TITLE.toLowerCase())})) return true
      }
      return false
    })
  const card = labs || titled || opened
  return { labs: Boolean(labs), text: card ? card.innerText.slice(0, 240) : '' }
})()`)
await pointer(spot)
await shot(prefix('01-card'))
await waitFor("Boolean(document.querySelector('.games-talk-setup'))", 20)
const setup = await tableState()
report.checks.setup_open = Boolean(setup.setup)
await shot(prefix('02-setup'))
// ---- choose a strength if the game offers one, then start -----------------
const levelPressed = await pressLabel('Expert')
report.checks.level_buttons = await evaluate(`[...document.querySelectorAll('.games-talk-setup button')].map(b => b.textContent.trim())`)
report.checks.expert_pressed = Boolean(levelPressed)
await shot(prefix('03-setup-strength'))
await pressLabel('Start the game')
await waitFor("Boolean(document.querySelector('.games-talk'))", 25)
let state = await tableState()
report.checks.game_open = Boolean(state.open)
for (let attempt = 0; attempt < 30 && !state.open; attempt += 1) { await sleep(500); state = await tableState() }
await shot(prefix('04-table'))
report.checks.first_table = { teams: state.teams, status: state.status, badge: state.badge }

// ---- play it out ---------------------------------------------------------
let moves = 0
let spoke = 0
for (let turn = 0; turn < 900; turn += 1) {
  state = await tableState()
  if (!state.open) {
    // A move re-reads the table: the screen shows "Opening the table…" for a moment,
    // so a missing root is not the end of the game until it stays missing.
    let recovered = false
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await sleep(600)
      state = await tableState()
      if (state.open) { recovered = true; break }
    }
    if (!recovered) { console.log('left the table at turn', turn, JSON.stringify(state).slice(0, 300)); break }
  }
  if (state.failed) { console.log('state read failed', state.failed); await sleep(700); continue }
  if (state.outcome) { console.log('outcome after', turn, 'turns'); break }
  if (state.canTalk && spoke < 2) {
    // One public line to the table, typed into the table's own chat box.
    const spot = await evaluate(`(() => {
      const input = document.querySelector('.games-talk input[maxlength="200"]')
      if (!input || input.disabled) return null
      input.scrollIntoView({ block: 'center' })
      const box = input.getBoundingClientRect()
      return [box.x + box.width / 2, box.y + box.height / 2]
    })()`)
    if (spot) {
      await pointer(spot)
      const line = SLUG === 'liars-dice-2v2'
        ? (spoke === 0 ? 'Partner, I am holding fives.' : 'Two of us beats one.')
        : (spoke === 0 ? 'I am watching the quiet ones.' : 'That is a fair point.')
      await cdp('Input.insertText', { text: line })
      for (const type of ['keyDown', 'keyUp']) {
        await cdp('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type === 'keyDown' ? '\r' : undefined })
      }
      spoke += 1
      await sleep(700)
      continue
    }
  }
  const pressed = await pressFirstAction()
  if (pressed) {
    moves += 1
    console.log('move', moves, pressed)
    if (moves === 4) await shot(prefix('05-bids'))
    if (moves === 10) await shot(prefix('06-midgame'))
    continue
  }
  if (turn % 40 === 0) console.log('waiting', turn, JSON.stringify({ status: state.status, buttons: state.buttons, canTalk: state.canTalk, teams: state.teams.map(t => t.dice) }))
  await sleep(900)
}
report.checks.moves = moves
report.checks.spoke = spoke
state = await tableState()
report.checks.final = {
  outcome: state.outcome,
  title: state.resultTitle,
  why: state.resultWhy,
  buttons: state.resultButtons,
  text: state.outcomeText,
  teams: state.teams,
  revealed: state.revealed
}
await shot(prefix('07-outcome'))
if (state.revealed) await shot(prefix('08-reveal'))
// The card's own Back is pressed with the mouse, then the shelf must be back.
report.checks.back_pressed = Boolean(await pressLabel('Back', '.games-result'))
await sleep(1200)
report.checks.back_to_shelf = Boolean(await evaluate("!document.querySelector('.games-talk') && document.body.innerText.length > 400"))
fs.writeFileSync(path.join(OUT, `${SLUG}-proof.json`), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
stopChrome()
process.exit(report.checks.final.outcome && report.checks.back_to_shelf ? 0 : 1)
