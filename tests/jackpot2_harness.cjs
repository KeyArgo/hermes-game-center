// tests/jackpot2_harness.cjs -- JACKPOT v2, LANE C: the over-chat layer, its switch and the fit.
//
// The second slot machine is two new parts of the bundle beside the old one: 18-jackpot2-machine.js
// (the cabinet, JackpotMachine({ ctx, mode })) and 19-jackpot2-layer.js (the see-through copy over
// the conversation, the switch and sliders that size it, and the full view). This harness pins the
// LAYER half of that contract in the style of tests/jackpot_overlay_harness.cjs: it loads the built
// desktop/plugin.js in a vm sandbox with a small DOM, drives the layer through its own door and the
// status item, and reads the div it appends to document.body -- no Games page, no route, no browser.
//
// What it checks, in the order the brief lists it:
//   1. the layer is created and removed by the switch alone: one div, position:fixed, at
//      z-index 2147483000, click-through, and gone from the body again when the switch goes off;
//   2. the status item's switch is that same door: it writes ctx.storage 'jackpot2.overchat',
//      off -> on brings the copy back visible, and a switch already stored floats it on a fresh load;
//   3. a 360 px column draws the machine at the 0.35 floor or above, and the copy still fits it;
//   4. the full view fits 1400x900 and 900x500 with nothing clipped;
//   5. the layer holds the cabinet in overlay mode for ALL THREE host shapes — createRoot, a portal
//      and no react-dom at all — and the third one still draws the cabinet when there is no body
//      div to paint into either (the owner's release blocker, 2026-11-11);
//   6. the old machine keeps its odds mechanics and prints no win-chance or return percentage;
//   7. one switch, drawn from one component, in the cabinet's own panel and in Settings, writing the
//      same three storage keys the status bar writes;
//   8. the frame it chose is announced once on the console, and the copy is never zero-sized and
//      never fully transparent, on the start screen as well as with a chat column;
//   9. no win-chance or return percentage text survives anywhere in the built bundle;
//  10. the copy's position and colour (owner's ask, 2026-11-11): the two offsets in the same panel as
//      Show over chat, See-through and Size, their default EXACTLY the geometry the copy had before
//      they existed, the clamp that keeps the whole machine inside the conversation and off the
//      composer, the six swatches and the gradient, the colour default equal to the teal border the
//      cabinet already draws, and Reset look putting every one of them back.
//
// Run it from the repo root after a build (the harnesses read desktop/plugin.js, not desktop/src/):
//   python3 tools/build_plugin.py && node tests/jackpot2_harness.cjs

const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const source = fs.readFileSync(path.join(ROOT, 'desktop/plugin.js'), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export \{.*\}$/gm, '').replace('export default {', 'const plugin = {')

// ---- the smallest DOM the layer needs ----------------------------------------
// The layer is a plain div created with document.createElement and appended to document.body (the
// way Aura mounts its backdrop), so the harness has to supply those, a place for its stylesheet
// (document.head) and a box to be measured against (document.querySelector for the composer).
function makeNode(tag) {
  const node = {
    nodeType: 1,
    tagName: String(tag || '').toUpperCase(),
    attributes: {},
    children: [],
    parentNode: null,
    style: {},
    textContent: '',
    rect: null,
    setAttribute(name, value) { node.attributes[name] = String(value) },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null },
    appendChild(child) { child.parentNode = node; node.children.push(child); return child },
    removeChild(child) {
      const at = node.children.indexOf(child)
      if (at >= 0) node.children.splice(at, 1)
      child.parentNode = null
      return child
    },
    remove() { if (node.parentNode && typeof node.parentNode.removeChild === 'function') node.parentNode.removeChild(node) },
    getBoundingClientRect() { return node.rect || { left: 0, top: 0, width: 0, height: 0 } }
  }
  Object.defineProperty(node, 'firstChild', { get: () => node.children[0] || null })
  return node
}

const body = makeNode('body')
const head = makeNode('head')
const localStore = {}
// The bundle logs the frame it chose with console.info (the owner's ask: it must be readable without
// a debugger). The gate counts every line the harness prints that is not "…: passed", so those
// lines are captured here rather than written to stdout — assertion 9 below reads this buffer.
const said = []
const sandbox = {
  console: { log: console.log, warn: console.warn, error: console.error, info: (...args) => said.push(args.join(' ')) },
  Set, setTimeout, clearTimeout, setInterval, clearInterval,
  PANES_AREA: 'panes', PALETTE_AREA: 'palette', ROUTES_AREA: 'routes',
  SIDEBAR_NAV_AREA: 'nav', STATUSBAR_AREAS: { right: 'right' },
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
  requestAnimationFrame: fn => setTimeout(fn, 0),
  cancelAnimationFrame: id => clearTimeout(id)
}
sandbox.window = {
  innerWidth: 1400,
  innerHeight: 900,
  location: { hash: '' },
  addEventListener: () => {},
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  localStorage: {
    getItem: key => (key in localStore ? localStore[key] : null),
    setItem: (key, value) => { localStore[key] = String(value) },
    removeItem: key => { delete localStore[key] }
  }
}
sandbox.document = {
  body,
  head,
  createElement: tag => makeNode(tag),
  createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {}
}
sandbox.host = { navigate: () => {} }
// A host react-dom, so the layer paints its own div through createRoot and the harness can read the
// element it was handed. The shipped case has none; that branch is checked further down (section 5).
sandbox.ReactDOM = {
  createRoot(node) {
    return {
      _node: node,
      render(element) { node.__rendered = element },
      unmount() { node.__rendered = null }
    }
  }
}
// React's class base, for the error boundary the bundle defines at load.
sandbox.Component = class {
  constructor(props) { this.props = props; this.state = {} }
  setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) } }
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

// ---- the harness's own react -------------------------------------------------
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
sandbox.useEffect = (fn, deps) => {
  const index = cursor++
  const before = hooks[index]
  if (!before || deps.some((dep, i) => dep !== before[i])) {
    hooks[index] = deps
    effects.push(() => { if (cleanups[index]) cleanups[index](); cleanups[index] = fn() })
  }
}
// The bundle draws with the jsx/jsxs runtime: a third-argument children bag must be folded in, or the
// tree loses text a check is looking for (the lesson from the old overlay harness).
sandbox.jsx = sandbox.jsxs = (type, props, extra) => {
  const p = props || {}
  if (extra && typeof extra === 'object' && !Array.isArray(extra) && 'children' in extra) {
    return { type, props: { ...p, children: extra.children }, key: extra.key }
  }
  return { type, props: p, key: extra }
}
sandbox.useCallback = fn => fn
sandbox.useMemo = fn => fn()

const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree)
  ? tree.flatMap(nodes)
  : [tree, ...[].concat(tree.props && tree.props.children || []).flatMap(nodes)]
const evaluate = expression => vm.runInContext(expression, sandbox)
function draw(expression) {
  cursor = 0
  const tree = evaluate(expression)
  const pending = effects
  effects = []
  pending.forEach(effect => effect())
  return tree
}
function reset() {
  cleanups.forEach(fn => fn && fn())
  cleanups = []
  hooks = []
  effects = []
}

// Every name the layer half publishes has to be in the built file before anything below can run.
for (const name of ['JackpotMachine', 'Jackpot2StatusItem', 'Jackpot2Full', 'Jackpot2Tile',
  'Jackpot2OverChatControls', 'jp2LApply', 'jp2LLayerNode', 'jp2LRemoveLayer', 'jp2LFrame',
  'jp2LOverlayGeometry', 'jp2LFitGeometry', 'jp2LTellFrame', 'jp2LSetOverchat']) {
  assert.equal(evaluate(`typeof ${name}`), 'function', `${name} is in the built bundle (run python3 tools/build_plugin.py first)`)
}
assert.equal(typeof evaluate('window.__jp2'), 'object', 'the machine publishes window.__jp2 for tests')

