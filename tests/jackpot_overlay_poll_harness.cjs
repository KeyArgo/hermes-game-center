// The over-chat slot rests when nothing is happening.
//
// The status chip used to ask the shelf for the machine every 600 ms for as long as it was mounted,
// whether or not anything was happening: a hundred reads a minute of the wallet file, per view of
// the machine, for numbers that only move while a turn runs or a spin lands. This harness mounts the
// real component on a fake clock, with a fake host that can say whether the focused chat is working,
// and counts the reads instead of waiting for them.
//
// The moments it pins:
//   idle            -> a read every 5 s
//   busy            -> a read every 600 ms, and one at once when the turn starts
//   the tail        -> still 600 ms for 3 s after the turn ends
//   hidden          -> no reads at all
//   visible again   -> a read at once, then the cadence again
//   message.start   -> a read at once (and its 400 ms follow-up, unchanged)
//   no busy state   -> exactly the old cadence, 600 ms
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '../desktop/plugin.js'), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export \{.*\}$/gm, '').replace('export default {', 'const plugin = {')

// ---- the fake clock ---------------------------------------------------------
// A cadence is counted, never waited for: the harness moves the clock on and runs whatever was due,
// so a check of five seconds of polling takes milliseconds and is exact.
let nextId = 1
let now = 0
let live = new Map()
const armed = (fn, ms, every) => {
  const id = nextId++
  live.set(id, { id, fn, every, due: now + Math.max(0, Number(ms) || 0) })
  return id
}
const clock = {
  now: () => now,
  setTimeout: (fn, ms) => armed(fn, ms, 0),
  setInterval: (fn, ms) => armed(fn, ms, Math.max(1, Number(ms) || 1)),
  clearTimeout: id => { live.delete(id) },
  clearInterval: id => { live.delete(id) },
  count: () => live.size
}
// The read is async, so every step of the clock lets the microtasks finish before the next timer runs.
const settle = async (rounds = 4) => {
  for (let round = 0; round < rounds; round += 1) await new Promise(resolve => setImmediate(resolve))
}
async function advance(ms) {
  const target = now + ms
  for (;;) {
    const due = [...live.values()].filter(timer => timer.due <= target).sort((a, b) => a.due - b.due)[0]
    if (!due) break
    now = due.due
    if (due.every) due.due = now + due.every
    else live.delete(due.id)
    due.fn()
    await settle()
  }
  now = target
  await settle()
}
// Time comes from the clock: a resting cadence is decided by Date.now(), so the fake one has to move.
class FakeDate extends Date {
  constructor(...args) {
    if (args.length) super(...args)
    else super(now)
  }
  static now() { return now }
}

// ---- the window: hidden, and the event that says so -------------------------
const windowListeners = {}
const documentListeners = {}
const listen = (bag, type, fn) => { (bag[type] = bag[type] || []).push(fn) }
const unlisten = (bag, type, fn) => { bag[type] = (bag[type] || []).filter(item => item !== fn) }

const sandbox = {
  console,
  Set, Map, JSON, Math, Promise, Object, Array, String, Number, Boolean, Error, RegExp,
  Date: FakeDate,
  setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  setInterval: clock.setInterval, clearInterval: clock.clearInterval,
  PANES_AREA: 'panes', PALETTE_AREA: 'palette', ROUTES_AREA: 'routes',
  SIDEBAR_NAV_AREA: 'nav', STATUSBAR_AREAS: { right: 'right' }, TITLEBAR_AREAS: { right: 'titleBar.right' },
  COMPOSER_AREAS: { top: 'composer.top', bottom: 'composer.bottom', underside: 'composer.underside' }
}
const storage = {}
sandbox.window = {
  localStorage: {
    getItem: key => (key in storage ? storage[key] : null),
    setItem: (key, value) => { storage[key] = String(value) },
    removeItem: key => { delete storage[key] }
  },
  addEventListener: (type, fn) => listen(windowListeners, type, fn),
  removeEventListener: (type, fn) => unlisten(windowListeners, type, fn)
}
const fakeDocument = {
  hidden: false,
  visibilityState: 'visible',
  addEventListener: (type, fn) => listen(documentListeners, type, fn),
  removeEventListener: (type, fn) => unlisten(documentListeners, type, fn),
  getElementById: () => null,
  activeElement: null
}
sandbox.document = fakeDocument
const appear = async hidden => {
  fakeDocument.hidden = hidden
  fakeDocument.visibilityState = hidden ? 'hidden' : 'visible'
  ;(documentListeners.visibilitychange || []).slice().forEach(fn => fn({ type: 'visibilitychange' }))
  await settle()
}

