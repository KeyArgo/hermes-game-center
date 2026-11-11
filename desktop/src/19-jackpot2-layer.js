// ---- 19-jackpot2-layer.js: JACKPOT v2 over the chat — the layer, its switch and the full view
//
// JACKPOT v2 is a second slot machine beside the old one (18-slot-machine.js / 18-slots.js /
// 19-jackpot-overlay.js, which are NOT touched by this part). This part owns three things and no
// others: the see-through machine that floats over the conversation, the switch and sliders that
// turn it on and size it, and the full-screen view the Games page opens.
//
// THE MACHINE IS NOT HERE. It is 18-jackpot2-machine.js — JackpotMachine({ ctx, mode }) — designed
// at ONE fixed size, 560x720. Everything in this file only ever scales the box the machine sits in,
// with a CSS transform, so the machine itself never has to know how big it is. When a bundle is
// built without that part (the lanes are written side by side) the layer still builds, mounts and
// can be tested: it draws a plain "not in this build yet" plate in the machine's place.
//
// HOW THE MACHINE GETS INTO THE LAYER (worth reading before changing anything below). The layer is
// a plain div, created with document.createElement, appended to document.body at z-index
// 2147483000, click-through except for the machine's own controls — the way Aura mounts its
// backdrop. A div the app's React tree does not own can only be filled by react-dom, and a Hermes
// plugin cannot import it: tools/build_plugin.py and tests/test_plugin_bundle.py allow only
// @hermes/plugin-sdk, react and react/jsx-runtime, and the desktop loader refuses every other
// specifier at runtime. So jp2LDOMlib() looks for a host copy of react-dom and uses it when one
// exists (createRoot into the layer, or a portal), and when there is none — which is the shipped
// case — the status item draws the same machine as a fixed-position copy in our own tree.
//
// THE COPY MUST NOT DEPEND ON THE BODY DIV (owner's release blocker, 2026-11-11; the three
// independent analyses in .q/overchat-why/ agree on this). It used to: the numbers came out of
// jp2LApply(), which measured only after jp2LEnsureLayer() had created and appended the div — so a
// host where that div cannot be created, or where only the status item's own tree renders, drew
// NOTHING over the chat while the pane's own machine worked. Jackpot2StatusItem now measures the
// frame itself, exactly the way the OLD over-chat machine does (JP_chatColumn: the first textarea,
// then the first ancestor wider than half the window), and draws the cabinet as a position:fixed
// child of its own status span. No body node, no createRoot and no createPortal is needed for it to
// appear. The layer div is still created and removed by the switch, and when a host react-dom can
// fill it the machine is drawn there INSTEAD — one mounted machine, never two.
//
// TESTABLE SURFACE (tests/jackpot2_harness.cjs):
//   jp2LApply(ctx, on, { alpha, size, notify }) -> { on, node, geo, root }   create/remove + paint
//   jp2LLayerNode()            the div, or null while the switch is off
//   jp2LEnsureLayer()          create it now (idempotent)
//   jp2LRemoveLayer()          remove it now
//   jp2LFrame()                the box it floats over: the chat column, else the right third
//   jp2LOverlayGeometry(frame, size) -> { scale, width, height, left, top }; scale floored at 0.35
//   jp2LSharedGeometry(frame, size, shared)  the same numbers ASKED BY THE COPY: the frame it floats
//                              over, the size, and then the position offsets applied (0 = today)
//   jp2LPositioned(geo, frame) the offsets, clamped inside the frame and above the composer
//   jp2LComposerTop()          the top of the composer to keep clear of, or null when there is none
//   jp2LFitGeometry(frame, size)     -> the full view: fits BOTH ways, nothing clipped, no floor
//   jp2LSetOverchat(on, ctx) / jp2LSetAlpha(value, ctx) / jp2LSetSize(value, ctx)
//   jp2LSetPosition(x, y, ctx) / jp2LSetHue(value, ctx) / jp2LSetGradient(id, ctx) / jp2LResetLook(ctx)
//   jp2LTint(gradient?, hue?) -> { gradient, hue, active }   active = not the look it always had
//   jp2LTintPalette(tint) -> { background, edge, glow }      the three colours the frame is painted
//   jp2LTintVars(tint)         the CSS values for the tint, or null at the default
//   Jackpot2OverChatControls({ ctx, tone })   the switch, the sliders, the position and the colour
//   Jackpot2StatusItem, Jackpot2Full, Jackpot2Tile
// A word on names, because it has bitten this feature once already: tools/build_plugin.py puts every
// part in ONE module scope, so two parts that declare the same name overwrite each other in silence
// (the last one wins). The first cut of this part declared jp2Publish(), which the machine's part
// owns — the machine's own publish would have run this part's instead. The name is jp2LPublish now,
// and the published surface above is exactly what tests/jackpot2_harness.cjs asks for, so a clash
// with a later part shows up as a harness failure rather than as a machine that quietly does
// nothing. Check before adding a plain jp2Foo() here.
// Defaults and key names: alpha 0.7 (range 0.25 - 1, step 0.05), size 1 (range 0.5 - 2), position
// 0/0 (range -1 - 1, step 0.05), hue 170 (range 0 - 360), gradient 'teal', stored in ctx.storage as
// 'jackpot2.overchat', 'jackpot2.alpha', 'jackpot2.size', 'jackpot2.posx', 'jackpot2.posy',
// 'jackpot2.hue', 'jackpot2.gradient'. Every one of them is read live through JP2L_STORE, so a
// change is on screen without a reload.
//
// THE POSITION AND THE COLOUR (owner's ask, 2026-11-11) are both defined so their DEFAULT is exactly
// the copy as it was before they existed: offsets 0 hand back the very same geometry
// jp2LOverlayGeometry() answers (jp2LPositioned returns its argument untouched), and hue 170 is the
// teal the cabinet already wears — #3ee0c5 is hue 170 exactly. Only when one of them moves does the
// tint paint anything at all.
//
// The tint cannot be part of the machine: the cabinet is 18-jackpot2-machine.js, which this lane does
// not touch. So the tint is a stylesheet of our own (jp2LLayerStyle), scoped to the cabinet's
// published root class INSIDE OUR OWN STAGE — `[data-jp2-tint] .jp2-machine` — and it names the root
// element and nothing under it, which is what keeps the reels and the symbol art their own colours.
// The values ride on the stage element as CSS custom properties (jp2LTintVars), so the same static
// rule serves every hue. The cabinet's own text shadow is left alone: the tint only ever moves the
// frost's hue, at the frost's own saturation and lightness, so the contrast the shadow was chosen
// for does not change.

