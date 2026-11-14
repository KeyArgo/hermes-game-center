// Every surface the plugin puts on screen owns its clock, and gives it back when it closes.
//
// The Desktop keeps a pane mounted while it is on screen and unmounts it the moment it is closed;
// the Games page is a route, so it unmounts when the person leaves it. A timer that outlives its
// surface keeps reading the shelf forever: a poll with nowhere to paint, a machine that goes on
// spinning after the person closed the cabinet. This harness draws each surface the way React
// would - component by component, effects and all - with a fake clock, closes it, and fails if any
// timer is still live.
//
// Fake timers, not real ones: a live interval is counted, never waited for, so the check is exact
// and takes milliseconds. A timer found alive is reported by the bundle line that armed it, mapped
// back to the part it came from.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'desktop', 'src')
const BUNDLE = path.join(ROOT, 'desktop', 'plugin.js')

const source = fs.readFileSync(BUNDLE, 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export \{.*\}$/gm, '').replace('export default {', 'const plugin = {')

// Which part a bundle line came from: the parts are glued in name order with a blank line
// between them, so the offsets are the build's own, not a list kept by hand.
function partLines() {
  const parts = fs.readdirSync(SRC).filter(name => /^\d{2}[a-z]?-[a-z0-9-]+\.js$/.test(name)).sort()
  const map = []
  let line = 3 // the two comment lines the build writes, then the first part
  for (const name of parts) {
    const count = fs.readFileSync(path.join(SRC, name), 'utf8').split('\n').length - 1
    map.push({ name, from: line, to: line + count - 1 })
    line += count + 1 // the blank line the build puts between parts
  }
  return map
}

const PARTS = partLines()
function where(bundleLine) {
  const found = PARTS.find(part => bundleLine >= part.from && bundleLine <= part.to)
  return found ? `${found.name}:${bundleLine - found.from + 1}` : `plugin.js:${bundleLine}`
}

// ---- the fake clock ---------------------------------------------------------
function makeClock() {
  let nextId = 1
  const live = new Map()
  const record = (kind, fn, ms) => {
    const id = nextId++
    const stack = String(new Error('armed here').stack || '').split('\n')
    const frame = stack.map(line => (line.match(/plugin\.js:(\d+)/) || [])[1]).filter(Boolean)[0]
    live.set(id, { id, kind, fn, ms, at: frame ? where(Number(frame)) : 'unknown' })
    return id
  }
  return {
    setTimeout: (fn, ms) => record('timeout', fn, ms),
    setInterval: (fn, ms) => record('interval', fn, ms),
    requestAnimationFrame: fn => record('frame', fn, 16),
    clearTimeout: id => { live.delete(id) },
    clearInterval: id => { live.delete(id) },
    cancelAnimationFrame: id => { live.delete(id) },
    live: () => [...live.values()]
  }
}

const clock = makeClock()
const windowListeners = {}
const sessionStore = {}
const fakeWindow = {
  addEventListener: (type, fn) => { (windowListeners[type] = windowListeners[type] || []).push(fn) },
  removeEventListener: (type, fn) => { windowListeners[type] = (windowListeners[type] || []).filter(item => item !== fn) },
  dispatchEvent: () => true,
  sessionStorage: {
    getItem: key => (key in sessionStore ? sessionStore[key] : null),
    setItem: (key, value) => { sessionStore[key] = String(value) },
    removeItem: key => { delete sessionStore[key] }
  }
}

