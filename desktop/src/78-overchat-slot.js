// ---- 78-overchat-slot.js: the see-through machines, in the composer's own slot
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
//   - the slot decides WHERE. It is part of the conversation's composer, so it exists exactly while the
//     conversation is on screen: no route sniffing, no DOM test, nothing to keep the machine off the
//     Games page, Settings or another plugin's page.
//   - the slot decides HOW WIDE. This component measures ITS OWN box (the one element it is allowed to
//     measure) and hands each machine its share: the whole width for one, the two halves for both.
//   - the machines decide their own look. Each copy fits itself into that share, keeps its own opacity,
//     and is watch-only (it must never take a click the conversation wanted).
//
// The strip is drawn only while at least one switch is on, so its height is zero — and the composer's
// underside is empty — whenever nobody asked for a machine.
const OVERCHAT_GAP = 10

// What one machine's slot looks like. `minWidth: 0` matters: without it a flex item refuses to shrink
// below its content, and a wide cabinet would push the strip past the composer instead of being fitted.
const OVERCHAT_SLOT = { minWidth: 0, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }

// The strip's own width, read from the element it owns. Read on every render rather than kept in state:
// one property, one element of ours, and a ResizeObserver only has to ask for a new render.
function overchatStripWidth(ref) {
  const node = ref && ref.current
  if (!node) return 0
  if (typeof node.getBoundingClientRect === 'function') {
    const rect = node.getBoundingClientRect()
    const width = rect ? Number(rect.width) || 0 : 0
    if (width > 0) return width
  }
  return Number(node.clientWidth) || 0
}

function OverChatStrip({ ctx }) {
  const [slotsOn] = useSmOverchat()
  const [jackpotOn] = useJp2LOverchat(ctx)
  const box = useRef(null)
  const [, setResized] = useState(0)
  const on = Boolean(slotsOn || jackpotOn)

  // Our own box, and nothing else. A ResizeObserver rather than a window listener: the composer changes
  // width when a pane opens, when the window moves between screens and when the person drags a sash —
  // all of those are the same event to this element.
  //
  // It depends on `on` and no other value: the strip's div exists ONLY while a switch is on, so a mount
  // with both switches off has no element to observe.
  // With `[]` the effect ran once against `null`, never attached, and never ran again — turning a machine
  // on afterwards rendered it at width 0 for good (the Jackpot v2 copy draws nothing at 0). Depending on
  // `on` re-runs the effect on the switch, and because React commits before effects run, the element is
  // there to be measured and watched.
  useJpLayoutEffect(() => {
    if (!on) return undefined
    // One render after the switch, because the ref is only filled in once the tree is committed: this
    // render asked for the div, the next one can read its width. (A strip already at its final width
    // fires no resize event, so nothing else would ask.)
    setResized(count => count + 1)
    const node = box.current
    if (typeof ResizeObserver === 'undefined' || !node) return undefined
    let watcher = null
    try {
      watcher = new ResizeObserver(() => setResized(count => count + 1))
      watcher.observe(node)
    } catch {
      return undefined
    }
    return () => { if (watcher && typeof watcher.disconnect === 'function') watcher.disconnect() }
  }, [on])

  const width = overchatStripWidth(box)
  if (!on) return null
  const both = Boolean(slotsOn && jackpotOn)
  const share = both ? Math.max(0, width - OVERCHAT_GAP) / 2 : width
  return jsx('div', {
    'data-overchat': 'strip',
    ref: box,
    style: {
      width: '100%',
      minWidth: 0,
      display: 'flex',
      gap: OVERCHAT_GAP,
      alignItems: 'flex-end',
      justifyContent: 'center',
      // The strip is a picture: nothing in it may take a click from the conversation. Each machine's own
      // dismissal controls opt back in (19-jackpot2-layer.js, jp2LStyleRules).
      pointerEvents: 'none'
    },
    children: [
      slotsOn ? jsx('div', {
        'data-overchat': 'slots',
        style: { ...OVERCHAT_SLOT, width: share ? share : '100%' },
        children: jsx(SlotsOverChatCopy, { ctx, width: share })
      }, 'slots') : null,
      jackpotOn ? jsx('div', {
        'data-overchat': 'jackpot',
        style: { ...OVERCHAT_SLOT, width: share ? share : '100%' },
        children: jsx(jp2LOverChatCopy, { ctx, width: share })
      }, 'jackpot') : null
    ]
  })
}
