// tests/overchat_defaults.mjs -- both see-through machines are OFF on a fresh install.
//
//   node tests/overchat_defaults.mjs
//
// The two switches are stored in two different places (the cabinet's in localStorage, Jackpot v2's on the
// shelf's plugin storage), and each has its own way of failing: a key that is not there, an empty string, a
// store that refuses reads, a host that passes no store at all. In every one of those the answer has to be
// "off": a see-through machine nobody asked for must never appear over the conversation on its own.
//
// The bundle is loaded once per world, because both switches are read at load time.
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname))
const source = fs.readFileSync(path.join(ROOT, 'desktop', 'plugin.js'), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export \{.*\}$/gm, '').replace('export default {', 'const plugin = {')

const failures = []
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`)
  if (!ok) failures.push(detail ? `${name} (${detail})` : name)
}

// What the browser's own storage answers. `null` means the window has no storage at all.
const stores = {
  'a fresh install: nothing stored yet': { getItem: () => null, setItem: () => {} },
  'an empty string where the switch would be': { getItem: () => '', setItem: () => {} },
  'a store that refuses reads': { getItem: () => { throw new Error('storage is unavailable') }, setItem: () => {} }
}

const ctxs = {
  'a host with no plugin storage': { rest: async () => ({}) },
  'a host whose storage answers nothing': { rest: async () => ({}), storage: { get: () => undefined, set: () => {} } },
  'a host whose storage answers an empty string': { rest: async () => ({}), storage: { get: () => '', set: () => {} } },
  'a host whose storage throws': { rest: async () => ({}), storage: { get: () => { throw new Error('no storage') }, set: () => {} } },
  'a host whose storage is not an object': { rest: async () => ({}), storage: 0 }
}

// One fresh load, with the window's storage and the host's ctx of this world. The hooks a component is
// allowed to use are stubbed with a real store behind them: a hook that is never re-run is enough to answer
// "what is the switch at load?".
function load(localStorage, ctx) {
  const sandbox = { console, Set, setTimeout, clearTimeout }
  sandbox.window = localStorage === null ? {} : { localStorage }
  sandbox.document = { addEventListener: () => {}, removeEventListener: () => {}, getElementById: () => null, activeElement: null }
  sandbox.__ctx = ctx
  let cursor = 0
  const slots = []
  sandbox.useState = initial => {
    const index = cursor++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    return [slots[index], value => { slots[index] = value }]
  }
  sandbox.useRef = initial => ({ current: initial })
  sandbox.useEffect = () => {}
  sandbox.useCallback = fn => fn
  sandbox.useMemo = fn => fn()
  sandbox.jsx = sandbox.jsxs = (type, props, extra) => ({ type, props: props || {}, key: extra })
  sandbox.Component = class { constructor(props) { this.props = props; this.state = {} } }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  return {
    evaluate: expression => { cursor = 0; return vm.runInContext(expression, sandbox) }
  }
}

const fresh = stores['a fresh install: nothing stored yet']
for (const [world, storage] of Object.entries(stores)) {
  const cabinet = load(storage, null).evaluate('SM_OVERCHAT.on')
  check(`the cabinet is off with ${world}`, cabinet === false, String(cabinet))
}

{
  const cabinet = load(null, null).evaluate('SM_OVERCHAT.on')
  check('the cabinet is off where the window has no storage at all', cabinet === false, String(cabinet))
}

for (const [world, ctx] of Object.entries(ctxs)) {
  const run = load(fresh, ctx)
  run.evaluate('jp2LAdopt(__ctx)')
  const v2 = run.evaluate('JP2L_STORE.overchat')
  check(`Jackpot v2 is off with ${world}`, v2 === false, String(v2))
}

// And the one place they are drawn renders nothing at all while both are off.
{
  const tree = load(fresh, null).evaluate('OverChatStrip({ ctx: { rest: async () => ({}) } })')
  check('the composer slot draws nothing while both switches are off', tree === null, String(tree))
}

// The opposite direction, so the checks above cannot pass by accident: a stored '1' does turn the cabinet
// on, which is what makes "it read the store" a real statement rather than a constant.
{
  const on = load({ getItem: key => (key === 'gameshelf.slots.overchat' ? '1' : null), setItem: () => {} }, null)
  check('a stored 1 does turn the cabinet on', on.evaluate('SM_OVERCHAT.on') === true, 'read back on')
}

if (failures.length) {
  console.error(`\n${failures.length} default check(s) failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('\nall over-chat default checks passed')