// A /jackpot answer, the same shape the shelf sends the old machine. Only the layer is drawn here,
// so the cabinet never reads it -- it is here so a mount that did start polling would still work.
const data = {
  chips: 12340, bet: 25, bets: [25, 50, 100], machine: 'jp2classic',
  machines: [{
    id: 'jp2classic', title: 'Classic', rows: 3, reels: 3,
    strips: [['🍒', '🔔', '💎', '7', 'BAR', 'NOUS'], ['🔔', '💎', '7', 'BAR', 'NOUS', '🍒'], ['💎', '7', 'BAR', 'NOUS', '🍒', '🔔']],
    lines: [{ name: 'Middle', rows: [1, 1, 1] }], bet: 25
  }],
  feed: [], paytable: [{ symbol: '💎', payout: 200 }], odds: { win_chance: 0.3, return: 0.95 },
  bonus: 41, reward: 7, autobet: true, autoplay: false
}
const store = {}
const makeCtx = () => ({
  rest: async () => data,
  storage: {
    get: (key, fallback) => (key in store ? store[key] : fallback),
    set: (key, value) => { store[key] = value }
  }
})
const ctx = makeCtx()
sandbox.jp2ctx = ctx
sandbox.jp2store = store

// ---- 1. the layer is created and removed by the switch alone -----------------
// jp2LApply is the door the status item's effect calls; the switch is what decides, and nothing here
// opens a Games page or draws a route.
evaluate('jp2LRemoveLayer()')
assert.equal(evaluate('jp2LLayerNode()'), null, 'nothing floats before the switch is turned on')

const opened = evaluate('jp2LApply(jp2ctx, true)')
assert.equal(opened.on, true, 'turning the switch on answers on')
assert.ok(opened.node, 'turning the switch on creates the layer')
const layer = opened.node
assert.equal(evaluate('jp2LLayerNode()'), layer, 'jp2LLayerNode exposes the layer')
assert.ok(sandbox.document.body.children.indexOf(layer) >= 0, 'the layer is a div appended to document.body')
assert.equal(layer.style.position, 'fixed', 'the layer is position: fixed')
assert.equal(String(layer.style.zIndex), '2147483000', 'the layer floats above the app chrome at 2147483000')
assert.equal(layer.style.pointerEvents, 'none', 'the layer is click-through to the conversation')
assert.ok(Number.parseFloat(layer.style.width) > 0 && Number.parseFloat(layer.style.height) > 0,
  'the layer is sized to the machine it holds')
assert.ok(/px$/.test(layer.style.left) && /px$/.test(layer.style.top), 'and it is placed at the conversation')
evaluate('jp2LApply(jp2ctx, true)')
assert.equal(sandbox.document.body.children.filter(node => node.getAttribute && node.getAttribute('data-jp2-layer')).length, 1,
  'turning it on twice never stacks a second copy')
const closed = evaluate('jp2LApply(jp2ctx, false)')
assert.equal(closed.node, null, 'turning the switch off removes the layer')
assert.equal(evaluate('jp2LLayerNode()'), null, 'and jp2LLayerNode goes quiet')
assert.equal(sandbox.document.body.children.indexOf(layer), -1, 'the div is gone from the body')
console.log('jackpot2: the layer is created and removed by the switch alone: passed')

// ---- 2. the status item's switch is that same door ---------------------------
evaluate('jp2LRemoveLayer()')
evaluate('jp2LSetOverchat(false, jp2ctx)')
reset()
sandbox.jp2statusProps = { ctx }
const statusToggle = tree => nodes(tree).find(node => node.type === 'button' && node.props && node.props['data-jp2'] === 'status')

let statusTree = draw('Jackpot2StatusItem(jp2statusProps)')
// The status bar shows NOTHING any more (owner, 2026-11-11): no button, no sliders - only the
// zero-size anchor the copy is a fixed child of. The switch is the cabinet's panel / Settings.
assert.equal(statusToggle(statusTree), undefined, 'the status bar carries no Slots button')
assert.ok(!nodes(statusTree).some(node => node.type === 'input'), 'and no sliders')
assert.equal(evaluate('jp2LLayerNode()'), null, 'and nothing floats while the switch is off')

evaluate('jp2LSetOverchat(true, jp2ctx)')                  // on
statusTree = draw('Jackpot2StatusItem(jp2statusProps)')
let float = evaluate('jp2LLayerNode()')
assert.ok(float, 'turning it on from the status bar creates the layer')
assert.equal(sandbox.jp2store['jackpot2.overchat'], true, 'the switch is stored under jackpot2.overchat')
assert.equal(float.style.visibility, 'visible', 'and the copy is visible')

evaluate('jp2LSetOverchat(false, jp2ctx)')                 // off
statusTree = draw('Jackpot2StatusItem(jp2statusProps)')
assert.equal(evaluate('jp2LLayerNode()'), null, 'turning it off removes the layer again')
assert.equal(sandbox.jp2store['jackpot2.overchat'], false, 'and off is stored too')

evaluate('jp2LSetOverchat(true, jp2ctx)')                  // on again
statusTree = draw('Jackpot2StatusItem(jp2statusProps)')
float = evaluate('jp2LLayerNode()')
assert.ok(float, 'off -> on brings the layer back')
assert.equal(float.style.visibility, 'visible', 'off -> on keeps it visible')
assert.ok(sandbox.document.body.children.indexOf(float) >= 0, 'and the copy is back on the page')

// A switch already stored floats the copy on a fresh load, with no Games page ever opened: adoption
// happens on a surface that still runs above the early return.
reset()
evaluate('jp2LRemoveLayer()')
const freshCtx = makeCtx()
store['jackpot2.overchat'] = true
sandbox.jp2freshProps = { ctx: freshCtx }
const freshTree = draw('Jackpot2StatusItem(jp2freshProps)')
assert.ok(evaluate('jp2LLayerNode()'), 'a stored switch floats the copy on load, without the Games page')
assert.equal(statusToggle(freshTree), undefined, 'still with nothing visible in the status bar')
evaluate('jp2LSetOverchat(false, jp2freshProps.ctx)')
evaluate('jp2LRemoveLayer()')
reset()
console.log('jackpot2: the switch alone creates, removes and revives the copy: passed')

// ONLY OVER THE CHAT (owner's screenshot, 2026-11-11 08:36: the copy sat on Game Center). Route only.
{
  const saved = sandbox.window.location
  const routeIs = hash => { sandbox.window.location = { hash }; return evaluate('jp2LOnChatRoute()') }
  assert.equal(routeIs(''), true, 'a new chat ("") is the chat')
  assert.equal(routeIs('#/'), true, '"/" is the chat')
  assert.equal(routeIs('#/local-4e8ea6488ee06c9e'), true, 'a local session is the chat')
  assert.equal(routeIs('#/20261109_194547_20a0a5'), true, 'a dated session is the chat')
  assert.equal(routeIs('#/games'), false, 'Game Center is not')
  assert.equal(routeIs('#/omniscience'), false, 'another plugin page is not')
  assert.equal(routeIs('#/settings'), false, 'Settings is not')
  assert.equal(routeIs('#/settings/models'), false, 'nor a sub-page')
  sandbox.window.location = saved
}

