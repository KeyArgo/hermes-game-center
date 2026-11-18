// ---- 78-overchat-slot.js: the see-through machines, anchored in the composer's own slot
//
// Both slot machines have a "show it over the conversation" switch: the original cabinet
// (18-slot-machine.js / 19-jackpot-overlay.js) and Jackpot v2 (19-jackpot2-layer.js). This part is the
// one place they are put on screen.
//
// WHAT IT REPLACED. Each machine used to put itself over the app: a position:fixed div appended to
// document.body, a stylesheet appended to <head>, and a measurement of the app's own markup — scan every
// <textarea>, walk their ancestors until one was wider than half the window, call that "the chat column",
// and read the route's hash to guess which screen was showing. A plugin that does that can be broken by
// an app update and can break the app.
//
// WHAT THIS IS. One contribution to `COMPOSER_AREAS.underside`, the composer's chrome-free strip below
// the input — a real Desktop SDK surface, registered like any other contribution:
//
//   - the slot decides WHERE THE ANCHOR IS. It belongs to the conversation's composer, so it exists
//     exactly while the conversation is on screen: no route sniffing, no DOM test, nothing to keep the
//     machine off the Games page, Settings or another plugin's page.
//   - the anchor has no height, so the composer keeps its own, and THE ANCHOR IS THE ONLY THING MEASURED:
//     its own left edge and width, with a ResizeObserver and a window resize listener.
//   - the machines are drawn in a child of the anchor that is position: fixed at the top of the window,
//     as wide as the anchor and centred over it, and no taller than 60% of the window nor than
//     OVERCHAT_MAX_HEIGHT. They keep their own opacity, their own size preference and their own aspect
//     ratio: the cabinet is a picture that scales, never a box that stretches.
//   - the machines decide their own look, and are watch-only: nothing here takes a click the
//     conversation wanted, and each machine's own dismissal controls opt back in.
//
// A FIXED BOX CAN BE TRAPPED. An ancestor with transform, filter or `contain` makes itself the containing
// block for a fixed child, so the box lands inside that ancestor instead of at the top of the window.
// Which ancestors do that cannot be known ahead of time, so the placement is CHECKED once it is laid out,
// against the fixed box's own rect: if it did not arrive at the top of the window, this falls back to
// drawing in the slot itself, which has no coordinates to get wrong.
//
// Nothing is drawn while both switches are off, so the slot is empty and the composer unchanged whenever
// nobody asked for a machine.
const OVERCHAT_GAP = 10

// Where the machines are drawn: a small offset below the window's top edge, so they clear the window's
// own chrome, and over the conversation rather than under it.
const OVERCHAT_TOP = 56

// How far off that offset the drawn box may land before the fallback takes over. A transformed ancestor
// puts the box inside itself, which is hundreds of pixels away; a few pixels is rounding.
const OVERCHAT_TOP_SLACK = 6

// The most of the window's height the machines may use. The conversation behind them is the point: they
// are a see-through picture on top of it, not a page of their own. 60% is the owner's ask — the machine
// is worth watching, and the top three fifths of the window is where it is allowed to be big.
const OVERCHAT_VIEW_SHARE = 0.60

// What one machine's cell looks like. `minWidth: 0` matters: without it a flex item refuses to shrink
// below its content, and a wide cabinet would push the row past the composer instead of being fitted.
const OVERCHAT_SLOT = { minWidth: 0, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }

// The window, where there is one: the harnesses and a server-side render have none.
function overchatWindow() {
  return typeof window === 'undefined' ? null : window
}

// The anchor's own box, and nothing else. Left and width are the whole measurement: the anchor has no
// height to care about, and no other element on the page is read.
function overchatAnchor(ref) {
  const node = ref && ref.current
  if (!node) return { left: 0, width: 0 }
  let rect = null
  if (typeof node.getBoundingClientRect === 'function') rect = node.getBoundingClientRect()
  const width = rect ? Number(rect.width) || 0 : Number(node.clientWidth) || 0
  const left = rect ? Number(rect.left) || 0 : 0
  return { left, width }
}

// How tall the drawn machines may be. The window's own height is a viewing policy — how much of what the
// person is looking at the machines may cover — not a measurement of the app: 60% of it, with
// OVERCHAT_MAX_HEIGHT as the ceiling. What the machinery DRAWS at that room is the fit's business
// (overchatFitScale in 19-jackpot-overlay.js): 100% is 640 px where this room allows it, and the size
// slider scales from there, never past this room.
function overchatStageHeight() {
  const win = overchatWindow()
  const view = win && Number(win.innerHeight) > 0 ? Number(win.innerHeight) : 0
  const share = view > 0 ? Math.floor(view * OVERCHAT_VIEW_SHARE) : OVERCHAT_MAX_HEIGHT
  const today = Math.max(0, Math.min(OVERCHAT_MAX_HEIGHT, share))
  const size = backdropGrowth()
  if (!(size > 1)) return today
  // Bigger than today: grow with the Size slider, but its bottom never past 95% of the window (it is
  // drawn OVERCHAT_TOP below the window's top edge).
  const most = view > 0 ? Math.floor(view * BACKDROP_MOST_SHARE) - OVERCHAT_TOP : Math.floor(today * size)
  return Math.max(today, Math.min(most, Math.floor(today * size)))
}

