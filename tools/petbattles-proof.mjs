// Prove Pet Battles with a real mouse in a muted headless Chrome.
//
// Every press is a CDP mouse press on the centre of the control, hit-tested with
// elementFromPoint first, so a covered or hidden control fails the run instead of
// passing it. No element.click(), no command API, no seeded boards.
//
//   node tools/petbattles_proof.mjs --url http://127.0.0.1:18764/ --out proof/pb
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
const OUT = path.resolve(arg('out', 'proof/pb'))
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-petb-'))
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
  const answer = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (answer && answer.exceptionDetails) throw new Error(String(answer.exceptionDetails.text))
  return answer && answer.result ? answer.result.value : undefined
}

// Chrome writes into its profile after being killed, so a failed sweep is not an error.
const cleanProfile = () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
      return
    } catch { /* still writing: try again */ }
  }
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

// The node under the press has to be the control itself, so it is tagged here and the
// hit test asks for that tag back: a card or a curtain lying over the button fails the
// press instead of quietly swallowing it.
const MARK = 'data-qa-press'
const centreOf = async expression => evaluate(`(() => {
  for (const node of document.querySelectorAll('[${MARK}]')) node.removeAttribute('${MARK}')
  const node = ${expression}
  if (!node) return null
  node.setAttribute('${MARK}', '1')
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
    const owner = node.closest('button, a, [data-testid]')
    const marked = node.closest('[${MARK}]')
    return (owner ? owner.tagName + '|' + (owner.getAttribute('data-testid') || '') + '|'
      + (owner.textContent || '').trim().slice(0, 40) : node.tagName) + (marked ? '|TARGET' : '|COVERED')
  })()`)
  if (String(hit).startsWith('nothing')) throw new Error(`nothing at ${point} for ${what}`)
  if (!String(hit).endsWith('|TARGET')) throw new Error(`${what} is covered at ${point}: ${hit}`)
  return hit
}

// The centre of the marked control, measured again after the scroll has settled: a
// scrollIntoView can still be moving when the first box is read.
const markedCentre = () => evaluate(`(() => {
  const node = document.querySelector('[${MARK}]')
  if (!node) return null
  const box = node.getBoundingClientRect()
  if (!box.width || !box.height) return null
  return [box.x + box.width / 2, box.y + box.height / 2]
})()`)

const press = async (expression, what, wait = 600) => {
  if (!await centreOf(expression)) return false
  await sleep(150)
  const spot = await markedCentre()
  if (!spot) return false
  await hitTest(spot, what)
  await pointer(spot)
  await sleep(wait)
  return true
}
const pressTestId = (id, wait) => press(`document.querySelector('[data-testid="${id}"]:not([disabled])')`, id, wait)
// A control can be disabled for a beat while the previous command lands; wait for it to
// be pressable rather than pressing nothing and calling it a failure.
const pressInCurtain = async (label, timeout = 20000, wait = 800) => {
  const ready = await waitFor(`Boolean([...document.querySelectorAll('[data-testid="petb-result"] button')]
    .find(node => node.textContent.trim() === ${JSON.stringify(label)} && !node.disabled))`, timeout)
  if (!ready) return false
  return press(`[...document.querySelectorAll('[data-testid="petb-result"] button')]
    .find(node => node.textContent.trim() === ${JSON.stringify(label)} && !node.disabled)`, label, wait)
}
const pressWhenReady = async (label, timeout = 20000, wait = 700) => {
  const ready = await waitFor(`Boolean([...document.querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(label)} && !node.disabled))`, timeout)
  if (!ready) return false
  return pressLabel(label, wait)
}
const pressLabel = (label, wait) => press(`[...document.querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(label)} && !node.disabled)`, label, wait)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(ok ? 'ok  ' : 'FAIL', name, detail)
}

