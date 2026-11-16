// tests/inference_autoplay_harness.cjs -- "Inference Slot Machine" on the Games page, and a backdrop
// big enough to be worth the name.
//
// The owner asked for three things in one breath: a real button on the main window that says
// "Inference Slot Machine" (the wallet's autoplay switch and the Jackpot backdrop are two settings, and
// the button is only ON while both are), backdrop wording instead of "over chat", and a backdrop that
// may grow further than it could.
//
//   python3 tools/build_plugin.py && node tests/inference_autoplay_harness.cjs
//
// What it checks:
//   1. the Games page draws the button near the top, in its off state, with the one-line tooltip;
//   2. pressing it turns the wallet's autoplay ON (POST /jackpot/autoplay {on:true}) and the Jackpot
//      backdrop ON (the jackpot2.overchat key the switch itself writes, so the copy really draws);
//   3. pressing it again turns both off;
//   4. a refused request leaves the button in its real state and says why;
//   5. the button follows the two switches: ON only while autoplay AND the backdrop are on, whichever
//      surface moved them;
//   6. the stage's height budget at a 1000 px window is at least 600 px, 100% still draws the size it
//      always did, and a size of 1.6 draws a taller cabinet than 1;
//   7. Small / Medium / Large sit beside the backdrop size slider and set 0.75 / 1 / 1.6.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const source = fs.readFileSync(path.join(ROOT, 'desktop/plugin.js'), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export \{.*\}$/gm, '').replace('export default {', 'const plugin = {')

// ---- the smallest host there is -----------------------------------------------
const sandbox = {
  console, Set, Map, Promise,
  setTimeout: (fn, ms) => 0,
  clearTimeout: () => {},
  setInterval: () => 1,
  clearInterval: () => {},
  PANES_AREA: 'panes', PALETTE_AREA: 'palette', ROUTES_AREA: 'routes',
  SIDEBAR_NAV_AREA: 'nav', STATUSBAR_AREAS: { right: 'right' }, TITLEBAR_AREAS: { right: 'titleBar.right' },
  COMPOSER_AREAS: { top: 'composer.top', bottom: 'composer.bottom', underside: 'composer.underside' }
}
const windowListeners = {}
const localStore = {}
sandbox.window = {
  innerHeight: 1000,
  innerWidth: 1440,
  addEventListener: (type, fn) => { windowListeners[type] = (windowListeners[type] || []).concat(fn) },
  removeEventListener: (type, fn) => { windowListeners[type] = (windowListeners[type] || []).filter(item => item !== fn) },
  localStorage: {
    getItem: key => (key in localStore ? localStore[key] : null),
    setItem: (key, value) => { localStore[key] = String(value) },
    removeItem: key => { delete localStore[key] }
  },
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  dispatchEvent: () => true,
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
}
sandbox.document = {
  addEventListener: sandbox.window.addEventListener,
  removeEventListener: sandbox.window.removeEventListener,
  getElementById: () => null,
  activeElement: null
}
const chatBusy = { value: false, get() { return this.value }, subscribe() { return () => {} } }
sandbox.host = {
  state: { busy: chatBusy },
  onEvent: () => () => {},
  revealPane() {},
  navigate() {}
}
sandbox.Component = class { constructor(props) { this.props = props; this.state = {} } setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) } } }
vm.createContext(sandbox)
vm.runInContext(source, sandbox)
const evaluate = expression => vm.runInContext(expression, sandbox)