// ---- how big the backdrop is drawn ---------------------------------------------------------------------
// The cabinets' OWN size settings (Jackpot's JP2L_STORE.size, the slots' SM_SCALE_STATE), set by their own
// sliders. A size above 1 also grows the stage's room, so a bigger machine really is drawn bigger. (The
// Games page's copy of these controls was removed, owner 2026-11-18: "don't seem to work, remove those".)
const BACKDROP_MOST_SHARE = 0.95

function backdropGrowth() {
  const jackpot = Number(JP2L_STORE.size) || 1
  const slots = Number(SM_SCALE_STATE.value) || 1
  return Math.max(1, jackpot, slots)
}

// The stage's span: the composer's own at today's size; a bigger size widens it by the same factor,
// centred on the composer and kept inside the window, so two machines side by side grow too.
const BACKDROP_EDGE = 16
function overchatStageSpan(left, width, size) {
  const grow = Number(size) > 1 ? Number(size) : 1
  if (grow === 1) return { left, width }
  const win = overchatWindow()
  const view = win && Number(win.innerWidth) > 0 ? Number(win.innerWidth) : 0
  if (!view) return { left, width }
  const wide = Math.min(Math.floor(width * grow), Math.max(width, view - 2 * BACKDROP_EDGE))
  const centre = left + width / 2
  const from = Math.min(Math.max(BACKDROP_EDGE, Math.round(centre - wide / 2)), Math.max(BACKDROP_EDGE, view - BACKDROP_EDGE - wide))
  return { left: from, width: wide }
}

// WHERE THE FIXED BOX LIVES. The Desktop's composer dock is centred with a CSS transform
// (`-translate-x-1/2`), and a transform traps every fixed child inside it: drawn from the composer slot,
// the stage could never reach the top of the window, and the fallback put the machines under the
// composer on every real Desktop. So the two jobs are split between two of our own contributions:
//
//   - OverChatStrip, in the composer's underside slot, is the ANCHOR: it exists exactly while the
//     conversation is on screen, and it measures its own left edge and width and shares them here.
//   - OverChatStage, in the status bar, DRAWS the fixed stage from those numbers. The status bar has no
//     transformed ancestor, so a fixed box there is placed against the window.
//
// The status bar is not always there: Simple mode rests it hidden, and anyone may hide it. So a second
// stage waits in the titlebar's right cluster, which the main window always draws and which is a fixed box
// with no transform. It is only the stand-in: that cluster sits above the app's panels and dialogs, and a
// machine drawn from it would sit above them too, so it draws only while the status-bar stage cannot.
//
// The stage still checks where it landed; if a host traps both stages, or neither mounts, the strip draws
// the machines in the slot itself, as before.
const OVERCHAT_SPOT = { left: 0, width: 0, anchored: false, stage: 'none', drawer: null, stages: {}, listeners: new Set() }

// The backdrop is a picture. Every machine copy is a whole cabinet, with its own buttons, sliders and
// pills, and several of them switch clicks back on for themselves (pointer-events: auto inline, or a
// stage rule). Over the conversation that took clicks meant for the chat (owner, 2026-11-17: "the buttons
// and sliders shouldn't work and should not interfere with other buttons or clickables as it has in the
// past"). One rule of our own, inside our own elements, wins over all of them: nothing in it takes a click.
// The second selector list out-ranks the cabinet's own `[data-jp2-stage] .jp2-machine [data-jp2="overchat-row"]
// button { pointer-events: auto !important }` (19-jackpot2-layer.js), which is more specific than `*`.
const OVERCHAT_NO_CLICKS = '[data-overchat="stage"], [data-overchat="stage"] *, [data-overchat="strip"], [data-overchat="strip"] *, ' +
  '[data-overchat] [data-jp2-stage] .jp2-machine [data-jp2="overchat-row"] button, [data-overchat] [data-jp2-stage] [data-jp2-control] ' +
  '{ pointer-events: none !important; cursor: default !important; }'
const overchatNoClicks = () => jsx('style', { 'data-overchat': 'no-clicks', children: OVERCHAT_NO_CLICKS }, 'no-clicks')

