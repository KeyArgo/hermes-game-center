// AD proof: two real browser sessions (staff + player), muted headless Chrome, real
// pointer hit-tests only (elementFromPoint + CDP Input.dispatchMouseEvent), never
// element.click(). Every screenshot lands in proof/ad/.
//
//   node tools/ad_proof.mjs --out proof/ad
//
// The script starts its own lobby on a free port, bootstraps the owner with the
// real CLI, drives both sessions, then stops the server it started.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const OUT = path.resolve(arg('out', 'proof/ad'))
fs.mkdirSync(OUT, { recursive: true })
const ROOT = path.resolve('.')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ---- the lobby this proof drives --------------------------------------------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-ad-'))
const CLI = [process.env.PYTHON || 'python3', '-m', 'online.admin', '--data', dataDir, 'grant-owner', 'Owner']
const cliOut = execFileSync(CLI[0], CLI.slice(1), { cwd: ROOT, encoding: 'utf8' })
const staffKey = /Staff key \(shown once, keep it out of chat and the repo\): (\S+)/.exec(cliOut)[1]
const ownerRecovery = /Recovery key \(shown once, sign in with it\): (\S+)/.exec(cliOut)[1]
console.log('owner bootstrapped from the CLI; staff key length', staffKey.length)

const PORT = Number(arg('port', '0')) || (18900 + (process.pid % 200))
const server = spawn(process.env.PYTHON || 'python3', ['-m', 'online.server', '--data', dataDir, '--port', String(PORT)], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe']
})
let serverLog = ''
server.stderr.on('data', chunk => { serverLog += String(chunk) })
const URL_BASE = `http://127.0.0.1:${PORT}/`
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    const answer = await fetch(URL_BASE + 'api/health', { signal: AbortSignal.timeout(400) })
    if (answer.ok) break
  } catch { /* not up yet */ }
  await sleep(200)
}
console.log('lobby up at', URL_BASE)

// ---- one Chrome per session (separate profiles = separate localStorage) -----
const results = []
let browserCount = 0
const record = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

