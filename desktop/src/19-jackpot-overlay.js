// ---- 19-jackpot-overlay.js: the floating slot machine over the chat and its status-bar chip counter

const JP_STORE = { open: false, listeners: new Set() }
const JP_STORAGE_KEY = 'gameshelf.jackpot.overlay'

// React's layout effect where the host has one, the ordinary effect where it does not (the harnesses
// stub exactly the hooks a part is allowed to use, and they stub useEffect). The over-chat copy has
// to know the machine's size before the first paint: measured afterwards, the machine is drawn once
// at its full size and then snaps to its fit, which is the "sometimes it is just huge" the owner saw
// (2026-11-09) and exactly what the visibility gate used to paper over. Resolved per call, never at
// load: a harness hands the bundle its hook stubs after loading it, so a name read at load time
// would simply not be there.
function useJpLayoutEffect(fn, deps) {
  const hook = typeof useLayoutEffect === 'function' ? useLayoutEffect : useEffect
  return hook(fn, deps)
}

// The copy's numbers before the machine has been measured. `natural: 0` is how "not measured" is
// spelled: it never hides the copy (that is the defect this path exists to fix) and it never stops the
// numbers arriving, because the measurement runs before the first paint through useJpLayoutEffect.
const JP_LAYOUT_EMPTY = { left: 0, top: 0, width: 0, scale: 1, natural: 0, naturalHeight: 0 }

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

// Where the app is, read from its own router: the desktop routes with the URL hash. The
// conversation is the empty hash (or "#/"), and the screens the machine must not float over have
// their own paths. This is a denylist on purpose: an unexpected path shows the machine, because a
// missing machine over the chat is worse than one extra copy on a screen nobody named. (The first
// cut was the inverse and hid it over the conversation too - owner's report, 2026-11-09.)
//
// '/games' is named here now (2026-11-11): the Games page has a route of its own, and the copy over
// the chat belongs over the conversation only.
const JP_OFF_CHAT = ['/games', '/settings', '/capabilities', '/messaging', '/plugins', '/onboarding', '/welcome', '/about']

// Is the CONVERSATION the thing on screen? The conversation's composer is a textarea that belongs to
// neither a game surface (a play table, the "play while you wait" pane) nor the Game Center page
// itself - those textareas are the games'. This is the same test that finds the chat column, asked as
// a yes/no question, and it is what keeps the copy over the conversation: Hermes keeps the Game
// Center page mounted after the person walks back to the chat, so "a Games element exists" says
// nothing about what is being looked at (owner's report, 2026-11-11: the switch is on and nothing
// appears over the chat).
function JP_composer() {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null
  const gamesOnly = '.games-play-table, .games-wait-pane, .games-center-layout'
  const isChats = node => Boolean(node)
    && !(typeof node.closest === 'function' && node.closest(gamesOnly))
  let found = []
  // Every textarea, not just the first: a pane or a game page can hold one that comes first in the
  // document, and picking that one would measure the copy against the wrong box.
  if (typeof document.querySelectorAll === 'function') {
    const all = document.querySelectorAll('textarea')
    found = all && typeof all.length === 'number' ? Array.prototype.slice.call(all) : []
  }
  if (!found.length) {
    const one = document.querySelector('textarea')
    if (one) found = [one]
  }
  return found.find(isChats) || null
}

function jpOnChatScreen() {
  try {
    const hash = String((typeof window !== 'undefined' && window.location && window.location.hash) || '').replace(/^#/, '')
    const path = hash.split('?')[0]
    if (path && path !== '/' && JP_OFF_CHAT.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) return false
    // A Games page can be up while the app still calls the route the conversation, so the DOM is
    // asked too - but only about a Games page that has taken the main area, and only when the
    // conversation is NOT on screen. Asking it any other way is what hid the copy for good: the Games
    // page stays mounted behind the chat, so the copy was suppressed over the very screen it is for
    // (owner's report, 2026-11-11). A composer outside the games IS the conversation, so nothing that
    // is merely still mounted can hide the copy from it.
    const gamesScreen = typeof document !== 'undefined' && typeof document.querySelector === 'function'
      ? document.querySelector('.games-center-layout')
      : null
    if (gamesScreen && gamesScreen.nodeType === 1 && !JP_composer()) {
      const box = typeof gamesScreen.getBoundingClientRect === 'function' ? gamesScreen.getBoundingClientRect() : null
      if (!box || (box.width > 0 && box.height > 0)) return false
    }
    return true
  } catch {
    return true
  }
}

function useJpOnChatScreen() {
  const [onChat, setOnChat] = useState(jpOnChatScreen())
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
    const read = () => setOnChat(jpOnChatScreen())
    window.addEventListener('hashchange', read)
    read()
    return () => { if (typeof window.removeEventListener === 'function') window.removeEventListener('hashchange', read) }
  }, [])
  return onChat
}