const sandbox = {
  console,
  Set, Map, JSON, Math, Date, Promise, Object, Array, String, Number, Boolean, Error, RegExp,
  setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  setInterval: clock.setInterval, clearInterval: clock.clearInterval,
  requestAnimationFrame: clock.requestAnimationFrame, cancelAnimationFrame: clock.cancelAnimationFrame,
  PANES_AREA: 'panes', PALETTE_AREA: 'palette', ROUTES_AREA: 'routes',
  SIDEBAR_NAV_AREA: 'nav', STATUSBAR_AREAS: { right: 'right' },
  COMPOSER_AREAS: { top: 'composer.top', bottom: 'composer.bottom', underside: 'composer.underside' }
}
sandbox.window = fakeWindow
sandbox.document = {
  addEventListener: fakeWindow.addEventListener,
  removeEventListener: fakeWindow.removeEventListener,
  getElementById: () => null,
  activeElement: null,
  visibilityState: 'visible'
}
sandbox.CustomEvent = class { constructor(type, opts) { this.type = type; Object.assign(this, opts || {}) } }
sandbox.Component = class {
  constructor(props) { this.props = props; this.state = {} }
  setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) } }
}
// The SDK host, as far as the surfaces read it: a busy atom and an event stream.
const busyAtom = { value: false, get() { return this.value }, subscribe() { return () => {} } }
// The host's event stream, kept so a check can fire the event a surface listens for.
const hostListeners = {}
const fireHostEvent = type => (hostListeners[type] || []).forEach(listener => listener({ type }))
sandbox.host = {
  state: { busy: busyAtom },
  onEvent(type, listener) {
    hostListeners[type] = (hostListeners[type] || []).concat([listener])
    return () => { hostListeners[type] = (hostListeners[type] || []).filter(item => item !== listener) }
  },
  revealPane() {},
  navigate() {}
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox)
const evaluate = expression => vm.runInContext(expression, sandbox)

// ---- hooks, per component instance, with React's dependencies and cleanups ---
// An instance is keyed by where it sits in the tree, so a child is drawn with hooks of its own
// instead of borrowing its parent's.
let instances = new Map()
let current = null
let cursor = 0
let queued = []
let made = 0

function instanceFor(key) {
  if (!instances.has(key)) instances.set(key, { key, hooks: [], slots: [], cleanups: [], order: made++ })
  return instances.get(key)
}

let lastUnder = ''
const next = () => {
  if (!current) throw new Error(`a hook ran outside a component under ${lastUnder}: ${new Error().stack.split('\n').slice(1, 6).join(' | ')}`)
  const at = cursor
  cursor += 1
  return at
}

sandbox.useState = initial => {
  // The setter keeps its own component: React hands back a function that writes this instance,
  // and an effect that calls it later must not land on whichever component is drawing then.
  const instance = current
  const at = next()
  if (at >= instance.hooks.length) instance.hooks[at] = typeof initial === 'function' ? initial() : initial
  return [instance.hooks[at], value => {
    instance.hooks[at] = typeof value === 'function' ? value(instance.hooks[at]) : value
  }]
}
sandbox.useRef = initial => {
  const instance = current
  const at = next()
  if (at >= instance.hooks.length) instance.hooks[at] = { current: initial }
  return instance.hooks[at]
}
sandbox.useCallback = (fn, deps) => {
  const instance = current
  const at = next()
  const before = instance.slots[at]
  if (!before || !deps || deps.some((dep, index) => dep !== before.deps[index])) instance.slots[at] = { fn, deps: deps || [] }
  return instance.slots[at].fn
}
sandbox.useMemo = (fn, deps) => {
  const instance = current
  const at = next()
  const before = instance.slots[at]
  if (!before || !deps || deps.some((dep, index) => dep !== before.deps[index])) instance.slots[at] = { value: fn(), deps: deps || [] }
  return instance.slots[at].value
}
sandbox.useValue = atom => {
  const instance = current
  const at = next()
  if (at >= instance.hooks.length) instance.hooks[at] = atom.get()
  return atom.get()
}
const useEffect = (fn, deps) => {
  const instance = current
  const at = next()
  const before = instance.slots[at]
  if (!before || !deps || deps.some((dep, index) => dep !== before[index])) {
    instance.slots[at] = deps || []
    queued.push({ instance, at, fn })
  }
}
sandbox.useEffect = useEffect
// The board measures its first paint, which a host with no layout does not have.
sandbox.useLayoutEffect = (fn, deps) => useEffect(fn, deps)
sandbox.useInsertionEffect = (fn, deps) => useEffect(fn, deps)
sandbox.useSyncExternalStore = (subscribe, get) => get()
sandbox.jsx = sandbox.jsxs = (type, props, extra) => {
  const p = props || {}
  if (extra && typeof extra === 'object' && !Array.isArray(extra) && 'children' in extra) {
    return { type, props: { ...p, children: extra.children }, key: extra.key }
  }
  return { type, props: p, key: extra }
}