// ---- the host: a busy atom and an event stream ------------------------------
const busyAtom = { value: false, get() { return this.value }, subscribe() { return () => {} } }
const hostListeners = {}
const fireHostEvent = type => (hostListeners[type] || []).slice().forEach(fn => fn({ type }))
sandbox.host = {
  state: { busy: busyAtom },
  onEvent(type, fn) {
    listen(hostListeners, type, fn)
    return () => unlisten(hostListeners, type, fn)
  },
  navigate() {},
  revealPane() {}
}
sandbox.CustomEvent = class { constructor(type, opts) { this.type = type; Object.assign(this, opts || {}) } }
sandbox.Component = class {
  constructor(props) { this.props = props; this.state = {} }
  setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) } }
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

// ---- hooks, as React would run them for one mount ---------------------------
let hooks = []
let cursor = 0
let queued = []
let cleanups = []
sandbox.useState = initial => {
  const at = cursor++
  if (!(at in hooks)) hooks[at] = typeof initial === 'function' ? initial() : initial
  return [hooks[at], value => { hooks[at] = typeof value === 'function' ? value(hooks[at]) : value }]
}
sandbox.useRef = initial => {
  const at = cursor++
  if (!(at in hooks)) hooks[at] = { current: initial }
  return hooks[at]
}
sandbox.useCallback = fn => fn
sandbox.useMemo = fn => fn()
// The SDK's atom reader: the host's own atom, read now.
sandbox.useValue = atom => atom.get()
sandbox.useEffect = (fn, deps) => {
  const at = cursor++
  const before = hooks[at]
  const changed = !before || !deps || deps.some((dep, index) => dep !== before[index])
  if (!changed) return
  hooks[at] = deps || []
  queued.push({ at, fn })
}
sandbox.useLayoutEffect = sandbox.useEffect
sandbox.useInsertionEffect = sandbox.useEffect
sandbox.jsx = sandbox.jsxs = (type, props, extra) => {
  const p = props || {}
  if (extra && typeof extra === 'object' && !Array.isArray(extra) && 'children' in extra) {
    return { type, props: { ...p, children: extra.children }, key: extra.key }
  }
  return { type, props: p, key: extra }
}

// A read is counted, with the clock time it happened at. machineData is the one answer the fake
// shelf gives; a check that needs a new spin swaps in a feed row.
const reads = []
let machineData = { chips: 12340, autoplay: false, overchat: { on: true }, machines: [], feed: [] }
const ctx = {
  rest: async asked => {
    reads.push({ path: asked, at: now })
    return machineData
  }
}
sandbox.props = { ctx }

function draw() {
  cursor = 0
  const tree = vm.runInContext('JackpotStatusItem(props)', sandbox)
  const pending = queued
  queued = []
  pending.forEach(({ at, fn }) => {
    if (cleanups[at]) cleanups[at]()
    cleanups[at] = fn()
  })
  // A drawn component that asks for something in its effects may draw again; one pass is enough for
  // the clock, and the state a second pass would show is not counted here.
  return tree
}
async function mount() {
  draw()
  await settle()
}
function unmount() {
  cleanups.slice().reverse().forEach(fn => { if (typeof fn === 'function') fn() })
  cleanups = []
  hooks = []
  queued = []
  cursor = 0
}
// The host re-renders a component whose atom changed; drawing again is how that reaches the hooks.
async function turnOf(value) {
  busyAtom.value = value
  draw()
  await settle()
}

// Reads are counted per step, not by timestamp: the clock can stand still between a mount and an
// unmount, so an index is the only honest marker of "since here".
const since = from => reads.slice(from)