// The see-through machine over the chat. It is mounted by the always-present status item,
// so it is on screen whether or not Game Center is open. It reads the same /jackpot door
// as the corner panel and reports itself visible, so auto-spin keeps running while chatting.
//
// The chat column is found the way the build that worked found it (9433891): the first textarea's
// first ancestor wider than half the window. That rule is the whole measurement - and when the shell
// exposes no such column, the copy is measured against the window instead of a box that does not
// exist.
function JP_chatColumn() {
  const composer = JP_composer()
  if (!composer) return null
  const viewport = Number(window.innerWidth) || 0
  let node = composer.parentElement
  while (node && node !== document.body) {
    if (typeof node.getBoundingClientRect === 'function') {
      const rect = node.getBoundingClientRect()
      if (rect && rect.width > viewport * 0.5) return node
    }
    node = node.parentElement
  }
  return null
}

// ---- the two machines on one conversation ------------------------------------
// The owner keeps BOTH machines (2026-11-11) and both switches may be on at once, so the conversation
// is shared instead of fought over: this one keeps the LEFT half of the chat column, from its
// top-left corner, and Jackpot v2 keeps the right half, from its bottom-right. Two copies that each
// stay inside their own half of the column cannot touch, whatever size they draw at - which is what
// makes "they must not overlap" a rule rather than a hope. The other machine's switch is only ever
// READ here: the two switches stay separate, and turning this one off never turns v2 off.
function JP_v2OverChat() {
  try {
    return Boolean(typeof JP2L_STORE !== 'undefined' && JP2L_STORE && JP2L_STORE.overchat)
  } catch {
    // Before the Jackpot v2 part of the bundle has run, or in a build without it: nothing to share.
    return false
  }
}

function useJpV2OverChat() {
  const [on, setOn] = useState(JP_v2OverChat)
  useEffect(() => {
    if (typeof JP2L_STORE === 'undefined' || !JP2L_STORE || !JP2L_STORE.listeners) return undefined
    const listener = value => setOn(Boolean(value))
    JP2L_STORE.listeners.add(listener)
    setOn(JP_v2OverChat())
    return () => { JP2L_STORE.listeners.delete(listener) }
  }, [])
  return on
}