// ---- the hooks, stubbed so a page can be drawn by hand ------------------------
let hooks = [], cursor = 0, effects = [], cleanups = []
sandbox.useState = initial => {
  const index = cursor++
  if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
  return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value }]
}
sandbox.useRef = initial => {
  const index = cursor++
  if (!(index in hooks)) hooks[index] = { current: initial }
  return hooks[index]
}
sandbox.useCallback = fn => fn
sandbox.useMemo = fn => fn()
sandbox.useValue = atom => atom.get()
sandbox.useEffect = (fn, deps) => {
  const index = cursor++
  const before = hooks[index]
  if (!before || !deps || deps.some((dep, i) => dep !== before[i])) {
    hooks[index] = deps
    effects.push(() => { if (cleanups[index]) cleanups[index](); cleanups[index] = fn() })
  }
}
sandbox.jsx = sandbox.jsxs = (type, props, extra) => {
  const p = props || {}
  if (extra && typeof extra === 'object' && !Array.isArray(extra) && 'children' in extra) {
    return { type, props: { ...p, children: extra.children }, key: extra.key }
  }
  return { type, props: p, key: extra }
}
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...[].concat(tree.props && tree.props.children || []).flatMap(nodes)]
const words = tree => !tree ? '' : typeof tree !== 'object' ? String(tree) : Array.isArray(tree) ? tree.map(words).join(' ') : [].concat(tree.props && tree.props.children || []).map(words).join(' ')
function reset() { cleanups.forEach(fn => fn && fn()); cleanups = []; hooks = []; effects = [] }
const tick = () => new Promise(resolve => setImmediate(resolve))

// ---- the shelf the page talks to ---------------------------------------------
// One fake shelf with the two settings the button joins: the wallet's autoplay switch and the Jackpot
// backdrop switch. Every POST is recorded, so "it posted autoplay on" is read, not inferred.
const shelf = { autoplay: false, failAutoplay: false, posts: [] }
const game = { id: 'connect4', title: 'Connect Four', kind: 'table', installed: true }
const view = {
  viewer_id: 'me', player: { name: 'Ada', named: true }, allow_ai: true,
  store: [game], play: [game], your_games: [], more: [],
  lobby: { lines: [], looking: [] }, setup: {}, alerts: { rows: [], count: 0 }
}
const storage = {}
const ctx = {
  rest: async (url, opts) => {
    const body = opts && opts.body
    if (url === '/view') return view
    if (url === '/jackpot') {
      return { chips: 500, bonus: 12, bet: 25, bets: [25], machines: [], feed: [], autoplay: shelf.autoplay }
    }
    if (url === '/jackpot/autoplay') {
      shelf.posts.push({ url, on: Boolean(body && body.on) })
      if (shelf.failAutoplay) throw new Error('the shelf did not take that')
      shelf.autoplay = Boolean(body && body.on)
      return { autoplay: shelf.autoplay }
    }
    if (url.startsWith('/board')) return { text: '', picture: null }
    return { ok: true }
  },
  storage: {
    get: (key, fallback) => (key in storage ? storage[key] : fallback),
    set: (key, value) => { storage[key] = value }
  }
}

// ---- 1. the button is on the Games page, near the top, in its off state -------
sandbox.pageCtx = ctx
let pageProps = { ctx, onArea: () => {} }
sandbox.pageProps = pageProps
// The page hands the button its context; the harness draws the component itself, because a tree of
// elements is not a tree of components (that is the wiring this section proves).
const buttonElement = tree => nodes(tree).find(node =>
  typeof node.type === 'function' && node.type.name === 'InferenceAutoPlayButton')
sandbox.autoProps = { ctx }
const buttonNode = tree => nodes(tree).find(node => node.props && typeof node.props['data-inference-autoplay'] === 'string')

function drawWith(expression) {
  cursor = 0
  const tree = evaluate(expression)
  const pending = effects; effects = []
  pending.forEach(effect => effect())
  return tree
}
const drawPage = () => drawWith('GameCenterPage(pageProps)')
const drawButton = () => drawWith('InferenceAutoPlayButton(autoProps)')

async function settlePage(times = 3) {
  for (let i = 0; i < times; i += 1) { drawPage(); await tick() }
  return drawPage()
}
async function drawButtonNow() {
  drawButton()          // mount: this runs the effect that reads the wallet
  await tick()          // let the answer land in the hook slots
  return drawButton()   // re-render with what it said
}
async function press(button) {
  button.props.onClick()
  await tick()
  await tick()
  return drawButton()
}

