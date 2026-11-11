// Prove "watch it think" and the Corner Coach with a real mouse, in a muted headless Chrome.
//
// Every press here is a real CDP mouse press on the control's own centre, checked with
// elementFromPoint first, so a hidden or covered control fails the run instead of passing it.
//
//   node tools/think_proof.mjs --url http://127.0.0.1:18764/ --out proof/wt
//
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const URL_BASE = arg('url', 'http://127.0.0.1:18764/')
const OUT = path.resolve(arg('out', 'proof/wt'))
let PORT = Number(arg('port', String(9500 + (process.pid % 400))))
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
const profile = fs.mkdtempSync('/tmp/gameshelf-think-')
process.on('exit', () => { try { chrome.kill('SIGKILL') } catch {} try { fs.rmSync(profile, { recursive: true, force: true }) } catch {} }); for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => process.exit(130)) // delete the ~200 MB Chrome profile when the run ends
const chrome = spawn('google-chrome', [
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

// A real pointer, pressed on the centre of the control. The centre is hit-tested
// first: whatever is actually on top there must be the control itself.
const pointer = async point => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point[0], y: point[1] })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: point[0], y: point[1], button: 'left', buttons: 1, clickCount: 1 })
  for (let step = 1; step <= 4; step += 1) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point[0] + step * 0.4, y: point[1] + step * 0.4, button: 'left', buttons: 1 })
    await sleep(14)
  }
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point[0], y: point[1], button: 'left', buttons: 0, clickCount: 1 })
}

const hitTest = async (point, selectorText) => {
  const hit = await evaluate(`(() => {
    const node = document.elementFromPoint(${point[0]}, ${point[1]})
    if (!node) return 'nothing'
    const owner = node.closest('button, input, section, a')
    return owner ? owner.tagName + '|' + (owner.textContent || '').trim().slice(0, 40) : node.tagName
  })()`)
  if (String(hit).startsWith('nothing')) throw new Error(`nothing at ${point} for ${selectorText}`)
  return hit
}

const centreOf = async expression => evaluate(`(() => {
  const node = ${expression}
  if (!node) return null
  node.scrollIntoView({ block: 'center' })
  const box = node.getBoundingClientRect()
  if (!box.width || !box.height) return null
  return [box.x + box.width / 2, box.y + box.height / 2]
})()`)

const pressButton = async label => {
  const spot = await centreOf(`[...document.querySelectorAll('button')]
    .find(node => node.textContent.trim() === ${JSON.stringify(label)} && !node.disabled)`)
  if (!spot) return false
  await hitTest(spot, label)
  await pointer(spot)
  await sleep(500)
  return true
}

const pressFirst = async selector => {
  const spot = await centreOf(`[...document.querySelectorAll(${JSON.stringify(selector)})]
    .find(node => !node.disabled)`)
  if (!spot) return false
  await hitTest(spot, selector)
  await pointer(spot)
  await sleep(600)
  return true
}

const typeText = async (selector, text) => {
  const spot = await centreOf(`document.querySelector(${JSON.stringify(selector)})`)
  if (!spot) return false
  await hitTest(spot, selector)
  await pointer(spot)
  await cdp('Input.insertText', { text })
  await sleep(200)
  return true
}

const state = () => evaluate(`(() => {
  const root = document.querySelector('.games-talk')
  const setup = document.querySelector('.games-talk-setup')
  if (!root) return { open: false, setup: Boolean(setup), text: (document.body.innerText || '') }
  const think = document.querySelector('.games-think')
  const coach = document.querySelector('.games-coach')
  const coachInput = coach ? coach.querySelector('input') : null
  const scratch = document.querySelector('.games-think-scratch')
  const actions = [...root.querySelectorAll('.games-talk-actions button')].filter(node => !node.disabled)
  const talk = root.querySelector('input[maxlength="200"]')
  return {
    open: true,
    setup: false,
    over: Boolean(document.querySelector('[aria-label="Reveal"]')),
    actions: actions.map(node => node.textContent.trim()),
    canTalk: Boolean(talk && !talk.disabled),
    think: think ? think.innerText : '',
    coach: coach ? coach.innerText : '',
    coachInput: Boolean(coachInput && !coachInput.disabled),
    scratch: scratch ? scratch.innerText : '',
    thinkFit: think ? (() => {
      const panel = think.getBoundingClientRect()
      const block = scratch ? scratch.getBoundingClientRect() : null
      return {
        panel: [Math.round(panel.height), Math.round(think.scrollHeight)],
        scratchTop: block ? Math.round(block.top - panel.top) : null,
        scratchHeight: block ? Math.round(block.height) : null,
        scratchInside: block ? block.top >= panel.top && block.bottom <= panel.bottom + 1 : null
      }
    })() : null,
    log: [...root.querySelectorAll('.games-talk-log li')].map(node => node.innerText),
    text: root.innerText
  }
})()`)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(ok ? 'ok  ' : 'FAIL', name, detail)
}