// ---- 3. a 360 px column: the 0.35 floor, and it still fits the column --------
const narrow = evaluate('jp2LOverlayGeometry({ left: 0, top: 0, width: 360, height: 900 }, 1)')
assert.ok(narrow.scale >= 0.35, 'a 360 px column draws the machine at the 0.35 floor or above: ' + narrow.scale)
assert.ok(narrow.width <= 360.5 && narrow.height <= 900.5, 'and the copy fits the column it floats over')
const floored = evaluate('jp2LOverlayGeometry({ left: 0, top: 0, width: 80, height: 80 }, 1)')
assert.equal(floored.scale, 0.35, 'a frame with no room for the machine stops at the 0.35 floor, never below')

// The same through jp2LFrame: no chat column exposed -> the right third of the window.
sandbox.window.innerWidth = 1080
sandbox.window.innerHeight = 720
sandbox.document.querySelector = () => null
assert.equal(evaluate('jp2LFrame()').width, 360, 'the fallback frame is the right third of the window')
const applied = evaluate('jp2LApply(jp2ctx, true)')
assert.ok(applied.geo && applied.geo.scale >= 0.35, 'the copy over a 360 px column is at the floor or above: ' + (applied.geo && applied.geo.scale))
assert.ok(applied.geo.width <= 360.5 && applied.geo.height <= 720.5, 'and it fits the third it floats over')
evaluate('jp2LRemoveLayer()')

// A real chat column, measured the way the old over-chat machine measures it.
const column = makeNode('div')
column.rect = { left: 350, top: 0, width: 800, height: 900 }
const composer = makeNode('textarea')
composer.parentElement = column
column.parentElement = sandbox.document.body
sandbox.document.querySelector = selector => (selector === 'textarea' ? composer : null)
sandbox.window.innerWidth = 1400
sandbox.window.innerHeight = 900
assert.equal(evaluate('jp2LFrame()').width, 800, 'the layer sits on the chat column when the shell exposes one')
const wide = evaluate('jp2LApply(jp2ctx, true)')
assert.ok(wide.geo.scale > applied.geo.scale, 'a wide column draws it larger than the fallback third')
evaluate('jp2LRemoveLayer()')

// REGRESSION (owner's screenshot, 2026-11-11 08:03): the composer's own bar is wider than half the window
// but only ~60 px tall. The frame must be the TALL conversation above it, never that strip - taking the
// strip drew a tiny machine on top of the composer at the bottom of the screen.
{
  const bar = makeNode('div')
  bar.rect = { left: 350, top: 830, width: 800, height: 64 }
  const shortComposer = makeNode('textarea')
  shortComposer.parentElement = bar
  bar.parentElement = column
  sandbox.document.querySelector = selector => (selector === 'textarea' ? shortComposer : null)
  const frame = evaluate('jp2LFrame()')
  assert.equal(frame.height, 900, `a wide but short composer bar is skipped for the tall conversation (${JSON.stringify(frame)})`)
  assert.equal(frame.width, 800, 'and it is the conversation column, not the window')
  // With nothing tall above it, the wide bar is still better than nothing (last resort, unchanged).
  bar.parentElement = sandbox.document.body
  assert.equal(evaluate('jp2LFrame()').height, 64, 'only when no tall ancestor exists does the bar stand in')
  sandbox.document.querySelector = selector => (selector === 'textarea' ? composer : null)
}

// REGRESSION (owner's screenshot, 2026-11-11 08:1x): with the Play-while-you-code pane open, the FIRST
// textarea on the page was the pane's own; the finder gave up and the copy fell onto the fallback third
// of the window - on top of the pane. The composer is the first textarea outside Game Center.
{
  const paneBox = makeNode('textarea')
  paneBox.closest = selector => (String(selector).includes('.games-wait-pane') ? {} : null)
  composer.closest = () => null
  sandbox.document.querySelectorAll = selector => (selector === 'textarea' ? [paneBox, composer] : [])
  sandbox.document.querySelector = selector => (selector === 'textarea' ? paneBox : null)
  const frame = evaluate('jp2LFrame()')
  assert.equal(frame.width, 800, `the pane's textarea is skipped and the conversation is found (${JSON.stringify(frame)})`)
  assert.equal(frame.left, 350, 'the conversation column, not the right third of the window')
  delete sandbox.document.querySelectorAll
  sandbox.document.querySelector = selector => (selector === 'textarea' ? composer : null)
}
sandbox.document.querySelector = () => null
console.log('jackpot2: a 360 px column keeps the copy at the floor and inside the column: passed')

// ---- 4. the full view fits 1400x900 and 900x500, nothing clipped -------------
const fitIn = (width, height, label) => {
  const geo = evaluate(`jp2LFitGeometry({ left: 0, top: 0, width: ${width}, height: ${height} }, 1)`)
  assert.ok(geo.scale > 0, `${label}: the full view has a scale`)
  assert.ok(geo.width <= width + 0.5, `${label}: the machine is no wider than its frame (${geo.width} <= ${width})`)
  assert.ok(geo.height <= height + 0.5, `${label}: and no taller (${geo.height} <= ${height})`)
  assert.ok(geo.left >= 0 && geo.top >= 0, `${label}: it is placed inside the frame`)
  assert.ok(geo.left + geo.width <= width + 0.5 && geo.top + geo.height <= height + 0.5,
    `${label}: nothing hangs off the right or the bottom`)
}
fitIn(1400, 900, 'the 1400x900 frame')
fitIn(900, 500, 'the 900x500 frame')

const stageBox = tree => nodes(tree).find(node => node.props && node.props['data-jp2-stage'] === '1')
for (const [width, height] of [[1400, 900], [900, 500]]) {
  reset()
  sandbox.jp2fullProps = { ctx, frame: { width, height } }
  const full = draw('Jackpot2Full(jp2fullProps)')
  const stage = stageBox(full)
  assert.ok(stage, `Jackpot2Full draws a scaled stage in ${width}x${height}`)
  assert.ok(stage.props.style.width <= width + 0.5 && stage.props.style.height <= height + 0.5,
    `nothing spills the ${width}x${height} frame (${stage.props.style.width}x${stage.props.style.height})`)
  const inner = nodes(stage).find(node => node.props && typeof node.props.style.transform === 'string' && node.props.style.transform.startsWith('scale('))
  assert.ok(inner && inner.props.style.transformOrigin === 'top left',
    `the ${width}x${height} stage is transform-scaled from its top-left corner`)
  const cabinet = nodes(full).find(node => node.type && node.type.name === 'JackpotMachine')
  assert.ok(cabinet && cabinet.props.mode === 'full', `the ${width}x${height} full view holds the cabinet in full mode`)
}
reset()
console.log('jackpot2: the full view fits 1400x900 and 900x500 without clipping: passed')

// ---- 5. the layer actually holds the cabinet, in overlay mode ----------------
evaluate('jp2LRemoveLayer()')
sandbox.window.innerWidth = 1400
sandbox.window.innerHeight = 900
sandbox.document.querySelector = () => null
const painted = evaluate('jp2LApply(jp2ctx, true)')
assert.ok(painted.node, 'the layer exists to paint into')
const rendered = painted.node.__rendered
assert.ok(rendered && rendered.props && rendered.props['data-jp2-stage'] === '1',
  'the layer is painted with the machine stage (through a host react-dom root)')
const overlayCabinet = nodes(rendered).find(node => node.type && node.type.name === 'JackpotMachine')
assert.ok(overlayCabinet, 'the layer holds the Jackpot cabinet')
assert.equal(overlayCabinet.props.mode, 'overlay', 'in its overlay mode')
assert.ok(String(rendered.props.style.transform).startsWith('scale('), 'and the stage is transform-scaled by the layer')

