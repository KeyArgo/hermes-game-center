// tests/jackpot2_look_harness.cjs -- JACKPOT v2: the over-chat copy's POSITION and COLOUR, in depth.
//
//   python3 tools/build_plugin.py && node tests/jackpot2_look_harness.cjs
//
// tests/jackpot2_harness.cjs pins where the two settings sit (the same panel as Show over chat,
// See-through and Size), that their default is exactly the copy that was there before them, and that
// no offset can push the machine out of the conversation or over the composer. This file goes after
// what reading a panel cannot settle:
//
//   1. the hue -> colour maths is total (every hue the slider can offer paints a valid colour) and the
//      frame it paints keeps the cabinet's own ink at AAA contrast (7:1) at EVERY hue and preset, so
//      "the text stays readable" is a number rather than a hope;
//   2. the four gradients are four different looks, the default is the frame's flat frost, 'violet'
//      really runs the violet swatch into the chosen hue at the default, and 'mono' ignores the hue;
//   3. every value survives a round trip through ctx.storage, and a value that cannot be honoured — a
//      word where a number belongs, an old host's out-of-range number — comes back as the default;
//   4. the tint is one static rule that names the cabinet's ROOT and nothing under it, uses no filter
//      and never touches the text shadow, so the reels, the symbol art and the words keep their own
//      colours;
//   5. the offsets travel symmetrically about the centre, so the default is the middle of the travel
//      and not one end of it, and the machine is handed nothing new by any of it.
//
// It reads desktop/plugin.js, the built bundle, exactly as the other two harnesses do.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const source = fs.readFileSync(path.join(ROOT, 'desktop/plugin.js'), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export \{.*\}$/gm, '').replace('export default {', 'const plugin = {')

// ---- the smallest shell the layer's look needs --------------------------------
// Nothing is drawn here: every check below calls the layer's own pure functions, so the stub only has
// to be enough for the bundle to load and for the two DOM questions (the chat column and the composer)
// to be answerable.
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
    removeChild(child) { const at = node.children.indexOf(child); if (at >= 0) node.children.splice(at, 1); child.parentNode = null; return child },
    remove() { if (node.parentNode && typeof node.parentNode.removeChild === 'function') node.parentNode.removeChild(node) },
    getBoundingClientRect() { return node.rect || { left: 0, top: 0, width: 0, height: 0 } }
  }
  Object.defineProperty(node, 'firstChild', { get: () => node.children[0] || null })
  return node
}

const body = makeNode('body')
const head = makeNode('head')
// The conversation the copy floats over: a chat column 800 px wide and a composer along its bottom,
// the same shape tests/jackpot2_harness.cjs measures against.
const column = makeNode('div')
column.rect = { left: 350, top: 0, width: 800, height: 900 }
const composer = makeNode('textarea')
composer.rect = { left: 360, top: 700, width: 780, height: 120 }
composer.parentElement = column
column.parentElement = body

const sandbox = {
  console: { log: console.log, warn: () => {}, error: () => {}, info: () => {} },
  Set, setTimeout, clearTimeout, setInterval, clearInterval,
  Component: class { constructor(props) { this.props = props; this.state = {} } setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) } } },
  useState: initial => [initial, () => {}],
  useRef: initial => ({ current: initial }),
  useEffect: () => {},
  useCallback: fn => fn,
  useMemo: fn => fn(),
  jsx: (type, props, extra) => ({ type, props: props || {}, key: extra }),
  jsxs: (type, props, extra) => ({ type, props: props || {}, key: extra }),
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} }
}
sandbox.window = {
  innerWidth: 1400,
  innerHeight: 900,
  addEventListener: () => {},
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
}
sandbox.document = {
  body,
  head,
  createElement: tag => makeNode(tag),
  createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
  getElementById: () => null,
  querySelector: selector => (selector === 'textarea' ? composer : null),
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {}
}
sandbox.host = { navigate: () => {} }
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

const evaluate = expression => vm.runInContext(expression, sandbox)
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree)
  ? tree.flatMap(nodes)
  : [tree, ...[].concat(tree.props && tree.props.children || []).flatMap(nodes)]
// A page must never lose a label a person is meant to read: this walks the drawn tree for its words,
// the way tests/table_ui_harness.cjs does, so a tag whose text never made it into the tree (the third
// jsx argument is the key, not the children) fails here instead of quietly reading as a blank gap.
const words = tree => !tree ? '' : typeof tree !== 'object' ? String(tree) : Array.isArray(tree)
  ? tree.map(words).join(' ')
  : [].concat(tree.props && tree.props.children || []).map(words).join(' ')
