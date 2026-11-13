// tests/jackpot2_harness.cjs -- JACKPOT v2, LANE C: the over-chat copy, its switch and the fit.
//
// The second slot machine is two parts of the bundle beside the old one: 18-jackpot2-machine.js (the
// cabinet, JackpotMachine({ ctx, mode })) and 19-jackpot2-layer.js (the copy over the conversation, the
// switch and sliders that size it, and the full view). This harness pins that half of the contract in the
// style of tests/jackpot_overlay_harness.cjs: it loads the built desktop/plugin.js in a vm sandbox and
// reads the tree the components hand the app — no Games page, no route, no browser.
//
// THE COPY LIVES IN A SLOT (review, 2026-11-12). It used to be a position:fixed div appended to
// document.body, measured against the app's own markup and announced on the console. It is a
// `composer.underside` contribution now: the composer's width is the only measurement, the strip splits it
// between the machines, and nothing here reads the window or the app's DOM.
//
// What it checks, in the order the brief lists it:
//   1. the switch alone draws and removes the copy: nothing while it is off, a fitted box while it is on;
//   2. the switch is the same stored setting the cabinet's panel and Settings write, and a stored switch
//      is adopted by a copy that mounts afterwards (a reload does not lose it);
//   3. the fit: a narrow share halves the machine, the strip's height budget caps a tall one, and the size
//      slider scales it inside that share — never wider than the share, never zero-sized;
//   4. the full view fits 1400x900 and 900x500 with nothing clipped;
//   5. the stage holds the cabinet in overlay mode, and its tint / watch-only rules are a <style> element
//      of the stage rather than a stylesheet pushed into the app's <head>;
//   6. the old machine keeps its odds mechanics and prints no win-chance or return percentage;
//   7. the copy is drawn with NO document and NO window at all — the review's whole point;
//   8. one switch, drawn from one component, in the cabinet's own panel and in Settings, on the same keys;
//   9. no win-chance or return percentage text survives anywhere in the built bundle, and no copy is drawn
//      at a size nobody could see;
//  10. the colour (owner's ask, 2026-11-11): six swatches, a gradient, a default that is exactly the teal
//      the cabinet already draws, Reset look putting it back, and no position sliders — the slot owns the
//      place now.
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

// ---- the smallest DOM there is -----------------------------------------------
// The copy is drawn inside the composer's underside slot (review, 2026-11-12), so it needs no document
// of the app's: no body to append to, no head for a stylesheet, no element to measure. These stubs are
// here only for the parts that genuinely own a DOM node (the cabinet's own art), and section 7 proves the
// copy itself is drawn with no document and no window at all.
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

// Every name this half publishes has to be in the built file before anything below can run. The layer's
// own doors (jp2LApply, jp2LLayerNode, jp2LFrame, ...) are deliberately NOT here: the copy is a slot
// contribution now, and a re-introduced document-level layer should fail this harness, not pass it.
for (const name of ['JackpotMachine', 'Jackpot2Full', 'Jackpot2Tile',
  'Jackpot2OverChatControls', 'jp2LOverChatCopy', 'jp2LSlotScale', 'jp2LStyleRules',
  'jp2LFitGeometry', 'jp2LSetOverchat', 'OverChatStrip']) {
  assert.equal(evaluate(`typeof ${name}`), 'function', `${name} is in the built bundle (run python3 tools/build_plugin.py first)`)
}
assert.equal(typeof evaluate('window.__jp2'), 'object', 'the machine publishes window.__jp2 for tests')

// A /jackpot answer, the same shape the shelf sends the old machine. The cabinet reads its own data,
// so this is here for the surfaces that do poll (the copy mounts one poller while it is shown).
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

// ---- 1. the copy is a slot contribution: a stored switch and a width -------------------
// ---- the copy is a slot contribution: a stored switch and a width -----------------------
// One helper for a fresh mount, the way the composer mounts the strip: a new ctx (so the stored switch is
// adopted), reset hooks, drawn with the width the slot would hand it.
function drawCopy(width, ctxOverride) {
  sandbox.jp2copy = { ctx: ctxOverride || makeCtx(), width }
  reset()
  return draw('jp2LOverChatCopy(jp2copy)')
}
const copySurface = tree => nodes(tree).find(node => node.props && node.props['data-jp2-surface'] === 'copy')

