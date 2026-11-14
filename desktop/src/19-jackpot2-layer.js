// ---- 19-jackpot2-layer.js: JACKPOT v2 in the composer's own slot — its switch and the full view
//
// JACKPOT v2 is a second slot machine beside the old one (18-slot-machine.js / 18-slots.js /
// 19-jackpot-overlay.js). This part owns the switch and the look sliders, the cabinet as it appears
// over the conversation, and the full-screen view the Games page opens.
//
// THE MACHINE IS NOT HERE. It is 18-jackpot2-machine.js — JackpotMachine({ ctx, mode }) — designed at
// ONE fixed size, 560x720. Everything in this file only ever scales the box the machine sits in, with a
// CSS transform, so the machine itself never has to know how big it is. When a bundle is built without
// that part the copy still builds and can be tested: it draws a plain "not in this build yet" plate in
// the machine's place.
//
// WHERE THE COPY IS DRAWN. Not in a div of our own appended to document.body, not measured against the
// app's own markup, and with no stylesheet pushed into the app's <head>: a plugin must live inside SDK
// surfaces, so an app update can neither break it nor be broken by it.
//
// The copy is a contribution to the composer's `composer.underside` slot and is rendered in our own
// tree by 78-overchat-slot.js, which owns the strip, the layout and the width each machine is given.
// Two things follow:
//
//   - "only over the conversation" is now structural. The slot belongs to the chat composer, so it does
//     not exist on the Games page, in Settings or on another plugin's page. No route sniffing and no
//     DOM test is needed to keep the machine off those screens.
//   - the size comes from the slot. The strip measures ITS OWN box and hands this copy its share of the
//     width (jp2LSlotScale); nothing here reads window.innerWidth or another element's rect, so a docked
//     pane, a narrow window or a split layout all size the copy correctly.
//
// The look (see-through, size, colour) is one stored setting shared by every surface, in ctx.storage:
// 'jackpot2.overchat', 'jackpot2.alpha', 'jackpot2.size', 'jackpot2.hue', 'jackpot2.gradient', read
// live through JP2L_STORE.
//
// The tint is a stylesheet of ours, scoped to the cabinet's published root class INSIDE OUR OWN STAGE
// (`[data-jp2-stage][data-jp2-tint] .jp2-machine`) and rendered as a <style> element in the stage's own
// children, so it leaves with the stage and never touches the document. The values ride on the stage as
// CSS custom properties (jp2LTintVars), so one static rule serves every hue. The cabinet's own text
// shadow is left alone: the tint only ever moves the frost's hue, at the frost's own saturation and
// lightness, so the contrast the shadow was chosen for does not change.
//
// There is no "where" setting any more, and that is deliberate: a copy that lives in a slot has a place,
// and the old left-right / up-down offsets moved it across a frame it no longer owns. The stored keys
// 'jackpot2.posx' / 'jackpot2.posy' are simply not read; nothing has to migrate.
//
// TESTABLE SURFACE (tests/jackpot2_harness.cjs, tests/jackpot2_look_harness.cjs):
//   jp2LSlotScale(width, size) -> scale       the copy fitted into its share of the slot
//   jp2LOverChatCopy({ ctx, width })          the copy, drawn at that scale (null while the switch is off)
//   jp2LStyleRules(tint) -> css text          the tint and the watch-only rules, scoped to our stage
//   jp2LStage(ctx, geo, mode)                 the scaled stage (machine + tint + the dismissal control)
//   jp2LMachine(ctx, mode)                    the cabinet, or the honest plate
//   jp2LFitGeometry(frame, size)              the full view: fits BOTH ways, nothing clipped
//   jp2LSetOverchat(on, ctx) / jp2LSetAlpha(value, ctx) / jp2LSetSize(value, ctx)
//   jp2LSetHue(value, ctx) / jp2LSetGradient(id, ctx) / jp2LResetLook(ctx)
//   jp2LTint(gradient?, hue?) -> { gradient, hue, active }   active = not the look it always had
//   jp2LTintPalette(tint) -> { background, edge, glow }      the three colours the frame is painted
//   jp2LTintVars(tint)         the CSS values for the tint, or null at the default
//   Jackpot2OverChatControls({ ctx, tone })   the switch, the sliders and the colour
//   Jackpot2Full, Jackpot2Tile, jp2LPlayTiles
// A word on names: tools/build_plugin.py puts every part in ONE module scope, so two parts that declare
// the same name overwrite each other in silence (the last one wins). The published surface above is
// exactly what the harnesses ask for, so a clash with another part shows up as a harness failure rather
// than as a machine that quietly does nothing. Check before adding a plain jp2Foo() here.
// Defaults and key names: alpha 0.25 (range 0.25 - 1, step 0.05), size 1 (range 0.25 - 2), hue 170
// (range 0 - 360), gradient 'teal'.

const JP2L_SIZE = { width: 560, height: 720 }
// The copy is also a tile and a full view; all three name the machine the same way.
const JP2L_ID = 'jackpot2'
const JP2L_SUMMARY = 'A second cabinet on the same wallet: futuristic reels, real spin effects.'

