// ---- 19-jackpot-overlay.js: the slot cabinet in the composer's strip, and its status-bar chip
//
// Two surfaces: the chip in the status bar (the switch, the running total, and the panel a click opens),
// and the see-through copy of the cabinet that 78-overchat-slot.js draws in the composer's underside
// slot. The copy is a slot contribution, not an overlay: nothing here measures the app, appends to its
// <body> or reads the route (review, 2026-11-12).

const JP_STORE = { open: false, listeners: new Set() }
const JP_STORAGE_KEY = 'gameshelf.jackpot.overlay'

// React's layout effect where the host has one, the ordinary effect where it does not (the harnesses
// stub exactly the hooks a part is allowed to use, and they stub useEffect). It is used to attach a
// ResizeObserver and to ask for the one render that follows a mount, because a ref is only filled in once
// the tree is committed. Resolved per call, never at load: a harness hands the bundle its hook stubs
// after loading it, so a name read at load time would simply not be there.
function useJpLayoutEffect(fn, deps) {
  const hook = typeof useLayoutEffect === 'function' ? useLayoutEffect : useEffect
  return hook(fn, deps)
}

// A cabinet that has not been measured yet is drawn at 100% in a zero-sized box (see the copy below):
// that is what makes its own size measurable at all, and one render later the fitted size replaces it.