// The machine's one design size. The layer scales this box; it never resizes the machine.
const JP2L_SIZE = { width: 560, height: 720 }
// Above every piece of the app's own chrome (Aura's bar sits at 999998): the machine floats over
// the conversation, not inside a pane.
const JP2L_Z = 2147483000
// The floor from the shared interface: below this the cabinet is a smudge, not a machine.
const JP2L_MIN_SCALE = 0.35
// The frame is never allowed to be nothing. A zero-sized frame is the one shape that would make the
// copy invisible while every number "looks" fine (owner's release rule, 2026-11-11: it must never be
// zero-sized), so a frame smaller than this is measured as this instead.
const JP2L_MIN_FRAME = { width: 240, height: 200 }
// The layer is also a tile and a full view; all three name the machine the same way.
const JP2L_ID = 'jackpot2'
const JP2L_SUMMARY = 'A second cabinet on the same wallet: futuristic reels, real spin effects.'

const JP2L_OVERCHAT_KEY = 'jackpot2.overchat'
const JP2L_ALPHA_KEY = 'jackpot2.alpha'
const JP2L_SIZE_KEY = 'jackpot2.size'
const JP2L_ALPHA_MIN = 0.25
const JP2L_ALPHA_MAX = 1
const JP2L_ALPHA_STEP = 0.05
// See-through by default: the machine is over the conversation, and the conversation has to stay
// readable around it. Fully opaque is allowed, and so is fading it back to a quarter — the floor is
// 0.25, never fully transparent, so the machine can never be there-but-invisible (owner's release
// rule, 2026-11-11).
// As see-through as it goes by default (owner, 2026-11-11: "default see thru should be the most").
const JP2L_ALPHA_DEFAULT = JP2L_ALPHA_MIN
const JP2L_SIZE_MIN = 0.25
const JP2L_SIZE_MAX = 2
// Half size by default (owner, 2026-11-11: "default size should be 50%").
const JP2L_SIZE_DEFAULT = 0.5

// Where the copy floats: an offset from the place it has always had (centred over the chat column),
// never a coordinate, so the default is today's position on any frame and any window. -1 and +1 are
// the ends of the travel the frame allows, not a fixed distance: on a wide column the same slider
// position is a longer move than on a narrow one, and no slider position can push the copy out of the
// conversation.
const JP2L_POSX_KEY = 'jackpot2.posx'
const JP2L_POSY_KEY = 'jackpot2.posy'
const JP2L_POS_MIN = -1
const JP2L_POS_MAX = 1
const JP2L_POS_STEP = 0.05
const JP2L_POS_DEFAULT = 0
// Where the copy starts up-down: the top of the conversation, centred left-right (owner, 2026-11-11:
// "move the default place for the jackpot out to the middle top"). -1 is the highest place the clamp allows.
const JP2L_POSY_DEFAULT = -1

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
  posx: { min: JP2L_POS_MIN, max: JP2L_POS_MAX, step: JP2L_POS_STEP },
  posy: { min: JP2L_POS_MIN, max: JP2L_POS_MAX, step: JP2L_POS_STEP },
  hue: { min: JP2L_HUE_MIN, max: JP2L_HUE_MAX, step: 1 }
}

function jp2LWin() {
  return typeof window === 'undefined' ? null : window
}