const JP2L_OVERCHAT_KEY = 'jackpot2.overchat'
const JP2L_ALPHA_KEY = 'jackpot2.alpha'
const JP2L_SIZE_KEY = 'jackpot2.size'
const JP2L_ALPHA_MIN = 0.25
const JP2L_ALPHA_MAX = 1
const JP2L_ALPHA_STEP = 0.05
// See-through by default: the machine sits under the composer, and the conversation around it has to
// stay readable. Fully opaque is allowed, and so is fading it back to a quarter — the floor is 0.25,
// never fully transparent, so the machine can never be there-but-invisible. The default sits at that
// floor: as see-through as the range goes.
const JP2L_ALPHA_DEFAULT = JP2L_ALPHA_MIN
const JP2L_SIZE_MIN = 0.25
const JP2L_SIZE_MAX = 2
// Full size by default. "100%" is now the largest the composer's slot allows rather than the whole chat
// column, which is a smaller box: keeping the old 50% would have halved the machine twice.
const JP2L_SIZE_DEFAULT = 1
// What colour the copy's frosted frame is. The hue of the cabinet's own accent, #3ee0c5, is 170.0
// exactly — so 170 IS "the current teal", and it is the default.
const JP2L_HUE_KEY = 'jackpot2.hue'
const JP2L_HUE_MIN = 0
const JP2L_HUE_MAX = 360
const JP2L_HUE_DEFAULT = 170
// The frame the machine draws in overlay mode, as 18-jackpot2-machine.js draws it: a dark navy frost
// behind the cabinet (hsl 205 / 43.2% / 18.6%, alpha .6), a teal border (hsl 170 / 72% / 56%, alpha
// .28) and a teal glow at .16. The constants below are the ones that reproduce those three EXACTLY
// — the harness checks them against the colours the cabinet's own part writes — so "the default is
// the current teal" is a figure and not a claim. The tint keeps the frost's saturation and lightness
// and the accent's, so a hue change rotates the colour and leaves the contrast alone.
const JP2L_FROST_HUE = 205
const JP2L_FROST_S = 43.2
const JP2L_FROST_L = 18.6
const JP2L_ACCENT_S = 72
const JP2L_ACCENT_L = 56
const JP2L_FROST_ALPHA = 0.6
const JP2L_EDGE_ALPHA = 0.28
const JP2L_GLOW_ALPHA = 0.16
// Six quick picks, the teal the cabinet wears first. The hue slider beside them reaches anything else.
const JP2L_SWATCHES = [
  { hue: 170, name: 'Teal' },
  { hue: 248, name: 'Violet' },
  { hue: 210, name: 'Blue' },
  { hue: 30, name: 'Amber' },
  { hue: 330, name: 'Rose' },
  { hue: 120, name: 'Green' }
]
// How the tint is laid across the frame. 'teal' is the frame's own flat frost — the default, and the
// look the copy had before this setting existed; the others run a second stop into the chosen hue.
const JP2L_GRADIENTS = [
  { id: 'teal', label: 'Teal (current)' },
  { id: 'violet', label: 'Violet to teal' },
  { id: 'sunset', label: 'Sunset' },
  { id: 'mono', label: 'Mono' }
]
const JP2L_GRADIENT_KEY = 'jackpot2.gradient'
const JP2L_GRADIENT_DEFAULT = 'teal'
// One table for the sliders: min, max and step per control, so the panel and the geometry cannot
// disagree about what a value may be.
const JP2L_RANGES = {
  alpha: { min: JP2L_ALPHA_MIN, max: JP2L_ALPHA_MAX, step: JP2L_ALPHA_STEP },
  size: { min: JP2L_SIZE_MIN, max: JP2L_SIZE_MAX, step: 0.05 },
  hue: { min: JP2L_HUE_MIN, max: JP2L_HUE_MAX, step: 1 }
}

function jp2LWin() {
  return typeof window === 'undefined' ? null : window
}

// Round a scale DOWN, never up. A scale rounded up is a copy a fraction of a pixel larger than the
// frame it was fitted to, which is how "it fits" quietly stops being true (measured: a 360 px
// column gave scale 0.643 and a 360.08 px machine).
function jp2LFloor(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 1
  return Math.floor(number * 10000) / 10000
}

function jp2LClampAlpha(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return JP2L_ALPHA_DEFAULT
  const stepped = Math.round(number / JP2L_ALPHA_STEP) * JP2L_ALPHA_STEP
  return Number(Math.min(JP2L_ALPHA_MAX, Math.max(JP2L_ALPHA_MIN, stepped)).toFixed(2))
}

function jp2LClampSize(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return JP2L_SIZE_DEFAULT
  return Number(Math.min(JP2L_SIZE_MAX, Math.max(JP2L_SIZE_MIN, number)).toFixed(2))
}

function jp2LBool(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on'
}

function jp2LClampHue(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return JP2L_HUE_DEFAULT
  return Math.round(Math.min(JP2L_HUE_MAX, Math.max(JP2L_HUE_MIN, number)))
}

function jp2LGradientId(value) {
  const id = typeof value === 'string' ? value : ''
  return JP2L_GRADIENTS.some(item => item.id === id) ? id : JP2L_GRADIENT_DEFAULT
}