{
  // 1. The switch alone draws and removes the copy. There is no layer to create, no div to append and no
  // body to reach into: the strip draws the copy only while the setting says so.
  store['jackpot2.overchat'] = false
  assert.equal(drawCopy(380), null, 'nothing is drawn while the switch is off')
  const onCtx = makeCtx()
  evaluate('jp2LSetOverchat(true, jp2copy.ctx)')
  assert.equal(store['jackpot2.overchat'], true, 'turning it on stores the switch')
  const tree = drawCopy(380, onCtx)
  const surface = copySurface(tree)
  assert.ok(surface, 'turning the switch on draws the copy')
  assert.ok(!('position' in surface.props.style), 'the slot places it; the copy has no position of its own')
  assert.ok(!('left' in surface.props.style) && !('top' in surface.props.style), 'and no coordinates')
  const width = Number(surface.props.style.width) || 0
  const height = Number(surface.props.style.height) || 0
  assert.ok(width > 0 && height > 0, `drawn at a size a person can see (${width}x${height})`)
  assert.ok(width <= 380 + 0.5, `never wider than the share it was given (${width})`)
  assert.ok(height <= evaluate('OVERCHAT_MAX_HEIGHT') + 0.5, 'nor taller than the strip budget')
  evaluate('jp2LSetOverchat(false, jp2copy.ctx)')
  assert.equal(drawCopy(380), null, 'and off removes it again')
  console.log('jackpot2: the switch alone draws and removes the copy: passed')
}

{
  // 2. The stored switch: one key, written from any surface, adopted by a copy that mounts later. This is
  // what makes the copy survive a reload — the old failure was a switch the copy never read.
  store['jackpot2.overchat'] = false
  // A host-side ctx, handed to the bundle's own setter: the vm has no makeCtx of its own.
  const setOverchat = evaluate('jp2LSetOverchat')
  setOverchat(false, makeCtx())
  assert.equal(store['jackpot2.overchat'], false, 'off is stored under jackpot2.overchat')
  setOverchat(true, makeCtx())
  assert.equal(store['jackpot2.overchat'], true, 'and on is stored under the same key')
  // A fresh ctx is a fresh mount: jp2LAdopt re-reads the stored value, so this copy comes up on.
  const revived = drawCopy(380, makeCtx())
  assert.ok(copySurface(revived), 'a copy that mounts with the switch stored comes up drawn')
  store['jackpot2.overchat'] = false
  assert.equal(drawCopy(380, makeCtx()), null, 'and a stored off draws nothing')
  console.log('jackpot2: the switch alone draws, removes and revives the copy: passed')
}
// ---- 3. the fit: the share it is given, and nothing else ---------------------
// ---- 3. the fit: the share it is given, and nothing else ---------------------
// The strip measures its own box and splits it; the copy is fitted into its share with a height budget, and
// the size slider scales it inside that. No window, no chat column, no viewport.
const maxHeight = evaluate('OVERCHAT_MAX_HEIGHT')
{
  const wide = evaluate('jp2LSlotScale(380, 1)')
  assert.ok(wide > 0, 'a 380 px share has a scale')
  assert.ok(560 * wide <= 380 + 0.5, `and the machine is no wider than it (${560 * wide})`)
  assert.ok(720 * wide <= maxHeight + 0.5, `nor taller than the strip budget (${720 * wide} of ${maxHeight})`)

  const half = evaluate('jp2LSlotScale(190, 1)')
  assert.ok(half < wide && 560 * half <= 190 + 0.5, `half the share halves the machine (${560 * half})`)

  assert.equal(evaluate('jp2LSlotScale(0, 1)'), 0, 'a share of nothing draws nothing')
  assert.equal(evaluate('jp2LSlotScale(-40, 1)'), 0, 'and neither does a nonsense width')

  const smaller = evaluate('jp2LSlotScale(760, 0.5)')
  const full = evaluate('jp2LSlotScale(760, 1)')
  assert.ok(smaller > 0 && smaller < full, `the size slider shrinks the cabinet (${smaller} < ${full})`)
  const big = evaluate('jp2LSlotScale(380, 2)')
  assert.ok(560 * big <= 380 + 0.5, `and cannot push it past its share (${560 * big} of 380)`)
  console.log('jackpot2: the copy is fitted to its share of the slot, and no larger: passed')
}
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