function JP_readOpen() {
  try {
    return window.localStorage.getItem(JP_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

JP_STORE.open = JP_readOpen()

function JP_writeOpen(open) {
  try {
    window.localStorage.setItem(JP_STORAGE_KEY, open ? '1' : '0')
  } catch {
    // Storage can be missing or refuse writes; the overlay still works for this visit.
  }
}

function jpSetOpen(value) {
  const open = !!value
  JP_STORE.open = open
  JP_writeOpen(open)
  JP_STORE.listeners.forEach(listener => listener(open))
}

function useJpOpen() {
  const [open, setOpen] = useState(JP_STORE.open)
  useEffect(() => {
    const listener = value => setOpen(value)
    JP_STORE.listeners.add(listener)
    setOpen(JP_STORE.open)
    return () => { JP_STORE.listeners.delete(listener) }
  }, [])
  return [open, jpSetOpen]
}

function JP_chips(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number.toLocaleString() : '0'
}

function JP_pick(list) {
  return list[Math.floor(Math.random() * list.length)]
}

// The last good /jackpot answer, shared by every view of the machine. The status item polls
// constantly and the over-chat machine mounts later, so seeding from here means it opens
// with the real reels and chip count instead of an empty cabinet.
let JP_LAST = null

// One reader for the machine, so every view fails in the same, explainable way.
async function jpRead(ctx) {
  if (!ctx || typeof ctx.rest !== 'function') throw new Error('this window has no shelf connection')
  return ctx.rest('/jackpot')
}
// Turn whatever went wrong into something a person can act on.
function jpReason(err) {
  const raw = String((err && (err.message || err.error || err.detail)) || err || '').trim()
  if (/404|not found|unknown (route|endpoint|method)/i.test(raw)) return 'the game center plugin in this window is older than the shelf - restart Hermes'
  if (/timeout|timed out|abort/i.test(raw)) return 'it took too long to answer'
  if (/ECONNREFUSED|ENOTFOUND|offline|network/i.test(raw)) return 'the connection was refused'
  if (!raw) return 'it did not answer'
  return raw.length > 130 ? `${raw.slice(0, 130)}…` : raw
}
// How many views of the machine are on screen. Auto-spin runs only while this is above zero,
// so nothing spins behind a closed machine - the whole point of "spins only while visible".
let JP_VIEWERS = 0
async function jpVisible(delta, send) {
  JP_VIEWERS = Math.max(0, JP_VIEWERS + delta)
  const on = JP_VIEWERS > 0
  if (!send) return
  try { await send('/jackpot/visible', { on }) } catch { /* a failed report just means no spin */ }
}

function JackpotStatusItem({ ctx }) {
  SM_API.rest = (path, opts) => ctx.rest(path, opts)
  // The chip is only part of the status bar when the person has asked for the over-chat machine
  // (owner's ask, 2026-11-09). The switch that turns it on lives in the Slots table's settings, so
  // nothing appears in the bar until it is wanted, and turning it off there removes it again.
  const [open, setOpen] = useJpOpen()
  const [data, setData] = useState(null)
  // Why the last read failed, so the chip never shows a made-up 0.
  const [trouble, setTrouble] = useState('')
  const [ticker, setTicker] = useState(null)
  const [overchatOn] = useSmOverchat()
  // The switch and its drawing preferences are adopted HERE as well as in the table, because the
  // table may not be mounted: this item returns null while the copy is off, so nothing inside it
  // ever runs, and the copy could only be switched on from a screen that was itself hidden. That
  // deadlock is why the machine never came back after a rebuild even though the wallet said it was
  // on (found 2026-11-10, with Claude's read of the same path).
  useEffect(() => {
    if (data && data.overchat) SM_adoptPrefs(data.overchat)
  }, [data && data.overchat && data.overchat.on, data && data.overchat && data.overchat.alpha,
      data && data.overchat && data.overchat.scale])
  const lastFeed = useRef('')
  const dataRef = useRef(null)
  const tickTimer = useRef(null)
  const landTimer = useRef(null)
  const glowTimer = useRef(null)
  const holdTimer = useRef(null)
  const loadNow = useRef(null)
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const next = await jpRead(ctx)
        JP_LAST = next
        dataRef.current = next
        if (alive) { setData(next); setTrouble('') }
      } catch (err) {
        // A failed read keeps the last known numbers and says why on hover.
        if (alive) setTrouble(jpReason(err))
      }
    }
    loadNow.current = load
    load()
    const timer = setInterval(load, 600)
    return () => { alive = false; clearInterval(timer) }
  }, [ctx])
  // The spin is recorded when the turn starts, which is the moment the message is sent.
  // Ask the shelf then, instead of making the person wait out a poll: the reels should run
  // as the message goes, which is what "auto-spin every reply" is supposed to look like.
  useEffect(() => {
    if (!SDK_HOST || typeof SDK_HOST.onEvent !== 'function') return undefined
    let stop = () => {}
    const pull = () => {
      if (loadNow.current) loadNow.current()
      const latest = dataRef.current
      if (latest && latest.autoplay && SM_PULL.listeners.size > 0) smPullAll()
    }
    try {
      stop = SDK_HOST.onEvent('message.start', () => {
        pull()
        setTimeout(() => { if (loadNow.current) loadNow.current() }, 400)
      }) || stop
    } catch {
      // An older host has no event stream; the poll still catches the spin.
    }
    return () => { try { stop() } catch { /* nothing to unwire */ } }
  }, [])
  useEffect(() => {
    const row = data && data.feed && data.feed[0]
    if (!row) return undefined
    const stamp = String(row.at == null ? '' : row.at)
    if (stamp === lastFeed.current) return undefined
    lastFeed.current = stamp
    if (tickTimer.current) {
      clearInterval(tickTimer.current)
      tickTimer.current = null
    }
    if (landTimer.current) {
      clearTimeout(landTimer.current)
      landTimer.current = null
    }
    if (glowTimer.current) {
      clearTimeout(glowTimer.current)
      glowTimer.current = null
    }
    if (holdTimer.current) {
      clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
    const machine = ((data && data.machines) || []).find(item => item.id === row.machine)
    const strips = (machine && machine.strips) || []
    const pool = strips.flat().filter(Boolean)
    const symbols = pool.length ? pool : (row.reels && row.reels.length ? row.reels : ['🍒', '🔔', '💎'])
    setTicker({ symbols: [JP_pick(symbols), JP_pick(symbols), JP_pick(symbols)], payout: 0, glow: false })
    let ticks = 0
    tickTimer.current = setInterval(() => {
      ticks += 1
      if (ticks >= 15) {
        clearInterval(tickTimer.current)
        tickTimer.current = null
        return
      }
      setTicker({ symbols: [JP_pick(symbols), JP_pick(symbols), JP_pick(symbols)], payout: 0, glow: false })
    }, 80)
    landTimer.current = setTimeout(() => {
      landTimer.current = null
      if (tickTimer.current) {
        clearInterval(tickTimer.current)
        tickTimer.current = null
      }
      const payout = Number(row.payout) > 0 ? Number(row.payout) : 0
      setTicker({
        symbols: row.reels && row.reels.length ? row.reels : ['🎰', '🎰', '🎰'],
        payout,
        glow: payout > 0
      })
      if (payout > 0) {
        glowTimer.current = setTimeout(() => {
          glowTimer.current = null
          setTicker(current => current ? { ...current, glow: false } : current)
        }, 700)
      }
      // The landed symbols stay in the status bar until the next spin: the strip is the same
      // machine the table is playing, so it should keep showing the game's last result rather
      // than blinking for three seconds and going blank.
    }, 1200)
    return () => {
      if (tickTimer.current) {
        clearInterval(tickTimer.current)
        tickTimer.current = null
      }
      if (landTimer.current) {
        clearTimeout(landTimer.current)
        landTimer.current = null
      }
      if (glowTimer.current) {
        clearTimeout(glowTimer.current)
        glowTimer.current = null
      }
      if (holdTimer.current) {
        clearTimeout(holdTimer.current)
        holdTimer.current = null
      }
    }
  }, [data])
  useEffect(() => () => {
    if (tickTimer.current) {
      clearInterval(tickTimer.current)
      tickTimer.current = null
    }
    if (landTimer.current) {
      clearTimeout(landTimer.current)
      landTimer.current = null
    }
    if (glowTimer.current) {
      clearTimeout(glowTimer.current)
      glowTimer.current = null
    }
    if (holdTimer.current) {
      clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
  }, [])
  const chips = data ? JP_chips(data.chips) : '…'
  const reward = data && Number(data.reward) > 0 ? Math.round(Number(data.reward)) : 0
  const label = `🍒 ${chips}`
  const toggle = () => setOpen(!open)
  const close = () => setOpen(false)
  const shown = ticker
    ? jsxs('span', {
      style: { display: 'inline-flex', alignItems: 'center', gap: 4 },
      children: [
        jsx('span', { children: ticker.symbols.join(' ') }),
        ticker.payout > 0 ? jsx('span', {
          style: { color: '#facc15', fontWeight: 700 },
          children: `+${JP_chips(ticker.payout)}`
        }) : null
      ]
    })
    : jsx('span', { children: label })
  // Nothing in the status bar unless the over-chat machine is on: the chip is how it is reached,
  // and the Slots table's own switches are how it is turned back on, off or changed.
  if (!overchatOn) return null
  // A small badge says there are reward chips waiting to be cashed in, without taking
  // the cherry and chip count away from the status item.
  const rewardBadge = reward ? jsx('span', {
    'data-games-jackpot': 'reward-badge',
    title: `${JP_chips(reward)} reward chips ready to cash in`,
    style: {
      background: '#d9a441', color: '#2a1a12', borderRadius: 999, padding: '0 4px',
      fontSize: 9, fontWeight: 800, lineHeight: '14px'
    },
    children: `+${JP_chips(reward)}`
  }) : null
  return jsxs('span', {
    'data-games-jackpot': 'status-wrap',
    style: { display: 'inline-flex', alignItems: 'center' },
    children: [
      jsx('button', {
        type: 'button',
        'data-games-jackpot': 'status',
        'aria-label': `Slots: ${chips} chips`,
        title: trouble ? `Slots: could not read your chips - ${trouble}` : 'Slots: click to open the slot machine',
        onClick: toggle,
        autoFocus: false,
        style: {
          // Owner's note, 2026-11-09: the chip was a small target in a wide bar. It is a proper
          // button now - taller, with room around the label - while staying one row high.
          display: 'flex', gap: 6, alignItems: 'center',
          padding: '2px 9px', minHeight: 22, border: 'none', background: 'transparent',
          color: text.primary, fontSize: 12, cursor: 'pointer',
          boxShadow: ticker && ticker.glow ? '0 0 10px rgba(250,204,21,0.9)' : 'none',
          borderRadius: 6
        },
        children: jsxs('span', {
          style: { display: 'inline-flex', alignItems: 'center', gap: 4 },
          children: [shown, rewardBadge]
        })
      }),
      open ? jsx(JackpotOverlay, { ctx, onClose: close }) : null
    ]
  })
}

function JackpotOverlay({ ctx, onClose, data }) {
  const [snapshot, setSnapshot] = useState(data || JP_LAST || null)
  const autoplaySwitch = useJpAutoplay(snapshot && snapshot.autoplay)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [trouble, setTrouble] = useState('')
  useEffect(() => {
    if (data) {
      setSnapshot(data)
      return undefined
    }
    let alive = true
    let wait = 600
    let timer = null
    const load = async () => {
      try {
        const next = await jpRead(ctx)
        if (!alive) return
        setSnapshot(next)
        setTrouble('')
        wait = 600
      } catch (err) {
        if (!alive) return
        // Say why, and look less often the longer it stays down, instead of spinning forever.
        setTrouble(jpReason(err))
        wait = Math.min(1500, Math.round(wait * 1.8))
      }
      if (alive) timer = setTimeout(load, wait)
    }
    load()
    return () => { alive = false; clearTimeout(timer) }
  }, [ctx, data])
  const door = (path, body) => ctx.rest(path, { method: 'POST', body })
  // Auto-spin is a switch, not a move: it answers even while a spin is running, and it shows
  // the shelf's own answer so the box cannot lie about what the reply hook will do.
  const setAutoplay = async on => {
    const id = autoplaySwitch.begin(on)
    try {
      const answer = await door('/jackpot/autoplay', { on })
      const confirmed = answer && typeof answer.autoplay === 'boolean' ? answer.autoplay : undefined
      if (!autoplaySwitch.finish(id, confirmed)) return
      if (confirmed === undefined) {
        setNote('The shelf did not confirm the auto-spin switch. Try again.')
        return
      }
      setSnapshot(answer)
      setNote('')
    } catch (err) {
      if (autoplaySwitch.finish(id, undefined)) setNote(`The shelf did not take that: ${jpReason(err)}.`)
    }
  }
  const post = async (path, body) => {
    if (busy) return null
    setBusy(true)
    setNote('')
    try {
      const options = body === undefined ? { method: 'POST' } : { method: 'POST', body }
      const answer = await ctx.rest(path, options)
      setSnapshot(answer)
      return answer
    } catch {
      setNote('The slot machine could not reach the shelf. Try again.')
      return null
    } finally {
      setBusy(false)
    }
  }
  const machines = (snapshot && snapshot.machines) || []
  const machineId = (snapshot && snapshot.machine) || (machines[0] && machines[0].id) || ''
  const machine = machines.find(item => item.id === machineId) || machines[0] || null
  const feed = (snapshot && snapshot.feed) || []
  const newest = feed[0] || null
  const result = newest && machine && newest.machine === machine.id ? newest : null
  const chips = snapshot && snapshot.chips
  const bet = Number(snapshot && snapshot.bet) || 0
  const bets = (snapshot && snapshot.bets) || []
  const odds = (snapshot && snapshot.odds) || null
  const autoplay = autoplaySwitch.value
  const canSpin = Number(chips) >= bet && bet > 0
  // Opening this overlay puts the machine on screen; closing it takes it away.
  useEffect(() => {
    jpVisible(1, door)
    return () => jpVisible(-1, door)
  }, [ctx])
  const close = () => { if (typeof onClose === 'function') onClose() }
  const closeButton = jsx('button', {
    type: 'button',
    'data-jackpot': 'close',
    'aria-label': 'Close the slots machine',
    onClick: close,
    style: {
      width: 22, height: 22, padding: 0, borderRadius: 6,
      border: `1px solid ${stroke}`, background: 'transparent',
      color: text.secondary, fontSize: 14, lineHeight: '18px', cursor: 'pointer'
    },
    children: '×'
  })
  const header = jsxs('div', {
    'data-jackpot': 'header',
    style: {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      marginBottom: 8, pointerEvents: 'auto'
    },
    children: [
      jsx('span', { style: { fontSize: 13, fontWeight: 700, color: '#facc15' }, children: 'Slots' }),
      closeButton
    ]
  })
  // This is the sidebar copy of the machine: always a real, clickable panel in the corner.
  // The see-through copy over the chat is its own component below, mounted by the status item
  // so it is there whether or not this panel is open.
  // Owner's note, 2026-11-09: the panel was sprawling over the session. It is bounded by the window
  // and by the chat column it sits beside, scrolls its own body, and never grows wider than the
  // conversation it is covering.
  const style = {
    position: 'fixed', right: 16, bottom: 48, zIndex: 60,
    maxWidth: 'min(360px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 96px)',
    overflowY: 'auto', overscrollBehavior: 'contain',
    background: 'rgba(15,10,30,0.86)', backdropFilter: 'blur(6px)',
    borderRadius: 14, padding: 8, color: text.primary, fontSize: 12,
    boxSizing: 'border-box', pointerEvents: 'auto'
  }
  return jsxs('div', {
    'data-jackpot': 'overlay',
    role: 'dialog',
    'aria-label': 'Slots',
    style,
    children: [
      header,
      jsx(SlotMachine, {
        machine,
        machines,
        result,
        chips,
        bet,
        bets,
        odds,
        autoplay,
        busy,
        canSpin,
        rewards: snapshot,
        onCashin: () => post('/jackpot/cashin'),
        onPoints: points => post('/jackpot/points/cash', points ? { points } : {}),
        onBailout: grade => post('/jackpot/bailout', { grade }),
        onEgg: id => post('/eggs/claim', { id }),
        paytable: (snapshot && snapshot.paytable) || [],
        compact: true,
        onSpin: () => post('/jackpot/spin'),
        onPickMachine: id => post('/jackpot/machine', { machine: id }),
        onBet: amount => post('/jackpot/bet', { chips: amount }),
        onAutoplay: setAutoplay,
      }),
      note ? jsx('div', { role: 'alert', style: { marginTop: 8, color: text.primary }, children: note }) : null
    ]
  })
}

// ---- the see-through machine, in the composer's own slot ---------------------
//
// WHERE IT IS DRAWN. Not over the app's markup, and not by measuring it: the copy is rendered inside
// the composer's `composer.underside` slot (78-overchat-slot.js), which is a real surface of the
// Desktop SDK. That slot belongs to the conversation's composer, so it exists exactly while the
// conversation is on screen. There is no route sniffing here, no scan of the app's textareas, no walk
// up their ancestors for a "chat column", and nothing appended to the app's <head> or <body> — the
// review's finding (2026-11-12), and the reason an app update can no longer break this machine or be
// broken by it.
//
// HOW BIG IT IS. The strip that owns the slot measures its own box and hands each machine its share of
// the width; this component fits the cabinet into that share and then applies the person's own size
// slider on top, capped by the same share. Nothing here reads window.innerWidth, a textarea's
// position, or another element's rect.
//
// The height budget both copies share. A machine in the composer's underside pushes the composer up,
// so "as big as its share allows" would eat the conversation; this keeps it a picture of a machine.
const OVERCHAT_MAX_HEIGHT = 320

// Fit a cabinet of `natural` size into `room` pixels of slot width. "100%" is the largest the slot
// allows — whichever runs out first, the width share or the strip's height budget — and the person's own
// size slider multiplies it from there, still never past the width share. 0 while either number is
// unknown (the first paint, before the cabinet has been laid out).
function overchatFitScale(natural, room, multiplier) {
  const width = Math.max(0, Number(room) || 0)
  if (!natural || !(natural.width > 0) || !(natural.height > 0) || !width) return 0
  const factor = Number(multiplier) > 0 ? Number(multiplier) : 1
  const byWidth = width / natural.width
  const byHeight = OVERCHAT_MAX_HEIGHT / natural.height
  const scale = Math.min(Math.min(byWidth, byHeight) * factor, byWidth)
  // Below two percent is not a small copy, it is an invisible one: draw nothing rather than a smudge.
  return scale > 0.02 ? Math.floor(scale * 10000) / 10000 : 0
}

// The cabinet's size at 100%, read from our OWN element (never the app's). It is read on every render
// rather than kept in state: the element is ours, the read is one property, and a ResizeObserver only has
// to ask for a new render — which is what keeps the fit correct when a late font or the symbol art
// changes the cabinet's layout.
function overchatNatural(ref) {
  const node = ref && ref.current
  if (!node) return null
  const width = Number(node.offsetWidth) || 0
  const height = Number(node.offsetHeight) || 0
  return width > 0 && height > 0 ? { width, height } : null
}

function SlotsOverChatCopy({ ctx, width }) {
  const [on] = useSmOverchat()
  const [snapshot, setSnapshot] = useState(JP_LAST)
  const cabinetRef = useRef(null)
  const [, setResized] = useState(0)
  const [alpha] = useSmOverchatAlpha()
  const [overchatScale] = useSmScale()

  // The picture. The status chip polls as well and is what adopts the shelf's stored switch on load;
  // this copy only needs the numbers while it is on screen, which is when it is mounted at all.
  useEffect(() => {
    let alive = true
    let timer = null
    let wait = 600
    const load = async () => {
      try {
        const next = await jpRead(ctx)
        if (!alive) return
        JP_LAST = next
        setSnapshot(next)
        wait = 600
      } catch {
        // A failed poll leaves the last good picture; try again a little later.
        wait = Math.min(1500, Math.round(wait * 1.8))
      }
      if (alive) timer = setTimeout(load, wait)
    }
    load()
    return () => { alive = false; clearTimeout(timer) }
  }, [ctx])

  // While the machine is drawn it counts as visible for auto-spin, so a reply spins it even when the
  // person is in another game. It is only mounted while it is shown, so being mounted IS being visible.
  useEffect(() => {
    const door = (path, body) => ctx.rest(path, { method: 'POST', body })
    jpVisible(1, door)
    return () => jpVisible(-1, door)
  }, [ctx])

  // The symbol art and the fonts settle after the first paint, and each of those changes the cabinet's
  // layout — one ResizeObserver asks for the render, and the render reads the size again.
  useJpLayoutEffect(() => {
    // One render after mount, whatever the observer does: the ref is only filled in once the tree is
    // committed, so the first render can only see "not measured yet". Without this the copy would wait
    // for a resize that may never come — a cabinet already at its final size fires no event at all.
    setResized(count => count + 1)
    const cabinet = cabinetRef.current
    if (typeof ResizeObserver === 'undefined' || !cabinet) return undefined
    let watcher = null
    try {
      watcher = new ResizeObserver(() => setResized(count => count + 1))
      watcher.observe(cabinet)
    } catch {
      return undefined
    }
    return () => { if (watcher && typeof watcher.disconnect === 'function') watcher.disconnect() }
  }, [])

  const natural = overchatNatural(cabinetRef)
  const scale = overchatFitScale(natural, width, overchatScale)
  if (!on) return null
  // The machine is drawn even before it has been measured — at 100%, clipped to nothing — because its own
  // size is what the measurement is of. One frame, and the box below takes the fitted size.
  const ready = Boolean(natural && scale)
  const machines = (snapshot && snapshot.machines) || []
  const machineId = (snapshot && snapshot.machine) || (machines[0] && machines[0].id) || ''
  const machine = machines.find(item => item.id === machineId) || machines[0] || null
  const feed = (snapshot && snapshot.feed) || []
  const newest = feed[0] || null
  const result = newest && machine && newest.machine === machine.id ? newest : null
  const chips = snapshot && snapshot.chips
  const bet = Number(snapshot && snapshot.bet) || 0
  const bets = (snapshot && snapshot.bets) || []
  const odds = (snapshot && snapshot.odds) || null
  const off = () => smSetOverchat(false)
  return jsx('div', {
    'data-jackpot': 'overchat',
    style: {
      // Relative, because the machine inside is absolutely positioned: that is what lets it be measured
      // before this box has a size. A plain child of a zero-width box measures as zero, and a machine that
      // only draws once measured would then never draw at all.
      position: 'relative',
      width: ready ? natural.width * scale : 0,
      height: ready ? natural.height * scale : 0,
      // The see-through machine sits at the viewer's opacity, 20% by default. The box is the size the
      // machine actually paints at: a transform does not shrink the layout box, so sizing the wrapper
      // is what keeps the strip's own height honest.
      opacity: alpha,
      // It is for watching, not clicking: a click here must never be one the conversation wanted. The
      // machine's own dismissal controls sit in the strip and opt back in.
      pointerEvents: 'none',
      boxSizing: 'border-box', overflow: 'hidden',
      color: text.primary, fontSize: 12
    },
    children: jsx('div', {
      style: {
        position: 'absolute',
        left: 0,
        top: 0,
        width: natural ? natural.width : 'max-content',
        height: natural ? natural.height : 'auto',
        transform: `scale(${ready ? scale : 1})`,
        transformOrigin: 'top left'
      },
      children: jsx(SlotMachine, {
        machine,
        machines,
        result,
        chips,
        bet,
        bets,
        odds,
        paytable: (snapshot && snapshot.paytable) || [],
        compact: false,
        // The copy is the same machine as the one in the wait pane, points card and printed glass
        // included (owner's ask, 2026-11-09), with its dismissal controls (`chat: true`).
        bare: false,
        chat: true,
        cabinetRef,
        // The wrapper scales the copy, not the machine inside it: a machine that resized itself
        // changed `natural` on every slider move, the fit recomputed, and the size barely moved.
        scaleOverride: 1,
        onClose: off,
        onShow: off
      })
    })
  })
}
