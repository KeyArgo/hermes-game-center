const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../desktop/plugin.js'), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export \{.*\}$/gm, '').replace('export default {', 'const plugin = {')
const sandbox = {
  console, Set, setTimeout, clearTimeout, setInterval, clearInterval,
  PANES_AREA: 'panes', PALETTE_AREA: 'palette', ROUTES_AREA: 'routes',
  SIDEBAR_NAV_AREA: 'nav', STATUSBAR_AREAS: { right: 'right' },
  COMPOSER_AREAS: { top: 'composer.top', bottom: 'composer.bottom', underside: 'composer.underside' }
}
// The SDK host the plugin reads at load. Only what the pane uses is here, so a
// missing door behaves like an older desktop.
const chatBusy = { value: false, get() { return this.value }, subscribe() { return () => {} } }
const eventListeners = {}
// A minimal window/document: the pane's Esc and outside-click doors listen on
// them. Tests fire keys with windowListeners.keydown.forEach(fn => fn(event)).
const windowListeners = {}
const fireKey = key => {
  const event = { key, preventDefault: () => {}, stopPropagation: () => {} }
  ;(windowListeners.keydown || []).forEach(fn => fn(event))
}
const sessionStore = {}
const fakeWindow = {
  addEventListener: (type, fn) => { windowListeners[type] = (windowListeners[type] || []).concat(fn) },
  removeEventListener: (type, fn) => { windowListeners[type] = (windowListeners[type] || []).filter(item => item !== fn) },
  sessionStorage: {
    getItem: key => (key in sessionStore ? sessionStore[key] : null),
    setItem: (key, value) => { sessionStore[key] = String(value) },
    removeItem: key => { delete sessionStore[key] }
  },
  dispatchEvent: event => {
    ;(windowListeners[event.type] || []).forEach(fn => fn(event))
    return true
  }
}
class FakeEvent {
  constructor(type, opts) { this.type = type; Object.assign(this, opts || {}) }
}
sandbox.window = { ...fakeWindow, listeners: windowListeners, fireKey }
const fakeDocument = {
  addEventListener: fakeWindow.addEventListener,
  removeEventListener: fakeWindow.removeEventListener,
  getElementById: () => null,
  activeElement: null
}
sandbox.document = fakeDocument
sandbox.CustomEvent = FakeEvent
sandbox.fireKey = fireKey
sandbox.host = {
  state: { busy: chatBusy },
  onEvent(type, listener) {
    eventListeners[type] = (eventListeners[type] || []).concat([listener])
    return () => { eventListeners[type] = (eventListeners[type] || []).filter(item => item !== listener) }
  },
  revealPane() { sandbox.revealed = (sandbox.revealed || 0) + 1 },
  navigate(route) { sandbox.navigated = route }
}
sandbox.eventListeners = eventListeners
// React's class base, for the error boundary.
sandbox.Component = class { constructor(props) { this.props = props; this.state = {} } setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) } } }
vm.createContext(sandbox)
vm.runInContext(source, sandbox)
const _dbg = (label) => console.error("DBG", label, typeof sandbox.window, sandbox.window && typeof sandbox.window.addEventListener)
const evaluate = expression => vm.runInContext(expression, sandbox)
const active = {
  status: 'active', turn: 'white', schema_version: 2,
  seats: [{ side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false },
    { side: 'black', kind: 'human', id: '', name: '', open: true }]
}
sandbox.pic = active
sandbox.viewer = { player: { id: 'me' }, allow_ai: true }
assert.equal(evaluate('tableAccess(pic, viewer).can_move'), true)
sandbox.viewer.player.id = 'spectator'
assert.equal(evaluate('tableAccess(pic, viewer).can_move'), false)
assert.equal(evaluate('tableAccess(pic, viewer).can_manage'), false)
assert.equal(evaluate('tableAccess(pic, viewer).can_join'), true)
sandbox.pic = { ...active, permissions: { can_move: false, can_join: false } }
assert.equal(evaluate('tableAccess(pic, viewer).can_join'), false)
sandbox.pic = { status: 'active', turn: 'white' }
assert.equal(evaluate('tableAccess(pic, viewer).can_move'), true, 'legacy boards remain playable')
// A game that always has a winner (Hex) offers no draw; every other game still does.
sandbox.viewer = { player: { id: 'me' }, allow_ai: true }
sandbox.pic = { ...active, draws: true }
assert.equal(evaluate('tableAccess(pic, viewer).can_draw'), true, 'a game with draws offers one')
sandbox.pic = { ...active, draws: false }
assert.equal(evaluate('tableAccess(pic, viewer).can_draw'), false, 'Hex offers no draw it can never reach')
sandbox.pic = { ...active }
assert.equal(evaluate('tableAccess(pic, viewer).can_draw'), true, 'older pictures keep the old behaviour')
// Review My Game: one person at the table, after the game has finished.
sandbox.viewer = { player: { id: 'me' }, allow_ai: true }
const finishedSeats = [
  { side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false },
  { side: 'black', kind: 'local', name: 'Local', open: false }
]
sandbox.pic = { status: 'win', turn: 'white', winner: 'white', schema_version: 2, seats: finishedSeats }
assert.equal(evaluate('tableAccess(pic, viewer).can_review'), true, 'a finished solo game can be reviewed')
sandbox.pic = { status: 'active', turn: 'white', schema_version: 2, seats: finishedSeats }
assert.equal(evaluate('tableAccess(pic, viewer).can_review'), false, 'no review until the game is over')
sandbox.pic = { status: 'win', turn: 'white', winner: 'white', schema_version: 2, seats: [
  { side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false },
  { side: 'black', kind: 'human', id: 'bea', name: 'Bea', open: false }
] }
assert.equal(evaluate('tableAccess(pic, viewer).can_review'), false, 'never for a game between two people')
assert.equal(evaluate('tableAccess(pic, viewer).can_rematch'), true)
sandbox.pic = { status: 'win', winner: 'white', schema_version: 2, seats: finishedSeats, permissions: { can_review: true } }
assert.equal(evaluate('tableAccess(pic, viewer).can_review'), true, 'gateway permissions are authoritative')
sandbox.pic = { status: 'win', winner: 'white', schema_version: 2, seats: finishedSeats, permissions: { can_review: false } }
assert.equal(evaluate('tableAccess(pic, viewer).can_review'), false)
console.log('table access: passed')

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
sandbox.useCallback = (fn, deps) => {
  const index = cursor++
  const before = hooks[index]
  if (!before || !deps || deps.some((dep, i) => dep !== before.deps[i])) {
    hooks[index] = { fn, deps: deps || [] }
  }
  return hooks[index].fn
}
// A readable atom, the way the SDK's useValue subscribes: the render reads the
// live value, and the harness re-renders by hand when the value changes.
sandbox.useValue = atom => {
  const index = cursor++
  if (!(index in hooks)) hooks[index] = atom.get()
  return atom.get()
}
sandbox.useEffect = (fn, deps) => {
  const index = cursor++
  const before = hooks[index]
  if (!before || deps.some((dep, i) => dep !== before[i])) {
    hooks[index] = deps
    effects.push(() => { if (cleanups[index]) cleanups[index](); cleanups[index] = fn() })
  }
}
// The plugin builds elements with children in a third argument -
// jsxs('span', style, { children: [...] }) - so a stub that reads only props.children loses them and
// no check can ever see their text. Measured 2026-11-10: the machine picker drew two data-sm-pick
// buttons while words(tree) could not find "Classic".
sandbox.jsx = sandbox.jsxs = (type, props, extra) => {
  const p = props || {}
  // Some elements carry their children in a third argument - jsxs('span', style, { children: [...] }).
  // Only that shape is folded in; a plain string stays a key, which is what it was before.
  if (extra && typeof extra === 'object' && !Array.isArray(extra) && 'children' in extra) {
    return { type, props: { ...p, children: extra.children }, key: extra.key }
  }
  return { type, props: p, key: extra }
}
// react's useCallback/useMemo: the component is drawn once per check here, so returning the function
// and calling the factory is the honest equivalent. Without useCallback, SlotMachine threw
// "useCallback is not defined" and the harness stopped before drawing anything at all.
sandbox.useCallback = fn => fn
sandbox.useMemo = fn => fn()
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...[].concat(tree.props && tree.props.children || []).flatMap(nodes)]
const words = tree => !tree ? '' : typeof tree !== 'object' ? String(tree) : Array.isArray(tree) ? tree.map(words).join(' ') : [].concat(tree.props && tree.props.children || []).map(words).join(' ')
const findButton = (tree, label) => nodes(tree).find(node => node.type === 'button' && words(node) === label)
// A page must never show two controls with the same visible name: a newcomer pressing
// 'Advanced' cannot know whether they will sit down at Expert or open the options box.
const uniqueControlNames = (tree, page) => {
  const seen = new Map()
  for (const node of nodes(tree)) {
    if (node.type !== 'button' && node.type !== 'summary') continue
    const name = words(node).trim()
    if (!name) continue
    seen.set(name, (seen.get(name) || 0) + 1)
  }
  const dupes = [...seen].filter(([, count]) => count > 1).map(([name, count]) => `${count}x "${name}"`)
  assert.equal(dupes.join(', '), '', `${page} has no two controls with the same visible name`)
}
const calls = []
const props = { game: { id: 'connect4', title: 'Connect Four', installed: true, bots: true },
  view: { player: { id: 'spectator' }, allow_ai: true },
  board: { picture: { ...active, table_id: 'table-1', view: 'connect4', moves: ['4', '5'], plies: 2, score: { white: 2, black: 1, draws: 3 } } },
  send: async line => { calls.push(line); return { text: 'OK' } }, playMove: async (...args) => calls.push(args), onBack: () => calls.push('back') }
sandbox.props = props
function render() {
  cursor = 0
  const tree = evaluate('PlayTable(props)')
  const pending = effects; effects = []; pending.forEach(effect => effect())
  return tree
}
function reset() { cleanups.forEach(fn => fn && fn()); cleanups = []; hooks = []; effects = [] }
let tree = render()
assert.ok(words(tree).includes('Spectating'), 'unseated viewers have an explicit read-only mode')
assert.ok(words(tree).includes('Open seat'))
assert.equal(nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'BoardSvg').props.interactive, false)
assert.ok(findButton(tree, 'Sit as Black'))
findButton(tree, 'Sit as Black').props.onClick()
assert.equal(calls.pop(), 'connect4 sit black')
assert.equal(findButton(tree, 'Join table'), undefined, 'the invite path is gone from the game page')
assert.ok(words(tree).includes('Move history'))
assert.ok(words(tree).includes('Ada 2'), 'a seated player is named, never a colour')
assert.ok(/You 1|Black 1/.test(words(tree)), 'the black seat reads You once taken, its colour while open')
assert.ok(words(tree).includes('Draws 3'))
assert.ok(findButton(tree, 'Learn to play'), 'lessons are offered')
findButton(tree, 'Learn to play').props.onClick()
props.board.picture = { ...props.board.picture, status: 'idle', seats: [], owner_id: 'me' }
tree = render()
assert.ok(findButton(tree, 'Play the computer'), 'the computer is offered by name')
assert.ok(findButton(tree, 'Intermediate'), 'and with plain levels')
assert.ok(findButton(tree, 'Play my Hermes model(s)'), 'your own models are offered as opponents')
assert.ok(findButton(tree, 'Same screen (pass and play)'), 'a friend on one screen is offered')
assert.equal(findButton(tree, 'Open in browser'), undefined, 'the game page carries no browser door')
assert.ok(!words(tree).includes('games.hermesnet.xyz'), 'and no lobby address to copy')
assert.ok(!words(tree).includes('Hermes does not run or host them'), 'nor the outside-Hermes note')
// The How-to-play door is the shared LearnButton (a component the harness cannot draw
// inside), so its own element is read off the tree: it must wear the approved words.
const learnElement = nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'LearnButton')
assert.ok(learnElement && learnElement.props.label === 'How to play', 'the header offers How to play')
assert.ok(findButton(tree, 'Settings'), 'and Settings')
const advancedNode = nodes(tree).find(node => node.type === 'details' && words(node).includes('More options'))
assert.ok(advancedNode, 'a More options disclosure holds the table controls')
const inNormal = label => nodes(tree).filter(node => node.type === 'button' && words(node) === label && !nodes(advancedNode).includes(node)).length
assert.equal(inNormal('Join table'), 0, 'Join is not in the normal view')
assert.equal(inNormal('Installed'), 0, 'Installed is not in the normal view')
assert.equal(inNormal('Play move'), 0, 'the move picker is behind More options')
assert.equal(findButton(advancedNode, 'Join table'), undefined, 'Join is gone from More options too: online play is the in-Hermes lobby')
assert.ok(findButton(tree, 'Agent vs bot'))
uniqueControlNames(tree, 'the game page with its start panel open')
props.board.picture = { ...active, table_id: 'table-1', view: 'connect4', seats: [
  { side: 'white', kind: 'human', id: 'someone', name: 'Someone', open: false },
  { side: 'black', kind: 'agent', id: 'agent', name: 'Your Hermes model', open: false }
] }
tree = render()
assert.ok(/Your Hermes model/.test(words(tree)), 'agent seat is labelled')
reset()
console.log('seats and spectator room: passed')

async function lifecycle() {
  props.view.player.id = 'me'
  tree = render()
  assert.ok(findButton(tree, 'Resign'), 'seated humans can resign')
  const before = calls.length
  findButton(tree, 'Resign').props.onClick()
  tree = render()
  assert.equal(calls.length, before, 'resign needs explicit confirmation')
  assert.ok(nodes(tree).some(node => node.props.role === 'alertdialog'))
  findButton(tree, 'Cancel').props.onClick()
  tree = render()
  assert.equal(calls.length, before)
  let finish
  props.send = line => { calls.push(line); return new Promise(resolve => { finish = resolve }) }
  findButton(tree, 'Resign').props.onClick()
  tree = render()
  findButton(tree, 'Confirm resign').props.onClick()
  tree = render()
  assert.equal(calls.at(-1), 'connect4 resign')
  assert.ok(findButton(tree, 'Resign').props.disabled, 'all match controls lock while awaiting authority')
  const count = calls.length
  findButton(tree, 'Resign').props.onClick()
  assert.equal(calls.length, count)
  finish({ ok: false, text: 'Seat changed. Refresh and try again.' })
  await new Promise(resolve => setImmediate(resolve))
  tree = render()
  assert.ok(words(tree).includes('Seat changed. Refresh and try again.'))
  assert.ok(nodes(tree).some(node => node.props.role === 'alert'))
  assert.ok(findButton(tree, 'Close table'), 'a viewer with no seat closes the table')
  assert.ok(findButton(tree, 'Offer draw'))
  props.board.picture.draw_offer = 'black'
  tree = render()
  assert.ok(findButton(tree, 'Accept draw'))
  props.send = async line => { calls.push(line); return { text: 'Draw agreed.' } }
  findButton(tree, 'Accept draw').props.onClick()
  tree = render()
  findButton(tree, 'Confirm draw').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.at(-1), 'connect4 draw accept', 'accept draw sends the acceptance verb, not another offer')
  reset()
  // Leaving a seat with another person at the table asks once, in the owner's words.
  props.board.picture = { ...active, table_id: 'table-1', view: 'connect4', seats: [
    { side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false },
    { side: 'black', kind: 'human', id: 'bea', name: 'Bea', open: false }
  ] }
  props.view.player.id = 'me'
  props.send = async line => { calls.push(line); return { text: 'OK' } }
  tree = render()
  assert.ok(findButton(tree, 'Leave table'), 'a seated person can leave')
  findButton(tree, 'Leave table').props.onClick()
  tree = render()
  assert.ok(words(tree).includes('Leave this game? It counts as a resignation'), 'the owner\'s words: ' + words(tree).slice(-200))
  assert.ok(words(tree).includes('it forfeits the match'), 'and says leaving forfeits the game')
  assert.ok(findButton(tree, 'Leave'))
  assert.ok(findButton(tree, 'Keep playing'))
  const beforeLeave = calls.length
  findButton(tree, 'Keep playing').props.onClick()
  tree = render()
  assert.equal(calls.length, beforeLeave, 'Keep playing sends nothing')
  assert.ok(findButton(tree, 'Leave table'))
  findButton(tree, 'Leave table').props.onClick()
  tree = render()
  findButton(tree, 'Leave').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.at(-1), 'connect4 leave', 'leave resigns and frees the seat in one command')
  tree = render()
  assert.ok(findButton(tree, 'Play the computer'), 'and the game\'s own start screen comes back')
  reset()
  // Against the computer, leaving an active game still asks once, and says it forfeits it.
  props.board.picture = { ...active, table_id: 'table-2', view: 'connect4', seats: [
    { side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false },
    { side: 'black', kind: 'local', id: '', name: 'Computer', open: false }
  ] }
  tree = render()
  const beforeQuit = calls.length
  findButton(tree, 'Leave table').props.onClick()
  tree = render()
  assert.equal(calls.length, beforeQuit, 'leaving an active game never sends on the first press')
  assert.ok(findButton(tree, 'Leave') && findButton(tree, 'Keep playing'), 'it asks first')
  assert.ok(words(tree).includes('leaving forfeits it'), 'and says leaving forfeits the game')
  findButton(tree, 'Leave').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.at(-1), 'connect4 abandon', 'confirming closes the table')
  // With no game in progress, Close table goes straight back to the shelf.
  reset()
  props.board.picture = { ...active, status: 'idle', seats: [] }
  tree = render()
  findButton(tree, 'Close table').props.onClick()
  assert.equal(calls.at(-1), 'back', 'no game in progress: close immediately')
  reset()
  props.board.picture = { ...props.board.picture, status: 'win', winner: 'white', rematch: { requested_by: ['black'] } }
  tree = render()
  assert.ok(words(tree).includes('White wins'), 'the winner is said in plain words: ' + words(tree).slice(0, 200))
  assert.ok(findButton(tree, 'Accept rematch'))
  assert.equal(nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'BoardSvg').props.interactive, false)
  reset()
  console.log('match lifecycle and authority errors: passed')
  await watchContract()
}
async function watchContract() {
  sandbox.viewer = { viewer_id: 'me', player: { name: 'Ada' }, allow_ai: true }
  sandbox.pic = active
  assert.equal(evaluate('tableAccess(pic, viewer).can_move'), true, 'viewer_id is the API identity contract')
  const tasks = new Map(); let timerId = 0
  sandbox.setTimeout = fn => { const id = ++timerId; tasks.set(id, fn); return id }
  sandbox.clearTimeout = id => tasks.delete(id)
  const tick = async () => { const next = tasks.entries().next().value; assert.ok(next, 'expected queued watch tick'); tasks.delete(next[0]); next[1](); await new Promise(resolve => setImmediate(resolve)) }
  let steps = 0, resolveStep, allowed = true
  sandbox.step = () => { steps++; return new Promise(resolve => { resolveStep = resolve }) }
  sandbox.canContinue = () => allowed
  sandbox.onError = error => { throw error }
  const stop = evaluate('startTableWatch(step, canContinue, onError)')
  assert.equal(steps, 0, 'watch starts paced, not immediately')
  await tick()
  assert.equal(steps, 1)
  assert.equal(tasks.size, 0, 'no overlapping step while response is pending')
  stop()
  resolveStep(true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(tasks.size, 0, 'cancel prevents late completion from scheduling')
  const stopAgain = evaluate('startTableWatch(step, canContinue, onError)')
  await tick()
  allowed = false
  resolveStep(true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(tasks.size, 0, 'finished tables never requeue')
  stopAgain()
  console.log('identity and serial cancellable watch: passed')
  reset()
  allowed = true
  props.view = { viewer_id: 'me', player: { name: 'Ada' }, allow_ai: true }
  props.board.picture = { ...active, status: 'idle', owner_id: 'me', seats: [] }
  props.send = async line => {
    calls.push(line)
    if (line.startsWith('allow-ai')) props.board.picture = { ...active, owner_id: 'me', seats: [
      { side: 'white', kind: 'local', name: 'Local', open: false },
      { side: 'black', kind: 'local', name: 'Local', open: false }
    ] }
    return { ok: true, picture: props.board.picture }
  }
  tree = render()
  findButton(tree, 'Watch bots').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  tree = render()
  assert.equal(tasks.size, 1, 'PlayTable uses the paced watch timer')
  assert.ok(words(tree).includes('Watching bots · table owner'), 'bot owner should not be labeled read-only spectator')
  findButton(tree, 'Stop').props.onClick()
  assert.equal(tasks.size, 0, 'Stop cancels the timer synchronously')
  tree = render()
  assert.ok(findButton(tree, 'Resume bots'), 'stopping playback does not require replacing the match')
  findButton(tree, 'Resume bots').props.onClick()
  tree = render()
  assert.equal(tasks.size, 1)
  findButton(tree, 'Back to games').props.onClick()
  assert.equal(tasks.size, 0, 'Back cancels the timer synchronously')
  reset()
  // Agent vs bot: the agent's turn is a seat the page is allowed to step.
  sandbox.pic = { ...active, turn: 'white', permissions: { can_manage: true, can_step: true }, seats: [
    { side: 'white', kind: 'agent', id: 'agent', name: 'Your agent', open: false },
    { side: 'black', kind: 'local', id: 'local', name: 'Local', open: false }
  ] }
  sandbox.viewer = { viewer_id: 'me', player: { name: 'Ada' }, allow_ai: true }
  assert.equal(evaluate('tableAccess(pic, viewer).can_step'), true,
    'the agent seat must be steppable exactly like the built-in one')
  props.view = { viewer_id: 'me', player: { name: 'Ada' }, allow_ai: true }
  props.board.picture = { ...active, status: 'idle', owner_id: 'me', seats: [] }
  calls.length = 0
  props.send = async line => {
    calls.push(line)
    if (line.startsWith('allow-ai')) props.board.picture = { ...sandbox.pic, owner_id: 'me' }
    return { ok: true, picture: props.board.picture }
  }
  tree = render()
  findButton(tree, 'Agent vs bot').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  tree = render()
  assert.equal(calls.at(-1), 'allow-ai connect4 white=agent black=local')
  assert.equal(tasks.size, 1, 'an agent-vs-bot table keeps advancing on the agent turn')
  findButton(tree, 'Stop').props.onClick()
  tree = render()
  assert.ok(!findButton(tree, 'Resume bots').props.disabled, 'Resume bots stays available on an agent turn')
  assert.ok(!findButton(tree, 'Next move').props.disabled, 'Next move stays available on an agent turn')
  reset()
  props.board.picture = { ...props.board.picture, status: 'idle', seats: [] }
  let finishSetup
  props.send = () => new Promise(resolve => { finishSetup = resolve })
  tree = render()
  findButton(tree, 'Watch bots').props.onClick()
  findButton(tree, 'Back to games').props.onClick()
  finishSetup({ ok: true })
  await new Promise(resolve => setImmediate(resolve))
  tree = render()
  assert.equal(tasks.size, 0, 'late bot setup cannot resume after Back')
  reset()
  console.log('watch room integration: passed')
  props.board.picture = { status: 'idle', view: 'connect4', game: 'connect4' }
  props.send = async () => {
    props.board.picture = { status: 'active', view: 'connect4', game: 'connect4', white: 'Local', black: 'Local', turn: 'white' }
    return { ok: true, picture: props.board.picture }
  }
  tree = render()
  findButton(tree, 'Watch bots').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  tree = render()
  assert.equal(tasks.size, 1, 'legacy watch controls work only after explicit consent')
  reset()
  assert.equal(tasks.size, 0)
  // Legacy gateways can return a refusal as text; unchanged human seats must not look like playback.
  props.board.picture = { ...active, owner_id: 'me', seats: active.seats }
  props.send = async () => ({ text: 'A match is in progress.' })
  tree = render()
  findButton(tree, 'Watch bots').props.onClick()
  tree = render()
  findButton(tree, 'Confirm replace match').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  tree = render()
  tree = render() // settle the effect that validates authoritative playback eligibility
  assert.equal(findButton(tree, 'Stop'), undefined, 'refused bot setup must not leave a phantom Stop control')
  reset()
  await transportContract()
  await staleResponseContract()
}
async function transportContract() {
  sandbox.setInterval = () => 1
  sandbox.clearInterval = () => {}
  let failCommand = false, refuseCommand = false, boardRead = 0
  const game = { id: 'connect4', title: 'Connect Four', kind: 'table', installed: true }
  const ctx = { rest: async (url) => {
    if (url === '/view') return { viewer_id: 'me', player: { name: 'Ada', named: true }, allow_ai: true, store: [game], play: [game], your_games: [], lobby: { lines: [], looking: [] } }
    if (url.startsWith('/board')) { boardRead++; return { text: 'Board', picture: { ...active, plies: boardRead } } }
    if (failCommand) throw new Error('Gateway unavailable')
    if (refuseCommand) return { ok: false, text: 'Seat changed.' }
    return { text: 'Played 4.' }
  } }
  sandbox.pageProps = { ctx }
  function page() {
    cursor = 0
    const result = evaluate('GameCenterPage(pageProps)')
    const pendingEffects = effects; effects = []; pendingEffects.forEach(effect => effect())
    return result
  }
  page()
  await new Promise(resolve => setImmediate(resolve))
  tree = page()
  nodes(tree).find(node => node.type === 'button' && words(node).includes('Connect Four')).props.onClick()
  tree = page()
  uniqueControlNames(tree, 'the Games page')
  const room = nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'PlayTable')
  assert.ok(room)
  const beforeRead = boardRead
  const answer = await room.props.send('connect4 step')
  assert.equal(answer.ok, true, 'send reports transport success')
  assert.ok(answer.picture.plies > beforeRead, 'send resolves after an authoritative refresh')
  refuseCommand = true
  assert.equal((await room.props.send('connect4 step')).ok, false, 'successful board refresh must not erase a command refusal')
  assert.equal((await room.props.playMove('connect4', '4')).ok, false, 'successful refresh must not erase a move refusal')
  refuseCommand = false
  failCommand = true
  const failed = await room.props.send('connect4 resign')
  assert.equal(failed.ok, false, 'transport errors cannot look like successful consent')
  assert.ok(failed.text.includes('Gateway unavailable'))
  const failedMove = await room.props.playMove('connect4', '4')
  assert.equal(failedMove.ok, false)
  reset()
  console.log('command transport: passed')
  await accessibilityContract()
}
async function staleResponseContract() {
  reset()
  sandbox.setInterval = () => 1
  sandbox.clearInterval = () => {}
  const activeA = { ...active, view: 'connect4', game: 'connect4', plies: 1, table_id: 'a', legal: ['1'] }
  const activeB = { ...active, view: 'reversi', game: 'reversi', plies: 9, table_id: 'b', legal: ['d3'] }
  const games = [
    { id: 'connect4', title: 'Connect Four', kind: 'table', installed: true },
    { id: 'reversi', title: 'Reversi', kind: 'table', installed: true }
  ]
  let resolveA
  const boardA = new Promise(resolve => { resolveA = resolve })
  const ctx = { rest: async url => {
    if (url === '/view') return { viewer_id: 'me', player: { name: 'Ada', named: true }, allow_ai: true, store: games, play: games, your_games: [], lobby: { lines: [], looking: [] } }
    if (url.startsWith('/board?game=connect4')) return boardA
    if (url.startsWith('/board?game=reversi')) return { text: '', picture: activeB }
    return { text: '', picture: null }
  } }
  sandbox.pageProps = { ctx }
  function page() {
    cursor = 0
    const result = evaluate('GameCenterPage(pageProps)')
    const pending = effects; effects = []; pending.forEach(effect => effect())
    return result
  }
  page()
  await new Promise(r => setImmediate(r))
  page()
  await new Promise(r => setImmediate(r))
  const tree = page()
  const reversiTile = nodes(tree).find(node =>
    node.type === 'button' && node.props && node.props.type === 'button'
    && words(node).includes('Reversi') && typeof node.props.onClick === 'function')
  assert.ok(reversiTile, 'Reversi tile is shown in the library')
  reversiTile.props.onClick()
  page()
  await new Promise(r => setImmediate(r))
  resolveA({ text: '', picture: activeA })
  await new Promise(r => setImmediate(r))
  const settled = page()
  const liveBoards = nodes(settled).filter(node =>
    typeof node.type === 'function' && node.type.name === 'BoardSvg'
    && node.props.picture && node.props.picture.table_id)
  assert.equal(liveBoards.filter(node => node.props.picture.table_id === 'a').length, 0,
    'a stale connect4 response must not render under reversi')
  const roomNode = nodes(settled).find(node => typeof node.type === 'function' && node.type.name === 'PlayTable')
  assert.ok(roomNode, 'the game screen opens for the chosen game')
  const live = roomNode.props.board && roomNode.props.board.picture
  assert.notEqual(live && live.table_id, 'a', 'a stale connect4 response must not reach the game screen')
  assert.equal(live && live.table_id, 'b', 'the reversi board is on the game screen after the switch')
  reset()
  console.log('stale board response: passed')
  await reviewContract()
}
async function reviewContract() {
  reset()
  props.view = { viewer_id: 'me', player: { name: 'Ada' }, allow_ai: true }
  const finished = {
    ...active, status: 'win', winner: 'white', game: 'connect4', view: 'connect4',
    seats: [
      { side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false },
      { side: 'black', kind: 'local', name: 'Local', open: false }
    ],
    rematch: { requested_by: [] }
  }
  props.board.picture = finished
  props.send = async line => { calls.push(line); return { text: 'OK' } }
  tree = render()
  assert.ok(findButton(tree, 'Rematch'), 'a finished game still offers the rematch verb')
  const review = findButton(tree, 'Review my game')
  assert.ok(review, 'a finished game against the computer offers Review my game')
  review.props.onClick()
  tree = render()
  assert.equal(calls.at(-1), 'connect4 review', 'the review button asks the table for a review')
  await new Promise(resolve => setImmediate(resolve))
  reset()
  props.board.picture = { ...finished, status: 'active', turn: 'white', winner: '' }
  tree = render()
  assert.equal(findButton(tree, 'Review my game'), undefined, 'no review while the game is still being played')
  reset()
  props.board.picture = { ...finished, seats: [
    { side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false },
    { side: 'black', kind: 'human', id: 'bea', name: 'Bea', open: false }
  ] }
  tree = render()
  assert.equal(findButton(tree, 'Review my game'), undefined, 'never a review for two people at one table')
  assert.ok(findButton(tree, 'Rematch'))
  reset()
  props.board.picture = { ...finished, seats: [
    { side: 'white', kind: 'local', name: 'Local', open: false },
    { side: 'black', kind: 'human', id: 'me', name: 'Ada', open: false }
  ] }
  tree = render()
  assert.ok(findButton(tree, 'Review my game'), 'the person who played black can review too')
  reset()
  // The review itself is a one-step lesson; after it passes the page offers Rematch.
  props.board.picture = {
    ...finished, status: 'lesson_done', winner: '', turn: 'white',
    lesson: { step: 1, of: 1, say: 'You had a winning move this turn.', note: 'That is the one.', custom: { say: 'You had a winning move this turn.' } }
  }
  tree = render()
  assert.ok(words(tree).includes('Your game, one move at a time'), 'the review is not labelled as one of the lessons')
  assert.ok(words(tree).includes('You had a winning move this turn.'))
  assert.equal(findButton(tree, 'Start this step again'), undefined, 'a review has no lesson step to restart')
  assert.equal(findButton(tree, 'Next step'), undefined)
  const panel = nodes(tree).find(node => node.props['aria-label'] === 'Review of your game')
  assert.ok(panel, 'the review uses the lesson panel')
  assert.ok(!words(panel).includes('Play the computer'), 'a finished review does not send you to a lesson')
  const again = findButton(tree, 'Rematch')
  assert.ok(again, 'after the review step passes, offer Rematch')
  again.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.at(-1), 'connect4 rematch', 'Rematch asks the table to rematch the game it remembers')
  assert.ok(!calls.some(line => String(line).startsWith('allow-ai connect4 white=human')),
    'a rematch after a review must not rebuild the seats and reset the series')
  reset()
  // A game against your own agent keeps that opponent, not the built-in player.
  props.board.picture = { ...finished, seats: [
    { side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false },
    { side: 'black', kind: 'agent', name: 'Your agent', open: false }
  ] }
  tree = render()
  const agentReview = findButton(tree, 'Review my game')
  assert.ok(agentReview, 'a game against your own agent can be reviewed')
  agentReview.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  props.board.picture = {
    ...finished, status: 'lesson_done', winner: '',
    lesson: { step: 1, of: 1, say: 'You had a winning move this turn.', custom: { say: 'You had a winning move this turn.' } }
  }
  tree = render()
  findButton(tree, 'Rematch').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.at(-1), 'connect4 rematch', 'Rematch keeps the opponent you just reviewed')
  reset()
  // Pass-and-play: one person holds both seats, so the result names the side that won.
  props.board.picture = { ...finished, winner: 'black', seats: [
    { side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false },
    { side: 'black', kind: 'human', id: 'me', name: 'Ada', open: false }
  ] }
  tree = render()
  assert.ok(words(tree).includes('Black wins.'), 'a shared-keyboard game names the side that won')
  assert.ok(!words(tree).includes('You win!'), 'pass-and-play never hands the win to whoever is looking')
  reset()
  console.log('review my game: passed')
}
async function accessibilityContract() {
  props.view = { viewer_id: 'me', player: { name: 'Ada' }, allow_ai: true }
  props.board.picture = { ...active, game: 'connect4', view: 'connect4', legal: ['1', '2'], last: '2', last_to: { row: 5, col: 1 } }
  tree = render()
  const select = nodes(tree).find(node => node.type === 'select' && node.props['aria-label'] === 'Legal move')
  assert.ok(select, 'keyboard players can choose a server-provided legal move')
  select.props.onChange({ target: { value: '2' } })
  tree = render()
  findButton(tree, 'Play move').props.onClick()
  assert.deepEqual(calls.at(-1), ['connect4', '2'])
  reset()
  props.board.picture.permissions = { can_move: false }
  tree = render()
  assert.ok(findButton(tree, 'Play move').props.disabled)
  reset()
  // A repeating Connect Four column is a new ply, not a duplicate animation.
  Object.assign(sandbox.window, { matchMedia: () => ({ matches: false }) })
  sandbox.performance = { now: () => 0 }
  let regularFrames = 0
  sandbox.requestAnimationFrame = () => { regularFrames++; return regularFrames }
  sandbox.cancelAnimationFrame = () => {}
  sandbox.boardProps = { picture: { ...props.board.picture, plies: 1 }, interactive: false }
  function boardRender() {
    cursor = 0
    const result = evaluate('BoardSvg(boardProps)')
    const pendingEffects = effects; effects = []; pendingEffects.forEach(effect => effect())
    return result
  }
  boardRender()
  sandbox.boardProps.picture = { ...sandbox.boardProps.picture, plies: 2, last_to: { row: 4, col: 1 } }
  boardRender()
  assert.equal(regularFrames, 2, 'same-column consecutive drops each animate')
  reset()
  Object.assign(sandbox.window, { matchMedia: () => ({ matches: true }) })
  sandbox.performance = { now: () => 0 }
  let frames = 0
  sandbox.requestAnimationFrame = () => { frames++; return 1 }
  sandbox.cancelAnimationFrame = () => {}
  sandbox.boardProps = { picture: props.board.picture, height: 560, interactive: false }
  cursor = 0
  const stage = evaluate('BoardSvg(boardProps)')
  const pendingEffects = effects; effects = []; pendingEffects.forEach(effect => effect())
  assert.equal(frames, 0, 'reduced-motion users do not receive frame animation')
  const svg = nodes(stage).find(node => node.type === 'svg')
  assert.ok(svg, 'the board is drawn by an svg inside its stage')
  assert.equal(svg.props.role, 'img')
  assert.ok(svg.props['aria-label'].includes('connect4'))
  assert.ok(source.includes('@media') && source.includes('games-center-layout'), 'small panes stack the lobby rather than crushing the table')
  reset()
  // Your games cards: an experiment another plugin installed is visible and locked - it can open
  // nothing, by press or by key (owner's ask 2026-11-10, #7).
  const opened = []
  sandbox.yourItem = { id: 'hello', title: 'Hello', summary: 'Says hi.', plugin: 'fake-game', opens: 'screen', desktop_route: '/hello' }
  sandbox.yourOpen = async card => { opened.push(card.desktop_route); return '' }
  sandbox.yourProps = { item: sandbox.yourItem, onOpen: sandbox.yourOpen }
  let yourCard = evaluate('YourGameCard(yourProps)')
  assert.ok(words(yourCard).includes('🔒 Coming soon'), 'an installed experiment wears the lock badge')
  assert.equal(yourCard.props['aria-disabled'], 'true', 'and is announced as disabled')
  assert.ok(words(yourCard).includes('From fake-game'), 'and still says where it came from')
  assert.equal(nodes(yourCard).filter(node => node.props && typeof node.props.onClick === 'function').length, 0,
    'the card carries no open handler at all')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(opened, [], 'nothing asked for that game\'s own screen')
  // A locked card is not a dead end: the plugin it came from is still named, so the person can ask
  // about it in chat and open it there.
  console.log('external plugin cards: locked, and still named: passed')
  // Community shelf: link-out cards only. Open hands one https address to the system browser
  // and never loads, frames or navigates to the site inside Hermes.
  const launch = [], navigated = []
  sandbox.host = { navigate: url => navigated.push(url) }
  sandbox.communityCtx = { os: { openExternal: async url => { launch.push(url); return true } } }
  sandbox.communityView = {
    notice: 'These games are made by the community, not by Game Center or Nous.',
    games: [
      { id: 'nous-hermes-arcade', title: 'Nous Hermes Arcade', creator: '123mikeyd', url: 'https://hermesarcade.123mikeyd.com/' },
      { id: 'roo-gang', title: 'ROO GANG', creator: 'mojomast', url: 'https://slophero.vercel.app/' }
    ],
    problems: []
  }
  sandbox.communityProps = { community: sandbox.communityView, ctx: sandbox.communityCtx }
  function communityRender() {
    cursor = 0
    const tree = evaluate('CommunityShelf(communityProps)')
    const pending = effects; effects = []; pending.forEach(effect => effect())
    return tree
  }
  reset()
  let shelf = communityRender()
  assert.ok(words(shelf).includes('Community'), 'the section is labelled Community')
  assert.ok(words(shelf).includes('not by Game Center or Nous'), 'the shelf says these games are not ours')
  assert.ok(words(shelf).includes('Nous Hermes Arcade') && words(shelf).includes('123mikeyd'), 'a card names the game and its creator')
  assert.ok(words(shelf).includes('Made by the community; opens in your browser'), 'each card says what Open does')
  const communityOpens = nodes(shelf).filter(node => node.type === 'button' && words(node) === 'Open')
  assert.equal(communityOpens.length, 2, 'every community card has its own Open')
  communityOpens[1].props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(launch, ['https://slophero.vercel.app/'], 'Open asks the system browser for exactly that address')
  assert.deepEqual(navigated, [], 'Open never navigates the plugin host')
  // When the browser cannot be reached, the shelf itself says so, on the shelf.
  sandbox.communityProps.ctx = { os: { openExternal: async () => false } }
  shelf = communityRender()
  findButton(shelf, 'Open').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  shelf = communityRender()
  assert.ok(words(shelf).includes('Could not open https://hermesarcade.123mikeyd.com/ in your browser.'), 'a failed open says so where the person pressed it')
  // A skipped entry keeps a friendly note, and an empty shelf still says whose games it is not.
  reset()
  sandbox.communityProps = { community: { notice: '', games: [], problems: ['Plain HTTP: the web address must start with https://; skipped.'] }, ctx: sandbox.communityCtx }
  shelf = communityRender()
  assert.ok(words(shelf).includes('must start with https://'), 'a skipped entry keeps a friendly note')
  assert.ok(words(shelf).includes('Not part of Game Center or Nous'), 'even an empty shelf says whose games it is not')
  assert.equal(nodes(shelf).filter(node => node.type === 'button' && words(node) === 'Open').length, 0, 'no card, no Open')
  // The page refuses a non-https address even if a bad list slips through.
  reset()
  sandbox.communityProps = { community: { notice: '', games: [{ id: 'sneaky', title: 'Sneaky', creator: 'Someone', url: 'file:///etc/passwd' }], problems: [] }, ctx: sandbox.communityCtx }
  shelf = communityRender()
  findButton(shelf, 'Open').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  shelf = communityRender()
  assert.deepEqual(launch, ['https://slophero.vercel.app/'], 'a non-https address is never handed to the browser')
  assert.ok(words(shelf).includes('not a web address'), 'the person hears why nothing opened')
  assert.ok(!/iframe/i.test(source), 'no community card is embedded in the page')
  console.log('community shelf link-out cards: passed')
  console.log('keyboard play, reduced motion, responsive layout: passed')
  await doctrineContract()
}
// Doctrine Arena: the card must mount a battle view and animate a recorded replay.
function arena() {
  const picture = {
    view: 'arena',
    game: 'doctrine-arena',
    battle_id: 'battle-1',
    preview: false,
    duration: 0.4,
    arena: { w: 960, h: 600 },
    combatants: [
      { seat: 0, name: 'Bulwark', colour: '#7ec8ff' },
      { seat: 1, name: 'Skirmisher', colour: '#ff9f6e' }
    ],
    frames: [
      [0, [[200, 300, 0, 0, 88], [700, 300, 180, 180, 88]], []],
      [0.2, [[250, 300, 0, 0, 60], [650, 300, 180, 180, 88]], [[300, 300, 0]]],
      [0.4, [[300, 300, 0, 0, 0], [600, 300, 180, 180, 70]], []]
    ],
    events: [
      { t: 0.2, kind: 'hit', by: 0, on: 1, x: 650, y: 300, damage: 4 },
      { t: 0.4, kind: 'kill', by: 1, on: 0 }
    ],
    result: { winner: 1, reason: 'destroyed', kills: [0, 1], damage: [4, 40], hp: [0, 70] }
  }
  const ops = []
  const ctx = { canvas: null }
  for (const name of ['clearRect', 'fillRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'fill', 'stroke', 'save', 'restore', 'translate', 'rotate', 'quadraticCurveTo', 'strokeRect', 'setLineDash', 'roundRect']) {
    ctx[name] = (...args) => ops.push([name, ...args])
  }
  const realUseRef = sandbox.useRef
  sandbox.useRef = initial => ({ current: initial || { getContext: () => ctx, width: 0, height: 0 } })
  const queued = []
  sandbox.requestAnimationFrame = callback => { queued.push(callback); return queued.length }
  sandbox.cancelAnimationFrame = () => {}
  sandbox.arenaProps = { picture, height: 360 }
  reset()
  cursor = 0
  let tree = evaluate('ArenaStage(arenaProps)')
  let pending = effects
  effects = []
  pending.forEach(effect => effect())
  assert.ok(ops.length > 0, 'the arena paints on its canvas')
  assert.ok(ops.some(op => op[0] === 'arc'), 'tanks, hits and bullets are drawn with arcs')
  assert.ok(findButton(tree, 'Replay'), 'a finished battle offers Replay')
  assert.equal(nodes(tree).filter(node => node.type === 'canvas').length, 1, 'one canvas per arena card')
  let at = 0
  // The arena opens with a 3-2-1 countdown before replay time zero, so the driver needs
  // enough ticks to cover the countdown, the battle and the result hold.
  for (let guard = 0; guard < 220 && queued.length; guard += 1) {
    const callback = queued.shift()
    at += 40
    callback(at)
  }
  cursor = 0
  tree = evaluate('ArenaStage(arenaProps)')
  assert.ok(words(tree).includes('Skirmisher wins'), 'the winner is named once the replay ends: ' + words(tree))
  sandbox.useRef = realUseRef
  reset()
  console.log('doctrine arena mount and replay playback: passed')
}
arena()

async function doctrineContract() {
  const cells = Array.from({ length: 11 }, () => Array.from({ length: 11 }, () => '.'))
  cells[2][1] = '1'
  cells[8][9] = '2'
  const frames = [
    { turn: 1, actor: 'p1', name: 'Iron Vanguard', board: cells, units: { p1: [{ id: 'p1u1', hp: 3, pos: 'b3' }], p2: [{ id: 'p2u1', hp: 3, pos: 'j9' }] }, scores: { p1: 0, p2: 0 }, beacons: { p1: 0, p2: 0 }, events: ['Turn 1: Iron Vanguard moved to b3.'], actions: [] },
    { turn: 2, actor: 'p2', name: 'Stone Bastion', board: cells, units: { p1: [{ id: 'p1u1', hp: 2, pos: 'b3' }], p2: [{ id: 'p2u1', hp: 3, pos: 'j9' }] }, scores: { p1: 1, p2: 0 }, beacons: { p1: 1, p2: 0 }, events: ['Turn 2: Stone Bastion controls beacon f6.'], actions: [] }
  ]
  const house = [
    { id: 'iron-vanguard', name: 'Iron Vanguard', personality: 'x' },
    { id: 'stone-bastion', name: 'Stone Bastion', personality: 'y' },
    { id: 'glass-swarm', name: 'Glass Swarm', personality: 'z' },
    { id: 'long-game', name: 'Long Game', personality: 'w' }
  ]
  const doctrine = {
    mode: 'watch', status: 'won', id: 'match-1', seed: 7, turn: 2, max_turns: 96, frame_count: 2, frames,
    scoreboard: [
      { id: 'p1', name: 'Iron Vanguard', units: 2, hp: 6, beacons: 0, score: 1, you: false },
      { id: 'p2', name: 'Stone Bastion', units: 2, hp: 6, beacons: 0, score: 0, you: false }
    ],
    can_move: false, legal_units: {}, sentence: '', events: [], result: ['Iron Vanguard wins 1-0 after 2 turns.'],
    your_card: { name: 'Glass Swarm' }, card_json: '{"schema":"doctrine-card/1"}', house,
    improve_ready: false, improve_note: 'Improve needs one model. Pick one in Settings → Models → "Game Shelf Opponent".',
    tree: '', ladder: [], pending: {}, notice: ''
  }
  const docCalls = []
  sandbox.docProps = {
    game: { id: 'doctrine', title: 'Doctrine', installed: true, bots: true },
    view: { player: { id: 'me' }, allow_ai: true },
    board: { picture: { view: 'hex', game: 'doctrine', cells, legal: [], doctrine } },
    send: async line => { docCalls.push(line); return { text: 'OK' } },
    playMove: async (id, token) => { docCalls.push([id, token]) },
    importText: async text => { docCalls.push(['import', text]); return { ok: true, text: 'Imported.' } },
    refresh: async () => ({ ok: true }),
    onBack: () => docCalls.push('back')
  }
  function doctrineRender() {
    cursor = 0
    const out = evaluate('DoctrinePanel(docProps)')
    const pendingEffects = effects
    effects = []
    pendingEffects.forEach(effect => effect())
    return out
  }
  reset()
  let docTree = doctrineRender()
  uniqueControlNames(docTree, 'the Doctrine panel')
  assert.ok(words(docTree).includes('Score panel'), 'Doctrine has a score panel')
  assert.ok(words(docTree).includes('Iron Vanguard'))
  assert.ok(words(docTree).includes('Turn 1 of 2'), 'replay starts at the first turn')
  assert.ok(words(docTree).includes('moved to b3'))
  assert.ok(!words(docTree).includes('1 beacons'), 'beacon counts follow the shown turn')
  assert.ok(findButton(docTree, 'Step'), 'a replay can be stepped')
  assert.equal(findButton(docTree, 'Improve my bot').props.disabled, true, 'Improve is off with no model')
  assert.ok(String(findButton(docTree, 'Improve my bot').props.title).includes('Settings'), 'the note says where to pick a model')
  findButton(docTree, 'Step').props.onClick()
  docTree = doctrineRender()
  assert.ok(words(docTree).includes('Turn 2 of 2'), 'stepping advances the replay')
  assert.ok(words(docTree).includes('controls beacon f6'), 'key moments read as plain sentences')
  assert.ok(words(docTree).includes('1 beacons'), 'beacon counts follow the shown turn, not the final board')
  assert.ok(words(docTree).includes('Battle finished'))
  findButton(docTree, 'Watch 4').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(docCalls.includes('doctrine watch 4 seed=1'), 'watch mode asks for a 4-bot seeded match')
  assert.ok(findButton(docTree, 'Restart'))
  assert.ok(findButton(docTree, 'Auto-play'))
  assert.ok(words(docTree).includes('at the usual watch speed'))
  findButton(docTree, 'Share').props.onClick()
  docTree = doctrineRender()
  const importBox = nodes(docTree).find(node => node.type === 'textarea' && node.props['aria-label'] === 'JSON to import')
  assert.ok(importBox, 'share panel offers a JSON box')
  importBox.props.onChange({ target: { value: '{"kind":"doctrine-replay"}' } })
  docTree = doctrineRender()
  findButton(docTree, 'Import JSON').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(docCalls.some(call => Array.isArray(call) && call[0] === 'import'), 'import uses the large-file door, not one command line')
  assert.equal(findButton(docTree, 'Write a card').props.disabled, true, 'a signature is required')
  findButton(docTree, 'Hide share').props.onClick()
  docTree = doctrineRender()
  findButton(docTree, 'Card JSON').props.onClick()
  docTree = doctrineRender()
  let editor = nodes(docTree).find(node => node.type === 'textarea' && node.props['aria-label'] === 'Card JSON')
  assert.equal(editor.props.value, doctrine.card_json)
  sandbox.docProps.board.picture.doctrine = { ...doctrine, card_json: '{"schema":"doctrine-card/1","weights":"changed"}' }
  docTree = doctrineRender()
  docTree = doctrineRender()
  editor = nodes(docTree).find(node => node.type === 'textarea' && node.props['aria-label'] === 'Card JSON')
  assert.equal(editor.props.value, '{"schema":"doctrine-card/1","weights":"changed"}', 'a same-name card update refreshes the editor')
  sandbox.docProps.board.picture.doctrine = { ...doctrine, your_card: { name: 'Long Game' }, card_json: '{"name":"Long Game"}' }
  docTree = doctrineRender()
  docTree = doctrineRender()
  editor = nodes(docTree).find(node => node.type === 'textarea' && node.props['aria-label'] === 'Card JSON')
  assert.equal(editor.props.value, '{"name":"Long Game"}', 'choosing another card replaces the editor even after an edit')

  // A human turn: highlighted hexes are clickable and End turn holds the rest.
  sandbox.docProps.board.picture = {
    view: 'hex', game: 'doctrine', cells,
    legal: ['c5'], doctrine: { ...doctrine, mode: 'human', status: 'active', frames: [frames[0]], frame_count: 1, can_move: true, legal_units: { p1u1: { cells: ['c5'], can_hold: true } }, id: 'match-2', improve_ready: true, improve_note: '' }
  }
  reset()
  docTree = doctrineRender()
  const boardNode = nodes(docTree).find(node => typeof node.type === 'function' && node.type.name === 'BoardSvg')
  assert.equal(boardNode.props.interactive, true, 'your turn makes the hex board clickable')
  assert.ok(words(docTree).includes('still to move'))
  boardNode.props.onMove('c5')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(docCalls.at(-1), ['doctrine', 'c5'], 'clicking a hex submits doctrine move')
  assert.ok(findButton(docTree, 'End turn'))
  assert.ok(!findButton(docTree, 'Step'), 'a live battle is not a replay')
  assert.equal(findButton(docTree, 'Improve my bot').props.disabled, false, 'a configured model turns Improve on')
  findButton(docTree, 'Improve my bot').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(docCalls.includes('doctrine improve'))

  // "Your card" lists the person's own cards, not only the four house cards.
  const withMine = {
    ...doctrine,
    your_card: { name: 'My Card' },
    cards: [
      ...house.map(card => ({ ...card, origin: 'house', current: false })),
      { id: 'import-abc123', name: 'My Card (yours)', origin: 'yours', personality: '', current: true }
    ]
  }
  sandbox.docProps.board.picture = { ...sandbox.docProps.board.picture, doctrine: withMine }
  reset()
  docTree = doctrineRender()
  const cardSelect = nodes(docTree).find(node => node.type === 'select' && node.props['aria-label'] === 'Your card')
  const offered = [].concat(cardSelect.props.children).map(option => option.props.value)
  assert.ok(offered.includes('import-abc123'), 'the person\'s own cards are offered in Your card: ' + offered.join(','))
  assert.equal(cardSelect.props.value, 'import-abc123', 'the card in play is the one selected')
  cardSelect.props.onChange({ target: { value: 'import-abc123' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(docCalls.includes('doctrine pick import-abc123'), 'picking your own card sends its id')
  sandbox.docProps.board.picture.doctrine = doctrine
  reset()
  docTree = doctrineRender()

  // The Doctrine Play card opens the dedicated panel rather than a fake two-seat table.
  assert.ok(source.includes('DoctrinePanel') && source.includes("id === 'doctrine'"), 'the Doctrine card opens the panel')
  console.log('doctrine panel, replay stepping, human turn, improve note: passed')
}

async function ownerFeedbackContract() {
  reset()
  // 1. The Connect Four highlight follows the column under the pointer, even when the svg is
  // letterboxed inside a wide, short box (the CSS height cap does exactly that: content centred,
  // margins left and right). The old box.width arithmetic put the highlight in the wrong column.
  const element = { getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 118 }) }
  const drawn = { w: 272, h: 236 }
  const at = col => ({ clientX: 432 + (10 + col * 36 + 18) * 0.5, clientY: 109 })
  for (const col of [0, 3, 6]) {
    assert.equal(
      evaluate(`connect4Column(${JSON.stringify(at(col))}, { getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 118 }) }, ${JSON.stringify(drawn)}, 7, 36, 10)`),
      col,
      `column ${col} sits under the pointer`
    )
  }
  assert.equal(
    evaluate(`connect4Column({ clientX: 200, clientY: 109 }, { getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 118 }) }, ${JSON.stringify(drawn)}, 7, 36, 10)`),
    null,
    'the margin beside the board has no column'
  )
  sandbox.hoverPicture = { ...active, game: 'connect4', view: 'connect4', turn: 'white', legal: ['1', '2', '3', '4', '5', '6', '7'], last: '3', last_to: { row: 5, col: 2 },
    cells: Array.from({ length: 6 }, (_, row) => Array.from({ length: 7 }, (_, col) => (row === 5 && col === 2 ? 'X' : '.'))) }
  sandbox.hoverProps = { picture: sandbox.hoverPicture, height: 560, interactive: true }
  cursor = 0
  let hoverTree = evaluate('BoardSvg(hoverProps)')
  let hoverEffects = effects; effects = []; hoverEffects.forEach(effect => effect())
  const hoverSvg = nodes(hoverTree).find(node => node.type === 'svg')
  hoverSvg.props.onPointerMove({ currentTarget: element, clientX: 432 + (10 + 5 * 36 + 18) * 0.5, clientY: 109 })
  cursor = 0
  hoverTree = evaluate('BoardSvg(hoverProps)')
  const ghost = nodes(hoverTree).find(node => node.key === 'ghost')
  assert.ok(ghost, 'the hovered column is shown')
  assert.equal(ghost.props.cx, 10 + 5 * 36 + 18, 'the ghost sits over column 6, the column under the pointer')
  assert.equal(ghost.props.style.pointerEvents, 'none', 'the ghost never swallows the click')
  reset()

  // 2. A drop stays inside the board: same stage, same svg, the piece is a child circle.
  sandbox.stageProps = { picture: sandbox.hoverPicture, height: 560, interactive: true }
  function boardTree() {
    cursor = 0
    const result = evaluate('BoardSvg(stageProps)')
    const queued = effects; effects = []; queued.forEach(effect => effect())
    return result
  }
  const first = boardTree()
  assert.equal(first.props.className, 'games-board-stage')
  assert.equal(first.props.style.width, '100%')
  assert.ok(String(first.props.style.aspectRatio).includes('/'), 'the stage keeps the drawing shape')
  assert.equal(first.props.style.maxHeight, '560px')
  const firstSvg = nodes(first).find(node => node.type === 'svg')
  assert.equal(firstSvg.props.style.height, '100%')
  const plain = evaluate('renderConnect4(hoverPicture, {})')
  const dropping = evaluate('renderConnect4(hoverPicture, { falling: { col: 3, row: 5, y: 120 } })')
  assert.deepEqual([dropping.w, dropping.h], [plain.w, plain.h], 'a drop never changes the board size')
  const fallingDisc = dropping.kids.find(kid => kid.key === 'fall')
  assert.ok(fallingDisc, 'the falling piece is drawn')
  assert.ok(fallingDisc.props.cy >= 0 && fallingDisc.props.cy <= dropping.h, 'the falling piece stays inside the board')
  assert.equal(fallingDisc.props.style.pointerEvents, 'none')
  reset()

  // 3. The opponent chooser lists the computer and Your agent, with the model that will play.
  props.view = {
    viewer_id: 'me', player: { id: 'me' }, allow_ai: true,
    opponent: { model: 'deepseek-v4-flash', where: 'cloud' },
    opponents: [
      { id: 'computer', label: 'The computer', kind: 'local', levels: [], note: 'The built-in player. No model needed.', line: 'allow-ai {game} black=local' },
      { id: 'agent', label: 'Your agent', kind: 'agent', model: 'deepseek-v4-flash', where: 'cloud',
        note: 'Your own model plays one move at a time.', line: 'allow-ai {game} black=agent',
        levels: [{ label: 'Easy', line: 'allow-ai {game} black=local level=easy' }] }
    ]
  }
  props.board.picture = { ...active, status: 'idle', seats: [], owner_id: 'me', view: 'connect4', game: 'connect4' }
  props.send = async line => { calls.push(line); return { ok: true, text: 'ok' } }
  calls.length = 0
  tree = render()
  const chooser = nodes(tree).find(node => node.props['aria-label'] === 'Choose how to play')
  assert.ok(chooser, 'the table offers a clear way to start')
  assert.ok(words(chooser).includes('Play the computer'))
  assert.ok(words(chooser).includes('Play my Hermes model(s)'))
  assert.ok(words(chooser).includes('deepseek-v4-flash'), 'the model that will play is named: ' + words(chooser))
  assert.ok(words(chooser).includes('cloud'), 'and where it runs')
  const openAgent = nodes(chooser).find(node => node.type === 'button' && words(node) === 'Play my Hermes model(s)')
  assert.ok(openAgent, 'the Hermes seats can be opened')
  openAgent.props.onClick()
  const menuTree = render()
  const picked = nodes(menuTree).find(node => node.type === 'button' && words(node).startsWith('Play against a Hermes model'))
  assert.ok(picked, 'and the one-model shape is offered')
  picked.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.at(-1), 'allow-ai connect4 black=agent')
  tree = render()
  const easy = nodes(tree).find(node => node.protocol === undefined && node.type === 'span' && words(node) === 'Beginner')
  assert.ok(easy, 'a difficulty level from the backend is offered once a game reports one')
  nodes(easy).find(node => node.type === 'button').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.at(-1), 'allow-ai connect4 black=local level=beginner')
  assert.ok(words(tree).includes('Intermediate until you pick'), 'the level control says what it will remember: ' + words(tree))
  reset()

  // 4. Your agent: the person's own move is on the board at once, and the wait is named.
  props.view = { viewer_id: 'me', player: { id: 'me' }, allow_ai: true, opponent: { model: 'deepseek-v4-flash', where: 'cloud' } }
  props.board.picture = {
    ...sandbox.hoverPicture, status: 'active', turn: 'white', owner_id: 'me', table_id: 'agent-table',
    seats: [
      { side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false },
      { side: 'black', kind: 'agent', id: 'agent', name: 'Your agent', open: false }
    ]
  }
  let finishMove = () => {}
  props.playMove = (...args) => { calls.push(args); return new Promise(resolve => { finishMove = () => resolve({ ok: true, text: 'Played 4.' }) }) }
  tree = render()
  assert.ok(words(tree).includes('deepseek-v4-flash'), 'the table says which model is playing')
  let liveBoard = nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'BoardSvg')
  liveBoard.props.onPending({ view: 'connect4', col: 3, side: 'white' })
  liveBoard.props.onMove('4')
  tree = render()
  liveBoard = nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'BoardSvg')
  assert.deepEqual(liveBoard.props.pending, { view: 'connect4', col: 3, side: 'white' }, 'the person move is shown while the table answers')
  sandbox.previewPicture = sandbox.hoverPicture
  const optimistic = evaluate('pendingCells(previewPicture, { view: "connect4", col: 3, side: "white" })')
  assert.equal(optimistic[5][3], 'X', 'the person piece is on the board immediately: ' + JSON.stringify(optimistic[5]))
  assert.ok(words(tree).includes('Hermes is thinking… 0s'), 'a wait is never silent, and it counts: ' + words(tree))
  assert.ok(words(tree).includes('deepseek-v4-flash'), 'the table still names the model that is playing (the vs chip)')
  assert.equal(
    evaluate("waitingLine({ kind: 'move', token: '4' }, { kind: 'agent', name: 'Your agent' })"),
    'You played 4. Hermes is thinking…'
  )
  assert.equal(
    evaluate("waitingLine({ kind: 'hint' }, { kind: 'agent', name: 'Your agent' })"),
    'Hermes is thinking about a hint…'
  )
  finishMove()
  await new Promise(resolve => setImmediate(resolve))
  tree = render()
  liveBoard = nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'BoardSvg')
  assert.equal(liveBoard.props.pending, null, 'the preview clears when the table answers')
  // The fallback note: the built-in player covered for a model that did not answer.
  props.board.picture = { ...props.board.picture, hint_ok: true }
  props.send = async line => { calls.push(line); return { ok: true, text: 'Hint: try 4. (Your agent gave no legal move; the built-in player chose.)' } }
  tree = render()
  const hintButton = findButton(tree, 'Hint')
  assert.ok(hintButton, 'the hint button is offered')
  try { hintButton.props.onClick() } catch (error) { console.error('hint click threw', error) }
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  tree = render()
  assert.ok(calls.includes('connect4 hint'), 'the hint is asked for: ' + calls.join(' | '))
  assert.ok(words(tree).includes('Hint: try 4'), 'a fallback move is said out loud: ' + words(tree))
  // The normal view never shows a raw "Played c3-b4" dump; that output lives under Advanced.
  assert.equal(evaluate("noteLine('Played e2e4.')"), '', 'raw table output stays out of the normal view')
  assert.equal(evaluate("noteLine('Hint: try 4.')"), 'Hint: try 4.')
  assert.ok(evaluate("noteLine('White played e4 (the built-in player chose for your bot.)')").includes('covered for your bot'))
  reset()
  // 5. A click that is not a move never fakes one. Picking e2 and then re-picking the knight on
  // g1 (or clicking any square that is not a target) must leave the board exactly as it was.
  reset()
  const rows = [
    ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'],
    ['p', 'p', 'p', 'p', 'p', 'p', 'p', 'p'],
    ['.', '.', '.', '.', '.', '.', '.', '.'],
    ['.', '.', '.', '.', '.', '.', '.', '.'],
    ['.', '.', '.', '.', '.', '.', '.', '.'],
    ['.', '.', '.', '.', '.', '.', '.', '.'],
    ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'],
    ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R']
  ]
  sandbox.chessPicture = {
    view: 'chess', game: 'chessboard', status: 'active', turn: 'white',
    files: 'abcdefgh', ranks: [8, 7, 6, 5, 4, 3, 2, 1],
    legal: ['e2e4', 'e2e3', 'g1f3'], cells: rows
  }
  const announced = []
  const moves = []
  sandbox.chessProps = {
    picture: sandbox.chessPicture, height: 560, interactive: true,
    onPending: move => announced.push(move), onMove: move => moves.push(move)
  }
  const square = (tree, col, row) => nodes(tree).find(
    node => node.type === 'rect' && node.props.x === 18 + col * 36 && node.props.y === 18 + row * 36
  )
  // The chess board takes pointer events, exactly like a mouse or a finger: one press and one
  // release on a square. The element reports the drawn size, so the hit test is unscaled.
  const chessBox = { left: 0, top: 0, width: 324, height: 324 }
  const pressSquare = (svgTree, col, row) => {
    const svg = nodes(svgTree).find(node => node.type === 'svg')
    const element = { getBoundingClientRect: () => chessBox }
    const clientX = 18 + col * 36 + 18
    const clientY = 18 + row * 36 + 18
    svg.props.onPointerDown({ currentTarget: element, pointerId: 1, clientX, clientY })
    svg.props.onPointerUp({ currentTarget: element, pointerId: 1, clientX, clientY })
  }
  const dragSquare = (svgTree, from, to) => {
    const svg = nodes(svgTree).find(node => node.type === 'svg')
    const element = { getBoundingClientRect: () => chessBox }
    const start = [18 + from[0] * 36 + 18, 18 + from[1] * 36 + 18]
    const end = [18 + to[0] * 36 + 18, 18 + to[1] * 36 + 18]
    svg.props.onPointerDown({ currentTarget: element, pointerId: 1, clientX: start[0], clientY: start[1] })
    for (let step = 1; step <= 4; step += 1) {
      svg.props.onPointerMove({ currentTarget: element, pointerId: 1, clientX: start[0] + (end[0] - start[0]) * step / 4, clientY: start[1] + (end[1] - start[1]) * step / 4 })
    }
    svg.props.onPointerUp({ currentTarget: element, pointerId: 1, clientX: end[0], clientY: end[1] })
  }
  const drawChess = () => {
    cursor = 0
    const result = evaluate('BoardSvg(chessProps)')
    const queued = effects; effects = []
    queued.forEach(fn => { try { fn() } catch (ignored) {} })
    return result
  }
  let chessTree = drawChess()
  pressSquare(chessTree, 4, 6)          // pick the e2 pawn
  chessTree = drawChess()
  pressSquare(chessTree, 6, 7)          // g1: a different piece, not a move
  chessTree = drawChess()
  assert.equal(announced.length, 0, 'a click that is not a move must not preview one: ' + JSON.stringify(announced))
  assert.equal(moves.length, 0)
  pressSquare(chessTree, 4, 6)          // pick e2 again
  chessTree = drawChess()
  pressSquare(chessTree, 0, 7)          // a stray square: no move, no preview
  chessTree = drawChess()
  assert.equal(announced.length, 0, 'a stray square must not preview a move: ' + JSON.stringify(announced))
  pressSquare(chessTree, 4, 6)          // pick e2
  chessTree = drawChess()
  pressSquare(chessTree, 4, 4)          // e4 is a real move
  assert.equal(JSON.stringify(announced), JSON.stringify([{ view: 'chess', from: 'e2', to: 'e4' }]), 'a real move is previewed once')
  assert.equal(JSON.stringify(moves), JSON.stringify(['e2e4']))
  // A real drag: press e2, carry it to e4, release there. Same move, no click at all.
  announced.length = 0
  moves.length = 0
  chessTree = drawChess()
  dragSquare(chessTree, [4, 6], [4, 4])
  assert.equal(JSON.stringify(moves), JSON.stringify(['e2e4']), 'dragging a piece plays the move')
  assert.equal(JSON.stringify(announced), JSON.stringify([{ view: 'chess', from: 'e2', to: 'e4' }]), 'a drag shows the move at once')
  // A drag released on a square the piece cannot reach leaves the board alone.
  announced.length = 0
  moves.length = 0
  chessTree = drawChess()
  dragSquare(chessTree, [4, 6], [0, 0])
  assert.equal(moves.length, 0, 'a drop on an illegal square returns the piece')
  // A pawn reaching the last rank asks which piece, on the board, with four pieces to press.
  sandbox.promoPicture = {
    view: 'chess', game: 'chessboard', status: 'active', turn: 'white',
    files: 'abcdefgh', ranks: [8, 7, 6, 5, 4, 3, 2, 1],
    legal: ['e7e8q', 'e7e8r', 'e7e8b', 'e7e8n'],
    cells: [['.', '.', '.', '.', '.', '.', '.', '.'], ['.', '.', '.', '.', 'P', '.', '.', '.'],
      ['.', '.', '.', '.', '.', '.', '.', '.'], ['.', '.', '.', '.', '.', '.', '.', '.'],
      ['.', '.', '.', '.', '.', '.', '.', '.'], ['.', '.', '.', '.', '.', '.', '.', '.'],
      ['.', '.', '.', '.', '.', '.', '.', '.'], ['.', '.', '.', '.', '.', '.', '.', '.']]
  }
  const promoMoves = []
  sandbox.promoProps = { picture: sandbox.promoPicture, height: 560, interactive: true, onMove: move => promoMoves.push(move) }
  const drawPromo = () => {
    cursor = 0
    const result = evaluate('BoardSvg(promoProps)')
    const queued = effects; effects = []
    queued.forEach(fn => { try { fn() } catch (ignored) {} })
    return result
  }
  let promoTtree = drawPromo()
  dragSquare(promoTtree, [4, 1], [4, 0])
  promoTtree = drawPromo()
  const picker = nodes(promoTtree).find(node => node.props['aria-label'] === 'Choose a promotion piece')
  assert.ok(picker, 'a pawn that reaches the last rank asks which piece')
  const pieces = ['Queen', 'Rook', 'Bishop', 'Knight'].map(name => nodes(picker).find(node => node.type === 'button' && node.props['aria-label'] === name))
  assert.ok(pieces.every(Boolean), 'all four pieces are offered')
  assert.equal(promoMoves.length, 0, 'nothing is played before the person picks')
  pieces[2].props.onClick()
  assert.deepEqual(promoMoves, ['e7e8b'], 'the picked piece is the move that is played')
  reset()
  console.log('owner feedback: hover offset, no board resize, opponent chooser, thinking status: passed')
}

// The chess pieces are the vendored chessnut drawings, drawn one nested svg per
// cell. Every letter must have art, and the art must not eat a click.
function pieceArtContract() {
  reset()
  const letters = ['K', 'Q', 'R', 'B', 'N', 'P', 'k', 'q', 'r', 'b', 'n', 'p']
  letters.forEach(letter => {
    const shapes = evaluate(`PIECE_ART[${JSON.stringify(letter)}]`)
    assert.ok(Array.isArray(shapes) && shapes.length > 0, 'no art for ' + letter)
    const svg = evaluate(`chessPiece(${JSON.stringify(letter)}, 0, 0, 36, 'x')`)
    assert.equal(svg.type, 'svg')
    assert.equal(svg.props.viewBox, '0 0 800 800')
    assert.equal(svg.props.children.length, shapes.length)
    assert.equal(svg.props.style.pointerEvents, 'none')
    svg.props.children.forEach(shape => {
      assert.ok(['path', 'circle', 'ellipse'].includes(shape.type), 'unexpected shape ' + shape.type)
      assert.equal(shape.props.style.pointerEvents, 'none')
    })
  })
  assert.equal(evaluate("chessPiece('Z', 0, 0, 36, 'x')"), null, 'an unknown mark draws nothing')
  const rows = [
    ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'],
    ['p', 'p', 'p', 'p', 'p', 'p', 'p', 'p'],
    ['.', '.', '.', '.', '.', '.', '.', '.'],
    ['.', '.', '.', '.', '.', '.', '.', '.'],
    ['.', '.', '.', '.', '.', '.', '.', '.'],
    ['.', '.', '.', '.', '.', '.', '.', '.'],
    ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'],
    ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R']
  ]
  sandbox.piecePicture = {
    view: 'chess', game: 'chessboard', status: 'active', turn: 'white',
    files: 'abcdefgh', ranks: [8, 7, 6, 5, 4, 3, 2, 1], legal: [], cells: rows
  }
  const tree = evaluate('BoardSvg({ picture: piecePicture, height: 560 })')
  const drawings = nodes(tree).filter(node => node.type === 'svg' && node.props.viewBox === '0 0 800 800')
  assert.equal(drawings.length, 32, 'a start position draws 32 pieces, not ' + drawings.length)
  assert.ok(drawings.every(node => node.props.x >= 18 && node.props.x + node.props.width <= 18 + 8 * 36 + 0.5),
    'every piece stays inside the board')
  reset()
  console.log('piece art: passed')
}

// The Submit button goes to the configured page, and to the guide when that page is unset.
function iaContract() {
  const target = submit => JSON.parse(JSON.stringify(evaluate(`submitTarget(${JSON.stringify(submit)})`)))
  assert.deepEqual(target({ url: 'https://games.hermesnet.xyz/submit', docs: '' }),
    { href: 'https://games.hermesnet.xyz/submit', label: 'Submit your game' }, 'the configured page wins')
  assert.deepEqual(target({ url: '', docs: 'https://example.org/guide' }),
    { href: 'https://example.org/guide', label: 'How to submit a game' }, 'an unset page falls back to the guide')
  assert.deepEqual(target({ url: 'javascript:alert(1)', docs: '' }),
    { href: '', label: 'Submit your game' }, 'only an https page is ever opened')
  assert.deepEqual(target({}), { href: '', label: 'Submit your game' }, 'no settings at all is not a crash')
  console.log('submit link: passed')
}

// First run, Settings, and the quiet "someone wants a match" alert. The page asks the
// backend for the right things and shows what came back; the backend owns the rules.
async function firstRunContract() {
  const asked = []
  const view = {
    player: { name: '', named: false },
    play: [{ id: 'connect4', title: 'Connect Four' }, { id: 'reversi', title: 'Reversi' }],
    setup: { welcome_needed: true, name: '', suggested_name: 'AmberOtter', watched: {}, paused: false, allow_ai: true, ai_choice: null },
    alerts: { ok: true, count: 0, rows: [] }
  }
  const ctx = {
    rest: async (path, options) => {
      asked.push([path, options])
      return { ok: true, text: 'Saved.', setup: { ...view.setup, welcome_needed: false }, player: { name: 'Scout', named: true } }
    }
  }
  // Each component gets its own hook slots, and every draw starts the cursor at the
  // top: that is what React does on a re-render.
  const draw = name => { cursor = 0; return evaluate(`${name}(${name === 'WelcomePanel' ? 'welcome' : name === 'SettingsPanel' ? 'settings' : name === 'AlertLine' ? 'alertProps' : 'badgeProps'})`) }

  // Values that crossed into the VM have that realm's prototypes, so compare their data.
  const plain = value => JSON.parse(JSON.stringify(value))
  // --- the welcome: one line, a name already filled in, Continue and Skip.
  reset()
  const welcome = { view, ctx, onDone: () => { asked.push(['done']) } }
  sandbox.welcome = welcome
  let tree = draw('WelcomePanel')
  const said = words(tree)
  assert.ok(said.includes('Welcome to Game Center'), 'the welcome says what it is')
  assert.ok(/board games that come with Hermes/.test(said), 'in one plain line')
  assert.ok(/No account, no email/.test(said), 'it promises no account and no email')
  assert.ok(findButton(tree, 'Continue') && findButton(tree, 'Skip for now'), 'it can be finished or skipped')
  assert.ok(said.includes('About 20 seconds'), 'the time it takes is stated')
  const nameInput = nodes(tree).find(node => node.type === 'input')
  assert.equal(nameInput.props.value, 'AmberOtter', 'a valid name is suggested, so Continue works at once')
  assert.equal(nameInput.props['aria-label'], 'Your name')

  // Continue saves the name and the games chosen, then ends the welcome.
  findButton(tree, 'Connect Four').props.onClick()
  tree = draw('WelcomePanel')
  await findButton(tree, 'Continue').props.onClick()
  const first = asked[0]
  assert.equal(first[0], '/setup')
  assert.equal(first[1].method, 'POST')
  assert.equal(first[1].body.done, true)
  assert.equal(first[1].body.name, 'AmberOtter')
  assert.deepEqual(plain(first[1].body.games), ['connect4'])
  assert.deepEqual(asked.at(-1), ['done'], 'the page moves on once it is saved')

  // Skip ends it without saving anything about the person.
  asked.length = 0
  tree = draw('WelcomePanel')
  await findButton(tree, 'Skip for now').props.onClick()
  assert.equal(asked[0][0], '/setup')
  assert.equal(asked[0][1].body.done, true)
  assert.equal('name' in asked[0][1].body, false, 'skipping asks for nothing')
  assert.equal('games' in asked[0][1].body, false)

  // A refused name keeps the welcome open and says why.
  reset()
  asked.length = 0
  const refusing = { view, onDone: () => { asked.push(['done']) }, ctx: { rest: async () => ({ ok: false, text: 'Pick a different name.' }) } }
  sandbox.refusing = refusing
  const drawRefusing = () => { cursor = 0; return evaluate('WelcomePanel(refusing)') }
  tree = drawRefusing()
  await findButton(tree, 'Continue').props.onClick()
  tree = drawRefusing()
  assert.ok(words(tree).includes('Pick a different name.'), 'a refused name is explained in place')
  assert.equal(asked.some(item => item[0] === 'done'), false, 'a refused name does not end the welcome')

  // --- Settings: the name, one switch per game (off by default), a pause, AI seats.
  reset()
  asked.length = 0
  const settingsView = {
    ...view,
    player: { name: 'AmberOtter', named: true },
    setup: { ...view.setup, welcome_needed: false, name: 'AmberOtter', watched: {} }
  }
  const settings = { view: settingsView, ctx, onBack: next => asked.push(['back', next]), onSaved: async () => {}, onReopen: () => asked.push(['reopen']) }
  sandbox.settings = settings
  tree = draw('SettingsPanel')
  const switchFor = label => nodes(tree).find(node => node.type === 'button' && node.props['aria-label'] === label)
  const connect4 = switchFor('Tell me when someone wants a match: Connect Four')
  assert.ok(connect4, 'each game has its own switch')
  assert.equal(words(connect4), 'Off', 'every switch starts off')
  assert.ok(words(tree).includes('Tell me when someone wants a match'), 'the switch says what it does')
  assert.ok(words(tree).includes('People in this Hermes and the chats it shares.'), 'the source is named, not the internet')
  await connect4.props.onClick()
  const toggled = asked.find(item => item[0] === '/settings')
  assert.deepEqual(plain(toggled[1].body), { watch: { connect4: true } }, 'a switch asks the backend to save just that game')
  assert.ok(switchFor('Pause all of these'), 'there is one global pause')
  assert.ok(switchFor('Let AI seats play here'), 'and whether AI seats may play here')

  asked.length = 0
  await findButton(tree, 'Save name').props.onClick()
  assert.deepEqual(plain(asked[0][1].body), { name: 'AmberOtter' }, 'the name is saved through the same rules')
  await switchFor('Pause all of these').props.onClick()
  await switchFor('Let AI seats play here').props.onClick()
  const bodies = asked.filter(item => item[0] === '/settings').map(item => item[1].body)
  assert.deepEqual(plain(bodies[1]), { paused: true })
  assert.deepEqual(plain(bodies[2]), { allow_ai: false })
  await findButton(tree, 'Show the welcome again').props.onClick()
  const reopened = asked.filter(item => item[0] === '/setup').at(-1)
  assert.ok(reopened, 'the welcome can be re-opened from Settings')
  assert.equal(reopened[1].body.reopen, true)
  assert.deepEqual(asked.at(-1), ['reopen'], 'and the page switches back to it')
  findButton(tree, 'Back to Game Center').props.onClick()
  assert.deepEqual(asked.at(-1), ['back', 'games'], 'Back goes to the games, not to a click event')

  // --- the version chip, at the top of Settings (owner, 2026-11-10). It is the one place the install
  // in view is drawn: not the status bar, not the Games header, not the pane's foot. Both Settings
  // views — the full screen's and the pane's — are this one panel, so both carry it.
  reset()
  const settingsStamp = { version: '9.9.9', commit: 'abcdef1234567890', commit_date: '2026-11-10T09:00:00-07:00', dirty: false }
  sandbox.chipSettings = {
    view: settingsView,
    onBack: () => {},
    onSaved: async () => {},
    ctx: { rest: async path => (path === '/v1/version' ? settingsStamp : {}) }
  }
  const drawChipPanel = () => { cursor = 0; return evaluate('SettingsPanel(chipSettings)') }
  const chipPanel = nodes(drawChipPanel())
  const versionTop = chipPanel.find(node => node.props && node.props['data-games-version-top'] === '1')
  assert.ok(versionTop, 'Settings opens with the version row at its top')
  const chipElement = nodes(versionTop).find(node => typeof node.type === 'function' && node.type.name === 'GamesVersionChip')
  assert.ok(chipElement, 'and what the row draws is the one reusable chip')
  assert.equal(chipElement.props.ctx, sandbox.chipSettings.ctx,
    'handed the Settings context — the same /v1/version source the rest of the plugin reads')
  const headingAt = chipPanel.findIndex(node => words(node).trim() === 'Game Center settings')
  assert.ok(headingAt > -1 && chipPanel.indexOf(versionTop) < headingAt,
    'above the heading: the first thing in the panel')
  assert.equal(chipPanel.filter(node => node.props && node.props['data-games-version-top'] === '1').length, 1, 'drawn once')
  assert.equal(chipPanel.some(node => node.props && node.props['data-games-version-row'] === '1'), false,
    'and it is not a masthead row like the one the Games header used to carry')

  // --- the quiet line: Join and Dismiss, never a dialog, never a focus grab.
  reset()
  assert.equal(evaluate('AlertLine({ alerts: { rows: [] }, onJoin() {}, onDismiss() {} })'), null, 'nothing is shown when nobody is looking')
  const row = { key: 'discord:9|connect4', game: 'connect4', name: 'Bea', title: 'Connect Four', where: 'bea.example:2300' }
  const picks = []
  sandbox.alertProps = { alerts: { rows: [row] }, onJoin: item => picks.push(['join', item.key]), onDismiss: item => picks.push(['dismiss', item.key]) }
  reset()
  tree = draw('AlertLine')
  assert.ok(words(tree).includes('Bea is looking for a Connect Four match at bea.example:2300.'), 'the line names the person, the game and the address they gave')
  assert.equal(nodes(tree).some(node => node.props.role === 'alertdialog'), false, 'no popup')
  assert.equal(nodes(tree).some(node => node.props.autoFocus), false, 'no focus steal')
  assert.equal(nodes(tree).some(node => node.props.role === 'alert'), false, 'nothing is shouted')
  findButton(tree, 'Join').props.onClick()
  findButton(tree, 'Dismiss').props.onClick()
  assert.deepEqual(picks, [['join', row.key], ['dismiss', row.key]])

  // Every row that is shown can be acted on, and a badge count above the list is said.
  const many = [1, 2, 3, 4].map(n => ({ key: `k${n}|connect4`, game: 'connect4', name: `P${n}`, title: 'Connect Four' }))
  sandbox.alertProps = { alerts: { rows: many, count: 6 }, onJoin() {}, onDismiss() {} }
  reset()
  tree = draw('AlertLine')
  assert.equal(nodes(tree).filter(node => node.type === 'button' && words(node) === 'Join').length, 4,
    'every listed row has its own Join')
  assert.equal(nodes(tree).filter(node => node.type === 'button' && words(node) === 'Dismiss').length, 4)
  assert.ok(words(tree).includes('2 more people are looking too'), 'the rest are named, not silently dropped')

  // --- the one Games status item: nothing to say, no item at all; one
  // actionable line the moment there is something. Polled exactly like the
  // component does it: mount, run the effect, let its fetches settle, redraw.
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))
  const seatsNow = [
    { side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false },
    { side: 'black', kind: 'local', name: 'Computer', open: false }
  ]
  const statusView = extra => ({
    player: { id: 'me', name: 'Ada', named: true },
    viewer_id: 'me',
    allow_ai: true,
    play: [
      { id: 'connect4', title: 'Connect Four', kind: 'table', installed: true },
      { id: 'hex', title: 'Hex', kind: 'table', installed: true }
    ],
    lobby: { lines: [], looking: [] },
    ...extra
  })
  let viewNow = statusView({})
  let boardNow = { text: '', picture: null }
  const storedNow = {}
  const statusCtx = {
    storage: {
      get: (key, fallback) => (key in storedNow ? storedNow[key] : fallback),
      set: (key, value) => { storedNow[key] = value }
    },
    os: { notify: () => {} },
    rest: async path => {
      if (path === '/view') return viewNow
      if (path.startsWith('/board')) return boardNow
      return {}
    }
  }
  const badgeProps = { ctx: statusCtx }
  sandbox.badgeProps = badgeProps
  const pollStatus = async () => {
    reset()
    draw('GamesStatusItem')
    const pending = effects; effects = []
    pending.forEach(effect => { const out = effect(); if (out) cleanups.push(out) })
    await tick()
    await tick()
    return draw('GamesStatusItem')
  }
  try {
    // The door (owner's ask, 2026-11-11): while the pane is off the screen the status bar
    // carries the way back, with a small game icon and its own words. The pane is set closed
    // for this block, and the news line is checked through its own hook.
    const doorItem = tree => nodes(tree).find(node => node.props && node.props['data-games-pane-door'])
    const newsItem = tree => nodes(tree).find(node => node.props && node.props['data-games-status'] === 'action')
    evaluate('WAIT_PANE_SLOT.dispose = null')
    evaluate("window.sessionStorage.removeItem('gameshelf-pane-chrome')")
    // Idle: no saved game, nobody waiting -- the door, and no news line at all.
    let badgeTree = await pollStatus()
    assert.ok(doorItem(badgeTree), 'a closed pane leaves the door in the status bar: ' + JSON.stringify(badgeTree))
    assert.equal(words(doorItem(badgeTree)).trim(), 'Play while you code', 'the door says what it does')
    assert.ok(nodes(doorItem(badgeTree)).some(node => node.props && node.props['data-games-pane-icon']),
      'and it wears a small game icon')
    assert.equal(newsItem(badgeTree), undefined, 'nothing else is said while there is nothing to say')
    doorItem(badgeTree).props.onClick()
    assert.ok(evaluate('Boolean(WAIT_PANE_SLOT.dispose)'), 'one press on the door opens the pane')
    evaluate('WAIT_PANE_SLOT.dispose = null')

    // Your turn: the pane's game is active and mine to move.
    storedNow['pane-game'] = 'connect4'
    boardNow = { text: '', picture: { table_id: 't1', view: 'connect4', seats: seatsNow, turn: 'white', status: 'active', plies: 3 } }
    badgeTree = await pollStatus()
    assert.equal(words(newsItem(badgeTree)).trim(), 'Your turn (Connect Four)', 'the turn names the game: ' + words(badgeTree))
    assert.equal(newsItem(badgeTree).props['data-games-status'], 'action', 'one actionable item')
    assert.ok(String(newsItem(badgeTree).props['aria-label']).includes('Your turn'))
    assert.ok(!newsItem(badgeTree).props.autoFocus, 'the item never takes the keyboard')

    // Match found while the board is quiet: my looking row plus someone else's.
    boardNow = { text: '', picture: null }
    viewNow = statusView({ lobby: { lines: [], looking: [{ game: 'hex', name: 'Ada' }, { game: 'hex', name: 'Bo' }] } })
    badgeTree = await pollStatus()
    assert.equal(words(newsItem(badgeTree)).trim(), 'Match found', 'a match is the headline: ' + words(badgeTree))

    // People waiting for a game I asked to hear about, no match of my own.
    storedNow['pane-alerts'] = { paused: false, games: { hex: true } }
    viewNow = statusView({ lobby: { lines: [], looking: [{ game: 'hex', name: 'Bo' }, { game: 'hex', name: 'Cy' }, { game: 'hex', name: 'Al' }] } })
    badgeTree = await pollStatus()
    assert.equal(words(newsItem(badgeTree)).trim(), '3 looking for Hex', 'opted-in crowd counts are spoken: ' + words(badgeTree))

    // Quiet again: the door stands, the news line is gone.
    viewNow = statusView({})
    badgeTree = await pollStatus()
    assert.ok(doorItem(badgeTree), 'quiet again means no news line')
    assert.equal(newsItem(badgeTree), undefined, 'and nothing but the door is left')
  } finally {
    reset()
  }
  console.log('first run, settings and quiet alerts: passed')
}

// Play while you code: the pane beside the chat. The board is BoardSvg, the same
// component the full table draws; the computer is the default opponent; the game
// is remembered; the agent line is driven by the SDK's busy atom and its events.
async function paneContract() {
  const play = [
    { id: 'connect4', title: 'Connect Four', kind: 'table', installed: true, bots: true },
    { id: 'reversi', title: 'Reversi', kind: 'table', installed: true, bots: true },
    { id: 'gomoku', title: 'Gomoku', kind: 'table', installed: true, bots: true },
    { id: 'breakthrough', title: 'Breakthrough', kind: 'table', installed: true, bots: true },
    { id: 'chessboard', title: 'Chess', kind: 'table', installed: true, bots: true },
    { id: 'doom', title: 'Doom', kind: 'play', installed: true, bots: false }
  ]
  const view = {
    player: { id: 'me', name: 'Ada', named: true },
    viewer_id: 'me',
    allow_ai: true,
    play,
    lobby: { lines: [], looking: [] }
  }
  const seats = [
    { side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false },
    { side: 'black', kind: 'local', name: 'Computer', open: false }
  ]
  const picture = { ...active, table_id: 't1', view: 'connect4', seats, turn: 'white', status: 'active' }
  let boardPicture = picture

  // The routes this Hermes has, as GET /models answers them: the pane hands these straight to the
  // shared ModelPicker (50-model-picker.js), so the search and the grouping are the same here.
  const PANE_MODEL_ROUTES = [
    { id: 'hermes-4|nous', label: 'Hermes 4', model: 'hermes-4', provider: 'nous', where: 'cloud' },
    { id: 'llama-3|groq', label: 'Llama 3', model: 'llama-3', provider: 'groq', where: 'cloud' }
  ]

  const makeCtx = (saved = {}) => {
    const asked = []
    const stored = { ...saved }
    const ctx = {
      storage: {
        get: (key, fallback) => (key in stored ? stored[key] : fallback),
        set: (key, value) => { stored[key] = value },
        remove: key => { delete stored[key] }
      },
      os: { notify: input => { ctx.notified.push(input) } },
      notified: [],
      actions: [],
      runAction: id => { ctx.actions.push(id); return { ok: true } },
      rest: async (path, options) => {
        asked.push(options && options.body ? options.body.line : path)
        if (path === '/view') return view
        if (path === '/models') return { ok: true, routes: PANE_MODEL_ROUTES, current: PANE_MODEL_ROUTES[0].id }
        if (path.startsWith('/board')) return { text: '', picture: boardPicture }
        if (path === '/command') return { text: 'OK', ok: true }
        return {}
      }
    }
    return { ctx, asked, stored }
  }

  const draw = (expression, value) => {
    sandbox.paneProps = value
    cursor = 0
    const tree = evaluate(expression)
    const pending = effects
    effects = []
    pending.forEach(effect => effect())
    return tree
  }
  // A tile in the pane's own game row (the quick game row has the same words).
  const paneTile = (tree, title) => {
    const group = nodes(tree).find(node => node.type === 'div' && node.props.role === 'group' && node.props['aria-label'] === 'Game')
    return nodes(group).find(node => node.type === 'button' && words(node) === title)
  }

  // The reversi tile, however deep the pane nests it.
  const gameTile = (tree, id) => nodes(tree).find(node => node.props && node.props['data-game-tile'] === id)

  // The status item's two faces, each found by its own hook: the door that opens the pane
  // (owner's ask, 2026-11-11) and the news line that needs saying.
  const statusDoor = tree => nodes(tree).find(node => node.props && node.props['data-games-pane-door'])
  const statusNews = tree => nodes(tree).find(node => node.props && node.props['data-games-status'] === 'action')

  // The four quick games the owner named, as tiles; and NOTHING is dealt until the person names an
  // opponent in the one door under the board (owner's ask, 2026-11-11).
  assert.equal(evaluate("quickGameLine('connect4')"), 'allow-ai connect4 black=local level=intermediate')
  assert.equal(evaluate("quickGameLine('gomoku', 'agent')"), 'allow-ai gomoku black=agent level=intermediate')
  reset()
  const first = makeCtx()
  let tree = draw('WaitPane(paneProps)', { ctx: first.ctx })
  await new Promise(resolve => setTimeout(resolve, 0))
  tree = draw('WaitPane(paneProps)', { ctx: first.ctx })
  ;['Connect Four', 'Reversi', 'Gomoku', 'Breakthrough'].forEach(label => {
    assert.ok(findButton(tree, label), `quick game ${label} is one click`)
  })
  assert.equal(findButton(tree, 'Doom'), undefined, 'a real-time game stays in the full screen')
  // A tile PICKS the game. It deals nothing, and it never picks an opponent for the person.
  const quick = findButton(tree, 'Connect Four')
  await quick.props.onClick()
  tree = draw('WaitPane(paneProps)', { ctx: first.ctx })
  assert.equal(first.asked.filter(line => typeof line === 'string' && line.startsWith('allow-ai')).length, 0,
    'picking a game tile deals nothing')
  assert.equal(first.stored['pane-game'], 'connect4', 'the pane remembers the game')
  const drawn = nodes(tree).find(node => node.type && node.type.name === 'BoardSvg')
  assert.ok(drawn, 'the pane draws the same board component as the full table')
  assert.equal(drawn.props.height, 300, 'the board is sized for the pane')
  assert.equal(drawn.props.interactive, true, 'a person can move in the pane')
  // The one door to a new game, on a table that is already playing: Start over.
  const door = findButton(tree, 'Start over')
  assert.ok(door, 'an active game offers one door to a new one')
  assert.equal(findButton(tree, 'New game vs computer'), undefined, 'never a button that assumes the computer')
  assert.equal(findButton(tree, 'Play my Hermes model'), undefined, 'nor one that assumes the model')
  door.props.onClick()
  tree = draw('WaitPane(paneProps)', { ctx: first.ctx })
  const radios = nodes(tree).filter(node => node.type === 'input' && node.props.type === 'radio')
  assert.equal(radios.length, 2, 'the dialog offers both opponents as radios')
  assert.deepEqual(radios.map(node => node.props.checked), [false, false], 'and NOTHING is picked for the person')
  const startDeal = findButton(tree, 'Start')
  assert.ok(startDeal, 'the dialog has a Start')
  assert.equal(startDeal.props.disabled, true, 'which is disabled until an opponent is picked')
  assert.equal(nodes(tree).some(node => node.props && node.props['data-level']), false,
    'and no strength row is offered before the computer is picked')
  // Cancel keeps the game exactly as it is: nothing is sent, and the table is still on the board.
  findButton(tree, 'Cancel').props.onClick()
  tree = draw('WaitPane(paneProps)', { ctx: first.ctx })
  assert.equal(first.asked.filter(line => typeof line === 'string' && (line.startsWith('allow-ai') || line.startsWith('connect4'))).length, 0,
    'Cancel sends nothing: the game is kept')
  // Picking the Computer shows the strength row - and a strength press ONLY sets the strength.
  findButton(tree, 'Start over').props.onClick()
  tree = draw('WaitPane(paneProps)', { ctx: first.ctx })
  nodes(tree).find(node => node.props && node.props['data-deal-choice'] === 'computer').props.onChange()
  tree = draw('WaitPane(paneProps)', { ctx: first.ctx })
  const levelButton = findButton(tree, 'Intermediate')
  assert.ok(levelButton, 'the four strengths are plain buttons, for the computer choice')
  assert.equal(findButton(tree, 'Start').props.disabled, false, 'with the computer picked, Start is live')
  await levelButton.props.onClick()
  tree = draw('WaitPane(paneProps)', { ctx: first.ctx })
  assert.equal(first.asked.filter(line => typeof line === 'string' && line.startsWith('allow-ai')).length, 0,
    'a strength press sets the strength and deals nothing')
  // ... and Start deals against the computer at the strength just picked.
  await findButton(tree, 'Start').props.onClick()
  tree = draw('WaitPane(paneProps)', { ctx: first.ctx })
  const dealtLines = first.asked.filter(line => typeof line === 'string' && (line.startsWith('allow-ai') || line.startsWith('connect4')))
  assert.deepEqual(dealtLines, ['connect4 resign', 'allow-ai connect4 black=local level=intermediate'],
    'Start resigns the old game and deals a fresh one against the computer, at the chosen strength')
  assert.equal(findButton(tree, 'Start'), undefined, 'and the dialog closes')

  // The thinking line in the pane, with the seconds ticking: the moment the board says a Hermes
  // model's seat is to move, the pane says so and counts - and it never claims the built-in
  // computer is working when nothing of ours is out (owner's ask, 2026-11-11).
  reset()
  boardPicture = { ...picture, turn: 'black', permissions: { can_move: false }, seats: [
    { side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false },
    { side: 'black', kind: 'agent', id: 'agent', name: 'Your agent', open: false }
  ] }
  const thinkCtx = makeCtx({ 'pane-game': 'connect4' })
  // Other contracts stub the interval out, so this check puts the real clock back for its own two
  // renders, and puts the stub back afterwards. reset() inside the block runs the effects'
  // cleanups, so no timer is left ticking past it.
  const clock = { interval: sandbox.setInterval, clear: sandbox.clearInterval }
  sandbox.setInterval = setInterval
  sandbox.clearInterval = clearInterval
  try {
    // The board arrives on its own poll, so draw until the pane is on the model's board - that is
    // the render the clock starts from.
    let shown = ''
    let opened = ''
    for (let attempt = 0; attempt < 5 && !shown; attempt += 1) {
      tree = draw('WaitPane(paneProps)', { ctx: thinkCtx.ctx })
      opened = words(tree)
      shown = opened.includes('Hermes is thinking…') ? opened : ''
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    assert.ok(shown, 'the pane is on the model seat\'s board: ' + opened.slice(0, 220))
    assert.ok(shown.includes('Hermes is thinking… 0s'), 'the pane names the model seat, and its clock starts at zero: ' + shown.slice(0, 220))
    // ... and it keeps counting while the model works.
    await new Promise(resolve => setTimeout(resolve, 1500))
    tree = draw('WaitPane(paneProps)', { ctx: thinkCtx.ctx })
    const ticked = String((words(tree).match(/Hermes is thinking… \d+s/) || [''])[0])
    assert.ok(ticked && !ticked.endsWith('0s'), 'and the seconds tick while the model works: ' + (ticked || words(tree).slice(0, 220)))
  } finally {
    reset()
    sandbox.setInterval = clock.interval
    sandbox.clearInterval = clock.clear
  }
  // The same three cases as pure words, so the pane and the page cannot drift apart.
  const wordsFor = (seats, turn, opts) => evaluate(`waitWords(${JSON.stringify({ status: 'active', turn, seats })}, ${JSON.stringify(view)}, ${JSON.stringify(opts || {})})`)
  const human = { side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false }
  assert.equal(wordsFor([human, { side: 'black', kind: 'local', id: 'local', name: 'Local' }], 'black'), 'Waiting for the computer…',
    'a computer seat on move, with nothing of ours out, is not thinking')
  assert.equal(wordsFor([human, { side: 'black', kind: 'local', id: 'local', name: 'Local' }], 'black', { working: true }), 'Computer is thinking…',
    'a computer reply actually in flight is')
  assert.equal(wordsFor([human, { side: 'black', kind: 'agent', id: 'agent', name: 'Your agent' }], 'black'), 'Hermes is thinking…',
    'a model seat is a wait as soon as it is its turn')
  assert.equal(wordsFor([human, { side: 'black', kind: 'human', id: 'bea', name: 'Bea', open: false }], 'black'), 'Waiting for Bea…',
    'another person is named')
  assert.equal(wordsFor([human, { side: 'black', kind: 'human', id: 'bea', name: 'Bea', open: false }], 'white'), '',
    'and your own turn says nothing at all')
  assert.equal(evaluate('waitSecondsWords(0)'), '0s', 'the clock starts at zero, so a line never looks frozen')
  assert.equal(evaluate('waitSecondsWords(42)'), '42s')
  boardPicture = picture

  // The agent line: working while it runs, then finished, with one click back.
  chatBusy.value = true
  tree = draw('WaitPane(paneProps)', { ctx: first.ctx })
  assert.ok(words(tree).includes('Hermes is working'), 'the pane says Hermes is working')
  chatBusy.value = false
  draw('WaitPane(paneProps)', { ctx: first.ctx })
  tree = draw('WaitPane(paneProps)', { ctx: first.ctx })
  assert.ok(words(tree).includes('Hermes finished'), 'the pane says Hermes finished')
  const back = findButton(tree, 'Back to chat')
  assert.ok(back, 'and offers one click back to the chat')
  back.props.onClick()
  assert.deepEqual(first.ctx.actions, ['composer.focus'], 'back to chat focuses the composer')
  assert.equal(first.ctx.notified.length, 0, 'nothing pops a notification for a finished turn')

  // An approval is said quietly too, from the gateway's own event, and takes no focus.
  assert.ok((eventListeners['approval.request'] || []).length > 0, 'the pane listens for approvals')
  ;(eventListeners['approval.request'] || []).forEach(listener => listener({ type: 'approval.request' }))
  tree = draw('WaitPane(paneProps)', { ctx: first.ctx })
  assert.ok(words(tree).includes('needs your approval'), 'the pane says an approval is waiting')
  ;(eventListeners['approval.settled'] || []).forEach(listener => listener({ type: 'approval.settled' }))
  tree = draw('WaitPane(paneProps)', { ctx: first.ctx })
  assert.ok(!words(tree).includes('needs your approval'), 'and stops saying it when the approval settles')

  // Leaving mid-game and coming back: the saved game is what opens, and the board
  // comes from the same /board door, so the server-side position is resumed.
  reset()
  const resumed = makeCtx({ 'pane-game': 'reversi' })
  tree = draw('WaitPane(paneProps)', { ctx: resumed.ctx })
  await new Promise(resolve => setTimeout(resolve, 0))
  tree = draw('WaitPane(paneProps)', { ctx: resumed.ctx })
  assert.ok(resumed.asked.includes('/board?game=reversi'), 'the saved game is the one that opens')
  const picker = nodes(tree).find(node => node.props && node.props['aria-label'] === 'Game')
  assert.ok(picker, 'every curated turn-based game is a tile')
  const tiles = nodes(picker).filter(node => node.props && node.props['data-game-tile'])
  assert.equal(tiles.length, 5, 'the tiles are the curated tables, not Doom')
  assert.deepEqual(tiles.map(node => words(node)), ['Connect Four', 'Reversi', 'Gomoku', 'Breakthrough', 'Chess'])
  assert.equal(nodes(tree).filter(node => node.type === 'select').length, 0, 'no drop-downs in the pane')

  // The lobby: find a match keeps looking while Hermes is used normally.
  reset()
  const lobbyCtx = makeCtx({ 'pane-game': 'connect4' })
  tree = draw('WaitPane(paneProps)', { ctx: lobbyCtx.ctx })
  await new Promise(resolve => setTimeout(resolve, 0))
  tree = draw('WaitPane(paneProps)', { ctx: lobbyCtx.ctx })
  findButton(tree, 'Lobby').props.onClick()
  tree = draw('WaitPane(paneProps)', { ctx: lobbyCtx.ctx })
  const find = findButton(tree, 'Find a match')
  assert.ok(find, 'the dock has a Find a match control')
  assert.equal(find.props.disabled, false, 'a named player can ask for a match')
  await find.props.onClick()
  assert.ok(lobbyCtx.asked.includes('looking connect4'), 'Find a match asks the local lobby for this game')

  // Alerts: off by default, per game, and pausable. They live on the Game tab.
  findButton(tree, 'Game').props.onClick()
  tree = draw('WaitPane(paneProps)', { ctx: lobbyCtx.ctx })
  sandbox.paneCtx = lobbyCtx.ctx
  assert.equal(evaluate("alertsOn(paneCtx, 'connect4')"), false, 'alerts are off until asked for')
  // Owner's ask 2026-11-09: no alert drops in any game for now, so the opt-in is not on the page
  // either. The controls are still in the source; ALERTS_OFF is what hides them.
  assert.ok(source.includes('const ALERTS_OFF = true'), 'alerts are switched off in one place')
  assert.ok(source.includes('ALERTS_OFF ? null : jsxs'), 'the pane list is not rendered while off')
  const alertBox = nodes(tree).find(node => node.type === 'label' && words(node).includes('Tell me when it is my turn'))
  assert.ok(!alertBox, 'and so the opt-in is not offered while alerts are off')
  // The rule still works underneath, for the day they come back: opt in per game, pause all.
  lobbyCtx.stored['pane-alerts'] = { paused: false, games: { connect4: true } }
  assert.equal(evaluate("alertsOn(paneCtx, 'connect4')"), true, 'per-game opt-in still reads back')
  assert.equal(evaluate("alertsOn(paneCtx, 'reversi')"), false, 'it is per game')
  lobbyCtx.stored['pane-alerts'].paused = true
  assert.equal(evaluate("alertsOn(paneCtx, 'connect4')"), false, 'pause silences every game at once')
  // And with the switch off, nothing pops up whatever the stored opt-in says.
  assert.equal(evaluate("notifyAlert(paneCtx, 'connect4', 'connect4', 'Your turn')"), null, 'no notification is raised')
  lobbyCtx.stored['pane-alerts'].paused = false

  // What the badge and the notification say, as plain functions.
  assert.equal(evaluate(`myTurn(${JSON.stringify(picture)}, ${JSON.stringify(view)})`), true, 'the board is mine to move')
  assert.equal(evaluate(`myTurn(${JSON.stringify({ ...picture, turn: 'black' })}, ${JSON.stringify(view)})`), false, 'and not when the computer is on move')
  const matchFor = (looking, name) => evaluate(`matchFound(${JSON.stringify({ looking })}, ${JSON.stringify(name)})`)
  assert.equal(matchFor([{ name: 'Ada', game: 'connect4' }, { name: 'Bea', game: 'connect4' }], 'Ada'), 'connect4',
    'someone waiting for my game is a match')
  assert.equal(matchFor([{ name: 'Ada', game: 'connect4' }], 'Ada'), '', 'my own looking row is not a match')
  assert.equal(matchFor([{ name: 'Bea', game: 'reversi' }], 'Ada'), '', 'nor is a game I am not looking for')

  // The status item: the dot and the notification only when asked for. One item,
  // one line -- 'Your turn (Connect Four)' -- and silent unless opted in.
  reset()
  const badgeCtx = makeCtx({ 'pane-game': 'connect4', 'pane-alerts': { paused: false, games: { connect4: true } } })
  sandbox.paneCtx = badgeCtx.ctx
  evaluate("paneWatch.game = 'connect4'")
  let badge = draw('GamesStatusItem(paneProps)', { ctx: badgeCtx.ctx })
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
  badge = draw('GamesStatusItem(paneProps)', { ctx: badgeCtx.ctx })
  assert.equal(statusNews(badge).props['aria-label'], 'Games: Your turn (Connect Four)', 'the status bar shows your turn, with the game')
  // Alerts are off for now (owner's ask, 2026-11-09): the badge still reads "Your turn", and
  // nothing is pushed at the person.
  assert.equal(badgeCtx.ctx.notified.length, 0, 'and raises no notification while alerts are off')
  badge = draw('GamesStatusItem(paneProps)', { ctx: badgeCtx.ctx })
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
  badge = draw('GamesStatusItem(paneProps)', { ctx: badgeCtx.ctx })
  assert.equal(badgeCtx.ctx.notified.length, 0, 'and repeating the read still announces nothing')

  // A slow board for the game the person just left must not paint under the game they
  // moved to, and the old board must not stay pressable under the new name while the
  // new one is on the way.
  const slowView = { player: { id: 'me', name: 'Ada', named: true }, viewer_id: 'me', allow_ai: true, play, lobby: { lines: [], looking: [] } }
  const slowStored = { 'pane-game': 'connect4' }
  const slow = { connect4: false, reversi: false }
  const release = { connect4: () => {}, reversi: () => {} }
  const slowCtx = {
    storage: { get: (key, fallback) => (key in slowStored ? slowStored[key] : fallback), set: (key, value) => { slowStored[key] = value } },
    os: {}, runAction: () => ({ ok: true }),
    rest: path => {
      const board = game => new Promise(resolve => { release[game] = () => resolve({ text: '', picture: { ...picture, view: game, game } }) })
      if (path.startsWith('/board?game=connect4')) return slow.connect4 ? board('connect4') : Promise.resolve({ text: '', picture })
      if (path === '/view') return Promise.resolve(slowView)
      if (path.startsWith('/board?game=reversi')) return slow.reversi ? board('reversi') : Promise.resolve({ text: '', picture: { ...picture, view: 'reversi', game: 'reversi' } })
      return Promise.resolve({})
    }
  }

  // (A) Connect Four is on screen and playable; Reversi's board is slow. The moment the
  // picker moves, nothing from Connect Four may still be pressable as Reversi.
  reset()
  slow.reversi = true
  tree = draw('WaitPane(paneProps)', { ctx: slowCtx })
  await new Promise(resolve => setTimeout(resolve, 0))
  tree = draw('WaitPane(paneProps)', { ctx: slowCtx })
  const beforeSwitch = nodes(tree).find(node => node.type && node.type.name === 'BoardSvg')
  assert.equal(beforeSwitch.props.picture.view, 'connect4', 'the pane is on Connect Four')
  assert.equal(beforeSwitch.props.interactive, true, 'and that board is playable')
  gameTile(tree, 'reversi').props.onClick()
  tree = draw('WaitPane(paneProps)', { ctx: slowCtx })
  const earlyBoard = nodes(tree).find(node => node.type && node.type.name === 'BoardSvg')
  assert.equal(earlyBoard.props.picture.view, 'reversi', 'the old game’s board is gone the moment the picker moves')
  assert.equal(earlyBoard.props.interactive, false, 'and nothing on it can be played as the new game')
  release.reversi()
  await new Promise(resolve => setTimeout(resolve, 0))
  tree = draw('WaitPane(paneProps)', { ctx: slowCtx })
  assert.equal(nodes(tree).find(node => node.type && node.type.name === 'BoardSvg').props.picture.view, 'reversi', 'then the new board arrives')
  slow.reversi = false

  // (B) Reversi is on screen; a Connect Four board the person left behind answers late.
  reset()
  slow.connect4 = true
  slowStored['pane-game'] = 'connect4'
  tree = draw('WaitPane(paneProps)', { ctx: slowCtx })
  await new Promise(resolve => setTimeout(resolve, 0))
  tree = draw('WaitPane(paneProps)', { ctx: slowCtx })
  gameTile(tree, 'reversi').props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  tree = draw('WaitPane(paneProps)', { ctx: slowCtx })
  release.connect4()
  await new Promise(resolve => setTimeout(resolve, 0))
  tree = draw('WaitPane(paneProps)', { ctx: slowCtx })
  assert.equal(gameTile(tree, 'reversi').props['aria-pressed'], true,
    'a stale board for the game the person left never paints under the new one')
  slow.connect4 = false

  // A match from the lobby: my own looking row plus somebody else's, under the badge.
  reset()
  view.lobby = { lines: [], looking: [{ name: 'Ada', game: 'connect4' }, { name: 'Bea', game: 'connect4' }] }
  boardPicture = { ...picture, turn: 'black' }
  const matchCtx = makeCtx({ 'pane-game': 'connect4', 'pane-alerts': { paused: false, games: { connect4: true } } })
  sandbox.paneCtx = matchCtx.ctx
  let matchBadge = draw('GamesStatusItem(paneProps)', { ctx: matchCtx.ctx })
  await new Promise(resolve => setTimeout(resolve, 0))
  matchBadge = draw('GamesStatusItem(paneProps)', { ctx: matchCtx.ctx })
  assert.equal(statusNews(matchBadge).props['aria-label'], 'Games: Match found', 'someone waiting for my game is on the badge')
  assert.equal(matchCtx.ctx.notified.length, 0, 'and nothing is pushed at the person while alerts are off')
  view.lobby = { lines: [], looking: [] }
  boardPicture = picture

  // Alerts are off for now (owner's ask, 2026-11-09), so the notification rules below are kept
  // for the day they come back rather than asserted against silent code.
  if (!evaluate('ALERTS_OFF')) {
  // Paused alerts are not remembered as told: the turn that happened while paused is
  // still announced once the game is unpaused (same badge, settings read again).
  reset()
  evaluate("paneWatch.game = 'connect4'")
  const pausedCtx = makeCtx({ 'pane-game': 'connect4', 'pane-alerts': { paused: true, games: { connect4: true } } })
  sandbox.paneCtx = pausedCtx.ctx
  let pausedBadge = draw('GamesStatusItem(paneProps)', { ctx: pausedCtx.ctx })
  await new Promise(resolve => setTimeout(resolve, 0))
  pausedBadge = draw('GamesStatusItem(paneProps)', { ctx: pausedCtx.ctx })
  assert.equal(statusNews(pausedBadge).props['aria-label'], 'Games: Your turn (Connect Four)', 'the badge still shows the turn while paused')
  assert.equal(pausedCtx.ctx.notified.length, 0, 'but it says nothing')
  pausedCtx.stored['pane-alerts'] = { paused: false, games: { connect4: true } }
  const unpausedCtx = { ...pausedCtx.ctx }
  pausedBadge = draw('GamesStatusItem(paneProps)', { ctx: unpausedCtx })
  await new Promise(resolve => setTimeout(resolve, 0))
  pausedBadge = draw('GamesStatusItem(paneProps)', { ctx: unpausedCtx })
  assert.equal(statusNews(pausedBadge).props['aria-label'], 'Games: Your turn (Connect Four)')
  assert.equal(unpausedCtx.notified.length, 1, 'unpausing does not lose the turn that happened while paused')

  // A later turn is a new line, even when every poll sees "Your turn".
  reset()
  evaluate("paneWatch.game = 'connect4'")
  boardPicture = { ...picture, plies: 4, last: '4' }
  const turnCtx = makeCtx({ 'pane-game': 'connect4', 'pane-alerts': { paused: false, games: { connect4: true } } })
  sandbox.paneCtx = turnCtx.ctx
  let turnBadge = draw('GamesStatusItem(paneProps)', { ctx: turnCtx.ctx })
  await new Promise(resolve => setTimeout(resolve, 0))
  turnBadge = draw('GamesStatusItem(paneProps)', { ctx: turnCtx.ctx })
  assert.equal(turnCtx.ctx.notified.length, 1, 'the first turn is announced')
  boardPicture = { ...picture, plies: 6, last: '5' }
  const nextTurnCtx = { ...turnCtx.ctx }
  turnBadge = draw('GamesStatusItem(paneProps)', { ctx: nextTurnCtx })
  await new Promise(resolve => setTimeout(resolve, 0))
  turnBadge = draw('GamesStatusItem(paneProps)', { ctx: nextTurnCtx })
  assert.equal(nextTurnCtx.notified.length, 2, 'and the next turn is announced too')
  }
  boardPicture = picture

  // An approval that arrives mid-turn is said out loud; "working" does not hide it.
  chatBusy.value = true
  assert.equal(evaluate("agentNotice(true, false, true).text"), 'Hermes needs your approval in the chat.',
    'an approval wins over the working line')
  chatBusy.value = false

  // Switching games clears the old board before the new one arrives, and a move for a
  // game that is no longer on screen is refused.
  assert.equal(evaluate("agentNotice(false, true, false).text"), 'Hermes finished: back to chat')

  if (!evaluate('ALERTS_OFF')) {
  // A match is announced even while the board is waiting on the person: the badge shows
  // the turn, and both pieces of news get their own notification.
  reset()
  evaluate("paneWatch.game = 'connect4'")
  view.lobby = { lines: [], looking: [{ name: 'Ada', game: 'connect4' }, { name: 'Bea', game: 'connect4' }] }
  const bothCtx = makeCtx({ 'pane-game': 'connect4', 'pane-alerts': { paused: false, games: { connect4: true } } })
  sandbox.paneCtx = bothCtx.ctx
  let bothBadge = draw('GamesStatusItem(paneProps)', { ctx: bothCtx.ctx })
  await new Promise(resolve => setTimeout(resolve, 0))
  bothBadge = draw('GamesStatusItem(paneProps)', { ctx: bothCtx.ctx })
  assert.equal(statusNews(bothBadge).props['aria-label'], 'Games: Your turn (Connect Four)', 'the badge leads with the turn')
  assert.deepEqual(bothCtx.ctx.notified.map(item => item.title), ['Your turn', 'Match found'],
    'and a match found is not hidden behind it')
  }
  view.lobby = { lines: [], looking: [] }

  // Start over: the model choice in the dialog, and its words naming the model - never "the
  // computer" for a model game (owner's ask, 2026-11-11).
  reset()
  evaluate("paneWatch.game = 'connect4'")
  const restartCtx = makeCtx({ 'pane-game': 'connect4' })
  tree = draw('WaitPane(paneProps)', { ctx: restartCtx.ctx })
  await new Promise(resolve => setTimeout(resolve, 0))
  tree = draw('WaitPane(paneProps)', { ctx: restartCtx.ctx })
  assert.ok(findButton(tree, 'Start over'), 'an active game offers Start over')
  findButton(tree, 'Start over').props.onClick()
  tree = draw('WaitPane(paneProps)', { ctx: restartCtx.ctx })
  assert.ok(words(tree).includes('Starting over resigns this game and deals a new one.'),
    'and it says what starting over does, before anything is picked: ' + words(tree).slice(0, 220))
  assert.ok(!words(tree).includes('against the computer'), 'naming no opponent the person did not pick')
  // The model choice: the shared ModelPicker appears, and the words name the model.
  nodes(tree).find(node => node.props && node.props['data-deal-choice'] === 'agent').props.onChange()
  tree = draw('WaitPane(paneProps)', { ctx: restartCtx.ctx })
  assert.ok(words(tree).includes('Starting over resigns this game and deals a new one against your Hermes model.'),
    'the confirm text matches the choice: ' + words(tree).slice(0, 240))
  assert.equal(words(tree).includes('against the computer'), false, 'and a model game never says "the computer"')
  await new Promise(resolve => setTimeout(resolve, 0))
  tree = draw('WaitPane(paneProps)', { ctx: restartCtx.ctx })
  const seatPicker = nodes(tree).find(node => node.type && node.type.name === 'ModelPicker')
  assert.ok(seatPicker, 'the shared ModelPicker is offered for the model seat')
  assert.deepEqual(seatPicker.props.routes, PANE_MODEL_ROUTES, 'handed every route this Hermes has')
  assert.equal(seatPicker.props.current, '', 'with the chat model marked while the person picks nothing')
  assert.equal(typeof seatPicker.props.onPick, 'function', 'and the pick reported back')
  assert.ok(words(tree).includes('Game Shelf opponent'), 'and the line says which model this seat really plays')
  // ... and Start deals the model seat, through the same two presses every start-over takes.
  await findButton(tree, 'Start').props.onClick()
  const lines = restartCtx.asked.filter(line => typeof line === 'string' && (line.startsWith('allow-ai') || line.startsWith('connect4')))
  assert.deepEqual(lines, ['connect4 resign', 'allow-ai connect4 black=agent level=intermediate'],
    'resign, then a fresh game against the person\'s own Hermes model')

  // Solo games in the side pane: Slots has no opponent, so no choice to make
  // and no strength row. The real manifest ships bots:true for the cabinet (its machine
  // is not an opponent seat), so the check uses the game's board view - its metadata -
  // and the same must hold whoever wrote the manifest's bots flag.
  reset()
  const savedPlay = view.play
  view.play = [{ id: 'slots', title: 'Slots', kind: 'table', installed: true, bots: true, solo: true }]
  boardPicture = { view: 'slots', game: 'slots', status: 'active', machines: [], legal: ['spin'], chips: 100, bet: 5, bets: [5], feed: [], paytable: [] }
  const soloCtx = makeCtx({ 'pane-game': 'slots' })
  tree = draw('WaitPane(paneProps)', { ctx: soloCtx.ctx })
  await new Promise(resolve => setTimeout(resolve, 0))
  tree = draw('WaitPane(paneProps)', { ctx: soloCtx.ctx })
  assert.equal(findButton(tree, 'Play my Hermes model'), undefined, 'a solo game never offers the Hermes model')
  assert.equal(findButton(tree, 'Start over'), undefined, 'a solo game has no opponent to restart against')
  assert.equal(findButton(tree, 'New game'), undefined, 'and no new game door at all')
  assert.equal(nodes(tree).some(node => node.props && node.props['data-level']), false, 'a solo game has no strength row')
  assert.equal(nodes(tree).some(node => node.props && node.props['data-pane-opponents']), false, 'and draws no opponent row at all')
  view.play = savedPlay
  boardPicture = picture

  // A game that is not in play yet: the door reads "New game", and it deals with no resign, at
  // the strength the person picked in the dialog (the pane used to deal on the strength press).
  reset()
  boardPicture = { ...picture, status: 'idle' }
  const levelCtx = makeCtx({ 'pane-game': 'connect4' })
  tree = draw('WaitPane(paneProps)', { ctx: levelCtx.ctx })
  await new Promise(resolve => setTimeout(resolve, 0))
  tree = draw('WaitPane(paneProps)', { ctx: levelCtx.ctx })

  const newGameBtn = findButton(tree, 'New game')
  assert.ok(newGameBtn, 'a table that is not in play offers New game')
  assert.equal(findButton(tree, 'Intermediate'), undefined, 'the strength row lives in the dialog, not on the pane')
  await newGameBtn.props.onClick()
  tree = draw('WaitPane(paneProps)', { ctx: levelCtx.ctx })
  nodes(tree).find(node => node.props && node.props['data-deal-choice'] === 'computer').props.onChange()
  tree = draw('WaitPane(paneProps)', { ctx: levelCtx.ctx })
  const beginnerBtn = findButton(tree, 'Beginner')
  assert.ok(beginnerBtn, 'Beginner strength button exists, for the computer choice')
  await beginnerBtn.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  tree = draw('WaitPane(paneProps)', { ctx: levelCtx.ctx })
  assert.equal(levelCtx.asked.filter(line => typeof line === 'string' && line.startsWith('allow-ai')).length, 0,
    'picking a strength deals nothing')
  await findButton(tree, 'Start').props.onClick()
  assert.equal(levelCtx.asked.filter(line => typeof line === 'string' && line.startsWith('allow-ai')).at(-1),
    'allow-ai connect4 black=local level=beginner',
    'New game vs computer preserves the selected level=beginner')
  boardPicture = picture
  reset()

  // Blackjack in the pane (owner's ask 2026-11-10): its dealer seat can be the built-in
  // player or the person's own model, so a solo table that seats one is offered the same
  // two buttons every board game has - the pane had no way to start a new game at all.
  reset()
  const savedPlayAgain = view.play
  view.play = [{ id: 'blackjack', title: 'Blackjack', kind: 'table', installed: true, bots: true, solo: true }]
  const feltSeats = [
    { side: 'white', kind: 'human', id: '', name: '', open: true },
    { side: 'black', kind: 'local', id: 'local', name: 'Local', open: false }
  ]
  const feltPicture = {
    view: 'blackjack', game: 'blackjack', status: 'active', phase: 'bet', plies: 0, turn: 'white',
    seats: feltSeats, side_words: { white: 'You', black: 'Dealer' }, level: 'intermediate',
    levels: [{ id: 'intermediate', label: 'Intermediate' }], legal: ['bet10'], bets: [10],
    chips: 10000, bet: 0, hand: [], dealer: [], permissions: { can_move: true, can_manage: true }
  }
  boardPicture = feltPicture
  const feltCtx = makeCtx({ 'pane-game': 'blackjack' })
  tree = draw('WaitPane(paneProps)', { ctx: feltCtx.ctx })
  await new Promise(resolve => setTimeout(resolve, 0))
  tree = draw('WaitPane(paneProps)', { ctx: feltCtx.ctx })
  assert.ok(findButton(tree, 'New game'), 'a solo table that seats a dealer offers a new game')
  assert.equal(nodes(tree).some(node => node.props && node.props['data-level']), false,
    'a dealer plays the house rules: no strength row')
  const felt = nodes(tree).find(node => node.type && node.type.name === 'BlackjackTable')
  assert.ok(felt && /dealer/.test(felt.props.against.who), 'the felt is told who is across it')
  // A session with nothing on the felt is dealt with no resign, once the dealer seat is chosen.
  await findButton(tree, 'New game').props.onClick()
  tree = draw('WaitPane(paneProps)', { ctx: feltCtx.ctx })
  nodes(tree).find(node => node.props && node.props['data-deal-choice'] === 'computer').props.onChange()
  tree = draw('WaitPane(paneProps)', { ctx: feltCtx.ctx })
  await findButton(tree, 'Start').props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.ok(feltCtx.asked.includes('allow-ai blackjack black=local level=intermediate'),
    'a fresh felt is dealt against the built-in dealer with no resign first')
  // A session with hands behind it is asked about first, then ended before the new deal.
  feltCtx.asked.length = 0
  boardPicture = { ...feltPicture, plies: 4, phase: 'play', legal: ['hit', 'stand'] }
  tree = draw('WaitPane(paneProps)', { ctx: feltCtx.ctx })
  await new Promise(resolve => setTimeout(resolve, 0))
  tree = draw('WaitPane(paneProps)', { ctx: feltCtx.ctx })
  await findButton(tree, 'Start over').props.onClick()
  tree = draw('WaitPane(paneProps)', { ctx: feltCtx.ctx })
  assert.ok(words(tree).includes('Starting over ends this session and deals a new one.'),
    'a session in play says what starting over does: ' + words(tree).slice(0, 200))
  nodes(tree).find(node => node.props && node.props['data-deal-choice'] === 'computer').props.onChange()
  tree = draw('WaitPane(paneProps)', { ctx: feltCtx.ctx })
  await findButton(tree, 'Start').props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  const dealt = feltCtx.asked.filter(line => typeof line === 'string' && (line.startsWith('allow-ai') || line.startsWith('blackjack')))
  assert.deepEqual(dealt, ['blackjack resign', 'allow-ai blackjack black=local level=intermediate'],
    'the session is ended, then dealt again against the computer')
  // And the person's model takes the dealer seat through the same two presses.
  feltCtx.asked.length = 0
  tree = draw('WaitPane(paneProps)', { ctx: feltCtx.ctx })
  await findButton(tree, 'Start over').props.onClick()
  tree = draw('WaitPane(paneProps)', { ctx: feltCtx.ctx })
  nodes(tree).find(node => node.props && node.props['data-deal-choice'] === 'agent').props.onChange()
  tree = draw('WaitPane(paneProps)', { ctx: feltCtx.ctx })
  await findButton(tree, 'Start').props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  const dealtToModel = feltCtx.asked.filter(line => typeof line === 'string' && (line.startsWith('allow-ai') || line.startsWith('blackjack')))
  assert.deepEqual(dealtToModel, ['blackjack resign', 'allow-ai blackjack black=agent level=intermediate'],
    'the model plays the dealer, one call per move')
  view.play = savedPlayAgain
  boardPicture = picture

  // A move in the pane is drawn the moment it is made, and painted from the answer itself
  // (owner's report 2026-11-10: "moving a piece versus the computer takes noticeably long
  // before the piece lands"). The board read after the move used to be the only thing that
  // could show it, so the piece sat still for the computer's whole search.
  reset()
  const moveCtx = makeCtx({ 'pane-game': 'connect4' })
  boardPicture = picture
  // The answer carries the new board.
  const answered = { ...picture, game: 'connect4', plies: 2, last: '4' }
  moveCtx.ctx.rest = async (path, options) => {
    if (path === '/command') { moveCtx.asked.push((options.body || {}).line); return { text: 'Played 4.', ok: true, picture: answered } }
    if (path === '/view') return view
    if (String(path).startsWith('/board')) return { text: '', picture: boardPicture }
    return {}
  }
  tree = draw('WaitPane(paneProps)', { ctx: moveCtx.ctx })
  await new Promise(resolve => setTimeout(resolve, 0))
  tree = draw('WaitPane(paneProps)', { ctx: moveCtx.ctx })
  const playable = nodes(tree).find(node => node.type && node.type.name === 'BoardSvg')
  assert.equal(typeof playable.props.onPending, 'function', 'the pane hands the move to be drawn ahead')
  assert.ok('pending' in playable.props, 'and a place to hold it')
  await new Promise(resolve => setTimeout(resolve, 0))
  // From here a board read answers nothing: whatever lands has to come from the move's own
  // reply, which is exactly the claim - the piece does not wait for a read.
  moveCtx.ctx.rest = async (path, options) => {
    if (path === '/command') { moveCtx.asked.push((options.body || {}).line); return { text: 'Played 4.', ok: true, picture: answered } }
    if (path === '/view') return view
    if (String(path).startsWith('/board')) return new Promise(() => {})
    return {}
  }
  await playable.props.onMove('4')
  tree = draw('WaitPane(paneProps)', { ctx: moveCtx.ctx })
  const answeredBoard = nodes(tree).find(node => node.type && node.type.name === 'BoardSvg')
  assert.equal(answeredBoard.props.picture.plies, 2, 'the move lands from the answer, with no read behind it')
  assert.equal(moveCtx.asked.filter(line => line === 'connect4 move 4').length, 1, 'one move line, one answer')
  assert.ok(!answeredBoard.props.pending, 'the move drawn ahead gives way to the table’s own board')
  boardPicture = picture

  // The way in: the status-bar item and the palette command reveal the pane, and
  // the pane contribution is a right-side pane that installs minimized.
  statusNews(badge).props.onClick()
  assert.ok(sandbox.revealed >= 1, 'the status-bar item opens the pane')
  const entries = []
  // The page's mount effect may have closed the pane while earlier contracts ran;
  // registering starts from the pane being wanted, as a fresh load does. The QA
  // localStorage has no removeItem, so clear the flag through setItem.
  evaluate("window.localStorage.setItem(PANE_GONE_KEY, '0')")
  evaluate('plugin').register({
    registerMany: list => { list.forEach(item => entries.push(item)) },
    storage: { get: (key, fallback) => fallback, set() {} },
    os: {},
    rest: async () => ({})
  })
  const paneEntry = entries.find(item => item.id === 'pane')
  assert.ok(paneEntry, 'the plugin contributes a pane')
  assert.equal(paneEntry.area, 'panes')
  assert.equal(paneEntry.title, 'Play while you code')
  assert.equal(paneEntry.data.placement, 'right')
  assert.equal(paneEntry.data.dock.pos, 'right')
  assert.equal(paneEntry.data.defaultCollapsed, true, 'it does not reshape a layout unasked')
  assert.equal(paneEntry.data.hideOnly, true, 'and closing it cannot disable the plugin')
  assert.ok(entries.find(item => item.area === 'palette' && item.data.label === 'Play while you code'), 'the palette can open it')
  assert.ok(entries.find(item => item.area === 'palette' && item.data.id === 'hermes-gameshelf.wait'), 'the palette command keeps its own id')
  assert.equal(typeof entries.find(item => item.id === 'status').render, 'function')

  // The version (owner's ask 2026-11-10): one reusable chip, and it is drawn at the top of Settings —
  // the full-screen Settings screen and this pane's own gear. It is NOT a status-bar item, NOT in the
  // Games header, and NOT at this pane's foot.
  assert.equal(entries.find(item => item.id === 'version'), undefined, 'the version is not a status-bar item')
  assert.equal(entries.find(item => item.area === 'right' && item.data && item.data.version), undefined,
    'and nothing else registers it in the status bar')
  assert.equal(entries.filter(item => item.area === 'right').length, 1,
    'the status bar has one Slots item and nothing else')
  // The two see-through machines are a composer-slot contribution now (review, 2026-11-12): the app owns
  // where they go, so nothing has to be anchored in the status bar or floated over the app's markup.
  assert.ok(entries.find(item => item.area === 'composer.underside' && item.id === 'overchat'),
    'the over-chat machines are contributed to the composer underside slot')
  assert.equal(entries.find(item => item.id === 'jackpot2'), undefined,
    'and no status-bar item is left just to host an overlay')
  reset()
  const versionStamp = { version: '9.9.9', commit: 'abcdef1234567890', commit_date: '2026-11-10T09:00:00-07:00', dirty: false }
  const chipCtx = makeCtx({ 'pane-game': 'connect4' })
  const chipRest = chipCtx.ctx.rest
  chipCtx.ctx.rest = async (path, options) => (path === '/v1/version' ? versionStamp : chipRest(path, options))
  sandbox.chipProps = { ctx: chipCtx.ctx }
  draw('GamesVersionChip(chipProps)', sandbox.chipProps)
  await new Promise(resolve => setTimeout(resolve, 0))
  const versionChip = nodes(draw('GamesVersionChip(chipProps)', sandbox.chipProps))
    .find(node => node.props && node.props['data-games-version'] === 'chip')
  assert.ok(versionChip, 'one reusable chip: GamesVersionChip')
  assert.equal(words(versionChip), 'v9.9.9 · 2026-11-10 · abcdef12', 'the same line the version stamp prints')
  assert.ok(String(versionChip.props.title).includes('Game Center 9.9.9'), 'and the same hover title')
  assert.equal(versionChip.props.style.fontVariantNumeric, 'tabular-nums', 'muted, small, tabular numbers')
  assert.equal(versionChip.props.style.color, 'var(--ui-text-tertiary)')
  assert.equal(versionChip.props.style.border, '1px solid var(--ui-stroke-secondary)', 'on the existing stroke token')
  sandbox.chipProps.ctx = { rest: async () => ({ ...versionStamp, dirty: true }) }
  reset()
  draw('GamesVersionChip(chipProps)', sandbox.chipProps)
  await new Promise(resolve => setTimeout(resolve, 0))
  const dirtyChip = nodes(draw('GamesVersionChip(chipProps)', sandbox.chipProps))
    .find(node => node.props && node.props['data-games-version'] === 'chip')
  assert.ok(words(dirtyChip).includes('· modified'), 'a modified install says so')
  assert.equal(dirtyChip.props.style.color, '#b45309', 'in amber, not muted')

  // The pane: no chip at its foot any more, and a gear in its header instead.
  reset()
  evaluate("window.sessionStorage.setItem('gameshelf-pane-chrome', 'open')")
  sandbox.chipProps = { ctx: chipCtx.ctx }
  tree = draw('WaitPane(paneProps)', sandbox.chipProps)
  await new Promise(resolve => setTimeout(resolve, 0))
  tree = draw('WaitPane(paneProps)', sandbox.chipProps)
  const paneRoot = nodes(tree).find(node => node.props && node.props.className === 'games-wait-pane')
  const paneChildren = [].concat((paneRoot && paneRoot.props.children) || [])
  assert.equal(paneChildren.some(child => child && child.props && child.props['data-games-version-footer'] === '1'), false,
    'the wait pane no longer draws the chip at its foot')
  assert.equal(nodes(tree).some(node => node.props && (node.props['data-games-version-row'] === '1' || node.props['data-games-version'] === 'chip')), false,
    'and it keeps the chip out of its own header too')
  const gear = nodes(tree).find(node => node.props && node.props['aria-label'] === 'Settings')
  assert.ok(gear, 'the pane header carries a small Settings gear')
  assert.ok(String(gear.props.title).includes('the same ones as in the Games app'),
    'and it says the settings are the Games app ones')

  // The gear opens the Games app's own SettingsPanel — same rows, same routes, same storage — inside
  // the pane, with a way back welded to the pane.
  gear.props.onClick()
  tree = draw('WaitPane(paneProps)', sandbox.chipProps)
  await new Promise(resolve => setTimeout(resolve, 0))
  tree = draw('WaitPane(paneProps)', sandbox.chipProps)
  const paneSettings = nodes(tree).find(node => node.props && node.props['data-pane-settings'] === '1')
  assert.ok(paneSettings, 'the gear opens a Settings view in the pane')
  const panel = nodes(paneSettings).find(node => typeof node.type === 'function' && node.type.name === 'SettingsPanel')
  assert.ok(panel, 'and what it draws is the one SettingsPanel, not a second copy of the rows')
  assert.equal(panel.props.ctx, chipCtx.ctx, 'fed the pane own context')
  assert.ok(panel.props.view && panel.props.view.play, 'and the pane own /view answer')
  assert.equal(typeof panel.props.onSkin, 'function', 'the Look switch is the page own hook, so no new storage key')
  assert.equal(panel.props.onReopen, undefined, 'no welcome link the pane cannot honour')
  assert.equal(panel.props.onCommunity, undefined, 'and no community link that would land elsewhere')
  assert.equal(panel.props.backLabel, 'Back to the play pane', 'the way back is the pane')
  panel.props.onBack()
  tree = draw('WaitPane(paneProps)', sandbox.chipProps)
  assert.ok(findButton(tree, 'Connect Four'), 'one press back and the pane game list is there again')

  // Out of the way, per the owner: a visible Close and Minimize in the header, a
  // strip to come back with, Esc while the pane has focus, and the choice kept
  // for the session.
  reset()
  boardPicture = { ...picture, turn: 'white' }
  const chromeCtx = makeCtx({ 'pane-game': 'connect4' })
  tree = draw('WaitPane(paneProps)', { ctx: chromeCtx.ctx })
  await new Promise(resolve => setTimeout(resolve, 0))
  tree = draw('WaitPane(paneProps)', { ctx: chromeCtx.ctx })
  const headerClose = () => nodes(tree).find(node => node.props && node.props['aria-label'] === 'Close')
  const headerMin = () => nodes(tree).find(node => node.props && node.props['aria-label'] === 'Minimize')
  const strip = () => nodes(tree).find(node => node.props && node.props['aria-label'] === 'Games. Restore the play pane')
  assert.ok(headerClose() && headerMin(), 'the pane header has a visible Close and Minimize')
  headerMin().props.onClick()
  tree = draw('WaitPane(paneProps)', { ctx: chromeCtx.ctx })
  assert.ok(strip(), 'minimize collapses the pane to one slim strip')
  assert.ok(nodes(strip()).some(node => node.props && node.props['data-dot'] === 'turn'),
    'the strip keeps the quiet your-turn dot')
  assert.equal(sandbox.window.sessionStorage.getItem('gameshelf-pane-chrome'), 'min', 'the choice is remembered for the session')
  strip().props.onClick()
  tree = draw('WaitPane(paneProps)', { ctx: chromeCtx.ctx })
  assert.ok(headerClose() && !strip(), 'one press on the strip restores the pane')
  assert.equal(sandbox.window.sessionStorage.getItem('gameshelf-pane-chrome'), null)
  headerClose().props.onClick()
  tree = draw('WaitPane(paneProps)', { ctx: chromeCtx.ctx })
  assert.ok(strip() && !headerClose(), 'close leaves the strip, and nothing else, in the pane slot')
  assert.equal(sandbox.window.sessionStorage.getItem('gameshelf-pane-chrome'), 'closed')
  strip().props.onClick()
  tree = draw('WaitPane(paneProps)', { ctx: chromeCtx.ctx })
  assert.ok(headerClose(), 'the status item and the palette door reopen it')

  // Esc: closes the pane while the person is in it, never while they are not.
  reset()
  sandbox.escapeRoot = { contains: () => true }
  sandbox.escapeDo = () => { sandbox.escapeClosed = (sandbox.escapeClosed || 0) + 1 }
  evaluate('(() => { useEffect(() => usePaneEscape({ current: { contains: () => true } }, escapeDo), []); return null })()')
  let escapeEffects = effects; effects = []
  escapeEffects.forEach(effect => effect())
  escapeEffects = effects; effects = []
  escapeEffects.forEach(effect => effect())
  sandbox.document.activeElement = { node: true }
  fireKey('Escape')
  assert.equal(sandbox.escapeClosed, 1, 'Esc closes the pane the person is working in')
  sandbox.document.activeElement = null
  fireKey('Escape')
  assert.equal(sandbox.escapeClosed, 1, 'and Esc never leaves the pane to steal the chat')

  // Full screen and the pane are one at a time: the handoff carries the game both
  // ways, and only one surface is registered after each move.
  reset()
  const handoffStored = { 'pane-game': 'connect4' }
  let handoffDisposed = 0
  const handoffCtx = {
    storage: {
      get: (key, fallback) => (key in handoffStored ? handoffStored[key] : fallback),
      set: (key, value) => { handoffStored[key] = value }
    },
    registerMany: () => {
      return () => { handoffDisposed++ }
    }
  }
  const handoffPaths = []
  sandbox.handoffPaths = handoffPaths
  // SDK_HOST is the host captured when the bundle loaded; mutate that object.
  evaluate('SDK_HOST.navigate = route => { handoffPaths.push(route); navigated = route }')
  sandbox.handoffCtx = handoffCtx
  evaluate("WAIT_PANE_SLOT.ctx = handoffCtx; WAIT_PANE_SLOT.make = () => ({ id: 'pane' }); WAIT_PANE_SLOT.dispose = null; paneWatch.game = ''")

  // a) The pane leaves the screen and Game Center opens on the pane's game.
  assert.equal(evaluate('mountWaitPane()'), true, 'the pane mounts before the handoff')
  evaluate('pageFromPane(handoffCtx)')
  assert.equal(handoffDisposed, 1, 'the pane registration is disposed')
  assert.equal(handoffPaths[handoffPaths.length - 1], '/games', 'Game Center is the route opened')
  assert.equal(evaluate('PAGE_HANDOFF.game'), 'connect4', 'the pane game is handed to the page')
  assert.equal(handoffStored['pane-game'], 'connect4', 'the saved pane game is not cleared by the handoff')

  // b) Full screen goes away and the pane comes back, registered, on the same game.
  evaluate("paneFromPage(handoffCtx, 'chess')")
  assert.equal(handoffPaths[handoffPaths.length - 1], '/', 'the full-screen page is left for the chat')
  assert.equal(evaluate("typeof WAIT_PANE_SLOT.dispose"), 'function', 'the pane is registered again')
  assert.equal(evaluate('paneWatch.game'), 'chess', 'the pane opens the game full screen was showing')
  assert.equal(handoffStored['pane-game'], 'chess', 'and remembers it')

  // c) The page appearing closes a mounted pane, and is harmless with no pane.
  const disposedBeforeLeave = handoffDisposed
  evaluate('leavePaneForPage()')
  assert.equal(handoffDisposed, disposedBeforeLeave + 1, 'the page appearing disposes the pane')
  evaluate('WAIT_PANE_SLOT.dispose = null')
  evaluate('leavePaneForPage()')
  assert.equal(handoffDisposed, disposedBeforeLeave + 1, 'with no pane there is nothing to dispose and no throw')

  // The pane's controls, as the source has them: one door to a new game with the opponent chosen
  // inside it, real radios with nothing picked, Start waiting for a choice, and a strength press
  // that only sets the strength (owner's ask, 2026-11-11).
  assert.ok(source.includes('const [dealWho, setDealWho] = useState(\'\')'), 'the pane starts with no opponent chosen')
  assert.ok(source.includes("type: 'radio'"), 'the dialog uses real radios')
  assert.ok(source.includes("'data-deal-choice': id"), 'each with its own hook')
  assert.ok(source.includes("name: 'games-pane-deal'"), 'in one named group, so the keyboard works')
  assert.ok(source.includes('disabled: working || !dealWho'), 'Start stays disabled until a choice is made')
  assert.ok(source.includes('onClick: () => setLevel(item.id)'), 'a strength press only sets the strength')
  assert.ok(source.includes('const dealWords = who => (who === \'agent\' ? \'your Hermes model\' : \'the computer\')'),
    'and the confirm text takes its words from the choice')
  assert.ok(!source.includes("`Starting over resigns this game and deals a new one against the computer.`"),
    'the old line that always said "the computer" is gone')
  assert.ok(source.includes('jsx(ModelPicker, {'), 'the model seat is offered the shared ModelPicker')

  // The pane hides what is not built, and keeps it: each gate wears its own FUTURE(2026-11-11) note
  // and the code behind it is still in the bundle (owner's ask, 2026-11-11).
  assert.ok(source.includes('const PANE_LADDER_OFF = true'), 'the bot ladder is switched off in one place')
  assert.ok(source.includes('const PANE_LEAGUES_OFF = true'), 'so are Bots & leagues')
  assert.ok(source.includes('const PANE_ONLINE_ALERT_OFF = true'), 'and the online-alert switch')
  assert.ok(source.includes('const STOCK_LEAGUE_OFF = true'), 'and the stock league design stub')
  for (const what of ['the bot ladder on the pane', 'Bots & leagues on the pane', 'the online-alert checkbox on the pane', 'the Stock league "Read the design"']) {
    assert.ok(source.includes(`FUTURE(2026-11-11): ${what} — remove if never built`), `the FUTURE note names ${what}`)
  }
  assert.ok(source.includes("'aria-label': 'Bot ladder'"), 'the ladder section is still written')
  assert.ok(source.includes("button('Enter ladder'"), 'with its own control')
  assert.ok(source.includes("'aria-label': 'Bots and leagues'"), 'the leagues block is still written')
  assert.ok(source.includes("'Read the design'"), 'and the stock league design stub')
  assert.ok(source.includes('PANE_LADDER_OFF ? null : ladderSection'), 'the ladder is gated where it is drawn')
  assert.ok(source.includes('PANE_LEAGUES_OFF || !(online.on && online.linked)'), 'so are the leagues')
  assert.ok(source.includes('PANE_ONLINE_ALERT_OFF ? null : jsxs'), 'and the alert row')
  assert.ok(source.includes('STOCK_LEAGUE_OFF ? null : jsx'), 'and the stock row')

  // One wording for the wait line, shared by the pane and the table, so they cannot drift.
  assert.ok(source.includes('function waitWords(picture, view, opts)'), 'the wait line is written once')
  assert.ok(source.includes("if (kind === 'agent') return 'Hermes is thinking…'"), 'a model seat is Hermes')
  assert.ok(source.includes("working ? 'Computer is thinking…' : 'Waiting for the computer…'"),
    'and the computer is only thinking while a reply is out')
  assert.ok(source.includes('function waitSecondsWords(seconds)'), 'the seconds are counted in one place')
  assert.ok(source.includes('const paneWait = pictured && pictured.status'), 'the pane follows that line, with the seconds')

  reset()
  chatBusy.value = false
  console.log('play while you code pane: passed')
}

// The obvious door (owner's ask, 2026-11-11): the pane and its palette command are "Play while
// you code", a real button stands in the Games header beside the chips, and the status bar
// carries a small game icon and the same words while the pane is closed. Both doors read one
// state and press the same two functions, and the status item hides while the pane is open.
async function paneDoorContract() {
  reset()
  // The words, in one place: the pane's own title, its palette command, and both doors.
  assert.equal(evaluate('paneDoorWords(false)'), 'Play while you code')
  assert.equal(evaluate('paneDoorWords(true)'), 'Close side pane')
  assert.ok(/side pane/.test(evaluate('paneDoorTitle(false)')), 'the closed door says where it goes on hover')
  assert.ok(/palette/.test(evaluate('paneDoorTitle(true)')), 'and the open one says how the pane comes back')
  assert.ok(source.includes("title: 'Play while you code'"), 'the pane is titled Play while you code')
  assert.ok(source.includes("label: 'Play while you code'"), 'and its palette command says the same')
  assert.ok(!source.includes("title: 'Play while you wait'") && !source.includes("label: 'Play while you wait'")
    && !source.includes("children: 'Play while you wait'"), 'the old words are gone from every title and label')

  // One state, read by both doors: the pane's own registration, and a session that closed it.
  evaluate("window.sessionStorage.removeItem('gameshelf-pane-chrome')")
  evaluate('WAIT_PANE_SLOT.dispose = null')
  assert.equal(evaluate('paneOnScreen()'), false, 'no pane registered, no pane on screen')
  evaluate('WAIT_PANE_SLOT.dispose = () => {}')
  assert.equal(evaluate('paneOnScreen()'), true, 'a registered pane is on the screen')
  evaluate("window.sessionStorage.setItem('gameshelf-pane-chrome', 'closed')")
  assert.equal(evaluate('paneOnScreen()'), false, 'a session that closed the pane stays closed')
  evaluate("window.sessionStorage.removeItem('gameshelf-pane-chrome')")
  evaluate('WAIT_PANE_SLOT.dispose = null')

  // The header button: plain words, a real button, and it opens and closes the pane.
  const openDoor = evaluate('paneDoorButtonElement(false)')
  assert.equal(words(openDoor), 'Play while you code', 'a closed pane offers Play while you code')
  assert.equal(openDoor.props['data-games-pane-door'], 'open')
  assert.equal(openDoor.props['aria-pressed'], false)
  const closeDoor = evaluate('paneDoorButtonElement(true)')
  assert.equal(words(closeDoor), 'Close side pane', 'an open pane makes the same button close it')
  assert.equal(closeDoor.props['data-games-pane-door'], 'close')
  assert.equal(closeDoor.props['aria-pressed'], true)
  const realOpen = evaluate('openWaitPane')
  const realClose = evaluate('closeWaitPane')
  sandbox.realOpen = realOpen
  sandbox.realClose = realClose
  sandbox.doorOpened = 0
  sandbox.doorClosed = 0
  evaluate('openWaitPane = () => { doorOpened += 1; return true }')
  evaluate('closeWaitPane = () => { doorClosed += 1; return true }')
  openDoor.props.onClick()
  closeDoor.props.onClick()
  assert.equal(sandbox.doorOpened, 1, 'one press on the closed button calls openWaitPane')
  assert.equal(sandbox.doorClosed, 1, 'and one press on the open button calls closeWaitPane')
  evaluate('openWaitPane = realOpen')
  evaluate('closeWaitPane = realClose')
  assert.equal(evaluate('openWaitPane'), realOpen, 'the real doors are back')

  // The status-bar item: a small game icon and the words while the pane is closed, nothing
  // while it is open, and no version chip anywhere near it.
  assert.equal(evaluate('paneDoorItemElement(true)'), null, 'the status item hides while the pane is open')
  const statusDoor = evaluate('paneDoorItemElement(false)')
  assert.ok(nodes(statusDoor).some(node => node.props && node.props['data-games-pane-icon']),
    'a closed pane puts a small game icon in the status bar')
  assert.equal(words(statusDoor).trim(), 'Play while you code', 'with the words beside it')
  assert.equal(statusDoor.props['aria-label'], 'Play while you code', 'and the same words for a screen reader')
  assert.equal(statusDoor.props.autoFocus, false, 'it never takes the keyboard')
  assert.ok(!nodes(statusDoor).some(node => node.props && node.props['data-games-version']),
    'and it is not a version chip')
  sandbox.doorOpened = 0
  evaluate('openWaitPane = () => { doorOpened += 1; return true }')
  statusDoor.props.onClick()
  assert.equal(sandbox.doorOpened, 1, 'one press on the status item opens the pane')
  evaluate('openWaitPane = realOpen')

  // The Game Center main screen: the door is a real button in the header, in the same row as
  // the wallet chip, and it follows the pane's state.
  const doorView = {
    viewer_id: 'me', player: { name: 'Ada', named: true }, allow_ai: true,
    store: [{ id: 'connect4', title: 'Connect Four', kind: 'table', installed: true }],
    play: [{ id: 'connect4', title: 'Connect Four', kind: 'table', installed: true }],
    your_games: [], labs_games: [], your_suggestions: [], makers: { note: '', notice: '', items: [] },
    lobby: { lines: [], looking: [] }
  }
  const doorCtx = {
    storage: { get: (key, fallback) => fallback, set: () => {} },
    rest: async path => (path === '/view' ? doorView : path === '/jackpot' ? { chips: 10, bonus: 20 } : { text: '', picture: null })
  }
  const realInterval = sandbox.setInterval
  sandbox.setInterval = () => 1
  sandbox.clearInterval = () => {}
  sandbox.pageProps = { ctx: doorCtx }
  const drawPage = () => {
    cursor = 0
    const drawn = evaluate('GameCenterPage(pageProps)')
    const pending = effects; effects = []
    pending.forEach(effect => effect())
    return drawn
  }
  try {
    evaluate("window.sessionStorage.removeItem('gameshelf-pane-chrome')")
    evaluate('WAIT_PANE_SLOT.dispose = null')
    reset()
    drawPage()
    await new Promise(resolve => setImmediate(resolve))
    const pageTree = drawPage()
    const headerDoor = findButton(pageTree, 'Play while you code')
    assert.ok(headerDoor, 'the main screen carries the door in its header')
    assert.equal(headerDoor.props['data-games-pane-door'], 'open')
    const chipRow = nodes(pageTree).find(node => [].concat((node.props && node.props.children) || [])
      .some(child => child && typeof child === 'object' && child.type && child.type.name === 'PointsChip'))
    assert.ok(chipRow && [].concat(chipRow.props.children).some(child => child && child.props && child.props['data-games-pane-door']),
      'and it stands in the header row with the chips')
    // The pane comes on screen: the same header button reads Close side pane. (The page is not
    // reset here on purpose: the pane's own door announces itself, and the header follows.)
    evaluate('WAIT_PANE_SLOT.dispose = () => {}')
    evaluate("window.dispatchEvent(new CustomEvent('gameshelf:pane-chrome'))")
    const openTree = drawPage()
    assert.ok(findButton(openTree, 'Close side pane'), 'with the pane open the header button says what the next press does')
    assert.equal(findButton(openTree, 'Play while you code'), undefined, 'and not both at once')
  } finally {
    sandbox.setInterval = realInterval
    reset()
    evaluate('WAIT_PANE_SLOT.dispose = null')
  }
  console.log('the pane door: header button, status item, one state: passed')
}

// The talking table: setup, seats round the table, one click per move, the message box
// only while that game is in a talking phase, the reveal, and the share/save controls.
async function talkTableContract() {
  const talkCalls = []
  const seat = (index, over = {}) => ({
    seat: index, env_seat: index, name: ['Ada', 'Wren', 'Ash', 'Rook', 'Iris', 'Bram'][index] || `Seat ${index}`,
    avatar: '✦', colour: '#d9a441', kind: index === 0 ? 'human' : 'local', you: index === 0,
    role: '', out: false, note: '', score: 0, playing: false, in_match: true, ...over
  })
  const places = [seat(0), seat(1, { playing: true }), seat(2), seat(3), seat(4), seat(5)]
  const setup = {
    schema_version: 2, view: 'mafia', game: 'mafia', title: 'Mafia',
    status: 'idle', preview: true, phase: 'Not started',
    places, log: [], actions: [], can_say: false, can_move: false, can_step: false,
    your_seat: null, your_turn: false, turn_seat: null, turn_name: '', mine: {}, draft: [],
    notes: [], calls: { used: 0, cap: 0, illegal: 0, fallbacks: 0, tokens: 0, ms: 0 },
    estimate: 12, reveal: null, standings: [], share: null,
    blurb: 'Six seats, two mafia. Talk by day, vote someone out.',
    limits: { min: 6, max: 10, default: 6 }, baseline: 6,
    champions: [{ id: 'champ-11111111', name: 'Rook', glyph: '♜', colour: '#d9a441' }],
    permissions: { can_manage: true, can_rematch: false, can_step: false, can_move: false }
  }
  const props = {
    game: { id: 'mafia', title: 'Mafia', installed: true, kind: 'play' },
    view: { opponent: { model: 'test-model' }, player: { id: 'me' } },
    board: { picture: setup },
    send: async line => { talkCalls.push(line); return { text: 'OK', ok: true } },
    onBack: () => talkCalls.push('back'),
    refresh: async () => {},
    ctx: { rest: async () => ({ ok: true, text: 'ok' }) }
  }
  sandbox.talkProps = props
  const draw = () => {
    cursor = 0
    const tree = evaluate('TalkingTable(talkProps)')
    const pending = effects
    effects = []
    pending.forEach(effect => effect())
    return tree
  }
  const settle = () => new Promise(resolve => setImmediate(resolve))
  reset()

  // --- setup: seats, champions, and the estimate before anything starts.
  let tree = draw()
  assert.ok(words(tree).includes('Mafia'))
  assert.ok(words(tree).includes('Talk by day'), 'the setup explains the game: ' + words(tree).slice(0, 200))
  assert.ok(findButton(tree, '6 seats') && findButton(tree, '10 seats'), 'seat counts are offered as buttons')
  assert.ok(words(tree).includes('No model is needed'), 'a table of computers says so')
  findButton(tree, '8 seats').props.onClick()
  tree = draw()
  findButton(tree, 'Invite Rook').props.onClick()
  tree = draw()
  assert.ok(findButton(tree, 'Rook is in'), 'a champion can be invited by name')
  assert.ok(words(tree).includes('ask a model about 12 time'), 'the model estimate is shown before starting: ' + words(tree).slice(0, 300))
  findButton(tree, 'Start the game').props.onClick()
  await settle()
  assert.equal(talkCalls.pop(), 'mafia new seats=8 champions=champ-11111111')

  // --- a refused start is said on the setup screen, where the person is standing.
  const goodSend = props.send
  props.send = async () => ({ ok: false, text: 'That game file is not one of ours.' })
  findButton(draw(), 'Start the game').props.onClick()
  await settle()
  tree = draw()
  assert.ok(words(tree).includes('That game file is not one of ours.'),
    'a refused start is shown on the setup screen: ' + words(tree).slice(0, 300))
  props.send = goodSend

  // --- AI off: there is no one to sit with, so the screen says why and offers nothing.
  const goodView = props.view
  props.view = { ...props.view, allow_ai: false }
  tree = draw()
  assert.equal(findButton(tree, 'Start the game').props.disabled, true,
    'AI off disables starting a talking table')
  assert.equal(findButton(tree, 'Watch computers play').props.disabled, true)
  assert.equal(findButton(tree, 'Seat your agent').props.disabled, true)
  assert.ok(words(tree).includes('AI is off for this profile'), words(tree).slice(0, 300))
  props.view = goodView

  // --- playing: seats round the table, your own role only, a click per move.
  props.board = {
    picture: {
      ...setup, status: 'active', preview: false, phase: 'Day 1 · voting',
      mine: { role: 'Detective' }, can_move: true, your_turn: true, your_seat: 0,
      turn_seat: 0, turn_name: 'Ada', can_say: false,
      actions: [
        { id: 'vote-1', label: 'Player 2', hint: 'Vote out', on: false, group: '' },
        { id: 'vote-2', label: 'Player 3', hint: 'Vote out', on: false, group: '' }
      ],
      log: [{ seat: 1, name: 'Wren', text: 'I think Player 3 is quiet.', kind: 'say' },
            { seat: null, name: '', text: 'Player 4 was eliminated by vote.', kind: 'game' }],
      standings: [{ seat: 0, name: 'Ada', score: 0 }, { seat: 1, name: 'Wren', score: 0 }],
      calls: { used: 3, cap: 40, illegal: 0, fallbacks: 0, tokens: 90, ms: 800 }
    }
  }
  tree = draw()
  const drawnSeats = nodes(tree).filter(node => node.props && node.props.className === 'games-talk-seat')
  assert.equal(drawnSeats.length, 6, 'every seat is drawn round the table')
  assert.ok(words(tree).includes('Your role'), 'the middle of the table shows the person their role')
  assert.ok(words(tree).includes('Detective'))
  assert.equal(nodes(tree).filter(node => node.props && node.props['data-role'] === 'Detective').length, 0,
    'a role is never painted on a seat')
  assert.ok(words(tree).includes('Wren:'), 'the log names the speaker')
  assert.ok(words(tree).includes('I think Player 3 is quiet.'))
  assert.ok(words(tree).includes('Player 4 was eliminated by vote.'))
  assert.ok(words(tree).includes('Built-in player'), 'the machine seats are labelled')
  const chat = nodes(tree).find(node => node.type === 'input' && node.props.maxLength === 200)
  assert.equal(chat.props.disabled, true, 'the message box is shut when it is not a talking phase')
  findButton(tree, 'Player 2').props.onClick()
  await settle()
  assert.equal(talkCalls.pop(), 'mafia act vote-1', 'a vote is one click, never typing')
  tree = draw()
  findButton(tree, 'Back').props.onClick()
  assert.equal(talkCalls.pop(), 'back')

  // --- talking: the box opens only when this game is in a talking phase.
  props.board.picture = {
    ...props.board.picture, phase: 'Day 1 · talking', can_say: true, actions: []
  }
  tree = draw()
  const openChat = nodes(tree).find(node => node.type === 'input' && node.props.maxLength === 200)
  assert.equal(openChat.props.disabled, false, 'a person may talk on their turn')
  openChat.props.onChange({ target: { value: 'I am watching the quiet ones.' } })
  tree = draw()
  nodes(tree).find(node => node.type === 'input' && node.props.maxLength === 200)
    .props.onKeyDown({ key: 'Enter' })
  await settle()
  assert.equal(talkCalls.pop(), 'mafia say I am watching the quiet ones.')

  // --- thinking: the seat that is taking its turn says so.
  props.board.picture = {
    ...props.board.picture, can_move: false, your_turn: false, can_say: false, can_step: true,
    turn_seat: 1, turn_name: 'Wren', actions: [],
    places: places.map(place => ({ ...place, playing: place.seat === 1 }))
  }
  tree = draw()
  assert.ok(words(tree).includes('thinking…'), 'the acting seat shows that it is thinking')
  assert.ok(words(tree).includes('Wren is thinking…'))
  reset()

  // --- the end: reveal, scores, rematch and the share controls.
  props.board.picture = {
    ...props.board.picture, status: 'done', can_step: false, can_move: false, turn_seat: null,
    places: places.map(place => ({ ...place, role: '' })),
    reveal: { roles: [{ seat: 0, role: 'Detective' }, { seat: 1, role: 'Mafia' }],
              winners: [1], reason: 'Mafia reached parity with villagers. Mafia wins!' },
    standings: [{ seat: 0, name: 'Ada', score: -1 }, { seat: 1, name: 'Wren', score: 1 }],
    share: { schema: 1, game: 'mafia', sessions: [] }
  }
  tree = draw()
  const reveal = nodes(tree).find(node => node.props && node.props['aria-label'] === 'Reveal')
  assert.ok(reveal, 'the reveal is shown at the end')
  assert.ok(words(reveal).includes('Mafia'), 'every role is named in the reveal')
  assert.ok(words(tree).includes('The game is over.'))
  assert.ok(findButton(tree, 'Save the game file'), 'the finished game can be saved as a file')
  assert.ok(findButton(tree, 'Play again'))
  findButton(tree, 'Play again').props.onClick()
  await settle()
  assert.equal(talkCalls.pop(), 'mafia rematch')
  tree = draw()
  findButton(tree, 'Save the game file').props.onClick()
  tree = draw()
  assert.ok(words(tree).includes('Saved the game file.') || words(tree).includes('This window cannot save files.'),
    'saving says what happened either way')
  reset()

  // --- the auction: bid chips grouped by lot, then one secret send.
  props.game = { id: 'blind-auction', title: 'Blind Auction', installed: true, kind: 'play' }
  props.board = {
    picture: {
      ...setup, game: 'blind-auction', view: 'blind-auction', title: 'Blind Auction',
      status: 'active', preview: false, phase: 'Bidding · send your secret bids', phase_kind: 'act',
      places: [seat(0), seat(1)], your_seat: 0, can_move: true, your_turn: true, can_say: false,
      mine: { capital: 900, items: [{ item: 0, name: 'Silver Chalice', value: 300 }] },
      actions: [
        { id: 'bid-0-120', label: '120 for Silver Chalice', hint: 'worth 300 to you', on: false, group: 'Item 0' },
        { id: 'bid-0-180', label: '180 for Silver Chalice', hint: 'worth 300 to you', on: false, group: 'Item 0' },
        { id: 'send', label: 'Send these bids', hint: 'They stay secret', on: false, group: '' },
        { id: 'pass', label: 'Bid on nothing', hint: 'Keep every coin', on: false, group: '' }
      ],
      log: [], standings: [], draft: [], notes: [], reveal: null, share: null
    }
  }
  tree = draw()
  assert.ok(words(tree).includes('Item 0'), 'the lots are grouped')
  assert.ok(words(tree).includes('Silver Chalice'), 'the lot is named on the table')
  assert.ok(words(tree).includes('300 to you'), 'your own valuation is on the table, not only in a tooltip')
  assert.ok(findButton(tree, 'Send these bids'))
  findButton(tree, '120 for Silver Chalice').props.onClick()
  await settle()
  assert.equal(talkCalls.pop(), 'blind-auction act bid-0-120')
  tree = draw()
  findButton(tree, 'Send these bids').props.onClick()
  await settle()
  assert.equal(talkCalls.pop(), 'blind-auction act send', 'the whole secret bid set is one click')
  reset()

  // --- the log speaks the buttons' words, never machine tokens (the bug hunt).
  props.game = { id: 'liars-dice', title: "Liar's Dice", installed: true, kind: 'play' }
  props.board = {
    picture: {
      ...setup, game: 'liars-dice', view: 'liars-dice', title: "Liar's Dice",
      status: 'active', preview: false, phase: 'Bidding · the bid is 2 × 3s', phase_kind: 'act',
      places: [seat(0, { note: '3 dice' }), seat(1, { note: '1 die' }), seat(2, { note: '5 dice' })],
      your_seat: 0, can_move: true, your_turn: true, can_say: false, can_step: false,
      mine: {}, bid: { quantity: 2, face: 3 }, dice_left: 9,
      actions: [
        { id: 'call', label: 'Call the bid a lie', hint: 'Reveal the dice', on: false, group: '' },
        { id: 'bid-3-3', label: '3 × 3s', hint: 'One more die', on: false, group: 'One more die' }
      ],
      log: [{ seat: 1, name: 'Wren', text: 'bid 2 × 3s', kind: 'say' },
            { seat: 0, name: 'Ada (you)', text: 'called the bid a lie', kind: 'say' },
            { seat: null, name: '', text: 'Wren has no dice left.', kind: 'game' }],
      standings: [{ seat: 0, name: 'Ada', score: 1 }], calls: { used: 0, cap: 40 }, notes: [],
      reveal: null, share: null, think: [], coach: null
    }
  }
  tree = draw()
  const said = words(tree)
  assert.ok(said.includes('bid 2 × 3s') && said.includes('called the bid a lie'),
    'the log says what the move was in the buttons’ words: ' + said.slice(0, 400))
  assert.ok(!/\[Bid:|\[Call\]/.test(said), 'no machine action tokens reach the table log')
  assert.ok(/\b1 die\b/.test(said) && !/1 dice/.test(said), 'one die is a die: ' + (said.match(/seat \d|[^ ]*dice|[^ ]*die/g) || []).join(' '))
  assert.ok(said.includes('3 dice'), 'and several are dice')
  reset()
  console.log('talking table: setup, seats, clicks, reveal and share: passed')
}

// The end of a game must be unmissable: a big card on the board that names what
// decided it, the deciding cells ringed under it, no turn dot, and the four ways on.
async function resultContract() {
  reset()
  props.view = { player: { id: 'me' }, viewer_id: 'me', allow_ai: true }
  props.game = { id: 'chessboard', title: 'Chess', installed: true, bots: true }
  props.send = async line => { calls.push(line); return { text: 'OK' } }
  props.playMove = async (...args) => calls.push(args)
  const seats = [
    { side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false },
    { side: 'black', kind: 'local', name: 'Computer', open: false }
  ]
  props.board.picture = {
    ...active, game: 'chessboard', view: 'chess', table_id: 'mate-1', seats,
    status: 'win', winner: 'black', result_reason: 'rules', result_detail: 'checkmate',
    check: false, highlight: [{ row: 0, col: 4 }], last: 'd8h4', last_to: { row: 0, col: 7 }
  }
  tree = render()
  const hero = nodes(tree).find(node => node.props.className === 'games-board-hero')
  assert.ok(hero, 'the board is on the screen')
  assert.ok(nodes(hero).some(node => node.props.className === 'games-result'), 'the result card is ON the board')
  assert.ok(words(tree).includes('Checkmate! Computer wins'), 'the deciding thing and the winner: ' + words(tree).slice(0, 200))
  assert.ok(nodes(tree).some(node => node.props['aria-label'] === 'Game over'), 'and it is announced')
  assert.equal(nodes(tree).filter(node => node.props.className === 'games-turn-dot').length, 0, 'the turn indicator stops')
  ;['Rematch', 'New game (Intermediate)', 'Review my game', 'Back to games'].forEach(label => {
    assert.ok(findButton(tree, label), `the result card offers ${label}`)
  })
  // The deciding thing is ringed by the drawing itself, under the card.
  assert.equal(evaluate(`(() => {
    const cells = Array.from({ length: 8 }, () => Array(8).fill('.'))
    const drawn = renderGrid({ cells, files: 'abcdefgh', ranks: [8,7,6,5,4,3,2,1], view: 'chess', legal: [], highlight: [{ row: 0, col: 4 }] }, {})
    return drawn.kids.filter(kid => kid && kid.props && kid.props.className === 'games-decider').length
  })()`), 1, 'the mated king is ringed in red')
  // The card is put away only by hand, and the result stays on the page when it is.
  findButton(tree, 'Look at the board').props.onClick()
  tree = render()
  assert.ok(!nodes(tree).some(node => node.props.className === 'games-result'), 'the card can be put away by hand')
  assert.ok(nodes(tree).some(node => node.props.className === 'games-result-bar'), 'but the result stays on the page')
  findButton(tree, 'Show result').props.onClick()
  tree = render()
  assert.ok(nodes(tree).some(node => node.props.className === 'games-result'), 'and comes back')
  // New game keeps the opponent and the level.
  const beforeNew = calls.length
  findButton(tree, 'New game (Intermediate)').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, beforeNew + 1)
  assert.equal(calls.at(-1), 'allow-ai chessboard black=local level=intermediate', 'New game keeps the computer and its level')
  // Back to games leaves the table.
  tree = render()
  findButton(tree, 'Back to games').props.onClick()
  assert.equal(calls.at(-1), 'back')
  reset()
  // A win for the person is said in the second person.
  props.game = { id: 'connect4', title: 'Connect Four', installed: true, bots: true }
  props.board.picture = {
    ...active, game: 'connect4', view: 'connect4', table_id: 'win-1', seats,
    status: 'win', winner: 'white', result_detail: 'four', highlight: [{ row: 5, col: 0 }, { row: 5, col: 1 }],
    last: '3', last_to: { row: 5, col: 2 }
  }
  tree = render()
  assert.ok(words(tree).includes('Four in a row! You win!'), 'a win is written in the second person: ' + words(tree).slice(0, 160))
  reset()
  // A draw names its own rule.
  props.board.picture = {
    ...active, game: 'chessboard', view: 'chess', table_id: 'draw-1', seats,
    status: 'draw', winner: '', result_detail: 'repetition', highlight: []
  }
  tree = render()
  assert.ok(words(tree).includes('Draw by repetition.'), 'a draw names the rule: ' + words(tree).slice(0, 160))
  assert.ok(findButton(tree, 'Rematch'))
  reset()
  // Check is said out loud while the game is still going.
  props.board.picture = {
    ...active, game: 'chessboard', view: 'chess', table_id: 'check-1', seats,
    status: 'active', turn: 'white', check: true, highlight: [{ row: 7, col: 4 }], legal: ['e1e2']
  }
  tree = render()
  assert.ok(words(tree).includes('Check!'), 'chess shows Check!')
  assert.ok(nodes(tree).some(node => node.props.className === 'games-check'))
  assert.equal(nodes(tree).filter(node => node.props.className === 'games-turn-dot').length, 1, 'the turn dot stays while play goes on')
  reset()
  // A game that cannot be drawn offers no draw, and never mentions one.
  props.game = { id: 'hex', title: 'Hex', installed: true, bots: true, draws: false }
  props.board.picture = {
    ...active, game: 'hex', view: 'hex', table_id: 'hex-1', seats, draws_allowed: false,
    status: 'active', turn: 'white', legal: ['a1']
  }
  tree = render()
  assert.ok(!findButton(tree, 'Offer draw'), 'Hex offers no draw')
  assert.ok(!words(tree).includes('Draws'), 'and no draw is counted on its score line')
  assert.equal(evaluate(`tableAccess(${JSON.stringify({ ...props.board.picture, seats })}, props.view).can_draw`), false)
  reset()
  // A counted game has to say the count on the card. The bug hunt's Go win screen
  // said only "Counted up. Computer wins" and hid 88.5 to 0 inside Advanced.
  props.game = { id: 'go', title: 'Go', installed: true, bots: true }
  props.board.picture = {
    ...active, game: 'go', view: 'gomoku', table_id: 'go-1', seats,
    status: 'win', winner: 'black', result_reason: 'score', result_detail: 'score',
    score_now: { white: 0, black: 88.5 }, komi: 7.5, draws: false
  }
  tree = render()
  const counted = words(tree)
  assert.ok(counted.includes('Counted up.'), 'the counted game keeps its headline')
  assert.ok(counted.includes('Final count: white 0, black 88.5 (black includes 7.5 komi).'),
    'and says the count, komi and all, without opening Advanced: ' + (counted.match(/Final count[^\n]*/) || [''])[0])
  props.board.picture = { ...props.board.picture, score_now: undefined, komi: undefined }
  assert.ok(!words(render()).includes('Final count'), 'a game that counts nothing says no count')
  reset()
  // Leave the shared fixture the way the other contracts expect to find it.
  props.game = { id: 'connect4', title: 'Connect Four', installed: true, bots: true }
  props.view = { player: { id: 'spectator' }, allow_ai: true }
  props.board.picture = { ...active, table_id: 'table-1', view: 'connect4', moves: ['4', '5'], plies: 2, score: { white: 2, black: 1, draws: 3 } }
  console.log('game result overlay, check and draws: passed')
}

// Watch it think and the corner coach: the owner's private panel, the states of
// the whisper box, and the line a watcher sees instead. The panel is drawn by
// TalkingTable; the coach box is its own component, so it is drawn directly.
async function watchItThinkContract() {
  const calls = []
  const seat = (index, over = {}) => ({
    seat: index, env_seat: index, name: ['Ada', 'Wren', 'Ash'][index] || `Seat ${index}`,
    avatar: ['♞', '♜', '♛'][index] || '●', colour: '#d9a441',
    kind: index === 0 ? 'human' : index === 1 ? 'agent' : 'local', you: index === 0,
    role: '', out: false, note: '', score: 0, playing: false, in_match: true, ...over
  })
  const places = [seat(0), seat(1), seat(2)]
  const base = {
    schema_version: 2, view: 'liars-dice', game: 'liars-dice', title: "Liar's Dice",
    status: 'active', preview: false, phase: 'Bidding · the bid is 2 × 3s',
    places, log: [], actions: [], can_say: false, can_move: false, can_step: true,
    your_seat: 0, your_turn: false, turn_seat: 1, turn_name: 'Wren', mine: {}, draft: [],
    notes: [], calls: { used: 2, cap: 40, illegal: 0, fallbacks: 0, tokens: 40, ms: 900 },
    estimate: 12, reveal: null, standings: [], share: null,
    think: [], coach: null
  }
  const props = {
    game: { id: 'liars-dice', title: "Liar's Dice", installed: true, kind: 'play' },
    view: { opponent: { model: 'test-model' }, player: { id: 'me' } },
    board: { picture: base },
    send: async line => { calls.push(line); return { text: 'Whispered.', ok: true } },
    onBack: () => calls.push('back'),
    refresh: async () => {},
    ctx: { rest: async () => ({ ok: true }) }
  }
  sandbox.thinkProps = props
  const draw = () => {
    cursor = 0
    const tree = evaluate('TalkingTable(thinkProps)')
    const pending = effects
    effects = []
    pending.forEach(effect => effect())
    return tree
  }
  reset()

  // --- waiting: the panel says whose working will appear, and that it is private.
  let tree = draw()
  assert.ok(words(tree).includes('Inside its head'), 'the panel is on the table screen')
  assert.ok(words(tree).includes('only you'), 'the panel says who may read it')
  assert.ok(words(tree).includes('has not moved yet'), 'an empty panel says why it is empty')
  assert.ok(!words(tree).includes('[Bid: 2, 3]'), 'nothing is invented before the bot moves')

  // --- a bot that has moved: Read answers, its working and the action it took.
  props.board.picture = {
    ...base,
    think: [{
      seat: 1, name: 'Wren', avatar: '♜', action: '[Bid: 3, 4]', coach: '', at: 1, fallback: false,
      read: [
        { key: 'know', label: 'What I know', text: 'Two fours and a six is a fair base.' },
        { key: 'saw', label: 'What they did', text: 'Player 2 raised twice, fast.' },
        { key: 'believe', label: 'What they want me to believe', text: 'That the table is full of fives.' },
        { key: 'safe', label: 'My safest line', text: 'Call only if the count passes six.' }
      ],
      scratch: 'Two fours is a fair base. Their quick raises look like a bluff.'
    }]
  }
  tree = draw()
  const panel = nodes(tree).find(node => node.props && node.props['aria-label'] === 'Inside its head')
  assert.ok(panel, 'the panel is a named region')
  assert.ok(words(panel).includes('What I know'), 'the Read checklist is shown with its plain labels')
  assert.ok(words(panel).includes('Two fours and a six is a fair base.'), 'the answer is shown')
  assert.ok(words(panel).includes('Their quick raises look like a bluff.'), 'the working is shown')
  assert.ok(words(panel).includes('[Bid: 3, 4]'), 'the action it chose is shown')
  assert.ok(nodes(panel).some(node => node.props && node.props.className === 'games-think-scratch'),
    'the working is drawn in its own quiet block')
  assert.ok(!JSON.stringify(tree).includes('games-think.read'), 'the panel is not a form')

  // --- a covered turn says so, rather than pretending the bot thought it out.
  props.board.picture = {
    ...props.board.picture,
    think: [{ ...props.board.picture.think[0], read: [], scratch: '', fallback: true }]
  }
  tree = draw()
  assert.ok(words(tree).includes('the built-in player took that turn'),
    'a model that failed is reported honestly')

  // --- a watcher: no owned seat, so a short honest line instead of the panel.
  props.board.picture = {
    ...base, your_seat: null, watching: true, can_step: true,
    places: places.map(place => ({ ...place, kind: 'local', you: false }))
  }
  tree = draw()
  assert.ok(words(tree).includes('Their thinking stays private at a table you are not sitting at.'),
    'a watcher is told plainly why there is no panel: ' + words(tree).slice(0, 240))
  assert.ok(!words(tree).includes('What I know'), 'a watcher is shown no Read answers')

  // --- the coach box: open with a draining clock, typing, then the whisper.
  const coachOpen = {
    open: true, until: Math.floor(Date.now() / 1000) + 12, seconds_left: 12,
    text: '', used_round: false, round: 'dice-15-alive-3', seat: 1, name: 'Wren', available: true
  }
  sandbox.coachPicture = { coach: coachOpen, places }
  sandbox.coachWhisper = async text => { calls.push(`liars-dice coach ${text}`); return true }
  // The coach box is a component with its own state, so it is drawn the same way
  // every time: hooks start at the first slot, and its effects run after the draw.
  let coachDrawn = false
  const renderCoach = () => {
    // A fresh hook table for the first draw only: this component's own state must
    // not read another screen's slots, but it must survive its own re-renders.
    if (!coachDrawn) {
      reset()
      coachDrawn = true
    }
    cursor = 0
    const drawn = evaluate('TalkCoachBox({ pictured: coachPicture, whisper: coachWhisper, busy: false })')
    const pending = effects
    effects = []
    pending.forEach(effect => effect())
    return drawn
  }
  let box = renderCoach()
  assert.ok(words(box).includes('Corner Coach'))
  assert.ok(words(box).includes('12') || words(box).includes('11'), 'the clock is shown')
  const coachInput = nodes(box).find(node => node.type === 'input' && node.props.maxLength === 120)
  assert.ok(coachInput, 'the whisper is one sentence, capped at 120 characters')
  assert.equal(coachInput.props.disabled, false)
  coachInput.props.onChange({ target: { value: 'Hold the bid one higher, then call it.' } })
  box = renderCoach()
  findButton(box, 'Whisper').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.pop(), 'liars-dice coach Hold the bid one higher, then call it.')

  // --- spent and closed states say what happened, and offer no box.
  sandbox.coachPicture = {
    coach: { ...coachOpen, open: false, used_round: true, text: 'Hold the bid one higher.' }, places
  }
  box = renderCoach()
  assert.ok(words(box).includes('sent'), 'a spent whisper says so')
  assert.ok(words(box).includes('Hold the bid one higher.'), 'the sentence it sent is echoed')
  assert.equal(nodes(box).find(node => node.type === 'input'), undefined, 'no box once it is spent')

  sandbox.coachPicture = {
    coach: { ...coachOpen, open: false, used_round: false, until: 0, seconds_left: 0 }, places
  }
  box = renderCoach()
  assert.ok(words(box).includes('One whisper a round'), 'a closed window says when it opens again')
  assert.equal(nodes(box).find(node => node.type === 'input'), undefined)

  // --- a table with no bot of yours has no coach at all.
  sandbox.coachPicture = { coach: { ...coachOpen, available: false }, places }
  box = renderCoach()
  assert.equal(box, null, 'no coach box on a table where you own no bot')

  // --- the log line the whisper leaves behind.
  props.board.picture = {
    ...base,
    log: [{ seat: 1, name: 'Coach', text: 'whispered: "Hold the bid one higher."', kind: 'coach' }]
  }
  tree = draw()
  const log = nodes(tree).find(node => node.props && node.props['aria-label'] === 'Table log')
  assert.ok(words(log).includes('Coach:'), 'the log names the whisper as the coach')
  assert.ok(words(log).includes('whispered: "Hold the bid one higher."'))
  reset()
  console.log('watch it think and the corner coach: panel, privacy and whisper states: passed')
}

// Liar's Dice 2v2: four seats, two teams, one shared pool each, the Labs badge,
// the four strength buttons, and a win/lose overlay that names the team.
async function teamTableContract() {
  const calls = []
  const seat = (index, over = {}) => ({
    seat: index, env_seat: index, name: ['Ada', 'Ash', 'Rook', 'Iris'][index],
    avatar: '✦', colour: '#d9a441', kind: index === 0 ? 'human' : 'local', you: index === 0,
    role: '', out: false, note: '5 dice', score: 0, playing: false, in_match: true, ...over
  })
  const places = [seat(0), seat(1), seat(2), seat(3)]
  const teams = [
    { team: 0, seats: [0, 2], dice: 10, out: false, spread: [5, 5] },
    { team: 1, seats: [1, 3], dice: 10, out: false, spread: [5, 5] }
  ]
  const preview = {
    schema_version: 2, view: 'liars-dice-2v2', game: 'liars-dice-2v2', title: "Liar's Dice 2v2",
    status: 'idle', preview: true, phase: 'Not started', places, log: [], actions: [],
    can_say: false, can_move: false, can_step: false, your_seat: null, your_turn: false,
    turn_seat: null, turn_name: '', mine: {}, draft: [], notes: [], reveal: null,
    calls: { used: 0, cap: 0, illegal: 0, fallbacks: 0, tokens: 0, ms: 0 }, estimate: 10,
    standings: [], share: null, blurb: 'Four seats, two teams, one shared pool each.',
    limits: { min: 4, max: 4, default: 4 }, max_invites: 1, baseline: 4,
    levels: [{ id: 'beginner', label: 'Beginner' }, { id: 'intermediate', label: 'Intermediate' },
      { id: 'advanced', label: 'Advanced' }, { id: 'expert', label: 'Expert' }],
    champions: [], permissions: { can_manage: true, can_rematch: false, can_step: false, can_move: false }
  }
  const props = {
    game: { id: 'liars-dice-2v2', title: "Liar's Dice 2v2", installed: true, kind: 'play' },
    view: { opponent: { model: 'test-model' }, player: { id: 'me' }, allow_ai: true },
    board: { picture: preview },
    send: async line => { calls.push(line); return { text: 'OK', ok: true } },
    onBack: () => calls.push('back'),
    refresh: async () => {},
    ctx: { rest: async () => ({ ok: true, text: 'ok' }) }
  }
  sandbox.teamProps = props
  const draw = () => {
    cursor = 0
    const tree = evaluate('TalkingTable(teamProps)')
    const pending = effects
    effects = []
    pending.forEach(effect => effect())
    return tree
  }
  const settle = () => new Promise(resolve => setImmediate(resolve))
  reset()

  // --- setup: the seats are fixed, the strength is a row of plain buttons.
  let tree = draw()
  assert.equal(findButton(tree, '4 seats'), undefined, 'a fixed four-seat table has no seat picker')
  assert.ok(words(tree).includes('Four seats'), 'the fixed seats are explained in words')
  for (const label of ['Beginner', 'Intermediate', 'Advanced', 'Expert']) {
    assert.ok(findButton(tree, label), `${label} is offered as a button: ` + words(tree).slice(0, 200))
  }
  assert.equal(nodes(tree).find(node => node.props.role === 'combobox'), undefined, 'no drop-down on the setup')
  findButton(tree, 'Expert').props.onClick()
  tree = draw()
  findButton(tree, 'Start the game').props.onClick()
  await settle()
  assert.equal(calls.pop(), 'liars-dice-2v2 new seats=4 level=expert', 'the strength travels with the new table')

  // --- the table: two team rows, the shared pool, the bid, the badge.
  props.board = {
    picture: {
      ...preview, status: 'active', preview: false, phase: 'Bidding · 2 × 3s · pools 10 v 10',
      teams, round: 3, bid: { quantity: 2, face: 3 }, dice_left: 20,
      your_seat: 0, your_turn: true, can_move: true, can_say: true, can_step: false,
      turn_seat: 0, turn_name: 'Ada', level: 'expert',
      mine: { dice: [1, 2, 5, 2, 6], dice_left: 5, team: 0, team_dice: 10, partner: 2, partner_dice: 5, other_team_dice: 10 },
      actions: [
        { id: 'call', label: 'Call the bid a lie', hint: 'Reveal the dice', on: false, group: '' },
        { id: 'bid-3-3', label: '3 × 3s', hint: 'One more die', on: false, group: 'One more die' }
      ],
      places: [seat(0, { playing: true }), seat(1), seat(2), seat(3)]
    }
  }
  tree = draw()
  assert.ok(words(tree).includes('Your team'), 'the person knows which side is theirs')
  assert.ok(words(tree).includes('Other team'), 'and which side is not')
  assert.equal(nodes(tree).filter(node => node.props && node.props['data-team'] !== undefined).length, 2)
  assert.ok(words(tree).includes('shared pool'), 'the pool is named, not just a number')
  assert.equal(nodes(tree).filter(node => String(node.props && node.props['data-pip']) === 'full').length, 20,
    'ten pips per team, all full at the start')
  assert.ok(words(tree).includes('2 × 3s'), 'the bid is on the table')
  assert.ok(words(tree).includes("Your cup this round"), 'your own dice are drawn')
  assert.ok(words(tree).includes('Labs · experiment'), 'an experiment is badged on its own screen')
  assert.ok(findButton(tree, 'Call the bid a lie') && findButton(tree, '3 × 3s'), 'every move is a press')
  findButton(tree, '3 × 3s').props.onClick()
  await settle()
  assert.equal(calls.pop(), 'liars-dice-2v2 act bid-3-3')

  // --- a lost game says so on the table itself, by team, not by seat.
  props.board = {
    picture: {
      ...props.board.picture, status: 'done', can_move: false, can_say: false, your_turn: false,
      teams: [{ team: 0, seats: [0, 2], dice: 0, out: true, spread: [0, 0] },
        { team: 1, seats: [1, 3], dice: 2, out: false, spread: [1, 1] }],
      actions: [],
      reveal: { dice: [], teams: [{ team: 0, dice: 0 }, { team: 1, dice: 2 }], winners: [1, 3],
        reason: 'Team 2 wins: the other team has no dice left.' }
    }
  }
  tree = draw()
  assert.ok(words(tree).includes('Your team loses'), 'the loss is said in the table, in words')
  assert.equal(nodes(tree).find(node => node.props && node.props['data-outcome'] === 'lose').props['data-outcome'], 'lose')
  props.board.picture.reveal = { ...props.board.picture.reveal, winners: [0, 2], reason: 'Team 1 wins.' }
  reset()
  tree = draw()
  assert.ok(words(tree).includes('Your team wins'), 'and a win reads the same way')
  reset()
  console.log('liars dice 2v2: teams, shared pool, strength buttons and win/lose overlay: passed')
}


// The bug hunt's chess vocabulary on tables that are not chess: the game names its
// own two sides (kit.py side_words / seat_words) and the table uses those words
// everywhere a side is named — the seat row, the move history and the start screen.
// Owner's ask 2026-11-10 (1 and 2): a table always says who you are playing, and a solo
// table that seats a machine (Blackjack's dealer) is offered the same two ways on as every
// board game. The label is words over the seats the page already has: seat.kind "local" is
// the built-in player, "agent" is the person's own Hermes model.
async function soloSeatContract() {
  const humans = { side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false }
  const boardSeats = [humans, { side: 'black', kind: 'local', id: 'local', name: 'Local', open: false }]
  sandbox.seatView = { viewer_id: 'me', player: { id: 'me' }, allow_ai: true, opponent: { model: '' } }
  sandbox.boardPicture = {
    view: 'connect4', game: 'connect4', status: 'active', turn: 'white', plies: 2, seats: boardSeats,
    side_words: { white: 'Red', black: 'Yellow' }, level: 'beginner',
    levels: [{ id: 'beginner', label: 'Beginner' }], level_note: 'built-in search', legal: ['1']
  }
  // A board game names the strength the built-in player is at.
  assert.equal(evaluate('opponentWords(boardPicture, seatView, false).who'), 'You vs Computer (Beginner)')
  assert.ok(/built-in search/.test(evaluate('opponentWords(boardPicture, seatView, false).why')),
    'the tooltip says which engine really played')
  // A Hermes model in that seat is named as the model, with what it costs to have it there.
  sandbox.boardPicture = {
    ...sandbox.boardPicture,
    seats: [humans, { side: 'black', kind: 'agent', id: 'agent', name: 'Your agent', open: false }]
  }
  sandbox.seatView = { viewer_id: 'me', player: { id: 'me' }, allow_ai: true, opponent: { model: 'glm-5.3-flash' } }
  assert.equal(evaluate('opponentWords(boardPicture, seatView, false).who'), 'You vs Your Hermes model (glm-5.3-flash)')
  assert.ok(/one call per move/.test(evaluate('opponentWords(boardPicture, seatView, false).why')),
    'the tooltip says the model thinks before it fires')
  const chip = evaluate('OpponentLine({ pictured: boardPicture, view: seatView, solo: false })')
  assert.equal(chip.props['data-gm-vs'], 'agent', 'the chip carries the seat kind it read')
  assert.ok(words(chip).includes('You vs Your Hermes model (glm-5.3-flash)'), 'and the words a person reads')
  assert.ok(chip.props.title && chip.props.title.includes('glm-5.3-flash'), 'with the story behind it on hover')

  // A house table (Blackjack) has no strength to name: the seat is the dealer, and the
  // label says so rather than inventing a level it does not play at.
  sandbox.housePicture = {
    view: 'blackjack', game: 'blackjack', status: 'active', turn: 'white', plies: 0, phase: 'bet',
    seats: [{ side: 'white', kind: 'human', id: '', name: '', open: true }, { side: 'black', kind: 'local', id: 'local', name: 'Local', open: false }],
    side_words: { white: 'You', black: 'Dealer' }, level: 'intermediate',
    levels: [{ id: 'intermediate', label: 'Intermediate' }], legal: ['bet10'], bets: [10], chips: 10000, bet: 0,
    permissions: { can_move: true, can_manage: true, can_step: true }
  }
  assert.equal(evaluate('opponentWords(housePicture, seatView, true).who'), 'You vs Computer (the dealer)')
  assert.ok(/house/.test(evaluate('opponentWords(housePicture, seatView, true).why')), 'and the tooltip names the house')
  sandbox.housePicture = {
    ...sandbox.housePicture,
    seats: [sandbox.housePicture.seats[0], { side: 'black', kind: 'agent', id: 'agent', name: 'Your agent', open: false }]
  }
  assert.equal(evaluate('opponentWords(housePicture, seatView, true).who'), 'You vs Your Hermes model (glm-5.3-flash) (the dealer)')
  // The label is drawn on the felt itself, which is where a Blackjack table is read.
  const felt = evaluate('BlackjackTable({ picture: housePicture, against: opponentWords(housePicture, seatView, true), interactive: true, busy: false, onMove: () => {} })')
  assert.ok(words(felt).includes('You vs Your Hermes model (glm-5.3-flash) (the dealer)'), 'the felt says who is across it')
  const onFelt = nodes(felt).find(node => node.props && node.props['data-gm-vs'] === 'agent')
  assert.ok(onFelt && onFelt.props.title, 'the felt label carries the seat kind and explains itself on hover')

  // Two people at one keyboard, and a seat nobody has taken: named, never guessed at.
  sandbox.seatView = { viewer_id: 'bea', player: { id: 'bea' }, allow_ai: true, opponent: {} }
  sandbox.boardPicture = { ...sandbox.boardPicture, seats: [humans, { side: 'black', kind: 'human', id: 'bea', name: 'Bea', open: false }] }
  assert.equal(evaluate('opponentWords(boardPicture, seatView, false).who'), 'You vs Ada')
  sandbox.seatView = { viewer_id: 'me', player: { id: 'me' }, allow_ai: true, opponent: {} }
  sandbox.boardPicture = { ...sandbox.boardPicture, seats: [humans, { side: 'black', kind: 'human', id: '', name: '', open: true }] }
  assert.equal(evaluate('opponentWords(boardPicture, seatView, false)'), null, 'an empty seat is not an opponent')
  assert.equal(evaluate('OpponentLine({ pictured: boardPicture, view: seatView, solo: false })'), null, 'so no chip is drawn for one')

  // The page: a board game shows the chip above the board, and Blackjack offers the same
  // two ways onto a new table as every board game, without a strength row a dealer cannot
  // use (owner's ask: "the same 'New game vs computer' and 'Play my Hermes model'").
  const calls = []
  sandbox.seatPageProps = {
    game: { id: 'connect4', title: 'Connect Four', kind: 'table', installed: true, bots: true },
    view: { viewer_id: 'me', player: { id: 'me' }, allow_ai: true, opponent: { model: '' } },
    board: { picture: {
      view: 'connect4', game: 'connect4', status: 'active', turn: 'white', plies: 2, seats: boardSeats,
      side_words: { white: 'Red', black: 'Yellow' }, level: 'beginner',
      levels: [{ id: 'beginner', label: 'Beginner' }], level_note: 'built-in search', legal: ['1']
    } },
    send: async line => { calls.push(line); return { text: 'OK', ok: true } },
    playMove: async (...args) => calls.push(args), onBack: () => {}, ctx: {}
  }
  const drawPage = () => {
    reset()
    return renderPage()
  }
  // A later render of the same table keeps its state, the way the page does (reset() would
  // hand it a brand-new component with the confirmation dialog forgotten).
  const renderPage = () => {
    cursor = 0
    const drawn = evaluate('PlayTable(seatPageProps)')
    const queued = effects
    effects = []
    queued.forEach(run => run())
    return drawn
  }
  const boardGame = drawPage()
  const chipElement = nodes(boardGame).find(node => node.type && node.type.name === 'OpponentLine')
  assert.ok(chipElement, 'a board game shows the who-chip on the table')
  assert.equal(chipElement.props.solo, false, 'and reads it as a board game, not a house table')
  sandbox.pageChipProps = chipElement.props
  assert.ok(words(evaluate('OpponentLine(pageChipProps)')).includes('You vs Computer (Beginner)'),
    'and the chip says who is across the board')
  delete sandbox.pageChipProps
  reset()
  sandbox.seatPageProps.game = { id: 'blackjack', title: 'Blackjack', kind: 'table', installed: true, bots: true, solo: true }
  sandbox.seatPageProps.view = { viewer_id: 'me', player: { id: 'me' }, allow_ai: true, opponent: { model: 'glm-5.3-flash' } }
  sandbox.seatPageProps.board = { picture: { ...sandbox.housePicture, seats: [sandbox.housePicture.seats[0], { side: 'black', kind: 'local', id: 'local', name: 'Local', open: false }] } }
  let blackjack = drawPage()
  assert.ok(findButton(blackjack, 'New game vs computer'), 'Blackjack offers the computer by name')
  assert.ok(findButton(blackjack, 'Play my Hermes model'), 'and the person’s own model')
  assert.equal(nodes(blackjack).some(node => node.props && node.props['data-level']), false,
    'a dealer plays the house rules: no strength row to press')
  // A table that has not dealt a hand yet is one press: the dealer takes the seat at once.
  findButton(blackjack, 'New game vs computer').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls.slice(-1), ['allow-ai blackjack black=local level=intermediate'],
    'one press seats the built-in dealer')
  // A session with hands behind it is asked about first, then ended before the new deal -
  // the table's own rule refuses a new game while a session is open.
  sandbox.seatPageProps.board.picture = { ...sandbox.seatPageProps.board.picture, plies: 4, phase: 'play', legal: ['hit', 'stand'] }
  blackjack = renderPage()
  findButton(blackjack, 'New game vs computer').props.onClick()
  blackjack = renderPage()
  const askDeal = findButton(blackjack, 'Confirm new game')
  assert.ok(askDeal, 'a session in play asks once before it is replaced')
  await askDeal.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls.slice(-2), ['blackjack abandon', 'allow-ai blackjack black=local level=intermediate'],
    'the session is ended, then dealt again against the computer')
  // The model takes the dealer's seat through the same door.
  blackjack = renderPage()
  findButton(blackjack, 'Play my Hermes model').props.onClick()
  blackjack = renderPage()
  await findButton(blackjack, 'Confirm new game').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls.slice(-2), ['blackjack abandon', 'allow-ai blackjack black=agent level=intermediate'],
    'and the model plays the dealer, one call per move')
  // A table with no AI seat at all (Slots) keeps the single Play button it had - the
  // real manifest's bots flag does not seat an opponent on a cabinet that draws the
  // "slots" board, so the page reads the board's view, never the flag alone.
  sandbox.seatPageProps.game = { id: 'slots', title: 'Slots', kind: 'table', installed: true, bots: true, solo: true }
  sandbox.seatPageProps.view = { viewer_id: 'me', player: { id: 'me' }, allow_ai: true, opponent: {} }
  sandbox.seatPageProps.board = { picture: { view: 'slots', game: 'slots', status: 'idle', machines: [], legal: ['spin'], chips: 100, bet: 5, bets: [5], feed: [], paytable: [] } }
  const slots = drawPage()
  assert.equal(findButton(slots, 'New game vs computer'), undefined, 'a table that seats nobody offers no opponent')
  assert.equal(findButton(slots, 'Play my Hermes model'), undefined)
  assert.equal(findButton(slots, 'Start over'), undefined, 'and nothing to start over against')
  assert.equal(nodes(slots).some(node => node.props && node.props['data-gm-solo-opponents']), false, 'no solo opponent row')
  assert.ok(findButton(slots, 'Play'), 'the one Play button the cabinet has always had stays')
  delete sandbox.seatPageProps
  delete sandbox.boardPicture
  delete sandbox.housePicture
  delete sandbox.seatView
  reset()
  console.log('solo tables and who is across the table: passed')
}

async function modelPickerContract() {
  const routes = [
    { id: 'hermes-4|nous', label: 'Hermes 4', model: 'hermes-4', provider: 'nous', where: 'cloud' },
    { id: 'hermes-3|nous', label: 'Hermes 3', model: 'hermes-3', provider: 'nous', where: 'cloud' },
    { id: 'llama-3|groq', label: 'Llama 3', model: 'llama-3', provider: 'groq', where: 'cloud' }
  ]
  const picked = []
  const store = {}
  const ctx = { storage: { get: (key, fallback) => (key in store ? store[key] : fallback), set: (key, value) => { store[key] = value } } }
  const paint = current => {
    sandbox.modelPickerProps = { routes, current: current || '', onPick: item => picked.push(item), ctx, hint: 'Type to filter.' }
    cursor = 0
    const tree = evaluate('ModelPicker(modelPickerProps)')
    const pending = effects
    effects = []
    pending.forEach(effect => effect())
    return tree
  }
  const buttons = tree => nodes(tree).filter(node => node.type === 'button')
  const input = tree => nodes(tree).find(node => node.type === 'input')
  const label = node => words(node).trim()

  // The chat model is the first entry, always; every route is offered and the one the
  // seat holds is marked, not guessed from its position in the list.
  reset()
  let tree = paint('')
  let rows = buttons(tree)
  assert.ok(label(rows[0]).includes('Use my chat model'), 'Use my chat model is the first entry')
  assert.equal(rows[0].props['data-model-current'], '1', 'and is marked while the seat is on the chat model')
  assert.ok(rows.some(row => label(row).includes('Hermes 4')) && rows.some(row => label(row).includes('Llama 3')),
    'every route is offered')
  reset()
  tree = paint('llama-3|groq')
  rows = buttons(tree)
  const marked = rows.filter(row => row.props['data-model-current'] === '1')
  assert.equal(marked.length, 1, 'exactly one route is marked current')
  assert.equal(marked[0].props['data-model-id'], 'llama-3|groq', 'and it is the one the seat holds')

  // Filtering: provider and model name, case-insensitively, as the person types.
  reset()
  tree = paint('')
  input(tree).props.onChange({ target: { value: 'GROQ' } })
  tree = paint('')
  rows = buttons(tree)
  assert.ok(rows.some(row => label(row).includes('Llama 3')), 'the provider filters, whatever the case')
  assert.ok(!rows.some(row => label(row).includes('Hermes 4')), 'and hides every other provider')
  input(tree).props.onChange({ target: { value: 'hermes-3' } })
  tree = paint('')
  rows = buttons(tree)
  assert.ok(rows.some(row => label(row).includes('Hermes 3')), 'the model name filters too')
  assert.ok(!rows.some(row => label(row).includes('Llama 3')), 'and drops the rest')
  assert.ok(rows.some(row => label(row).includes('Use my chat model')), 'the chat entry is never filtered away')

  // Keyboard: down moves the highlight, Enter takes the highlighted route.
  reset()
  tree = paint('')
  rows = buttons(tree)
  const firstRoute = rows[1]
  assert.ok(firstRoute && firstRoute.props['data-model-id'], 'the first route sits under the chat entry')
  picked.length = 0
  input(tree).props.onKeyDown({ key: 'ArrowDown', preventDefault: () => {} })
  tree = paint('')
  input(tree).props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
  assert.equal(picked.length, 1, 'Enter picked one route')
  assert.equal(picked[0].id, firstRoute.props['data-model-id'], 'and picked the highlighted one')

  // Recent: a pick is remembered, and the remembered route sits above the provider groups.
  assert.ok(Array.isArray(store['gameshelf-model-recent']) && store['gameshelf-model-recent'][0] === picked[0].id,
    'the pick is remembered')
  tree = paint('')
  assert.ok(words(tree).includes('Recent'), 'a Recent group is drawn')
  const order = buttons(tree).map(row => row.props['data-model-id'])
  assert.equal(order[1], picked[0].id, 'and the last pick sits directly under the chat entry')
  reset()
  console.log('model picker: search, grouping, keyboard, current and recent: passed')
}

function sideWordsContract() {
  const seats = [
    { side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false },
    { side: 'black', kind: 'local', name: 'Local', open: false }
  ]
  const calls = []
  const props = {
    game: { id: 'connect4', title: 'Connect Four', installed: true, bots: true },
    view: { player: { id: 'me' }, allow_ai: true },
    board: { picture: {
      ...active, table_id: 'table-9', view: 'connect4', seats, moves: ['4'], plies: 3,
      score: { white: 1, black: 1, draws: 0 },
      side_words: { white: 'Red', black: 'Yellow' },
      seat_words: { white: 'Red pieces', black: 'Yellow pieces' }
    } },
    send: async line => { calls.push(line); return { text: 'OK' } },
    playMove: async (...args) => calls.push(args), onBack: () => calls.push('back'), ctx: {}
  }
  sandbox.sideProps = props
  const drawSide = () => {
    cursor = 0
    const tree = evaluate('PlayTable(sideProps)')
    const queued = effects
    effects = []
    queued.forEach(run => run())
    return tree
  }

  reset()
  const said = words(drawSide())
  assert.ok(said.includes('Red pieces · Human'), 'the seat row says whose red pieces these are')
  assert.ok(said.includes('Yellow pieces · Computer'), 'and whose yellow')
  assert.ok(!/White pieces|Black pieces/.test(said), 'a red-versus-yellow drop game never says white or black')
  assert.ok(said.includes('You · Red') && said.includes('Computer · Yellow'),
    'the move history heads its columns with the board’s own words')
  assert.ok(!/white · to move|black · to move/i.test(said), 'the row under the board is not left speaking machine sides')

  // The start screen names the model's side in the game's own words too.
  props.board.picture = {
    ...active, table_id: '', view: 'connect4', status: 'idle', seats: [], plies: 0, moves: [],
    side_words: { white: 'Red', black: 'Yellow' }
  }
  const startWords = words(drawSide())
  assert.ok(/plays yellow/.test(startWords), 'the start screen says your model plays yellow, not black')
  assert.ok(findButton(drawSide(), 'Play my Hermes model(s)'), 'and still offers the Hermes seats by name')

  // Kalah counts seeds in pits and stores; the board labels them bottom and top.
  props.game = { id: 'kalah', title: 'Kalah', installed: true, bots: true }
  props.board.picture = {
    ...active, table_id: 'table-10', view: 'kalah', seats, moves: ['1'], plies: 1,
    side_words: { white: 'Bottom', black: 'Top' },
    seat_words: { white: 'Bottom pits and store', black: 'Top pits and store' }
  }
  const kalahWords = words(drawSide())
  assert.ok(kalahWords.includes('Bottom pits and store · Human'), 'the seat row speaks seeds, not pieces')
  assert.ok(!/pieces/.test(kalahWords), 'a mancala never talks about pieces')
  sandbox.kalahBoard = {
    view: 'kalah', pits: [4, 4, 4, 4, 4, 4, 0, 4, 4, 4, 4, 4, 4, 0], legal: ['1'], turn: 'white',
    side_words: { white: 'Bottom', black: 'Top' }
  }
  const drawn = words(evaluate('renderKalah(kalahBoard, {}).kids'))
  assert.ok(drawn.includes('Bottom') && drawn.includes('Top'), 'the two stores are named for their halves')
  assert.ok(!/Black|White/.test(drawn), 'and not by chess colours')

  // A table that really does play white against black keeps the old words.
  assert.equal(evaluate('JSON.stringify(sideWordsOf(null))'), '{"white":"White","black":"Black"}')
  assert.equal(evaluate('JSON.stringify(seatWordsOf(null))'), '{"white":"White pieces","black":"Black pieces"}')
  assert.equal(evaluate('JSON.stringify(sideWordsOf({ side_words: { white: "Bottom" } }))'), '{"white":"Bottom","black":"Black"}',
    'a half-named game keeps the ordinary word for the side it did not name')
  delete sandbox.sideProps
  delete sandbox.kalahBoard
  reset()
  console.log('side words: red and yellow, bottom and top, white and black: passed')
}

// A finished talking table uses the same big result card as the board games: it
// names who won and why, and every way on is a button. This covers both plain
// games named in the bug (Liar's Dice and Mafia), played and watched.
async function talkResultContract() {
  const calls = []
  const seat = (index, name, over = {}) => ({
    seat: index, env_seat: index, name, avatar: '✦', colour: '#d9a441',
    kind: index === 0 ? 'human' : 'local', you: index === 0, role: '', out: false,
    note: '', score: 0, playing: false, in_match: true, ...over
  })
  const finished = (gameId, title, places, reveal, over = {}) => ({
    schema_version: 2, view: gameId, game: gameId, title, status: 'done', preview: false,
    phase: 'Finished', places, log: [], actions: [], can_say: false, can_move: false,
    can_step: false, your_seat: 0, your_turn: false, turn_seat: null, turn_name: '',
    mine: {}, draft: [], notes: [], calls: { used: 0, cap: 0, illegal: 0, fallbacks: 0, tokens: 0, ms: 0 },
    estimate: 0, standings: [], reveal, share: { schema: 1, game: gameId, sessions: [] },
    permissions: { can_manage: true, can_rematch: true, can_step: false, can_move: false },
    ...over
  })
  const props = {
    game: { id: 'liars-dice', title: "Liar's Dice", installed: true, kind: 'play' },
    view: { player: { id: 'me' }, allow_ai: true },
    board: { picture: null },
    send: async line => { calls.push(line); return { text: 'OK', ok: true } },
    onBack: () => calls.push('back'),
    refresh: async () => {},
    ctx: { rest: async () => ({ ok: true, text: 'ok' }) }
  }
  sandbox.talkResultProps = props
  const draw = () => {
    cursor = 0
    const tree = evaluate('TalkingTable(talkResultProps)')
    const pending = effects
    effects = []
    pending.forEach(effect => effect())
    return tree
  }
  const settle = () => new Promise(resolve => setImmediate(resolve))
  const card = tree => nodes(tree).find(node => node.props && node.props.className === 'games-result')
  reset()

  // --- Liar's Dice: the person in a seat lost. The card says who won and why,
  // and the three ways on are all buttons.
  props.board.picture = finished('liars-dice', "Liar's Dice",
    [seat(0, 'Ada'), seat(1, 'Wren')],
    { dice: [{ seat: 0, dice: [2, 2], left: 0 }, { seat: 1, dice: [5], left: 1 }],
      winners: [1], reason: 'Wren was the last player with dice.' })
  let tree = draw()
  let result = card(tree)
  assert.ok(result, 'a finished Liar\'s Dice table shows the result card')
  assert.ok(words(result).includes('You lose.'), 'the card says the seat lost: ' + words(result))
  assert.ok(words(result).includes('Wren was the last player with dice.'), 'and says why it ended')
  assert.equal(nodes(result).find(node => node.props.role === 'combobox'), undefined,
    'the result card has no drop-down')
  ;['Rematch', 'New game', 'Back'].forEach(label => assert.ok(findButton(result, label), `the card offers ${label}`))
  findButton(result, 'Rematch').props.onClick()
  await settle()
  assert.equal(calls.pop(), 'liars-dice rematch', 'Rematch starts the same seats again')
  tree = draw()
  findButton(card(tree), 'New game').props.onClick()
  await settle()
  assert.equal(calls.pop(), 'liars-dice abandon', 'New game closes the table for a fresh set-up')
  tree = draw()
  findButton(card(tree), 'Back').props.onClick()
  assert.equal(calls.pop(), 'back', 'Back leaves the table')

  // --- Mafia: the person in a seat won, and a watcher is told the winning seats
  // by name rather than left with "The game is over."
  props.game = { id: 'mafia', title: 'Mafia', installed: true, kind: 'play' }
  props.board.picture = finished('mafia', 'Mafia',
    [seat(0, 'Ada'), seat(1, 'Wren'), seat(2, 'Ash')],
    { roles: [{ seat: 0, role: 'Villager' }, { seat: 1, role: 'Mafia' }, { seat: 2, role: 'Villager' }],
      mafia: [1], winners: [0, 2], reason: 'The village won.' })
  tree = draw()
  result = card(tree)
  assert.ok(result, 'a finished Mafia table shows the result card')
  assert.ok(words(result).includes('You win!'), 'the winning seat reads as a win: ' + words(result))
  assert.ok(words(result).includes('The village won.'), 'the card says why the village won')
  props.board.picture = { ...props.board.picture, your_seat: null, mine: {} }
  tree = draw()
  result = card(tree)
  assert.ok(words(result).includes('Ada and Ash win'), 'a watcher is told the winning seats by name: ' + words(result))
  assert.equal(result.props['data-outcome'], 'watched', 'and the card is marked as a watched result')
  reset()
  console.log('talking table result card: named winner, reason and mouse-only ways on: passed')
}


// Owner's ask 2026-11-10 (#7), at page level: the Experimental section is drawn, titled
// "Experimental", and every game inside it is locked - the whole shelf renders, and nothing in it
// can be entered from the library.
async function experimentalShelfContract() {
  reset()
  sandbox.setInterval = () => 1
  sandbox.clearInterval = () => {}
  const installed = { id: 'hello', title: 'Hello', summary: 'Says hi.', plugin: 'fake-game', opens: 'screen', desktop_route: '/hello' }
  const draft = { id: 'liars-dice-2v2', title: 'Liar\'s Dice 2v2', summary: 'A bluffing table.', labs: true, installed: true, ship: true }
  const view = {
    viewer_id: 'me', player: { name: 'Ada', named: true }, allow_ai: true,
    store: [{ id: 'connect4', title: 'Connect Four', kind: 'table', installed: true }],
    play: [{ id: 'connect4', title: 'Connect Four', kind: 'table', installed: true }],
    your_games: [installed], labs_games: [draft], your_suggestions: [],
    makers: { note: '', notice: '', items: [] },
    lobby: { lines: [], looking: [] }
  }
  const ctx = { rest: async url => url === '/view' ? view : { text: '', picture: null } }
  sandbox.pageProps = { ctx }
  const page = () => {
    cursor = 0
    const drawn = evaluate('GameCenterPage(pageProps)')
    const pending = effects; effects = []; pending.forEach(effect => effect())
    return drawn
  }
  page()
  await new Promise(resolve => setImmediate(resolve))
  const tree = page()
  const mark = nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'GameCenterMark')
  assert.ok(mark, 'the Games header renders the Game Center mark')
  const svg = mark.type(mark.props)
  assert.equal(svg.type, 'svg')
  assert.equal(svg.props['data-game-center-mark'], '1')
  assert.equal(svg.props.width, 48)
  assert.ok(nodes(tree).some(node => typeof node.type === 'function' && node.type.name === 'GameCenterWordmark'), 'the header renders the wordmark')
  assert.ok(!nodes(tree).some(node => node.type === 'img' && node.props.src === evaluate('SM_ART.NOUS')), 'the Games page does not render the Nous image')
  assert.equal(nodes(tree).some(node => node.props && node.props['data-experiments'] === '1'), false, 'experiments stay off the main screen')
  assert.ok(findButton(tree, 'Play while you code'), 'the main screen header carries the pane door')
  assert.equal(findButton(tree, 'Play the computer while you wait'), undefined)
  const experimentalLink = findButton(tree, 'Experimental')
  assert.ok(experimentalLink, 'the main screen offers one Experimental link')
  experimentalLink.props.onClick()
  const section = nodes(page()).find(node => node.props && node.props['data-experiments'] === '1')
  assert.ok(section, 'the Experimental section renders as one shelf')
  assert.ok(words(section).includes('Early experiments. You can see them; they open when they are ready.'),
    'with its one short help line under the heading')
  assert.equal(nodes(section).filter(node => words(node) === 'Experimental').length, 1,
    'the section is titled Experimental, once')
  const locked = (card, id) => {
    assert.ok(card, `${id} is still shown in the section`)
    assert.equal(card.props['aria-disabled'], 'true', `${id} is announced as disabled`)
    assert.ok(String(card.props.title).includes('not open yet'), `${id} says why in its tooltip`)
    assert.ok(words(card).includes('🔒 Coming soon'), `${id} wears the lock badge`)
    return card
  }
  const byProp = (attribute, id) => nodes(section).find(node => node.props && node.props[attribute] === id)
  // An installed experiment is a component card: the page draws the element, and the card itself is
  // rendered on its own - as every component in this harness is.
  const installedElement = nodes(section).find(node => typeof node.type === 'function' && node.type.name === 'YourGameCard')
  assert.ok(installedElement && installedElement.props.item.id === 'hello', 'an installed experiment is still shown')
  sandbox.lockedCardProps = installedElement.props
  locked(evaluate('YourGameCard(lockedCardProps)'), 'an installed experiment')
  locked(byProp('data-labs-play', 'liars-dice-2v2'), 'a playable draft')
  locked(byProp('data-labs-locked', 'pet-battles'), 'Pet Battles')
  locked(byProp('data-labs-locked', 'mafia-town'), 'Mafia Town')
  // Pet Battles and Mafia Town are drawn by another file, so their own card is wrapped: the page
  // hands the card no open handler at all, and the wrapper is what says no.
  for (const name of ['PetBattlesLabsCard', 'MafiaTownCard']) {
    const element = nodes(section).find(node => typeof node.type === 'function' && node.type.name === name)
    assert.ok(element, `${name} is still shown in the section`)
    assert.equal(element.props.onOpen, undefined, `${name} is handed no way to open`)
  }
  assert.equal(nodes(section).filter(node => node.props && typeof node.props.onClick === 'function').length, 0,
    'no control in the shelf carries a click handler')
  findButton(page(), 'Back to Game Center').props.onClick()
  // The version appears in the header and remains in Settings.
  const stamp = { version: '9.9.9', commit: 'abcdef1234567890', commit_date: '2026-11-10T09:00:00-07:00', dirty: false }
  const plainRest = ctx.rest
  ctx.rest = async url => (url === '/v1/version' ? stamp : plainRest(url))
  page()
  await new Promise(resolve => setImmediate(resolve))
  const headed = nodes(page())
  assert.ok(headed.some(node => typeof node.type === 'function' && node.type.name === 'GamesVersionChip'),
    'the Games header carries the shared version chip')
  const settingsLink = findButton(headed, 'Settings')
  assert.ok(settingsLink, 'the header keeps its way into Settings')
  settingsLink.props.onClick()
  const settingsPage = page()
  const panel = nodes(settingsPage).find(node => typeof node.type === 'function' && node.type.name === 'SettingsPanel')
  assert.ok(panel, 'and it opens the one SettingsPanel — the same component the pane gear draws')
  assert.equal(panel.props.ctx, ctx, 'handed the page own context')
  assert.equal(typeof panel.props.onCommunity, 'function', 'so the community link still works on the page')
  assert.equal(typeof panel.props.onReopen, 'function', 'as does the welcome link')
  assert.equal(panel.props.backLabel, undefined, 'and the back button keeps its page wording')
  assert.equal(nodes(settingsPage).some(node => node.props && node.props['data-games-version'] === 'chip'), false,
    'the page draws no chip of its own: the panel that mounts it owns it')
  reset()
  console.log('library: the Experimental section renders, titled, with every game locked: passed')
}


lifecycle().then(() => resultContract()).then(() => ownerFeedbackContract()).then(() => pieceArtContract()).then(() => championsContract()).then(() => petSpriteContract()).then(() => iaContract()).then(() => firstRunContract()).then(() => paneContract()).then(() => paneDoorContract()).then(() => lobbyAsksContract()).then(() => soloSeatContract()).then(() => modelPickerContract()).then(() => talkTableContract()).then(() => teamTableContract()).then(() => watchItThinkContract()).then(() => onlineContract()).then(() => onlineTableContract()).then(() => petBattlesContract()).then(sideWordsContract).then(mafiaTownContract).then(mafiaTownPanelContract).then(() => talkResultContract()).then(refereeBadgeContract).then(() => hallContract()).then(() => lobbyColumnContract()).then(() => experimentalShelfContract()).then(() => gcextrasContract()).catch(error => { console.error(error); process.exitCode = 1 })
// Champions: the creator, the two divisions, the one model, and watching a
// finished tournament game back. The backend owns the rules; this checks the
// page asks for the right things and shows what came back.
// Online play in the dock: off until the person says yes, then the queue, the
// table, one alert, and the ladder with its model estimate before anything runs.
// Every action is a /online door; the pane never reaches the lobby server itself.
async function onlineContract() {
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }
  const draw = (expression, value) => {
    sandbox.paneProps = value
    cursor = 0
    const tree = evaluate(expression)
    const pending = effects
    effects = []
    pending.forEach(effect => effect())
    return tree
  }
  const play = [
    { id: 'connect4', title: 'Connect Four', kind: 'table', installed: true, bots: true },
    { id: 'reversi', title: 'Reversi', kind: 'table', installed: true, bots: true }
  ]
  const off = {
    on: false, url: 'https://games.hermesnet.xyz', linked: false, name: '', offline: false,
    disclosure: 'Online play and match alerts are off until you turn them on here. The key is kept in Hermes credentials.',
    game: '', looking: {}, waiting_names: [], match: null, alerts: {}, ladder: {}, bot: {}, alert: null
  }
  const makeCtx = (online, extra = {}) => {
    const asked = []
    const opened = []
    const notified = []
    const ctx = {
      storage: { get: (key, fallback) => (key in extra ? extra[key] : fallback), set() {}, remove() {} },
      os: {
        notify: input => notified.push(input),
        openExternal: url => { opened.push(url); return true }
      },
      runAction: () => ({ ok: true }),
      rest: async (path, options) => {
        asked.push([path, options || null])
        if (path === '/view') {
          return { player: { id: 'me', name: 'Ada', named: true }, viewer_id: 'me', allow_ai: true,
            play, lobby: { lines: [], looking: [] }, online: { ...off, ...online } }
        }
        if (path.startsWith('/board')) return { text: '', picture: null }
        if (path === '/command') return { text: 'OK', ok: true }
        if (path.startsWith('/online/ladder?')) {
          return extra.ladderAsk || { ok: true, estimate: null, model_ready: true, champions: [], status: {} }
        }
        const answer = extra.answers && extra.answers[path] ? extra.answers[path] : { ok: true, text: 'Done.' }
        if (answer.online === undefined) answer.online = { ...off, ...online, ...(answer.onlinePatch || {}) }
        return answer
      }
    }
    return { ctx, asked, opened, notified }
  }

  const open = async (runner, tab = 'lobby') => {
    reset()
    let tree = draw('WaitPane(paneProps)', { ctx: runner.ctx })
    await tick()
    tree = draw('WaitPane(paneProps)', { ctx: runner.ctx })
    findButton(tree, 'Lobby').props.onClick()
    return draw('WaitPane(paneProps)', { ctx: runner.ctx })
  }
  const onlinePaths = runner => runner.asked.map(item => item[0]).filter(path => String(path).startsWith('/online'))

  // 1. Off: the disclosure is the first thing on the section, and nothing at all
  //    is sent until the person presses the button.
  const shut = makeCtx({})
  let tree = await open(shut)
  assert.ok(words(tree).includes('Play with people online'), 'the dock names the online source')
  assert.ok(words(tree).includes('off until you turn them on'), 'the disclosure is shown before the switch')
  assert.ok(words(tree).includes('Hermes credentials'), 'and says where the key is kept')
  const turnOn = findButton(tree, 'Turn on online play')
  assert.ok(turnOn, 'turning it on is one press')
  assert.deepEqual(onlinePaths(shut), [], 'nothing is sent before the person says yes')
  await turnOn.props.onClick()
  assert.ok(shut.asked.some(item => item[0] === '/online/on'), 'the press is the one call that turns it on')

  // 2. On, no name yet: the name and the saved key are both offered, and the
  //    way out is offered too — a person who turned it on but never signed up
  //    must not be stuck with online play on.
  const named = makeCtx({ on: true })
  tree = await open(named)
  assert.ok(findButton(tree, 'Create my player'), 'a new person can pick a name')
  assert.ok(findButton(tree, 'I have a key'), 'and a returning person can paste their key')
  const offSwitch = findButton(tree, 'Turn online play off')
  assert.ok(offSwitch, 'someone with no account can still turn online play off')
  await offSwitch.props.onClick()
  assert.ok(named.asked.some(item => item[0] === '/online/off'), 'and the press is the off call')
  const nameInput = nodes(tree).find(node => node.type === 'input' && node.props.placeholder === 'Your name online')
  assert.ok(nameInput, 'the name field is there')
  nameInput.props.onChange({ target: { value: 'Ada' } })
  tree = draw('WaitPane(paneProps)', { ctx: named.ctx })
  await findButton(tree, 'Create my player').props.onClick()
  const signup = named.asked.filter(item => item[0] === '/online/signup').pop()
  assert.equal(signup[1].body.name, 'Ada', 'the typed name is what is sent')

  // A new recovery key is shown once, with a copy button, and never in the view.
  const fresh = makeCtx({ on: true }, { answers: { '/online/signup': { ok: true, text: 'You are Ada online.', key_to_copy: 'KEY-123', onlinePatch: { linked: true, name: 'Ada' } } } })
  tree = await open(fresh)
  await findButton(tree, 'Create my player').props.onClick()
  tree = draw('WaitPane(paneProps)', { ctx: fresh.ctx })
  assert.ok(words(tree).includes('KEY-123'), 'the recovery key is shown once so it can be copied')
  assert.ok(findButton(tree, 'Copy recovery key'), 'with a copy button')
  assert.ok(findButton(tree, 'Hide this key'), 'and a way to put it away')
  assert.ok(words(tree).includes('You are Ada online.'), 'the person is signed in in the same breath')

  // 3. Linked: Find a match online asks the queue for this game. The online-alert switch is NOT
  //    offered on the pane (owner's ask, 2026-11-11): it saves a flag, but the notification behind
  //    it is a no-op, so the pane does not promise it. It is still in the source, behind a gate.
  const linked = makeCtx({ on: true, linked: true, name: 'Ada' })
  tree = await open(linked)
  assert.ok(words(tree).includes('You are Ada online'))
  const findOnline = findButton(tree, 'Find a match online: Connect Four')
  assert.ok(findOnline, 'the online queue has its own button, named with the game')
  await findOnline.props.onClick()
  const queued = linked.asked.filter(item => item[0] === '/online/queue').pop()
  assert.equal(queued[1].body.game, 'connect4', 'the queue is asked for the game the pane is on')
  const alertBox = nodes(tree).find(node => node.type === 'label' && words(node).includes('Tell me when someone online wants this game'))
  assert.equal(alertBox, undefined, 'the online-alert switch is not offered on the pane')
  assert.equal(linked.asked.filter(item => item[0] === '/online/alerts').length, 0, 'and nothing is sent for it')

  // 4. A table was found: one line, one button that opens it in the browser.
  const found = makeCtx({ on: true, linked: true, name: 'Ada', game: '',
    match: { room_id: 'r1', game: 'connect4', title: 'Connect Four', side: 'black', opponent: 'Bea', url: 'https://games.hermesnet.xyz/t/r1' } })
  tree = await open(found)
  assert.ok(words(tree).includes('Your table is ready: Bea for Connect Four'), 'the match is named')
  assert.ok(words(tree).includes('You play black'))
  // Online play is inside Hermes now (owner, 2026-11-11): Play here, and no browser door.
  assert.ok(findButton(tree, 'Play here'), 'the ready table is played here')
  assert.equal(findButton(tree, 'Open in browser'), undefined, 'and there is no Open in browser any more')
  assert.deepEqual(found.opened || [], [], 'nothing opens a browser')
  await findButton(tree, 'Not now').props.onClick()
  assert.ok(found.asked.some(item => item[0] === '/online/match/close'), 'and can be put away')

  // 5. Server down: one plain sentence, and the local lobby button still works.
  const down = makeCtx({ on: true, linked: true, name: 'Ada', offline: true,
    offline_text: 'The online lobby cannot be reached right now. Everything here that runs on this computer still works.' })
  tree = await open(down)
  assert.ok(words(tree).includes('cannot be reached right now'), 'the offline state is plain')
  const localFind = findButton(tree, 'Find a match')
  assert.ok(localFind, 'the local Find a match is still there')
  await localFind.props.onClick()
  assert.ok(down.asked.some(item => item[0] === '/command' && item[1].body.line === 'looking connect4'),
    'and local play is untouched by the online server being down')

  // 6. The bot ladder and Bots & leagues are NOT on the pane (owner's ask, 2026-11-11): rated
  //    bot-versus-bot is not proven end to end, and watching a league leaves Hermes for the
  //    browser. Both are still in the source, behind their own gates.
  const ladderAsk = {
    ok: true, model_ready: true,
    estimate: { text: 'One rated ladder game of Connect Four is up to about 22 model calls on this computer, one per move, each a short text answer. The table allows 15 seconds a move.' },
    status: { state: 'idle' }, champions: [{ id: 'c1', name: 'Rook' }]
  }
  const ladderCtx = makeCtx({ on: true, linked: true, name: 'Ada' }, { ladderAsk })
  tree = await open(ladderCtx)
  assert.equal(words(tree).includes('Bot ladder'), false, 'the ladder section is not on the pane')
  assert.equal(findButton(tree, 'Enter ladder'), undefined, 'nor is its Enter ladder control')
  assert.equal(findButton(tree, 'Start ladder game'), undefined, 'nor anything to start')
  assert.equal(words(tree).includes('Bots and leagues'), false, 'and the leagues block is not on the pane either')
  assert.equal(findButton(tree, 'Read the design'), undefined, 'nor the stock league\'s design stub')
  assert.equal(findButton(tree, 'Enter the open league'), undefined, 'nor the open league door')
  assert.deepEqual(onlinePaths(ladderCtx).filter(path => path.startsWith('/online/ladder')), [],
    'and nothing at all is sent to the ladder')

  // 7. One alert, once, and never during a match or a game of the person's own.
  const tell = makeCtx({ on: true, linked: true, name: 'Ada',
    alert: { game: 'connect4', at: 500, waiting: 2, text: '2 people online wants a game of connect4 right now.' } })
  await open(tell)
  // Alerts are off for now (owner's ask, 2026-11-09): the lobby still says it in words on the
  // Lobby tab, and nothing is pushed at the person.
  assert.equal(tell.notified.length, 0, 'no alert is pushed while alerts are off')
  assert.ok(words(draw('WaitPane(paneProps)', { ctx: tell.ctx })).includes('2 people online'), 'the lobby still says it in words')
  reset()
  draw('WaitPane(paneProps)', { ctx: tell.ctx })
  assert.equal(tell.notified.length, 0, 'and still nothing is pushed')
  const quiet = makeCtx({ on: true, linked: true, name: 'Ada', alert: { game: 'connect4', at: 900, waiting: 1, text: 'Someone online wants a game of connect4.' },
    match: { room_id: 'r2', game: 'connect4', title: 'Connect Four', side: 'white', opponent: 'Cy', url: 'https://games.hermesnet.xyz/t/r2' } })
  await open(quiet)
  assert.equal(quiet.notified.length, 0, 'no alert while a table is waiting for the person')

  // 8. The plain sentences the section is built from.
  assert.ok(evaluate(`onlineLine(${JSON.stringify({ on: false })}, 'Connect Four')`).includes('Off'))
  assert.ok(evaluate(`onlineLine(${JSON.stringify({ on: true, offline: true, offlineText: 'down' })}, 'Connect Four')`).includes('down'))
  assert.ok(evaluate(`onlineLine(${JSON.stringify({ on: true, linked: true, name: 'Ada' })}, 'Connect Four')`).includes('Nothing is sent until you press'))
  assert.ok(evaluate(`onlineLine(${JSON.stringify({ on: true, linked: true, name: 'Ada', game: 'connect4' })}, 'Connect Four')`).includes('Looking for a Connect Four match'))
  assert.ok(evaluate(`ladderLine(${JSON.stringify({ state: 'playing', text: 'Playing Connect Four as white.', plies: 12 })})`).includes('Move 12'))
  assert.equal(evaluate('onlineHost("https://games.hermesnet.xyz")'), 'games.hermesnet.xyz')
  reset()
  console.log('online lobby in the dock: passed')
}

// The online table, played inside Hermes (CONTRACT C). The server's own per-seat picture is the
// board, every click is a /online/table/cmd, and a local game move can never come out of it.
// The turn line says whose move it is — and never that a Hermes model is thinking.
async function onlineTableContract() {
  sandbox.setInterval = () => 1
  sandbox.clearInterval = () => {}
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }
  const draw = (expression, name, value) => {
    sandbox[name] = value
    cursor = 0
    const tree = evaluate(expression)
    const pending = effects
    effects = []
    pending.forEach(effect => effect())
    return tree
  }
  // A poll is a round trip: draw (which starts the read), let it settle, draw again.
  const settle = async (expression, name, value) => {
    draw(expression, name, value)
    await tick()
    return draw(expression, name, value)
  }
  const onlineNode = tree => nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'OnlineTable')
  const turnLine = tree => nodes(tree).find(node => node.props && node.props['data-turn-line'] !== undefined)
  const boardNode = tree => nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'BoardSvg')
  const localCalls = []
  const game = { id: 'connect4', title: 'Connect Four', kind: 'table', installed: true, bots: true }
  const minePicture = {
    status: 'active', turn: 'white', winner: '', schema_version: 2, view: 'connect4', game: 'connect4',
    plies: 4, last: '4', legal: ['1', '2', '3', '4', '5', '6', '7'], permissions: { can_move: true }
  }
  const theirsPicture = { ...minePicture, turn: 'black', permissions: { can_move: false } }
  const wonPicture = { ...minePicture, status: 'win', winner: 'white', permissions: { can_move: false } }
  const live = (picture, extra = {}) => ({
    room_id: 'r1', state: 'live', picture, room: 'r1', side: 'white',
    opponent: { name: 'Bea' }, error: '', finished: false, ...extra
  })
  const makeCtx = (table, extra = {}) => {
    const asked = []
    const opened = []
    const state = { table }
    const ctx = {
      storage: { get: (key, fallback) => fallback, set() {}, remove() {} },
      os: { openExternal: url => { opened.push(url); return true }, notify() {} },
      rest: async (path, options) => {
        asked.push([path, options || null])
        if (path === '/online/table') return { table: state.table }
        if (path === '/online/table/open') return extra.open || { ok: true, text: 'Table opened.' }
        if (path === '/online/table/cmd') {
          const body = (options && options.body) || {}
          if (extra.refuse) return { ok: false, text: 'That move is not legal.', picture: minePicture }
          if (extra.hold) return new Promise(resolve => { extra.hold.release = () => resolve({ ok: true, text: `Played ${body.action}.`, picture: theirsPicture }) })
          return { ok: true, text: `Played ${body.action}.`, picture: theirsPicture }
        }
        if (path === '/online/table/chat') return { ok: true, text: '' }
        if (path === '/online/table/close') return { ok: true, text: 'Table put away.' }
        return { ok: true }
      }
    }
    return { ctx, asked, opened, state }
  }
  const tableOnly = run => run.asked.map(item => item[0]).filter(path => !String(path).startsWith('/online/table'))
  const commands = run => run.asked.filter(item => item[0] === '/online/table/cmd')
  const chats = run => run.asked.filter(item => item[0] === '/online/table/chat')

  reset()
  // 1. My move: the turn line says so at once, and the board takes clicks.
  const taking = makeCtx(live(minePicture))
  const props = { game, ctx: taking.ctx, roomId: 'r1', onBack: () => localCalls.push('back') }
  let tree = await settle('OnlineTable(onlineProps)', 'onlineProps', props)
  assert.equal(turnLine(tree).props['data-turn-line'], 'mine', 'the online turn line names my move')
  assert.equal(words(turnLine(tree)), 'Your turn', 'in the owner\'s own words')
  assert.equal(boardNode(tree).props.interactive, true, 'and the board is the one that takes the click')
  assert.ok(words(tree).includes('Against Bea'), 'the other seat is named, not a blank')
  assert.ok(!words(tree).includes('Hermes is thinking'), 'no model is claimed to be thinking here')
  uniqueControlNames(tree, 'the online table')

  reset()
  // 2. Their move: the line waits, by name — even when the other seat is called Hermes.
  const waitingRun = makeCtx(live(theirsPicture, { opponent: { name: 'Hermes' } }))
  tree = await settle('OnlineTable(onlineProps)', 'onlineProps',
    { game, ctx: waitingRun.ctx, roomId: 'r1', onBack: () => {} })
  assert.equal(turnLine(tree).props['data-turn-line'], 'theirs', 'a seat that may not move waits')
  assert.equal(words(turnLine(tree)), 'Waiting for Hermes', 'and says who it is waiting for')
  assert.ok(!words(tree).includes('Hermes is thinking'), 'never the local table\'s thinking line')
  assert.equal(boardNode(tree).props.interactive, false, 'and the board is locked while it is not my turn')

  reset()
  // 3. A click is a table command, never a local game line.
  const playing = makeCtx(live(minePicture))
  const playProps = { game, ctx: playing.ctx, roomId: 'r1', onBack: () => {} }
  tree = await settle('OnlineTable(onlineProps)', 'onlineProps', playProps)
  const before = playing.asked.length
  boardNode(tree).props.onMove('4')
  await tick()
  const sent = commands(playing).pop()
  assert.equal(sent[0], '/online/table/cmd', 'the click goes to the table command route')
  assert.deepEqual(JSON.parse(JSON.stringify(sent[1].body)), { action: 'move', args: ['4'] },
    'the token the board produced is the argument, one action, no prediction')
  assert.equal(playing.asked.slice(before).filter(item => item[0] === '/online/table/cmd').length, 1, 'one click, one command')
  assert.deepEqual(tableOnly(playing), [], 'and nothing else is asked of the shelf')
  tree = await settle('OnlineTable(onlineProps)', 'onlineProps', playProps)
  assert.ok(words(tree).includes('Played move.'), 'the table\'s own answer is shown')

  // A move the table refuses says so, in the table's words: never a silent no-op.
  const illegal = makeCtx(live(minePicture), { refuse: true })
  const illegalProps = { game, ctx: illegal.ctx, roomId: 'r1', onBack: () => {} }
  tree = await settle('OnlineTable(onlineProps)', 'onlineProps', illegalProps)
  boardNode(tree).props.onMove('9')
  await tick()
  tree = draw('OnlineTable(onlineProps)', 'onlineProps', illegalProps)
  assert.ok(words(tree).includes('That move is not legal.'), 'a refused move is refused out loud')
  assert.ok(nodes(tree).some(node => node.props.role === 'alert'), 'and it is an alert')

  reset()
  // 4. A command in flight locks the board and the buttons, with no guessed move on the board.
  const hold = {}
  const slow = makeCtx(live(minePicture), { hold })
  const slowProps = { game, ctx: slow.ctx, roomId: 'r1', onBack: () => {} }
  tree = await settle('OnlineTable(onlineProps)', 'onlineProps', slowProps)
  boardNode(tree).props.onMove('5')
  tree = draw('OnlineTable(onlineProps)', 'onlineProps', slowProps)
  assert.equal(boardNode(tree).props.interactive, false, 'the board is locked while a command is out')
  assert.equal(findButton(tree, 'Resign').props.disabled, true, 'and so are the table controls')
  assert.equal(findButton(tree, 'Close table').props.disabled, true)
  boardNode(tree).props.onMove('6')
  assert.equal(commands(slow).length, 1, 'a second click while one is out sends nothing')
  hold.release()
  await tick()
  tree = draw('OnlineTable(onlineProps)', 'onlineProps', slowProps)
  assert.equal(findButton(tree, 'Resign').props.disabled, false, 'the controls unlock when the table answers')
  assert.equal(words(turnLine(tree)), 'Waiting for Bea', 'and the table\'s own picture is what is drawn')

  reset()
  // 5. Resign asks first, in the owner's words, and closing the table is its own route.
  const leaving = makeCtx(live(minePicture))
  const leavingProps = { game, ctx: leaving.ctx, roomId: 'r1', onBack: () => localCalls.push('back') }
  tree = await settle('OnlineTable(onlineProps)', 'onlineProps', leavingProps)
  findButton(tree, 'Resign').props.onClick()
  tree = draw('OnlineTable(onlineProps)', 'onlineProps', leavingProps)
  assert.equal(commands(leaving).length, 0, 'resign sends nothing before it is confirmed')
  assert.ok(nodes(tree).some(node => node.props.role === 'alertdialog'), 'it asks in a dialog')
  assert.ok(words(tree).includes('awards the win to Bea'), 'and names who gets the game')
  findButton(tree, 'Cancel').props.onClick()
  tree = draw('OnlineTable(onlineProps)', 'onlineProps', leavingProps)
  assert.equal(commands(leaving).length, 0, 'Cancel sends nothing')
  findButton(tree, 'Resign').props.onClick()
  tree = draw('OnlineTable(onlineProps)', 'onlineProps', leavingProps)
  findButton(tree, 'Confirm resign').props.onClick()
  await tick()
  assert.equal(commands(leaving).pop()[1].body.action, 'resign', 'only the confirmation resigns')
  tree = draw('OnlineTable(onlineProps)', 'onlineProps', leavingProps)
  findButton(tree, 'Close table').props.onClick()
  await tick()
  assert.ok(leaving.asked.some(item => item[0] === '/online/table/close'), 'Close table posts the close route')
  assert.equal(localCalls.pop(), 'back', 'and puts the person back where they came from')
  assert.equal(evaluate('ONLINE_ROOM.roomId'), '', 'a closed table is forgotten')

  reset()
  // 6. The end of the game reads like the local table's result.
  const ended = makeCtx(live(wonPicture, { finished: true }))
  tree = await settle('OnlineTable(onlineProps)', 'onlineProps', { game, ctx: ended.ctx, roomId: 'r1', onBack: () => {} })
  assert.ok(nodes(tree).some(node => node.props.role === 'alert' && node.props['aria-label'] === 'Game over'), 'the result is announced')
  assert.ok(words(tree).includes('You win!'), 'with the local table\'s own words')
  assert.equal(turnLine(tree).props['data-turn-line'], 'over', 'and the turn line says the game is over')
  uniqueControlNames(tree, 'the online table when the game is over')

  reset()
  // 7. A table that is reconnecting says that, and nothing else.
  const wobbling = makeCtx(live(minePicture, { state: 'reconnecting' }))
  tree = await settle('OnlineTable(onlineProps)', 'onlineProps', { game, ctx: wobbling.ctx, roomId: 'r1', onBack: () => {} })
  assert.equal(words(turnLine(tree)), 'Reconnecting…', 'a dropped table says so out loud')
  assert.equal(turnLine(tree).props['data-turn-line'], 'reconnecting')
  assert.equal(boardNode(tree).props.interactive, false, 'and nothing can be played into a dropped table')

  reset()
  // 8. The game page draws OnlineTable instead of the local table, so no local move can be sent.
  const pageRun = makeCtx(live(minePicture))
  const localPicture = {
    status: 'active', turn: 'white', schema_version: 2, view: 'connect4', game: 'connect4', table_id: 't1',
    legal: ['1'], permissions: { can_move: true },
    seats: [{ side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false },
      { side: 'black', kind: 'human', id: 'bea', name: 'Bea', open: false }]
  }
  const ptProps = {
    game, view: { player: { id: 'me' }, allow_ai: true }, board: { picture: localPicture },
    send: async line => { localCalls.push(line); return { text: 'OK' } },
    playMove: async (...args) => { localCalls.push(`move ${args.join(' ')}`); return { ok: true, text: 'OK' } },
    ctx: pageRun.ctx, onBack: () => localCalls.push('back')
  }
  tree = await settle('PlayTable(ptProps)', 'ptProps', ptProps)
  assert.ok(findButton(tree, 'Offer draw'), 'with no online table the local table is exactly what it was')
  ptProps.view = { ...ptProps.view, online: { on: true, url: 'https://games.hermesnet.xyz', table: { room_id: 'r1' } } }
  tree = await settle('PlayTable(ptProps)', 'ptProps', ptProps)
  assert.ok(onlineNode(tree), 'an online table the server reports replaces the local table')
  assert.equal(onlineNode(tree).props.roomId, 'r1')
  assert.equal(findButton(tree, 'Offer draw'), undefined, 'and none of the local match controls are left')
  assert.equal(findButton(tree, 'Learn to play'), undefined)
  assert.deepEqual(localCalls, [], 'nothing local is sent while the online table is up')

  // The room "Play here" opened is the same switch, with no server answer needed.
  ptProps.view.online.table = null
  evaluate("rememberOnlineRoom('r1', 'connect4')")
  tree = await settle('PlayTable(ptProps)', 'ptProps', ptProps)
  assert.ok(onlineNode(tree), 'the room Play here opened is played here too')

  // ...but only for the game it was opened for: a Connect Four room is not Reversi's screen.
  evaluate("rememberOnlineRoom('r1', 'reversi')")
  tree = await settle('PlayTable(ptProps)', 'ptProps', ptProps)
  assert.equal(onlineNode(tree), undefined, 'a room opened for another game is never drawn over this one')
  assert.ok(findButton(tree, 'Offer draw'), 'this game\'s own table stays instead')
  evaluate("rememberOnlineRoom('')")
  ptProps.view.online = { ...ptProps.view.online, table: { room_id: 'r1', game: 'reversi' } }
  tree = await settle('PlayTable(ptProps)', 'ptProps', ptProps)
  assert.equal(onlineNode(tree), undefined, 'the same guard holds for what the server reports')

  ptProps.view.online.table = null
  tree = await settle('PlayTable(ptProps)', 'ptProps', ptProps)
  assert.ok(findButton(tree, 'Offer draw'), 'and the local table comes back when it is forgotten')

  // The local agent seat keeps the thinking line the owner asked for.
  ptProps.board = { picture: { ...localPicture, turn: 'black', permissions: { can_move: false },
    seats: [{ side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false },
      { side: 'black', kind: 'agent', id: 'agent', name: 'Your agent', open: false }] } }
  tree = await settle('PlayTable(ptProps)', 'ptProps', ptProps)
  assert.equal(turnLine(tree).props['data-turn-line'], 'thinking', 'a local model seat still says it is thinking')
  assert.ok(words(tree).includes('Hermes is thinking… 0s'), 'in the owner\'s words, with the seconds: ' + words(tree).slice(0, 160))
  // A computer seat that is only ON move is not "Computer is thinking…": nothing of ours is out,
  // so the line says it is waiting, with the same clock (owner's ask, 2026-11-11).
  ptProps.board = { picture: { ...localPicture, turn: 'black', permissions: { can_move: false },
    seats: [{ side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false },
      { side: 'black', kind: 'local', id: 'local', name: 'Local', open: false }] } }
  tree = await settle('PlayTable(ptProps)', 'ptProps', ptProps)
  assert.equal(turnLine(tree).props['data-turn-line'], 'theirs', 'a computer seat on move waits, it is not claimed to be thinking')
  assert.equal(words(turnLine(tree)), 'Waiting for the computer… 0s', 'and it is said in words, with the clock: ' + words(turnLine(tree)))
  // ... and another person is named, never a model.
  ptProps.board = { picture: { ...localPicture, turn: 'black', permissions: { can_move: false },
    seats: [{ side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false },
      { side: 'black', kind: 'human', id: 'bea', name: 'Bea', open: false }] } }
  tree = await settle('PlayTable(ptProps)', 'ptProps', ptProps)
  assert.equal(words(turnLine(tree)), 'Waiting for Bea… 0s', 'another person is named, with the clock')
  assert.equal(words(tree).includes('Hermes is thinking'), false, 'and no model is claimed to be thinking for them')
  ptProps.board = { picture: localPicture }

  // 9. "Play here" in the pane: the room is opened on the server, then the table is drawn here.
  const paneAsked = []
  const paneOnline = {
    on: true, linked: true, name: 'Ada', url: 'https://games.hermesnet.xyz', offline: false, disclosure: '',
    match: { room_id: 'r7', game: 'connect4', title: 'Connect Four', side: 'white', opponent: 'Bea', url: 'https://games.hermesnet.xyz/t/r7' },
    game: '', looking: {}, waiting_names: [], alerts: {}, ladder: {}, bot: {}, alert: null
  }
  const paneCtx = {
    storage: { get: (key, fallback) => fallback, set() {}, remove() {} },
    os: { notify() {}, openExternal: () => true },
    runAction: () => ({ ok: true }),
    rest: async (path, options) => {
      paneAsked.push([path, options || null])
      if (path === '/view') {
        return { player: { id: 'me', name: 'Ada', named: true }, viewer_id: 'me', allow_ai: true,
          play: [game], lobby: { lines: [], looking: [] }, online: paneOnline }
      }
      if (path.startsWith('/board')) return { text: '', picture: localPicture }
      if (path === '/online/table') return { table: live(minePicture, { room_id: 'r7' }) }
      return { ok: true, text: 'OK' }
    }
  }
  reset()
  const paneProps = { ctx: paneCtx }
  draw('WaitPane(paneProps)', 'paneProps', paneProps)
  await tick()
  tree = draw('WaitPane(paneProps)', 'paneProps', paneProps)
  findButton(tree, 'Lobby').props.onClick()
  tree = draw('WaitPane(paneProps)', 'paneProps', paneProps)
  const playHere = findButton(tree, 'Play here')
  assert.ok(playHere, 'a ready match is played here, not only in a browser')
  assert.equal(findButton(tree, 'Open in browser'), undefined, 'and the browser door is gone (owner, 2026-11-11)')
  await playHere.props.onClick()
  await tick()
  const opened = paneAsked.filter(item => item[0] === '/online/table/open').pop()
  assert.deepEqual(JSON.parse(JSON.stringify(opened[1].body)), { room_id: 'r7' }, 'Play here opens the room first')
  tree = draw('WaitPane(paneProps)', 'paneProps', paneProps)
  assert.ok(onlineNode(tree), 'and the pane shows the table itself')
  assert.equal(onlineNode(tree).props.roomId, 'r7')
  assert.ok(nodes(tree).some(node => node.props && node.props['aria-label'] === 'Close'),
    'the pane\'s own × stays on screen while a table is open')

  // 10. The shape of the built file: one command route, one poll, and no local move path.
  const onlineSource = source.slice(source.indexOf('// ---- 73-online-table.js'), source.indexOf('// ---- 79-version.js'))

  reset()
  // 11. The table chat: the list the server sent is what is drawn, one route sends a message, Enter
  // sends it too, and a line appears only once the table feed has it, never on the keypress.
  const greeted = makeCtx(live(minePicture, { chat: [
    { id: 1, player_id: 'bea', name: 'Bea', role: 'player', text: 'Good luck' },
    { id: 2, player_id: 'eve', name: 'Eve', role: 'watcher', text: 'Watching this one.' }
  ] }))
  const talkProps = { game, ctx: greeted.ctx, roomId: 'r1', onBack: () => {} }
  const chatField = view => nodes(view).find(node => node.props && node.props['data-chat-input'] === '1')
  tree = await settle('OnlineTable(onlineProps)', 'onlineProps', talkProps)
  assert.ok(nodes(tree).some(node => node.props && node.props['data-online-chat'] === '1'), 'the table carries a chat panel')
  assert.ok(words(tree).includes('Bea : Good luck'), 'a message the server sent is drawn: ' + words(tree).slice(0, 140))
  assert.ok(words(tree).includes('Eve (watching) : Watching this one.'), 'and a watcher is named as one')
  assert.equal(chatField(tree).props.maxLength, 300, 'the box is capped at the server 300 characters')
  assert.ok(String(chatField(tree).props.title || '').length > 0, 'and the cap is said on hover')
  assert.equal(findButton(tree, 'Send').props.disabled, true, 'Send does nothing with nothing typed')
  chatField(tree).props.onChange({ target: { value: 'Nice opening' } })
  tree = draw('OnlineTable(onlineProps)', 'onlineProps', talkProps)
  assert.equal(findButton(tree, 'Send').props.disabled, false, 'typing arms Send')
  const beforeSaying = greeted.asked.length
  findButton(tree, 'Send').props.onClick()
  await tick()
  const said = chats(greeted).pop()
  assert.deepEqual(JSON.parse(JSON.stringify(said[1].body)), { text: 'Nice opening' },
    'one press, one message, the text as typed')
  assert.equal(greeted.asked.slice(beforeSaying).filter(item => item[0] === '/online/table/chat').length, 1, 'one press, one message')
  assert.deepEqual(tableOnly(greeted), [], 'and nothing local is asked of the shelf')
  tree = draw('OnlineTable(onlineProps)', 'onlineProps', talkProps)
  assert.equal(chatField(tree).props.value, '', 'the box clears once the table has taken it')
  assert.ok(!words(tree).includes('Nice opening'), 'and no line is drawn before the table feed has it')
  // The feed catches up on the next poll: the line is the table word, never this screen guess.
  greeted.state.table = live(minePicture, { chat: [
    { id: 1, player_id: 'bea', name: 'Bea', role: 'player', text: 'Good luck' },
    { id: 2, player_id: 'eve', name: 'Eve', role: 'watcher', text: 'Watching this one.' },
    { id: 3, player_id: 'me', name: 'Ada', role: 'player', text: 'Nice opening' }
  ] })
  // The harness stubs the 400 ms timer, so a fresh read object is what the next poll would be.
  talkProps.ctx = { ...greeted.ctx }
  tree = await settle('OnlineTable(onlineProps)', 'onlineProps', talkProps)
  assert.ok(words(tree).includes('Ada : Nice opening'), 'the line appears once the table has it')
  // Enter sends, exactly as the box says it does, and an empty box sends nothing.
  chatField(tree).props.onChange({ target: { value: 'See you' } })
  tree = draw('OnlineTable(onlineProps)', 'onlineProps', talkProps)
  const typed = chats(greeted).length
  chatField(tree).props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
  await tick()
  assert.equal(chats(greeted).length, typed + 1, 'Enter sends')
  assert.equal(chats(greeted).pop()[1].body.text, 'See you', 'the same message the button would send')
  tree = draw('OnlineTable(onlineProps)', 'onlineProps', talkProps)
  chatField(tree).props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
  await tick()
  assert.equal(chats(greeted).length, typed + 1, 'an empty box sends nothing')

  // A message the table turns down comes back on the table's own feed, in the server's words, and
  // the words that were refused are put back in the box: nothing typed here is lost or swallowed.
  const turnedDown = makeCtx(live(minePicture, { chat: [],
    chat_error: { text: 'You are sending messages too fast.', sent: 'hello', at: 7 } }))
  const turnedProps = { game, ctx: turnedDown.ctx, roomId: 'r1', onBack: () => {} }
  tree = await settle('OnlineTable(onlineProps)', 'onlineProps', turnedProps)
  tree = draw('OnlineTable(onlineProps)', 'onlineProps', turnedProps)
  assert.ok(words(tree).includes('You are sending messages too fast.'), 'a message the table refused is refused out loud')
  assert.ok(nodes(tree).some(node => node.props.role === 'alert' && words(node).includes('too fast')), 'as an alert')
  assert.equal(chatField(tree).props.value, 'hello', 'and the refused words are put back in the box')
  // The same refusal, still on the feed, does not fight the person's next keystroke.
  chatField(tree).props.onChange({ target: { value: 'hello again' } })
  tree = await settle('OnlineTable(onlineProps)', 'onlineProps', turnedProps)
  assert.equal(chatField(tree).props.value, 'hello again', 'one refusal is shown once, not on every poll')

  // A table that is not live takes no typing, and no table at all draws no panel.
  const away = makeCtx(live(minePicture, { state: 'reconnecting' }))
  tree = await settle('OnlineTable(onlineProps)', 'onlineProps', { game, ctx: away.ctx, roomId: 'r1', onBack: () => {} })
  assert.equal(chatField(tree).props.disabled, true, 'a dropped table takes no typing')
  assert.equal(findButton(tree, 'Send').props.disabled, true, 'and Send has nothing to send')
  const blank = makeCtx(null)
  tree = await settle('OnlineTable(onlineProps)', 'onlineProps', { game, ctx: blank.ctx, roomId: '', onBack: () => {} })
  assert.equal(nodes(tree).find(node => node.props && node.props['data-online-chat'] === '1'), undefined, 'no table, no chat panel')

  // 12. The shape of the built file: one route sends a message, and the log follows the newest line.
  assert.ok(onlineSource.includes('/online/table/chat'), 'one route sends a message')
  assert.ok(onlineSource.includes('data-online-chat'), 'the panel is marked for the harness')
  assert.ok(onlineSource.includes('data-chat-list'), 'the list is its own scrolling box')
  assert.ok(onlineSource.includes('scrollTop = list.scrollHeight'), 'which follows the newest line')
  assert.ok(/event\.key === 'Enter'/.test(onlineSource), 'Enter sends')
  assert.ok(onlineSource.includes('maxLength: 300'), 'and the box is capped where the server caps')
  assert.ok(onlineSource.includes('ONLINE_TABLE_POLL_MS = 400'), 'the table is read every 400 ms')
  assert.ok(onlineSource.includes("ctx.rest('/online/table/cmd'"), 'every move is a table command')
  assert.ok(onlineSource.includes("ctx.rest('/online/table/close'"), 'closing is its own route')
  assert.ok(!onlineSource.includes('playMove') && !onlineSource.includes("'/command'"),
    'the online table has no way to send a local game line')
  assert.ok(onlineSource.includes("'data-turn-line': turnKind"), 'the turn line uses the existing attribute')
  assert.ok(onlineSource.includes("? 'Your turn'"), 'and says your turn in words')

  // 13. Regression test: A table that finishes forgets the room so the local table comes back.
  evaluate("rememberOnlineRoom('r1', 'connect4')")
  const finishedPicture = { ...minePicture, status: 'win', winner: 'white' }
  const finishedCtx = makeCtx(live(finishedPicture, { room_id: 'r1', finished: true }))
  const finishedProps = { game, ctx: finishedCtx.ctx, roomId: 'r1', onBack: () => {} }
  tree = await settle('OnlineTable(onlineProps)', 'onlineProps', finishedProps)
  assert.equal(evaluate("ONLINE_ROOM.roomId"), '', 'a finished table forgets the online room so the local table comes back')
  assert.equal(evaluate("onlineRoomFor({}, 'connect4')"), '', 'onlineRoomFor returns empty once the table finishes')

  // 14. A slow read must never paint over a newer one: the 400 ms poll is not a race.
  reset()
  const pendingReads = []
  const raceCtx = {
    storage: { get: (key, fallback) => fallback, set() {}, remove() {} },
    os: { openExternal: () => true, notify() {} },
    rest: async path => {
      if (path !== '/online/table') return { ok: true }
      return new Promise(resolve => pendingReads.push(payload => resolve({ table: payload })))
    }
  }
  const olderBoard = live(minePicture)     // white may move: the line reads Your turn
  const newerBoard = live(theirsPicture)   // black may not: the line reads Waiting for Bea
  const raceProps = { game, ctx: raceCtx, roomId: 'r1', onBack: () => {}, onClose: () => {} }
  const raceTrip = async value => { await tick(); return draw('OnlineTable(onlineProps)', 'onlineProps', value) }
  const raceSettle = async value => { tree = await raceTrip(value); tree = await raceTrip(value); return tree }
  tree = await settle('OnlineTable(onlineProps)', 'onlineProps', raceProps)
  assert.equal(pendingReads.length, 1, 'the table is read on the way in')
  // A second window on the same room (a re-subscribe, a room change) is a second read.
  raceProps.ctx = { ...raceCtx }
  tree = await raceTrip(raceProps)
  assert.equal(pendingReads.length, 2, 'a re-subscribed poll starts its own read')
  pendingReads[1](newerBoard)
  tree = await raceSettle(raceProps)
  assert.equal(turnLine(tree).props['data-turn-line'], 'theirs', 'the newer board is the one drawn')
  // Now the first, slow answer lands — an older board arriving late.
  pendingReads[0](olderBoard)
  tree = await raceSettle(raceProps)
  assert.equal(turnLine(tree).props['data-turn-line'], 'theirs',
    'a slow read that lands late never overwrites a newer board')

  evaluate("rememberOnlineRoom('')")
  reset()
  console.log('online table in the plugin: the server board, one command route, the table chat on one route, no local move: passed')
}

// The lobby's chat column (#games) on the home page: the name and the message are drafts,
// and a draft is only given up once the command behind it has been taken. The browser link
// beside the table reports what happened, including the copy fallback.
async function lobbyColumnContract() {
  sandbox.setInterval = () => 1
  sandbox.clearInterval = () => {}
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }
  const drafts = { chat: '', name: '' }
  const sends = []
  let sender = async line => { sends.push(line); return { ok: true, text: 'OK' } }
  const named = { player: { id: 'me', name: 'Ada', named: true }, lobby: { lines: [], looking: [] }, online: { on: true, url: 'https://games.hermesnet.xyz' } }
  const unnamed = { player: { id: 'me', name: '', named: false }, lobby: { lines: [], looking: [] }, online: { on: true, url: 'https://games.hermesnet.xyz' } }
  const paint = (extra = {}) => {
    sandbox.lobbyProps = {
      view: named, ctx: { os: { openExternal: () => false } }, current: 'connect4', onPlayHere: () => {},
      chat: drafts.chat, setChat: value => { drafts.chat = value },
      name: drafts.name, setName: value => { drafts.name = value },
      send: line => sender(line),
      ...extra
    }
    cursor = 0
    const tree = evaluate('LobbyChatColumn(lobbyProps)')
    const pending = effects
    effects = []
    pending.forEach(effect => effect())
    return tree
  }
  // A command is a round trip: the press sends, the answer lands, the next draws paint it.
  const roundTrip = async (extra = {}) => { await tick(); return paint(extra) }
  const settleTrips = async (extra = {}) => { tree = await roundTrip(extra); tree = await roundTrip(extra); return tree }
  const inputFor = (tree, label) => nodes(tree).find(node => node.type === 'input' && node.props['aria-label'] === label)
  let tree = null

  // 1. A message the lobby refuses keeps its words in the box, in the server's own words; the
  // same message, once the lobby has taken it, clears the box.
  reset()
  drafts.chat = 'hello there'
  sender = async line => { sends.push(line); return { ok: false, text: 'The lobby did not take that message.' } }
  tree = paint()
  findButton(tree, 'Send').props.onClick()
  tree = await settleTrips()
  assert.deepEqual(sends, ['chat say hello there'], 'one press, one chat line')
  assert.equal(drafts.chat, 'hello there', 'a message the lobby refused stays in the box')
  assert.ok(words(tree).includes('The lobby did not take that message.'),
    'and the refusal is shown: ' + words(tree).slice(-200))
  drafts.chat = 'hello there'
  sender = async line => { sends.push(line); return { ok: true, text: 'OK' } }
  tree = paint()
  findButton(tree, 'Send').props.onClick()
  tree = await settleTrips()
  assert.equal(drafts.chat, '', 'a message the lobby took clears the box')
  assert.ok(!words(tree).includes('The lobby did not take that message.'), 'and the refusal goes away')

  // The name draft follows the same rule: a name the lobby refuses is not thrown away.
  reset()
  drafts.chat = ''
  drafts.name = 'Ada'
  sender = async line => { sends.push(line); return { ok: false, text: 'That name is already taken.' } }
  tree = paint({ view: unnamed })
  findButton(tree, 'Set').props.onClick()
  tree = await settleTrips({ view: unnamed })
  assert.ok(sends.includes('name Ada'), 'Set posts the name')
  assert.equal(drafts.name, 'Ada', 'a name the lobby refused stays in the box')
  assert.ok(words(tree).includes('That name is already taken.'), 'and the reason is shown')
  drafts.name = 'Ada'
  sender = async line => { sends.push(line); return { ok: true, text: 'OK' } }
  tree = paint({ view: unnamed })
  findButton(tree, 'Set').props.onClick()
  tree = await settleTrips({ view: unnamed })
  assert.equal(drafts.name, '', 'a name the lobby took clears the box')

  // 2. The lobby column keeps every in-Hermes way into a match, and no browser link: the web
  // way in was removed (owner's ask, 2026-11-11). "Play here" is the one door on a ready table.
  reset()
  const withMatch = { player: { id: 'me', name: 'Ada', named: true }, lobby: { lines: [], looking: [] },
    online: { on: true, url: 'https://games.hermesnet.xyz',
      match: { room_id: 'r7', game: 'connect4', title: 'Connect Four', url: 'https://games.hermesnet.xyz/t/r7' } } }
  tree = paint({ view: withMatch })
  assert.equal(findButton(tree, 'Game'), undefined, 'the Game Center lobby column has no Game tab: it is only the lobby')
  assert.equal(findButton(tree, 'Lobby'), undefined, 'nor a Lobby tab')
  assert.ok(findButton(tree, 'Play here'), 'a ready match shows on top of the lobby and plays here, on this page')
  assert.ok(inputFor(tree, 'Say something in the lobby chat'), 'with the lobby chat still under it')
  assert.equal(findButton(tree, 'Open in browser'), undefined, 'and carries no browser link any more')
  assert.equal(nodes(tree).some(node => node.props && node.props['data-lobby-open-note'] === '1'), false,
    'nor the copy fallback note that went with it')

  // 3. Both boxes carry an accessible name: a placeholder is not a label.
  reset()
  tree = paint({ view: unnamed })
  const nameBox = inputFor(tree, 'Your name')
  assert.ok(nameBox, 'the name box has an aria-label, not only a placeholder')
  assert.equal(nameBox.props.placeholder, 'Your name', 'and keeps its placeholder')
  assert.ok(inputFor(tree, 'Say something in the lobby chat'), 'so does the chat box')
  reset()
  tree = paint()
  assert.ok(inputFor(tree, 'Say something in the lobby chat'), 'the labelled chat box is there for a named player too')

  reset()
  // 4. The column is narrow (140 px): each box gets its own full-width line with its button under
  // it, never squeezed side by side (owner's ask, 2026-11-11).
  reset()
  tree = paint({ view: unnamed })
  const sayRows = nodes(tree).filter(node => node.props && node.props['data-lobby-say-row'] === '1')
  assert.equal(sayRows.length, 2, 'the name row and the chat row are both stacked rows')
  for (const row of sayRows) assert.equal(row.props.style.flexDirection, 'column', 'a box sits above its button')
  console.log('lobby chat column: refused drafts are kept, matches play here: passed')
}

// The Plugin Hall (contract D): the desktop screen that reads GET /online/hall and
// speaks the four /online/hall/* doors. Drawn the same way OnlineTable is above —
// a draw starts a poll, a tick lets it settle, a second draw paints the answer.
async function hallContract() {
  sandbox.setInterval = () => 1
  sandbox.clearInterval = () => {}
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }
  const draw = value => {
    sandbox.hallProps = value
    cursor = 0
    const tree = evaluate('LobbyHall(hallProps)')
    const pending = effects
    effects = []
    pending.forEach(effect => effect())
    return tree
  }
  const settle = async value => { draw(value); await tick(); return draw(value) }
  const rowFor = (tree, id) => nodes(tree).filter(node => node.props && node.props['data-hall-row'] === id)[0]
  const you = { id: 'me', name: 'Ada' }
  const liveSnap = (extra = {}) => ({
    state: 'live', you, prefs: { open: true, games: { connect4: true } },
    roster: [
      { id: 'me', name: 'Ada', status: 'online', games: ['connect4'] },
      { id: 'bea', name: 'Bea', status: 'online', games: ['connect4', 'reversi'] },
      { id: 'cole', name: 'Cole', status: 'away', games: ['connect4'] },
      { id: 'dot', name: 'Dot', status: 'online', games: ['reversi'] },
      { id: 'eve', name: 'Eve', status: 'playing', games: ['connect4'] }
    ],
    requests: [], seated: null, ...extra
  })
  const makeCtx = (snapshot, extra = {}) => {
    const asked = []
    const state = { snap: snapshot }
    const ctx = {
      rest: async (path, options) => {
        asked.push([path, (options && options.body) || null])
        if (path === '/online/hall') { if (extra.hallError) throw new Error('The Hall cannot be reached.'); return state.snap }
        if (path === '/online/table/open') return typeof extra.open === 'function' ? extra.open() : (extra.open || { ok: true, text: 'Table opened.' })
        if (extra.hold && path === extra.hold.path) return new Promise(resolve => { extra.hold.release = () => resolve(extra.hold.answer || { ok: true }) })
        if (extra.fail) return { ok: false, text: extra.fail }
        return { ok: true }
      }
    }
    return { ctx, asked, state }
  }
  const props = extra => ({ ctx: null, current: 'connect4', view: {}, onPlayHere: () => {}, ...extra })

  // 1. The three not-live states each say their one line, in the owner's words.
  reset()
  let run = makeCtx({ state: 'off', you, prefs: {}, roster: [], requests: [], seated: null })
  let tree = await settle(props({ ctx: run.ctx }))
  assert.ok(words(tree).includes('Turn online play on to see who is here.'), 'off invites turning online play on')
  reset()
  run = makeCtx({ state: 'connecting', you, prefs: {}, roster: [], requests: [], seated: null })
  tree = await settle(props({ ctx: run.ctx }))
  assert.ok(words(tree).includes('Joining the Hall'), 'connecting says it is joining')
  reset()
  run = makeCtx({ state: 'old-server', you, prefs: {}, roster: [], requests: [], seated: null })
  tree = await settle(props({ ctx: run.ctx }))
  assert.ok(words(tree).includes('This lobby server has no Hall yet. Find a match still works.'), 'an old server says Find a match still works')
  // Before the first snapshot lands, the screen says it is joining, not blank.
  reset()
  run = makeCtx(liveSnap())
  tree = draw(props({ ctx: run.ctx }))
  assert.ok(words(tree).includes('Joining the Hall'), 'until the first snapshot lands it says joining')

  // 2. The live roster: names and statuses, with you left out of your own roster.
  reset()
  run = makeCtx(liveSnap())
  tree = await settle(props({ ctx: run.ctx }))
  const rows = nodes(tree).filter(node => node.props && node.props['data-hall-row'] !== undefined)
  assert.equal(rows.length, 4, 'your own row is left out of the roster')
  assert.ok(!rows.some(node => node.props['data-hall-row'] === 'me'), 'you are never in your own roster')
  for (const name of ['Bea', 'Cole', 'Dot', 'Eve']) assert.ok(words(tree).includes(name), `the roster names ${name}`)
  const statuses = nodes(tree).filter(node => node.props && node.props['data-hall-status'] !== undefined).map(node => node.props['data-hall-status'])
  assert.ok(statuses.includes('online') && statuses.includes('away') && statuses.includes('playing'), 'and shows each person\'s status')

  // 3. Ask is offered only to someone online who accepts the current game, and posts the exact body.
  const askButtons = nodes(tree).filter(node => node.type === 'button' && words(node) === 'Ask')
  assert.equal(askButtons.length, 1, 'only the online player who accepts this game can be asked')
  assert.ok(findButton(rowFor(tree, 'bea'), 'Ask'), 'Bea is online and accepts connect4, so she can be asked')
  assert.equal(findButton(rowFor(tree, 'cole'), 'Ask'), undefined, 'an away player cannot be asked')
  assert.equal(findButton(rowFor(tree, 'dot'), 'Ask'), undefined, 'a player who does not accept this game cannot be asked')
  assert.equal(findButton(rowFor(tree, 'eve'), 'Ask'), undefined, 'a player already at a table cannot be asked')
  findButton(rowFor(tree, 'bea'), 'Ask').props.onClick()
  await tick()
  const asked = run.asked.filter(item => item[0] === '/online/hall/request').pop()
  assert.deepEqual(JSON.parse(JSON.stringify(asked[1])), { to: 'bea', game: 'connect4' }, 'Ask posts the exact request body')

  // An empty roster says so plainly.
  reset()
  run = makeCtx(liveSnap({ roster: [{ id: 'me', name: 'Ada', status: 'online', games: ['connect4'] }] }))
  tree = await settle(props({ ctx: run.ctx }))
  assert.ok(words(tree).includes('Nobody else is here right now.'), 'an empty roster is named, not blank')

  // 4. An inbound request is a card: Accept answers yes, Decline answers no.
  reset()
  run = makeCtx(liveSnap({ requests: [
    { id: 'q1', state: 'pending', from: { id: 'bea', name: 'Bea' }, to: { id: 'me', name: 'Ada' }, game: 'connect4', created: 0, expires: 90 }
  ] }))
  tree = await settle(props({ ctx: run.ctx }))
  assert.ok(words(tree).includes('Bea wants to play connect4'), 'an inbound request reads as a card')
  findButton(tree, 'Accept').props.onClick()
  await tick()
  let respond = run.asked.filter(item => item[0] === '/online/hall/respond').pop()
  assert.deepEqual(JSON.parse(JSON.stringify(respond[1])), { id: 'q1', accept: true }, 'Accept answers the request yes')
  tree = draw(props({ ctx: run.ctx }))
  findButton(tree, 'Decline').props.onClick()
  await tick()
  respond = run.asked.filter(item => item[0] === '/online/hall/respond').pop()
  assert.deepEqual(JSON.parse(JSON.stringify(respond[1])), { id: 'q1', accept: false }, 'Decline answers the request no')

  // 5. An outbound request shows who you asked, and Cancel takes it back by id.
  reset()
  run = makeCtx(liveSnap({ requests: [
    { id: 'q2', state: 'pending', from: { id: 'me', name: 'Ada' }, to: { id: 'bea', name: 'Bea' }, game: 'connect4', created: 0, expires: 90 }
  ] }))
  tree = await settle(props({ ctx: run.ctx }))
  assert.ok(words(tree).includes('Asked Bea'), 'an outbound request names who you asked')
  findButton(tree, 'Cancel').props.onClick()
  await tick()
  const cancelled = run.asked.filter(item => item[0] === '/online/hall/cancel').pop()
  assert.deepEqual(JSON.parse(JSON.stringify(cancelled[1])), { id: 'q2' }, 'Cancel takes the request back by id')

  // 6. The master switch posts {open:true}; the per-game toggle names the current game only.
  reset()
  run = makeCtx(liveSnap({ prefs: { open: false, games: {} } }))
  tree = await settle(props({ ctx: run.ctx }))
  const masterLabel = nodes(tree).find(node => node.props && node.props['data-hall-toggle'] === 'open')
  assert.ok(masterLabel, 'the master switch is present')
  nodes(masterLabel).find(node => node.type === 'input').props.onChange({ target: { checked: true } })
  await tick()
  let prefsPost = run.asked.filter(item => item[0] === '/online/hall/prefs').pop()
  assert.deepEqual(JSON.parse(JSON.stringify(prefsPost[1])), { open: true }, 'the master switch turns requests on')
  tree = draw(props({ ctx: run.ctx }))
  const gameLabel = nodes(tree).find(node => node.props && node.props['data-hall-toggle'] === 'game')
  assert.ok(gameLabel, 'a per-game toggle is present for the current game')
  nodes(gameLabel).find(node => node.type === 'input').props.onChange({ target: { checked: true } })
  await tick()
  prefsPost = run.asked.filter(item => item[0] === '/online/hall/prefs').pop()
  assert.deepEqual(JSON.parse(JSON.stringify(prefsPost[1])), { games: { connect4: true } }, 'the per-game toggle names only the current game')

  // 7. A seat opens the online table once — not again on the next poll.
  reset()
  run = makeCtx(liveSnap({ seated: { room_id: 'r9', game: 'connect4' } }))
  const played = []
  const seatedProps = props({ ctx: run.ctx, onPlayHere: match => played.push(match) })
  tree = await settle(seatedProps)
  await tick()
  let opens = run.asked.filter(item => item[0] === '/online/table/open')
  assert.equal(opens.length, 1, 'a seat opens the online table once')
  assert.deepEqual(JSON.parse(JSON.stringify(opens[0][1])), { room_id: 'r9' }, 'with the room the server seated you at')
  assert.deepEqual(JSON.parse(JSON.stringify(played.pop())), { room_id: 'r9', game: 'connect4' }, 'and hands the room to the page')
  tree = await settle(seatedProps)
  await tick()
  opens = run.asked.filter(item => item[0] === '/online/table/open')
  assert.equal(opens.length, 1, 'the same seat never opens the table twice on the next poll')

  // 8. A control is locked while its own POST is out, and a refusal is shown.
  reset()
  const hold = { path: '/online/hall/request' }
  run = makeCtx(liveSnap(), { hold })
  tree = await settle(props({ ctx: run.ctx }))
  findButton(rowFor(tree, 'bea'), 'Ask').props.onClick()
  tree = draw(props({ ctx: run.ctx }))
  assert.equal(findButton(rowFor(tree, 'bea'), 'Ask').props.disabled, true, 'Ask locks while its request is in flight')
  hold.release()
  await tick()
  tree = draw(props({ ctx: run.ctx }))
  assert.equal(findButton(rowFor(tree, 'bea'), 'Ask').props.disabled, false, 'and unlocks when the server answers')
  reset()
  run = makeCtx(liveSnap(), { fail: 'They are not taking requests right now.' })
  tree = await settle(props({ ctx: run.ctx }))
  findButton(rowFor(tree, 'bea'), 'Ask').props.onClick()
  await tick()
  tree = draw(props({ ctx: run.ctx }))
  assert.ok(words(tree).includes('They are not taking requests right now.'), 'a refused Ask shows the server\'s own reason')

  // 9. The Hall never prints a URL, an invite code, a key or a token.
  reset()
  run = makeCtx(liveSnap({ requests: [
    { id: 'q3', state: 'pending', from: { id: 'bea', name: 'Bea' }, to: { id: 'me', name: 'Ada' }, game: 'connect4', created: 0, expires: 90 },
    { id: 'q4', state: 'pending', from: { id: 'me', name: 'Ada' }, to: { id: 'dot', name: 'Dot' }, game: 'connect4', created: 0, expires: 90 }
  ] }))
  tree = await settle(props({ ctx: run.ctx }))
  const printed = words(tree).toLowerCase()
  assert.ok(!printed.includes('http'), 'the Hall never prints a URL')
  assert.ok(!printed.includes('invite'), 'and never an invite code')

  // 10. A seat the server offers that will not open says so, stays retryable, and never
  // moves the person to a table that is not there.
  reset()
  let seatOpens = false
  const seatAnswer = () => (seatOpens ? { ok: true, text: 'Table opened.' } : { ok: false, text: 'That room is already gone.' })
  run = makeCtx(liveSnap({ seated: { room_id: 'r10', game: 'connect4' } }), { open: seatAnswer })
  const refusedPlay = []
  const refusedProps = props({ ctx: run.ctx, onPlayHere: match => refusedPlay.push(match) })
  // An attempt is a round trip: the effect posts, the answer lands, the next draws paint it.
  const roundTrip = async value => { await tick(); return draw(value) }
  const settleTrip = async value => { tree = await roundTrip(value); tree = await roundTrip(value); return tree }
  const opensSoFar = () => run.asked.filter(item => item[0] === '/online/table/open').length
  tree = await settle(refusedProps)
  tree = await settleTrip(refusedProps)
  assert.deepEqual(refusedPlay, [], 'a seat that would not open never moves the person to it')
  assert.ok(words(tree).includes('That room is already gone.'),
    'and the server\'s own reason is shown: ' + words(tree).slice(-220))
  assert.equal(opensSoFar(), 1, 'the seat is asked for once so far')
  assert.ok(findButton(tree, 'Try again'), 'with a way to ask for the same seat again')
  findButton(tree, 'Try again').props.onClick()
  tree = await settleTrip(refusedProps)
  assert.equal(opensSoFar(), 2, 'Try again asks the server once more')
  assert.deepEqual(refusedPlay, [], 'and a second refusal still does not move the person')
  assert.ok(words(tree).includes('That room is already gone.'), 'and the refusal is still on screen')
  // The same seat, once the server does open it, is handed over once — by room and game.
  seatOpens = true
  findButton(tree, 'Try again').props.onClick()
  tree = await settleTrip(refusedProps)
  assert.deepEqual(JSON.parse(JSON.stringify(refusedPlay)), [{ room_id: 'r10', game: 'connect4' }],
    'a seat that opens is handed to the page by room and game, once')
  assert.ok(!words(tree).includes('could not be opened'), 'and the refusal is cleared once the table opens')
  tree = await settleTrip(refusedProps)
  assert.equal(opensSoFar(), 3, 'the same seat is never asked for a second time after it opened')

  // 11. A Hall read that fails says it is reconnecting, and clears the moment one lands again:
  // an old roster must never be passed off as the live one.
  reset()
  const flaky = { hallError: false }
  run = makeCtx(liveSnap(), flaky)
  tree = await settleTrip(props({ ctx: run.ctx }))
  assert.ok(words(tree).includes('Bea'), 'the roster is live to start with')
  assert.ok(!words(tree).includes('Reconnecting…'), 'and nothing says reconnecting yet')
  flaky.hallError = true
  tree = await settleTrip(props({ ctx: { ...run.ctx } }))
  assert.ok(words(tree).includes('Reconnecting…'),
    'a failed Hall read says it is reconnecting: ' + words(tree).slice(0, 220))
  assert.ok(nodes(tree).some(node => node.props['data-hall-reconnecting'] === '1'),
    'and the line is marked as the reconnecting state')
  assert.ok(words(tree).includes('Bea'), 'the last roster stays on screen while it retries')
  flaky.hallError = false
  tree = await settleTrip(props({ ctx: { ...run.ctx } }))
  assert.ok(!words(tree).includes('Reconnecting…'), 'and the line clears as soon as a read lands')
  assert.ok(words(tree).includes('Bea'), 'with the roster still there')
  // A Hall that never answered at all says the same thing, rather than claiming to be joining.
  reset()
  run = makeCtx(liveSnap(), { hallError: true })
  tree = await settleTrip(props({ ctx: run.ctx }))
  assert.ok(words(tree).includes('Reconnecting…'), 'a Hall that never answered says it is reconnecting')
  assert.ok(!words(tree).includes('Joining the Hall'), 'and never claims to be joining')

  // 12. One lock for every Hall action: while one POST is out, none of the others pretend to
  // work, and each says why it cannot be pressed.
  reset()
  const holdAsk = { path: '/online/hall/request' }
  run = makeCtx(liveSnap({ requests: [
    { id: 'q6', state: 'pending', from: { id: 'bea', name: 'Bea' }, to: { id: 'me', name: 'Ada' }, game: 'connect4', created: 0, expires: 90 },
    { id: 'q7', state: 'pending', from: { id: 'me', name: 'Ada' }, to: { id: 'dot', name: 'Dot' }, game: 'connect4', created: 0, expires: 90 }
  ] }), { hold: holdAsk })
  tree = await settleTrip(props({ ctx: run.ctx }))
  findButton(rowFor(tree, 'bea'), 'Ask').props.onClick()
  tree = await roundTrip(props({ ctx: run.ctx }))
  assert.equal(findButton(tree, 'Accept').props.disabled, true,
    'another request cannot be answered while one Hall action is out')
  assert.equal(findButton(tree, 'Decline').props.disabled, true, 'nor refused')
  assert.equal(findButton(tree, 'Cancel').props.disabled, true, 'nor taken back')
  assert.ok(String(findButton(tree, 'Accept').props.title).includes('still going'),
    'and each says why on hover: ' + findButton(tree, 'Accept').props.title)
  const hallMaster = nodes(tree).find(node => node.props && node.props['data-hall-toggle'] === 'open')
  assert.equal(nodes(hallMaster).find(node => node.type === 'input').props.disabled, true,
    'the switches are locked with the rest')
  assert.ok(String(hallMaster.props.title).includes('still going'), 'and wear the same reason')
  holdAsk.release()
  await tick()
  tree = await settleTrip(props({ ctx: run.ctx }))
  assert.equal(findButton(tree, 'Accept').props.disabled, false, 'everything unlocks when the server answers')
  assert.ok(String(findButton(tree, 'Accept').props.title).includes('Accept and sit down'),
    'and a tooltip goes back to what the control does: ' + findButton(tree, 'Accept').props.title)

  // Opening a seat above remembered a room on the module; forget it so the next
  // contract's local table is not mistaken for that online room.
  evaluate("rememberOnlineRoom('')")
  reset()
  console.log('plugin hall (contract D): roster, prefs, requests, and one seat-open: passed')
}

async function championsContract() {
  const champion = { id: 'champ-11111111', name: 'Rook', motto: 'Hold the line.',
    avatar: 'rook', color: 'amber', brief: 'Patient and positional.',
    brain: { kind: 'model', model: '', provider: '' }, created_at: 1 }
  const rival = { id: 'champ-22222222', name: 'Fang', motto: 'Strike first.',
    avatar: 'fang', color: 'amber', brief: 'A reckless attacker.',
    brain: { kind: 'model', model: '', provider: '' }, created_at: 2 }
  const data = {
    ok: true,
    champions: [champion, rival],
    avatars: [{ id: 'knight', glyph: '♞' }, { id: 'rook', glyph: '♜' }],
    colors: [{ id: 'amber', hex: '#d9a441' }],
    limits: { name: 32, motto: 80, brief: 600, champions: 64 },
    brain: { model: 'test-model', provider: 'nous', where: 'cloud', slot: 'gameshelf_opponent' },
    model_ready: true,
    divisions: [
      { id: 'prompt', label: 'Prompt Division', note: 'Same brain, best mind wins.' },
      { id: 'open', label: 'Open Division', note: 'Any champion or computer.' }
    ],
    games: [{ id: 'connect4', title: 'Connect Four' }],
    bots: [{ id: 'bot-easy', level: 'easy', name: 'Computer (Easy)' },
      { id: 'bot-hard', level: 'hard', name: 'Computer (Hard)' }],
    caps: { entrants: 8, games: 200, calls: 1200 },
    leaderboard: [{ id: champion.id, name: 'Rook', rating: 1512, games: 2, wins: 2, losses: 0, draws: 0, badges: ['first_win'] }],
    by_game: {},
    ratings: { [champion.id]: { rating: 1512, wins: 2, losses: 0, draws: 0, illegal: 0, tokens: 20, think_ms: 100, games: 2 } },
    tournaments: [{ id: 'tour-9', status: 'done', played: 1, total: 1 }]
  }
  const done = { ok: true, id: 'tour-9', status: 'done', played: 1, total: 1, current: {},
    names: { [champion.id]: 'Rook', 'bot-easy': 'Computer (Easy)' },
    results: [{ game: 'connect4', white: champion.id, black: 'bot-easy', winner: 'white', status: 'win', plies: 1, moves: ['1'] }] }
  const asked = []
  sandbox.champCtx = {
    rest: async (path, options) => {
      asked.push([path, options])
      if (path === '/champions') return data
      if (path === '/tournament/start') return { ok: true, id: 'tour-1', estimate: { games: 2 }, text: 'Started 2 games.' }
      if (path.startsWith('/tournament/status')) return done
      if (path.startsWith('/tournament/replay')) return {
        ok: true, game: 'connect4', title: 'Connect Four',
        names: done.names, result: done.results[0],
        frames: [{ view: 'grid', cells: [['.']], white: 'Rook' }, { view: 'grid', cells: [['X']], white: 'Rook' }]
      }
      return { ok: true, text: 'Saved.' }
    }
  }
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))
  const draw = () => { cursor = 0; return evaluate('ChampionsPage({ ctx: champCtx, view: {} })') }
  const flush = () => { const pending = effects; effects = []; pending.forEach(effect => { const out = effect(); if (out) cleanups.push(out) }) }
  const openPage = async () => { reset(); let page = draw(); flush(); await tick(); page = draw(); return page }

  reset()
  let tree = draw()
  flush()
  await tick()
  tree = draw()
  assert.ok(words(tree).includes('Create a champion'), 'the creator is on the page')
  assert.ok(words(tree).includes('Personality and strategy brief'))
  assert.ok(words(tree).includes('same brain, best mind wins') || words(tree).includes('Same brain, best mind wins'))
  assert.ok(words(tree).includes('Rook'))
  // The Bot Passport is one component per champion: the card body is the pet, the
  // playbook it plays and the record it earned, with its own actions.
  const passportOf = (page, index) => nodes(page).filter(node => typeof node.type === 'function' && node.type.name === 'PassportCard')[index]
  const passportAction = (page, index, label) => findButton(passportOf(page, index).props.actions, label)
  assert.ok(passportOf(tree, 0) && passportOf(tree, 1), 'one passport card per champion')
  assert.ok(passportAction(tree, 0, 'Export') && passportAction(tree, 0, 'Delete') && passportAction(tree, 0, 'Edit'),
    'each passport carries its own actions')
  assert.equal(passportOf(tree, 0).props.pet, null, 'no pet is passed while none is installed')
  // The card itself: pet body, the playbook version that plays, the record, badges.
  reset()
  sandbox.passport = {
    ctx: sandbox.champCtx,
    champion: {
      ...champion,
      record: { rating: 1512, wins: 2, losses: 0, draws: 0 },
      record_by_version: { wins: 1, losses: 0, draws: 0 },
      playbook: { id: 'pb-1234abcd', name: 'Patient wall', words: 210 },
      dossiers: [{ opponent: rival.id, opponent_name: 'Fang', matches: 3, wins: 2, losses: 1, draws: 0, text: 'Fang opens wide and trades badly when behind.' }]
    },
    avatars: data.avatars,
    colors: data.colors,
    pet: null,
    badges: ['first_win'],
    actions: []
  }
  let card = evaluate('PassportCard(passport)')
  assert.ok(words(card).includes('Elo 1512'), 'the card shows the real rating')
  assert.ok(words(card).includes('Patient wall'), 'the playbook version that plays is named')
  assert.ok(words(card).includes('this version 1-0-0'), 'the record of that version is kept apart from the overall one')
  assert.ok(words(card).includes('first win'), 'earned badges are shown')
  assert.ok(words(card).includes('1 rival scouted'), 'scouted rivals are offered')
  assert.ok(findButton(card, 'Open playbook'), 'the card opens the playbook')
  // A champion with no playbook asks for one instead of pretending it has a brain.
  sandbox.passport = { ...sandbox.passport, champion: { ...champion, record: {} }, badges: [] }
  card = evaluate('PassportCard(passport)')
  assert.ok(words(card).includes('No playbook yet'), 'a champion without a playbook says so')
  assert.ok(findButton(card, 'Write a playbook'), 'and offers to write one')

  tree = await openPage()
  passportAction(tree, 0, 'Add to tournament').props.onClick()
  tree = draw()
  passportAction(tree, 1, 'Add to tournament').props.onClick()
  tree = draw()
  nodes(tree).find(node => node.type === 'button' && words(node).includes('Connect Four')).props.onClick()
  tree = draw()
  assert.ok(words(tree).includes('2 games'), 'the estimate is shown before starting')
  assert.ok(words(tree).includes('model calls'))
  assert.ok(words(tree).includes('48 model calls'), 'champions cost model calls')

  // A tournament of computers only makes no model calls, so it fits a 1-call cap.
  passportAction(tree, 0, 'In tournament').props.onClick()
  tree = draw()
  passportAction(tree, 1, 'In tournament').props.onClick()
  tree = draw()
  assert.ok(words(tree).includes('0 model calls') || words(tree).includes('Pick at least two entrants'), 'both picks are cleared')
  findButton(tree, 'Open Division').props.onClick()
  tree = draw()
  findButton(tree, 'Computer (Easy)').props.onClick()
  tree = draw()
  findButton(tree, 'Computer (Hard)').props.onClick()
  tree = draw()
  assert.ok(words(tree).includes('0 model calls'), 'bot-only tournaments cost no model calls: ' + words(tree).slice(0, 300))
  findButton(tree, 'Computer (Easy)').props.onClick()
  tree = draw()
  findButton(tree, 'Computer (Hard)').props.onClick()
  tree = draw()
  findButton(tree, 'Prompt Division').props.onClick()
  tree = draw()
  passportAction(tree, 0, 'Add to tournament').props.onClick()
  tree = draw()
  passportAction(tree, 1, 'Add to tournament').props.onClick()
  tree = draw()
  const start = findButton(tree, 'Start tournament')
  assert.equal(Boolean(start.props.disabled), false, 'two entrants and a game are enough')
  await start.props.onClick()
  tree = draw()
  const started = asked.filter(item => item[0] === '/tournament/start').pop()
  assert.deepEqual(JSON.parse(JSON.stringify(started[1].body.champions)), [champion.id, rival.id])
  assert.deepEqual(JSON.parse(JSON.stringify(started[1].body.games)), ['connect4'])
  assert.equal(started[1].body.division, 'prompt')
  assert.ok(words(tree).includes('0 / 2 games'), 'progress is visible')

  // A saved tournament opens, and any finished game can be watched back.
  tree = draw()
  await findButton(tree, 'Open').props.onClick()
  await tick()
  tree = draw()
  const watch = findButton(tree, 'Watch')
  assert.ok(watch, 'finished games offer a replay')
  await watch.props.onClick()
  await tick()
  tree = draw()
  assert.ok(words(tree).includes('Replay · Connect Four'))
  assert.ok(words(tree).includes('Rook vs Computer (Easy)'))
  assert.ok(findButton(tree, 'Next') && findButton(tree, 'Play'))
  reset()
  console.log('champions creator and tournament replay: passed')
}

// The champion's body: the person's own Hermes pet through the desktop host's
// gateway call first, the plugin route second, a drawn figure when neither has one.
async function petSpriteContract() {
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))
  const frames = [[[[10, 20, 30, 255, 40, 50, 60, 255], [70, 80, 90, 255, 100, 110, 120, 255]]]]
  const asked = []
  sandbox.petCtx = { rest: async path => { asked.push(path); return sandbox.petAnswer } }
  const host = { called: [] }
  sandbox.host.request = async (method, params) => {
    host.called.push([method, params])
    if (host.mode === 'throws') throw new Error('no gateway here')
    return sandbox.petAnswer
  }
  const draw = () => { cursor = 0; return evaluate('PetSprite(petProps)') }
  const flush = () => { const pending = effects; effects = []; pending.forEach(effect => { const out = effect(); if (out) cleanups.push(out) }) }
  const drawn = (tree, state) => nodes(tree).find(node => node.props && node.props.role === 'img' && String(node.props['aria-label'] || '').includes(`, ${state}`))

  // 1. The gateway answers: cells are drawn, the plugin route is never asked.
  reset()
  host.mode = 'ok'
  sandbox.petAnswer = { enabled: true, slug: 'quokka', state: 'wave', cols: 24, frameMs: 200, frames }
  sandbox.petProps = { ctx: sandbox.petCtx, pet: { enabled: true, slug: 'quokka', displayName: 'Quokka' }, state: 'wave', caption: 'Taunt' }
  let tree = draw()
  flush()
  await tick()
  tree = draw()
  assert.equal(host.called.length, 1, 'the pet is asked for through the gateway first')
  assert.equal(host.called[0][0], 'pet.cells')
  assert.deepEqual(JSON.parse(JSON.stringify(host.called[0][1])), { state: 'wave', cols: 24 })
  assert.ok(drawn(tree, 'wave'), 'the gateway cells are drawn as the champion body')
  assert.ok(words(tree).includes('Taunt'), 'the state is captioned in plain words')
  assert.equal(asked.length, 0, 'the plugin route is not asked when the gateway answers')

  // 2. No gateway (or it refuses): the plugin route answers instead.
  reset()
  host.mode = 'throws'
  host.called.length = 0
  asked.length = 0
  sandbox.petAnswer = { enabled: true, slug: 'otter', state: 'review', cols: 24, frameMs: 200, frames }
  sandbox.petProps = { ctx: sandbox.petCtx, pet: { enabled: true, slug: 'otter', displayName: 'Otter' }, state: 'review' }
  tree = draw()
  flush()
  await tick()
  tree = draw()
  assert.equal(asked.length, 1)
  assert.ok(asked[0].startsWith('/pet/cells?state=review'), 'the fallback asks the plugin route for the same state')
  assert.ok(drawn(tree, 'review'), 'the fallback cells are drawn')

  // 3. Neither: a small drawn figure stands in, and the page says why.
  reset()
  host.mode = 'throws'
  asked.length = 0
  sandbox.petAnswer = { enabled: false, reason: 'unsupported', states: [] }
  sandbox.petProps = { ctx: sandbox.petCtx, pet: { enabled: true, slug: 'moth', displayName: 'Moth' }, state: 'failed', caption: 'Lost' }
  tree = draw()
  flush()
  await tick()
  tree = draw()
  const fallback = nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'CritterFallback')
  assert.ok(fallback, 'a host without pets still gets a body')
  assert.equal(fallback.props.state, 'failed', 'the figure follows the same state')
  assert.ok(words(tree).includes('Lost'))

  delete sandbox.host.request
  delete sandbox.petProps
  delete sandbox.petCtx
  delete sandbox.petAnswer
  reset()
  console.log('champion body: gateway pet, plugin fallback, drawn figure: passed')
}


// --- Chess coach: panel, arrows and review. Facts on the table; the model only via Why.
{
  const coachInBook = { opening: { eco: 'B10', name: 'Caro-Kann Defense' }, alt: 2, book: ['b8c6'], in_book: true, left_ply: null }
  sandbox.coachInBook = { coach: coachInBook }
  let tree = evaluate('CoachPanel(coachInBook)')
  let said = words(tree)
  assert.ok(said.includes('Chess coach'), 'the panel says what it is')
  assert.ok(nodes(tree).some(node => node.props && node.props['data-labs-badge']), 'it carries the Labs badge')
  assert.ok(said.includes('B10 · Caro-Kann Defense') && said.includes('+2 more names'), 'it names the opening and owns the transpositions')
  assert.ok(said.includes('Book moves are marked on the board.'), 'in book, the arrows speak')

  sandbox.coachLeft = { coach: { opening: null, alt: 0, book: [], in_book: false, left_ply: 13 } }
  said = words(evaluate('CoachPanel(coachLeft)'))
  assert.ok(said.includes('You left the book here — move 7 (White).'), 'leaving the book is said once, with the move')

  sandbox.coachOut = { coach: { opening: null, alt: 0, book: [], in_book: false, left_ply: null } }
  said = words(evaluate('CoachPanel(coachOut)'))
  assert.ok(said.includes('Unbooked position.'), 'an unbooked game says so, quietly')

  // The empty board is at the root of all 3,332 entries in the book, so it names none
  // of them: the bug hunt's card claimed the Amar Opening at move 0.
  sandbox.coachAtRest = { coach: { opening: null, alt: 0, book: ['g1h3', 'e2e3'], in_book: true, left_ply: null } }
  said = words(evaluate('CoachPanel(coachAtRest)'))
  assert.ok(said.includes('No opening named yet'), 'the card waits for the first move before naming an opening')
  assert.ok(!/A00|Amar/.test(said), 'it never claims an opening nobody has played')
  assert.ok(said.includes('Book moves are marked on the board.'), 'and still offers the book')

  sandbox.coachNone = { coach: null }
  assert.equal(evaluate('CoachPanel(coachNone)'), null, 'no coach data, no panel')

  assert.deepEqual(
    JSON.parse(JSON.stringify(evaluate('coachArrowPairs({ view: "chess", coach: { book: ["b1c3", "g1f3"] } })'))),
    [{ from: 'b1', to: 'c3' }, { from: 'g1', to: 'f3' }],
    'book moves become arrow pairs')
  assert.deepEqual(JSON.parse(JSON.stringify(evaluate('coachArrowPairs({ view: "reversi", coach: { book: ["a1b2"] } })'))), [],
    'no arrows off the chess board')
  const pic = { files: 'abcdefgh', ranks: [8, 7, 6, 5, 4, 3, 2, 1], view: 'chess' }
  sandbox.coachPic = pic
  const marks = evaluate('coachArrowMarks("chess", coachPic, { coachArrows: [{ from: "b1", to: "c3" }] }, 18, 36)')
  assert.equal(marks.length, 2, 'an arrow is a line plus a head')
  assert.equal(evaluate('coachArrowMarks("chess", coachPic, { coachArrows: [{ from: "b1", to: "c3" }], picked: ["b1"] }, 18, 36)').length, 0,
    'arrows yield while a piece is held')

  const why = []
  sandbox.coachReview = {
    coach: {
      engine: 'built-in search', opening: { eco: 'C01', name: 'French Defense' }, alt: 0, left_ply: 9,
      ply: 23, played: 'd1d5', played_san: 'Qxd5', better: 'f1d1', better_san: 'Rd1', before: 120, after: -40
    },
    onWhy: () => why.push('hint')
  }
  tree = evaluate('CoachReview(coachReview)')
  said = words(tree)
  assert.ok(said.includes('Opening: C01 · French Defense'), 'the review names the opening')
  assert.ok(said.includes('Left the book at move 5.'), 'and where the book ended')
  assert.ok(said.includes('Biggest mistake: move 12 (White) Qxd5') && said.includes('Rd1 was better.'), 'the mistake and the better move')
  assert.ok(said.includes('evaluated by built-in search'), 'the engine is labelled')
  const whyLink = findButton(tree, 'Why this move?')
  assert.ok(whyLink, 'the model speaks only when Why is pressed')
  whyLink.props.onClick()
  assert.deepEqual(why, ['hint'], 'Why asks the table for the hint at that position')
  console.log('chess coach: panel, arrows, review and the one Why link: passed')
}

// Pet Battles: the Labs entry, the pre-battle choices, and the pure helpers the
// battle screen draws from. No browser here — the mouse proof is proof/pb.
async function petBattlesContract() {
  assert.equal(evaluate('petbHpPercent({ hp: 85, maxhp: 170 })'), 50)
  assert.equal(evaluate('petbHpPercent({ hp: 0, maxhp: 170 })'), 0)
  assert.equal(evaluate('petbHpPercent({})'), 0)
  assert.equal(evaluate('petbHpColour(10)'), '#e0574f')
  assert.equal(evaluate('petbHpColour(40)'), '#e0a33f')
  assert.equal(evaluate('petbHpColour(90)'), '#4fb86a')
  assert.equal(evaluate('petbColour("Ember")'), '#ff7a59')
  // A hit puts its target in the jump beat; a move puts its user in the run dash. Every
  // beat is one of Hermes's own pet states.
  assert.equal(evaluate('petbStateFor({ kind: "hit" })'), 'jump')
  assert.equal(evaluate('petbStateFor({ kind: "move" })'), 'run')
  assert.equal(evaluate('petbStateFor({ kind: "faint" })'), 'failed')
  assert.equal(evaluate('petbStateFor({ kind: "switch" })'), 'wave')
  assert.equal(evaluate('petbStateFor({ kind: "shield" })'), 'wave')
  assert.equal(evaluate('petbStateFor({ kind: "miss" })'), 'review')
  assert.equal(JSON.stringify(evaluate('PETB_STATES')), JSON.stringify(['idle', 'wave', 'run', 'jump', 'failed', 'review', 'waiting']))
  // Nobody acting: the side to move is reviewing, the other waits; the winner jumps.
  assert.equal(evaluate('petbRestState("you", "active")'), 'review')
  assert.equal(evaluate('petbRestState("foe", "active")'), 'waiting')
  assert.equal(evaluate('petbRestState("you", "watch")'), 'waiting')
  assert.equal(evaluate('petbRestState("you", "won")'), 'jump')
  assert.equal(evaluate('petbRestState("foe", "won")'), 'failed')
  assert.equal(evaluate('petbRestState("you", "lost")'), 'failed')
  assert.equal(evaluate('petbStateSide({ kind: "hit", target: "foe", side: "you" })'), 'foe')
  assert.equal(evaluate('petbStateSide({ kind: "move", target: "foe", side: "you" })'), 'you')
  assert.equal(evaluate('petbStateSide({ kind: "win" })'), '')
  // A frame index is clamped, never trusted.
  assert.equal(evaluate('petbFrame([{ turn: 1 }, { turn: 2 }], 9).turn'), 2)
  assert.equal(evaluate('petbFrame([{ turn: 1 }, { turn: 2 }], -4).turn'), 1)
  assert.equal(evaluate('petbFrame([], 0)'), null)

  // The gateway's flat gallery and the plugin's split answer become one shape.
  const flat = evaluate('petbGalleryShape({ active: "boba", pets: [{ slug: "boba", displayName: "Boba", installed: true }, { slug: "kebo", displayName: "Kebo", installed: false, curated: true }] })')
  assert.equal(flat.installed.length, 1, 'installed pets are split out of the gateway list')
  assert.equal(flat.gallery.length, 1, 'the gallery is what is not installed')
  assert.equal(flat.source, 'petdex')
  const split = evaluate('petbGalleryShape({ source: "local", reason: "Petdex gallery could not be reached", installed: [], gallery: [] })')
  assert.equal(split.source, 'local', 'a local-only answer keeps its honest source')
  assert.equal(split.reason, 'Petdex gallery could not be reached')
  assert.equal(evaluate('petbGalleryShape(null).reason'), 'no-answer')

  // The computer's team comes from the gallery, never from your own installed pets, and the
  // same seed always picks the same three.
  sandbox.petbGallery = [
    { slug: 'boba', displayName: 'Boba', installed: true },
    { slug: 'kebo', displayName: 'Kebo', installed: false, curated: true },
    { slug: 'scoop', displayName: 'Scoop', installed: false, curated: true },
    { slug: 'boxcat', displayName: 'Boxcat', installed: false, curated: true },
    { slug: 'noir-webling', displayName: 'Noir Webling', installed: false }
  ]
  const foes = evaluate('petbPickOpponents(petbGallery, 1234, 3)')
  assert.equal(foes.length, 3, 'three opponents')
  assert.equal(foes.some(pet => pet.slug === 'boba'), false, 'never your own installed pet')
  const again = evaluate('petbPickOpponents(petbGallery, 1234, 3)')
  assert.deepEqual(foes, again, 'the same seed picks the same opponents')
  assert.equal(evaluate('petbPickOpponents([], 1, 3).length'), 0, 'no gallery, no opponents')

  // Your team: the picked pet leads, the rest of the installed pets follow.
  sandbox.petbInstalled = [
    { slug: 'boba', displayName: 'Boba' }, { slug: 'kebo', displayName: 'Kebo' },
    { slug: 'scoop', displayName: 'Scoop' }, { slug: 'boxcat', displayName: 'Boxcat' }
  ]
  const team = evaluate('petbTeamIdentities(petbInstalled, "scoop", 3)')
  assert.equal(team[0].slug, 'scoop', 'the picked pet leads')
  assert.equal(team.length, 3, 'three pets')
  assert.equal(team.filter(pet => pet.slug === 'scoop').length, 1, 'no pet twice')
  assert.equal(evaluate('petbTeamIdentities([], "", 3).length'), 0, 'no installed pets, no identities')
  // Names travel as one shlex word each, percent-encoded.
  assert.equal(evaluate('petbIdentityTokens([{ slug: "boba", name: "Boba" }, { slug: "kebo", name: "Ke bo" }])'),
    'boba=Boba kebo=Ke%20bo')
  assert.equal(evaluate('petbIdentityTokens([])'), '')
  delete sandbox.petbGallery
  delete sandbox.petbInstalled

  // The Labs card says it is an experiment and names who made it.
  sandbox.petbOpen = 0
  const card = evaluate('PetBattlesLabsCard({ onOpen() { petbOpen += 1 } })')
  assert.ok(words(card).includes('Labs · experiment'), 'the Labs badge is the shared one')
  assert.ok(words(card).includes('Pet Battles'))
  assert.ok(words(card).includes('no model calls in play'), 'the card is honest about models')
  const open = findButton(card, 'Open Pet Battles')
  assert.ok(open, 'the card has one way in')
  open.props.onClick()
  assert.equal(sandbox.petbOpen, 1, 'the button opens the screen')

  // The pre-battle screen: six types, sixteen moves, four levels, no typing and no select.
  const picture = {
    status: 'idle',
    levels: [
      { id: 'beginner', label: 'Beginner' },
      { id: 'intermediate', label: 'Intermediate' },
      { id: 'advanced', label: 'Advanced' },
      { id: 'expert', label: 'Expert' }
    ],
    enlist: { type: 'Ember', moves: ['cinder-lash', 'guard-up', 'quick-jab', 'scorch'] },
    catalogue: {
      types: [
        { name: 'Ember', colour: '#ff7a59' }, { name: 'Tide', colour: '#4fa8ff' },
        { name: 'Verdant', colour: '#63c76a' }, { name: 'Data', colour: '#b07bff' },
        { name: 'Shadow', colour: '#8b8fb5' }, { name: 'Steel', colour: '#8fa3ad' }
      ],
      moves: [
        { id: 'cinder-lash', name: 'Cinder Lash', type: 'Ember', power: 40, kind: 'damage' },
        { id: 'undertow', name: 'Undertow', type: 'Tide', power: 38, kind: 'damage' },
        { id: 'thorn-volley', name: 'Thorn Volley', type: 'Verdant', power: 40, kind: 'damage' },
        { id: 'packet-pierce', name: 'Packet Pierce', type: 'Data', power: 45, kind: 'damage' },
        { id: 'night-nip', name: 'Night Nip', type: 'Shadow', power: 40, kind: 'damage' },
        { id: 'rivet-ram', name: 'Rivet Ram', type: 'Steel', power: 45, kind: 'damage' },
        { id: 'quick-jab', name: 'Quick Jab', type: 'Data', power: 30, kind: 'damage' },
        { id: 'heavy-slam', name: 'Heavy Slam', type: 'Steel', power: 60, kind: 'damage' },
        { id: 'guard-up', name: 'Guard Up', type: 'Steel', power: 0, kind: 'shield' },
        { id: 'overclock', name: 'Overclock', type: 'Data', power: 0, kind: 'buff' },
        { id: 'wind-step', name: 'Wind Step', type: 'Verdant', power: 0, kind: 'buff' },
        { id: 'mend', name: 'Mend', type: 'Verdant', power: 0, kind: 'heal' },
        { id: 'scorch', name: 'Scorch', type: 'Ember', power: 0, kind: 'status' },
        { id: 'static-snare', name: 'Static Snare', type: 'Data', power: 0, kind: 'status' },
        { id: 'dazzle', name: 'Dazzle', type: 'Shadow', power: 0, kind: 'status' },
        { id: 'drain-bite', name: 'Drain Bite', type: 'Shadow', power: 25, kind: 'drain' }
      ]
    }
  }
  sandbox.petbPicture = picture
  sandbox.petbStarts = []
  sandbox.petbPick = { type: 'Ember', moves: ['cinder-lash', 'guard-up', 'quick-jab', 'scorch'] }
  sandbox.petbSetType = value => { sandbox.petbPick.type = value; sandbox.petbPicked = value }
  sandbox.petbLeads = []
  sandbox.petbPetdex = {
    installed: [
      { slug: 'boba', displayName: 'Boba', type: 'Data' },
      { slug: 'kebo', displayName: 'Kebo', type: 'Verdant' }
    ],
    gallery: [{ slug: 'boxcat', displayName: 'Boxcat', installed: false, curated: true }],
    thumbs: {}, loadThumb() {}, source: 'petdex', loading: false
  }
  const enlist = evaluate(`PetbEnlist({
    picture: petbPicture, catalogue: petbPicture.catalogue,
    type: petbPick.type, setType: petbSetType,
    moves: petbPick.moves, setMoves() {},
    busy: false, notice: '',
    petdex: petbPetdex, leadSlug: 'boba', setPetSlug: slug => petbLeads.push(slug),
    watchLevel: 'intermediate', setWatchLevel() {},
    onStart: level => petbStarts.push(level), onWatch: level => petbWatches.push(level)
  })`)
  assert.equal(nodes(enlist).filter(node => String(node.props && node.props['data-testid'] || '').startsWith('petb-type-')).length, 6, 'six type buttons')
  assert.equal(nodes(enlist).filter(node => String(node.props && node.props['data-testid'] || '').startsWith('petb-pick-')).length, 16, 'sixteen move tiles')
  assert.equal(nodes(enlist).filter(node => String(node.props && node.props['data-testid'] || '').startsWith('petb-level-')).length, 4, 'four level buttons')
  // The team is picked from real Hermes pets, each a card with its sprite slot.
  const petCards = nodes(enlist).filter(node => node && typeof node.type === 'function' && node.type.name === 'PetbPetCard')
  assert.equal(petCards.length, 2, 'one card per installed pet')
  assert.equal(petCards[0].props.selected, true, 'the lead pet is ringed')
  assert.equal(petCards[1].props.selected, false)
  assert.equal(petCards[0].props.pet.slug, 'boba', 'the card carries the real pet slug')
  petCards[1].props.onPick('kebo')
  assert.deepEqual(sandbox.petbLeads, ['kebo'], 'picking a card picks the lead pet')
  assert.ok(words(enlist).includes('pets from the Petdex gallery are waiting on the other side.'), 'the gallery is named')
  assert.ok(words(enlist).includes('Ember ▸ Verdant ▸ Tide ▸ Ember'), 'the chart is written out in words')
  const expert = nodes(enlist).find(node => node.props && node.props['data-testid'] === 'petb-level-expert')
  assert.ok(expert && expert.props.disabled === false, 'four moves enable every level')
  expert.props.onClick()
  assert.deepEqual(sandbox.petbStarts, ['expert'], 'the level button starts that level')
  const tide = nodes(enlist).find(node => node.props && node.props['data-testid'] === 'petb-type-tide')
  tide.props.onClick()
  assert.equal(sandbox.petbPicked, 'Tide', 'a type is one click')

  // No installed pet: Hermes's own install/hatch flow is offered, not a fake pet.
  sandbox.petbHostNav = []
  const bare = evaluate(`PetbEnlist({
    picture: petbPicture, catalogue: petbPicture.catalogue,
    type: 'Ember', setType() {}, moves: petbPick.moves, setMoves() {},
    busy: false, notice: '', petdex: { installed: [], gallery: [], thumbs: {}, loadThumb() {}, source: 'local', reason: 'Petdex gallery could not be reached', loading: false },
    leadSlug: '', setPetSlug() {}, watchLevel: 'beginner', setWatchLevel() {},
    onStart() {}, onWatch() {}
  })`)
  assert.ok(nodes(bare).find(node => node.props && node.props['data-testid'] === 'petb-no-pet'), 'the empty state is a card')
  assert.ok(words(bare).includes('Settings ▸ Appearance ▸ Pet'), 'it names Hermes’s own flow')
  assert.ok(words(bare).includes('Petdex gallery could not be reached'), 'the unreachable gallery is said on screen')
  const hatch = findButton(bare, 'Open pet gallery in Hermes')
  assert.ok(hatch, 'one button opens Hermes settings')

  // Three moves: the battle buttons say why they cannot start, and stay disabled.
  sandbox.petbPick.moves = ['cinder-lash', 'guard-up', 'quick-jab']
  const short = evaluate(`PetbEnlist({
    picture: petbPicture, catalogue: petbPicture.catalogue,
    type: 'Ember', setType() {}, moves: petbPick.moves, setMoves() {},
    busy: false, notice: '', petdex: petbPetdex, leadSlug: 'boba', setPetSlug() {},
    watchLevel: 'beginner', setWatchLevel() {},
    onStart() {}, onWatch() {}
  })`)
  const blocked = nodes(short).find(node => node.props && node.props['data-testid'] === 'petb-level-beginner')
  assert.equal(blocked.props.disabled, true, 'a short team cannot start')
  assert.ok(words(short).includes('Pick exactly four moves to start'))
  // No typing and no drop-down anywhere in the pre-battle screen.
  assert.equal(nodes(short).filter(node => node.type === 'input' || node.type === 'select' || node.type === 'textarea').length, 0)

  // The result card: the winner's own pet, and four ways out, Back among them.
  sandbox.petbResult = { rematch: 0, fresh: 0, replay: 0, back: 0 }
  const result = evaluate(`PetbResult({
    overlay: { result: 'win', title: 'You win!', line: 'All three of the computer’s pets fainted.', turns: 12,
               winner_pet: { name: 'Boba', type: 'Data', slug: 'boba', side: 'you' } },
    picture: {'seed': 4242},
    thumbs: { boba: 'data:image/png;base64,AAA' }, onNeedThumb() {}, busy: false, mode: 'battle',
    onRematch() { petbResult.rematch += 1 }, onNew() { petbResult.fresh += 1 },
    onReplay() { petbResult.replay += 1 }, onBack() { petbResult.back += 1 }
  })`)
  assert.ok(result && result.props['data-testid'] === 'petb-result', 'the result card is the overlay')
  const resultPet = nodes(result).find(node => node.props && node.props['data-testid'] === 'petb-result-pet')
  assert.ok(resultPet, 'the winner’s pet has its own block')
  const sprite = nodes(result).find(node => node && typeof node.type === 'function' && node.type.name === 'PetbSprite')
  assert.equal(sprite.props.slot.slug, 'boba', 'the winner’s real pet is the sprite source')
  assert.equal(sprite.props.thumbs.boba, 'data:image/png;base64,AAA', 'the real thumbnail is handed to the sprite')
  assert.ok(words(result).includes('Boba') && words(result).includes('You win!'), 'the pet and the result are named')
  assert.ok(words(result).includes('12 turns'), 'the turn count is honest')
  for (const label of ['Rematch', 'New battle', 'Watch replay', 'Back to games']) {
    const control = findButton(result, label)
    assert.ok(control, `the result card has ${label}`)
  }
  findButton(result, 'Back to games').props.onClick()
  findButton(result, 'Watch replay').props.onClick()
  findButton(result, 'New battle').props.onClick()
  findButton(result, 'Rematch').props.onClick()
  assert.deepEqual(sandbox.petbResult, { rematch: 1, fresh: 1, replay: 1, back: 1 }, 'every way out works')

  // An old saved battle without winner_pet still names the right pet.
  const fallback = evaluate(`PetbResult({
    overlay: { result: 'lose', title: 'You lose', line: 'Out.', turns: 4 },
    picture: { seed: 7, you: { slots: [{ name: 'Boba', slug: 'boba' }], active: 0 },
               foe: { slots: [{ name: 'Kebo', slug: 'kebo' }], active: 0 } },
    thumbs: {}, onNeedThumb() {}, busy: false, mode: 'battle',
    onRematch() {}, onNew() {}, onReplay() {}, onBack() {}
  })`)
  assert.ok(words(fallback).includes('Kebo'), 'the losing side’s winner pet is the computer’s')

  // How to play: the chart, four moves, switching, and one way to close it.
  sandbox.petbHowtoClosed = 0
  const howto = evaluate('PetbHowTo({ onClose() { petbHowtoClosed += 1 } })')
  for (const pair of ['Ember', 'Verdant', 'Tide', 'Data', 'Shadow', 'Steel']) {
    assert.ok(words(howto).includes(pair), `the chart names ${pair}`)
  }
  assert.ok(words(howto).includes('Four moves and a switch'), 'the card covers moves and switching')
  assert.ok(words(howto).includes('Switching uses your turn'), 'switching is explained')
  const got = findButton(howto, 'Got it')
  assert.ok(got, 'the card can be dismissed')
  got.props.onClick()
  assert.equal(sandbox.petbHowtoClosed, 1, 'dismissing closes it once')

  delete sandbox.petbResult
  delete sandbox.petbHowtoClosed
  delete sandbox.petbPetdex
  delete sandbox.petbLeads
  delete sandbox.petbPicture

  // ---- the whole screen, on the fake hooks: the bug hunt's dead Rematch --------------
  // The press that landed under the result curtain while the last turn's command was
  // still travelling was dropped on the floor, so the finished battle stayed on screen
  // forever. One press is now one battle, whenever it lands.
  const petbSlots = [
    { name: 'Boba', type: 'Data', hp: 60, maxhp: 60, fainted: false, status: {}, slug: 'boba' },
    { name: 'Kebo', type: 'Verdant', hp: 60, maxhp: 60, fainted: false, status: {}, slug: '' },
    { name: 'Scoop', type: 'Tide', hp: 60, maxhp: 60, fainted: false, status: {}, slug: '' }
  ]
  const petbBase = seed => ({
    status: 'active', preview: false, seed, level: 'advanced', level_label: 'Advanced', turn: 0,
    you: { side: 'you', name: 'You', active: 0, slots: petbSlots },
    foe: { side: 'foe', name: 'The computer', active: 0, slots: petbSlots },
    log: [], can_move: true,
    legal: [{ kind: 'move', index: 2, name: 'Heavy Slam', type: 'Steel', power: 60, note: '60 power' }],
    overlay: null,
    catalogue: picture.catalogue,
    enlist: { type: 'Ember', moves: ['cinder-lash', 'guard-up', 'quick-jab', 'scorch'], pets: [] }
  })
  const petbOver = seed => ({
    ...petbBase(seed), status: 'lost', turn: 9, can_move: false, legal: [],
    overlay: {
      result: 'lose', title: 'You lose', line: 'All three of your pets fainted. Bitling was last out.',
      turns: 9, winner_pet: { name: 'Rivetpup', type: 'Steel', slug: '', side: 'foe' }
    }
  })
  const petbCalls = []
  let petbHoldNext = false
  let petbRelease = null
  const petbProps = {
    game: { id: 'pet-battles', title: 'Pet Battles', installed: true },
    view: { player: { id: 'me' }, allow_ai: true },
    board: { picture: petbBase(11) },
    send: async line => {
      petbCalls.push(line)
      if (petbHoldNext) {
        petbHoldNext = false
        return new Promise(resolve => { petbRelease = () => resolve({ ok: true, text: 'ok' }) })
      }
      return { ok: true, text: 'ok' }
    },
    ctx: { rest: async () => ({}) },
    onBack: () => petbCalls.push('back')
  }
  sandbox.petbProps = petbProps
  const petbDraw = () => {
    cursor = 0
    const tree = evaluate('PetBattlePanel(petbProps)')
    const queued = effects
    effects = []
    queued.forEach(run => run())
    return tree
  }
  const petbCurtain = tree => {
    const card = nodes(tree).find(node => node && typeof node.type === 'function' && node.type.name === 'PetbResult')
    if (!card) return null
    sandbox.petbCardProps = card.props
    return evaluate('PetbResult(petbCardProps)')
  }
  const settle = async () => {
    for (let round = 0; round < 6; round += 1) await new Promise(resolve => setImmediate(resolve))
  }

  reset()
  let petbTree = petbDraw()
  assert.equal(petbTree.props['data-testid'], 'petb-screen', 'the battle screen renders')
  // The winning blow is struck: its command is still in flight when the curtain goes up.
  petbHoldNext = true
  const moveTile = nodes(petbTree).find(node => node && typeof node.type === 'function' && node.type.name === 'PetbMoveButton')
  moveTile.props.onPick({ index: 2 })
  assert.deepEqual(petbCalls, ['pet-battles move 2'], 'one move is one command line')
  petbProps.board.picture = petbOver(11)
  petbTree = petbDraw()
  let curtain = petbCurtain(petbTree)
  assert.ok(curtain, 'the result card covers the finished battle')
  const rematch = findButton(curtain, 'Rematch')
  assert.ok(rematch, 'the result card offers Rematch')
  assert.notEqual(rematch.props.disabled, true, 'the way out of the result card is never greyed out')
  rematch.props.onClick()
  assert.equal(petbCalls.length, 1, 'the queued Rematch does not cut in front of the turn in flight')
  petbRelease()
  await settle()
  assert.equal(petbCalls[1], 'pet-battles enlist Ember cinder-lash,guard-up,quick-jab,scorch',
    'a Rematch pressed under the curtain re-enlists the same team')
  assert.ok(String(petbCalls[2]).startsWith('pet-battles new advanced '),
    'and starts the fresh battle the press asked for')

  // Two presses in a row are still one battle, not two.
  petbCalls.length = 0
  petbHoldNext = true
  curtain = petbCurtain(petbDraw())
  findButton(curtain, 'Rematch').props.onClick()
  findButton(curtain, 'Rematch').props.onClick()
  petbRelease()
  await settle()
  assert.equal(petbCalls.filter(line => line.startsWith('pet-battles new ')).length, 1,
    'a double press starts one battle, not two')

  // A start the battle refused to take says so on the card, where the person is looking,
  // and the card can be pressed again.
  petbCalls.length = 0
  petbProps.send = async line => { petbCalls.push(line); return { ok: false, text: 'The save could not be written.' } }
  findButton(petbCurtain(petbDraw()), 'Rematch').props.onClick()
  await settle()
  curtain = petbCurtain(petbDraw())
  assert.ok(words(curtain).includes('The save could not be written.'),
    'a refused Rematch is said on the result card, not behind it')
  findButton(curtain, 'Rematch').props.onClick()
  await settle()
  assert.equal(petbCalls.filter(line => line.startsWith('pet-battles new ')).length, 2,
    'and the card can be pressed again')
  petbProps.send = async line => { petbCalls.push(line); return { ok: true, text: 'ok' } }

  delete sandbox.petbProps
  delete sandbox.petbCardProps
  console.log('pet battles: labs card, real pet cards, result card, how to play, queued Rematch, pure helpers: passed')
}

// Mafia Town: the Labs skin on the mafia table. The pure scene helpers, the card,
// and the panel's night/vote behaviour with a stubbed picture. The mouse proof is
// proof/gm; this only pins the logic.
function mafiaTownContract() {
  // --- pure helpers ------------------------------------------------------------
  assert.equal(evaluate('townPhaseOf("Night 2 · the table sleeps", "active")'), 'night')
  assert.equal(evaluate('townPhaseOf("Day 3 · voting", "active")'), 'vote')
  assert.equal(evaluate('townPhaseOf("Day 1 · talking", "active")'), 'talk')
  assert.equal(evaluate('townPhaseOf("Not started", "idle")'), 'setup')
  assert.equal(evaluate('townPhaseOf("Day 2 · voting", "done")'), 'done')
  assert.equal(JSON.stringify(evaluate('townNewlyOut([1], [{ seat: 0, out: false }, { seat: 1, out: true }, { seat: 2, out: true }])')), '[2]')
  assert.equal(JSON.stringify(evaluate('townNewlyOut([], [])')), '[]')
  assert.equal(evaluate('townVerbOf([{ id: "vote-3" }, { id: "vote-4" }])'), 'vote')
  assert.equal(evaluate('townVerbOf([])'), '')
  assert.equal(
    JSON.stringify(evaluate('townBubbles([{ seat: 0, name: "Ada" }, { seat: 1, name: "Wren" }],'
      + '[{ kind: "say", name: "Ada", text: "The quiet one." }, { kind: "note", name: "Ada", text: "nope" }])')),
    '{"0":"The quiet one."}',
    'only say rows become bubbles, keyed by seat')
}

function mafiaTownPanelContract() {
  const seat = index => ({
    seat: index, env_seat: index, name: ['Ada', 'Wren', 'Ash', 'Kit'][index] || `Seat ${index}`,
    avatar: ['♞', '♜', '♛', '♟'][index] || '●', colour: '#d9a441', kind: index === 0 ? 'human' : 'local',
    you: index === 0, out: false, note: '', playing: false, in_match: true
  })
  const base = {
    schema_version: 2, view: 'mafia', game: 'mafia', title: 'Mafia',
    status: 'active', preview: false, phase: 'Day 1 · talking', phase_kind: 'talk',
    places: [seat(0), seat(1), seat(2), seat(3)], log: [], actions: [],
    can_say: false, can_move: false, can_step: false, your_seat: 0, your_turn: false,
    turn_seat: 1, turn_name: 'Wren', watching: false, mine: {}, coach: null,
    reveal: null, standings: [], share: null, notes: [], calls: { used: 0, cap: 0 },
    estimate: 0, draft: [], think: []
  }
  const calls = []
  const props = {
    game: { id: 'mafia', title: 'Mafia', installed: true, kind: 'play' },
    view: { player: { id: 'me' }, allow_ai: true },
    board: { picture: base },
    send: async line => { calls.push(line); return { text: 'done', ok: true } },
    onBack: () => calls.push('back'),
    onClassic: () => { townOn.value = false; calls.push('classic') },
    refresh: async () => {}, ctx: {}
  }
  const townOn = { value: true }
  sandbox.townProps = props
  sandbox.townOn = townOn
  // Seats are components of the panel; walk into them for the per-seat assertions.
  const deep = tree => nodes(tree).flatMap(node => node && typeof node.type === 'function' ? deep(node.type(node.props || {})) : [node])
  const draw = () => {
    cursor = 0
    const tree = evaluate('MafiaTown(townProps)')
    const pending = effects
    effects = []
    pending.forEach(effect => effect())
    return tree
  }
  reset()

  // Day talk: the square is on screen, the say box is there but shut, nobody clickable.
  let tree = draw()
  const root = nodes(tree).find(node => node.props && node.props['data-town'] === 'mafia-town')
  assert.ok(root, 'the town screen renders')
  assert.ok(nodes(tree).find(node => node.props && node.props['data-town-scene'] === 'true'), 'the square itself')
  assert.equal(deep(tree).filter(node => node.props && node.props['data-town-seat']).length, 4, 'four seats stand in the square')
  assert.ok(nodes(tree).find(node => node.props && node.props['data-town-say']), 'a say box exists')
  assert.equal(nodes(tree).filter(node => node.type === 'select').length, 0, 'no drop-downs in play')
  const shade = nodes(tree).find(node => node.props && node.props['data-town-nightshade'])
  assert.equal(shade.props['data-town-nightshade'], 'false', 'day is light')

  // The Labs card offers the town and one Open button.
  const card = evaluate('MafiaTownCard({ onOpen: () => calls.push("town") })')
  assert.equal(nodes(card).filter(node => node.props && node.props['data-labs-card'] === 'mafia-town').length, 1)
  assert.ok(findButton(card, 'Open Mafia Town'), 'the card opens the town')

  // Voting, my turn: the legal targets are the only enabled portraits, and a click
  // on one is one act line — no menus, no typing.
  props.board.picture = {
    ...base, phase: 'Day 2 · voting', phase_kind: 'act', can_move: true, your_turn: true,
    actions: [{ id: 'vote-1', label: 'Wren' }, { id: 'vote-2', label: 'Ash' }]
  }
  tree = draw()
  const wren = deep(tree).find(node => node.props && node.props['data-town-seat'] === '1')
  const kit = deep(tree).find(node => node.props && node.props['data-town-seat'] === '3')
  assert.equal(wren.props.disabled, false, 'a legal target is clickable')
  assert.equal(kit.props.disabled, true, 'a seat nobody voted for stays at rest')
  wren.props.onClick()
  assert.deepEqual(calls, ['mafia act vote-1'], 'one click is one vote')

  // Night: the shade is drawn, and my night move names itself in the status line.
  props.board.picture = {
    ...base, phase: 'Night 2 · the table sleeps', phase_kind: 'act', can_move: true, your_turn: true,
    actions: [{ id: 'protect-2', label: 'Ash', hint: 'Protect' }]
  }
  tree = draw()
  const nightShade = nodes(tree).find(node => node.props && node.props['data-town-nightshade'])
  assert.equal(nightShade.props['data-town-nightshade'], 'true', 'night darkens the town')
  assert.ok(nodes(tree).find(node => node.props && node.props['data-town-star']), 'stars at night')
  assert.ok(words(tree).includes('Your night move'), 'the night move says itself')

  // Out seats become gravestones; the done overlay carries the verdict and roles.
  props.board.picture = {
    ...base, status: 'done', phase: 'The game is over',
    places: [seat(0), { ...seat(1), out: true }, seat(2), seat(3)],
    reveal: { roles: [{ seat: 0, role: 'Villager' }, { seat: 1, role: 'Mafia' }], mafia: [1], winners: [0, 2, 3], reason: 'The village won.' }
  }
  tree = draw()
  assert.ok(deep(tree).find(node => node.props && node.props['data-town-grave']), 'a gone player is a gravestone')
  const over = nodes(tree).find(node => node.props && node.props['data-town-over'])
  assert.ok(over, 'the result overlays the town')
  assert.ok(words(tree).includes('You won') && words(tree).includes('The village won.'), 'the overlay names the result')
  tree = draw() // the roles land from an effect; draw again on the settled state
  assert.ok(deep(tree).find(node => node.props && node.props['data-town-role']), 'roles are revealed on the portraits')

  // Watching: the ribbon, and the classic table is one click away.
  props.board.picture = { ...base, watching: true }
  tree = draw()
  assert.ok(nodes(tree).find(node => node.props && node.props['data-town-ribbon']), 'watching is labelled')
  const classic = [...nodes(tree)].reverse().find(node => node.type === 'button' && words(node) === 'Classic table')
  classic.props.onClick()
  assert.ok(calls.includes('classic'), 'Classic table leaves the skin')
  assert.equal(townOn.value, false, 'the skin is off once the classic table is asked for')
  assert.equal(nodes(tree).filter(node => node.type === 'input').length <= 1, true, 'typing is only ever the say box')
  delete sandbox.townProps
  delete sandbox.townOn
  console.log('mafia town: pure helpers, card, night and vote panel, result overlay: passed')
}

// The referee's badge: when a model's moves were refused and the built-in player moved
// for it, the refused ply carries a "Referee said no" badge naming the proposals.
async function refereeBadgeContract() {
  reset()
  props.view = { viewer_id: 'me', player: { id: 'me' }, allow_ai: true }
  props.send = async line => { calls.push(line); return { ok: true, text: 'OK' } }
  props.board.picture = {
    ...active, game: 'connect4', view: 'connect4', table_id: 'referee-table',
    moves: ['4', '5', '6'], plies: 3,
    seats: [
      { side: 'white', kind: 'human', id: 'me', name: 'Ada', open: false },
      { side: 'black', kind: 'agent', id: 'agent', name: 'Your agent', open: false }
    ],
    refusals: [{ ply: 1, side: 'black', played: '5', proposals: [
      { proposed: '9', reason: 'that isn\'t a move in this game' },
      { proposed: '0', reason: 'Columns run from 1 to 7.' }
    ] }]
  }
  tree = render()
  const badge = nodes(tree).find(node => words(node) === 'Referee said no')
  assert.ok(badge, 'the ply the built-in player covered for is badged in the move history')
  const refusedCell = nodes(tree).find(node => node.key === 'b1')
  assert.ok(refusedCell && words(refusedCell).includes('Referee said no'), 'the badge sits on the move it refused for')
  const ownCell = nodes(tree).find(node => node.key === 'w1')
  assert.ok(ownCell && !words(ownCell).includes('Referee said no'), 'the model\'s own legal moves wear no badge')
  const said = String(badge.props.title || '')
  assert.ok(said.includes('9') && said.includes('Columns run from 1 to 7.'), 'the badge names each refused proposal and its reason: ' + said)
  assert.ok(/built-in player/i.test(said) && said.includes('5'), 'and says the built-in player moved for it: ' + said)
  reset()
  props.board.picture = { ...props.board.picture, refusals: [] }
  tree = render()
  assert.equal(nodes(tree).find(node => words(node) === 'Referee said no'), undefined, 'no refusals, no badge')
  reset()
  console.log('referee badge on refused moves: passed')
}



{
  // A crash inside a game is contained: the card offers Back and Close, and Back remounts fresh.
  const resets = []
  const closes = []
  const boundary = evaluate(`new GamesBoundary({ where: 'page', children: 'GAME', onReset: () => {}, onClose: () => {} })`)
  boundary.props.onReset = () => resets.push(1)
  boundary.props.onClose = () => closes.push(1)
  const healthy = boundary.render()
  assert.equal(healthy.props.children, 'GAME')
  Object.assign(boundary.state, evaluate('GamesBoundary').getDerivedStateFromError(new Error('boom')))
  const card = JSON.stringify(boundary.render(), (key, value) => (typeof value === 'function' ? 'fn' : value))
  assert.ok(card.includes('Back to games') && card.includes('Close') && card.includes('boom'), card)
  const buttons = []
  const walk = node => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.type === 'button' && node.props && node.props.onClick) buttons.push(node)
    if (node.props) walk(node.props.children)
  }
  walk(boundary.render())
  buttons.find(item => JSON.stringify(item.props.children).includes('Back')).props.onClick()
  assert.equal(resets.length, 1)
  assert.equal(boundary.state.failure, null)
  assert.equal(boundary.state.generation, 1)
  console.log('games boundary: crash card with Back and Close: passed')
}

{
  // × takes the wait pane off the screen completely: its registration is disposed,
  // and the palette / status item register it again.
  const live = new Set()
  const fakeCtx = {
    registerMany: list => {
      list.forEach(item => live.add(item.id))
      return () => list.forEach(item => live.delete(item.id))
    },
    storage: { get: () => undefined, set: () => {} },
    rest: async () => ({})
  }
  evaluate('WAIT_PANE_SLOT').dispose = null
  evaluate('rememberPaneGone')(false)
  evaluate('plugin').register(fakeCtx)
  assert.ok(live.has('pane') && live.has('page'), [...live].join(','))
  evaluate('closeWaitPane')()
  assert.ok(!live.has('pane') && live.has('page'), 'closing removes only the pane')
  evaluate('openWaitPane')()
  assert.ok(live.has('pane'), 'opening registers it again')
  console.log('wait pane: × removes it completely, open brings it back: passed')
}

{
  // Keys typed into the chat composer beside the board must never reach Sea Battle.
  assert.equal(evaluate('typeof seaTyping'), 'function', 'the typing guard exists')
  assert.equal(evaluate('seaTyping({ target: { closest: s => s.indexOf("input") >= 0 ? {} : null } })'), true, 'a text field swallows the key')
  assert.equal(evaluate('seaTyping({ target: { isContentEditable: true } })'), true, 'contenteditable counts as typing')
  assert.equal(evaluate('seaTyping({})'), false, 'a key with no target still plays the board')
  const start = source.indexOf('const onDown = event => {')
  const handler = source.slice(start, start + 900)
  const guard = handler.indexOf('if (seaTyping(event)) return')
  assert.ok(guard > -1, 'the board checks the guard')
  assert.ok(guard < handler.indexOf('preventDefault'), 'the guard runs before any preventDefault')
  console.log('sea battle: keys typed in chat never move the board: passed')
}

{
  // A kill is never reported as a plain hit: the line names whose ship went down.
  assert.equal(evaluate('seaShotWords({ side: "white", square: "D4", result: "sunk", ship: "battleship" }, "white")'), '💥 You sank the enemy battleship at D4')
  assert.equal(evaluate('seaShotWords({ side: "black", square: "A1", result: "sunk", ship: "cruiser" }, "white")'), '☠ The enemy sank your cruiser at A1')
  assert.equal(evaluate('seaShotWords({ side: "white", square: "C3", result: "hit" }, "white")'), 'You hit at C3')
  assert.equal(evaluate('seaShotWords({ side: "white", square: "C3", result: "sunk", ship: "destroyer" }, "white")').indexOf('enemy destroyer') > 0, true)
  console.log('sea battle: a sunk ship is named, not called a hit: passed')
}

{
  // Focus decides: a text field in focus keeps every key, the board in focus plays.
  const doc = sandbox.document
  doc.activeElement = { tagName: 'TEXTAREA' }
  assert.equal(evaluate('seaTyping({})'), true, 'a focused composer keeps every key')
  doc.activeElement = { tagName: 'DIV', isContentEditable: false, closest: () => null }
  assert.equal(evaluate('seaTyping({ target: { closest: () => null } })'), false, 'the focused board plays')
  doc.activeElement = null
  console.log('sea battle: the focused board, not the composer, gets the keys: passed')
}

{
  // Sound: one remembered switch, and no audio stack is silence rather than a throw.
  const store = {}
  sandbox.window.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v) } }
  assert.equal(evaluate('gamesSoundOn()'), true, 'sound is on by default')
  evaluate('gamesSoundSet(false)')
  assert.equal(evaluate('gamesSoundOn()'), false, 'the switch is remembered on this machine')
  evaluate('gamesSoundSet(true)')
  assert.equal(evaluate('gamesSoundOn()'), true)
  assert.equal(evaluate("gamesSound('win')"), undefined, 'no audio stack means silence, not a crash')
  assert.equal(evaluate('typeof SoundSetting'), 'function', 'the settings row exists')
  console.log('sound: one remembered switch, silence when there is no audio stack: passed')
}

{
  // Hitting the enemy fleet shakes the board; being hit does not.
  assert.equal(evaluate('seaBoomFor({ side: "white", result: "hit" }, "white")'), 'hit', 'your hit on their fleet explodes')
  assert.equal(evaluate('seaBoomFor({ side: "white", result: "sunk" }, "white")'), 'sunk', 'a sinking is the big one')
  assert.equal(evaluate('seaBoomFor({ side: "black", result: "hit" }, "white")'), '', 'taking a hit is not your explosion')
  assert.equal(evaluate('seaBoomFor({ side: "white", result: "miss" }, "white")'), '', 'a miss is quiet')
  assert.equal(evaluate('seaBoomFor(null, "white")'), '', 'no shot, no bang')
  console.log('sea battle: your hits shake the water, theirs do not: passed')
}

{
  // The hit graphics are centred on the square that was fired at, inside the fleet it was
  // fired into — not on the panel between the two boards, which is what a full-panel bloom
  // looked like. The maths is pure, so the two rects pin it exactly.
  const panel = { left: 100, top: 50, width: 700, height: 420 }
  const enemyWaters = { left: 420, top: 90, width: 300, height: 300 }
  const e5 = { left: 420 + 4 * 28, top: 90 + 5 * 28, width: 28, height: 28 }
  const flash = evaluate(`seaBoomCentre(${JSON.stringify(panel)}, ${JSON.stringify(e5)})`)
  assert.equal(flash.x, e5.left - panel.left + 14, 'the flash sits on the centre of the square (x)')
  assert.equal(flash.y, e5.top - panel.top + 14, 'the flash sits on the centre of the square (y)')
  assert.ok(flash.size >= 120, 'a flash big enough to read')
  // A different square moves the flash: it tracks the shot, not the middle of the table.
  const j10 = { left: 420 + 9 * 28, top: 90 + 9 * 28, width: 28, height: 28 }
  const other = evaluate(`seaBoomCentre(${JSON.stringify(panel)}, ${JSON.stringify(j10)})`)
  assert.notEqual(other.x, flash.x, 'another square is another place')
  assert.notEqual(other.y, flash.y, 'another rank is another place')
  // The banner is centred on the fleet the shot landed in.
  const banner = evaluate(`seaBoardCentre(${JSON.stringify(panel)}, ${JSON.stringify(enemyWaters)})`)
  assert.equal(banner.x, enemyWaters.left - panel.left + 150, 'the banner sits in the middle of those waters (x)')
  assert.equal(banner.y, enemyWaters.top - panel.top + 150, 'the banner sits in the middle of those waters (y)')
  // No layout to measure (a host with no real boxes) must not throw or land at NaN.
  const bare = evaluate('seaBoomCentre({}, {})')
  assert.ok(Number.isFinite(bare.x) && Number.isFinite(bare.y), 'a missing layout still gives a number')
  // And the render reads those numbers rather than a percentage of the panel.
  assert.ok(source.indexOf("'data-sea-boom-at': boom.at ?") > 0, 'the flash reports where it was put')
  console.log('sea battle: hit graphics centre on the square that was fired at: passed')
}

{
  // The last reel must never run past the drawn strip: that is what emptied the third column.
  const covers = (reels, size, rows) => {
    const copies = evaluate('SM_copiesFor(' + reels + ')')
    const travel = 4 * size + (size - 1) + (2 + reels - 1) * size
    return copies * size >= travel + rows
  }
  assert.equal(covers(3, 20, 3), true, 'Fruit Classic: three reels of 20, three rows')
  assert.equal(covers(3, 6, 1), true, 'Hermes Robots: three reels of 6, one row')
  assert.equal(covers(1, 20, 1), true, 'a one-reel machine')
  // The old count is exactly what broke it, so the guard is not vacuous.
  assert.equal(8 * 20 >= 179 + 3, false, 'the old eight copies ran out on the third reel')
  console.log('slot machine: every reel has strip left while it spins: passed')
}

{
  // Columns land one at a time, and each one later than the one before it.
  const land = [0, 1, 2].map(reel => {
    const start = evaluate('SM_KICK_MS') + reel * evaluate('SM_STAGGER_MS')
    return start + evaluate('SM_STOP_MS[Math.min(' + reel + ', SM_STOP_MS.length - 1)]')
  })
  assert.ok(land[0] < land[1] && land[1] < land[2], 'reels land left to right: ' + land.join(','))
  assert.ok(land[1] - land[0] >= 100 && land[2] - land[1] >= 100, 'and far enough apart to be seen: ' + land.join(','))
  assert.ok(evaluate('SM_STAGGER_MS') > 0, 'the columns do not start together')
  console.log('slot machine: columns run and land one at a time: passed')
}

{
  // Auto-spin looked on and never fired: the table's switch wrote through a door that was
  // not wired, and the optimistic value stayed on screen. Both halves are guarded here.
  assert.equal(evaluate('jpSwitchValue({ autoplay: true }, false)'), true, 'the server answer wins')
  assert.equal(evaluate('jpSwitchValue(null, false)'), false, 'a dropped write shows the truth, not a lie')
  assert.equal(evaluate('jpSwitchValue({ autoplay: false }, true)'), false, 'turning it off is believed')
  const table = source.slice(source.indexOf('function SlotsTable('), source.indexOf('// ---- 19-jackpot-overlay.js'))
  assert.ok(table.includes('onSetting'), 'the table accepts its own API door')
  assert.ok(table.includes("slotsSetting('/jackpot/autoplay', { on }, onSetting)"), 'the switch uses that door')
  const page = source.slice(source.indexOf("? jsx(drawnView === 'blackjack' ? BlackjackTable : SlotsTable"))
  assert.ok(page.slice(0, 700).includes('onSetting: (path, body) => ctx.rest'), 'the game page hands over the door')
  assert.ok(source.includes('onSetting: (path, body) => ctx.rest(path, { method: \'POST\', body })'), 'the wait pane hands it over too')
  console.log('slots: the auto-spin switch writes through a real door: passed')
}

{
  // Chips only: the machine shows a bet ladder, no pulls or earned, and reports whether it is
  // on screen so nothing spins behind a closed machine.
  assert.equal(evaluate('typeof jpVisible'), 'function', 'the visibility counter exists')
  assert.ok(source.includes("data-sm-bet"), 'the bet ladder renders')
  assert.ok(!source.includes("counter('Pulls'"), 'no pulls counter is left in the machine')
  assert.ok(!source.includes("counter('Earned'"), 'no earned counter is left in the machine')
  assert.ok(source.includes("jpVisible(1, onSetting)") && source.includes("jpVisible(-1, onSetting)"),
    'the table reports itself visible while open')
  assert.ok(source.includes("data-sm-celebrate"), 'a big win takes the screen')
  assert.ok(source.includes("gamesSound(big ? 'jackpot' : 'win', { scale })"), 'the win sound scales with the payout')
  // The celebration ends by itself, whatever the spin loop does: its own timer, a rain whose length
  // is the win's length, and a new result that drops the overlay instead of orphaning its timer.
  assert.ok(source.includes("data-sm-bet-locked"), 'the bet ladder is marked locked while auto-bet is on')
  // The reels are the machine: bigger cells, and a cabinet that is not pushed left by the space kept
  // for the lever. The glass prints the headline pays on the cabinet itself (owner's ask, 2026-11-09).
  assert.ok(source.includes('SM_px(70)') && source.includes('SM_px(48)'), 'the three-row wheels are bigger')
  assert.ok(/marginLeft: SM_px\(24\), marginRight: SM_px\(24\)/.test(source), 'the cabinet has equal margins, so it sits centred')
  assert.ok(source.includes("data-sm-glass"), 'the cabinet carries a printed pay strip')
  // The cabinet is as wide as its reels, the shape 9433891 drew (284 px of cabinet around 235 px of
  // reels). Everything printed on it - the pay strip and the points card - wraps INSIDE that width.
  // A card that measured its own sentences into the cabinet grew it to 852 px against 274 px of
  // reels, and the reels sat small at the left of it (owner's report, 2026-11-10: "the current
  // cabinet is drawn elongated ... reels small on the left"). Pinned as the deck, not a magic
  // number, because the deck is the window plus its own border, the markers and the row's gaps.
  assert.ok(source.includes('const deckW = windowW + 2 * (SM_px(4) * 2 + SM_px(16))'),
    'the cabinet is sized by its reels, as in 9433891')
  assert.equal((source.match(/maxWidth: deckW/g) || []).length, 2,
    'both printed strips wrap inside the deck width instead of stretching the cabinet')
  // The comeback ladder: a graded tap when the wallet is empty, a cooldown to come back to, and the
  // premium on the following wins (owner's ask, 2026-11-09: "really gamify this so its addictive").
  assert.ok(source.includes("data-sm-bailout-start"), 'the empty wallet is offered a skill shot')
  assert.ok(source.includes("data-sm-egg"), 'a hidden egg can be marked on the cabinet')
  // A find is announced and animated, and the reveal is a fixed pointer-transparent layer so it can
  // never block a click or leave the machine needing a reload.
  assert.ok(source.includes("data-sm-eggs-found"), 'a found egg is announced')
  // The copy over the chat is the same machine as the wait pane: points card, ladder and printed
  // glass, not a bare cabinet.
  assert.ok(source.includes('chat: true,') && source.includes('bare: false,'),
    'the over-chat machine draws the full machine, points and all')
  assert.ok(source.includes("'data-jackpot': 'overchat'"), 'and it is the over-chat copy that does')
  assert.ok(source.includes('@keyframes sm-egg-pop') && source.includes('@keyframes sm-egg-spark'),
    'the reveal animates')
  assert.ok(/position: 'fixed', inset: 0, zIndex: 81, pointerEvents: 'none'/.test(source),
    'the reveal cannot swallow clicks')
  assert.ok(source.includes("onEgg: id => post('/eggs/claim'"), 'the over-chat copy can claim it')
  assert.ok(source.includes("data-sm-bailout-tap"), 'the tap button exists while the shot runs')
  assert.ok(source.includes('sm-sweep 1100ms linear infinite'), 'the marker sweeps at the graded period')
  assert.ok(source.includes("onBailout: grade => post('/jackpot/bailout'"), 'the over-chat copy can post a grade')
  // A paytable row is a run of symbols, and each one is drawn with its picture: the plain string used
  // to reach the screen as the word NOUS three times while the reels showed the Nous mark
  // (owner's report, 2026-11-09: "replace nous nous nous ... with the images").
  assert.ok(source.includes('function SM_symbolRun('), 'paytable rows are drawn symbol by symbol')
  assert.ok(source.includes("'data-sm-plate'"), 'the picture symbols sit on a pale plate, so the line reads on a dark drum')
  // Sea Battle says what to do at the top, above the boards, not under them; the table shows the
  // person's points; and a win outside blackjack shows the 100-point payout on the result card.
  assert.ok(source.indexOf("'data-sea-hint'") > 0 && source.indexOf("'data-sea-hint'") < source.indexOf("className: 'games-seabattle-boards'"),
    'sea battle guidance sits above the boards')
  assert.ok(source.includes("'data-gm-points'"), 'the table shows the points total')
  assert.ok(source.includes("'data-gm-win-bonus'"), 'a win shows the 100-point payout')
  // Who you are playing is named on the table with one "You vs <opponent>" line, and a move
  // paints from the command's own reply instead of waiting for a second round trip. Online
  // play is the in-Hermes lobby now, so this table carries no browser "find a match" door.
  assert.ok(source.includes("'data-gm-opponent'"), 'the table names its opponent')
  assert.ok(source.includes("'data-gm-vs'"), 'the one who-line carries the seat-kind hook')
  assert.ok(!source.includes("'data-gm-findmatch'"), 'and offers no browser door to find a match')
  // The see-through machine is fitted to the SLOT it is given (review, 2026-11-12): the composer's
  // underside measures its own box, hands each machine a share of the width, and the copy is fitted into
  // that share with a height budget — never against the window, and never against the app's markup.
  assert.ok(source.includes('function overchatFitScale'), 'the copy is fitted to the width it was given')
  assert.ok(source.includes('OVERCHAT_MAX_HEIGHT'), 'and to a height budget, so it cannot eat the chat')
  assert.ok(source.includes('OVERCHAT_SLOT') && source.includes('minWidth: 0'),
    'the strip hands each machine a shrinking share of one row')
  assert.ok(!source.includes('ceilingHeight'), 'the window is no longer measured at all')
  assert.ok(!source.includes('const frame = rect && rect.width && rect.height ? rect : null'),
    'and no chat column is measured off the app')
  assert.ok(!source.includes('Math.min(columnWidth, holder.width)'),
    'the status-bar span is never used as the frame')
  assert.ok(source.includes('if (answer && answer.picture) setBoard('), 'a move paints from the command reply')
  assert.ok(/SM_symbolRun\(row\.symbol/.test(source), 'the glass and the scoring card both use it')
  // The points panel is a card, not small print: the balance as the headline, its worth beside it,
  // and a bar showing how close the next point is (owner's ask, 2026-11-09: "make the point
  // advertising more clear and look nicer").
  assert.ok(source.includes("data-sm-point-progress"), 'the points card shows progress to the next point')
  assert.ok(source.includes("data-sm-points-worth"), 'the card says what the balance is worth in chips')
  assert.ok(source.includes("10 points for every 1M tokens in + out"), 'the earning rule is spelled out in words')
  assert.ok(source.includes('disabled: Boolean(busy) || Number(chips) < amount || autobetShown'),
    'with auto-bet on, the multiplier buttons are disabled, not offered and ignored')
  assert.ok(!/sm-rain[^`]*infinite/.test(source), 'the coin rain is not an infinite animation')
  assert.ok(source.includes('const hold = big ? Math.min(300, Math.max(20, tier.seconds)) : Math.min(10, tier.seconds)'),
    'a normal win rains at most 10 s, a jackpot at most 5 minutes')
  assert.ok(source.includes('if (!celebrate) return undefined'), 'the overlay clears itself on its own deadline')
  assert.ok(source.includes('smClearCelebrations()'), 'toggling "Show over chat" clears a celebration at once')
  assert.ok(source.includes("data-sm-stop"), 'the person can stop a celebration by hand')
  // A handle used but never declared is a crash `node --check` cannot see: the bundle loaded, the
  // machine threw "celebrateTimer is not defined" on the first result, and the desktop closed the
  // game with "This game hit a problem" (owner's screenshot, 2026-11-09).
  const machineStart = source.indexOf('function SlotMachine({')
  const machineEnd = source.indexOf('\nfunction ', machineStart + 10)
  const machine = source.slice(machineStart, machineEnd > machineStart ? machineEnd : source.length)
  const refs = new Set([...machine.matchAll(/const (\w+) = useRef\(/g)].map(match => match[1]))
  const handles = new Set([...machine.matchAll(/\b(\w+)\.current\b/g)].map(match => match[1]))
  const undeclared = [...handles].filter(name => !refs.has(name))
  assert.deepEqual(undeclared, [], `every ref handle is declared: ${undeclared.join(', ') || 'none'}`)
  assert.ok(/\$\{rainRuns\} both/.test(source), 'the rain runs for the celebration, then stops off-screen')
  console.log('slots: bet ladder, chips only, visible-only spins, celebration: passed')
}

{
  // A watched surface must not sit a beat behind the person: a poll of three or five seconds reads as
  // lag even when the server answered at once (owner's report, 2026-11-09: "latency of a few seconds").
  assert.ok(source.includes('setInterval(load, 600)'), 'the over-chat overlay reads every 600 ms')
  assert.ok(source.includes('setInterval(() => load(), 1000)'), 'the waiting pane reads every second')
  assert.ok(source.includes("SDK_HOST.onEvent('message.start', () => load())"),
    'a sent message refreshes the waiting pane at once instead of waiting for a tick')
  assert.ok(source.includes("ctx.rest(`/board?game="), 'the pane still reads the board every tick, so a move shows at once')
  assert.ok(!source.includes('wait = Math.min(5000'), 'a failed read backs off to 1.5 s, not 5 s')
  console.log('slots: no watched surface polls slower than a second: passed')
}

{
  // The reward line is read by a person, not parsed: two plain sentences instead of a rate in
  // brackets, and the waiting time to the next point said out loud.
  assert.ok(source.includes("data-sm-points-line"), 'the points are said in a plain sentence')
  assert.ok(source.includes("data-sm-tokens-line"), 'the tokens line says how far the next point is')
  assert.ok(!source.includes('(10 points per 1M)'), 'the old bracketed rate is gone')
  assert.ok(source.includes('justifyContent: \'center\''),
    'the strip centres the machines it draws, without measuring a chat column to centre them on')
  console.log('slots: points in plain words, over-chat centred: passed')
}

{
  // A slot machine makes no decisions, so the skill controls are greyed out, never offered:
  // Learn to play, Hint, the coach strip and any level buttons.
  assert.ok(source.includes("data-skill-greyed"), 'the skill controls are marked as greyed')
  assert.ok(source.includes("String(pictured.view || game.id) === 'slots'"), 'the slot table is treated as skill-less')
  assert.ok(source.includes('Slots has no skill levels: every spin has the same published odds.'),
    'the tooltip says why they are off')
  assert.ok(/disabled: off \|\| skillless/.test(source), 'level buttons are disabled on a slot machine')
  console.log('slots: the skill controls are greyed out, not offered: passed')
}


{
  // Auto-spin is a switch, not a move: it must answer while a spin is in flight, show the
  // shelf's own answer, and it must be the same door on the table and in the panel.
  assert.ok(source.includes('const setAutoplay = async on =>'), 'the panel has its own switch handler')
  assert.ok(!/const setAutoplay = async on => \{[^}]*if \(busy\)/.test(source), 'a spin in flight cannot block the switch')
  assert.ok(source.includes("onAutoplay: setAutoplay"), 'the panel passes it to the machine')
  assert.ok(source.includes("onAutoplay: async on =>"), 'the table has its own')
  assert.ok(source.includes('jpSwitchValue(answer, p.autoplay)'), 'the table shows the server value')
  assert.ok(!source.includes('jpBackdrop'), 'the backdrop feature is gone')
  assert.ok(!source.includes('useJpCenter'), 'the centre-machine memory is gone')
  console.log('slots: auto-spin can be turned on and off from either surface: passed')
}

{
  // The owner asked for 85% of the old machine size, and the separate robots game is gone.
  // Owner's ask 2026-11-09: 20% smaller than the 85% it was, and the size is a slider now.
  // Owner's correction: only the see-through copy over the chat changes size; the table and the
  // Play page keep the size they had.
  assert.equal(evaluate('SM_SCALE_DEFAULT'), 1, 'the over-chat copy starts at the Game Center size')
  assert.equal(evaluate('SM_SCALE_TABLE'), 0.85, 'the machine where it is played keeps its size')
  assert.equal(evaluate('SM_SCALE'), 0.85, 'a machine draws at the table size by default')
  assert.equal(evaluate('SM_SCALE_MIN'), 0.1, 'the slider goes down to a tenth of the cabinet')
  assert.equal(evaluate('SM_SCALE_MAX'), 3, 'and up to three times it, which fills the window')

  assert.equal(evaluate('SM_SCALE_STEP'), 0.05, 'the slider steps in 5%')
  assert.equal(evaluate('SM_clampScale(1)'), 1, 'the 100% default sits exactly on the step grid')
  assert.ok(source.includes("'data-sm-scale-range': '1'"), 'the size control is a slider')
  assert.ok(source.includes("'data-sm-scale-reset': '1'"), 'the slider can be reset')
  assert.ok(!source.includes("['slots', 'robots']"), 'no code still treats robots as a separate game')
  console.log('slots: the over-chat copy starts at the table size and has its own slider: passed')
}

{
  // Ship placement: the anchor sent is the hull's far end, so the hull lands on the
  // squares the ghost highlighted. Before this the near square was sent and every
  // vertical ship appeared on the opposite side of the drop, or vanished at the top
  // of the board because the anchor ran off the water.
  assert.equal(evaluate("seaAnchor(5, 5, 0, 'v')"), 'a1', 'a carrier dropped at a5 hangs down to a1')
  assert.equal(evaluate("seaAnchor(5, 0, 0, 'v')"), 'a6', 'the top of the board is placeable')
  assert.equal(evaluate("seaAnchor(4, 4, 0, 'h')"), 'a6', 'a horizontal hull keeps the square under the pointer')
  assert.equal(evaluate("seaAnchor(2, 8, 9, 'v')"), 'j1', 'the bottom rows anchor themselves')
  assert.ok(source.includes('${seaAnchor(carried.size, row, col, carried.orient)}'),
    'the drop handler names the anchor, not the square under the pointer')
  assert.ok(!/place \$\{carried\.name\} \$\{name\} \$\{carried\.orient\}/.test(source),
    'the near-square anchor is gone')
  console.log('seabattle: a dropped hull lands on the squares the ghost showed: passed')
}

{
  // Owner's ask 2026-11-09: no alert drops anywhere for now - the component stays in the bundle,
  // so bringing it back is one line, but nothing renders it.
  assert.ok(!source.includes('jsx(AlertLine'), 'no alert drop is rendered on any screen')
  assert.ok(source.includes('function AlertLine'), 'the component itself is still there to restore')
  console.log('alerts: no drops anywhere, component kept: passed')
}

{
  // Owner's ask 2026-11-09: the ships you still have to place sit under your own waters, so the
  // drag is short, instead of under the enemy's board where they used to be centred.
  const columnAt = source.indexOf("'games-sea-own-column'")
  const enemyAt = source.indexOf("title: side ? 'ENEMY WATERS'")
  const usedAt = source.indexOf('trayBlock,', columnAt)
  assert.ok(columnAt > -1, 'your waters and the tray share a column')
  assert.ok(usedAt > columnAt && usedAt < enemyAt, 'the tray is drawn inside that column, before the enemy board')
  assert.equal((source.match(/'aria-label': 'Ship tray'/g) || []).length, 1, 'there is one ship tray')
  assert.ok(source.includes("'data-sea-tray': 'done'"), 'the deployed note sits in the same column')
  console.log('sea battle: the ship tray sits under your waters: passed')
}

{
  // Owner's ask 2026-11-09: after placement the game must say what to do next.
  assert.ok(source.includes("'data-sea-hint': '1'"), 'the table shows a next-step line')
  assert.ok(source.includes('Click any square in ENEMY WATERS to fire'), 'the fire phase tells you where to click')
  assert.ok(source.includes('Drag a ship from the tray under YOUR WATERS'), 'the place phase says where the ships come from')
  assert.ok(source.includes('Waiting for the other side to place'), 'the wait says what it is waiting for')
  console.log('sea battle: the table says what to do next: passed')
}

{
  // Owner's report 2026-11-09: the shooter got the big lettering, the enemy's screen did not.
  assert.ok(source.includes("☠ Your ${shipName} went down!"), 'the defender is told in words')
  assert.ok(!source.includes('if (firstLook) return undefined'),
    'the newest shot is not swallowed by a fresh view')
  // Owner's report 2026-11-09: "it tells me things late or after it already told me". One shot,
  // once, immediately: no 520 ms stagger, no replay when the pass card lifts.
  assert.ok(!source.includes('index * 520'), 'banners are not staggered behind the board')
  // One shot is spoken - the biggest news, not merely the newest (owner's report 2026-11-11: your
  // own sinking shot was swallowed by the computer's instant reply miss).
  assert.ok(!source.includes('const shot = fresh[fresh.length - 1]'), 'the newest shot no longer wins by default')
  const pickLine = source.split('\n').find(line => line.includes('const shot = fresh.reduce('))
  const weightLine = source.split('\n').find(line => line.includes("const weight = row => (row.result === 'sunk'"))
  assert.ok(pickLine && weightLine, 'the banner picks among the new shots by weight')
  const pick = new Function('fresh', `${weightLine}\n${pickLine}\nreturn shot`)
  const mineSunk = { side: 'white', result: 'sunk', ship: 'cruiser' }
  const replyMiss = { side: 'black', result: 'miss' }
  assert.equal(pick([mineSunk, replyMiss]), mineSunk, 'your sinking shot beats the reply miss behind it')
  assert.equal(pick([{ side: 'white', result: 'hit' }, replyMiss]).result, 'hit', 'your hit beats the reply miss')
  const theirSunk = { side: 'black', result: 'sunk', ship: 'destroyer' }
  assert.equal(pick([{ side: 'white', result: 'miss' }, theirSunk]), theirSunk, 'their sinking shot is still spoken')
  assert.equal(pick([mineSunk, theirSunk]), theirSunk, 'two sinkings: the latest is spoken')
  assert.ok(source.includes('if (cover) return undefined'), 'nothing is marked seen behind the pass card')
  assert.ok(source.includes('primed.current'), 'arriving mid-game announces the history, not the board')
  assert.ok(source.includes('}, [shotKey, cover, onScreen])'), 'the banner effect watches the cover and its own visibility')
  console.log('sea battle: both seats are told when a ship goes down: passed')
}

{
  // Owner's correction 2026-11-09: every graphic is centred on the board it is about - a hit you
  // land appears on ENEMY waters, a hit you take on your own - instead of being placed at a guessed
  // fraction of the whole table.
  assert.ok(source.includes("where: mine ? 'enemy' : 'own'"), 'a shot names the board it happened on')
  assert.ok(source.includes("seaBanner('own')") && source.includes("seaBanner('enemy')"), 'each board draws its own banner')
  assert.ok(source.includes("seaBoom('own')") && source.includes("seaBoom('enemy')"), 'each board draws its own flash')
  assert.ok(source.includes("left: '50%', top: '42%', transform: 'translate(-50%, -50%)'"), 'the banner is centred in its frame')
  // And the frame is the board, not the column that also holds the tray and the fleet review.
  for (const frame of ["'own-frame'", "'enemy-frame'"]) {
    assert.ok(source.includes(frame), 'the board and its lettering share one frame: ' + frame)
  }
  assert.ok(source.includes("position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center'"),
    'that frame is the size of the board')
  assert.ok(!source.includes("left: blast.where === 'enemy' ? '75%'"), 'the guessed fraction is gone')
  assert.ok(source.includes("'data-sea-boom': where"), 'the flash names its board for a test')
  console.log('sea battle: every graphic is centred on its own waters: passed')
}

{
  // Owner's ask 2026-11-09: a jackpot takes the machine over - 15-20 seconds of coins, an alarm,
  // a screen flash - and the size of the celebration follows the size of the win.
  assert.equal(evaluate('SM_tierFor(10).chips'), 10, 'a 10 chip win is a tier')
  assert.equal(evaluate('SM_tierFor(60).chips'), 50, '60 chips is the 50 tier')
  assert.equal(evaluate('SM_tierFor(999).chips'), 500, '999 chips is the 500 tier')
  assert.equal(evaluate('SM_tierFor(1000).chips'), 1000, 'a 1000 chip win is its own tier')
  assert.equal(evaluate('SM_tierFor(50000).chips'), 10000, 'anything over ten thousand is the top tier')
  assert.equal(evaluate('SM_tierFor(10000).name'), 'JACKPOT!', 'the top tier is the jackpot')
  assert.ok(evaluate('SM_tierFor(10000).seconds') >= 15 && evaluate('SM_tierFor(10000).seconds') <= 20,
    'the jackpot runs 15-20 seconds')
  assert.ok(evaluate('SM_tierFor(10000).coins') > evaluate('SM_tierFor(100).coins'), 'more coins for more win')
  assert.equal(evaluate('SM_tierFor(100).alarm'), 0, 'small wins have no alarm')
  assert.equal(evaluate('SM_tierFor(10000).alarm'), 8, 'the jackpot alarm runs')
  assert.ok(source.includes("gamesSound('ching'"), 'coins ching rather than blip')
  assert.ok(source.includes("'data-sm-flash'"), 'the whole screen flashes on a huge win')
  assert.ok(source.includes("pointerEvents: 'none'"), 'and the flash never blocks typing')
  console.log('slots: the win ladder runs from 10 chips to a 20 second jackpot: passed')
}

{
  // Owner's correction 2026-11-09: one Experiments shelf for the installed games and the workshop,
  // and the word "experimental" said once, not in every section. Owner's ask 2026-11-10 (#7): the
  // shelf is now titled "Experimental" and every game in it is locked - visible, with no way in.
  assert.ok(source.includes("heading('Experimental')"), 'one heading covers the whole shelf')
  assert.ok(!source.includes("heading('Experiments')"), 'the old heading is not left beside it')
  assert.ok(!source.includes("heading('Experimental Games')"), 'the second heading is gone')
  assert.ok(!source.includes('labsShelf(labsBlocks),'), 'the workshop is folded in, not a second section')
  assert.ok(source.includes("'data-experiments': '1'"), 'the shelf is one block')
  assert.ok(source.includes('withHeading: false'), 'the workshop blocks sit under that heading')
  const note = source.indexOf('EXPERIMENTS_NOTE =')
  assert.ok(note > -1, 'one sentence sells them honestly')
  console.log('library: one Experiments shelf, said once: passed')
}

{
  // Owner's ask 2026-11-10 (#7): the Experimental shelf is a shop window. Its heading, its one
  // short help line and the lock every card wears are written once (27-labs.js), so no lane can
  // invent a second way of saying no.
  assert.ok(source.includes("LABS_LOCK_HELP = 'Early experiments. You can see them; they open when they are ready.'"),
    'the one short help line is the sentence asked for')
  assert.ok(source.includes("'data-experimental-help': '1'"), 'and it is drawn under the heading')
  assert.ok(source.includes("LABS_LOCK_BADGE = '🔒 Coming soon'"), 'the lock badge is written once')
  assert.ok(source.includes("LABS_LOCK_TITLE = 'Experimental — not open yet. Coming soon.'"), 'so is the tooltip')

  // A locked card: dimmed, announced as disabled, badged, tooltipped - and no handler anywhere in
  // it, so neither a click nor Enter/Space on a focused control can open a game.
  sandbox.opened = []
  const lockedCard = (label, expression, parts) => {
    const card = evaluate(expression)
    const found = nodes(card)
    assert.ok(found.length >= parts, `${label} renders`)
    assert.ok(words(card).includes('🔒 Coming soon'), `${label} wears the lock badge`)
    assert.equal(card.props.title, 'Experimental — not open yet. Coming soon.', `${label} carries the tooltip`)
    assert.equal(card.props['aria-disabled'], 'true', `${label} is announced as disabled`)
    assert.equal(card.props.style.cursor, 'not-allowed', `${label} refuses the pointer`)
    assert.ok(card.props.style.opacity >= 0.5 && card.props.style.opacity <= 0.6, `${label} is dimmed, not hidden`)
    const handlers = found.filter(node => node.props
      && (typeof node.props.onClick === 'function' || typeof node.props.onKeyDown === 'function'))
    assert.equal(handlers.length, 0, `${label} carries no open handler at all`)
    assert.equal(sandbox.opened.length, 0, `${label} opens nothing`)
  }
  lockedCard('an installed experimental game', "YourGameCard({ item: { id: 'demo', title: 'Demo game', plugin: 'demo-plugin' }, onOpen: () => opened.push('demo') })", 3)
  lockedCard('a playable experiment', "labsPlayCard({ id: 'pet-battles', title: 'Pet Battles', summary: 'A battle of pets.' })", 4)

  // A locked card whose art is drawn by a file this lane does not own (Pet Battles, Mafia Town): the
  // wrapper takes the card's door away - the handler inside never runs, by click or by key.
  const wrapped = evaluate("labsLocked(jsx('button', { onClick: () => opened.push('entered') }, 'Open Pet Battles'), 'pet-battles')")
  assert.equal(wrapped.props['aria-disabled'], 'true', 'the wrapped card is announced as disabled')
  assert.equal(wrapped.props.title, 'Experimental — not open yet. Coming soon.', 'and explains itself')
  assert.ok(nodes(wrapped).find(node => node.type === 'button'), 'the card still shows its own control, so it stays visible')
  const swallowed = { stopped: 0, prevented: 0, stopPropagation() { this.stopped++ }, preventDefault() { this.prevented++ } }
  wrapped.props.onClickCapture(swallowed)
  wrapped.props.onKeyDownCapture(swallowed)
  assert.equal(swallowed.stopped, 2, 'a click or a key is stopped before the card can see it')
  assert.equal(swallowed.prevented, 2, 'and its default action is refused')
  assert.equal(sandbox.opened.length, 0, 'nothing inside the wrapped card can be entered')
  // As the page draws it: no handler is passed into those cards at all, so their own button has
  // nothing to run even if a press reached it.
  const petButton = nodes(evaluate('PetBattlesLabsCard({})')).find(node => node.type === 'button')
  assert.ok(petButton, 'Pet Battles still shows its control')
  assert.equal(petButton.props.onClick, undefined, 'and the page hands it no way to open')
  const townButton = nodes(evaluate('MafiaTownCard({})')).find(node => node.type === 'button')
  assert.ok(townButton, 'Mafia Town still shows its control')
  assert.equal(townButton.props.onClick, undefined, 'and the page hands it no way to open')
  console.log('library: the Experimental shelf is visible and locked: passed')
}

{
  // Owner's report 2026-11-09: Sea Battle sounds fired periodically with no game open. A mounted
  // but hidden table must stay silent, and the window being hidden silences it too.
  assert.ok(source.includes('const [onScreen, setOnScreen] = useState(true)'), 'the table knows whether it is on screen')
  assert.ok(source.includes('new IntersectionObserver'), 'it watches its own visibility')
  assert.ok(source.includes('if (!onScreen) return undefined'), 'a hidden table plays nothing')
  assert.ok(source.includes("document.visibilityState === 'hidden'"), 'a hidden window plays nothing')
  console.log('sea battle: a hidden table is silent: passed')
}
{
  // Owner's report: the coins sounded like a bell, not metal. The strike is noise, the ring is
  // short and high, and no partial is allowed a long decay.
  assert.ok(source.includes('bandpass'), 'the coin strike is filtered noise')
  assert.ok(source.includes('length: 0.04 + Math.random() * 0.05'), 'the cascade rings for tens of milliseconds')
  assert.ok(!source.includes('[[1, 1], [2.76, 0.5], [5.4, 0.26]]'), 'the bell ratios are gone')
  console.log('sound: coins are metal, not a bell: passed')
}

{
  // Owner's ask 2026-11-09: real ship pictures during setup, not a list of squares.
  assert.ok(source.includes('function SeaShipArt'), 'a ship is drawn as a silhouette')
  assert.ok(source.includes("'data-sea-ship-art'"), 'the chip carries the picture')
  assert.ok(source.includes("'data-sea-shipyard'"), 'the ship in the hand is drawn big')
  assert.ok(source.includes('rotate(90deg)'), 'and it turns with the orientation')
  console.log('sea battle: the setup shows ships, not squares: passed')
}

{
  // Owner's correction 2026-11-09: the result belongs at the TOP, above the boards and under the
  // game's own header - not inside the water and not straddling two boards.
  const resultAt = source.indexOf("'data-sea-result'")
  const boardsAt = source.indexOf("className: 'games-seabattle-boards'")
  assert.ok(resultAt > -1 && resultAt < boardsAt, 'the result band is above the boards')
  assert.ok(source.includes("role: 'status'"), 'and it is announced, not just drawn')
  console.log('sea battle: the result is a band above the boards: passed')
}

{
  // Owner's ask 2026-11-09: at the end, a picture of both fleets - your kills in their waters, your
  // losses in yours, the sunk ones red and the survivors grey.
  assert.ok(source.includes('function SeaFleetReview'), 'the review draws a fleet')
  assert.ok(source.includes("tone: ship.sunk ? 'sunk' : 'afloat'"), 'sunk hulls are red, survivors grey')
  assert.ok(source.includes("data-sea-fleet': where") || source.includes("'data-sea-fleet': where"), 'each side has its own review')
  assert.ok(source.includes("ships: picture.enemy_fleet, where: 'enemy'"), 'your kills are drawn in enemy waters')
  assert.ok(source.includes("ships: picture.own_ships, where: 'own'"), 'your losses are drawn in your waters')
  console.log('sea battle: the review shows both fleets, sunk in red: passed')
}
{
  // Owner's ask: coins plus the machine's own ding ding ding. The tray body is what makes a clink
  // read as money rather than a tick.
  assert.ok(source.includes("case 'payout'"), 'the machine has its own payout chime')
  assert.ok(source.includes('soundTone(ctx, { freq: 1568'), 'the ding is a bright bell')
  assert.ok(source.includes("[[0.28, 0.4], [0.52, 0.25]]"), 'the coin has a tray ringing under it')
  console.log('sound: coins ring in a tray and the machine dings: passed')
}

{
  // Owner's ask 2026-11-09: real recorded slot sounds, and a variety of them.
  const clips = ['coin', 'coinwin', 'winalert', 'ding', 'payout', 'win', 'siren', 'wheel']
  for (const name of clips) {
    assert.ok(source.includes(`${name}: 'data:audio/ogg;base64,`), `the ${name} clip is embedded`)
  }
  assert.ok(source.includes('function smSfxPlay'), 'there is a sample player')
  assert.ok(source.includes('function smSfxOr'), 'and a synth fallback around it')
  assert.ok(source.includes("smSfxOr('coin'"), 'coins use the recording')
  assert.ok(source.includes("smSfxOr('ding'") || source.includes("clips = ['ding'"), 'the payout uses the recording')
  assert.ok(source.includes("smSfxOr('siren'"), 'the jackpot alarm is the recording')
  assert.ok(source.includes("smSfxOr('wheel'"), 'the reels are the recording')
  console.log('sound: the cabinet plays recorded clips with synth fallback: passed')
}

{
  // Owner's asks 2026-11-09: the table must be muteable and lowerable, and the recordings were
  // abrasive at conversation volume.
  assert.ok(source.includes('function gamesVolume()'), 'there is a master volume')
  assert.ok(source.includes('function gamesVolumeSet('), 'and it can be set')
  assert.equal(evaluate('SOUND_VOLUME_DEFAULT'), 35, 'it starts low rather than loud')
  assert.ok(source.includes("'data-sound-volume': '1'"), 'the settings row offers a slider')
  assert.ok(source.includes("type: 'range', min: 0, max: 100, step: 5"), 'the slider covers silence to full')
  assert.ok(source.includes('function SoundSetting'), 'and it sits with the sound switch')
  assert.ok(source.includes('if (volume <= 0) return'), 'zero volume is silence, not a quiet voice')
  assert.ok(source.includes('gamesSoundOn()') && source.includes('const master = typeof gamesVolume'), 'samples follow the volume too')
  assert.ok(source.includes("softener.type = 'lowpass'"), 'the clips are softened, not raw')
  assert.ok(source.includes('* 0.45'), 'and played under the voice')
  console.log('sound: volume slider, and the recordings are softened: passed')
}

{
  // Owner's asks 2026-11-09: the Sea Battle result belongs at the top, above the boards; the alert
  // drops are gone for now; and choosing a Hermes model offers 1v1 or model-vs-model.
  const resultAt = source.indexOf("'data-sea-result'")
  const boardsAt = source.indexOf("className: 'games-seabattle-boards'")
  assert.ok(resultAt > -1 && resultAt < boardsAt, 'the result band is drawn above the boards')
  assert.ok(!source.includes('jsx(AlertLine'), 'no alert drops are rendered')
  assert.ok(source.includes("'data-model-menu': '1'"), 'the Hermes seats offer a choice')
  assert.ok(source.includes('Watch two Hermes models play each other'), 'including two models against each other')
  assert.ok(source.includes('Play against a Hermes model'), 'and one model against you')
  assert.ok(source.includes('Play my Hermes model(s)'), 'the control is named for what it does')
  console.log('tables: result at the top, no alert drops, model-vs-model offered: passed')
}

{
  // Owner's ask 2026-11-09: the auto-bet sizes itself by what the hook cost, and it is on by
  // default. The switch says so, and turning it off leaves the lever's bet in charge.
  assert.ok(source.includes("'Auto-bet sizes itself'"), 'the switch is on the machine card')
  assert.ok(source.includes('/jackpot/autobet'), 'it talks to the shelf')
  assert.ok(source.includes('autobet !== false'), 'absent means on, so the default is auto-bet')
  console.log('slots: auto-bet is default and self-sizing: passed')
}

{
  // Owner's report 2026-11-09: the auto-bet switch would not turn off - it read straight from the
  // polled payload, so it snapped back to on every render. It flips locally and posts now.
  assert.ok(source.includes('const flipAutobet = on =>'), 'the switch flips under the finger')
  assert.ok(source.includes('setAutobetShown(Boolean(on))'), 'and keeps its own value')
  assert.ok(source.includes("checkbox('Auto-bet sizes itself', autobetShown, flipAutobet"), 'the checkbox uses that value, not the payload')
  // The rules are findable: hover on the question, tap to open the words.
  assert.ok(source.includes('const AUTOBET_RULES ='), 'the sizing rules are written down once')
  assert.ok(source.includes("'data-autobet-help': '1'"), 'with a control that opens them')
  assert.ok(source.includes("'data-autobet-rules': '1'"), 'and a place to show them')
  const rules = source.slice(source.indexOf('const AUTOBET_RULES ='), source.indexOf('const AUTOBET_RULES =') + 400)
  for (const told of ['1x', '20k', '8x', '25 chips', 'odds are identical']) {
    assert.ok(rules.includes(told), 'the tooltip says ' + told)
  }
  console.log('slots: auto-bet turns off, and its rules are in a tooltip: passed')
}

{
  // Owner's release rule, 2026-11-11: the win chance and the return are taken OFF the screen of both
  // machines. The session draw itself is untouched — the shelf's own tests pin the numbers — so the
  // picker still says what tonight holds, in a WORD and never in a percentage.
  assert.ok(!source.includes("'data-sm-chance'"), 'the picker shows no session win chance')
  assert.ok(!source.includes('% · bonus') && !source.includes('% · cold'), 'no chance percentage is named beside a mood')
  assert.ok(source.includes("'data-sm-mood': item.id"), 'the mood still has its own hook')
  assert.ok(source.includes("session.mood"), 'the mood comes from the shelf, not from the desktop')
  console.log('slots: the picker names the session mood and quotes no percentage: passed')
}

{
  // Owner's report 2026-11-09: playing a Hermes model, nothing said whether it was thinking or whose
  // turn it was. The strip now always names the state, and counts the seconds while the other seat
  // works.
  assert.ok(source.includes("'data-turn-line': thinking ? 'thinking'"), 'the strip names thinking')
  assert.ok(source.includes("myTurnNow ? 'Your turn'"), 'and says your turn in words')
  assert.ok(source.includes('`${machineName} is thinking…'), 'a model thinking is named as Hermes')
  assert.ok(source.includes('Waiting for ${waitingOn}'), 'another person waiting is named too')
  assert.ok(source.includes('function useWaitSeconds(active)'), 'the wait is counted, not guessed')
  assert.ok(source.includes('@keyframes games-spin'), 'and the line is visibly alive')
  console.log('tables: whose turn it is, in words and seconds: passed')
}

{
  // An address that came from outside Hermes never reaches the operating system's
  // handler: only http(s) may be opened, and a refusal is said out loud.
  const tried = []
  sandbox.dangerCtx = { os: { openExternal: url => { tried.push(url); return true } } }
  sandbox.said = []
  sandbox.sayNote = text => { sandbox.said.push(String(text)) }
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'slack://open', 'data:text/html,<b>x</b>']) {
    sandbox.badUrl = bad
    evaluate('openInBrowser(dangerCtx, badUrl, sayNote)')
  }
  assert.deepEqual(tried, [], 'a non-web address reached the operating system handler')
  assert.ok(sandbox.said.length === 4 && /not a web link/.test(sandbox.said[0]), 'the refusal is said once per click')
  sandbox.goodUrl = 'https://games.example/t/abc'
  evaluate('openInBrowser(dangerCtx, goodUrl, sayNote)')
  assert.deepEqual(tried, ['https://games.example/t/abc'], 'a web address still opens')
  console.log('opens: only a web address reaches the browser, and a refusal is said: passed')
}

{
  // A lobby address with another scheme must not become an operating-system call
  // through the league "Watch" button either: that path does its own openExternal.
  const tried = []
  sandbox.leagueCtx = { os: { openExternal: url => { tried.push(url); return true } } }
  sandbox.leagueRoom = { id: 'r1' }
  sandbox.badBase = 'file:///tmp'
  evaluate('openTable(leagueRoom, leagueCtx, badBase)')
  assert.deepEqual(tried, [], 'the watch button handed a file: address to the operating system')
  sandbox.goodBase = 'https://games.example'
  evaluate('openTable(leagueRoom, leagueCtx, goodBase)')
  assert.deepEqual(tried, ['https://games.example/t/r1'], 'a web lobby address still opens its table')
  console.log('leagues: watch opens only a web table address: passed')
}

// The lobby as the owner asked for it (2026-11-11): everyone online is listed, appear
// offline is one obvious switch at the top, the request switches name every game the
// server can seat, find match is chips (never a silent default game), a match offer
// arrives as a Join / Not now dialog with one dim line of its own, and every lobby
// post carries its date and time and nothing older than a day is ever drawn.
async function lobbyAsksContract() {
  sandbox.setInterval = () => 1
  sandbox.clearInterval = () => {}
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }
  const you = { id: 'me', name: 'Ada' }
  const draw = value => {
    sandbox.hallProps = value
    cursor = 0
    const tree = evaluate('LobbyHall(hallProps)')
    const pending = effects
    effects = []
    pending.forEach(effect => effect())
    return tree
  }
  const settle = async value => { draw(value); await tick(); return draw(value) }
  const roundTrip = async value => { await tick(); return draw(value) }
  const snapshot = (extra = {}) => ({
    state: 'live', you, prefs: { open: false, games: {} },
    roster: [{ id: 'me', name: 'Ada', status: 'online', games: [] }],
    requests: [], seated: null, ...extra
  })
  const makeCtx = (snap, extra = {}) => {
    const asked = []
    const state = { snap }
    return {
      ctx: {
        rest: async (path, options) => {
          asked.push([path, (options && options.body) || null])
          if (path === '/online/hall') return state.snap
          if (path === '/online/table/open') return { ok: true, text: 'Table opened.' }
          return { ok: true, text: 'Saved.' }
        }
      },
      asked, state,
      settle: async value => { const tree = await settle(value); return tree }
    }
  }
  const props = extra => ({ ctx: null, current: 'connect4', view: {}, onPlayHere: () => {}, ...extra })
  const switchFor = (tree, key) => nodes(tree).find(node => node.props && node.props['data-hall-toggle'] === key)
  const posts = (run, path) => run.asked.filter(item => item[0] === path).map(item => item[1])
  const chips = tree => nodes(tree).filter(node => node.type === 'button' && node.props['data-lobby-chip'] !== undefined)
  const chipFor = (tree, id) => chips(tree).find(node => node.props['data-lobby-chip'] === id)

  // 1. Every game the server can seat has its own switch, and the switches are the ones
  // the server knows: one per game, in the lobby's own order, each naming its game.
  reset()
  let run = makeCtx(snapshot({ prefs: { open: false, games: { connect4: true, go: true } } }))
  tree = await settle(props({ ctx: run.ctx }))
  const perGame = nodes(tree).filter(node => node.props && node.props['data-hall-game'] !== undefined)
  assert.deepEqual(perGame.map(node => node.props['data-hall-game']),
    ['connect4', 'reversi', 'checkers', 'gomoku', 'chessboard', 'go', 'hex', 'breakthrough', 'seabattle'],
    'every two-player game the server can seat has a switch')
  for (const [, label] of evaluate('LOBBY_GAMES')) {
    assert.ok(words(tree).includes(label), `the switches are labelled: ${label} missing`)
  }
  const seaSwitch = perGame.find(node => node.props['data-hall-game'] === 'seabattle')
  assert.ok(String(seaSwitch.props.title).includes('Sea Battle'), 'a switch says which game it is for')
  nodes(seaSwitch).find(node => node.type === 'input').props.onChange({ target: { checked: true } })
  await tick()
  assert.deepEqual(JSON.parse(JSON.stringify(posts(run, '/online/hall/prefs').pop())),
    { games: { seabattle: true } }, 'one switch turns on exactly its own game')

  // 2. Appear offline is the first switch at the top, it posts the flag, and the panel
  // says out loud what it means.
  reset()
  run = makeCtx(snapshot())
  tree = await settle(props({ ctx: run.ctx }))
  const order = nodes(tree).filter(node => node.props && node.props['data-hall-toggle'] !== undefined)
    .map(node => node.props['data-hall-toggle'])
  assert.equal(order[0], 'invisible', 'appear offline is the first control in the lobby')
  assert.ok(order.includes('open'), 'the master switch is there too')
  const offlineSwitch = switchFor(tree, 'invisible')
  assert.ok(String(offlineSwitch.props.title).includes('nobody sees you'), 'the offline switch says what it does')
  assert.equal(nodes(offlineSwitch).find(node => node.type === 'input').props.checked, false,
    'nobody appears offline unless they said so')
  assert.ok(words(tree).includes('everyone else in the lobby can see you'), 'the panel says you are listed')
  nodes(offlineSwitch).find(node => node.type === 'input').props.onChange({ target: { checked: true } })
  await tick()
  assert.deepEqual(JSON.parse(JSON.stringify(posts(run, '/online/hall/prefs').pop())),
    { invisible: true }, 'the offline switch posts the flag and nothing else')
  run = makeCtx(snapshot({ you: { ...you, invisible: true } }))
  tree = await settle(props({ ctx: run.ctx }))
  assert.equal(nodes(switchFor(tree, 'invisible')).find(node => node.type === 'input').props.checked, true,
    'a person who is appearing offline sees their switch on')
  assert.ok(words(tree).includes('appearing offline'), 'and the panel says so')

  // 3. Find match: chips, one per game plus All games, and nothing picked to start with.
  // The chips are their own component (drawn inside the Hall), so it is called directly
  // here, the same way the other nested pieces in this harness are.
  reset()
  run = makeCtx(snapshot())
  tree = await settle(props({ ctx: run.ctx }))
  const findSpot = nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'LobbyFindMatch')
  assert.ok(findSpot, 'find match is drawn in the lobby panel')
  assert.deepEqual(JSON.parse(JSON.stringify(findSpot.props.looking)), [],
    'with whatever the server says is being looked for, and nothing guessed')
  const findAsked = []
  const findPost = async (key, path, body) => { findAsked.push([path, body]); return { ok: true } }
  const drawFind = looking => {
    sandbox.findProps = { looking, post: findPost, pending: '', busyNote: 'busy' }
    return evaluate('LobbyFindMatch(findProps)')
  }
  const findPosts = () => findAsked.map(item => item[1])
  tree = drawFind([])
  assert.equal(chips(tree).length, 10, 'a chip per game, plus All games')
  for (const [id, label] of evaluate('LOBBY_GAMES')) {
    assert.ok(words(chipFor(tree, id)).includes(label), `the chip for ${label} wears its label`)
  }
  assert.ok(words(chipFor(tree, 'all')).includes('All games'), 'and so does the All games chip')
  assert.ok(chips(tree).every(node => node.props['aria-pressed'] === 'false'),
    'no game is picked silently: find match starts where the person set it')
  assert.ok(words(tree).includes('Nothing picked yet'), 'and the panel says nothing is being looked for')
  assert.equal(findButton(tree, 'Find a match'), undefined, 'there is no one-press button that guesses a game')
  chipFor(tree, 'connect4').props.onClick()
  await tick()
  assert.deepEqual(JSON.parse(JSON.stringify(findPosts().pop())),
    { games: ['connect4'] }, 'one chip looks for exactly that game')
  tree = drawFind(['connect4'])
  chipFor(tree, 'go').props.onClick()
  await tick()
  assert.deepEqual(JSON.parse(JSON.stringify(findPosts().pop())),
    { games: ['connect4', 'go'] }, 'a second chip looks for both')
  tree = drawFind(['connect4', 'go'])
  chipFor(tree, 'all').props.onClick()
  await tick()
  assert.deepEqual(JSON.parse(JSON.stringify(findPosts().pop())),
    { all: true }, 'All games looks for every game the server can seat')
  // What the server says it is looking for is what the chips show, and one tap stops it.
  tree = drawFind(['connect4', 'go'])
  assert.equal(chipFor(tree, 'connect4').props['aria-pressed'], 'true', 'a game being looked for reads as pressed')
  assert.equal(chipFor(tree, 'seabattle').props['aria-pressed'], 'false', 'and the others do not')
  assert.ok(words(tree).includes('Looking for Connect 4, Go right now'), 'the panel names what is being looked for')
  const stop = nodes(tree).find(node => node.props && node.props['data-lobby-find-stop'] !== undefined)
  assert.ok(stop, 'one tap stops it')
  stop.props.onClick()
  await tick()
  assert.deepEqual(JSON.parse(JSON.stringify(findPosts().pop())),
    { on: false }, 'Stop looking stops find match')
  chipFor(tree, 'connect4').props.onClick()
  await tick()
  assert.deepEqual(JSON.parse(JSON.stringify(findPosts().pop())),
    { games: ['go'] }, 'pressing one chip off leaves what is still being looked for')
  tree = drawFind(['go'])
  chipFor(tree, 'go').props.onClick()
  await tick()
  assert.deepEqual(JSON.parse(JSON.stringify(findPosts().pop())),
    { on: false }, 'pressing the last chip off stops it')
  reset()

  // 4. A match offer arrives as a dialog naming the person and the game, with Join and
  // Not now, and as one dim line in the panel - never as a request card to cancel, and
  // never through the chat.
  reset()
  const offer = { id: 'o1', state: 'pending', offer: true, game: 'connect4', created: 0, expires: 90,
    from: { id: 'bea', name: 'Bea' }, to: { id: 'me', name: 'Ada' } }
  run = makeCtx(snapshot({ requests: [offer] }))
  tree = await settle(props({ ctx: run.ctx }))
  const dialogSpot = nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'LobbyOfferDialog')
  assert.ok(dialogSpot, 'an offer opens a dialog')
  assert.equal(dialogSpot.props.card.id, 'o1', 'for the offer the server sent')
  assert.equal(dialogSpot.props.otherName, 'Bea', 'naming the other person')
  const line = nodes(tree).find(node => node.props && node.props['data-lobby-offer-line'] === '1')
  assert.ok(line, 'and one line of its own on the panel')
  assert.ok(words(line).includes('Bea') && words(line).includes('Connect 4'), 'the line names the person and the game')
  assert.ok(!words(tree).includes('Asked Bea'), 'an offer is not drawn as a request you sent')
  assert.equal(findButton(tree, 'Cancel'), undefined, 'and it has no Cancel: it is not yours to take back')
  assert.deepEqual(run.asked.filter(item => /chat/i.test(item[0])), [],
    'the offer never goes through the lobby chat')
  const offerAsked = []
  sandbox.offerProps = { card: offer, other: { id: 'bea', name: 'Bea' }, otherName: 'Bea',
    busy: false, busyNote: 'busy',
    onJoin: () => offerAsked.push({ id: offer.id, accept: true }),
    onNotNow: () => offerAsked.push({ id: offer.id, accept: false }) }
  const offerTree = evaluate('LobbyOfferDialog(offerProps)')
  assert.equal(offerTree.props['aria-label'], 'Bea wants to play Connect 4', 'the dialog names the person and the game')
  assert.equal(offerTree.props.role, 'dialog', 'and it is a dialog')
  assert.ok(words(offerTree).includes('Bea wants to play Connect 4'), 'saying it in the dialog itself')
  assert.ok(findButton(offerTree, 'Join') && findButton(offerTree, 'Not now'), 'with Join and Not now')
  findButton(offerTree, 'Join').props.onClick()
  findButton(offerTree, 'Not now').props.onClick()
  assert.deepEqual(offerAsked, [{ id: 'o1', accept: true }, { id: 'o1', accept: false }],
    'Join and Not now answer the offer')
  reset()
  run = makeCtx(snapshot({ requests: [offer] }))
  tree = await settle(props({ ctx: run.ctx }))
  const dialogNode = nodes(tree).find(node => node.props && node.props.role === 'dialog')
  assert.equal(dialogNode, undefined, 'the dialog itself is not inlined twice into the panel')
  const joinAgain = nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'LobbyOfferDialog')
  joinAgain.props.onJoin()
  await tick()
  assert.deepEqual(JSON.parse(JSON.stringify(posts(run, '/online/hall/respond').pop())),
    { id: 'o1', accept: true }, 'Join answers the offer')
  tree = draw(props({ ctx: run.ctx }))
  const again = nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'LobbyOfferDialog')
  again.props.onNotNow()
  await tick()
  assert.deepEqual(JSON.parse(JSON.stringify(posts(run, '/online/hall/respond').pop())),
    { id: 'o1', accept: false }, 'Not now says not this time')
  // The same offer, made to the other side: the dialog reads the same, and either may join.
  run = makeCtx(snapshot({ you: { ...you, id: 'bea' }, requests: [offer] }))
  tree = await settle(props({ ctx: run.ctx }))
  const otherSide = nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'LobbyOfferDialog')
  assert.equal(otherSide.props.otherName, 'Ada', 'the person who was offered reads the other name')
  // A plain request is still a card, not a dialog.
  reset()
  run = makeCtx(snapshot({ requests: [{ ...offer, offer: false }] }))
  tree = await settle(props({ ctx: run.ctx }))
  assert.equal(nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'LobbyOfferDialog'), undefined,
    'a request somebody sent is still a card, not a dialog')
  assert.ok(findButton(tree, 'Accept') && findButton(tree, 'Decline'), 'and it is answered with Accept and Decline')

  // 5. Every lobby post carries its date and time, and nothing older than a day is drawn.
  reset()
  sandbox.setInterval = () => 1
  const seconds = Math.floor(Date.now() / 1000)
  const stamp = at => {
    const when = new Date(at * 1000)
    const pad = number => String(number).padStart(2, '0')
    return `${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`
  }
  const paints = value => {
    sandbox.lobbyProps = value
    cursor = 0
    const tree2 = evaluate('LobbyChatColumn(lobbyProps)')
    const pending = effects
    effects = []
    pending.forEach(effect => effect())
    return tree2
  }
  const withPosts = paints({
    view: { player: { id: 'me', name: 'Ada', named: true },
      lobby: { looking: [], lines: [
        { id: 'p1', name: 'Bea', text: 'anyone for connect4?', at: seconds - 60 },
        { id: 'p2', name: 'Cole', text: 'yesterday\u2019s news', at: seconds - 25 * 3600 },
        { id: 'p3', name: 'Dot', text: 'no stamp at all' }
      ] },
      online: { on: true, url: '' } },
    ctx: { os: { openExternal: () => false } }, current: 'connect4', onPlayHere: () => {},
    chat: '', setChat: () => {}, name: '', setName: () => {}, send: async () => ({ ok: true })
  })
  const printed = words(withPosts)
  assert.ok(printed.includes('anyone for connect4?'), 'a fresh post is drawn')
  assert.ok(printed.includes(stamp(seconds - 60)), 'with its own date and time: ' + printed.slice(-160))
  assert.ok(!printed.includes('yesterday'), 'a post older than a day is never drawn')
  assert.ok(!printed.includes('Cole'), 'nor is the person who wrote it')
  assert.ok(!printed.includes('no stamp at all'), 'nor is a post this screen cannot date')
  reset()
  console.log('lobby asks: everyone listed, appear offline, per-game switches, find match chips, offers as dialogs, stamped posts: passed')
}

// The three owner asks of 2026-11-11, in one contract: Backgammon's Play tile draws its own board
// (not the dark stand-in scene an unknown id gets), the main screen carries one row of links out to
// the project, and the version chip copies its own line on a click or a key and says so.
async function gcextrasContract() {
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }

  // ---- 1. Backgammon has a cover of its own, in the same 130 px stage as every other tile.
  reset()
  const start = JSON.parse(JSON.stringify(evaluate('startingPicture("backgammon")')))
  assert.ok(start && start.view === 'backgammon', 'backgammon has a starting picture at all')
  assert.equal(start.points.filter(count => count > 0).length, 4, 'the standard opening: checkers on four near points')
  assert.equal(start.points.filter(count => count < 0).length, 4, 'and four for the other side')
  const cover = evaluate('coverArt("backgammon", 130)')
  assert.equal(cover.type, 'svg', 'the tile draws an svg, not a stand-in scene')
  assert.equal(cover.key, 'backgammon-cover', 'and it is the backgammon cover')
  assert.equal(cover.props.style.height, 130, 'drawn into the same stage as the other Play tiles')
  const drawn = nodes(cover)
  assert.equal(drawn.filter(node => node.type === 'polygon').length, 24, 'twenty-four points')
  assert.equal(drawn.filter(node => node.type === 'circle' && node.props.fill === '#f5e8d0').length, 15, 'fifteen white checkers')
  assert.equal(drawn.filter(node => node.type === 'circle' && node.props.fill === '#30251f').length, 15, 'fifteen black checkers')
  assert.ok(!drawn.some(node => node.props && node.props.fill === '#1a080c'), 'never the generic scene worldScene draws')
  // The neighbours are untouched: a grid game still goes through BoardSvg.
  const grid = evaluate('coverArt("connect4", 130)')
  assert.equal(typeof grid.type, 'function', 'a grid game still draws its own board component')
  reset()

  // ---- 2. One row of links out to the project, opened through the one browser door.
  reset()
  const repo = 'https://github.com/KeyArgo/hermes-game-center'
  const wanted = [
    ['Report a problem', repo + '/issues/new'],
    ['Contribute', repo],
    ['Add your own game', repo + '/blob/main/docs/SUBMIT-A-GAME.md']
  ]
  const launched = []
  sandbox.linkProps = {
    ctx: { os: { openExternal: async url => { launched.push(url); return true } } },
    onNote: () => {}
  }
  const row = evaluate('GameCenterLinks(linkProps)')
  assert.equal(row.props['data-games-links'], 'repo', 'the links are one marked row')
  for (const [label, href] of wanted) {
    const link = findButton(row, label)
    assert.ok(link, `the row carries ${label}`)
    link.props.onClick()
    await tick()
    assert.equal(launched.at(-1), href, `${label} opens ${href}`)
  }
  assert.deepEqual(launched, wanted.map(item => item[1]), 'each link asked for exactly its own address')
  assert.ok(!/javascript|file:/i.test(JSON.stringify(launched)), 'and nothing but a web address is ever handed over')
  // ---- 3. The version chip copies its own line, on a click or a key, and says so for a breath.
  // Drawn before the page on purpose: a component only has the harness's hook slots to itself while
  // it is the one drawing, so the chip goes first and the page — whose poll keeps resolving — goes last.
  reset()
  sandbox.setTimeout = setTimeout
  sandbox.clearTimeout = clearTimeout
  const copied = []
  sandbox.navigator = { clipboard: { writeText: text => { copied.push(text); return Promise.resolve() } } }
  const line = 'v1.0.0-dev.7 · 2026-11-11 · abcdef12'
  // The copy goes through the SDK's own clipboard door (ctx.os.writeClipboard) — never a hidden textarea
  // appended to the app's <body> (review, 2026-11-12).
  const clip = []
  sandbox.gcChip = { ctx: {
    os: { writeClipboard: text => { clip.push(text); copied.push(text); return Promise.resolve(true) } },
    rest: async path => (path === '/v1/version'
      ? { version: '1.0.0-dev.7', commit: 'abcdef1234567890', commit_short: 'abcdef12', commit_date: '2026-11-11T09:00:00-07:00', dirty: false }
      : {})
  } }
  const drawChip = () => { cursor = 0; const tree = evaluate('GamesVersionChip(gcChip)'); const pending = effects; effects = []; pending.forEach(effect => effect()); return tree }
  drawChip()
  await tick()
  let chip = drawChip()
  assert.equal(words(chip), line, 'the chip shows one line')
  assert.equal(chip.props['data-games-version'], 'chip', 'it is the one reusable chip')
  assert.equal(String(chip.props.title).split('\n').pop(), 'Click to copy the version', 'the tooltip says what a click does')
  assert.ok(String(chip.props.title).includes('Game Center 1.0.0-dev.7'), 'and still names the install')
  assert.equal(chip.props.role, 'button', 'the chip is a control, not decoration')
  assert.equal(chip.props.tabIndex, 0, 'that the keyboard can reach')
  chip.props.onClick()
  await tick()
  assert.deepEqual(copied, [line], 'one click copies the chip text itself')
  chip = drawChip()
  assert.equal(words(chip), 'Copied', 'and the chip says so')
  chip.props.onKeyDown({ key: 'Enter', preventDefault() {} })
  await tick()
  assert.equal(copied.length, 2, 'Enter copies too')
  chip.props.onKeyDown({ key: ' ', preventDefault() {} })
  await tick()
  assert.equal(copied.length, 3, 'and so does Space')
  // "Copied" is a breath, not a state: the chip is back to the version after a second and a half.
  await new Promise(resolve => setTimeout(resolve, 1600))
  chip = drawChip()
  assert.equal(words(chip), line, 'the chip goes back to the version it names')
  // Where the SDK door is missing, the browser's own clipboard still does the job...
  sandbox.navigator = { clipboard: { writeText: text => { copied.push(text); return Promise.resolve() } } }
  const doorless = { ctx: { rest: sandbox.gcChip.ctx.rest } }
  sandbox.gcChip = doorless
  chip = drawChip()
  chip.props.onClick()
  await tick()
  assert.equal(copied.length, 4, 'with no SDK door the browser clipboard copies instead')
  // ...and where neither exists the chip says nothing rather than inventing a copy, and touches no
  // element of the app's to try.
  sandbox.navigator = {}
  const touched = []
  const savedCreate = sandbox.document.createElement
  sandbox.document.createElement = () => { touched.push('createElement'); return { style: {}, setAttribute() {}, select() {} } }
  const provable = { ctx: { rest: sandbox.gcChip.ctx.rest } }
  sandbox.gcChip = provable
  reset()  // a fresh chip, so the earlier "Copied" is not what is being read
  drawChip()
  await tick()
  chip = drawChip()
  chip.props.onClick()
  await tick()
  assert.deepEqual(touched, [], 'no element of the app\'s is created for a copy')
  assert.equal(words(drawChip()), line, 'and the chip never claims a copy it could not make')
  sandbox.document.createElement = savedCreate
  // Let that last "Copied" land in the chip's own slots before the page takes them over.
  await new Promise(resolve => setTimeout(resolve, 1600))
  reset()

  // ---- 4. The main screen draws the row, beside the side links it belongs with.
  reset()
  sandbox.setInterval = () => 1
  sandbox.clearInterval = () => {}
  const game = { id: 'connect4', title: 'Connect Four', kind: 'table', installed: true }
  sandbox.pageProps = { ctx: { rest: async url => {
    if (url === '/view') return { viewer_id: 'me', player: { name: 'Ada', named: true }, allow_ai: true, store: [game], play: [game], your_games: [], lobby: { lines: [], looking: [] } }
    if (url === '/jackpot') return { chips: 12, bonus: 3 }
    if (url.startsWith('/board')) return { text: '', picture: { ...active, view: 'connect4', game: 'connect4' } }
    return { text: '', picture: null }
  } } }
  const drawPage = () => { cursor = 0; const tree = evaluate('GameCenterPage(pageProps)'); const pending = effects; effects = []; pending.forEach(effect => effect()); return tree }
  drawPage()
  await tick()
  drawPage()
  await tick()
  const page = drawPage()
  // The harness draws elements, not components: the row appears as its own element, so read it
  // back and draw it with the props the page handed it — that proves the wiring, not just the name.
  const rowElement = nodes(page).find(node => typeof node.type === 'function' && node.type.name === 'GameCenterLinks')
  assert.ok(rowElement, 'the main screen draws the link row')
  assert.equal(typeof rowElement.props.ctx.rest, 'function', 'handed the page context, so it can open a browser')
  sandbox.pageLinkProps = rowElement.props
  const wired = evaluate('GameCenterLinks(pageLinkProps)')
  assert.equal(wired.props['data-games-links'], 'repo', 'and the row it draws is the project links')
  for (const [label] of wanted) assert.ok(findButton(wired, label), `the row the page draws offers ${label}`)
  for (const label of ['Experimental', 'Settings', 'Community creations']) {
    assert.ok(findButton(page, label), `still beside ${label}`)
  }
  // The page keeps polling: let its last answers land, then hand the hook slots back. This contract
  // is the last one in the chain, so nothing is drawn after it.
  for (let settle = 0; settle < 3; settle += 1) { drawPage(); await tick() }
  reset()
  console.log('gcextras: backgammon cover, project link row and the copyable version chip: passed')
}