// ---- 5. the stage holds the cabinet, and the rules are ours --------------------
// ---- 5. the stage holds the cabinet, and the rules are ours --------------------
// The cabinet is drawn in overlay mode inside a stage transform-scaled from its top-left corner, and the
// rules it needs (the tint, "watching, not clicking") are a <style> element of that stage. They used to be
// appended to the app's <head>; a plugin does not get to write there.
{
  store['jackpot2.overchat'] = true
  const tree = drawCopy(380, makeCtx())
  const cabinet = nodes(tree).find(node => node.type && node.type.name === 'JackpotMachine')
  assert.ok(cabinet, 'the copy holds the cabinet')
  assert.equal(cabinet.props.mode, 'overlay', 'in overlay mode')
  const stage = nodes(tree).find(node => node.props && node.props['data-jp2-stage'] === '1')
  assert.ok(stage, 'inside a stage of ours')
  assert.equal(stage.props.style.width, 560, 'at the cabinet\'s own design width')
  assert.equal(stage.props.style.height, 720, 'and height')
  assert.ok(String(stage.props.style.transform).startsWith('scale('), 'transform-scaled, never resized')
  assert.equal(stage.props.style.transformOrigin, 'top left', 'from the top-left corner')
  const rules = nodes(tree).find(node => node.type === 'style')
  assert.ok(rules, 'the stage carries its own rules as a <style> element')
  const css = String(rules.props.children)
  assert.ok(css.includes('[data-jp2-stage]'), 'every rule is scoped to that stage')
  assert.ok(!css.includes('[data-jp2-layer]') && !css.includes('body'), 'and none of them names the document')
  const close = nodes(tree).find(node => node.type === 'button' && node.props && node.props['data-jp2-close'] === '1')
  assert.ok(close, 'the copy has its own close control')
  close.props.onClick()
  assert.equal(store['jackpot2.overchat'], false, 'and closing it turns the switch off')
  console.log('jackpot2: the stage holds the cabinet, and its rules live in our own tree: passed')
}
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

// ---- 7. no document, no window: the whole point of the fix ---------------------
// ---- 7. no document, no window: the whole point of the fix ---------------------
// The review's finding was a copy that reached into the app's markup. This draws it with `document` and
// `window` deleted from the sandbox: if anything still needs them, this fails loudly instead of in a shell
// the plugin cannot see.
{
  store['jackpot2.overchat'] = true
  const savedDocument = sandbox.document
  const savedWindow = sandbox.window
  delete sandbox.document
  delete sandbox.window
  let tree = null
  try {
    tree = drawCopy(380, makeCtx())
  } finally {
    sandbox.document = savedDocument
    sandbox.window = savedWindow
  }
  const surface = copySurface(tree)
  assert.ok(surface, 'the copy is drawn with no document and no window at all')
  assert.ok(nodes(tree).some(node => node.props && node.props['data-jp2-stage'] === '1'), 'stage and all')
  // And the bundle has no way back to the app's markup, in the copy's own part or anywhere else.
  for (const pattern of ['document\\.body\\s*\\.', 'document\\.head\\s*\\.', 'document\\.querySelector',
    'window\\.hermesDesktop', 'createElement\\(\\s*[\'"]style']) {
    assert.ok(!new RegExp(pattern).test(source), `the bundle never uses /${pattern}/`)
  }
  console.log('jackpot2: the copy is drawn with no document and no window: passed')
}
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
reset()
console.log('jackpot2: one over-chat switch, in the panel and in Settings, on the same keys: passed')

// ---- 9. no percentage, and no copy nobody could see ---------------------------
{
  for (const gone of ['% win this session', '% back promised', '% of spins win', '% · bonus', '% · cold']) {
    assert.ok(!source.includes(gone), `no "${gone}" anywhere in the built bundle`)
  }
  assert.ok(!source.includes('console.info(`[jackpot2] over chat'),
    'the frame no longer has to be announced: the slot decides it, and there is no frame to explain')
  // A scale of nothing is not drawn at all, rather than drawn at 2% and invisible.
  assert.equal(evaluate('jp2LSlotScale(4, 1)'), 0, 'a four-pixel share draws nothing')
  assert.ok(evaluate('jp2LSlotScale(380, 1)') > 0.02, 'a real share draws a real size')
  console.log('jackpot2: no percentage is printed, and no copy is zero-sized: passed')
}
// ---- 10. the colour of the frame (and no place to set: the slot owns it) ------
// ---- 10. the colour of the frame (and no place to set: the slot owns it) ------
// The owner's ask (2026-11-11) kept the part a reader can check with no browser in the room: the colour
// default is EXACTLY the teal the cabinet already draws, the six swatches and the gradient are one static
// rule scoped to our own stage, and Reset look puts every look setting back.
//
// The two position sliders are gone on purpose (review, 2026-11-12): a copy that lives in a slot has a
// place, and an offset would move it across a frame it does not own. The stored keys are not read.
evaluate('jp2LSetOverchat(false, jp2ctx)')
evaluate('jp2LResetLook(jp2ctx)')
assert.equal(sandbox.jp2store['jackpot2.overchat'], false, 'Reset look never turns the copy on by itself')
reset()