function SlotsOverChat({ ctx }) {
  const [on, setOn] = useSmOverchat()
  const [snapshot, setSnapshot] = useState(JP_LAST)
  const cabinetRef = useRef(null)
  const [layout, setLayout] = useState(JP_LAYOUT_EMPTY)
  const [alpha] = useSmOverchatAlpha()
  const [overchatScale] = useSmScale()
  // The other machine's switch, read-only: both may be over the chat at once, and then the
  // conversation is halved rather than shared (see the note above JP_v2OverChat).
  const v2On = useJpV2OverChat()
  // Re-read the surface on every render: the status item mounts once, the games screen can open at
  // the root route afterwards, and a hashchange-only listener never fires for that (2026-11-10).
  const hashSaysChat = useJpOnChatScreen()
  const onChatScreen = hashSaysChat && jpOnChatScreen()
  useEffect(() => {
    // Poll even while the switch reads off: the shelf's stored value is what turns the copy on, and a
    // component that only starts polling once it is already on can never adopt it - the same deadlock
    // that hid the switch behind the switch (2026-11-10). Off polls slowly, on polls at 600 ms.
    let alive = true
    let wait = on ? 600 : 1500
    let timer = null
    const load = async () => {
      try {
        const next = await jpRead(ctx)
        if (!alive) return
        JP_LAST = next
        setSnapshot(next)
        // The stored switch is the truth: the copy must come back on a reload without the person
        // walking to the Games table first (owner's report, 2026-11-10: the copy showed over the
        // games area but never over the chat). Adopting it here is what the status item does for the
        // chip; the overlay has to do it for itself, because it is the surface being asked for.
        if (!on && next && next.overchat && next.overchat.on === true) setOn(true)
        wait = 600
      } catch {
        // A failed poll leaves the last good picture; try again a little later.
        wait = Math.min(1500, Math.round(wait * 1.8))
      }
      if (alive) timer = setTimeout(load, wait)
    }
    load()
    return () => { alive = false; clearTimeout(timer) }
  }, [ctx, on])
  // While the see-through machine is actually on screen it counts as visible for auto-spin, so a
  // reply spins it even when the person is in another game (owner's note, 2026-11-09: they hear the
  // machine while playing Sea Battle). Off the conversation it is not drawn, so it must not count:
  // that would spin a machine nobody can see.
  useEffect(() => {
    if (!on || !onChatScreen) return undefined
    const door = (path, body) => ctx.rest(path, { method: 'POST', body })
    jpVisible(1, door)
    return () => jpVisible(-1, door)
  }, [ctx, on, onChatScreen])
  useJpLayoutEffect(() => {
    if (!on || !onChatScreen) return undefined
    const measure = () => {
      const viewport = Number(window.innerWidth) || 0
      const column = JP_chatColumn()
      const rect = column && typeof column.getBoundingClientRect === 'function'
        ? column.getBoundingClientRect()
        : null
      // The frame the copy is measured against: the chat column when the shell exposes one, otherwise
      // the window. It is NOT the element the copy is mounted inside - that is the status-bar span,
      // about sixty pixels wide and twenty tall, and measuring against it is what made the machine
      // 2% of its size and effectively invisible (found 2026-11-10 by reading the numbers rather than
      // the screenshot: fit = 60*0.7/natural, room = 22-16 px, so the scale floor won every time).
      // No column to sit on (the shell's DOM does not always expose one): the window, which keeps the
      // machine centred rather than 210 px left of the window's centre (owner's report, 2026-11-09).
      const frame = rect && rect.width && rect.height ? rect : null
      const windowWidth = Math.max(0, viewport)
      const windowHeight = Number(window.innerHeight) || 0
      const left = frame && Number.isFinite(frame.left) ? Math.max(0, frame.left) : 0
      const whole = frame ? Math.max(0, Math.min(windowWidth, frame.left + frame.width) - left) : windowWidth
      // Both machines over the chat: half the conversation each, this one the left half. Two boxes
      // that stay inside their own half of the column cannot touch, which is what makes the owner's
      // "they must not overlap" true by construction rather than by luck (2026-11-11).
      const half = v2On && frame ? Math.max(0, whole / 2) : 0
      const width = half || whole
      const cabinet = cabinetRef.current
      // The machine is drawn at its table size, so this is its width and height at 100%.
      const natural = cabinet && cabinet.offsetWidth ? cabinet.offsetWidth : 0
      const naturalHeight = cabinet && cabinet.offsetHeight ? cabinet.offsetHeight : 0
      // A cabinet that has not been laid out yet reports 0, and the numbers are then simply not known
      // this time round. That is a reason to look again in a moment, never a reason to leave the copy
      // out: waiting for a measurement that may never come is the defect this whole path exists to
      // fix (owner's report, 2026-11-11: the switch is on and nothing appears over the chat). The
      // last good numbers stay on screen until the new ones are here, which is also what keeps the
      // copy from being drawn at 100% once ("sometimes it is just huge", owner's report, 2026-11-09).
      if (!natural || !naturalHeight || !width) {
        if (!layout.natural) retry = setTimeout(measure, 60)
        return
      }
      // 100% fills 70% of the chat column (the size it always had); the slider multiplies that, and
      // the top of the range is capped by the window in BOTH directions so the copy can neither spill
      // off the bottom (the full-screen fix) nor past the right edge.
      const fit = (width * 0.7) / natural
      const ceiling = Math.min(width, viewport) / natural
      // Where the frame starts, not where the window does. "top: 8%" is 8% of the window, so in a
      // pane that begins low and is short, the machine started too far down and its bottom was cut
      // off (owner's report, 2026-11-10: "the on screen slot machine is missing its bottom").
      const frameTop = frame && Number.isFinite(frame.top) ? Math.max(0, frame.top) : 0
      const top = Math.min(windowHeight, frameTop + Math.min(8, Math.max(0, windowHeight - frameTop)))
      const frameBottom = frame ? Math.min(windowHeight, frame.top + frame.height) : windowHeight
      const room = Math.max(0, frameBottom - top)
      const ceilingHeight = room / naturalHeight
      const scale = Math.max(0, Math.min(fit * overchatScale, ceiling, ceilingHeight))
      // A scale this small is not a small copy, it is an invisible one: a frame with no room left
      // (a wrapper that collapsed, a pane mid-transition). Keep the last good layout and look again.
      if (!(scale > 0.02)) {
        if (!layout.natural) retry = setTimeout(measure, 150)
        return
      }
      const box = { left, top, width, scale, natural, naturalHeight }
      // Only redraw when the numbers actually moved: setLayout on every ResizeObserver tick was a
      // render loop of its own.
      setLayout(prev => (Math.abs((prev.scale || 0) - box.scale) < 0.001
        && prev.left === box.left && prev.top === box.top && prev.width === box.width
        && prev.natural === box.natural && prev.naturalHeight === box.naturalHeight) ? prev : box)
    }
    let retry = null
    let watchers = []
    let observedColumn = null
    const remeasure = () => {
      if (retry) { clearTimeout(retry); retry = null }
      const column = JP_chatColumn()
      if (column !== observedColumn) {
        if (watchers.length) { watchers.forEach(watcher => watcher.disconnect()); watchers = [] }
        observedColumn = column
        if (column && typeof ResizeObserver !== 'undefined') {
          const onColumn = new ResizeObserver(remeasure)
          try { onColumn.observe(column); watchers.push(onColumn) } catch (error) { /* a dead column is not fatal */ }
        }
      }
      measure()
    }
    remeasure()
    if (typeof ResizeObserver !== 'undefined') {
      // The cabinet changes size on its own: the machine can be switched (three reels against nine
      // windows), the symbol art loads late, and the fonts settle after first paint. Watching the
      // cabinet is what keeps "always the right size" true rather than a one-shot measurement.
      const cabinet = cabinetRef.current
      if (cabinet) {
        const onCabinet = new ResizeObserver(remeasure)
        try { onCabinet.observe(cabinet); watchers.push(onCabinet) } catch (error) { /* as above */ }
      }
    }
    // Area changes can replace the composer without changing the URL.
    // A light poll, not a body-wide observer: the plugin must not watch the app's own markup.
    const areaWatcher = setInterval(() => {
      if (JP_chatColumn() !== observedColumn) remeasure()
    }, 1000)
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('resize', measure)
      window.addEventListener('orientationchange', measure)
      window.addEventListener('hashchange', measure)
    }
    const settles = [0, 120, 400, 1200].map(delay => setTimeout(measure, delay))
    // Web fonts and images land after the first paint; both change the machine's natural size.
    try {
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure)
    } catch (error) { /* an old shell without the font set simply keeps the timers */ }
    return () => {
      watchers.forEach(watcher => watcher.disconnect())
      clearInterval(areaWatcher)
      if (typeof window.removeEventListener === 'function') {
        window.removeEventListener('resize', measure)
        window.removeEventListener('orientationchange', measure)
        window.removeEventListener('hashchange', measure)
      }
      settles.forEach(timer => clearTimeout(timer))
      if (retry) clearTimeout(retry)
    }
  }, [on, onChatScreen, v2On, snapshot && snapshot.machine, overchatScale])
  if (!on || !onChatScreen) return null
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
  const off = () => setOn(false)
  // Both machines on: this one is the left-hand copy, anchored at the frame's top-left corner; on its
  // own it stays centred in the frame it has to itself (the shell's own look, owner's report
  // 2026-11-09: a copy measured from left 0 read as left-justified). Either way the box stays inside
  // its half of the conversation, which is what keeps the two machines off one another.
  const sharing = Boolean(v2On && layout.width)
  return jsx('div', {
    'data-jackpot': 'overchat',
    style: {
      position: 'fixed', left: layout.left, top: layout.top ?? 0, width: layout.width || 'auto',
      // The see-through machine sits at the viewer's opacity, 20% by default (owner's ask,
      // 2026-11-09: five points more opaque than the 15% it was). The − / + control beside
      // "Show over chat" changes it and the choice is kept in this browser. The × / Show
      // controls are the only things drawn above it.
      //
      // There is deliberately no `visibility` gate here any more: the copy used to be hidden until a
      // measurement arrived, and a measurement that never arrives then hides the machine for good -
      // which is the owner's release blocker this change exists for (2026-11-11). The numbers are
      // measured in this component, before the first paint (JP_USE_LAYOUT), so there is nothing to
      // hide from.
      zIndex: 60, opacity: alpha,
      pointerEvents: 'none', boxSizing: 'border-box',
      display: 'flex', justifyContent: sharing ? 'flex-start' : 'center', color: text.primary, fontSize: 12
    },
    // The scaled box is given the size the machine actually paints at. A transform does not shrink
    // the layout box, so without this the child kept its full width inside a narrower centred
    // wrapper, pushed itself right, and read as dials pinned left with dead space beside them
    // (owner's report, 2026-11-09: the "centering" problem).
    children: jsx('div', {
      style: {
        width: layout.natural ? layout.natural * layout.scale : 'auto',
        height: layout.naturalHeight ? layout.naturalHeight * layout.scale : 'auto'
      },
      children: jsx('div', {
        style: {
          width: layout.natural || 'auto',
          transform: `scale(${layout.scale})`,
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
        // The copy over the chat is the same machine as the one in the wait pane, points card and
        // printed glass included (owner's ask, 2026-11-09: "should have points and all, and look the
        // same"). `chat` draws the full machine with the dismissal controls; `bare` would have shown
        // the cabinet alone.
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
  })
}