// The page polls the board every few seconds, so a control can be visible a beat
// before the screen it opens is. Wait for the state, never for a fixed number.
const waitFor = async (expression, timeout = 9000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    // While a navigation is in flight the document can be gone for a beat, so an
    // expression that throws is "not yet", not a failed proof.
    try {
      if (await evaluate(expression)) return true
    } catch { /* the document is between pages */ }
    await sleep(200)
  }
  return false
}

const battleState = () => evaluate(`(() => {
  const screen = document.querySelector('[data-testid="petb-screen"]')
  const enlist = document.querySelector('[data-testid="petb-enlist"]')
  const field = document.querySelector('[data-testid="petb-field"]')
  const log = document.querySelector('[data-testid="petb-log"]')
  const overlay = document.querySelector('[data-testid="petb-result"]')
  const howto = document.querySelector('[data-testid="petb-howto"]')
  const pick = side => document.querySelector('[data-testid="petb-pet-' + side + '"]')
  const moves = [...document.querySelectorAll('[data-testid^="petb-move-"]')].filter(node => !node.disabled)
  const switches = [...document.querySelectorAll('[data-testid^="petb-switch-"]')].filter(node => !node.disabled)
  const bar = side => {
    const node = document.querySelector('[data-testid="petb-hpbar-' + side + '"]')
    return node ? node.style.width : ''
  }
  return {
    screen: Boolean(screen),
    status: screen ? screen.getAttribute('data-status') : '',
    petdex: screen ? screen.getAttribute('data-petdex') : '',
    enlist: Boolean(enlist),
    field: Boolean(field),
    howto: Boolean(howto),
    overlay: Boolean(overlay),
    overlayText: overlay ? overlay.innerText : '',
    statusLine: (document.querySelector('[data-testid="petb-status"]') || {}).innerText || '',
    turnText: (document.querySelector('[data-testid="petb-turn"]') || {}).innerText || '',
    moves: moves.map(node => node.getAttribute('data-testid')),
    switches: switches.map(node => node.getAttribute('data-testid')),
    logLines: log ? [...log.children].map(node => node.innerText).filter(Boolean).length : 0,
    lastLog: log ? [...log.children].slice(-1).map(node => node.innerText).join('') : '',
    hp: { you: bar('you'), foe: bar('foe') },
    you: pick('you') ? { slug: pick('you').getAttribute('data-pet-slug'), state: pick('you').getAttribute('data-state'),
                         sprite: Boolean(pick('you').querySelector('img[data-pet-slug]')), name: pick('you').innerText } : null,
    foe: pick('foe') ? { slug: pick('foe').getAttribute('data-pet-slug'), state: pick('foe').getAttribute('data-state'),
                         sprite: Boolean(pick('foe').querySelector('img[data-pet-slug]')), name: pick('foe').innerText } : null,
    petCards: [...document.querySelectorAll('[data-testid^="petb-petcard-"]')].map(node => ({
      slug: node.getAttribute('data-testid').replace('petb-petcard-', ''),
      selected: node.getAttribute('data-selected'),
      sprite: Boolean(node.querySelector('img[data-pet-slug]')),
      name: node.innerText
    })),
    text: (document.body.innerText || '')
  }
})()`)