;(async () => {
  // ---- idle: a read every 5 s ----------------------------------------------
  await mount()
  assert.equal(reads.length, 1, 'the chip reads once as it opens')
  const idleFrom = reads.length
  await advance(11000)
  const idle = since(idleFrom)
  assert.equal(idle.length, 2, `an idle chip reads every 5 s, not every 600 ms (${idle.map(r => r.at).join(', ')})`)
  assert.equal(idle[0].at, 5000, 'the first resting read is at 5 s')
  assert.equal(idle[1].at - idle[0].at, 5000, `the resting gap is 5 s (${idle[1].at - idle[0].at})`)

  // ---- busy: 600 ms, and one read the moment the turn starts ---------------
  const beforeBusy = reads.length
  await turnOf(true)
  assert.equal(since(beforeBusy).length, 1, 'a turn starting is read at once, not at the next tick')
  const busyFrom = reads.length
  await advance(3000)
  const busy = since(busyFrom)
  assert.ok(busy.length >= 4 && busy.length <= 6,
    `a working chat is read every 600 ms (${busy.length} reads in 3 s)`)
  assert.ok(busy.every((read, index) => index === 0 || read.at - busy[index - 1].at === 600),
    'and the busy gap is exactly 600 ms')

  // ---- the tail: 3 s of 600 ms after the turn ends ------------------------
  await turnOf(false)
  const tailFrom = reads.length
  await advance(3000)
  const tail = since(tailFrom)
  assert.ok(tail.length >= 4, `the 3 s after a turn end are still watched closely (${tail.length} reads)`)

  // ---- and then it rests again -------------------------------------------
  const restFrom = reads.length
  await advance(6000)
  const resting = since(restFrom)
  assert.ok(resting.length <= 2, `after the tail the chip rests again (${resting.length} reads in 6 s)`)

  // ---- hidden: no reads at all -------------------------------------------
  await appear(true)
  const hiddenFrom = reads.length
  await advance(20000)
  assert.equal(since(hiddenFrom).length, 0, 'a hidden window is not polled at all')

  // ---- visible again: a read at once, then the cadence --------------------
  await appear(false)
  assert.equal(since(hiddenFrom).length, 1, 'coming back on screen reads at once')
  const shownFrom = reads.length
  await advance(5500)
  const resumed = since(shownFrom)
  assert.ok(resumed.length >= 1 && resumed.length <= 2,
    `and then it rests at 5 s again (${resumed.length} reads in 5.5 s)`)

  // ---- a reply starting: the message.start pull is unchanged --------------
  const eventFrom = reads.length
  fireHostEvent('message.start')
  await settle()
  assert.equal(since(eventFrom).length, 1, 'message.start reads at once')
  await advance(400)
  assert.equal(since(eventFrom).length, 2, 'and the 400 ms follow-up read is still there')

  // ---- a new spin on the feed: watched while the reels run ----------------
  const spinFrom = reads.length
  machineData = { ...machineData, feed: [{ machine: 'fruit9', at: 99, reels: ['🍒', '🍒', '🍒'], payout: 100 }] }
  await advance(5000)
  const caught = since(spinFrom)
  assert.ok(caught.length >= 1, 'the spin is read')
  const reelFrom = reads.length
  await advance(1800)
  assert.ok(since(reelFrom).length >= 2,
    `a new spin keeps the reels watched, not rested (${since(reelFrom).length} reads)`)

  // ---- the clock and the listener are given back --------------------------
  assert.ok(clock.count() > 0, 'the chip holds one clock while it is open')
  unmount()
  assert.equal(clock.count(), 0, 'closing the chip leaves no timer behind')
  assert.equal((documentListeners.visibilitychange || []).length, 0,
    'and takes its visibility listener with it')

  // ---- a host with no busy state: exactly the old cadence ----------------
  sandbox.host.state = {}
  const beforePlain = reads.length
  await mount()
  assert.equal(since(beforePlain).length, 1, 'the mount reads once')
  const plainFrom = reads.length
  await advance(3000)
  const plain = since(plainFrom)
  assert.ok(plain.length >= 4 && plain.length <= 6,
    `an older host keeps the 600 ms cadence it always had (${plain.length} reads at ${plain.map(r => r.at).join(', ')})`)
  assert.ok(plain.every((read, index) => index === 0 || read.at - plain[index - 1].at === 600),
    'and that cadence is 600 ms')
  unmount()

  console.log('jackpot overlay poll: passed')
})().catch(error => {
  console.error(error && error.stack ? error.stack : String(error))
  process.exitCode = 1
})