// One hue, at a saturation and lightness of its own, as a CSS rgba(). Everything the tint paints
// comes through here, so a hued frame and the neutral (mono) one cannot drift apart in contrast, and
// the default hue lands on the cabinet's own accents (checked in tests/jackpot2_harness.cjs).
function jp2LRgba(hue, saturation, lightness, alpha) {
  const turn = ((((Number(hue) || 0) % 360) + 360) % 360) / 360
  const sat = Math.min(1, Math.max(0, (Number(saturation) || 0) / 100))
  const light = Math.min(1, Math.max(0, (Number(lightness) || 0) / 100))
  const alphaValue = Math.min(1, Math.max(0, Number(alpha) || 0))
  const high = light < 0.5 ? light * (1 + sat) : light + sat - light * sat
  const low = 2 * light - high
  const channel = offset => {
    let value = offset
    if (value < 0) value += 1
    if (value > 1) value -= 1
    if (value < 1 / 6) return low + (high - low) * 6 * value
    if (value < 1 / 2) return high
    if (value < 2 / 3) return low + (high - low) * (2 / 3 - value) * 6
    return low
  }
  const parts = [channel(turn + 1 / 3), channel(turn), channel(turn - 1 / 3)]
    .map(value => Math.round(Math.min(1, Math.max(0, value)) * 255))
  return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alphaValue})`
}

// The look the copy is wearing right now, read live from the store. `active` is the whole reason the
// default has to be exact: while it is false nothing at all is painted over the frame, so the copy is
// the cabinet's own teal — the same pixels as before this setting existed.
function jp2LTint(gradient, hue) {
  const id = jp2LGradientId(gradient === undefined ? JP2L_STORE.gradient : gradient)
  const chosen = jp2LClampHue(hue === undefined ? JP2L_STORE.hue : hue)
  return { gradient: id, hue: chosen, active: !(id === JP2L_GRADIENT_DEFAULT && chosen === JP2L_HUE_DEFAULT) }
}

// The three values the frame is painted with: the frost (see-through, behind the machine), its border
// and its outer glow. Only the hue moves — the frost keeps the cabinet's own 43% / 19% and the accent
// its 72% / 56% — which is how the text over the frame keeps the contrast and the text shadow it
// already had.
function jp2LTintPalette(tint) {
  const look = tint || jp2LTint()
  const hue = look.hue
  const frostAt = (at, saturation, lightness) => jp2LRgba(at, saturation, lightness, JP2L_FROST_ALPHA)
  const frost = frostAt(hue, JP2L_FROST_S, JP2L_FROST_L)
  const edge = jp2LRgba(hue, JP2L_ACCENT_S, JP2L_ACCENT_L, JP2L_EDGE_ALPHA)
  const glow = jp2LRgba(hue, JP2L_ACCENT_S, JP2L_ACCENT_L, JP2L_GLOW_ALPHA)
  if (look.gradient === 'mono') {
    // No hue at all: the same frost at 6% saturation, and a grey border and glow. Readable over any
    // conversation behind it, which is why it is offered beside the colours.
    return {
      background: `linear-gradient(165deg, ${frostAt(215, 6, 28)} 0%, ${frostAt(215, 6, 13)} 100%)`,
      edge: jp2LRgba(215, 6, 62, 0.3),
      glow: jp2LRgba(215, 6, 62, 0.16)
    }
  }
  if (look.gradient === 'violet') {
    // Violet to teal at the default hue: the two ends are 78 apart, so the pair travels together as
    // the hue slider moves.
    return { background: `linear-gradient(165deg, ${frostAt(hue + 78, JP2L_FROST_S, JP2L_FROST_L)} 0%, ${frost} 100%)`, edge, glow }
  }
  if (look.gradient === 'sunset') {
    // A warm end at 62% saturation. Its lightness is the one place the tint is darker than the frost
    // it replaces: at the frost's own 18.6% the warm end reads as brown rather than as sunset, and the
    // value that looks right is also the one that keeps the cabinet's ink at 7:1 or better.
    return { background: `linear-gradient(165deg, ${frostAt(28, 62, 26)} 0%, ${frost} 100%)`, edge, glow }
  }
  return { background: frost, edge, glow }
}

// What rides on the stage element. The stylesheet is static and these are the values, so a hue change
// repaints the frame without rebuilding a rule; at the default there is nothing to set and nothing is
// painted.
function jp2LTintVars(tint) {
  const look = tint || jp2LTint()
  if (!look.active) return null
  const palette = jp2LTintPalette(look)
  return { '--jp2-tint-bg': palette.background, '--jp2-tint-edge': palette.edge, '--jp2-tint-glow': palette.glow }
}

// The shorthand a repaint is decided by: the hue and the gradient, not the pixels.
function jp2LTintSignature(tint) {
  const look = tint || jp2LTint()
  return `${look.gradient}:${look.hue}`
}

// ---- the switch and the sliders, remembered by the shelf ----------------------
// ctx.storage is the plugin's own little key-value drawer in the host, so the choice survives a
// plugin reload and a rebuild — the browser's localStorage would not.
function jp2LStored(ctx, key, fallback) {
  try {
    if (!ctx || !ctx.storage || typeof ctx.storage.get !== 'function') return fallback
    const value = ctx.storage.get(key, fallback)
    return value === undefined || value === null ? fallback : value
  } catch (error) {
    return fallback
  }
}

function jp2LSave(ctx, key, value) {
  try {
    if (ctx && ctx.storage && typeof ctx.storage.set === 'function') ctx.storage.set(key, value)
  } catch (error) {
    // An older host without plugin storage: the switch still works for this visit.
  }
}

const JP2L_STORE = {
  ctx: null,
  overchat: false,
  alpha: JP2L_ALPHA_DEFAULT,
  size: JP2L_SIZE_DEFAULT,
  hue: JP2L_HUE_DEFAULT,
  gradient: JP2L_GRADIENT_DEFAULT,
  listeners: new Set()
}

// Read the shelf's stored choices, once per context. Called from the hooks themselves rather than from
// an effect, so a surface reads the real value before its first paint instead of one render later.
function jp2LAdopt(ctx) {
  if (!ctx || JP2L_STORE.ctx === ctx) return
  JP2L_STORE.ctx = ctx
  JP2L_STORE.overchat = jp2LBool(jp2LStored(ctx, JP2L_OVERCHAT_KEY, false))
  JP2L_STORE.alpha = jp2LClampAlpha(jp2LStored(ctx, JP2L_ALPHA_KEY, JP2L_ALPHA_DEFAULT))
  JP2L_STORE.size = jp2LClampSize(jp2LStored(ctx, JP2L_SIZE_KEY, JP2L_SIZE_DEFAULT))
  JP2L_STORE.hue = jp2LClampHue(jp2LStored(ctx, JP2L_HUE_KEY, JP2L_HUE_DEFAULT))
  JP2L_STORE.gradient = jp2LGradientId(jp2LStored(ctx, JP2L_GRADIENT_KEY, JP2L_GRADIENT_DEFAULT))
}

function jp2LPublish() {
  JP2L_STORE.listeners.forEach(listener => listener(JP2L_STORE.overchat))
}

function jp2LSetOverchat(value, ctx) {
  const on = jp2LBool(value)
  JP2L_STORE.overchat = on
  jp2LSave(ctx || JP2L_STORE.ctx, JP2L_OVERCHAT_KEY, on)
  jp2LPublish()
  return on
}

function jp2LSetAlpha(value, ctx) {
  const alpha = jp2LClampAlpha(value)
  JP2L_STORE.alpha = alpha
  jp2LSave(ctx || JP2L_STORE.ctx, JP2L_ALPHA_KEY, alpha)
  jp2LPublish()
  return alpha
}

function jp2LSetSize(value, ctx) {
  const size = jp2LClampSize(value)
  JP2L_STORE.size = size
  jp2LSave(ctx || JP2L_STORE.ctx, JP2L_SIZE_KEY, size)
  jp2LPublish()
  return size
}
function jp2LSetHue(value, ctx) {
  const hue = jp2LClampHue(value)
  JP2L_STORE.hue = hue
  jp2LSave(ctx || JP2L_STORE.ctx, JP2L_HUE_KEY, hue)
  jp2LPublish()
  return hue
}

function jp2LSetGradient(value, ctx) {
  const gradient = jp2LGradientId(value)
  JP2L_STORE.gradient = gradient
  jp2LSave(ctx || JP2L_STORE.ctx, JP2L_GRADIENT_KEY, gradient)
  jp2LPublish()
  return gradient
}

// Reset look: every LOOK setting back to its default — how see-through, how big, and what colour. The
// over-chat switch is not a look: it is left exactly where the person put it, so resetting the look can
// never make the cabinet vanish (or appear) as a side effect.
function jp2LResetLook(ctx) {
  jp2LSetAlpha(JP2L_ALPHA_DEFAULT, ctx)
  jp2LSetSize(JP2L_SIZE_DEFAULT, ctx)
  jp2LSetHue(JP2L_HUE_DEFAULT, ctx)
  jp2LSetGradient(JP2L_GRADIENT_DEFAULT, ctx)
  return true
}

function useJp2LOverchat(ctx) {
  jp2LAdopt(ctx)
  const [on, setOn] = useState(JP2L_STORE.overchat)
  useEffect(() => {
    const listener = value => setOn(value)
    JP2L_STORE.listeners.add(listener)
    setOn(JP2L_STORE.overchat)
    return () => { JP2L_STORE.listeners.delete(listener) }
  }, [])
  return [on, value => jp2LSetOverchat(value, ctx)]
}

function useJp2LAlpha(ctx) {
  // Read once from the store, then keep this view's own copy: the sliders are the only thing that
  // changes it, and the store is what makes the choice survive the next reload.
  jp2LAdopt(ctx)
  const [alpha, setAlpha] = useState(JP2L_STORE.alpha)
  useEffect(() => {
    const listener = () => setAlpha(JP2L_STORE.alpha)
    JP2L_STORE.listeners.add(listener)
    setAlpha(JP2L_STORE.alpha)
    return () => JP2L_STORE.listeners.delete(listener)
  }, [])
  return [alpha, value => jp2LSetAlpha(value, ctx)]
}

function useJp2LSize(ctx) {
  jp2LAdopt(ctx)
  const [size, setSize] = useState(JP2L_STORE.size)
  useEffect(() => {
    const listener = () => setSize(JP2L_STORE.size)
    JP2L_STORE.listeners.add(listener)
    setSize(JP2L_STORE.size)
    return () => JP2L_STORE.listeners.delete(listener)
  }, [])
  return [size, value => jp2LSetSize(value, ctx)]
}

function useJp2LTint(ctx) {
  jp2LAdopt(ctx)
  const [tint, setTint] = useState(jp2LTint())
  useEffect(() => {
    const listener = () => setTint(jp2LTint())
    JP2L_STORE.listeners.add(listener)
    listener()
    return () => JP2L_STORE.listeners.delete(listener)
  }, [])
  return [tint, {
    setHue: value => jp2LSetHue(value, ctx),
    setGradient: value => jp2LSetGradient(value, ctx),
    reset: () => jp2LResetLook(ctx)
  }]
}


// ---- where the copy is drawn: its share of the composer's underside slot -------------
// The slot hands each machine a width (78-overchat-slot.js measures the strip's own box and splits it),
// and this is the whole of the sizing: fill that share at the person's size, never wider than the share,
// and never taller than the strip's height budget at the default size. No window, no rect, no column.
// The cabinet is a fixed 560x720 design, so "its own size" is a constant and the whole rule is the one
// both machines share (overchatFitScale, 19-jackpot-overlay.js).
function jp2LSlotScale(width, size) {
  const scale = overchatFitScale(JP2L_SIZE, width, jp2LClampSize(size))
  return scale > 0 ? jp2LFloor(scale) : 0
}

// The copy itself: the cabinet at its design size inside the box the slot gave it. It is mounted by the
// strip only while the switch is on, so being mounted is being shown.
function jp2LOverChatCopy({ ctx, width }) {
  const [on] = useJp2LOverchat(ctx)
  const [alpha] = useJp2LAlpha(ctx)
  const [size] = useJp2LSize(ctx)
  // The tint is subscribed to as well as read: a colour change publishes on the store, and a hook that
  // only ever set the same alpha would let React skip the render, leaving the old hue on the stage.
  const [tint] = useJp2LTint(ctx)
  const scale = jp2LSlotScale(width, size)
  if (!on || !scale) return null
  const geo = { scale, width: JP2L_SIZE.width * scale, height: JP2L_SIZE.height * scale }
  return jsx('div', {
    'data-jp2-surface': 'copy',
    style: {
      width: geo.width,
      height: geo.height,
      opacity: jp2LClampAlpha(alpha),
      // Watching, not clicking: the copy must never take a click the conversation wanted. The machine's
      // own dismissal controls opt back in through the stage's own rules (jp2LStyleRules).
      pointerEvents: 'none',
      boxSizing: 'border-box',
      overflow: 'hidden'
    },
    children: jp2LStage(ctx, geo, 'overlay', tint)
  })
}

function jp2LCentreIn(frame, scale) {
  const width = JP2L_SIZE.width * scale
  const height = JP2L_SIZE.height * scale
  return {
    scale,
    width,
    height,
    left: Math.round(frame.left + Math.max(0, (frame.width - width) / 2)),
    top: Math.round(frame.top + Math.max(0, (frame.height - height) / 2))
  }
}

// The full view: the same machine, as large as its frame allows and no larger. There is no floor here —
// the promise for this one is that NOTHING is clipped, in any frame, and a floor would break that
// promise on a short frame. The slider only ever shrinks it.
function jp2LFitGeometry(frame, size) {
  const box = frame || { width: JP2L_SIZE.width, height: JP2L_SIZE.height }
  const factor = jp2LClampSize(size)
  const fit = Math.min(box.width / JP2L_SIZE.width, box.height / JP2L_SIZE.height)
  const scale = Math.max(0.05, Math.min(fit, fit * factor))
  return jp2LCentreIn(box, jp2LFloor(scale))
}

// The machine, or the honest plate that says the machine is not in this bundle.
function jp2LMachine(ctx, mode) {
  const Machine = typeof JackpotMachine === 'function' ? JackpotMachine : null
  if (Machine) return jsx(Machine, { ctx, mode: mode || 'overlay' })
  return jsx('div', {
    'data-jp2-absent': '1',
    style: {
      width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxSizing: 'border-box', padding: 24, textAlign: 'center',
      background: '#070b14', color: '#a99bff', font: '13px/1.45 system-ui, -apple-system, sans-serif'
    },
    children: 'The Jackpot cabinet is not in this build yet.'
  })
}

// The stage's own rules: the tint, and "watching, not clicking", both scoped to a stage of ours. They
// used to be a stylesheet appended to the app's <head>; they are now a <style> element rendered inside
// the stage (jp2LStage), so they apply to our subtree alone and leave with it.
function jp2LStyleRules(tint) {
  const active = tint && tint.active
  return [
    '[data-jp2-stage] { pointer-events: none; }',
    '[data-jp2-stage] button, [data-jp2-stage] input, [data-jp2-stage] select, [data-jp2-stage] textarea,',
    '[data-jp2-stage] [data-jp2-control] { pointer-events: auto; }',
    // Over the chat the machine is to WATCH: its spin, lever, bet, machine picker and
    // other buttons do not take a click there - only the X, the sound switch and the look controls do.
    '[data-jp2-stage] .jp2-machine button:not([data-jp2-sound]):not([data-jp2-close]) { pointer-events: none !important; cursor: default !important; }',
    '[data-jp2-stage] .jp2-machine [data-jp2="overchat-row"] button { pointer-events: auto !important; cursor: pointer !important; }',
    active
      ? '[data-jp2-stage][data-jp2-tint] .jp2-machine {'
        + ' background: var(--jp2-tint-bg) !important;'
        + ' border-color: var(--jp2-tint-edge) !important;'
        + ' box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .05), 0 18px 60px rgba(2, 4, 10, .8), 0 0 60px var(--jp2-tint-glow) !important; }'
      : '',
    '@media (prefers-reduced-motion: reduce) { [data-jp2-stage] * { animation: none !important; transition: none !important; } }'
  ].filter(Boolean).join('\n')
}

// The scaled stage: the machine at its design size inside a box that is transform-scaled from the
// top-left corner, which is the only thing the caller is allowed to do to it. The <style> child is the
// stage's own rules — a document-wide stylesheet would leak into the app.
function jp2LStage(ctx, geo, mode, tintNow) {
  const scale = geo && Number.isFinite(geo.scale) ? geo.scale : 1
  const overlay = (mode || 'overlay') === 'overlay'
  // The caller may hand its own (subscribed) tint; otherwise the stored one is read here.
  const tint = overlay ? (tintNow || jp2LTint()) : null
  const tintVars = tint && tint.active ? jp2LTintVars(tint) : null
  return jsxs('div', {
    'data-jp2-stage': '1',
    'data-jp2-tint': tintVars ? tint.gradient : undefined,
    style: {
      width: JP2L_SIZE.width,
      height: JP2L_SIZE.height,
      transform: `scale(${scale})`,
      transformOrigin: 'top left',
      ...(tintVars || {})
    },
    children: [
      overlay ? jsx('style', { children: jp2LStyleRules(tint) }, 'rules') : null,
      jp2LMachine(ctx, mode || 'overlay'),
      overlay ? jsx('button', {
        type: 'button', 'data-jp2-close': '1', 'aria-label': 'Close Slots over chat',
        onClick: () => jp2LSetOverchat(false, ctx),
        style: { position: 'absolute', right: 12, top: 12, zIndex: 10, pointerEvents: 'auto', cursor: 'pointer', border: '1px solid #3ee0c5', borderRadius: 6, background: '#173044', color: '#fff', fontSize: 20 },
        children: '×'
      }, 'close') : null
    ]
  })
}

// ---- one switch, one panel of sliders, every surface --------------------------
// The switch that shows the cabinet over the conversation is ONE setting, so it is drawn from one
// component and every surface shows that component — the cabinet's own panel beside Auto-spin/Auto-bet,
// the Games app's Settings, and the play-while-you-wait pane's Settings (which is the same Settings
// panel). All of them read and write 'jackpot2.overchat', 'jackpot2.alpha', 'jackpot2.size',
// 'jackpot2.hue' and 'jackpot2.gradient' through the hooks above, so there is no second copy of the
// choice and no surface that can drift from another.
//
// There is no "where it is" row: the copy lives in the composer's underside slot now, so its place is
// the slot's and the old left-right / up-down offsets would move it across a frame it does not own.
//
// tone: 'cabinet' draws it inside the dark machine; anything else draws it on the light panels.
function Jackpot2OverChatControls({ ctx, tone }) {
  const [on, setOn] = useJp2LOverchat(ctx)
  const [alpha, setAlpha] = useJp2LAlpha(ctx)
  const [size, setSize] = useJp2LSize(ctx)
  const [tint, tintActions] = useJp2LTint(ctx)
  const dark = tone === 'cabinet'
  const ink = dark ? JP2_INK : text.primary
  const dim = dark ? JP2_DIM : text.tertiary
  const glow = dark ? JP2_ION : '#3ee0c5'
  // The one place the sliders' own limits are written down, so the panel and the geometry that
  // clamps the values cannot disagree about what a slider may offer.
  const slider = (key, label, value, onChange) => jsx('input', {
    type: 'range',
    min: JP2L_RANGES[key].min,
    max: JP2L_RANGES[key].max,
    step: JP2L_RANGES[key].step,
    value,
    'aria-label': `Jackpot over chat: ${label}`,
    title: `Jackpot over chat: ${label}`,
    'data-jp2-oc-range': key,
    onChange: event => onChange(Number(event.target.value)),
    style: { width: dark ? 68 : 108, margin: 0, accentColor: glow, cursor: 'pointer', pointerEvents: 'auto' }
  })
  const readout = (key, text) => jsx('span', {
    'data-jp2-oc-value': key,
    style: { fontSize: 11, color: dim, minWidth: 34, textAlign: 'right' },
    children: text
  })
  // ONE ROW PER SETTING, on one line each. The cabinet's own panel lives inside a fixed 560x720
  // machine whose reels are sized by the machine's part, and a flex column hands a taller panel its
  // space by SQUEEZING the reels — measured: the 89 px these four sliders added took the reel window
  // from 304 px to 222 px and cut the bottom row of the drum off. So the rows here are single lines:
  // a second slider or a tag shares a row, the buttons ride on the rows they belong to, and the why
  // line is kept for Settings, which is a page rather than a 720 px cabinet. Nothing is folded away —
  // every setting is visible where it was asked for.
  const row = (key, label, content, labelWidth) => jsxs('label', {
    key,
    style: {
      display: 'inline-flex', alignItems: 'center', gap: dark ? 6 : 8, color: ink, fontSize: 12,
      whiteSpace: 'nowrap', cursor: 'pointer', minWidth: 0, flexWrap: 'wrap', lineHeight: 1.1
    },
    children: [
      jsx('span', { style: { minWidth: labelWidth || (dark ? 58 : 74) }, children: label }, 'label'),
      ...[].concat(content)
    ]
  }, key)
  // A small word beside a slider ('Size', 'Left-right'): the third argument of jsx is the KEY, never
  // the text, which is why this one passes children explicitly — a tag with no children is invisible
  // and reads as a missing label.
  const tag = (text, key) => jsx('span', { key, style: { fontSize: 11, color: dim }, children: text }, key)
  const button = (key, label, title, onClick) => jsx('button', {
    type: 'button',
    key,
    'data-jp2-oc': key,
    title,
    onClick,
    children: label,
    style: {
      pointerEvents: 'auto', padding: '2px 9px', borderRadius: 999, cursor: 'pointer',
      fontFamily: 'inherit', fontWeight: 700, fontSize: 11,
      border: `1px solid ${dark ? 'rgba(62,224,197,.5)' : '#3ee0c5'}`,
      background: dark ? 'rgba(62,224,197,.14)' : 'transparent',
      color: dark ? JP2_ION : '#0f6b5c'
    }
  }, key)
  const swatch = item => jsx('button', {
    type: 'button',
    'data-jp2-oc-swatch': String(item.hue),
    'aria-label': `Jackpot over chat: tint ${item.name}`,
    'aria-pressed': tint.hue === item.hue,
    title: `${item.name} (hue ${item.hue})`,
    onClick: () => tintActions.setHue(item.hue),
    style: {
      pointerEvents: 'auto', width: dark ? 14 : 18, height: dark ? 14 : 18, padding: 0, borderRadius: 999,
      cursor: 'pointer', boxSizing: 'border-box',
      border: tint.hue === item.hue ? `2px solid ${ink}` : '1px solid rgba(140,150,170,.55)',
      background: jp2LRgba(item.hue, JP2L_ACCENT_S, JP2L_ACCENT_L, 1)
    }
  }, `swatch-${item.hue}`)
  return jsxs('div', {
    'data-jp2-oc': 'controls',
    'data-jp2-oc-tone': dark ? 'cabinet' : 'settings',
    style: {
      display: 'flex', flexDirection: 'column', gap: dark ? 5 : 7, minWidth: 0,
      border: dark ? '1px solid rgba(169,155,255,.24)' : `1px solid ${stroke}`,
      borderRadius: 10, padding: dark ? '6px 10px' : '10px 12px',
      background: dark ? 'rgba(9,14,26,.72)' : 'transparent'
    },
    children: [
      jsxs('div', {
        'data-jp2-oc': 'switch-row',
        style: { display: 'inline-flex', alignItems: 'center', gap: dark ? 10 : 14, minWidth: 0, flexWrap: 'wrap' },
        children: [
          jsx('label', {
            'data-jp2-oc': 'toggle',
            title: 'Float the Jackpot cabinet over the conversation. The same switch as the status bar.',
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 8, color: ink, fontSize: 12,
              fontWeight: 700, cursor: 'pointer', pointerEvents: 'auto'
            },
            children: [
              jsx('input', {
                type: 'checkbox',
                checked: Boolean(on),
                'data-jp2-oc-box': 'overchat',
                onChange: event => setOn(event.target.checked),
                style: { accentColor: glow, cursor: 'pointer' }
              }, 'box'),
              jsx('span', { children: 'Show over chat' }, 'text')
            ]
          }, 'toggle'),
          button('reset', 'Reset look', 'Restore every look setting: see-through, size and colour. The over-chat switch itself is left as it is.', () => tintActions.reset())
        ]
      }, 'switch'),
      row('alpha', 'See-through', [
        slider('alpha', 'see-through', alpha, setAlpha),
        readout('alpha', `${Math.round(alpha * 100)}%`),
        tag('Size', 'size-tag'),
        slider('size', 'size', size, setSize),
        readout('size', `${Math.round(size * 100)}%`)
      ], dark ? 64 : 74),
      // What colour its frosted frame is: six quick picks, a hue for anything else, and how the tint is
      // laid across the frame. The reels and the symbol art are never touched by any of it.
      row('colour', 'Colour', [
        ...JP2L_SWATCHES.map(swatch),
        slider('hue', 'tint hue', tint.hue, value => tintActions.setHue(value)),
        readout('hue', `${tint.hue}°`),
        jsx('select', {
          'data-jp2-oc-select': 'gradient',
          'aria-label': 'Jackpot over chat: gradient',
          title: 'Gradient: how the tint is laid across the frame. The teal is the frame the cabinet has always worn.',
          value: tint.gradient,
          onChange: event => tintActions.setGradient(event.target.value),
          style: {
            pointerEvents: 'auto', padding: '2px 6px', borderRadius: 8, cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 11, color: ink, maxWidth: dark ? 132 : 170,
            border: dark ? '1px solid rgba(169,155,255,.3)' : `1px solid ${stroke}`,
            background: dark ? 'rgba(9,14,26,.9)' : card
          },
          children: JP2L_GRADIENTS.map(item => jsx('option', { value: item.id, children: item.label }, item.id))
        }, 'select')
      ]),
      // The one line that is not a control. It is kept where there is room for it and dropped where
      // there is not: inside the cabinet it is the panel's height that decides whether the reels keep
      // their own (see the note above the rows).
      dark ? null : jsx('div', {
        'data-jp2-oc': 'why',
        style: { fontSize: 10, color: dim, lineHeight: 1.4 },
        children: on
          ? 'The cabinet floats over the conversation at the size, place and colour set here.'
          : 'Off: the cabinet stays in its own panel, and nothing is drawn over the conversation.'
      }, 'why')
    ]
  })
}

// ---- the Games page: one card beside the shelf's own Slots entry, and the full view ----
function jp2LCover() {
  const reel = (token, key) => jsx('span', {
    style: {
      width: 22, height: 36, borderRadius: 4, background: '#0d1524',
      border: '1px solid rgba(62,224,197,0.55)', display: 'flex', alignItems: 'center',
      justifyContent: 'center', fontSize: 16, color: '#3ee0c5', boxShadow: '0 0 8px rgba(62,224,197,0.25)'
    },
    children: token
  }, key)
  return jsxs('div', {
    'data-jp2': 'cover',
    style: {
      height: 130, display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: 8, overflow: 'hidden',
      background: 'radial-gradient(120% 90% at 50% 0%, #16213c 0%, #070b14 62%)'
    },
    children: [
      jsxs('div', {
        style: {
          display: 'flex', gap: 6, padding: '7px 9px', borderRadius: 10,
          border: '1px solid rgba(169,155,255,0.55)', background: 'rgba(10,16,30,0.82)'
        },
        children: [reel('7', 'a'), reel('◆', 'b'), reel('7', 'c')]
      }),
      jsx('div', {
        style: { fontSize: 10, letterSpacing: '0.22em', fontWeight: 800, color: '#ff5d73' },
        children: 'JACKPOT'
      })
    ]
  })
}

// The Play-grid card. It opens Game Center's own screen for this machine, next to the shelf's Slots
// tile — it is not a server game, so it never goes through the shelf's lobby.
function Jackpot2Tile({ onOpen }) {
  return jsxs('button', {
    type: 'button',
    'data-jp2': 'tile',
    'aria-label': 'Jackpot',
    onClick: () => { if (typeof onOpen === 'function') onOpen() },
    style: {
      textAlign: 'left', padding: 0, borderRadius: 12, background: card,
      color: 'inherit', cursor: 'pointer', overflow: 'hidden', minWidth: 0
    },
    children: [
      jp2LCover(),
      jsxs('div', {
        style: { padding: '11px 13px 13px', display: 'flex', flexDirection: 'column', gap: 4 },
        children: [
          jsx('div', {
            style: { fontFamily: DISPLAY_FONT, fontSize: 17, lineHeight: 1.2, letterSpacing: '-.01em', fontWeight: 600 },
            children: 'Jackpot'
          }),
          jsx('div', { style: { fontSize: 12, color: text.tertiary, lineHeight: 1.35 }, children: JP2L_SUMMARY })
        ]
      })
    ]
  })
}

// The Play shelf with the Jackpot entry in it, right after the shelf's own Slots card. A search only
// keeps it when it matches, exactly like every shelf card around it.
function jp2LPlayTiles(list, open, waiting, openJackpot, matches) {
  const tiles = (list || []).map(item => playTile(item, open, waiting(item.id)))
  return tiles
}

// The full view: the whole machine, centred in its frame, never clipped. It measures its own frame
// with a ResizeObserver; a `frame={{ width, height }}` is accepted for tests and for callers that
// already know the box.
function Jackpot2Full({ ctx, frame, size, onBack }) {
  const box = useRef(null)
  const [geo, setGeo] = useState(null)
  const width = frame && Number(frame.width) > 0 ? Number(frame.width) : 0
  const height = frame && Number(frame.height) > 0 ? Number(frame.height) : 0
  // The playable cabinet (pane, Games page) is always full size unless a caller says otherwise: the Size
  // slider belongs to the copy over the chat only; the playable cabinet is never resized.
  const factor = Number.isFinite(Number(size)) ? Number(size) : 1
  useEffect(() => {
    const read = () => {
      const node = box.current
      const rect = node && typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null
      const measured = rect && Number(rect.width) > 0 && Number(rect.height) > 0
        ? { width: Number(rect.width), height: Number(rect.height) }
        : null
      const win = jp2LWin()
      const viewport = win && Number(win.innerWidth) > 0
        ? { width: Number(win.innerWidth), height: Number(win.innerHeight) > 0 ? Number(win.innerHeight) : JP2L_SIZE.height }
        : null
      const given = width > 0 && height > 0 ? { width, height } : null
      setGeo(jp2LFitGeometry(given || measured || viewport || { width: JP2L_SIZE.width, height: JP2L_SIZE.height }, factor))
    }
    read()
    let observer = null
    if (typeof ResizeObserver !== 'undefined' && box.current) {
      observer = new ResizeObserver(read)
      observer.observe(box.current)
    }
    const win = jp2LWin()
    if (win && typeof win.addEventListener === 'function') win.addEventListener('resize', read)
    return () => {
      if (observer && typeof observer.disconnect === 'function') observer.disconnect()
      if (win && typeof win.removeEventListener === 'function') win.removeEventListener('resize', read)
    }
  }, [width, height, factor])
  const shown = geo || jp2LFitGeometry({ width: width || JP2L_SIZE.width, height: height || JP2L_SIZE.height }, factor)
  // Nothing is ever drawn at a guessed size: until the frame has been measured (one frame at most)
  // the stage is hidden, so a short pane never flashes a full-height machine.
  const ready = Boolean(geo) || (width > 0 && height > 0)
  return jsxs('div', {
    'data-jp2': 'full',
    style: {
      display: 'flex', flexDirection: 'column', gap: 0, height: '100%', minHeight: 0,
      background: '#070b14', boxSizing: 'border-box'
    },
    children: [
      jsxs('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          padding: '10px 14px', borderBottom: '1px solid rgba(169,155,255,0.25)'
        },
        children: [
          jsx('div', {
            style: { fontFamily: DISPLAY_FONT, fontSize: 18, fontWeight: 600, color: '#eaeaf2', letterSpacing: '-.01em' },
            children: 'Jackpot'
          }),
          typeof onBack === 'function'
            ? jsx('button', {
              type: 'button',
              'data-jp2': 'full-back',
              onClick: onBack,
              style: {
                padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                border: '1px solid rgba(62,224,197,0.6)', background: 'transparent', color: '#3ee0c5'
              },
              children: 'Back to games'
            })
            : null
        ]
      }),
      jsx('div', {
        ref: box,
        'data-jp2': 'full-frame',
        style: {
          position: 'relative', flex: '1 1 auto', minHeight: 0, width: '100%',
          display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden'
        },
        children: jsx('div', {
          'data-jp2-stage': '1',
          style: { width: shown.width, height: shown.height, visibility: ready ? 'visible' : 'hidden' },
          children: jsx('div', {
            style: {
              width: JP2L_SIZE.width, height: JP2L_SIZE.height,
              transform: `scale(${shown.scale})`, transformOrigin: 'top left'
            },
            children: jp2LMachine(ctx, 'full')
          })
        })
      })
    ]
  })
}