// The shipped case has no host react-dom: the machine must still be drawn over the conversation.
delete sandbox.ReactDOM
reset()
evaluate('jp2LRemoveLayer()')
evaluate('jp2LSetOverchat(true, jp2ctx)')
sandbox.jp2statusProps = { ctx }
draw('Jackpot2StatusItem(jp2statusProps)')
const fallbackTree = draw('Jackpot2StatusItem(jp2statusProps)')
const fallbackCabinet = nodes(fallbackTree).find(node => node.type && node.type.name === 'JackpotMachine')
assert.ok(fallbackCabinet && fallbackCabinet.props.mode === 'overlay',
  'with no host react-dom the cabinet is still drawn over the chat')
evaluate('jp2LSetOverchat(false, jp2ctx)')
evaluate('jp2LRemoveLayer()')
reset()

// Regression test: A host react-dom with createPortal but no createRoot:
// Jackpot2StatusItem must render the portal element into its tree so the machine is mounted
sandbox.ReactDOM = {
  createPortal(children, container) {
    return { type: 'portal', props: { children, container } }
  }
}
evaluate('jp2LSetOverchat(true, jp2ctx)')
sandbox.jp2statusProps = { ctx }
draw('Jackpot2StatusItem(jp2statusProps)')
const portalTree = draw('Jackpot2StatusItem(jp2statusProps)')
const portalCabinet = nodes(portalTree).find(node => node.type && node.type.name === 'JackpotMachine')
assert.ok(portalCabinet && portalCabinet.props.mode === 'overlay',
  'with ReactDOM.createPortal the cabinet is rendered via portal in overlay mode')
evaluate('jp2LSetOverchat(false, jp2ctx)')
evaluate('jp2LRemoveLayer()')
delete sandbox.ReactDOM
reset()

console.log('jackpot2: the layer paints the cabinet in overlay mode, with or without a host react-dom: passed')

// ---- 6. the old machine keeps its mechanics and prints no odds numbers -------
// This check used to be `git diff --quiet` on 18-slot-machine.js as well. That is deliberately no
// longer the promise: the owner's release rule (2026-11-11) takes the win chance and the return OFF
// the screen of BOTH machines, so that file is edited on purpose. What must still hold is that the
// v2 lane never needed to touch the old machine's session plumbing, and that no percentage is
// printed by it.
//
// 19-jackpot-overlay.js came off this list when the over-chat lane took it on (2026-11-11): that
// lane's whole job is the ORIGINAL machine's copy over the conversation (it restores 9433891's mount,
// chat-column measurement and show logic so the copy actually appears in the real app), so a
// `git diff` promise over that file would pin the defect. What was worth pinning is pinned directly
// instead, at the end of this file: the built bundle prints no win-chance or return percentage
// anywhere, either machine.
const OLD_MACHINE_PLUMBING = ['desktop/src/18-slots.js']
try {
  execFileSync('git', ['-C', ROOT, 'diff', '--quiet', '--', ...OLD_MACHINE_PLUMBING], { stdio: 'ignore' })
} catch (error) {
  assert.fail(`the old machine's session plumbing must not be touched, but git diff found changes in ${OLD_MACHINE_PLUMBING.join(', ')} (git exit ${error.status})`)
}
const legacyMachine = fs.readFileSync(path.join(ROOT, 'desktop/src/18-slot-machine.js'), 'utf8')
assert.ok(legacyMachine.includes('odds'), 'the old machine still carries the shelf odds prop (the mechanics are kept)')
assert.ok(!/% (?:win|back|of spins)/.test(legacyMachine), 'and prints no win-chance or return percentage')
assert.ok(!legacyMachine.includes('% · bonus') && !legacyMachine.includes('% · cold'), 'and no percentage beside a session mood')
console.log('jackpot2: the old machine shows no odds numbers, and its session plumbing is untouched: passed')

// ---- 7. the cabinet appears for every host shape -----------------------------
// The owner's release blocker (2026-11-11): in the real app the pane's own machine worked and
// NOTHING appeared over the chat. A host can present three shapes, and all three are pinned here.
const machineIn = tree => nodes(tree).find(node => node.type && node.type.name === 'JackpotMachine')

// (a) a host with createRoot: the machine goes into the layer's own div, and NOT a second time into
// our tree.
reset()
evaluate('jp2LRemoveLayer()')
evaluate('jp2LSetOverchat(true, jp2ctx)')
sandbox.ReactDOM = {
  createRoot(node) {
    return { _node: node, render(element) { node.__rendered = element }, unmount() { node.__rendered = null } }
  }
}
sandbox.jp2statusProps = { ctx }
draw('Jackpot2StatusItem(jp2statusProps)')
const rootTree = draw('Jackpot2StatusItem(jp2statusProps)')
const rootLayer = evaluate('jp2LLayerNode()')
assert.ok(rootLayer && rootLayer.__rendered, 'createRoot: the layer div is painted')
assert.ok(machineIn(rootLayer.__rendered), 'createRoot: the cabinet is drawn into the layer div')
assert.ok(!machineIn(rootTree), 'createRoot: and NOT a second time in our own tree')

// (b) a host with createPortal but no createRoot: the portal element is drawn in OUR tree, aimed at
// the layer div.
reset()
evaluate('jp2LRemoveLayer()')
delete sandbox.ReactDOM
sandbox.ReactDOM = { createPortal(children, container) { return { type: 'portal', props: { children, container } } } }
draw('Jackpot2StatusItem(jp2statusProps)')
const portalOnlyTree = draw('Jackpot2StatusItem(jp2statusProps)')
const portalEl = nodes(portalOnlyTree).find(node => node.type === 'portal')
assert.ok(portalEl, 'createPortal: the portal element is drawn in our tree')
assert.equal(portalEl.props.container, evaluate('jp2LLayerNode()'), 'createPortal: and it targets the layer div')
assert.ok(machineIn(portalEl.props.children), 'createPortal: the cabinet rides inside it')
assert.equal(machineIn(portalEl.props.children).props.mode, 'overlay', 'createPortal: in overlay mode')
assert.ok(!nodes(portalOnlyTree).some(node => node.props && node.props['data-jp2-surface'] === 'mirror'),
  'createPortal: and there is no second copy in our tree')

// (c) no react-dom at all AND no body div to paint into: the shipped case, and the exact shape the
// owner reported. The cabinet must still be drawn — as a fixed child of the status span.
reset()
evaluate('jp2LRemoveLayer()')
delete sandbox.ReactDOM
const realBody = sandbox.document.body
sandbox.document.body = { nodeType: 1, tagName: 'BODY', children: [] }   // no appendChild: no div can be made
draw('Jackpot2StatusItem(jp2statusProps)')
const bareTree = draw('Jackpot2StatusItem(jp2statusProps)')
assert.equal(evaluate('jp2LLayerNode()'), null, 'no react-dom and no body div: the layer div cannot be created')
const bareMirror = nodes(bareTree).find(node => node.props && node.props['data-jp2-surface'] === 'mirror')
assert.ok(bareMirror, 'and the cabinet is STILL drawn over the chat, as a fixed child of the status span')
assert.equal(bareMirror.props.style.position, 'fixed', 'position: fixed')
assert.ok(bareMirror.props.style.width > 0 && bareMirror.props.style.height > 0, 'with a real, non-zero box')
assert.ok(Number(bareMirror.props.style.opacity) >= 0.25, 'and never fully transparent (alpha floor 0.25)')
assert.ok(machineIn(bareMirror), 'holding the cabinet')
assert.equal(machineIn(bareMirror).props.mode, 'overlay', 'in overlay mode')
sandbox.document.body = realBody
evaluate('jp2LSetOverchat(false, jp2ctx)')
evaluate('jp2LRemoveLayer()')
reset()
console.log('jackpot2: the cabinet is drawn for all three host shapes, even with no body div: passed')

