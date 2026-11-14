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
//     as wide as the anchor and centred over it, and no taller than OVERCHAT_MAX_HEIGHT or a share of
//     the window. They keep their own opacity, their own size preference and their own aspect ratio: the
//     cabinet is a picture that scales, never a box that stretches.
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
// are a see-through picture on top of it, not a page of their own.
const OVERCHAT_VIEW_SHARE = 0.42

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
// person is looking at the machines may cover — not a measurement of the app, and it is capped by the
// height budget a machine in a conversation is allowed at all.
function overchatStageHeight() {
  const win = overchatWindow()
  const view = win && Number(win.innerHeight) > 0 ? Number(win.innerHeight) : 0
  const share = view > 0 ? Math.floor(view * OVERCHAT_VIEW_SHARE) : OVERCHAT_MAX_HEIGHT
  return Math.max(0, Math.min(OVERCHAT_MAX_HEIGHT, share))
}

function OverChatStrip({ ctx }) {
  const [slotsOn] = useSmOverchat()
  const [jackpotOn] = useJp2LOverchat(ctx)
  const anchor = useRef(null)
  const stage = useRef(null)
  const [, setResized] = useState(0)
  // 'top' draws the machines in the fixed stage; 'slot' is the fallback for a host that traps fixed
  // positioning inside the composer. Only ever set away from 'top': a host that traps it once traps it
  // on every render, so retrying would only cost renders.
  const [place, setPlace] = useState('top')
  const on = Boolean(slotsOn || jackpotOn)

  // The anchor's box changes when the composer does: a pane opening, the window moving between screens,
  // a sash being dragged. A ResizeObserver sees all of those as one event on our own element, and the
  // window listener catches the one case the observer cannot — the window itself moving under a fixed
  // box, which changes where the top of the window is without changing our width.
  //
  // It depends on `on` and no other value: the anchor exists ONLY while a switch is on, so a mount with
  // both switches off has no element to observe. With `[]` the effect ran once against `null`, never
  // attached, and never ran again — turning a machine on afterwards rendered it at width 0 for good (the
  // Jackpot v2 copy draws nothing at 0). Depending on `on` re-runs the effect on the switch, and because
  // React commits before effects run, the element is there to be measured and watched.
  useJpLayoutEffect(() => {
    if (!on) return undefined
    // One render after the switch, because the ref is only filled in once the tree is committed: this
    // render asked for the anchor, the next one can read its box. (An element already at its final width
    // fires no resize event, so nothing else would ask.)
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
    }
  }, [on])

  // Did the fixed box actually arrive at the top of the window? Its own rect is the only honest answer:
  // a transform, a filter or `contain` on an ancestor silently moves it into that ancestor. When it did
  // not arrive, the machines are drawn in the slot instead — the layout that cannot be trapped.
  useJpLayoutEffect(() => {
    if (!on || place !== 'top') return undefined
    const node = stage.current
    if (!node || typeof node.getBoundingClientRect !== 'function') return undefined
    const rect = node.getBoundingClientRect()
    const top = rect ? Number(rect.top) : NaN
    if (!Number.isFinite(top)) return undefined
    if (Math.abs(top - OVERCHAT_TOP) > OVERCHAT_TOP_SLACK) setPlace('slot')
    return undefined
  }, [on, place])

  if (!on) return null
  const box = overchatAnchor(anchor)
  const width = box.width
  const both = Boolean(slotsOn && jackpotOn)
  const share = both ? Math.max(0, width - OVERCHAT_GAP) / 2 : width
  // The height budget handed to each machine: the stage's own height at the top of the window, and
  // nothing (the machines' own budget) in the fallback, where the slot sizes the row.
  const budget = place === 'top' ? overchatStageHeight() : undefined
  const cells = [
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

  if (place !== 'top') {
    // The fallback: the machines are laid out in the slot itself, exactly as wide as the composer and
    // nowhere near the top of the window — but drawn, which is the point, in a host that traps fixed.
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
      children: cells
    })
  }

  return jsx('div', {
    'data-overchat': 'strip',
    'data-overchat-place': 'top',
    ref: anchor,
    style: {
      // A zero-height anchor: the slot keeps the composer's height, and the machines are drawn from this
      // element's own left edge and width. The fixed stage below is out of flow, so it adds no height
      // either — the row, its gap and its centring are here only so the two cells and the stage they sit
      // in measure the same slot.
      width: '100%',
      minWidth: 0,
      height: 0,
      minHeight: 0,
      display: 'flex',
      gap: OVERCHAT_GAP,
      alignItems: 'flex-start',
      justifyContent: 'center',
      pointerEvents: 'none'
    },
    children: jsx('div', {
      'data-overchat': 'stage',
      ref: stage,
      style: {
        position: 'fixed',
        top: OVERCHAT_TOP,
        left: box.left,
        width: width ? width : 0,
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
      children: cells
    }, 'stage')
  })
}