const main = async () => {
  await cdp('Runtime.enable')
  await cdp('Page.navigate', { url: URL_BASE })
  await sleep(3200)
  if (/Welcome to Game Center/.test(await evaluate('document.body.innerText'))) {
    await pressButton('Continue')
    await sleep(2200)
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!(await pressButton('Back'))) break
    await sleep(400)
  }
  const opened = await evaluate(`(() => {
    const direct = [...document.querySelectorAll('button')].find(b => b.textContent.includes("Prisoner's Dilemma"))
    if (direct) return true
    // An installed talking table sits in Your games as a card with an Open button.
    const row = [...document.querySelectorAll('button')]
      .filter(b => b.textContent.trim() === 'Open')
      .find(b => {
        let node = b
        for (let step = 0; step < 4 && node; step += 1) {
          node = node.parentElement
          const text = ((node && node.innerText) || '').trim().toLowerCase()
          if (text.startsWith("prisoner's dilemma")) return true
        }
        return false
      })
    return Boolean(row)
  })()`)
  if (!opened) throw new Error('no Prisoner\'s Dilemma card')
  const card = await centreOf(`(() => {
    const direct = [...document.querySelectorAll('button')].find(b => b.textContent.includes("Prisoner's Dilemma"))
    if (direct) return direct
    return [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Open').find(b => {
      let node = b
      for (let step = 0; step < 4 && node; step += 1) {
        node = node.parentElement
        if (((node && node.innerText) || '').trim().toLowerCase().startsWith("prisoner's dilemma")) return true
      }
      return false
    }) || null
  })()`)
  if (!card) throw new Error('the Prisoner\'s Dilemma card could not be located on screen')
  await hitTest(card, 'the game card')
  await pointer(card)
  await sleep(1800)
  const waitForSetup = async ms => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evaluate("Boolean(document.querySelector('.games-talk-setup'))")) return true
      await sleep(500)
    }
    return false
  }
  if (!(await waitForSetup(9000))) {
    // A table from an earlier run may still be open: close it and start from the seats.
    for (const label of ['New table', 'Set up a new table']) {
      if (await waitForSetup(1000)) break
      if (await pressButton(label)) await sleep(2000)
    }
  }
  if (!(await waitForSetup(9000))) {
    throw new Error('the setting-up screen did not open')
  }
  // Three seats, one of them the owner's own bot: a whisper needs a bot to hear it.
  check('three seats offered', await pressButton('3 seats'))
  check('agent seat offered', await pressButton('Seat your agent'))
  await shot('01-setup-agent-seated')
  check('table started', await pressButton('Start the game'))
  const waitForTable = async ms => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evaluate("Boolean(document.querySelector('.games-talk'))")) return true
      await sleep(400)
    }
    return false
  }
  if (!(await waitForTable(8000))) {
    await pressButton('Start the game')
    if (!(await waitForTable(10000))) throw new Error('the table never opened')
  }
  await sleep(600)

  let sawCoachOpen = false
  let whispered = false
  let whisperShown = false
  let sawPanel = false
  let closedShot = false
  let said = 0
  const waitFor = async (test, ms = 6000) => {
    const until = Date.now() + ms
    let last = await state()
    while (Date.now() < until) {
      if (test(last)) return last
      await sleep(500)
      last = await state()
    }
    return last
  }
  for (let turn = 0; turn < 200; turn += 1) {
    const now = await state()
    if (!now.open) break
    if (now.over) break
    if (now.coach && /Corner Coach/.test(now.coach) && !sawCoachOpen && now.coachInput) {
      sawCoachOpen = true
      await shot('02-coach-window-open')
      fs.writeFileSync(path.join(OUT, '02-coach-window-open.txt'), now.coach)
    }
    if (!whispered && now.coachInput) {
      const typed = await typeText('.games-coach input', 'Keep your side of the bargain this round.')
      if (typed) {
        const pressed = await pressButton('Whisper')
        const after = await waitFor(row => /sent|Whispered/.test(row.coach) && !row.coachInput, 8000)
        whispered = pressed && /sent|Whispered/.test(after.coach)
        check('whisper accepted', whispered, after.coach.replace(/\n/g, ' · ').slice(0, 220))
        const logged = await waitFor(row => row.log.some(line => /Coach/.test(line) && /whispered:/.test(line)), 6000)
        check('log says Coach whispered',
          logged.log.some(line => /Coach/.test(line) && /whispered:/.test(line)),
          logged.log.filter(line => /Coach/.test(line)).join(' | '))
        await shot('03-whisper-sent')
      }
    }
    if (whispered && now.think && /your whisper/i.test(now.think) && !whisperShown) {
      whisperShown = true
      fs.writeFileSync(path.join(OUT, '03b-whisper-in-panel.txt'), now.think)
      await shot('03b-whisper-in-panel')
      check('whisper shown in the panel', true, now.think.replace(/\n/g, ' · ').slice(0, 200))
    }
    if (now.scratch && !sawPanel) {
      sawPanel = true
      fs.writeFileSync(path.join(OUT, '04-think-panel.txt'), now.think)
      fs.writeFileSync(path.join(OUT, '04-think-panel-fit.json'), JSON.stringify(now.thinkFit, null, 2))
      await shot('04-think-panel')
      check('read checklist shown', /what i know/i.test(now.think) && /what they did/i.test(now.think))
      check('working shown', /My own read says this round/.test(now.think), now.think.replace(/\n/g, ' · ').slice(0, 160))
      check('action shown', /\[Cooperate\]/.test(now.think), now.think.replace(/\n/g, ' · ').slice(0, 200))
    }
    if (sawPanel && !closedShot && now.coach && !now.coachInput && /waiting|sent/.test(now.coach)) {
      closedShot = true
      await shot('05-coach-closed')
    }
    if (now.canTalk && said < 8) {
      const typed = await typeText('.games-talk input[maxlength="200"]', 'I would rather we both did well here.')
      if (typed) {
        said += 1
        await pressButton('Say it')
        await sleep(700)
      }
      continue
    }
    if (now.actions.length) {
      if (!(await pressFirst('.games-talk-actions button'))) break
      continue
    }
    await sleep(700)
  }
  const last = await state()
  fs.writeFileSync(path.join(OUT, '06-final-screen.txt'), last.text || '')
  await shot('06-final-screen')
  check('coach window was seen open', sawCoachOpen)
  check('the working panel filled', sawPanel)
  if (whispered && !whisperShown) check('whisper shown in the panel', false, 'the panel never carried it')
  const failed = results.filter(row => !row.ok)
  if (pageErrors.length) console.log('page errors:', pageErrors.slice(0, 4).join('\n'))
  fs.writeFileSync(path.join(OUT, 'think-proof.json'), JSON.stringify({ results, shots, pageErrors }, null, 2))
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed`)
  if (failed.length) process.exitCode = 1
}

try {
  await main()
} catch (error) {
  console.error('PROOF FAILED:', error.message)
  try {
    const text = await evaluate('document.body.innerText')
    fs.writeFileSync(path.join(OUT, '99-failure.txt'), String(text || ''))
  } catch { /* the page may be gone */ }
  try { await shot('99-failure') } catch { /* the page may be gone */ }
  process.exitCode = 1
} finally {
  try { socket.close() } catch { /* already closed */ }
  chrome.kill()
  await sleep(300)
  fs.rmSync(profile, { recursive: true, force: true })
}