function jp2LDoc() {
  return typeof document === 'undefined' ? null : document
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

// The position and the colour, clamped the way alpha and size are: a stored value that is nonsense
// (a string from an old host, a drag that ended off the end) comes back as the default rather than as
// a copy somewhere strange.
function jp2LClampPosition(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return JP2L_POS_DEFAULT
  const stepped = Math.round(number / JP2L_POS_STEP) * JP2L_POS_STEP
  return Number(Math.min(JP2L_POS_MAX, Math.max(JP2L_POS_MIN, stepped)).toFixed(2))
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
  posx: JP2L_POS_DEFAULT,
  posy: JP2L_POSY_DEFAULT,
  hue: JP2L_HUE_DEFAULT,
  gradient: JP2L_GRADIENT_DEFAULT,
  listeners: new Set()
}

// Read the shelf's stored choices, once per context. Called from the hooks themselves rather than
// from an effect: the status item is the only thing that can turn the layer on, and it must read
// the real value before its first paint, not one render later.
function jp2LAdopt(ctx) {
  if (!ctx || JP2L_STORE.ctx === ctx) return
  JP2L_STORE.ctx = ctx
  JP2L_STORE.overchat = jp2LBool(jp2LStored(ctx, JP2L_OVERCHAT_KEY, false))
  JP2L_STORE.alpha = jp2LClampAlpha(jp2LStored(ctx, JP2L_ALPHA_KEY, JP2L_ALPHA_DEFAULT))
  JP2L_STORE.size = jp2LClampSize(jp2LStored(ctx, JP2L_SIZE_KEY, JP2L_SIZE_DEFAULT))
  JP2L_STORE.posx = jp2LClampPosition(jp2LStored(ctx, JP2L_POSX_KEY, JP2L_POS_DEFAULT))
  JP2L_STORE.posy = jp2LClampPosition(jp2LStored(ctx, JP2L_POSY_KEY, JP2L_POSY_DEFAULT))
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

// The two offsets, written together: they are one setting to a person ("where is it"), and one of
// them alone is not a position. -1 is the left / the top end of the travel the frame allows, +1 the
// right / the bottom end, 0 the centre the copy has always had.
function jp2LSetPosition(x, y, ctx) {
  const posx = jp2LClampPosition(x)
  const posy = jp2LClampPosition(y)
  JP2L_STORE.posx = posx
  JP2L_STORE.posy = posy
  const store = ctx || JP2L_STORE.ctx
  jp2LSave(store, JP2L_POSX_KEY, posx)
  jp2LSave(store, JP2L_POSY_KEY, posy)
  jp2LPublish()
  return { x: posx, y: posy }
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

// Reset look: every LOOK setting back to its default — how see-through, how big, where, and what
// colour. The over-chat switch is not a look: it is left exactly where the person put it, so resetting
// the look can never make the cabinet vanish (or appear) as a side effect.
function jp2LResetLook(ctx) {
  jp2LSetAlpha(JP2L_ALPHA_DEFAULT, ctx)
  jp2LSetSize(JP2L_SIZE_DEFAULT, ctx)
  jp2LSetPosition(JP2L_POS_DEFAULT, JP2L_POSY_DEFAULT, ctx)
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

// The offsets and the colour, on the same pattern as the two sliders above: read once from the store,
// then kept in step by the store's listeners, and written with the setters that save them. That is
// what makes a change live — the status item, the cabinet's panel and both Settings views all draw
// this same setting and all see the same value the moment it moves.
function useJp2LPosition(ctx) {
  jp2LAdopt(ctx)
  const [position, setPosition] = useState({ x: JP2L_STORE.posx, y: JP2L_STORE.posy })
  useEffect(() => {
    const listener = () => setPosition({ x: JP2L_STORE.posx, y: JP2L_STORE.posy })
    JP2L_STORE.listeners.add(listener)
    listener()
    return () => JP2L_STORE.listeners.delete(listener)
  }, [])
  return [position, (x, y) => jp2LSetPosition(x, y, ctx)]
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

// ---- where the layer goes ----------------------------------------------------
// The box the machine floats over: the chat column, found the way the old over-chat machine finds
// it (19-jackpot-overlay.js, JP_chatColumn — an ancestor of the composer that spans most of the
// window) with one difference: when a docked pane squeezes the conversation below half the window,
// the innermost ancestor that is still a column (240 px or more) is the better answer than the
// right third of the window, which would sit over the panes instead of over the conversation. Read
// locally rather than borrowed, so this machine's geometry cannot be changed by the old one's.
// The conversation's composer: the first textarea that is NOT inside a Game Center surface. A
// "Play while you code" pane (or a table) can hold the first textarea on the page - its table chat -
// and treating that as the composer dropped the copy onto the pane (owner's screenshot, 2026-11-11).
// ONE finder, used for the chat column and for the composer limit alike, so they cannot disagree.
function jp2LComposerNode(doc) {
  if (!doc || typeof doc.querySelector !== 'function') return null
  const inGames = node => typeof node.closest === 'function' && Boolean(node.closest('.games-play-table, .games-wait-pane'))
  const all = typeof doc.querySelectorAll === 'function' ? Array.from(doc.querySelectorAll('textarea') || []) : []
  const composer = all.length ? all.find(node => !inGames(node)) : doc.querySelector('textarea')
  return composer && !inGames(composer) ? composer : null
}

function jp2LChatColumn() {
  const doc = jp2LDoc()
  if (!doc || typeof doc.querySelector !== 'function') return null
  // The conversation's composer is the first textarea that is NOT inside a Game Center surface. A
  // "Play while you code" pane (or a table) can hold the first textarea on the page - its table chat -
  // and treating that as "no chat column" dropped the copy onto the fallback third, i.e. ON the pane
  // (owner's screenshot, 2026-11-11 08:1x). So skip those, and only give up when no other is left.
  const composer = jp2LComposerNode(doc)
  if (!composer) return null
  const win = jp2LWin()
  const viewport = win && Number(win.innerWidth) > 0 ? Number(win.innerWidth) : 0
  const viewHeight = win && Number(win.innerHeight) > 0 ? Number(win.innerHeight) : 0
  // The conversation is TALL as well as wide. A composer's own bar can already be wider than half the
  // window while only ~60 px high, and taking it drew a tiny machine on the composer at the bottom
  // (owner's screenshot, 2026-11-11 08:03). So the walk wants an ancestor that is wide AND at least 40%
  // of the window high; the old wide-only answer is kept only as a last resort.
  const tall = height => viewHeight <= 0 || height >= viewHeight * 0.4
  let node = composer.parentElement
  let column = null
  let wideOnly = null
  while (node && node !== doc.body) {
    if (typeof node.getBoundingClientRect === 'function') {
      const rect = node.getBoundingClientRect()
      const width = rect ? Number(rect.width) || 0 : 0
      const height = rect ? Number(rect.height) || 0 : 0
      if (viewport > 0 && width > viewport * 0.5) {
        if (tall(height)) return node
        if (!wideOnly) wideOnly = node
      }
      if (!column && width >= 240 && tall(height)) column = node
    }
    node = node.parentElement
  }
  return column || wideOnly
}

function jp2LFrame() {
  const win = jp2LWin()
  const viewWidth = win && Number(win.innerWidth) > 0 ? Number(win.innerWidth) : 0
  const viewHeight = win && Number(win.innerHeight) > 0 ? Number(win.innerHeight) : 0
  const column = jp2LChatColumn()
  const box = column && typeof column.getBoundingClientRect === 'function' ? column.getBoundingClientRect() : null
  if (box && Number(box.width) > 0 && Number(box.height) > 0) {
    return {
      left: Math.max(0, Number(box.left) || 0),
      top: Math.max(0, Number(box.top) || 0),
      width: Number(box.width),
      height: Number(box.height)
    }
  }
  if (viewWidth > 0 && viewHeight > 0) {
    const width = Math.max(1, Math.round(viewWidth / 3))
    return { left: Math.max(0, viewWidth - width), top: 0, width, height: viewHeight }
  }
  // Nothing measurable at all (a headless shell, a stub document): the design size, so the numbers
  // are never nonsense and the machine still paints at 100%.
  return { left: 0, top: 0, width: JP2L_SIZE.width, height: JP2L_SIZE.height }
}

// The copy's own position: an offset from the centre, read live from the store.
function jp2LPosition() {
  return { x: jp2LClampPosition(JP2L_STORE.posx), y: jp2LClampPosition(JP2L_STORE.posy) }
}

// The top of the composer — a limit the copy must not cross — or null when the frame is not a
// conversation at all (the start screen, a games pane), because then there is no composer to keep
// clear of. It is the first textarea, the very element the chat column is found from, and it is only
// trusted when that column WAS found: a textarea inside a games pane cannot push the copy around on
// the conversation, and jp2LChatColumn() already answers null for one.
function jp2LComposerTop() {
  const doc = jp2LDoc()
  if (!doc || typeof doc.querySelector !== 'function') return null
  if (!jp2LChatColumn()) return null
  const composer = jp2LComposerNode(doc)
  if (!composer || typeof composer.getBoundingClientRect !== 'function') return null
  const rect = composer.getBoundingClientRect()
  const top = rect ? Number(rect.top) : 0
  return Number.isFinite(top) && top > 0 ? top : null
}

// The offsets, applied to the numbers jp2LOverlayGeometry() answered. Offsets of 0 — the default —
// hand that answer straight back, which is what makes "the default is where it has always been" true
// on any frame, window and size. Otherwise the copy is moved by a share of the room it actually has:
// the travel is the smaller of the room on the two sides, so -1 and +1 are both reachable and the
// centre stays the centre, and the destination is clamped so the whole machine stays inside the
// conversation and never lies over the composer. Where there is no room on an axis (the machine is as
// tall as the conversation, or taller than the part above the composer) there is nothing to travel
// and that axis does not move at all.
function jp2LPositioned(geo, frame) {
  const position = jp2LPosition()
  if (!geo || (position.x === 0 && position.y === 0)) return geo
  const box = frame || jp2LFrame()
  const left = Number(box.left) || 0
  const top = Number(box.top) || 0
  const width = Math.max(0, Number(box.width) || 0)
  const height = Math.max(0, Number(box.height) || 0)
  const composer = jp2LComposerTop()
  const ceiling = composer === null ? top + height : Math.min(top + height, composer)
  const minLeft = left
  const maxLeft = Math.max(minLeft, left + width - geo.width)
  const maxTop = Math.max(top, ceiling - geo.height)
  // Each direction travels as far as ITS side allows: -1 reaches the top (or left) edge of the
  // conversation and +1 the composer (or right edge), even when the centred copy sits nearer one side.
  // (A shared, symmetric travel stopped "top middle" short whenever the composer was close below.)
  const along = (at, low, high, amount) => {
    const room = amount < 0 ? at - low : high - at
    return room > 0 ? Math.min(high, Math.max(low, at + amount * room)) : at
  }
  const movedX = along(geo.left, minLeft, maxLeft, position.x)
  const movedY = along(geo.top, top, maxTop, position.y)
  return { scale: geo.scale, width: geo.width, height: geo.height, left: Math.round(movedX), top: Math.round(movedY) }
}

// ---- the two machines on one conversation ------------------------------------
// The owner keeps BOTH machines (2026-11-11) and both switches may be on at once. Then the
// conversation is shared rather than fought over: the ORIGINAL slot machine keeps the left half of
// the chat column, from its top-left corner, and this one keeps the right half, from its bottom-right.
// Two copies that each stay inside their own half of the column cannot touch, whatever size they draw
// at, which is what makes "they must not overlap" true by construction. The other machine's switch is
// only ever READ here: the two switches stay separate, and turning this one off never turns the
// original off.
function jp2LSlotsOverchat() {
  try {
    return Boolean(typeof SM_OVERCHAT !== 'undefined' && SM_OVERCHAT && SM_OVERCHAT.on)
  } catch (error) {
    // Before 18-slot-machine.js has run, or in a build without it: nothing to share.
    return false
  }
}

function useJp2LSlotsOverchat() {
  const [on, setOn] = useState(jp2LSlotsOverchat)
  useEffect(() => {
    if (typeof SM_OVERCHAT === 'undefined' || !SM_OVERCHAT || !SM_OVERCHAT.listeners) return undefined
    const listener = value => setOn(Boolean(value))
    SM_OVERCHAT.listeners.add(listener)
    setOn(jp2LSlotsOverchat())
    return () => { SM_OVERCHAT.listeners.delete(listener) }
  }, [])
  return on
}

// The frame this machine floats over: its own half of the chat column when the original machine is up
// as well, the whole column otherwise - and the right third of the window when the shell exposes no
// column at all (the start screen), which is what jp2LFrame() already answers.
function jp2LSharedFrame(shared) {
  const frame = jp2LFrame()
  if (!shared) return frame
  const half = Math.max(1, frame.width / 2)
  return {
    left: frame.left + Math.max(0, frame.width - half),
    top: frame.top,
    width: half,
    height: frame.height
  }
}

// ...and the numbers inside it: bottom-right of the frame it shares, centred in a frame it has to
// itself. The scale floor that keeps a lone copy visible is deliberately NOT applied while sharing:
// on a column narrow enough that even half of it is below the floor, a copy at the floor would spill
// past its own half and onto the other machine, and not overlapping is the firmer promise.
function jp2LSharedGeometry(frame, size, shared) {
  const box = frame || jp2LFrame()
  if (!shared) return jp2LPositioned(jp2LOverlayGeometry(box, size), box)
  const factor = jp2LClampSize(size)
  const room = Math.min(box.width / JP2L_SIZE.width, box.height / JP2L_SIZE.height)
  // Floored first, then the box is derived from the number the stage is actually transformed by, so
  // the drawn machine and its layout box stay the same size.
  const scale = jp2LFloor(Math.max(0.05, Math.min(room, room * factor)))
  const width = JP2L_SIZE.width * scale
  const height = JP2L_SIZE.height * scale
  return jp2LPositioned({
    scale,
    width,
    height,
    left: Math.round(box.left + Math.max(0, box.width - width)),
    top: Math.round(box.top + Math.max(0, box.height - height))
  }, box)
}

// The one door every part of this file reads the copy's numbers through, so the status item's own
// measurement, the layer the react-dom hosts paint into, and the frame announcement can never
// disagree about where the machine is.
function jp2LOverchatGeometry(shared) {
  return jp2LSharedGeometry(jp2LSharedFrame(shared), JP2L_STORE.size, shared)
}

// The owner's ask (2026-11-11): when the machine does not appear, the reason has to be readable
// without a debugger. So the copy says which frame it chose, in the console, once per distinct
// frame — console.info, prefixed so it is easy to filter. It is deliberately not an error and not a
// warning: the machine appearing is not a problem, and a noisy log is its own defect.
let JP2L_TOLD = ''

function jp2LTellFrame(frame, geo) {
  const box = frame || { left: 0, top: 0, width: 0, height: 0 }
  const line = `${Math.round(Number(box.left) || 0)},${Math.round(Number(box.top) || 0)} `
    + `${Math.round(Number(box.width) || 0)}x${Math.round(Number(box.height) || 0)}`
    + ` -> ${Math.round(Number(geo && geo.width) || 0)}x${Math.round(Number(geo && geo.height) || 0)}`
    + ` at scale ${geo && geo.scale}`
  if (JP2L_TOLD === line) return line
  JP2L_TOLD = line
  try {
    if (typeof console !== 'undefined' && console && typeof console.info === 'function') {
      console.info(`[jackpot2] over chat: frame ${line}`)
    }
  } catch (error) {
    // A shell with no console: the frame is still chosen, it just cannot be announced.
  }
  return line
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

// The over-chat copy: it fits the column AND the window, at the size the slider asks for, and is
// never smaller than the floor — a copy below that is invisible, which is worse than a big one. The
// frame itself is floored too, so a host that reports a zero-sized column (a chat that has not laid
// out yet, the start screen) still gets a machine instead of a 0x0 box.
function jp2LOverlayGeometry(frame, size) {
  const measured = frame || jp2LFrame()
  const box = {
    left: Number(measured && measured.left) || 0,
    top: Number(measured && measured.top) || 0,
    width: Math.max(JP2L_MIN_FRAME.width, Number(measured && measured.width) || 0),
    height: Math.max(JP2L_MIN_FRAME.height, Number(measured && measured.height) || 0)
  }
  const factor = jp2LClampSize(size)
  const win = jp2LWin()
  const viewWidth = win && Number(win.innerWidth) > 0 ? Number(win.innerWidth) : box.width
  const viewHeight = win && Number(win.innerHeight) > 0 ? Number(win.innerHeight) : box.height
  const fit = Math.min(box.width / JP2L_SIZE.width, box.height / JP2L_SIZE.height)
  const room = Math.min(viewWidth / JP2L_SIZE.width, viewHeight / JP2L_SIZE.height)
  const scale = Math.max(JP2L_MIN_SCALE, Math.min(fit * factor, Math.max(JP2L_MIN_SCALE, room)))
  const geo = jp2LCentreIn(box, jp2LFloor(scale))
  // Belt and braces: whatever a stub host answered, the numbers handed to a caller are a box that
  // can be seen. This is the promise the owner's release rule asks for, so it is checked, not
  // assumed.
  if (!(geo.width > 0) || !(geo.height > 0)) {
    return jp2LCentreIn({ left: 0, top: 0, width: JP2L_SIZE.width, height: JP2L_SIZE.height }, 1)
  }
  return geo
}

// The full view: the same machine, as large as its frame allows and no larger. There is no floor
// here — the promise for this one is that NOTHING is clipped, in any frame, and a floor would break
// that promise on a short frame. The slider only ever shrinks it.
function jp2LFitGeometry(frame, size) {
  const box = frame || jp2LFrame()
  const factor = jp2LClampSize(size)
  const fit = Math.min(box.width / JP2L_SIZE.width, box.height / JP2L_SIZE.height)
  const scale = Math.max(0.05, Math.min(fit, fit * factor))
  return jp2LCentreIn(box, jp2LFloor(scale))
}

// ---- the layer itself --------------------------------------------------------
const JP2L_LAYER = {
  ctx: null,
  node: null,
  root: null,
  element: null,
  geo: null,
  column: null,
  observer: null,
  onResize: null,
  style: null,
  notify: null,
  // The tint the layer's own stage was last painted with, so a colour change repaints it and a resize
  // that changes nothing does not.
  tint: null,
  // Whether the original machine is over the chat too, so this one keeps to its half of the column.
  shared: false
}

function jp2LLayerNode() {
  return JP2L_LAYER.node
}

// One stylesheet, injected once: the layer is a window, not a wall. Everything in it passes the
// pointer through to the conversation underneath except the machine's own controls, which opt in by
// being buttons, inputs, selects or anything marked data-jp2-control.
function jp2LLayerStyle() {
  if (JP2L_LAYER.style) return JP2L_LAYER.style
  const doc = jp2LDoc()
  if (!doc || !doc.head || typeof doc.createElement !== 'function' || typeof doc.head.appendChild !== 'function') return null
  const el = doc.createElement('style')
  el.setAttribute('id', 'jp2-layer-style')
  doc.head.appendChild(el)
  el.textContent = `
    [data-jp2-layer], [data-jp2-surface] { pointer-events: none; }
    [data-jp2-layer] button, [data-jp2-layer] input, [data-jp2-layer] select, [data-jp2-layer] textarea, [data-jp2-layer] [data-jp2-control],
    [data-jp2-surface] button, [data-jp2-surface] input, [data-jp2-surface] select, [data-jp2-surface] textarea, [data-jp2-surface] [data-jp2-control] { pointer-events: auto; }
    /* Over the chat the machine is to WATCH (owner, 2026-11-11): its spin, lever, bet, machine picker and
       other buttons do not take a click there - only the X, the sound switch and the look controls
       (see-through, size, place, colour) do. Scoped to the over-chat layer, so the cabinet in the pane
       and on the Games page plays exactly as before. */
    [data-jp2-layer] .jp2-machine button:not([data-jp2-sound]):not([data-jp2-close]),
    [data-jp2-surface] .jp2-machine button:not([data-jp2-sound]):not([data-jp2-close]) { pointer-events: none !important; cursor: default !important; }
    [data-jp2-layer] .jp2-machine [data-jp2="overchat-row"] button,
    [data-jp2-surface] .jp2-machine [data-jp2="overchat-row"] button { pointer-events: auto !important; cursor: pointer !important; }
    [data-jp2-tint] .jp2-machine {
      background: var(--jp2-tint-bg) !important;
      border-color: var(--jp2-tint-edge) !important;
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .05), 0 18px 60px rgba(2, 4, 10, .8), 0 0 60px var(--jp2-tint-glow) !important;
    }
    @media (prefers-reduced-motion: reduce) {
      [data-jp2-layer] *, [data-jp2-surface] * { animation: none !important; transition: none !important; }
    }
  `
  JP2L_LAYER.style = el
  return el
}

function jp2LEnsureLayer() {
  if (JP2L_LAYER.node) return JP2L_LAYER.node
  const doc = jp2LDoc()
  if (!doc || !doc.body || typeof doc.createElement !== 'function' || typeof doc.body.appendChild !== 'function') return null
  const node = doc.createElement('div')
  node.setAttribute('data-jp2-layer', 'overlay')
  node.setAttribute('data-jp2-surface', 'layer')
  node.setAttribute('role', 'presentation')
  node.setAttribute('aria-label', 'Jackpot over chat')
  if (node.style) {
    Object.assign(node.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      width: '0px',
      height: '0px',
      zIndex: String(JP2L_Z),
      pointerEvents: 'none',
      opacity: String(JP2L_STORE.alpha),
      boxSizing: 'border-box',
      visibility: 'visible'
    })
  }
  doc.body.appendChild(node)
  JP2L_LAYER.node = node
  jp2LLayerStyle()
  return node
}

// Take the div off the page, by every door there is. Each step is guarded and none of them is
// trusted to have worked: a shell (or a test double) whose `remove()` is a no-op, or whose
// appendChild never set parentNode, still ends up with the layer gone, which is the whole promise
// of switching it off.
function jp2LDetach(node) {
  if (!node) return
  try {
    if (typeof node.remove === 'function') node.remove()
  } catch (error) {
    // fall through: the parent still knows how
  }
  try {
    const parent = node.parentNode
    if (parent && typeof parent.removeChild === 'function') parent.removeChild(node)
  } catch (error) {
    // already gone
  }
  try {
    const doc = jp2LDoc()
    if (doc && doc.body && typeof doc.body.removeChild === 'function') doc.body.removeChild(node)
  } catch (error) {
    // not a child of the body any more, which is what we wanted
  }
}

function jp2LRemoveLayer() {
  const node = JP2L_LAYER.node
  const root = JP2L_LAYER.root
  JP2L_LAYER.node = null
  JP2L_LAYER.root = null
  JP2L_LAYER.element = null
  JP2L_LAYER.geo = null
  JP2L_LAYER.notify = null
  JP2L_LAYER.tint = null
  // Switching it off is a fresh start: the next turn-on announces the frame it chose again.
  JP2L_TOLD = ''
  jp2LUnwatch()
  if (root && typeof root.unmount === 'function') {
    try { root.unmount() } catch (error) { /* a dead root is not worth an error */ }
  }
  if (node && typeof node.removeChild === 'function') {
    while (node.firstChild) node.removeChild(node.firstChild)
  }
  jp2LDetach(node)
  return true
}

function jp2LApplyStyle(node, geo) {
  if (!node || !node.style || !geo) return
  node.style.left = `${geo.left}px`
  node.style.top = `${geo.top}px`
  node.style.width = `${geo.width}px`
  node.style.height = `${geo.height}px`
  node.style.opacity = String(JP2L_STORE.alpha)
  node.style.visibility = 'visible'
}

// The host's react-dom, if this build has one on any global it can see. Never imported: see the
// note at the top of this file.
function jp2LDOMlib() {
  const found = []
  try { if (typeof ReactDOM !== 'undefined' && ReactDOM) found.push(ReactDOM) } catch (error) { /* not a global here */ }
  try { const global = typeof globalThis === 'undefined' ? null : globalThis; if (global && global.ReactDOM) found.push(global.ReactDOM) } catch (error) { /* not a global here */ }
  try { const win = jp2LWin(); if (win && win.ReactDOM) found.push(win.ReactDOM) } catch (error) { /* not a global here */ }
  return found.find(lib => lib && (typeof lib.createRoot === 'function' || typeof lib.createPortal === 'function')) || null
}

// The same library, asked only for the portal door. Kept apart from jp2LDOMlib() because a host that
// can do both is already served by the root, and a host that can only portal is not a root host.
function jp2LDomlibForPortals() {
  const lib = jp2LDOMlib()
  return lib && typeof lib.createPortal === 'function' ? lib : null
}

// The machine, or the honest plate that says the machine is not in this bundle. The layer is this
// part's job; the cabinet is 18-jackpot2-machine.js's.
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

// The scaled stage: the machine at its design size inside a box that is transform-scaled from the
// top-left corner, which is the only thing the caller is allowed to do to it.
function jp2LStage(ctx, geo, mode) {
  const scale = geo && Number.isFinite(geo.scale) ? geo.scale : 1
  const overlay = (mode || 'overlay') === 'overlay'
  // The colour of the frame. Only the over-chat copy is frosted, so only it is tinted: the full view
  // in the Games page is the cabinet's own drawing. A tinted copy also makes sure the one static rule
  // it needs is on the page, wherever this stage is drawn — including a host where the layer's own
  // div could not be created and the copy is a child of the status span.
  const tint = overlay ? jp2LTint() : null
  const tintVars = tint && tint.active ? jp2LTintVars(tint) : null
  // The over-chat copy always needs the static rules (tint, and its watch-only buttons), wherever
  // it is drawn - the layer's own div or a child of the status span.
  if (overlay) jp2LLayerStyle()
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
    children: [jp2LMachine(ctx, mode || 'overlay'), (mode || 'overlay') === 'overlay' ? jsx('button', {
      type: 'button', 'data-jp2-close': '1', 'aria-label': 'Close Slots over chat',
      onClick: () => jp2LSetOverchat(false, ctx),
      style: { position: 'absolute', right: 12, top: 12, zIndex: 10, pointerEvents: 'auto', cursor: 'pointer', border: '1px solid #3ee0c5', borderRadius: 6, background: '#173044', color: '#fff', fontSize: 20 },
      children: '×'
    }) : null]
  })
}

// Draw the machine into the layer with a host react-dom root, when there is one. Returns the root,
// or null when this build has no react-dom at all — the status item then draws the machine in our
// own tree, over the layer's numbers (never both: the machine is mounted once).
function jp2LPaint(ctx) {
  const node = JP2L_LAYER.node
  if (!node || !JP2L_LAYER.geo) return null
  const element = jp2LStage(ctx || JP2L_LAYER.ctx, JP2L_LAYER.geo, 'overlay')
  JP2L_LAYER.element = element
  const lib = jp2LDOMlib()
  if (lib && typeof lib.createRoot === 'function') {
    try {
      if (!JP2L_LAYER.root) JP2L_LAYER.root = lib.createRoot(node)
      JP2L_LAYER.root.render(element)
      return JP2L_LAYER.root
    } catch (error) {
      JP2L_LAYER.root = null
    }
  }
  return null
}

function jp2LMeasure() {
  const node = JP2L_LAYER.node
  if (!node) return null
  const before = JP2L_LAYER.geo
  // The same numbers the status item draws its own copy at: one shape, one measurement, whichever
  // door this host offers (see jp2LOverchatGeometry).
  const geo = jp2LOverchatGeometry(Boolean(JP2L_LAYER.shared))
  JP2L_LAYER.geo = geo
  jp2LApplyStyle(node, geo)
  // Repaint only when something the stage is PAINTED with moved: the size, or the tint. A wider or
  // shorter window is what a resize tick brings, and re-rendering the machine for one of those would
  // restart its spin; the position is not in here because the layer's own box is moved by
  // jp2LApplyStyle above, which needs no re-render at all.
  const tint = jp2LTintSignature(jp2LTint())
  const repaint = !before || Math.abs(before.scale - geo.scale) > 0.001 || JP2L_LAYER.tint !== tint
  JP2L_LAYER.tint = tint
  if (repaint) jp2LPaint(JP2L_LAYER.ctx)
  return geo
}

function jp2LRemeasure() {
  const geo = jp2LMeasure()
  if (geo && typeof JP2L_LAYER.notify === 'function') JP2L_LAYER.notify(geo)
  return geo
}

// Kept aligned by a ResizeObserver on the column it sits over, plus the window's own resize: the
// column can change without the window doing so (a pane opening beside the chat).
function jp2LWatch() {
  const column = jp2LChatColumn()
  if (JP2L_LAYER.column !== column) {
    if (JP2L_LAYER.observer && typeof JP2L_LAYER.observer.disconnect === 'function') JP2L_LAYER.observer.disconnect()
    JP2L_LAYER.observer = null
    JP2L_LAYER.column = column
  }
  if (!JP2L_LAYER.observer && column && typeof ResizeObserver !== 'undefined') {
    try {
      JP2L_LAYER.observer = new ResizeObserver(() => jp2LRemeasure())
      JP2L_LAYER.observer.observe(column)
    } catch (error) {
      JP2L_LAYER.observer = null
    }
  }
  const win = jp2LWin()
  if (!JP2L_LAYER.onResize && win && typeof win.addEventListener === 'function') {
    JP2L_LAYER.onResize = () => { jp2LWatch(); jp2LRemeasure() }
    win.addEventListener('resize', JP2L_LAYER.onResize)
  }
}

function jp2LUnwatch() {
  if (JP2L_LAYER.observer && typeof JP2L_LAYER.observer.disconnect === 'function') JP2L_LAYER.observer.disconnect()
  JP2L_LAYER.observer = null
  JP2L_LAYER.column = null
  const win = jp2LWin()
  if (JP2L_LAYER.onResize && win && typeof win.removeEventListener === 'function') {
    win.removeEventListener('resize', JP2L_LAYER.onResize)
  }
  JP2L_LAYER.onResize = null
}

// The one door: on creates the layer, sizes it to the conversation and paints the machine; off
// removes it and everything it started. Nothing else in the plugin creates or removes the layer, so
// the switch alone decides whether it exists.
function jp2LApply(ctx, on, options = {}) {
  if (ctx) {
    JP2L_LAYER.ctx = ctx
    jp2LAdopt(ctx)
  }
  if (Number.isFinite(Number(options.alpha))) JP2L_STORE.alpha = jp2LClampAlpha(options.alpha)
  if (Number.isFinite(Number(options.size))) JP2L_STORE.size = jp2LClampSize(options.size)
  if (typeof options.notify === 'function') JP2L_LAYER.notify = options.notify
  if (!on) {
    jp2LRemoveLayer()
    return { on: false, node: null, geo: null, root: null }
  }
  const node = jp2LEnsureLayer()
  if (!node) return { on: true, node: null, geo: null, root: null }
  jp2LWatch()
  const geo = jp2LMeasure()
  if (geo && typeof JP2L_LAYER.notify === 'function') JP2L_LAYER.notify(geo)
  return { on: true, node, geo, root: JP2L_LAYER.root }
}

// ---- the status bar: the switch, the sliders, and the machine while it floats ----
function jp2LSliderRow(alpha, size, setAlpha, setSize) {
  const slider = (label, key, value, onChange) => jsx('input', {
    type: 'range',
    min: key === 'alpha' ? JP2L_ALPHA_MIN : JP2L_SIZE_MIN,
    max: key === 'alpha' ? JP2L_ALPHA_MAX : JP2L_SIZE_MAX,
    step: key === 'alpha' ? JP2L_ALPHA_STEP : 0.05,
    value,
    'aria-label': label,
    title: label,
    'data-jp2-range': key,
    onChange: event => onChange(Number(event.target.value)),
    style: { width: 58, margin: 0, accentColor: '#3ee0c5', cursor: 'pointer' }
  })
  const readout = (key, value) => jsx('span', {
    'data-jp2-value': key,
    style: { fontSize: 10, color: text.tertiary, minWidth: 28, textAlign: 'right' },
    children: `${Math.round(value * 100)}%`
  })
  return jsxs('span', {
    'data-jp2': 'prefs',
    style: { display: 'inline-flex', alignItems: 'center', gap: 6, pointerEvents: 'auto' },
    children: [
      slider('Jackpot over chat: how see-through', 'alpha', alpha, setAlpha),
      slider('Jackpot over chat: how big', 'size', size, setSize)
    ]
  })
}

// ---- only over the conversation -----------------------------------------------
// The copy floats over the CHAT and nowhere else: not the Games page, not another plugin's page, not
// Settings (owner's screenshot, 2026-11-11 08:36: it sat on top of Game Center). Hermes routes by hash
// (react-router HashRouter): the chat is "/" (a new chat) or "/<sessionId>", one segment that carries
// digits ("local-4e8e...", "20261109_194547_20a0a5"). Every app page and every plugin page is a word
// ("/games", "/settings", "/omniscience"). ROUTE ONLY - no DOM rule (a DOM rule once hid the copy on
// the real chat, see 9433891 / 1bc6cd7).
function jp2LOnChatRoute() {
  try {
    const win = jp2LWin()
    const hash = String((win && win.location && win.location.hash) || '').replace(/^#/, '')
    const path = hash.split('?')[0]
    if (!path || path === '/') return true
    const segment = path.replace(/^\//, '')
    if (!segment || segment.includes('/')) return false
    return /\d/.test(segment)
  } catch {
    return true
  }
}

// The same answer as React state. hashchange is not enough on its own (a navigation can replace the
// route without one), so it is re-read on a light 600 ms timer as well.
function useJp2LOnChatRoute() {
  const [onChat, setOnChat] = useState(jp2LOnChatRoute)
  useEffect(() => {
    const win = jp2LWin()
    const read = () => setOnChat(jp2LOnChatRoute())
    if (win && typeof win.addEventListener === 'function') win.addEventListener('hashchange', read)
    const timer = setInterval(read, 600)
    return () => {
      if (win && typeof win.removeEventListener === 'function') win.removeEventListener('hashchange', read)
      clearInterval(timer)
    }
  }, [])
  return onChat
}

function Jackpot2StatusItem({ ctx }) {
  SM_API.rest = (path, opts) => ctx.rest(path, opts)
  const [switchOn, setOn] = useJp2LOverchat(ctx)
  // The switch is the person's choice; whether the copy is DRAWN also needs the chat on screen.
  const onChatRoute = useJp2LOnChatRoute()
  const on = switchOn && onChatRoute
  const [alpha, setAlpha] = useJp2LAlpha(ctx)
  const [size, setSize] = useJp2LSize(ctx)
  // The copy's own position and colour are read here as well, because both change what is drawn:
  // the offsets move it and the tint paints it. A change to either re-runs the effect below, which
  // measures again and (for a colour) repaints, so the copy follows the sliders without a reload.
  const [position] = useJp2LPosition(ctx)
  const [tint] = useJp2LTint(ctx)
  // The other machine over the chat: when the original slot machine's switch is on as well, this one
  // keeps to the right half of the conversation so the two can never draw over each other (owner's
  // ask, 2026-11-11 - see the note above jp2LSharedFrame).
  const shared = false
  // The numbers, measured HERE, in our own tree. They must not come out of jp2LApply: that only
  // measures once the body div exists, so on a host where the div cannot be created the machine
  // never appeared over the chat at all (owner's release blocker, 2026-11-11 — see the note at the
  // top of this file). This is the OLD machine's own method, kept whole: measure the frame, then
  // draw a position:fixed child of this span.
  const [geo, setGeo] = useState(null)
  const [hosted, setHosted] = useState(false)
  const measure = () => {
    const frame = jp2LSharedFrame(shared)
    const next = jp2LSharedGeometry(frame, size, shared)
    jp2LTellFrame(frame, next)
    setGeo(next)
    return next
  }
  useEffect(() => {
    // The layer's own div is still created and removed by the switch alone — the shipped host and
    // the harness both rely on it — and a host react-dom fills it when it has one. It is told which
    // frame to keep, so the layer and this span's own copy are the same shape.
    JP2L_LAYER.shared = shared
    const painted = jp2LApply(ctx, on, { alpha, size })
    setHosted(Boolean(painted && painted.root))
    if (!on) {
      setGeo(null)
      return undefined
    }
    const next = measure()
    if (painted && painted.node) jp2LApplyStyle(painted.node, next)
    // Kept aligned by the column it sits over, and by the window itself: a docked pane changes the
    // column without the window changing at all.
    const column = jp2LChatColumn()
    let observer = null
    if (column && typeof ResizeObserver !== 'undefined') {
      try {
        observer = new ResizeObserver(() => measure())
        observer.observe(column)
      } catch (error) {
        observer = null
      }
    }
    const win = jp2LWin()
    if (win && typeof win.addEventListener === 'function') win.addEventListener('resize', measure)
    // One more look after the first paint: the chat column only has its real width once the shell
    // has laid out, and the old machine re-measures at zero delay for the same reason.
    const settle = setTimeout(measure, 0)
    return () => {
      if (observer && typeof observer.disconnect === 'function') observer.disconnect()
      if (win && typeof win.removeEventListener === 'function') win.removeEventListener('resize', measure)
      clearTimeout(settle)
    }
    // position and tint are in the list because moving a slider has to measure again and a colour
    // change has to repaint; they are read as values, so a change to either is a change here.
  }, [ctx, on, alpha, size, shared, position.x, position.y, tint.gradient, tint.hue])
  // A plugin reload while the machine is up must not leave its div behind on the page.
  useEffect(() => () => jp2LRemoveLayer(), [])
  const toggle = () => setOn(!switchOn)
  // ONE machine, whichever door this host offers:
  //   createRoot   -> drawn into the layer's own div (jp2LApply did it above);
  //   createPortal -> drawn into the layer's own div through the portal door;
  //   neither      -> drawn here, as a fixed child of this span, at the numbers measured above.
  // The third door is the one the owner's release blocker was about: it needs no body div at all,
  // so the cabinet appears even where jp2LEnsureLayer() can create nothing.
  const lib = jp2LDomlibForPortals()
  const portal = on && !hosted && geo && JP2L_LAYER.node && lib
    ? lib.createPortal(jp2LStage(ctx, geo, 'overlay'), JP2L_LAYER.node)
    : null
  const mirror = on && !hosted && !portal && geo
    ? jsx('div', {
      'data-jp2-surface': 'mirror',
      style: {
        position: 'fixed', left: geo.left, top: geo.top, width: geo.width, height: geo.height,
        zIndex: JP2L_Z, opacity: jp2LClampAlpha(alpha), pointerEvents: 'none', visibility: 'visible'
      },
      children: jp2LStage(ctx, geo, 'overlay')
    })
    : null
  // NOTHING visible in the status bar (owner, 2026-11-11: "remove the status bar for the slots
  // completely"). The span stays, zero-sized and unclickable, ONLY as the anchor the over-chat copy is
  // a fixed child of (the 9433891 method). The switch and sliders live in the cabinet's own panel and
  // in Settings (Jackpot2OverChatControls).
  void toggle
  return jsx('span', {
    'data-jp2': 'status-wrap',
    style: { display: 'inline-block', width: 0, height: 0, overflow: 'visible', padding: 0, margin: 0 },
    children: portal || mirror
  })
}

// ---- one switch, one panel of sliders, every surface ------------------------
// The owner's ask (2026-11-11): the switch that floats the machine over the chat is ONE setting, so
// it is drawn from one component and every surface shows that component — the cabinet's own panel
// beside Auto-spin/Auto-bet, the Games app's Settings, and the play-while-you-wait pane's Settings
// (which is the same Settings panel). All of them read and write 'jackpot2.overchat',
// 'jackpot2.alpha', 'jackpot2.size', 'jackpot2.posx', 'jackpot2.posy', 'jackpot2.hue' and
// 'jackpot2.gradient' through the hooks above, so there is no second copy of the choice and no
// surface that can drift from another. The status-bar toggle is that same switch too.
//
// tone: 'cabinet' draws it inside the dark machine; anything else draws it on the light panels.
function Jackpot2OverChatControls({ ctx, tone }) {
  const [on, setOn] = useJp2LOverchat(ctx)
  const [alpha, setAlpha] = useJp2LAlpha(ctx)
  const [size, setSize] = useJp2LSize(ctx)
  const [position, setPosition] = useJp2LPosition(ctx)
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
  // Where the copy is, in one line: 'centre' for the place it starts at, otherwise the two offsets as
  // signed shares of the travel they have. + is right and down, exactly as the sliders move.
  const share = value => (value === 0 ? '0%' : `${value > 0 ? '+' : '−'}${Math.round(Math.abs(value) * 100)}%`)
  const offsetText = (x, y) => (x === 0 && y === JP2L_POSY_DEFAULT ? 'top middle' : `${share(x)} / ${share(y)}`)
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
          button('reset', 'Reset look', 'Restore every look setting: see-through, size, position and colour. The over-chat switch itself is left as it is.', () => tintActions.reset())
        ]
      }, 'switch'),
      row('alpha', 'See-through', [
        slider('alpha', 'see-through', alpha, setAlpha),
        readout('alpha', `${Math.round(alpha * 100)}%`),
        tag('Size', 'size-tag'),
        slider('size', 'size', size, setSize),
        readout('size', `${Math.round(size * 100)}%`)
      ], dark ? 64 : 74),
      // Where it floats. Both sliders are offsets from the centre the copy has always had, clamped to
      // the conversation: nothing here can put it outside the chat column or over the composer.
      row('position', 'Position', [
        tag('Left-right', 'lr'),
        slider('posx', 'left-right (0 is centred, + is right)', position.x, value => setPosition(value, position.y)),
        tag('Up-down', 'ud'),
        slider('posy', 'up-down (0 is centred, + is down)', position.y, value => setPosition(position.x, value)),
        readout('position', offsetText(position.x, position.y)),
        button('centre', 'Top middle', 'Put the copy back at its starting place: the top of the conversation, centred.', () => setPosition(JP2L_POS_DEFAULT, JP2L_POSY_DEFAULT))
      ]),
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

// The Play shelf with the Jackpot entry in it, right after the shelf's own Slots card (the owner's
// ask: a Jackpot entry beside the old slots entry). A search only keeps it when it matches, exactly
// like every shelf card around it.
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
  // slider belongs to the copy over the chat only (owner, 2026-11-11 - only that copy may change).
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