// ---- 8. one switch: the cabinet's own panel and Settings, on the same keys ----
// The owner's ask (2026-11-11): a clear "Show over chat" switch INSIDE the Jackpot panel beside
// Auto-spin/Auto-bet, and the same switch with the size and see-through sliders in Settings (the
// page's and the pane's, which is one component). One source of truth: the keys the status bar
// already writes.
const controlsIn = tree => nodes(tree).find(node => node.props && node.props['data-jp2-oc'] === 'controls')
const checkBoxIn = tree => nodes(tree).find(node => node.props && node.props['data-jp2-oc-box'] === 'overchat')
const rangeIn = (tree, key) => nodes(tree).some(node => node.props && node.props['data-jp2-oc-range'] === key)

evaluate('jp2LSetOverchat(false, jp2ctx)')
reset()
sandbox.jp2machineProps = { ctx, mode: 'full' }
const machineTree = draw('JackpotMachine(jp2machineProps)')
const panelSwitch = nodes(machineTree).find(node => node.type && node.type.name === 'Jackpot2OverChatControls')
assert.ok(panelSwitch, 'the cabinet panel offers the over-chat switch')
assert.equal(panelSwitch.props.tone, 'cabinet', 'drawn for the dark cabinet')
assert.ok(nodes(machineTree).some(node => node.props && node.props['data-jp2-toggle'] === 'autoplay'),
  'in the same panel as Auto-spin, as asked')

// The block itself, drawn the way the panel draws it (the harness inspects elements, it does not run
// components, so the switch has to be drawn in its own right as well).
reset()
sandbox.jp2controlsProps = { ctx, tone: 'cabinet' }
let controlsTree = draw('Jackpot2OverChatControls(jp2controlsProps)')
assert.ok(controlsIn(controlsTree), 'the switch is one block with the two sliders in it')
assert.ok(rangeIn(controlsTree, 'size'), 'with the size slider beside it')
assert.ok(rangeIn(controlsTree, 'alpha'), 'and the see-through slider')
assert.equal(checkBoxIn(controlsTree).props.checked, false, 'and the switch starts off')

checkBoxIn(controlsTree).props.onChange({ target: { checked: true } })
assert.equal(sandbox.jp2store['jackpot2.overchat'], true, 'turning it on in the panel writes jackpot2.overchat')
controlsTree = draw('Jackpot2OverChatControls(jp2controlsProps)')
assert.equal(checkBoxIn(controlsTree).props.checked, true, 'and the panel reads it back')

// Settings — the Games app's, and the play-while-you-code pane's, which is this same component.
reset()
sandbox.jp2settingsProps = { view: { setup: {}, play: [], player: {} }, ctx, onBack: () => {} }
const settingsTree = draw('SettingsPanel(jp2settingsProps)')
const settingsSwitch = nodes(settingsTree).find(node => node.type && node.type.name === 'Jackpot2OverChatControls')
assert.ok(settingsSwitch, 'Settings offers the same over-chat switch')
assert.equal(settingsSwitch.props.tone, 'settings', 'drawn for the light panel')

// Every component draw gets its own hook slots: the harness's hooks are one flat array, so drawing a
// second component without reset() would hand it the first one's state.
reset()
sandbox.jp2controlsProps = { ctx, tone: 'settings' }
const settingsControlsTree = draw('Jackpot2OverChatControls(jp2controlsProps)')
assert.ok(rangeIn(settingsControlsTree, 'size') && rangeIn(settingsControlsTree, 'alpha'),
  'with the size and see-through sliders beside it')
assert.equal(checkBoxIn(settingsControlsTree).props.checked, true, 'and it reads the value the panel wrote')

checkBoxIn(settingsControlsTree).props.onChange({ target: { checked: false } })
assert.equal(sandbox.jp2store['jackpot2.overchat'], false, 'turning it off in Settings writes the same key')
evaluate('jp2LRemoveLayer()')
reset()
console.log('jackpot2: one over-chat switch, in the panel and in Settings, on the same keys: passed')

// ---- 9. the frame it chose is announced, and nothing is zero-sized ------------
// The owner's ask: log once to console with the frame it chose, so why it is where it is can be read
// without a debugger — and it must be on the start screen (no composer at all) as well as beside a
// chat column. The console.info lines are buffered (see `said` at the top) so the gate's line count
// is not disturbed; switching the layer off clears the buffer's subject, because
// jp2LRemoveLayer() forgets the frame it had already announced.
said.length = 0
reset()
evaluate('jp2LRemoveLayer()')
evaluate('jp2LSetOverchat(true, jp2ctx)')
sandbox.window.innerWidth = 1400
sandbox.window.innerHeight = 900
sandbox.document.querySelector = () => null      // the Hermes start screen: no composer, no column
draw('Jackpot2StatusItem(jp2statusProps)')
const startTree = draw('Jackpot2StatusItem(jp2statusProps)')
const startMirror = nodes(startTree).find(node => node.props && node.props['data-jp2-surface'] === 'mirror')
assert.ok(startMirror, 'the start screen still gets the cabinet over the conversation')
const startFrame = evaluate('jp2LFrame()')
assert.equal(startFrame.width, 467, 'the fallback frame is the right third of the window')
assert.equal(startFrame.left, 933, 'and it is the RIGHT third, not the left')
assert.equal(startFrame.top, 0, 'starting at the top of the window')
assert.equal(startFrame.height, 900, 'and as tall as the window')
assert.ok(startMirror.props.style.width > 0 && startMirror.props.style.height > 0, 'the copy is never zero-sized')
assert.ok(Number(startMirror.props.style.opacity) >= 0.25, 'and never fully transparent')
assert.ok(said.some(line => /^\[jackpot2\] over chat: frame /.test(line)),
  'the frame it chose is announced on the console: ' + JSON.stringify(said))
assert.equal(said.filter(line => /^\[jackpot2\]/.test(line)).length, 1, 'once, not on every render')

// The chat column arrives: the copy moves onto it, and the new frame is announced too. A real host
// re-measures on the window's resize event or on the column's ResizeObserver; the harness has
// neither, so a fresh ctx stands in for that event (ctx is one of the effect's own deps, and the
// storage behind it is the same drawer).
const startColumn = makeNode('div')
startColumn.rect = { left: 350, top: 0, width: 800, height: 900 }
const startComposer = makeNode('textarea')
startComposer.parentElement = startColumn
startColumn.parentElement = sandbox.document.body
sandbox.document.querySelector = selector => (selector === 'textarea' ? startComposer : null)
sandbox.jp2statusProps = { ctx: makeCtx() }
draw('Jackpot2StatusItem(jp2statusProps)')
const columnTree = draw('Jackpot2StatusItem(jp2statusProps)')
const columnMirror = nodes(columnTree).find(node => node.props && node.props['data-jp2-surface'] === 'mirror')
const columnFrame = evaluate('jp2LFrame()')
assert.equal(columnFrame.width, 800, 'with a chat column, the frame is the column')
assert.equal(columnFrame.left, 350, 'at the column’s own left edge')
assert.ok(columnMirror.props.style.left >= 349, 'and the copy moves onto it')
assert.ok(columnMirror.props.style.width <= 800.5, 'without spilling out of it')
assert.ok(said.filter(line => /^\[jackpot2\]/.test(line)).length >= 2, 'and the new frame is announced as well')
sandbox.document.querySelector = () => null
evaluate('jp2LSetOverchat(false, jp2ctx)')
evaluate('jp2LRemoveLayer()')
reset()

