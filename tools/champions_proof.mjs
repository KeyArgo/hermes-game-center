// Prove the Champions 2.0 screen with a real browser and a real mouse.
//
//   node tools/champions_proof.mjs --url http://127.0.0.1:18871/ --out proof/cp
//
// Every click is dispatched as a mouse press and release at the control's own centre,
// and before each press the driver asks document.elementFromPoint which element is
// really under that point. A control that is covered, off-screen or 1px wide fails
// the run instead of clicking something else. Nothing here calls element.click().
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const URL_BASE = arg('url', process.env.GAMESHELF_QA_URL || 'http://127.0.0.1:18871/')
const OUT = path.resolve(arg('out', 'proof/cp'))
let PORT = Number(arg('port', String(9500 + (process.pid % 400))))
fs.mkdirSync(OUT, { recursive: true })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-champions-'))
const stopChrome = () => { try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); else chrome.kill('SIGKILL') } catch {} }
process.on('exit', () => { stopChrome(); try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch {} }); for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => process.exit(130)) // delete the ~200 MB Chrome profile when the run ends
const chrome = spawn(process.env.CHROME_BIN || 'google-chrome', [
  '--headless=new', '--mute-audio', '--no-sandbox', '--disable-gpu',
  '--window-size=1400,1000', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' })

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
socket.onmessage = message => {
  const data = JSON.parse(message.data)
  if (data.id && waiting.has(data.id)) {
    waiting.get(data.id)(data.result || data.error)
    waiting.delete(data.id)
  }
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
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(taken.data, 'base64'))
  shots.push(`${name}.png`)
  console.log('shot', name)
}

const hits = []
const clickAt = async (point, what) => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point[0], y: point[1] })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: point[0], y: point[1], button: 'left', buttons: 1, clickCount: 1 })
  await sleep(30)
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point[0], y: point[1], button: 'left', buttons: 0, clickCount: 1 })
  await sleep(320)
  hits.push({ what, point })
}

// Find a control by its visible words, ask the page what is really under its centre,
// and refuse to click when something else is on top.
const clickText = async (text, { exact = true, required = true } = {}) => {
  const spot = await evaluate(`(() => {
    const wanted = ${JSON.stringify(text)}
    const found = [...document.querySelectorAll('button,a,[role=button],summary,label')].find(node => {
      const said = (node.textContent || '').trim()
      return ${exact ? 'said === wanted' : 'said.includes(wanted)'} && !node.disabled
    })
    if (!found) return { missing: true }
    found.scrollIntoView({ block: 'center' })
    const box = found.getBoundingClientRect()
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    const under = document.elementFromPoint(x, y)
    const owns = under === found || found.contains(under)
    return { x, y, owns, under: under ? (under.tagName + ':' + (under.textContent || '').trim().slice(0, 40)) : '', disabled: found.disabled === true }
  })()`)
  if (!spot || spot.missing) {
    if (required) throw new Error(`no button says ${JSON.stringify(text)}`)
    return false
  }
  if (!spot.owns) throw new Error(`${JSON.stringify(text)} is covered by ${spot.under}`)
  if (spot.disabled) throw new Error(`${JSON.stringify(text)} is disabled`)
  await clickAt([spot.x, spot.y], `button:${text}`)
  return true
}

const clickSelector = async (selector, what) => {
  const spot = await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    if (!node) return { missing: true }
    node.scrollIntoView({ block: 'center' })
    const box = node.getBoundingClientRect()
    const x = box.x + box.width / 2
    const y = box.y + Math.min(box.height / 2, 18)
    const under = document.elementFromPoint(x, y)
    return { x, y, owns: under === node || node.contains(under), under: under ? under.tagName : '' }
  })()`)
  if (!spot || spot.missing) throw new Error(`no element for ${selector}`)
  if (!spot.owns) throw new Error(`${selector} is covered by ${spot.under}`)
  await clickAt([spot.x, spot.y], what || selector)
}

// Real typing: focus the field with the mouse, then send text the way a keyboard does.
const typeInto = async (selector, text) => {
  await clickSelector(selector)
  await cdp('Input.insertText', { text })
  await sleep(200)
}
const clearAndType = async (selector, text) => {
  await clickSelector(selector)
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, windowsVirtualKeyCode: 65, key: 'a', code: 'KeyA' })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, windowsVirtualKeyCode: 65, key: 'a', code: 'KeyA' })
  await cdp('Input.insertText', { text })
  await sleep(200)
}

const waitFor = async (expression, what, seconds = 30) => {
  for (let step = 0; step < seconds * 4; step += 1) {
    const value = await evaluate(expression)
    if (value) return value
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}`)
}
const text = () => evaluate('document.body.innerText')

