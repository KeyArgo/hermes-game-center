// The website's Hall, drawn without a browser: the offer cards are read off the real
// online/web/app.js, so what a seeker and a person who is asked each see is checked in
// the file the site actually serves.
//
// The page is a module for the browser, so its two imports and its one mount call are
// stripped and the few React doors it uses are stubbed. Everything else - the words, the
// buttons, which request is whose - is the site's own code, unmodified.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '../online/web/app.js'), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace(/^createRoot\(.*$/gm, '')
  .replace(/^try \{ document\.documentElement\.dataset\.skin = storedSkin\(\) \} catch \{\}$/m, '')

const sandbox = { console, Set, Map, Date, Math, JSON, Number, String, Boolean, Array, Object, Promise,
  setInterval: () => 1, clearInterval: () => {}, setTimeout, clearTimeout }
sandbox.window = { location: { pathname: '/', search: '', hash: '' } }
sandbox.document = { documentElement: { dataset: {} }, getElementById: () => null, title: '' }
sandbox.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
sandbox.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) })
sandbox.BoardSvg = () => null
sandbox.coverArt = () => ''
vm.createContext(sandbox)

// React's createElement, reduced to the shape the harness reads: type, props, children.
// Children are the third argument onwards, and a list handed as one child stays a list.
sandbox.reactCreateElement = (type, props, ...children) => {
  const folded = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
  return { type, props: { ...(props || {}), ...(folded === undefined ? {} : { children: folded }) }, key: props && props.key }
}
sandbox.reactFragment = 'F fragment'
Math.max, Number.parseInt // keep the linter quiet about unused stubs

// Hooks: one list of slots, re-read on every render, the way React keeps them.
let hooks = []
let cursor = 0
let effects = []
let cleanups = []
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
sandbox.useEffect = (fn, deps) => {
  const index = cursor++
  const before = hooks[index]
  if (!before || !deps || deps.some((dep, i) => dep !== before[i])) {
    hooks[index] = deps
    effects.push(() => { if (cleanups[index]) cleanups[index](); cleanups[index] = fn() })
  }
}

// The module is run once, with the h/Fragment names its own import line used.
sandbox.h = sandbox.reactCreateElement
sandbox.Fragment = sandbox.reactFragment
vm.runInContext(source, sandbox)
const evaluate = expression => vm.runInContext(expression, sandbox)

const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...[].concat(tree.props && tree.props.children || []).flatMap(nodes)]
const words = tree => (!tree ? '' : typeof tree !== 'object' ? String(tree) : Array.isArray(tree) ? tree.map(words).join(' ') : [].concat(tree.props && tree.props.children || []).map(words).join(' ')).replace(/\s+/g, ' ').trim()
// The site's buttons are a component of its own (Button), so a press is read off its
// element: the label is the element's child, the handler its onClick.
const buttons = tree => nodes(tree).filter(node => typeof node.type === 'function' && String(node.type.name) === 'Button')
const buttonWords = node => words({ props: { children: node.props.children } }).trim()
const button = (tree, label) => buttons(tree).find(node => buttonWords(node) === label)
const plainButtons = tree => nodes(tree).filter(node => node.type === 'button')

function reset() { cleanups.forEach(fn => fn && fn()); cleanups = []; hooks = []; effects = [] }
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }

// One render of the Hall: the state slots persist, the pending effects are run, and the
// next render reads what they set - the same loop a browser works in.
function draw(props) {
  sandbox.hallTabProps = props
  cursor = 0
  const tree = evaluate('HallTab(hallTabProps)')
  const pending = effects
  effects = []
  pending.forEach(effect => effect())
  return tree
}
async function settle(props) { draw(props); await tick(); return draw(props) }

const hall = (extra = {}) => Object.assign({
  phase: 'live', error: '', notice: '', more: 0, invisible: false,
  you: { id: 'me', name: 'Ada' },
  prefs: { open: true, games: { connect4: true }, until: {} },
  roster: [{ id: 'me', name: 'Ada', status: 'online', games: ['connect4'] }],
  requests: [],
  setOpen: () => {}, setInvisible: () => {}, toggleGame: () => {},
  ask: async () => ({ ok: true }), respond: async () => ({ ok: true }),
  cancel: async () => ({ ok: true }), close: () => {}
}, extra)
const props = extra => ({ token: 'T', me: { id: 'me', name: 'Ada' }, hall: hall(extra) })
const makeHall = extra => {
  const post = []
  const value = hall({
    respond: async (id, accept) => { post.push(['respond', id, accept]); return { ok: true } },
    cancel: async id => { post.push(['cancel', id]); return { ok: true } },
    ...extra
  })
  return { hall: value, post }
}

async function offerSidesOnTheSite() {
  const now = Math.floor(Date.now() / 1000)
  const toMe = { id: 'o1', state: 'pending', offer: true, game: 'connect4', created: now - 5, expires: now + 55,
    from: { id: 'bea', name: 'Bea' }, to: { id: 'me', name: 'Ada' } }
  const fromMe = { ...toMe, from: { id: 'me', name: 'Ada' }, to: { id: 'bea', name: 'Bea' } }

  // 1. The person asked sees the offer, with Join and Not now.
  reset()
  let run = makeHall({ requests: [toMe] })
  let tree = await settle({ ...props({}), hall: run.hall })
  assert.ok(words(tree).includes('Bea wants to play Connect Four'), 'the offer names the person and the game: ' + words(tree))
  assert.ok(button(tree, 'Join'), 'the person asked gets Join')
  assert.ok(button(tree, 'Not now'), 'and Not now')
  button(tree, 'Join').props.onClick()
  await tick()
  assert.deepEqual(JSON.parse(JSON.stringify(run.post)), [['respond', 'o1', true]], 'Join answers the offer')

  // 2. The seeker waits: no Join, no Not now - who is being asked, and a cancel.
  reset()
  run = makeHall({ requests: [fromMe] })
  tree = await settle({ ...props({}), hall: run.hall })
  assert.equal(button(tree, 'Join'), undefined, 'the seeker is never offered Join on their own ask')
  assert.equal(button(tree, 'Not now'), undefined, 'nor Not now')
  assert.match(words(tree), /Asking Bea — \d+ s/, 'the seeker is told who is being asked: ' + words(tree))
  const cancel = button(tree, 'Cancel')
  assert.ok(cancel, 'with a way to take the ask back')
  cancel.props.onClick()
  await tick()
  assert.deepEqual(JSON.parse(JSON.stringify(run.post)), [['cancel', 'o1']], 'Cancel is the cancel door')

  // 3. Somebody else's offer is neither: nothing of it is drawn for a third person.
  reset()
  run = makeHall({ you: { id: 'zed', name: 'Zed' }, requests: [fromMe] })
  tree = await settle({ ...props({}), hall: run.hall })
  assert.equal(button(tree, 'Join'), undefined, 'an offer between two other people offers no Join')
  assert.equal(button(tree, 'Cancel'), undefined, 'and nothing to cancel')
  assert.equal(/Asking Bea/.test(words(tree)), false, 'and no ask of theirs to wait on')
  reset()
  console.log('site: the person asked answers an offer, the seeker waits with a cancel: passed')
}

offerSidesOnTheSite().catch(error => { console.error(error); process.exitCode = 1 })