// Nothing anywhere in the built bundle prints a win chance or a return (owner's release rule,
// 2026-11-11). The mechanics are untouched; only the printing is gone.
const bundle = fs.readFileSync(path.join(ROOT, 'desktop/plugin.js'), 'utf8')
for (const gone of ['% win this session', '% back promised this session', '% of spins win', '% · bonus', '% · cold', '% promised']) {
  assert.ok(!bundle.includes(gone), `the built bundle no longer prints "${gone}"`)
}
assert.ok(bundle.includes('Show over chat'), 'and it does carry the one over-chat switch')
const centered = evaluate('jp2LOverlayGeometry({ left: 350, top: 0, width: 800, height: 900 }, 1)')
assert.ok(Math.abs(centered.left + centered.width / 2 - 750) <= 1, 'the layer is centered on the chat column')
evaluate('jp2LSetOverchat(true, jp2ctx)')
const stage = evaluate("jp2LStage(jp2ctx, { scale: 1 }, 'overlay')")
const closeButton = nodes(stage).find(node => node.props && node.props['data-jp2-close'] === '1')
assert.ok(closeButton, 'the floating copy has a close button')
closeButton.props.onClick()
assert.equal(store['jackpot2.overchat'], false, 'closing turns off Show over chat')
const prefs = evaluate('jp2LSliderRow(0.7, 1, () => {}, () => {})')
assert.ok(!nodes(prefs).some(node => typeof node.props?.children === 'string' && node.props.children.includes('%')), 'slider controls show no percentages')
console.log('jackpot2: the frame is announced, and no win-chance or return percentage is printed: passed')

// ---- 10. where the copy floats and what colour its frame is -------------------
// The owner's ask (2026-11-11). Three promises a reader can check with no browser in the room: the
// default is EXACTLY the copy that was there before these sliders existed, no offset can push the
// machine out of the conversation or over the composer, and the colour default is the teal the
// cabinet already wears. Then Reset look puts every one of them back.
evaluate('jp2LSetOverchat(false, jp2ctx)')
evaluate('jp2LResetLook(jp2ctx)')
evaluate('jp2LRemoveLayer()')
reset()

// The controls, in the one panel that already held Show over chat / See-through / Size.
sandbox.jp2lookProps = { ctx, tone: 'settings' }
const lookTree = draw('Jackpot2OverChatControls(jp2lookProps)')
const rangeFor = (tree, key) => nodes(tree).find(node => node.props && node.props['data-jp2-oc-range'] === key)
const controlFor = (tree, key) => nodes(tree).find(node => node.type === 'button' && node.props && node.props['data-jp2-oc'] === key)
assert.ok(controlsIn(lookTree), 'the panel with the switch is still one block')
assert.ok(rangeFor(lookTree, 'posx') && rangeFor(lookTree, 'posy'),
  'with a Left-right and an Up-down slider in it')
assert.equal(rangeFor(lookTree, 'posx').props.min, -1, 'the offsets run -1 to +1, centred at 0')
assert.equal(rangeFor(lookTree, 'posx').props.max, 1)
assert.equal(rangeFor(lookTree, 'posx').props.value, 0, 'and they start centred')
assert.ok(rangeFor(lookTree, 'hue'), 'and a hue slider for the colour')
const swatches = nodes(lookTree).filter(node => node.props && node.props['data-jp2-oc-swatch'])
assert.equal(swatches.length, 6, 'six swatches beside it')
assert.equal(swatches[0].props['data-jp2-oc-swatch'], '170', 'the teal the cabinet wears is the first')
assert.equal(swatches[0].props['aria-pressed'], true, 'and it reads as the one in use')
const gradientSelect = nodes(lookTree).find(node => node.props && node.props['data-jp2-oc-select'] === 'gradient')
assert.ok(gradientSelect, 'a Gradient choice')
assert.equal(gradientSelect.props.value, 'teal', 'starting on the current teal')
assert.equal(gradientSelect.props.children.length, 4, 'with four presets: teal, violet, sunset and mono')
const buttonWords = (tree, key) => {
  const node = controlFor(tree, key)
  return node ? [].concat(node.props.children || []).join('') : ''
}
assert.equal(buttonWords(lookTree, 'centre'), 'Top middle', 'a Top middle button that reads Top middle (the starting place, owner 2026-11-11)')
assert.equal(buttonWords(lookTree, 'reset'), 'Reset look', 'and a Reset look button that reads Reset look')

// The default is the copy as it was: the same numbers the door answered before the offsets existed.
// (plain(): the objects come out of the vm's own realm, so their prototype is not the host's and a
// strict deep compare would refuse two identical shapes.)
const plain = value => JSON.parse(JSON.stringify(value))
const LOOK_FRAME = { left: 350, top: 0, width: 800, height: 900 }
const lookFrame = JSON.stringify(LOOK_FRAME)
// With both offsets at 0 the copy is exactly the old centred one; the STARTING place is now the top
// middle (owner, 2026-11-11), checked right after this loop.
evaluate('jp2LSetPosition(0, 0, jp2ctx)')
for (const size of [0.5, 1, 2]) {
  const before = evaluate(`jp2LOverlayGeometry(${lookFrame}, ${size})`)
  const after = evaluate(`jp2LSharedGeometry(${lookFrame}, ${size}, false)`)
  assert.deepEqual(plain(after), plain(before), `with no offsets, size ${size} is exactly where it always was`)
}
evaluate('jp2LSetPosition(JP2L_POS_DEFAULT, JP2L_POSY_DEFAULT, jp2ctx)')
{
  const centred = plain(evaluate(`jp2LOverlayGeometry(${lookFrame}, 0.5)`))
  const start = plain(evaluate(`jp2LSharedGeometry(${lookFrame}, 0.5, false)`))
  assert.equal(start.left, centred.left, 'the starting place is centred left-right')
  assert.ok(start.top < centred.top && start.top >= LOOK_FRAME.top, `and at the top of the conversation, inside it (${JSON.stringify(start)} vs ${JSON.stringify(centred)})`)
}
evaluate('jp2LSetPosition(0, 0, jp2ctx)')
const sharedHome = evaluate(`jp2LSharedGeometry(${lookFrame}, 1, true)`)
assert.equal(sharedHome.left + sharedHome.width, 1150, 'both machines on at once: still the bottom-right of the column')
assert.equal(sharedHome.top + sharedHome.height, 900, 'and still no offsets applied to it')

// The clamp, with a real composer to keep clear of.
const lookColumn = makeNode('div')
lookColumn.rect = LOOK_FRAME
const lookComposer = makeNode('textarea')
lookComposer.rect = { left: 360, top: 700, width: 780, height: 120 }
lookComposer.parentElement = lookColumn
lookColumn.parentElement = sandbox.document.body
sandbox.document.querySelector = selector => (selector === 'textarea' ? lookComposer : null)
sandbox.window.innerWidth = 1400
sandbox.window.innerHeight = 900
assert.equal(evaluate('jp2LComposerTop()'), 700, 'the composer is the limit the copy must not cross')

const placed = (x, y, size) => {
  evaluate(`jp2LSetPosition(${x}, ${y}, jp2ctx)`)
  return evaluate(`jp2LSharedGeometry(${lookFrame}, ${size}, false)`)
}
const far = placed(1, 1, 0.5)
assert.equal(far.left, 800, 'far right: the copy stops at the right edge of the conversation')
assert.equal(far.top, 250, 'far down: it stops with its bottom on the composer’s top edge')
assert.ok(far.left + far.width <= 1150.5 && far.top + far.height <= 700.5,
  `the whole machine stays inside the conversation and above the composer (${far.left}..${far.left + far.width} x ${far.top}..${far.top + far.height})`)