// Which stage draws: the first in this list that is mounted and not trapped.
const OVERCHAT_STAGE_ORDER = ['statusbar', 'titlebar']

function overchatStageTurn(where) {
  for (const name of OVERCHAT_STAGE_ORDER) {
    if (OVERCHAT_SPOT.stages[name] === 'ready') return name === where
  }
  return false
}

function overchatStageMark(where, value) {
  const stages = { ...OVERCHAT_SPOT.stages }
  if (value) stages[where] = value
  else delete stages[where]
  overchatShare({ stages })
}

function overchatShare(patch) {
  let changed = false
  for (const key of Object.keys(patch)) {
    if (OVERCHAT_SPOT[key] !== patch[key]) { OVERCHAT_SPOT[key] = patch[key]; changed = true }
  }
  if (changed) for (const listener of Array.from(OVERCHAT_SPOT.listeners)) listener()
}

// Re-render whenever the shared anchor or stage state changes.
function useOverchatSpot() {
  const [, setTick] = useState(0)
  useEffect(() => {
    const listener = () => setTick(count => count + 1)
    OVERCHAT_SPOT.listeners.add(listener)
    return () => { OVERCHAT_SPOT.listeners.delete(listener) }
  }, [])
  return OVERCHAT_SPOT
}

// The machines themselves, for a given width and height budget. Shared by the stage and the fallback.
function overchatCells(ctx, slotsOn, jackpotOn, width, budget) {
  const both = Boolean(slotsOn && jackpotOn)
  const share = both ? Math.max(0, width - OVERCHAT_GAP) / 2 : width
  return [
    slotsOn ? jsx('div', {
      'data-overchat': 'slots',
      style: { ...OVERCHAT_SLOT, width: share ? share : '100%' },
      children: jsx(SlotsOverChatCopy, { ctx, width: share, height: budget })
    }, 'slots') : null,
    jackpotOn ? jsx('div', {
      'data-overchat': 'jackpot',
      style: { ...OVERCHAT_SLOT, width: share ? share : '100%' },
      children: jsx(jp2LOverChatCopy, { ctx, width: share, height: budget })
    }, 'jackpot') : null
  ]
}

function OverChatStrip({ ctx }) {
  const [slotsOn] = useSmOverchat()
  const [jackpotOn] = useJp2LOverchat(ctx)
  const spot = useOverchatSpot()
  const anchor = useRef(null)
  const [resized, setResized] = useState(0)
  const on = Boolean(slotsOn || jackpotOn)

  // The anchor's box changes when the composer does: a pane opening, the window moving between screens,
  // a sash being dragged. A ResizeObserver sees all of those as one event on our own element, and the
  // window listener catches the window itself changing size.
  //
  // It depends on `on`: the anchor exists ONLY while a switch is on, so a mount with both switches off
  // has no element to observe. Depending on `on` re-runs the effect on the switch, and because React
  // commits before effects run, the element is there to be measured and watched.
  useJpLayoutEffect(() => {
    if (!on) return undefined
    setResized(count => count + 1)
    const node = anchor.current
    let watcher = null
    if (typeof ResizeObserver !== 'undefined' && node) {
      try {
        watcher = new ResizeObserver(() => setResized(count => count + 1))
        watcher.observe(node)
      } catch {
        watcher = null
      }
    }
    const win = overchatWindow()
    const onWindowResize = () => setResized(count => count + 1)
    const listening = Boolean(win && typeof win.addEventListener === 'function')
    if (listening) win.addEventListener('resize', onWindowResize)
    return () => {
      if (watcher && typeof watcher.disconnect === 'function') watcher.disconnect()
      if (listening && typeof win.removeEventListener === 'function') win.removeEventListener('resize', onWindowResize)
      overchatShare({ anchored: false })
    }
  }, [on])

  // Share the anchor's own box with the stage after every layout that may have moved it.
  useJpLayoutEffect(() => {
    if (!on) return undefined
    const box = overchatAnchor(anchor)
    // The window's own size goes along: a window that only gets shorter or taller moves nothing the
    // anchor measures, and the stage's height budget still has to follow it (Codex review, 2026-11-17).
    const win = overchatWindow()
    const viewHeight = win && Number(win.innerHeight) > 0 ? Number(win.innerHeight) : 0
    const viewWidth = win && Number(win.innerWidth) > 0 ? Number(win.innerWidth) : 0
    overchatShare({ left: box.left, width: box.width, anchored: box.width > 0, viewHeight, viewWidth })
    return undefined
  }, [on, resized])

  if (!on) return null
  const box = overchatAnchor(anchor)

  if (spot.stage !== 'top') {
    // The fallback: the status-bar stage is not drawing (hidden bar, or a host that traps it), so the
    // machines are laid out in the slot itself, exactly as wide as the composer — drawn, which is the point.
    return jsx('div', {
      'data-overchat': 'strip',
      'data-overchat-place': 'slot',
      ref: anchor,
      style: {
        width: '100%',
        minWidth: 0,
        display: 'flex',
        gap: OVERCHAT_GAP,
        alignItems: 'flex-end',
        justifyContent: 'center',
        // The row is a picture: nothing in it may take a click from the conversation. Each machine's own
        // dismissal controls opt back in (19-jackpot2-layer.js, jp2LStyleRules).
        pointerEvents: 'none'
      },
      children: [overchatNoClicks(), ...overchatCells(ctx, slotsOn, jackpotOn, box.width, undefined)]
    })
  }

  // The stage is drawing at the top: the slot keeps only a zero-height anchor, so the composer keeps its
  // own height and the stage reads this element's left edge and width.
  return jsx('div', {
    'data-overchat': 'strip',
    'data-overchat-place': 'top',
    ref: anchor,
    style: { width: '100%', minWidth: 0, height: 0, minHeight: 0, pointerEvents: 'none' }
  })
}