// ---- a small renderer: components are called, their children are drawn ------
function renderNode(node, under, depth) {
  if (depth > 60) throw new Error(`the tree is more than 60 levels deep under ${under}`)
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${under}[${index}]`, depth + 1))
  if (typeof node !== 'object') return node
  const { type, props } = node
  const given = props || {}
  if (typeof type === 'function') {
    if (type.prototype && type.prototype.render) {
      // A class component (the error boundary): its props and its own state, no hooks.
      const made_ = new type(given)
      made_.state = made_.state || {}
      return renderNode(made_.render(), `${under}>${type.name || 'class'}`, depth + 1)
    }
    const key = `${under}>${type.name || 'anonymous'}`
    lastUnder = key
    const instance = instanceFor(key)
    const saved = { current, cursor }
    current = instance
    cursor = 0
    let out
    try {
      out = type(given)
    } finally {
      current = saved.current
      cursor = saved.cursor
    }
    return renderNode(out, key, depth + 1)
  }
  if (given.children !== undefined) {
    return { ...node, props: { ...given, children: renderNode(given.children, under, depth + 1) } }
  }
  return node
}

const settle = async (rounds = 3) => {
  for (let round = 0; round < rounds; round += 1) await new Promise(resolve => setImmediate(resolve))
}

function draw(expression, props) {
  const tree = { type: evaluate(expression), props }
  const drawn = renderNode(tree, 'root', 0)
  const pending = queued
  queued = []
  pending.forEach(({ instance, at, fn }) => {
    if (instance.cleanups[at]) instance.cleanups[at]()
    instance.cleanups[at] = fn()
  })
  return drawn
}

function close() {
  const all = [...instances.values()].sort((a, b) => b.order - a.order)
  for (const instance of all) {
    for (const cleanup of instance.cleanups.slice().reverse()) {
      if (typeof cleanup === 'function') cleanup()
    }
    instance.cleanups = []
  }
  instances = new Map()
  queued = []
  current = null
  cursor = 0
}

// One surface: mount (twice, so what its first reads answered is drawn), close, count clocks.
async function lifecycle(name, expression, props, act, after) {
  clock.live().forEach(timer => clock.clearInterval(timer.id))
  if (instances.size) close()
  draw(expression, props)
  await settle()
  const tree = draw(expression, props)
  await settle()
  if (act) { act(tree); await settle() }
  const open = clock.live().length
  close()
  if (after) after()
  const left = clock.live()
  assert.equal(
    left.length, 0,
    `${name} left ${left.length} timer${left.length === 1 ? '' : 's'} running after it closed: `
    + left.slice(0, 6).map(timer => `${timer.kind} ${timer.ms}ms armed at ${timer.at}`).join(', ')
    + (left.length > 6 ? `, and ${left.length - 6} more` : '')
    + ` (${open} live while it was open)`
  )
  return open
}

// ---- the props the surfaces are drawn with ----------------------------------
const view = {
  player: { id: 'me', name: 'Ada', named: true },
  viewer_id: 'me',
  allow_ai: true,
  opponent: { model: '' },
  play: [
    { id: 'connect4', title: 'Connect Four', kind: 'table', installed: true, bots: true },
    { id: 'gomoku', title: 'Gomoku', kind: 'table', installed: true, bots: true },
    { id: 'seabattle', title: 'Sea Battle', kind: 'table', installed: true, bots: true },
    { id: 'backgammon', title: 'Backgammon', kind: 'table', installed: true, bots: true },
    { id: 'slots', title: 'Slots', kind: 'table', installed: true, bots: true, solo: true }
  ],
  lobby: { lines: [], looking: [] },
  online: { on: false, url: '', disclosure: '' },
  setup: { welcome_needed: false, name: 'Ada', named: true },
  alerts: { rows: [], count: 0 }
}
const stored = {}
const ctx = {
  storage: {
    get: (key, fallback) => (key in stored ? stored[key] : fallback),
    set: (key, value) => { stored[key] = value },
    remove: key => { delete stored[key] }
  },
  os: { notify() {}, openExternal: () => Promise.resolve(true) },
  runAction: () => ({ ok: true }),
  rest: async asked => {
    if (asked === '/view') return view
    if (asked.startsWith('/board')) return { text: '', picture: null }
    if (asked === '/models') return { ok: true, routes: [], current: '' }
    if (asked === '/jackpot') return { chips: 1000, bonus: 0, feed: [], machines: [], autoplay: false, overchat: { on: false } }
    if (asked === '/champions') return {
      ok: true, champions: [], leaderboard: [], tournaments: [], divisions: [], games: [], ratings: {},
      bots: [], avatars: [], colors: [], brain: {}, model_ready: false,
      limits: { name: 24, motto: 60, brief: 200 }, caps: {}, playbook_limits: {}, pet: {}
    }
    if (asked === '/v1/version') return { version: '1.0.0', commit: 'abcdef1' }
    if (asked === '/online') return { on: false, url: '', disclosure: '', hall: { rooms: [] }, lobbies: [] }
    return {}
  }
}

const seats = [
  { side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false },
  { side: 'black', kind: 'local', id: 'local', name: 'Local', open: false }
]
const pictureFor = id => ({
  view: id, game: id, table_id: 't1', status: 'active', turn: 'white', plies: 1, moves: [],
  seats, legal: [], score: { white: 0, black: 0, draws: 0 }, schema_version: 2, level: 'intermediate'
})
// A table whose other seat is to move: the clock that counts the wait belongs to this shape.
const waitingSeats = [
  { side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false },
  { side: 'black', kind: 'agent', id: 'agent', name: 'Your agent', open: false }
]

const checks = []
const check = (name, expression, props, act, after) => checks.push({ name, expression, props, act, after })
const gameProps = (id, picture) => ({
  game: { id, title: id, installed: true, bots: true },
  view,
  board: { text: '', picture: picture || pictureFor(id) },
  send: async () => ({ text: 'OK' }),
  playMove: async () => ({ ok: true }),
  onBack: () => {},
  ctx
})

check('the Games page route', 'GameCenterRoute', { ctx })
check('the Games page', 'GameCenterPage', { ctx, onArea: () => {} })
check('the wait pane', 'WaitPane', { ctx })
check('the status bar item', 'GamesStatusItem', { ctx })
check('the over-chat strip', 'OverChatStrip', { ctx })
check('the wallet chip', 'PointsChip', { ctx })
check('the champions page', 'ChampionsPage', { ctx, view })
check('the lobby hall', 'LobbyHall', { ctx, view, current: 'connect4', onPlayHere: () => {} })
check('the online table', 'OnlineTable', {
  game: { id: 'connect4', title: 'Connect Four' }, view, ctx, roomId: 'room-1', onBack: () => {}, onClose: () => {}
})
check('the talking table', 'TalkingTable', {
  game: { id: 'prisoners_dilemma', title: 'Prisoners Dilemma', installed: true, bots: true },
  view, board: { text: '', picture: { ...pictureFor('prisoners_dilemma'), view: 'talk', legal: [] } },
  send: async () => ({ text: 'OK' }), refresh: async () => {}, onBack: () => {}, ctx
})
check('the slots cabinet', 'SlotMachine', {
  machine: { id: 'classic', title: 'Slots', rows: 3, reels: 3, strips: [[], [], []], lines: [] },
  machines: [{ id: 'classic', title: 'Slots', rows: 3, reels: 3, strips: [[], [], []], lines: [] }],
  result: null, chips: 100, bet: 5, bets: [5], odds: {}, autoplay: false, autobet: false,
  busy: false, canSpin: false, onSpin: () => {}, onBet: () => {}, onPickMachine: () => {},
  onAutoplay: () => {}, onAutobet: () => {}, paytable: [], rewards: {}, ctx
})
check('the jackpot cabinet', 'JackpotMachine', { ctx, mode: 'full' })
check('the jackpot overlay', 'JackpotOverlay', { ctx, onClose: () => {}, data: null })
check('the playbook editor', 'PlaybookEditor', {
  ctx, champion: { id: 'c1', name: 'Ada' }, limits: {}, pet: {}, onClose: () => {}, onChanged: () => {}
})
check('a pet sprite', 'PetSprite', { ctx, pet: { enabled: false, slug: 'x' }, state: 'idle' })
check('a learn diagram', 'LearnDiagram', {
  diagram: { label: 'D', frames: [{ say: 'one', marks: {} }, { say: 'two', marks: {} }] }
})
check('a learn demo', 'DemoPlayer', {
  demo: { intro: '', frames: [{ say: 'one' }, { say: 'two' }], outro: '' }
})
check('the corner coach', 'TalkCoachBox', {
  pictured: { coach: { open: true, available: true, until: Math.floor(Date.now() / 1000) + 15 } }, whisper: '', busy: false
})
for (const id of ['connect4', 'gomoku', 'reversi', 'checkers', 'chess', 'hex', 'go', 'breakthrough', 'seabattle', 'blackjack', 'slots']) {
  check(`the ${id} table`, 'PlayTable', gameProps(id))
}
check('a table waiting on a model', 'PlayTable', gameProps('gomoku', {
  ...pictureFor('gomoku'), turn: 'black', seats: waitingSeats, permissions: { can_move: false }
}))

check('the version chip', 'GamesVersionChip', { ctx })
check('the community shelf', 'CommunityShelf', { community: { games: [], makers: [] }, ctx })
check('the Mafia Town table', 'MafiaTown', {
  ...gameProps('mafia'), refresh: async () => {}, onClassic: () => {}
})
check('the pet battle panel', 'PetBattlePanel', gameProps('petbattles'))
check('the arena panel', 'ArenaPanel', gameProps('arena'))
check('the doctrine panel', 'DoctrinePanel', gameProps('doctrine'))
check('the slots table', 'SlotsTable', {
  picture: { ...pictureFor('slots'), legal: ['spin'], chips: 100, bet: 5, bets: [5], machines: [], feed: [], paytable: [] },
  interactive: true, busy: false, onMove: () => {}, onSetting: () => Promise.resolve({})
})
check('the admin page', 'AdminPage', { ctx, view })
check('the learn sheet', 'LearnSheet', { game: { id: 'connect4', title: 'Connect Four' }, ctx, onClose: () => {} })
check('the welcome panel', 'WelcomePanel', { view: { ...view, setup: { welcome_needed: true } }, ctx, onDone: () => {} })
check('the settings panel', 'SettingsPanel', { view, ctx, onBack: () => {}, onSaved: () => {}, skin: 'signal', onSkin: () => {} })
check('the backgammon board', 'BackgammonSvg', {
  picture: { ...pictureFor('backgammon'), points: Array(24).fill(0), bar: { white: 0, black: 0 }, off: { white: 0, black: 0 }, dice: [], legal: [] },
  height: 300, interactive: false, onMove: () => {}
})

// A reply starting makes the over-chat chip ask the shelf for the spin at once, on a short timer.
// The chip's copy can be closed in that moment (the pane is unregistered, the page is left), and
// the timer must go with it.
check('the over-chat chip, just after a reply starts', 'JackpotStatusItem', { ctx }, () => {
  fireHostEvent('message.start')
})

// A preference the person changed is posted to the shelf a moment later. The machine that took
// the change can be closed in that moment (the pane's ×, the Games page's Close), and the write
// must still happen - but on the way out, not on a timer left behind.
check('the slots cabinet, just after a look change', 'SlotMachine', {
  machine: { id: 'classic', title: 'Slots', rows: 3, reels: 3, strips: [[], [], []], lines: [] },
  machines: [{ id: 'classic', title: 'Slots', rows: 3, reels: 3, strips: [[], [], []], lines: [] }],
  result: null, chips: 100, bet: 5, bets: [5], odds: {}, autoplay: false, autobet: false,
  busy: false, canSpin: false, onSpin: () => {}, onBet: () => {}, onPickMachine: () => {},
  onAutoplay: () => {}, onAutobet: () => {}, paytable: [], rewards: {}, ctx
}, () => { evaluate('SM_savePrefs()') })

// ---- run --------------------------------------------------------------------
;(async () => {
  const report = []
  for (const item of checks) {
    const open = await lifecycle(item.name, item.expression, item.props, item.act, item.after)
    report.push(`${item.name}: ${open} timer${open === 1 ? '' : 's'} while open, 0 after close`)
  }
  console.log(report.join('\n'))
  console.log('surface clocks: passed')
  process.exit(0)
})().catch(error => {
  console.error(error && error.stack ? error.stack : String(error))
  process.exit(1)
})