const near = placed(-1, -1, 0.5)
assert.equal(near.left, 350, 'far left: the left edge of the conversation')
assert.equal(near.top, LOOK_FRAME.top, 'far up: the top edge of the conversation (each side travels its own room)')
const home = placed(0, 0, 0.5)
assert.deepEqual(plain(home), plain(evaluate(`jp2LOverlayGeometry(${lookFrame}, 0.5)`)), 'back at the centre: the same numbers again')

// Nothing the slider can ask for, and nothing a corrupted store can hold, gets it out.
assert.equal(evaluate('jp2LClampPosition(5)'), 1, 'the slider cannot ask for more travel than there is')
assert.equal(evaluate('jp2LClampPosition(-5)'), -1, 'on either side')
assert.equal(evaluate('jp2LClampPosition("nonsense")'), 0, 'and nonsense is the centre, never a strange place')
evaluate('JP2L_STORE.posx = 99; JP2L_STORE.posy = -99')
const forced = evaluate(`jp2LSharedGeometry(${lookFrame}, 0.5, false)`)
assert.equal(forced.left, 800, 'even a store holding 99 lands on the right edge, not outside it')
assert.equal(forced.top, LOOK_FRAME.top, 'and on the top edge of the conversation, not off it')
evaluate('jp2LSetPosition(0, 0, jp2ctx)')

// Where there is no room on an axis, that axis does not move: a machine as tall as the conversation
// stays where it is rather than being shoved to one end.
sandbox.document.querySelector = () => null
assert.equal(evaluate('jp2LComposerTop()'), null, 'no conversation: no composer to keep clear of, and no push either')
evaluate('jp2LSetPosition(1, 1, jp2ctx)')
const noRoom = evaluate('jp2LPositioned({ scale: 1, width: 560, height: 720, left: 70, top: 0 }, { left: 0, top: 0, width: 700, height: 720 })')
assert.equal(noRoom.top, 0, 'with no room above or below, the vertical offset does nothing at all')
assert.equal(noRoom.left, 140, 'while the axis that does have room still travels')
evaluate('jp2LSetPosition(0, 0, jp2ctx)')

// The colour default is the teal the cabinet already draws — as numbers, not as a claim.
assert.equal(evaluate('jp2LTint().gradient'), 'teal', 'the default gradient is the current teal')
assert.equal(evaluate('jp2LTint().hue'), 170, 'and the default hue is the cabinet’s own accent')
assert.equal(evaluate('jp2LTint().active'), false, 'so the default paints nothing at all')
assert.equal(evaluate('jp2LTintVars()'), null, 'and the frame is left exactly as the cabinet draws it')
assert.equal(evaluate('jp2LRgba(JP2L_HUE_DEFAULT, JP2L_ACCENT_S, JP2L_ACCENT_L, JP2L_EDGE_ALPHA)'),
  'rgba(62, 224, 197, 0.28)', 'the default hue IS the teal border 18-jackpot2-machine.js draws')
assert.equal(evaluate('jp2LRgba(JP2L_FROST_HUE, JP2L_FROST_S, JP2L_FROST_L, JP2L_FROST_ALPHA)'),
  'rgba(27, 51, 68, 0.6)', 'and the tint keeps the frost that part draws behind the cabinet')
const plainStage = nodes(evaluate(`jp2LStage(jp2ctx, { scale: 1 }, 'overlay')`))
  .find(node => node.props && node.props['data-jp2-stage'] === '1')
assert.equal(plainStage.props['data-jp2-tint'], undefined, 'an untinted copy carries no tint at all')
assert.equal(plainStage.props.style['--jp2-tint-bg'], undefined, 'and sets no colour of its own')

// A hue change is on the copy straight away, and it is one static rule that paints it.
evaluate('jp2LSetHue(248, jp2ctx)')
assert.equal(sandbox.jp2store['jackpot2.hue'], 248, 'the hue is stored under jackpot2.hue')
assert.equal(evaluate('jp2LTint().active'), true, 'and the tint is now on')
const tintedStage = nodes(evaluate(`jp2LStage(jp2ctx, { scale: 1 }, 'overlay')`))
  .find(node => node.props && node.props['data-jp2-stage'] === '1')