// Objects out of the vm carry the vm's own prototype, which a strict deep compare refuses even when
// the shapes are identical.
const plain = value => JSON.parse(JSON.stringify(value))
const FRAME = { left: 350, top: 0, width: 800, height: 900 }

for (const name of ['jp2LTint', 'jp2LTintPalette', 'jp2LTintVars', 'jp2LRgba', 'jp2LClampHue',
  'jp2LSetHue', 'jp2LSetGradient', 'jp2LResetLook', 'jp2LStyleRules', 'jp2LSlotScale', 'useJp2LTint']) {
  assert.equal(evaluate(`typeof ${name}`), 'function', `${name} is in the built bundle (run python3 tools/build_plugin.py first)`)
}

// ---- the colour maths, and the contrast it keeps ------------------------------
// WCAG relative luminance, so "the text stays readable" can be measured instead of asserted. The ink
// is the colour 18-jackpot2-machine.js writes the cabinet's own text in (#e8f4ff, JP2_INK).
const channel = value => {
  const v = value / 255
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
const rgbasIn = css => [...String(css).matchAll(/rgba\((\d+), (\d+), (\d+), ([0-9.]+)\)/g)]
  .map(match => [Number(match[1]), Number(match[2]), Number(match[3])])
const INK = luminance([232, 244, 255])

// Every hue the slider offers (0 - 360, step 1) against every gradient, in one call inside the bundle.
const painted = evaluate(`(function () {
  const out = []
  for (let hue = 0; hue <= 360; hue += 1) {
    for (const gradient of ['teal', 'violet', 'sunset', 'mono']) {
      out.push(gradient + ':' + hue + ':' + jp2LTintPalette(jp2LTint(gradient, hue)).background)
    }
  }
  return out
})()`)
assert.equal(painted.length, 361 * 4, 'every hue is painted against every gradient')

let worst = { ratio: Infinity, where: '' }
for (const line of painted) {
  const [gradient, hue, background] = [line.slice(0, line.indexOf(':')), line.split(':')[1], line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1)]
  const stops = rgbasIn(background)
  assert.ok(stops.length >= 1, `hue ${hue} paints a colour (${gradient})`)
  assert.ok(/rgba\(/.test(background), `hue ${hue} paints a real colour, never an empty value (${gradient})`)
  for (const stop of stops) {
    const ratio = contrast(INK, luminance(stop))
    if (ratio < worst.ratio) worst = { ratio, where: `${gradient} at hue ${hue} (${background})` }
  }
}
assert.ok(worst.ratio >= 7,
  `the cabinet's ink keeps AAA contrast (7:1) against every frost the tint can paint: worst ${worst.ratio.toFixed(2)}:1 at ${worst.where}`)
const defaultFrost = rgbasIn(evaluate('jp2LTintPalette(jp2LTint("teal", 170)).background'))[0]
assert.ok(luminance(defaultFrost) > 0, 'the default frost is a real, dark colour')
assert.deepEqual(plain(rgbasIn(evaluate(`jp2LRgba(JP2L_FROST_HUE, JP2L_FROST_S, JP2L_FROST_L, JP2L_FROST_ALPHA)`))[0]),
  [27, 51, 68], 'and its saturation and lightness ARE the frost the cabinet draws: at the frost\'s own hue they land on rgba(27, 51, 68, .6)')
assert.deepEqual(plain(rgbasIn(evaluate(`jp2LRgba(JP2L_HUE_DEFAULT, JP2L_ACCENT_S, JP2L_ACCENT_L, 1)`))[0]),
  [62, 224, 197], 'as the accent\'s land on #3ee0c5, the teal the cabinet already wears')
console.log(`jackpot2 look: every hue keeps the ink at ${worst.ratio.toFixed(1)}:1 or better, AAA, with no filter in sight: passed`)

// ---- the four gradients are four different looks ------------------------------
const lookAt = (gradient, hue) => evaluate(`jp2LTintPalette(jp2LTint(${JSON.stringify(gradient)}, ${hue}))`)
const frostStop = (hue, saturation, lightness) => evaluate(`jp2LRgba(${hue}, ${saturation}, ${lightness}, JP2L_FROST_ALPHA)`)
assert.equal(String(lookAt('teal', 200).background).includes('linear-gradient'), false,
  'the default gradient is a flat frost, the shape the frame always had')
const violet = String(lookAt('violet', 170).background)
assert.equal(violet,
  `linear-gradient(165deg, ${frostStop(248, 'JP2L_FROST_S', 'JP2L_FROST_L')} 0%, ${frostStop(170, 'JP2L_FROST_S', 'JP2L_FROST_L')} 100%)`,
  'violet to teal at the default hue runs the violet swatch into the teal one, as the brief asks')
assert.equal(evaluate('JP2L_SWATCHES[1].hue'), 248, 'and 248 is the violet swatch the panel offers')
const sunset = rgbasIn(lookAt('sunset', 170).background)
assert.equal(sunset.length, 2, 'sunset is a two-stop gradient as well')
assert.ok(sunset[0][0] > sunset[0][2], 'and its first stop is warm: more red than blue')
assert.notDeepEqual(sunset, rgbasIn(lookAt('violet', 170).background), 'which is not the violet one')
const monoA = String(lookAt('mono', 170).background)
assert.equal(String(lookAt('mono', 300).background), monoA, 'mono ignores the hue entirely: greys at every setting')
assert.equal(rgbasIn(lookAt('mono', 170).background).every(stop => Math.max(...stop) - Math.min(...stop) <= 10), true,
  'and it really is neutral: no channel stands out of the three')
const backgrounds = ['teal', 'violet', 'sunset', 'mono'].map(id => String(lookAt(id, 170).background))
assert.equal(new Set(backgrounds).size, 4, 'the four presets are four different frames')
const edges = ['teal', 'violet', 'sunset', 'mono'].map(id => String(lookAt(id, 170).edge))
assert.equal(new Set(edges.slice(0, 3)).size, 1,
  'the teal, violet and sunset frames all wear the chosen hue on their border and glow')
assert.notEqual(edges[3], edges[0], 'and mono is the neutral one: a grey border and glow')
assert.equal(evaluate('JP2L_GRADIENTS.map(item => item.id).join(",")'), 'teal,violet,sunset,mono',
  'the four the panel offers, in the order it offers them')
console.log('jackpot2 look: four gradients, four looks, flat teal by default and mono hue-blind: passed')

// ---- every value through the shelf's own drawer -------------------------------
const store = {}
sandbox.lookCtx = { storage: { get: (key, fallback) => (key in store ? store[key] : fallback), set: (key, value) => { store[key] = value } } }
// The offsets are gone (review, 2026-11-12): a copy in a slot has a place, so a stored 'jackpot2.posx'
// is simply not read — old values in a drawer must not move anything.
store['jackpot2.posx'] = 0.5
store['jackpot2.posy'] = -0.25
store['jackpot2.hue'] = '300'
store['jackpot2.gradient'] = 'sunset'
evaluate('jp2LAdopt(lookCtx)')
assert.equal(evaluate('typeof JP2L_STORE.posx'), 'undefined', 'a stored left-right is not read at all')
assert.equal(evaluate('typeof JP2L_STORE.posy'), 'undefined', 'and neither is the up-down')
assert.equal(evaluate('JP2L_STORE.hue'), 300, 'a stored hue as a string is read as a number')
assert.equal(evaluate('JP2L_STORE.gradient'), 'sunset', 'and the stored gradient')

evaluate('jp2LSetHue(275, lookCtx)')
assert.equal(store['jackpot2.hue'], 275, 'the hue saves under jackpot2.hue')
evaluate('jp2LSetGradient("violet", lookCtx)')
assert.equal(store['jackpot2.gradient'], 'violet', 'the gradient under jackpot2.gradient')
evaluate('jp2LSetHue(999, lookCtx)')
assert.equal(store['jackpot2.hue'], 360, 'a hue past the end of the slider stops at the end')
evaluate('jp2LSetHue(-20, lookCtx)')
assert.equal(store['jackpot2.hue'], 0, 'and one before the start stops at the start')
evaluate('jp2LSetGradient("plaid", lookCtx)')
assert.equal(store['jackpot2.gradient'], 'teal', 'a gradient that is not one of the four falls back to the default')

// A drawer holding nonsense: the copy must land at the centre in the teal, never at a value the
// geometry cannot honour.
const bad = { 'jackpot2.posx': 'left', 'jackpot2.posy': {}, 'jackpot2.hue': 'teal', 'jackpot2.gradient': 'plaid' }
sandbox.badCtx = { storage: { get: (key, fallback) => (key in bad ? bad[key] : fallback), set: (key, value) => { bad[key] = value } } }
evaluate('jp2LAdopt(badCtx)')
assert.equal(evaluate('typeof JP2L_STORE.posx'), 'undefined', 'a word where a position belongs moves nothing')
assert.equal(evaluate('JP2L_STORE.hue'), 170, 'and a word where a hue belongs is the cabinet\'s own teal')
assert.equal(evaluate('JP2L_STORE.gradient'), 'teal', 'with the default gradient')
console.log('jackpot2 look: every value round-trips through ctx.storage, and nonsense falls back to the default: passed')

// ---- the tint touches the frame and nothing else ------------------------------
// A tint that is actually on: at the default the rule is not emitted at all (nothing is painted).
const sheet = String(evaluate('jp2LStyleRules(jp2LTint("teal", 248))'))
assert.ok(!String(evaluate('jp2LStyleRules(jp2LTint())')).includes('--jp2-tint'),
  'at the default the stylesheet carries no tint rule, so the cabinet is untouched')
const painting = sheet.split('}').map(part => part.trim()).filter(Boolean).filter(part => part.includes('--jp2-tint'))
assert.equal(painting.length, 1, 'exactly one rule paints the tint')
assert.equal(painting[0].split('{')[0].trim(), '[data-jp2-stage][data-jp2-tint] .jp2-machine',
  'and it names the cabinet\'s root element, inside our own stage, and nothing under it: the reels and the symbol art keep their colours')
assert.ok(/background:\s*var\(--jp2-tint-bg\)/.test(painting[0]), 'the frost is the tint variable')
assert.ok(/border-color:\s*var\(--jp2-tint-edge\)/.test(painting[0]), 'the border is the tint variable')
assert.ok(/box-shadow:[^;]*var\(--jp2-tint-glow\)/.test(painting[0]), 'the glow is the tint variable')
assert.equal(/filter\s*:/.test(sheet), false, 'no filter is used anywhere: a filter on the cabinet would recolour its art')
assert.equal(/hue-rotate|saturate|grayscale|sepia/.test(sheet), false, 'and none of the filter functions that recolour an element')
assert.equal(/text-shadow/.test(sheet), false, 'the text shadow stays the cabinet\'s own, which is what keeps the words readable')

evaluate('jp2LSetHue(248, lookCtx)')
const stage = evaluate(`jp2LStage(lookCtx, { scale: 1 }, 'overlay')`)
const stageNode = nodes(stage).find(node => node.props && node.props['data-jp2-stage'] === '1')
const cabinet = nodes(stage).find(node => node.type && typeof node.type === 'function' && node.type.name === 'JackpotMachine')
assert.ok(cabinet, 'the stage still holds the cabinet')
assert.equal(cabinet.props.ctx, sandbox.lookCtx, 'handed the same context it always was')
assert.equal(cabinet.props.mode, 'overlay', 'in overlay mode, as the layer always drew it')
assert.deepEqual(Object.keys(plain(cabinet.props)).sort(), ['ctx', 'mode'],
  'and nothing else: the tint hands the cabinet no prop at all, so its frame is the only thing that changes')
assert.equal(evaluate('jp2LTint().active'), true, 'with a hue set, the tint is on')
assert.equal(stageNode.props.style['--jp2-tint-bg'], evaluate('jp2LTintVars()')['--jp2-tint-bg'],
  'the tint rides on the stage as the three CSS values the one rule reads')
assert.deepEqual(plain(Object.keys(evaluate('jp2LTintVars()'))), ['--jp2-tint-bg', '--jp2-tint-edge', '--jp2-tint-glow'],
  'three values, all of them colours: nothing that can affect the art')
const fullStage = evaluate(`jp2LStage(lookCtx, { scale: 1 }, 'full')`)
assert.equal(nodes(fullStage).find(node => node.props && node.props['data-jp2-stage'] === '1').props['data-jp2-tint'], undefined,
  'the full view on the Games page is the cabinet\'s own drawing, untinted')
console.log('jackpot2 look: one rule on the cabinet\'s root, no filter, no text shadow, the art untouched: passed')

// ---- the place is the slot's, and the fit follows the share --------------------
// The offsets are gone with the overlay they moved the copy across. What is left is the one rule the
// copy is sized by, and it is a rule about the slot it is given: a narrower share is a smaller machine.
evaluate('jp2LSetHue(170, lookCtx)')
const fitWide = evaluate('jp2LSlotScale(760, 1)')
const fitHalf = evaluate('jp2LSlotScale(380, 1)')
const fitNarrow = evaluate('jp2LSlotScale(190, 1)')
assert.equal(fitWide, fitHalf, 'a share wider than the strip budget stops growing the copy: it is height-capped')
assert.ok(fitHalf > fitNarrow, `and below that, a narrower share is a smaller copy (${fitHalf} > ${fitNarrow})`)
assert.ok(720 * fitHalf <= evaluate('OVERCHAT_MAX_HEIGHT') + 0.5, 'never taller than the strip budget')
assert.ok(560 * fitNarrow <= 190 + 0.5, 'and never wider than the share it was given')
assert.equal(evaluate('jp2LSlotScale(0, 1)'), 0, 'with no share there is nothing to draw')
console.log('jackpot2 look: the copy is sized by its share of the slot, and nothing else: passed')

// ---- the panel keeps its footprint --------------------------------------------
// Measured in a real browser against this repo's own QA pane (headless Chrome, the pane's Slots tile):
// the cabinet's content column is a flex column inside a machine that is exactly 720 px tall, so a
// taller panel is paid for out of the REEL WINDOW — the first cut of this feature added 89 px and took
// the window from its design 312 px down to 222 px, cutting the bottom row of the drum off the screen.
// One row per setting is what keeps that from happening: four single-line rows leave the panel 100 px
// tall (304 px window → the full 312 px) against 104 px before Position and Colour existed. That
// structure is pinned here rather than merely intended: a fifth row would show up as a failure.
const panelFor = tone => evaluate(`Jackpot2OverChatControls(${tone === 'cabinet' ? 'panelProps' : 'panelSettingsProps'})`)
sandbox.panelProps = { ctx: sandbox.lookCtx, tone: 'cabinet' }
sandbox.panelSettingsProps = { ctx: sandbox.lookCtx, tone: 'settings' }
const cabinetPanel = panelFor('cabinet')
const rows = nodes(cabinetPanel).find(node => node.props && node.props['data-jp2-oc'] === 'controls').props.children.filter(Boolean)
assert.equal(rows.length, 3, 'the cabinet panel is three rows: the switch, then one row per setting')
assert.equal(rows[0].props['data-jp2-oc'], 'switch-row', 'the switch and Reset look share the first row')
assert.ok(rows.slice(1).every(row => row.type === 'label'), 'and each setting is one row of its own')
assert.equal(nodes(cabinetPanel).some(node => node.props && node.props['data-jp2-oc'] === 'why'), false,
  'with no why line inside the cabinet: there is no room for one that does not cost the reels')
for (const key of ['alpha', 'size', 'hue']) {
  assert.ok(nodes(cabinetPanel).some(node => node.props && node.props['data-jp2-oc-range'] === key), `the cabinet panel still offers the ${key} slider`)
}
assert.ok(!nodes(cabinetPanel).some(node => node.props && node.props['data-jp2-oc-range'] === 'posx'),
  'and no left-right slider: the slot owns the place')
assert.equal(nodes(cabinetPanel).filter(node => node.props && node.props['data-jp2-oc-swatch']).length, 6, 'and all six swatches')
assert.ok(nodes(cabinetPanel).some(node => node.props && node.props['data-jp2-oc-select'] === 'gradient'), 'and the gradient choice')
const namedButtons = nodes(cabinetPanel)
  .filter(node => node.type === 'button' && typeof node.props.children === 'string')
  .map(node => node.props.children).sort()
assert.deepEqual(plain(namedButtons), ['Reset look'],
  'and both buttons say what they are — an empty button is a defect the panel layout hides')
assert.ok(words(rows[1]).includes('See-through') && words(rows[1]).includes('Size'),
  `both sliders on the shared row keep their name (${words(rows[1]).trim()})`)
assert.ok(words(rows[2]).includes('Colour') && words(rows[2]).includes('Teal (current)'),
  `the colour row names the setting and the gradient (${words(rows[2]).trim()})`)
assert.ok(words(rows[2]).includes(`${evaluate('jp2LTint().hue')}°`),
  'and reads the hue that is actually set')
const settingsPanel = panelFor('settings')
assert.ok(nodes(settingsPanel).some(node => node.props && node.props['data-jp2-oc'] === 'why'),
  'Settings keeps the why line, where there is room for it')
console.log('jackpot2 look: one single-line row per setting, so the cabinet panel costs the reels nothing: passed')

console.log('jackpot2 look harness: passed')
console.log('DONE')