function OverChatStage({ ctx, where = 'statusbar' }) {
  const [slotsOn] = useSmOverchat()
  const [jackpotOn] = useJp2LOverchat(ctx)
  const spot = useOverchatSpot()
  const stage = useRef(null)
  // Re-render when either cabinet's size moves: the stage's room grows with it.
  useJp2LSize(ctx)
  useSmScale()
  const size = backdropGrowth()
  // 'top' until the stage's own rect says otherwise. Only ever set away from 'top': a host that traps a
  // fixed box once traps it on every render, so retrying would only cost renders.
  const [place, setPlace] = useState('top')
  const on = Boolean(slotsOn || jackpotOn)

  // Say this stage is here (and whether it is trapped), and take it back when it goes. An effect, not a
  // layout effect: it must run after useOverchatSpot has subscribed, or this stage misses its own news.
  useEffect(() => {
    overchatStageMark(where, place === 'top' ? 'ready' : 'trapped')
    return undefined
  }, [where, place])
  useEffect(() => () => overchatStageMark(where, null), [where])

  const drawing = on && spot.anchored && spot.width > 0 && place === 'top' && overchatStageTurn(where)

  // Did the fixed box actually arrive at the top of the window? Its own rect is the only honest answer:
  // a transform, a filter or `contain` on an ancestor silently moves it into that ancestor.
  useJpLayoutEffect(() => {
    if (!drawing) return undefined
    const node = stage.current
    if (!node || typeof node.getBoundingClientRect !== 'function') return undefined
    const rect = node.getBoundingClientRect()
    const top = rect ? Number(rect.top) : NaN
    if (!Number.isFinite(top)) return undefined
    if (Math.abs(top - OVERCHAT_TOP) > OVERCHAT_TOP_SLACK) {
      setPlace('slot')
      overchatShare({ stage: 'trapped', drawer: null })
    } else {
      overchatShare({ stage: 'top', drawer: where })
    }
    return undefined
  }, [drawing, spot.left, spot.width, where])

  // A stage that is not drawing hands the machines back to the slot.
  useEffect(() => {
    // Only the stage that is drawing may say so: the stand-in waiting its turn must not wipe the other's 'top'.
    if (!drawing && OVERCHAT_SPOT.drawer === where) overchatShare({ stage: 'none', drawer: null })
  }, [drawing, where])
  useEffect(() => () => { if (OVERCHAT_SPOT.drawer === where) overchatShare({ stage: 'none', drawer: null }) }, [where])

  if (!drawing) return null
  const { left, width } = overchatStageSpan(spot.left, spot.width, size)
  const budget = overchatStageHeight()
  return jsx('span', {
    'data-overchat': 'stage-host',
    style: { display: 'inline-block', width: 0, height: 0, overflow: 'visible' },
    children: [overchatNoClicks(), jsx('div', {
      'data-overchat': 'stage',
      ref: stage,
      style: {
        position: 'fixed',
        top: OVERCHAT_TOP,
        left,
        width,
        height: budget || 0,
        display: 'flex',
        gap: OVERCHAT_GAP,
        alignItems: 'flex-start',
        justifyContent: 'center',
        boxSizing: 'border-box',
        // A picture over the conversation: see-through, watch-only, and never a click taken from the chat.
        pointerEvents: 'none',
        // Above the plugin's own in-page pieces (they stay at 10 and below) and below the panels and
        // dialogs that use 40 and up, so a see-through machine can never end up over the app's own chrome.
        zIndex: 20,
        overflow: 'hidden'
      },
      children: overchatCells(ctx, slotsOn, jackpotOn, width, budget)
    }, 'stage')]
  })
}