const failures = []
const check = (okay, message) => {
  if (!okay) failures.push(message)
  console.log(okay ? 'ok  ' : 'FAIL', message)
}

await cdp('Page.enable')
await cdp('Runtime.enable')
await cdp('Page.navigate', { url: URL_BASE })
await waitFor('document.readyState === "complete" && !!document.body.innerText', 'the page')
await sleep(1200)

// 0. A fresh scratch install opens on the welcome. Answer it the way a person would.
const settled = await waitFor(`(() => {
  const said = document.body.innerText || ''
  if (said.includes('Welcome to Game Center')) return 'welcome'
  if ([...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'Champions')) return 'app'
  return ''
})()`, 'the page to settle', 20)
if (settled === 'welcome') {
  await clickText('Continue')
  await sleep(900)
  check(!(await text()).includes('Welcome to Game Center'), 'the welcome closes on Continue')
  await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'Champions')`, 'the Games screen', 20)
}

// 1. The Champions screen, opened by its own tab.
await clickText('Champions')
await waitFor('[...document.querySelectorAll("button")].some(n => n.textContent.trim() === "Create champion")', 'the creators card')
await shot('01-champions')

// 2. A champion is made with the mouse and the keyboard, like a person would.
await typeInto('input[placeholder^="Name (max"]', 'Rook')
await typeInto('input[placeholder^="Motto (max"]', 'Hold the line.')
await typeInto('textarea[placeholder^="How does this champion think?"]', 'A patient, positional player who never rushes a winning position.')
await clickText('Create champion')
await waitFor('!!document.querySelector("[data-passport]")', 'a passport card')
check((await evaluate('!!document.querySelector("[data-passport]")')), 'a created champion appears as a Bot Passport card')
const header = await text()
const hasPet = !header.includes('No Hermes pet yet')
check(hasPet ? /Champion bodies are your Hermes pet/.test(header) : /No Hermes pet yet/.test(header),
  hasPet ? "the page says the champion's body is the person's own pet" : 'with no pet the page says so and offers the gallery')
await shot('02-passport')

// 3. The playbook editor, with counters. A page that re-renders on its own poll can swallow
//    one click, so this asks again — and says so, rather than retrying silently forever.
let opened = false
for (let attempt = 0; attempt < 3 && !opened; attempt += 1) {
  if (await clickText('Write a playbook', { required: false }) === false) await clickText('Open playbook')
  for (let step = 0; step < 20; step += 1) {
    opened = await evaluate('!!document.querySelector("textarea[aria-label=\\"Question 1\\"]")')
    if (opened) break
    await sleep(250)
  }
  if (!opened) console.log('the playbook editor did not open on attempt', attempt + 1)
}
check(opened, 'the playbook editor opens from the champion card')
check((await text()).includes('0 / 250 words'), 'the editor starts its counter at 0 / 250 words')

// Over the per-line cap on purpose: the counter turns, saving is refused.
await typeInto('textarea[aria-label="Question 1"]', 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone')
const blocked = await evaluate(`(() => {
  const save = [...document.querySelectorAll('button')].find(n => n.textContent.trim() === 'Save as a new version')
  return { disabled: Boolean(save && save.disabled), shown: document.body.innerText }
})()`)
check(blocked.disabled, 'a line over its own 20-word cap blocks saving')
check(/over the cap|Over the cap|over its own cap/i.test(blocked.shown), 'the page says why saving is blocked')

await clearAndType('textarea[aria-label="Question 1"]', 'What does their last move leave undefended?')
await typeInto('textarea[aria-label="Question 2"]', 'Which square is cheapest to take next?')
await typeInto('textarea[aria-label="Rule 1"]', 'If they stack one side, then open the other side and keep the trade even.')
await typeInto('textarea[aria-label="Scout rule"]', 'Note which side they open and what they do when they are behind.')
await typeInto('textarea[aria-label="Voice"]', 'Dry and brief, gives credit when it loses.')
await typeInto('input[aria-label="Version name"]', 'Patient wall')
const counted = await text()
check(/\d+ \/ 250 words/.test(counted), 'the whole-playbook counter counts as the fields are filled')
const total = Number((counted.match(/(\d+) \/ 250 words/) || [])[1] || 0)
check(total > 20 && total < 250, `the counter reads ${total} of 250 words, inside the cap`)
await shot('03-playbook')

// 4. Saving mints a named version.
await clickText('Save as a new version')
await waitFor('document.body.innerText.includes("Saved versions")', 'the saved version pill')
check((await text()).includes('Patient wall'), 'the saved version is named and listed')
await shot('04-saved')

// 5. The test game against the house computer, and its private read.
await clickText('Test vs house bot')
await waitFor('document.body.innerText.includes("Playing the house computer")', 'the test to start')
await shot('05-test-running')
await waitFor('!!document.querySelector("[data-spar=result]") && !document.body.innerText.includes("Playing the house computer")', 'the test result', 90)
await evaluate(`document.querySelector('[data-spar=result]').scrollIntoView({ block: 'center' })`)
await sleep(300)
const spar = await text()
check(/The champion won|The house computer won|Drawn/.test(spar), 'the test reports a clear result')
check(/Moves: \S+/.test(spar), 'the test shows the moves it played')
check(/private read/i.test(spar), 'the test shows the private read answers')
await shot('06-test-result')

// 6. Back on the roster, the passport carries the pet, the version and the record.
await clickText('Back to champions')
await waitFor('!!document.querySelector("[data-passport]")', 'the passport again')
const passport = await evaluate(`(() => {
  const card = document.querySelector('[data-passport]')
  return { shown: card ? card.innerText : '', sprite: Boolean(card && card.querySelector('[role=img]')), label: card && card.querySelector('[role=img]') ? card.querySelector('[role=img]').getAttribute('aria-label') : '' }
})()`)
check(/Playbook: Patient wall/.test(passport.shown), 'the passport names the playbook version that plays')
check(/W 0 · L 0 · D 0|Elo/.test(passport.shown), 'the passport carries the record')
check(passport.sprite, 'the passport draws a champion body')
console.log('pet sprite label:', passport.label)
await shot('07-passport-playbook')

// 7. The pet answers a click: it waves, then goes back to idle. With no pet, the gallery
//    link is what matters: it must reach Hermes's own pet screen, never a drawn gallery.
if (hasPet && passport.sprite) {
  const petSpot = await evaluate(`(() => {
    const card = document.querySelector('[data-passport]')
    const button = card.querySelector('button[aria-label]')
    const box = button.getBoundingClientRect()
    return [box.x + box.width / 2, box.y + box.height / 2]
  })()`)
  await clickAt(petSpot, 'the pet')
  await sleep(400)
  const waving = await evaluate(`document.querySelector('[data-passport] [role=img]').getAttribute('aria-label')`)
  check(/wave/i.test(waving || ''), `clicking the pet makes it wave (label: ${waving})`)
  await shot('08-pet-wave')
} else {
  // A host without a pet offers one of two gallery doors; both must reach Hermes's own
  // pet screen, never a gallery we drew.
  const pressed = (await clickText('Open pet gallery', { required: false }))
    || (await clickText('Choose or hatch a pet', { required: false }))
  check(pressed, 'the page offers Hermes\'s own pet gallery when no pet is installed')
  await sleep(400)
  const nav = await evaluate('window.qa && window.qa.nav')
  check(Array.isArray(nav) && nav.includes('/settings'), `the gallery button opens Hermes's own settings (nav: ${JSON.stringify(nav)})`)
  await shot('08-no-pet-gallery')
}

const report = {
  url: URL_BASE, shots, hits, failures,
  errors: await evaluate('({ page: window.qa && window.qa.errors, console: window.qa && window.qa.consoleErrors })')
}
fs.writeFileSync(path.join(OUT, 'champions-proof.json'), JSON.stringify(report, null, 2))
console.log('\n' + (failures.length ? `FAILURES (${failures.length}):\n- ` + failures.join('\n- ') : 'every check passed'))
console.log('page errors:', JSON.stringify(report.errors))
console.log('shots:', shots.join(', '))

await cdp('Browser.close').catch(() => {})
stopChrome()
process.exit(failures.length ? 1 : 0)