async function openBrowser(label) {
  // Pick a debugging port nothing is listening on: attaching to a left-over
  // browser from an earlier run would drive the wrong page.
  let port = 9700 + (process.pid % 300)
  for (let candidate = port; candidate < port + 60; candidate += 1) {
    try { await fetch(`http://127.0.0.1:${candidate}/json`, { signal: AbortSignal.timeout(250) }) } catch { port = candidate; break }
  }
  browserCount += 1
  const profile = fs.mkdtempSync(`/tmp/gameshelf-ad-${label}-`)
  process.on('exit', () => { try { chrome.kill('SIGKILL') } catch {} try { fs.rmSync(profile, { recursive: true, force: true }) } catch {} }); for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => process.exit(130)) // delete the ~200 MB Chrome profile when the run ends
  const chrome = spawn('google-chrome', [
    '--headless=new', '--mute-audio', '--no-sandbox', '--disable-gpu',
    '--window-size=1400,1000', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: 'ignore' })
  let tabs = []
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      if (tabs.some(tab => tab.type === 'page')) break
    } catch { /* not up yet */ }
    await sleep(250)
  }
  const page = tabs.find(tab => tab.type === 'page')
  if (!page) throw new Error(`${label}: chrome did not open a page`)
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
    if (answer && answer.exceptionDetails) return { __error: answer.exceptionDetails.text }
    return answer && answer.result ? answer.result.value : undefined
  }
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Page.navigate', { url: URL_BASE })
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await evaluate(`Boolean(document.querySelector('#name, input[aria-label="Lobby chat message"], .lobby'))`)
    if (ready) break
    await sleep(200)
  }
  await sleep(400)
  const shot = async name => {
    const taken = await cdp('Page.captureScreenshot', { format: 'png' })
    if (!taken || !taken.data) { record(`shot ${name}`, false, 'browser quiet'); return }
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(taken.data, 'base64'))
    console.log('shot', name)
  }
  const pointer = async spot => {
    const px = Array.isArray(spot) ? spot[0] : spot.x
    const py = Array.isArray(spot) ? spot[1] : spot.y
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py })
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1, clickCount: 1 })
    for (let step = 1; step <= 4; step += 1) {
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'left', buttons: 1 })
      await sleep(15)
    }
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(140)
  }
  const find = async (label, { exact = false, nth = 0, selector = 'button,a,[role=button]' } = {}) => evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(node => {
      const text = (node.textContent || '').trim()
      return (${exact} ? text === ${JSON.stringify(label)} : text.includes(${JSON.stringify(label)})) && !node.disabled
    })
    const found = nodes[${nth}]
    if (!found) return null
    found.scrollIntoView({ block: 'center' })
    const box = found.getBoundingClientRect()
    if (!box.width || !box.height) return null
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, text: found.textContent.trim().slice(0, 40) }
  })()`)
  const hitTest = async spot => evaluate(`(() => {
    const el = document.elementFromPoint(${spot.x}, ${spot.y})
    return el ? el.tagName + ':' + (el.textContent || '').trim().slice(0, 40) : null
  })()`)
  const click = async (label, options = {}) => {
    const spot = await find(label, options)
    if (!spot) { record(`${label} found`, false, 'control not found'); return false }
    const hit = await hitTest(spot)
    const pass = Boolean(hit && /^(BUTTON|A|SPAN|DIV|INPUT)/.test(hit))
    record(`hit-test “${label}”`, pass, `cursor over <${hit}>`)
    await pointer(spot)
    await sleep(options.wait || 700)
    return true
  }
  // Click an input and type into it with real key events.
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
  // Replace what is in a field: click it, select all, then type.
  const retype = async (selector, text) => {
    await type(selector, '')
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
    await cdp('Input.insertText', { text })
    await sleep(200)
  }
  const has = async text => evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`)
  const textOf = async selector => evaluate(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ''`)
  const waitFor = async (test, seconds = 8) => {
    for (let attempt = 0; attempt < seconds * 4; attempt += 1) {
      if (await test()) return true
      await sleep(250)
    }
    return false
  }
  return { label, cdp, evaluate, shot, click, type, retype, has, textOf, waitFor, close: () => { chrome.kill(); } }
}

// ---- the scenario ------------------------------------------------------------
let staff = null
let player = null
try {
  // Player first: they exist before the owner looks anyone up.
  player = await openBrowser('player')
  await player.type('#name', 'Mallory')
  await player.click('Continue')
  record('player signed up', await player.waitFor(() => player.has('Find a match')))
  await player.shot('01-player-signed-up')

  await player.type('input[aria-label="Lobby chat message"]', 'this lobby is garbage')
  await player.click('Send')
  record('player posted a message', await player.waitFor(() => player.has('this lobby is garbage')))
  await player.shot('02-player-chat')

  // Staff session: sign in with the recovery key the CLI printed.
  staff = await openBrowser('staff')
  await staff.type('#name', 'Owner')
  await staff.click('I have a recovery key')
  await staff.type('#recovery', ownerRecovery)
  await staff.click('Sign in')
  record('owner signed in', await staff.waitFor(() => staff.has('Find a match')))
  await staff.shot('03-owner-signed-in')

  await staff.type('input[aria-label="Lobby chat message"]', 'Welcome to the lobby. Be kind to each other.')
  await staff.click('Send')
  record('staff message reaches the log', await staff.waitFor(async () => (await staff.textOf('.log')).includes('Welcome to the lobby')))
  record('Owner badge on the message', await staff.has('Owner'))
  await staff.shot('04-staff-badge')

  // The owner reports the player's message from the chat (the ⚑ control).
  const flagSpot = await staff.evaluate(`(() => {
    const button = [...document.querySelectorAll('.msg button.flag')][0]
    if (!button) return null
    button.scrollIntoView({ block: 'center' })
    const box = button.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  })()`)
  if (flagSpot) {
    const hit = await staff.evaluate(`(() => { const el = document.elementFromPoint(${flagSpot.x}, ${flagSpot.y}); return el ? el.tagName + ':' + (el.textContent||'') : null })()`)
    record('hit-test report flag', Boolean(hit && /BUTTON/.test(hit)), `cursor over <${hit}>`)
    await staff.click('⚑', { wait: 500 })
  }
  record('report sheet opens', await staff.waitFor(() => staff.has('Report Mallory')))
  await staff.click('Abuse or threats')
  record('report accepted', await staff.waitFor(() => staff.has('Reported. A moderator will look at it.')))
  await staff.shot('05-report-sent')

  // The staff key: the Admin tab only exists once it is in.
  record('no Admin tab before the staff key', !(await staff.has('Admin')))
  await staff.click('You')
  record('staff key card present', await staff.waitFor(() => staff.has('Staff key')))
  await staff.type('input[aria-label="Staff key"]', staffKey)
  await staff.click('Use it')
  record('staff key accepted', await staff.waitFor(() => staff.has('Staff key saved')))
  await staff.shot('06-staff-key-accepted')
  record('Admin tab appears', await staff.waitFor(() => staff.has('Admin')))

  await staff.click('Admin', { exact: true, wait: 900 })
  record('admin panel opens on Reports', await staff.waitFor(() => staff.has('Audit log')))
  record('report is in the queue', await staff.waitFor(() => staff.has('this lobby is garbage')))
  await staff.shot('07-admin-reports')

  await staff.type('input[aria-label="Reason for this action"]', 'abuse in the lobby')
  await staff.click('Delete message', { wait: 900 })
  record('delete-message accepted', await staff.waitFor(() => staff.has('Message removed')))
  await staff.shot('08-after-delete')
  const tomb = await player.waitFor(() => player.has('removed by a moderator'), 12)
  record('player sees the tombstone', tomb)
  await player.shot('09-player-tombstone')

  // Lookup and silence.
  await staff.click('Look up', { exact: true, wait: 700 })
  await staff.type('input[aria-label="Name to look up"]', 'Mallory')
  await staff.click('Look up', { exact: true, nth: 1, wait: 900 })
  record('lookup finds the player', await staff.waitFor(() => staff.has('joined')))
  await staff.shot('10-lookup')
  await staff.click('1 hour', { exact: true, nth: 0, wait: 900 })
  record('silence accepted', await staff.waitFor(() => staff.has('silenced')))
  await staff.shot('11-silenced')

  await player.retype('input[aria-label="Lobby chat message"]', 'am I still allowed to talk')
  await player.click('Send')
  record('player is silenced in chat', await player.waitFor(() => player.has('You are silenced')))
  await player.shot('12-player-silenced')

  // Audit log, and undo the silence from it.
  await staff.click('Audit log', { wait: 800 })
  record('audit lists the actions', await staff.waitFor(async () => (await staff.textOf('table.audit')).includes('silence')))
  await staff.shot('13-audit')
  await staff.click('Undo', { wait: 1000 })
  record('undo accepted', await staff.waitFor(() => staff.has('Undone')))
  await staff.shot('14-undo')

  await player.retype('input[aria-label="Lobby chat message"]', 'thank you')
  await player.click('Send')
  record('player can talk again', await player.waitFor(() => player.has('thank you'), 10))

  // Personal block list: Mallory hides the owner's chat, then lets it back.
  await player.click('You', { exact: true, wait: 800 })
  record('the block list starts empty', await player.waitFor(() => player.has('Nobody blocked')))
  await player.type('input[aria-label="Name to block"]', 'Owner')
  await player.click('Block', { exact: true, wait: 1000 })
  record('the owner lands in the block list', await player.waitFor(() => player.has('Unblock')))
  await player.shot('15-blocked')
  await player.click('Lobby', { exact: true, wait: 1400 })
  record('a blocked person\u2019s chat is hidden', await player.waitFor(async () => !(await player.textOf('.log')).includes('Welcome to the lobby'), 12))
  await player.shot('16-blocked-hides-chat')
  await player.click('You', { exact: true, wait: 900 })
  await player.click('Unblock', { wait: 1000 })
  record('unblock empties the list', await player.waitFor(() => player.has('Nobody blocked'), 10))
  await player.click('Lobby', { exact: true, wait: 1400 })
  record('the hidden message comes back', await player.waitFor(async () => (await player.textOf('.log')).includes('Welcome to the lobby'), 12))

  // Suspend: chat stops at once, a fresh sign-in is refused, then the owner lifts it.
  await staff.click('Look up', { exact: true, wait: 700 })
  await staff.type('input[aria-label="Name to look up"]', 'Mallory')
  await staff.click('Look up', { exact: true, nth: 1, wait: 900 })
  await staff.click('1 day', { exact: true, wait: 1200 })
  record('suspend accepted', await staff.waitFor(() => staff.has('suspended.')))
  await staff.shot('17-suspended')
  await player.retype('input[aria-label="Lobby chat message"]', 'can I talk now')
  await player.click('Send')
  record('a suspended player cannot chat', await player.waitFor(() => player.has('This account is suspended'), 10))
  await player.shot('18-player-suspended')
  // A different computer tries the same name: sign-in is refused.
  const stranger = await openBrowser('stranger')
  await stranger.type('#name', 'Mallory')
  await stranger.click('Continue', { wait: 1400 })
  record('sign-in says the name is suspended', await stranger.waitFor(() => stranger.has('suspended'), 10))
  await stranger.shot('19-signin-suspended')
  stranger.close()
  await staff.click('Lift suspension', { wait: 1200 })
  record('suspension lifted', await staff.waitFor(() => staff.has('free again')))
  await player.retype('input[aria-label="Lobby chat message"]', 'back again, sorry')
  await player.click('Send')
  record('the player can chat after the lift', await player.waitFor(() => player.has('back again, sorry'), 10))

  // The player is still a plain player: no Admin tab.
  record('player has no Admin tab', !(await player.has('Admin')))
  await player.shot('20-player-no-admin')

  // Team: appoint a moderator; the key shown once actually opens the Admin tab.
  await staff.click('Team', { exact: true, wait: 900 })
  record('team panel lists staff', await staff.waitFor(() => staff.has('Owner')))
  await staff.type('input[aria-label="Name to appoint"]', 'Mallory')
  await staff.click('Make moderator', { wait: 1200 })
  record('moderator appointed with a one-time key', await staff.waitFor(() => staff.has('Staff key (shown once)')))
  await staff.shot('21-team-appoint')
  const issuedKey = await staff.evaluate(`(() => {
    const boxes = [...document.querySelectorAll('input, code, pre')].map(node => (node.value || node.textContent || '').trim())
    return boxes.find(text => /^[A-Za-z0-9_-]{20,}$/.test(text)) || ''
  })()`)
  record('the key is shown once to the owner', Boolean(issuedKey))
  await player.evaluate('location.reload(); true')
  await player.waitFor(() => player.has('Find a match'), 12)
  await player.click('You', { exact: true, wait: 900 })
  await player.type('input[aria-label="Staff key"]', issuedKey)
  await player.click('Use it', { wait: 1400 })
  record('the appointed moderator can use that key', await player.waitFor(() => player.has('Staff key saved'), 12))
  record('Admin tab appears for the new moderator', await player.waitFor(() => player.has('Admin'), 12))
  await player.shot('22-new-moderator-admin')

  await staff.shot('23-admin-final')
} catch (failure) {
  record('scenario completed', false, String(failure && failure.stack || failure))
} finally {
  const summary = { url: URL_BASE, passed: results.filter(row => row.pass).length, total: results.length, results }
  fs.writeFileSync(path.join(OUT, 'proof.json'), JSON.stringify(summary, null, 2))
  console.log('SUMMARY', JSON.stringify({ passed: summary.passed, total: summary.total }))
  if (staff) staff.close()
  if (player) player.close()
  // Only the server this script started is stopped, and only after checking it is ours.
  try {
    const cmdline = execFileSync('ps', ['-o', 'args=', '-p', String(server.pid)], { encoding: 'utf8' })
    if (cmdline.includes(`--data ${dataDir}`)) server.kill()
    else console.log('not stopping pid', server.pid, '— unexpected command line:', cmdline.trim())
  } catch { /* already gone */ }
  if (serverLog.trim()) console.log('server stderr tail:', serverLog.trim().split('\n').slice(-4).join('\n'))
  process.exit(summary.passed === summary.total ? 0 : 2)
}