{
  sandbox.jp2lookProps = { ctx, tone: 'settings' }
  const lookTree = draw('Jackpot2OverChatControls(jp2lookProps)')
  const rangeFor = (tree, key) => nodes(tree).find(node => node.props && node.props['data-jp2-oc-range'] === key)
  const controlFor = (tree, key) => nodes(tree).find(node => node.type === 'button' && node.props && node.props['data-jp2-oc'] === key)
  assert.ok(controlsIn(lookTree), 'the panel with the switch is one block')
  assert.ok(rangeFor(lookTree, 'alpha'), 'with the see-through slider')
  assert.ok(rangeFor(lookTree, 'size'), 'the size slider')
  assert.ok(!rangeFor(lookTree, 'posx') && !rangeFor(lookTree, 'posy'),
    'and no place sliders: the composer slot decides where the copy is')
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
  assert.equal(buttonWords(lookTree, 'reset'), 'Reset look', 'and a Reset look button that reads Reset look')
}

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
const rules = String(evaluate('jp2LStyleRules(jp2LTint())'))
const tintRule = rules.split('}').find(part => part.includes('[data-jp2-tint]')) || ''
assert.equal(tintRule.split('{')[0].trim(), '[data-jp2-stage][data-jp2-tint] .jp2-machine',
  'one static rule, scoped to our stage, naming the cabinet root and nothing under it (the reels keep their colours)')
assert.ok(!tintRule.includes('text-shadow'), 'and it never touches the text shadow the cabinet draws')
assert.equal(evaluate('jp2LStage(jp2ctx, { scale: 1 }, "full").props["data-jp2-tint"]'), undefined,
  'the full view in the Games page is the cabinet’s own colour, tinted nowhere')
// The stage that draws the tint is the one the copy draws, with no reload: the colour rides on it.
store['jackpot2.overchat'] = true
const live = copySurface(drawCopy(380, makeCtx()))
assert.ok(live, 'the copy is drawn with the tint set')
const liveStage = nodes(live).find(node => node.props && node.props['data-jp2-stage'] === '1')
assert.equal(liveStage.props['data-jp2-tint'], 'teal', 'and the tint rides on the stage that was drawn')

// Reset look: every look setting back to its default, and the switch left exactly where it was.
evaluate('jp2LSetAlpha(0.5, jp2ctx)')
evaluate('jp2LSetSize(2, jp2ctx)')
evaluate('jp2LSetGradient("mono", jp2ctx)')
assert.equal(sandbox.jp2store['jackpot2.gradient'], 'mono', 'the gradient under jackpot2.gradient')
assert.equal(sandbox.jp2store['jackpot2.overchat'], true, 'the switch is on before Reset look')
evaluate('jp2LResetLook(jp2ctx)')
assert.equal(sandbox.jp2store['jackpot2.alpha'], 0.25, 'Reset look puts the see-through back (most see-through)')
assert.equal(sandbox.jp2store['jackpot2.size'], 1, 'and the size (full: 100% is the slot\'s own allowance)')
assert.equal(sandbox.jp2store['jackpot2.hue'], 170, 'and the colour')
assert.equal(sandbox.jp2store['jackpot2.gradient'], 'teal')
assert.equal(evaluate('jp2LTint().active'), false, 'so nothing is painted again')
assert.equal(sandbox.jp2store['jackpot2.overchat'], true, 'and the over-chat switch is not a look: it is left on')
evaluate('jp2LSetOverchat(false, jp2ctx)')
reset()
console.log('jackpot2: the copy’s colour defaults to exactly the frame the cabinet already draws: passed')
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