assert.equal(tintedStage.props['data-jp2-tint'], 'teal', 'the stage says which gradient is on it')
const tintVars = evaluate('jp2LTintVars()')
assert.equal(tintedStage.props.style['--jp2-tint-bg'], tintVars['--jp2-tint-bg'], 'and carries the frost it should')
assert.ok(String(tintVars['--jp2-tint-bg']).includes('248') === false, 'through the hue, not the literal number')
assert.ok(/^rgba\(/.test(String(tintVars['--jp2-tint-edge'])) && /^rgba\(/.test(String(tintVars['--jp2-tint-glow'])),
  'with a border and a glow at the same alpha the cabinet uses')
const tintRule = String(evaluate('jp2LLayerStyle()').textContent).split('}').find(part => part.includes('[data-jp2-tint]')) || ''
assert.equal(tintRule.split('{')[0].trim(), '[data-jp2-tint] .jp2-machine',
  'one static rule, naming the cabinet root and nothing under it (the reels keep their colours)')
assert.ok(!tintRule.includes('text-shadow'), 'and it never touches the text shadow the cabinet draws')
assert.equal(evaluate('jp2LStage(jp2ctx, { scale: 1 }, "full").props["data-jp2-tint"]'), undefined,
  'the full view in the Games page is the cabinet’s own colour, tinted nowhere')

// The copy itself follows, without a reload: the same door, a different place.
sandbox.document.querySelector = selector => (selector === 'textarea' ? lookComposer : null)
evaluate('jp2LSetOverchat(true, jp2ctx)')
evaluate('jp2LSetSize(0.5, jp2ctx)')
evaluate('jp2LSetPosition(1, 1, jp2ctx)')
reset()
sandbox.jp2statusProps = { ctx }
draw('Jackpot2StatusItem(jp2statusProps)')
const movedTree = draw('Jackpot2StatusItem(jp2statusProps)')
const movedMirror = nodes(movedTree).find(node => node.props && node.props['data-jp2-surface'] === 'mirror')
assert.ok(movedMirror, 'the copy is drawn with the offsets set')
assert.equal(movedMirror.props.style.left, 800, 'and it is where the sliders say: the right edge of the conversation')
assert.equal(movedMirror.props.style.top, 250, 'with its bottom on the composer')
const movedStage = nodes(movedMirror).find(node => node.props && node.props['data-jp2-stage'] === '1')
assert.equal(movedStage.props['data-jp2-tint'], 'teal', 'and the tint rides on the stage that was drawn')

// Reset look: every look setting back to its default, and the switch left exactly where it was.
assert.equal(sandbox.jp2store['jackpot2.posx'], 1, 'the position is stored under jackpot2.posx')
assert.equal(sandbox.jp2store['jackpot2.posy'], 1, 'and jackpot2.posy')
evaluate('jp2LSetGradient("mono", jp2ctx)')
assert.equal(sandbox.jp2store['jackpot2.gradient'], 'mono', 'the gradient under jackpot2.gradient')
evaluate('jp2LResetLook(jp2ctx)')
assert.equal(sandbox.jp2store['jackpot2.alpha'], 0.25, 'Reset look puts the see-through back (most see-through)')
assert.equal(sandbox.jp2store['jackpot2.size'], 0.5, 'and the size (half, the default)')
assert.equal(sandbox.jp2store['jackpot2.posx'], 0, 'and the position')
assert.equal(sandbox.jp2store['jackpot2.posy'], -1, 'back to the top middle')
assert.equal(sandbox.jp2store['jackpot2.hue'], 170, 'and the colour')
assert.equal(sandbox.jp2store['jackpot2.gradient'], 'teal')
assert.equal(evaluate('jp2LTint().active'), false, 'so nothing is painted again')
assert.equal(sandbox.jp2store['jackpot2.overchat'], true, 'and the over-chat switch is not a look: it is left on')
evaluate('jp2LSetOverchat(false, jp2ctx)')
evaluate('jp2LRemoveLayer()')
sandbox.document.querySelector = () => null
reset()
console.log('jackpot2: the copy’s position and colour default to exactly the copy there was before: passed')
// ---- 11. the cabinet feeds itself, says so, and shows what it pays -------------
// The owner's report (2026-11-11): *"auto-spin is NOT working"*. The hook path was not the defect and
// is not touched here: the shelf spins on it - one spin for a reply, one for a tool call - only while
// a machine says it is on screen, and the Jackpot cabinet never said so, so with the cabinet up (the
// usual case, the original copy over the chat being off) every hook was refused. This section pins
// the report, the two lines the owner asked the cabinet to carry, the pay table it opens, and the
// one thing the cabinet must never do: spin on a clock of its own.
reset()
const seen = []
const watchCtx = {
  rest: async (path, opts) => { seen.push({ path, method: (opts && opts.method) || 'GET', body: opts && opts.body }); return data },
  storage: ctx.storage
}
sandbox.jp2watchCtx = watchCtx
// The cabinet seeds itself from the last good /jackpot answer the shelf sent (the shared JP2_LAST),
// and the poll is asynchronous - the harness draws synchronously - so the answer is put there the way
// an earlier mount would have left it.
sandbox.jp2watchData = data
evaluate('JP2_LAST = jp2watchData')
sandbox.jp2machineProps = { ctx: watchCtx, mode: 'full' }
const machineDraw = draw('JackpotMachine(jp2machineProps)')

const reports = seen.filter(call => call.path === '/jackpot/visible')
assert.ok(reports.length >= 1, 'the cabinet tells the shelf it is on screen')
assert.equal(reports[reports.length - 1].body.on, true, 'and that it IS on screen')
assert.equal(reports[reports.length - 1].body.source, 'jackpot2',
  "under its own name, so closing it cannot clear the original copy's flag")
assert.ok(seen.some(call => call.path === '/jackpot'), 'and it reads the wallet while it is there')
assert.ok(!seen.some(call => call.path === '/jackpot/spin'),
  'nothing in the cabinet spins on a clock: the automatic spin is the shelf hook path\'s')

// Two surfaces at once (the Games page and the pane can both hold one), then both closed: the cabinet
// is only off screen once the last of them is gone, and the report says so.
draw('JackpotMachine(jp2machineProps)')        // a second mount, same surface name
seen.length = 0
reset()                                        // both unmount at once: the cleanup reports it
const off = seen.filter(call => call.path === '/jackpot/visible')
assert.ok(off.length >= 1, 'unmounting reports the surface going away')
assert.equal(off[off.length - 1].body.on, false, 'and that nothing is on screen any more')

// The two lines the owner asked for, on the cabinet, with the whole sentence in the tooltip.
const noteLine = nodes(machineDraw).find(node => node.props && node.props['data-jp2-autospin-note'])
const autospinWords = evaluate('JP2_AUTOSPIN_NOTE')
assert.ok(noteLine, 'the cabinet carries the line about the automatic spin')
assert.equal(noteLine.props.children, autospinWords, 'in the shelf\'s own words, not a paraphrase')
assert.ok(/spins by itself/i.test(autospinWords) && /tokens you spend/i.test(autospinWords)
  && /games you win/i.test(autospinWords), autospinWords)
assert.equal(noteLine.props.title, autospinWords, 'and the same sentence is the tooltip')
const pointsWords = evaluate('JP2_POINTS_NOTE')
assert.ok(/your ranking/i.test(pointsWords) && /lowers/i.test(pointsWords), pointsWords)

// The cash-in control: a slider, a number and Max, all at the rate the shelf sent (four points buy
// three chips) - read off points_rate rather than typed into the cabinet.
const control = nodes(machineDraw).find(node => node.props && node.props['data-jp2-points-control'])
assert.ok(control, 'the cabinet offers the cash-in control')
const controlNodes = nodes(control)
const slider = controlNodes.find(node => node.props && node.props['data-jp2-points-range'])
const number = controlNodes.find(node => node.props && node.props['data-jp2-points-number'])
assert.ok(slider && number, 'a slider and a number, as asked')
assert.equal(slider.props.step, 4, 'stepping in whole blocks of the shelf\'s rate')
assert.equal(slider.props.max, 40, 'up to every point the person holds, in whole blocks')
const maxButton = controlNodes.find(node => node.props && node.props['data-jp2-points-max'])
const cashButton = controlNodes.find(node => node.props && node.props['data-jp2-points-cash'])
assert.ok(maxButton && cashButton, 'with Max and the one press that turns them in')
assert.equal(maxButton.props.children, 'Max')
slider.props.onChange({ target: { value: '20' } })
const afterSlide = draw('JackpotMachine(jp2machineProps)')
const slidButton = nodes(afterSlide).find(node => node.props && node.props['data-jp2-points-cash'])
assert.equal(slidButton.props.children, 'Cash in 20 points', 'the amount the person picked is what it spends')

// What it pays: opened from the header, drawn over the reels, generated from the live pay table.
const openButton = nodes(afterSlide).find(node => node.props && node.props['data-jp2-pays-open'])
assert.ok(openButton, 'the cabinet offers what it pays')
openButton.props.onClick()
const withTable = draw('JackpotMachine(jp2machineProps)')
const panel = nodes(withTable).find(node => node.props && node.props['data-jp2-pays'] === '1')
assert.ok(panel, 'opening it draws the pay table')
const panelRows = nodes(panel).filter(node => node.props && typeof node.props['data-jp2-pay-row'] === 'string')
assert.equal(panelRows.length, data.paytable.length, 'a row per combination the shelf sent')
const panelText = nodes(panel)
  .flatMap(node => [].concat((node.props && node.props.children) || []))
  .filter(child => typeof child === 'string').join(' ')
assert.ok(/200 chips/.test(panelText), 'each row carries the payout the shelf quoted: ' + panelText.slice(0, 140))
assert.ok(!panelText.includes('%'), 'and the table prints no percentage anywhere: ' + panelText.slice(0, 140))
const closeTable = nodes(panel).find(node => node.props && node.props['data-jp2-pays-close'])
assert.ok(closeTable, 'the table has its own close')
closeTable.props.onClick()
const closedTable = draw('JackpotMachine(jp2machineProps)')
assert.ok(!nodes(closedTable).some(node => node.props && node.props['data-jp2-pays'] === '1'),
  'closing it takes the table off the reels again')
assert.ok(nodes(closedTable).some(node => node.props && node.props['data-jp2-pays-open']),
  'and the way to open it is still there')
// Unmount: the cabinet's poll timer is the harness's own real setTimeout (the sandbox passes Node's
// through), and a draw left mounted would keep the event loop alive for ever - the harness would print
// DONE and then never exit, which is a hung gate rather than a failing one. reset() runs the effects'
// cleanups, which is also how the last surface reports going off screen.
reset()
console.log('jackpot2: the cabinet reports itself, carries the two lines, and shows what it pays: passed')

console.log('jackpot2 harness: passed')
console.log('DONE')