async function main() {
  let page = await settlePage(3)
  const element = buttonElement(page)
  assert.ok(element, 'the Games page draws an Inference Slot Machine button component')
  assert.equal(element.props.ctx, ctx, 'handed the page context, so it can reach the shelf')
  // Near the top: it is drawn before the Play shelf's own heading, not buried in the machine.
  const flat = nodes(page)
  const playHeading = flat.findIndex(node => words(node).trim() === 'Play' && node !== element)
  assert.ok(playHeading > 0 && flat.indexOf(element) < playHeading,
    'and it sits above the Play shelf, where the person arrives')

  reset()
  sandbox.autoProps = { ...element.props }
  let button = buttonNode(await drawButtonNow())
  assert.ok(button, 'the component draws a button')
  assert.equal(button.type, 'button', 'and it is a real button, not a link or a label')
  assert.equal(words(button).trim(), 'Start Inference Slot Machine', 'which offers to start it')
  assert.equal(button.props['data-inference-autoplay'], 'off', 'and says it is off')
  assert.equal(button.props['aria-pressed'], false, 'pressed state is off too, for a screen reader')
  assert.equal(button.props.title,
    'Spins the slot machine each time Hermes starts thinking, shown as a see-through backdrop over the chat.',
    'with the one-line tooltip the owner asked for')

  // ---- 2. pressing it turns both halves on ---------------------------------
  let root = await press(button)
  assert.equal(shelf.posts.length, 1, 'one press is one request, not a storm')
  assert.equal(shelf.posts[0].url, '/jackpot/autoplay', 'it posts to the wallet\'s autoplay door')
  assert.equal(shelf.posts[0].on, true, 'turning autoplay on')
  assert.equal(storage['jackpot2.overchat'], true,
    'and it turns the Jackpot backdrop on through the switch\'s own key, so the copy really draws')
  button = buttonNode(root)
  assert.equal(words(button).trim(), 'Stop Inference Slot Machine', 'the button now offers to stop it')
  assert.equal(button.props['data-inference-autoplay'], 'on', 'with an on look the tree can read')
  assert.ok(nodes(root).some(node => node.props && node.props['data-inference-autoplay-state'] === 'on'),
    'and the state word says On')

  // ---- 3. pressing it again turns both off ---------------------------------
  root = await press(button)
  assert.equal(shelf.posts.length, 2, 'the second press posts once')
  assert.equal(shelf.posts[1].url, '/jackpot/autoplay', 'to the same door')
  assert.equal(shelf.posts[1].on, false, 'turning autoplay off')
  assert.equal(storage['jackpot2.overchat'], false, 'and hiding the backdrop')
  button = buttonNode(root)
  assert.equal(words(button).trim(), 'Start Inference Slot Machine', 'and it is back to Start')

  // ---- 4. a refused request leaves the button honest ------------------------
  shelf.failAutoplay = true
  root = await press(button)
  assert.equal(storage['jackpot2.overchat'], false, 'a refused turn-on does not leave the backdrop on')
  button = buttonNode(root)
  assert.equal(words(button).trim(), 'Start Inference Slot Machine', 'the button is back in its real state')
  const note = nodes(root).find(node => node.props && node.props['data-inference-autoplay-note'] === '1')
  assert.ok(note, 'and it says what happened')
  assert.ok(String(words(note)).trim().length > 0, `in a short line (${JSON.stringify(words(note).trim())})`)
  assert.ok(words(note).length < 140, 'short: one line, not a stack trace')
  shelf.failAutoplay = false

  // ---- 5. the button follows BOTH switches, wherever they are moved --------
  // The backdrop switch alone is not enough: with autoplay off the button is off.
  reset()
  evaluate('jp2LSetOverchat(true, pageCtx)')
  page = await settlePage(2)
  reset()
  button = buttonNode(await drawButtonNow())
  assert.equal(button.props['data-inference-autoplay'], 'off',
    'the backdrop on its own leaves the button off: nothing would spin')
  // Autoplay alone is not enough either: there is no machine on screen.
  shelf.autoplay = true
  reset()
  button = buttonNode(await drawButtonNow())
  assert.equal(button.props['data-inference-autoplay'], 'on',
    'autoplay and the backdrop together are on')
  assert.equal(words(button).trim(), 'Stop Inference Slot Machine', 'and the label agrees')
  // A switch moved elsewhere (the cabinet's panel, Settings, the status bar) moves this button.
  evaluate('jp2LSetOverchat(false, pageCtx)')
  reset()
  button = buttonNode(await drawButtonNow())
  assert.equal(button.props['data-inference-autoplay'], 'off',
    'turning the backdrop off elsewhere turns the button off')
  shelf.autoplay = false
  reset()
  console.log('inference autoplay: the home button turns both switches, follows them, and stays honest: passed')

  // ---- 6. the stage is tall enough, and 100% is twice the old 320 px copy ----
  // The owner: "make the on screen slot machine twice the size but same area". 100% is now 640 px
  // tall where the window allows it, still drawn in the same top-centre stage, still capped by 60% of
  // the window and by the chat column's width.
  const budget = evaluate('overchatStageHeight()')
  assert.equal(budget, 600, `a 1000 px window gives the backdrop 60% of it (${budget})`)
  const tall100 = evaluate('overchatFitScale({ width: 560, height: 720 }, 900, 1, 720)')
  assert.equal(Math.round(720 * tall100), 640, `100% draws twice the old 320 px copy (${720 * tall100})`)
  const at100 = evaluate('overchatFitScale({ width: 560, height: 720 }, 900, 1, 600)')
  assert.equal(Math.round(720 * at100), 600, `on a 1000 px window it fills its 60% share (${720 * at100})`)
  const half = evaluate('overchatFitScale({ width: 560, height: 720 }, 900, 0.5, 720)')
  assert.equal(Math.round(720 * half), 320, `50% is the size it used to be (${720 * half})`)
  const at160 = evaluate('overchatFitScale({ width: 560, height: 720 }, 900, 1.6, 720)')
  assert.ok(720 * at160 > 720 * tall100, `and 160% draws a taller cabinet (${720 * at160} > ${720 * tall100})`)
  assert.ok(720 * at160 <= 720 + 0.5, `never taller than the room it was given (${720 * at160} <= 720)`)
  const narrow = evaluate('overchatFitScale({ width: 560, height: 720 }, 300, 1.6, 600)')
  assert.ok(560 * narrow <= 300 + 0.5, `and never wider than the chat column (${560 * narrow} <= 300)`)
  assert.ok(evaluate('OVERCHAT_MAX_HEIGHT') <= 720, 'with a sane absolute ceiling (720)')
  console.log('inference autoplay: the backdrop is twice its old size, in its 60% share of the window: passed')

  // ---- 7. Small / Medium / Large beside the size slider ------------------
  sandbox.panelProps = { ctx, tone: 'settings' }
  const panel = evaluate('Jackpot2OverChatControls(panelProps)')
  for (const [label, value] of [['Small', 0.5], ['Medium', 1], ['Large', 1.6]]) {
    const quick = nodes(panel).find(node => node.type === 'button' && words(node).trim() === label)
    assert.ok(quick, `the backdrop controls offer ${label}`)
    evaluate('jp2LSetSize(0.5, panelProps.ctx)')
    quick.props.onClick()
    assert.equal(evaluate('JP2L_STORE.size'), value, `${label} sets the size to ${value}`)
  }
  console.log('inference autoplay: Small, Medium and Large size the backdrop in one press: passed')

  reset()
  console.log('inference autoplay harness: passed')
  console.log('DONE')
}

main().catch(error => { console.error(error && error.stack || error); console.log('FAILED'); process.exit(1) })