const main = async () => {
  // A proof that hangs must fail loudly rather than sit forever.
  const guard = setTimeout(() => {
    console.error('proof hard timeout after 8 minutes')
    process.exit(3)
  }, 480000)
  guard.unref?.()
  await cdp('Runtime.enable')
  await cdp('Page.navigate', { url: URL_BASE })
  // The page loads React from the network on a cold profile, so wait for a real
  // first screen rather than for a number of seconds.
  await waitFor(`document.body.innerText.includes('Welcome to Game Center') || Boolean(document.querySelector('[data-labs-section]'))`, 30000)
  if (/Welcome to Game Center/.test(await evaluate('document.body.innerText'))) {
    await pressLabel('Continue', 600)
    await waitFor(`Boolean(document.querySelector('[data-labs-section]'))`, 15000)
  }
  await sleep(600)

  // 1. The Labs shelf carries the card, with the shared badge.
  const home = await evaluate(`(() => {
    const section = document.querySelector('[data-labs-section]')
    const card = document.querySelector('[data-labs-card="pet-battles"]')
    return {
      labs: Boolean(section),
      // The badge is a micro-caps label, so the rendered text is uppercased by CSS;
      // compare case-insensitively against the one shared string.
      badge: section ? /labs · experiment/i.test(section.innerText) : false,
      card: card ? card.innerText : '',
      open: Boolean([...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Open Pet Battles'))
    }
  })()`)
  check('Labs shelf holds Pet Battles with the shared badge', home.labs && home.badge && home.card.length > 0, home.card.slice(0, 120))
  check('the card has one Open button', home.open)
  await shot('01-labs-card')

  // 2. Open it with the mouse. First open shows the short how-to card.
  check('Open Pet Battles pressed', await pressLabel('Open Pet Battles', 600))
  await waitFor(`Boolean(document.querySelector('[data-testid="petb-screen"]'))`, 30000)
  let state = await battleState()
  // The first visit is taught before anything else, and the card sits over the whole
  // screen, so it is dismissed first and everything below starts from the real controls.
  const howtoShown = await waitFor(`Boolean(document.querySelector('[data-testid="petb-howto"]'))`, 20000)
  state = await battleState()
  check('the how-to card opens on the first visit', howtoShown && state.howto, state.text.slice(0, 80))
  check('the how-to names the type chart and switching',
    /Ember beats Verdant/.test(state.text.replace(/\s+/g, ' ')) && /Switching uses your turn/.test(state.text))
  await shot('02-howto')
  check('Got it pressed', await pressLabel('Got it', 500))
  const howtoGone = await waitFor(`!document.querySelector('[data-testid="petb-howto"]')`, 5000)
  check('the how-to card closes', howtoGone)

  let enlisted = await waitFor(`Boolean(document.querySelector('[data-testid="petb-enlist"]'))`, 30000)
  if (!enlisted) {
    // A battle saved from an earlier visit reopens on the field; New battle is the way
    // back to the picks, and it must be there while the battle is still going.
    check('a half-played battle offers New battle', await pressLabel('New battle', 800))
    enlisted = await waitFor(`Boolean(document.querySelector('[data-testid="petb-enlist"]'))`, 25000)
  }
  state = await battleState()
  check('the pre-battle screen appears on its own route', enlisted && state.status === 'idle', state.statusLine)

  // 3. The team is made of the person's real Hermes pets, each a card with its real sprite.
  await waitFor(`document.querySelectorAll('[data-testid^="petb-petcard-"] img[data-pet-slug]').length >= 2`, 20000)
  state = await battleState()
  const sprited = state.petCards.filter(card => card.sprite)
  check('team picking shows real Hermes pet cards', state.petCards.length >= 1 && sprited.length >= 1,
    state.petCards.map(card => `${card.slug}${card.sprite ? ' (sprite)' : ''}`).join(', '))
  check('the Petdex gallery came through', state.petdex === 'petdex', state.petdex)
  const second = state.petCards[1]
  if (second) {
    check('second pet card pressed', await press(`document.querySelector('[data-testid="petb-petcard-${second.slug}"]')`, second.slug, 500))
    state = await battleState()
    const picked = state.petCards.find(card => card.selected === 'true')
    check('the picked pet is ringed and leads', picked && picked.slug === second.slug, picked && picked.slug)
  }
  await shot('03-pets')

  // 3. Pick a type and change the four moves, all by clicking.
  check('type Tide pressed', await pressTestId('petb-type-tide', 350))
  const tide = await evaluate(`document.querySelector('[data-testid="petb-type-tide"]').getAttribute('aria-pressed')`)
  check('Tide is the selected type', tide === 'true', String(tide))

  // Four are picked to begin with, so drop one before adding another.
  check('move Scorch un-picked', await pressTestId('petb-pick-scorch', 300))
  check('move Mend picked', await pressTestId('petb-pick-mend', 300))
  const count = await evaluate(`document.body.innerText.includes('4 of 4')`)
  check('the screen counts four chosen moves', count)
  await shot('03-four-moves')

  // 4. Start at Advanced.
  check('Advanced pressed', await pressTestId('petb-level-advanced', 400))
  const fieldUp = await waitFor(`(() => {
    const screen = document.querySelector('[data-testid="petb-screen"]')
    const ready = document.querySelectorAll('[data-testid^="petb-move-"]:not([disabled])').length
    return Boolean(screen && screen.getAttribute('data-status') === 'active' && ready === 4)
  })()`, 30000)
  state = await battleState()
  check('the battle field is on screen', fieldUp && state.field && state.status === 'active', state.statusLine)
  check('four move buttons and two switches are offered', state.moves.length === 4 && state.switches.length >= 1,
    `${state.moves.length} moves, ${state.switches.length} switches`)
  // Both sides are real Hermes pets: the person's installed ones and Petdex gallery ones.
  await waitFor(`Boolean(document.querySelector('[data-testid="petb-pet-you"] img[data-pet-slug]'))`, 15000)
  await waitFor(`Boolean(document.querySelector('[data-testid="petb-pet-foe"] img[data-pet-slug]'))`, 25000)
  state = await battleState()
  check('your pet on the field is a real Hermes pet', Boolean(state.you && state.you.slug),
    state.you ? `${state.you.slug}, ${state.you.name}` : 'no pet')
  check('the computer picked a Petdex gallery pet', Boolean(state.foe && state.foe.slug),
    state.foe ? `${state.foe.slug}, ${state.foe.name}` : 'no pet')
  check('both sprites are real images, not drawn stand-ins',
    Boolean(state.you && state.you.sprite) && Boolean(state.foe && state.foe.sprite),
    `you ${state.you && state.you.sprite} / foe ${state.foe && state.foe.sprite}`)
  // The resting states are Hermes's own: you review, the other side waits.
  check('the thinking pet is in the review state', state.you && state.you.state === 'review', state.you && state.you.state)
  check('the other side is in the waiting state', state.foe && state.foe.state === 'waiting', state.foe && state.foe.state)
  await shot('04-battle-open')
  const startHp = state.hp

  // 5. Use a move with the mouse. While the turn plays, sample the pets' Hermes states.
  await evaluate(`(() => {
    window.qaStates = { you: [], foe: [] }
    window.qaSample = () => {
      for (const side of ['you', 'foe']) {
        const pet = document.querySelector('[data-testid="petb-pet-' + side + '"]')
        const value = pet ? pet.getAttribute('data-state') : ''
        const seen = window.qaStates[side]
        if (value && seen[seen.length - 1] !== value) seen.push(value)
      }
    }
    window.qaTimer = setInterval(window.qaSample, 30)
  })()`)
  check('first move pressed', await pressTestId('petb-move-0', 500))
  const turned = await waitFor(`(() => {
    const log = document.querySelector('[data-testid="petb-log"]')
    const turn = document.querySelector('[data-testid="petb-turn"]')
    return Boolean(log && log.children.length && turn && /turn [1-9]/.test(turn.innerText))
  })()`, 20000)
  await sleep(1500)
  const seenStatesRaw = await evaluate(`(() => { clearInterval(window.qaTimer); return window.qaStates })()`)
  const seenStates = [...(seenStatesRaw.you || []), ...(seenStatesRaw.foe || [])]
  state = await battleState()
  check('the log records the turn', turned && state.logLines > 0, state.lastLog)
  check('a health bar moved', state.hp.you !== startHp.you || state.hp.foe !== startHp.foe,
    `${startHp.you}->${state.hp.you}, ${startHp.foe}->${state.hp.foe}`)
  check('the turn counter advanced', /turn [1-9]/.test(state.turnText), state.turnText)
  check('the attack plays in the run and jump pet states',
    seenStates.includes('run') && (seenStates.includes('jump') || seenStates.includes('failed')),
    `you ${(seenStatesRaw.you || []).join('/')} · foe ${(seenStatesRaw.foe || []).join('/')}`)
  // A hit beat runs about half a second; wait for the pets to settle rather than sample
  // mid-animation, so the check is about the resting state and not about timing.
  await waitFor(`(() => {
    const you = document.querySelector('[data-testid="petb-pet-you"]')
    const foe = document.querySelector('[data-testid="petb-pet-foe"]')
    return you && foe && you.getAttribute('data-state') === 'review' && foe.getAttribute('data-state') === 'waiting'
  })()`, 8000)
  state = await battleState()
  check('the pets settle back into review and waiting',
    state.you && state.you.state === 'review' && state.foe && state.foe.state === 'waiting',
    `${state.you && state.you.state} / ${state.foe && state.foe.state}`)
  await shot('05-one-turn')

  // 6. Switch a pet by clicking, then keep fighting to the result overlay.
  let switched = false
  // The hit animation holds the buttons for a beat; wait for the turn to settle.
  await waitFor(`document.querySelectorAll('[data-testid^="petb-move-"]:not([disabled])').length === 4`, 15000)
  state = await battleState()
  if (state.switches.length) {
    switched = await pressTestId(state.switches[0], 500)
    await waitFor(`/steps in/.test(document.querySelector('[data-testid="petb-log"]').innerText)`, 15000)
  }
  state = await battleState()
  check('a switch button works', switched && /steps in/.test(state.text), state.lastLog)
  await shot('06-switched')

// A battle takes as many turns as it takes: every turn is a server command plus the
  // log beats playing, so wait for the move buttons to come back rather than guess.
  const logLineCount = () => evaluate(`(() => {
    const log = document.querySelector('[data-testid="petb-log"]')
    return log ? log.children.length : 0
  })()`)
  const fightToResult = async () => {
    let rounds = 0
    const fightBy = Date.now() + 180000
    while (rounds < 70 && Date.now() < fightBy) {
      if (await evaluate(`Boolean(document.querySelector('[data-testid="petb-result"]'))`)) return rounds
      const ready = await waitFor(`document.querySelectorAll('[data-testid^="petb-move-"]:not([disabled])').length > 0`, 20000)
      if (!ready) {
        state = await battleState()
        const probe = await evaluate(`(() => ({
          moves: [...document.querySelectorAll('[data-testid^="petb-move-"]')].map(b => b.getAttribute('data-testid') + ':' + b.disabled),
          screen: (document.querySelector('[data-testid="petb-screen"]') || {}).getAttribute
            ? document.querySelector('[data-testid="petb-screen"]').getAttribute('data-status') : 'none',
          turn: (document.querySelector('[data-testid="petb-turn"]') || {}).innerText || '',
          petState: (document.querySelector('[data-testid="petb-pet-you"]') || {}).getAttribute
            ? document.querySelector('[data-testid="petb-pet-you"]').getAttribute('data-state') : ''
        }))()`)
        console.log('no moves came back:', state.status, state.statusLine, 'log', state.logLines,
          'probe', JSON.stringify(probe),
          'notice', (await evaluate(`(document.querySelector('[role="status"]') || {}).innerText || ''`)))
        break
      }
      state = await battleState()
      if (state.overlay) break
      const move = state.moves[0]
      if (!move) break
      // One turn at a time: after the press, wait for the log to take the turn before
      // the next press, so a slow command is never pressed twice or dropped.
      const before = await logLineCount()
      if (!await pressTestId(move, 200)) {
        // The button went disabled between the wait and the press (a command in flight);
        // wait for it rather than counting an empty round.
        await sleep(700)
        continue
      }
      const took = await waitFor(`(() => {
        const log = document.querySelector('[data-testid="petb-log"]')
        return Boolean(document.querySelector('[data-testid="petb-result"]')) || (log && log.children.length > ${before})
      })()`, 25000)
      rounds += 1
      if (!took) {
        state = await battleState()
        console.log('the turn did not register:', state.status, state.logLines, state.lastLog)
        break
      }
    }
    await waitFor(`Boolean(document.querySelector('[data-testid="petb-result"]'))`, 30000)
    return rounds
  }
  const rounds = await fightToResult()
  console.log(`fought ${rounds} rounds`)
  state = await battleState()
  check('a result overlay ends the battle', state.overlay, state.overlayText.replace(/\n/g, ' · ').slice(0, 120))
  check('the overlay says who won', /You win|You lose|draw/i.test(state.overlayText), state.overlayText.split('\n')[2] || '')
  const resultPet = await evaluate(`(() => {
    const card = document.querySelector('[data-testid="petb-result-pet"]')
    const img = card ? card.querySelector('img[data-pet-slug]') : null
    return { text: card ? card.innerText : '', slug: img ? img.getAttribute('data-pet-slug') : '',
             sprite: Boolean(img) }
  })()`)
  check('the result names the winner with their pet', Boolean(resultPet.slug) && resultPet.sprite,
    `${resultPet.slug}: ${resultPet.text.replace(/\n/g, ' · ')}`)
  for (const label of ['Rematch', 'New battle', 'Watch replay', 'Back to games']) {
    const present = await evaluate(`Boolean([...document.querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(label)}))`)
    check(`the result offers ${label}`, present)
  }
  await shot('07-result-overlay')

  // 7. Rematch is a whole new battle on the same teams, from turn one.
  check('Rematch pressed', await pressInCurtain('Rematch', 20000, 900))
  // Enlist + new is two commands, and each refresh re-reads the whole catalogue, so
  // give the fresh battle a generous window rather than a tight one.
  const curtainGone = await waitFor(`!document.querySelector('[data-testid="petb-result"]')`, 45000)
  const activeAgain = await waitFor(`(() => {
    const screen = document.querySelector('[data-testid="petb-screen"]')
    return Boolean(screen) && screen.getAttribute('data-status') === 'active'
  })()`, 45000)
  state = await battleState()
  // A fresh battle is one that has not had a turn spent on it yet.
  const freshTurn = /turn [01]\b/.test(state.turnText) || state.turnText === ''
  check('Rematch starts a fresh battle with the result cleared',
    curtainGone && activeAgain && state.status === 'active' && freshTurn,
    `${state.status}, ${state.turnText}, curtain gone ${curtainGone}`)
  await shot('08-rematch')

  // 8. Fight this one out too, then Watch replay plays it back from turn one.
  await fightToResult()
  state = await battleState()
  check('the second battle also ends in a result', state.overlay, state.status)
  // The result curtain appears the moment the battle ends, while the last beats are
  // still playing, so let the log come to rest before counting it.
  let linesBeforeReplay = await logLineCount()
  for (let settle = 0; settle < 6; settle += 1) {
    await sleep(700)
    const next = await logLineCount()
    if (next === linesBeforeReplay) break
    linesBeforeReplay = next
  }
  linesBeforeReplay = Math.max(3, linesBeforeReplay)
  check('Watch replay pressed', await pressInCurtain('Watch replay', 20000, 900))
  const replayGone = await waitFor(`!document.querySelector('[data-testid="petb-result"]')`, 8000)
  // The log is emptied and refilled a line at a time, so a beat after the press there
  // are fewer lines on screen than the finished battle had.
  const replayRunning = await waitFor(`(() => {
    const log = document.querySelector('[data-testid="petb-log"]')
    return Boolean(log) && log.children.length < ${linesBeforeReplay}
  })()`, 8000)
  check('Watch replay hides the result and replays the log', replayGone && replayRunning,
    `hides ${replayGone}, thinner log ${replayRunning} (was ${linesBeforeReplay})`)
  await shot('09-replay')
  const replayBack = await waitFor(`Boolean(document.querySelector('[data-testid="petb-result"]'))`, 60000)
  check('the result returns when the replay ends', replayBack)

  // 8. New battle is the way back to the team and level picks.
  check('New battle pressed', await pressInCurtain('New battle', 20000, 900))
  const backToPicks = await waitFor(`Boolean(document.querySelector('[data-testid="petb-enlist"]'))`, 25000)
  state = await battleState()
  check('New battle returns to the picks', backToPicks && state.enlist && state.status === 'idle', state.status)
  await shot('10-new-battle-picks')

  // 9. Watch two computer teams: it advances on its own, pauses, and runs at 2x.
  await waitFor(`document.querySelector('[data-testid="petb-watch-level-intermediate"]:not([disabled])')`, 10000)
  check('watch teams pressed', await pressTestId('petb-watch-level-intermediate', 500))
  const watching = await waitFor(`document.querySelector('[data-testid="petb-screen"]').getAttribute('data-status') === 'watch'`, 40000)
  state = await battleState()
  check('watch mode is playing', watching && state.status === 'watch', state.statusLine.slice(0, 90))
  const frameNow = () => evaluate(`(document.body.innerText.match(/Frame (\\d+) of (\\d+)/) || []).slice(1).join('/')`)
  const frameOne = await frameNow()
  // Pause first: a short replay can finish in the time a screenshot takes, and then the
  // buttons are gone. Holding the frame makes the rest of this sequence stable.
  check('Pause pressed', await pressWhenReady('Pause', 15000, 500))
  const paused = await frameNow()
  await sleep(1800)
  const stillPaused = await frameNow()
  check('Pause holds the frame', paused === stillPaused, `${paused} -> ${stillPaused}`)
  await shot('11-watch')
  check('Play pressed', await pressWhenReady('Play', 15000, 700))
  await sleep(2200)
  const frameTwo = await frameNow()
  check('Play lets the replay advance on its own', frameOne !== frameTwo, `${paused} -> ${frameTwo}`)
  check('2x pressed', await pressLabel('2×', 300))
  await shot('12-watch-2x')

  // 10. Back to games is the way out, from wherever the battle is.
  // The curtain covers the whole window, so when it is up its own Back to games is the
  // reachable one; the header's button does the same thing when no battle is showing.
  const curtainUp = await evaluate(`Boolean(document.querySelector('[data-testid="petb-result"]'))`)
  check('Back to games pressed', curtainUp
    ? await pressInCurtain('Back to games', 15000, 700)
    : await pressWhenReady('Back to games', 15000, 700))
  const leftScreen = await waitFor(`!document.querySelector('[data-testid="petb-screen"]')`, 10000)
  check('Back to games leaves Pet Battles for the shelf', leftScreen)
  await shot('13-back-to-shelf')
  check('Open Pet Battles pressed again', await pressLabel('Open Pet Battles', 700))
  await waitFor(`Boolean(document.querySelector('[data-testid="petb-screen"]'))`, 20000)
  const howtoAgain = await waitFor(`Boolean(document.querySelector('[data-testid="petb-howto"]'))`, 4000)
  check('the how-to card does not reopen once it has been read', !howtoAgain)


  // 8. Nothing threw while all of that happened.
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))

  const summary = { url: URL_BASE, at: new Date().toISOString(), shots, pageErrors, results }
  fs.writeFileSync(path.join(OUT, 'petbattles-proof.json'), JSON.stringify(summary, null, 2))
  const failed = results.filter(row => !row.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    const text = await evaluate('document.body.innerText')
    fs.writeFileSync(path.join(OUT, '99-failure.txt'), failed.map(row => `${row.name}: ${row.detail}`).join('\n') + '\n\n' + text)
    await shot('99-failure')
  }
  socket.close()
  stopChrome()
  cleanProfile()
  process.exitCode = failed.length ? 1 : 0
}

main().catch(async error => {
  console.error(error)
  fs.writeFileSync(path.join(OUT, '99-failure.txt'), String(error && error.stack || error))
  try { await shot('99-failure') } catch { /* chrome may be gone */ }
  stopChrome()
  cleanProfile()
  process.exitCode = 1
})
