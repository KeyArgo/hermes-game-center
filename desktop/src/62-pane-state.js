// ---- 62-pane-state.js: Play while you code: what the pane remembers and how it reads a game
// ----- Play while you code: the side pane ------------------------------------
//
// A turn-based game in a pane beside the chat, so a person can play a move while
// Hermes works and be told, quietly, when it finishes. The board is BoardSvg —
// the very component the full table draws — so hover, drag and the piece art are
// the same by construction and only the size changes.
//
// Nothing here writes into the chat or asks the person's chat model for anything
// unless they press "Play my Hermes model": the built-in computer is the default
// opponent in this pane, free and instant. A game in progress lives on the
// server, and the pane remembers which game it was, so leaving and coming back
// resumes it.
const SDK_HOST = typeof host === 'undefined' ? null : host
const PANE_ID = 'hermes-gameshelf:pane'
const PANE_GAME_KEY = 'pane-game'
const PANE_ALERTS_KEY = 'pane-alerts'
const PANE_WIDTH = '720px'
// The four quick games. Order is the order they are offered.
const QUICK_GAMES = ['connect4', 'reversi', 'gomoku', 'breakthrough']
const QUICK_LEVEL = 'intermediate'
const IDLE_CHAT = { get: () => false, subscribe: () => () => {} }
// Which game the pane is on. Module state, so the status-bar badge sees the
// pane's choice without a second store.
const paneWatch = { game: '' }

function quickGameLine(id, who = 'computer', level = QUICK_LEVEL) {
  return `allow-ai ${id} black=${who === 'agent' ? 'agent' : 'local'} level=${level || QUICK_LEVEL}`
}

// Play is the curated list and nothing else, so the pane offers exactly the
// games the full table calls match-ready.
function paneGames(view) {
  return ((view && view.play) || []).filter(item => (item.kind || 'table') === 'table' && item.installed !== false)
}

// A game's own board says who it seats. A slot machine seats nobody opposite the
// person: one player, no computer, no levels, no model, no start-over. Read the
// board's view - the game's own metadata - never a sentence's wording.
function gameSeatsNobody(game, pictured) {
  const view = String((pictured && pictured.view) || (game && game.view) || (game && game.id) || '')
  return view === 'slots'
}

function paneGame(view, saved) {
  const games = paneGames(view)
  const wanted = String(saved || '')
  if (wanted && games.some(item => item.id === wanted)) return wanted
  return games.length ? games[0].id : ''
}

function storedValue(ctx, key, fallback) {
  try {
    if (!ctx || !ctx.storage || typeof ctx.storage.get !== 'function') return fallback
    const value = ctx.storage.get(key, fallback)
    return value === undefined || value === null ? fallback : value
  } catch {
    return fallback
  }
}

function storeValue(ctx, key, value) {
  try {
    if (ctx && ctx.storage && typeof ctx.storage.set === 'function') ctx.storage.set(key, value)
  } catch {
    // An older host without plugin storage: the table still saves on the server.
  }
}

function savedPaneGame(ctx) {
  const stored = storedValue(ctx, PANE_GAME_KEY, '')
  return typeof stored === 'string' ? stored : ''
}

function rememberPaneGame(ctx, id) {
  const wanted = String(id || '')
  if (!wanted || savedPaneGame(ctx) === wanted) return
  storeValue(ctx, PANE_GAME_KEY, wanted)
}

// Alerts are per game and off until the person turns them on; "paused" silences
// every game at once without forgetting the per-game choices.
function paneAlerts(ctx) {
  const stored = storedValue(ctx, PANE_ALERTS_KEY, null)
  if (!stored || typeof stored !== 'object') return { paused: false, games: {} }
  const games = stored.games && typeof stored.games === 'object' ? stored.games : {}
  return { paused: Boolean(stored.paused), games }
}

function alertsOn(ctx, gameId) {
  // The status-bar count is a quiet readout, not an alert drop: it stays. What ALERTS_OFF silences
  // is anything that pops up or notifies.
  const settings = paneAlerts(ctx)
  return Boolean(gameId && !settings.paused && settings.games[gameId])
}

function myTurn(picture, view) {
  return Boolean(picture && picture.status === 'active' && tableAccess(picture, view).can_move)
}

function lookingRows(lobby) {
  return (lobby && lobby.looking) || []
}

// Someone else waiting for this game. The lobby names people, and a person's own
// row carries their name, so the name is what tells "them" from "me".
function othersLooking(lobby, game, name) {
  return lookingRows(lobby).filter(row => row.game === game && row.name !== name)
}

function isLooking(lobby, game, name) {
  return lookingRows(lobby).some(row => row.game === game && row.name === name)
}

// Someone else waiting for a game this person is also waiting for. Both rows carry
// their names, which is what tells "them" from "me".
function matchFound(lobby, name) {
  const games = lookingRows(lobby).filter(row => row.name === name).map(row => row.game)
  return games.find(game => othersLooking(lobby, game, name).length) || ''
}

// Whose move it is, in one line. The pane and the full table say it in the same words:
//   - a Hermes model's seat is "Hermes is thinking…" the moment the board says it is that seat's
//     turn: the model works outside the request the person made, so the wait is real from the start;
//   - the built-in computer is "Computer is thinking…" only while a request that will answer it is
//     really in flight, and "Waiting for the computer…" when the board is simply its turn;
//   - another person is "Waiting for <name>…".
// '' means it is the person's own turn and nobody else is working: the board speaks for itself.
function waitWords(picture, view, opts) {
  const working = Boolean(opts && opts.working)
  if (!picture || String(picture.status || '') !== 'active') return ''
  const seats = picture.seats || []
  const seat = seats.find(item => item.side === picture.turn) || null
  const kind = String((seat && seat.kind) || '')
  if (kind === 'agent') return 'Hermes is thinking…'
  if (kind === 'local') return working ? 'Computer is thinking…' : 'Waiting for the computer…'
  // A request that is out is answered by whichever machine seat is at the table, so the person's
  // own move names the wait before the board says whose turn it is.
  const machine = seats.find(item => item.kind === 'agent') || seats.find(item => item.kind === 'local') || null
  if (working && machine) return machine.kind === 'agent' ? 'Hermes is thinking…' : 'Computer is thinking…'
  // Your own move says nothing here: the board itself says what to do.
  if (myTurn(picture, view)) return ''
  const name = String((seat && seat.name) || '')
  if (kind === 'human' && name) return `Waiting for ${name}…`
  return 'Waiting for the other side…'
}

// Is a Hermes model's seat the one to move? The one wait that starts before any request of the
// person's own is out: the model answers on its own schedule.
function agentOnMove(picture) {
  return Boolean(picture && picture.status === 'active' &&
    (picture.seats || []).some(seat => seat.side === picture.turn && seat.kind === 'agent'))
}

// The seconds on a wait line, counted from the moment the wait began: a line that reads "0s" is
// telling the person the clock is running.
function waitSecondsWords(seconds) {
  const whole = Math.floor(Number(seconds))
  return `${Number.isFinite(whole) && whole > 0 ? whole : 0}s`
}

// What the pane says under the board, in plain words: whose move it is, with the seconds running,
// while the other side works - and the plain state of this table otherwise.
function paneStatus(picture, view, opts) {
  if (!picture) return 'Quick game: pick a game, then press New game.'
  const status = String(picture.status || '')
  if (status === 'active') {
    const waiting = waitWords(picture, view, opts)
    if (!waiting) return ''
    const seconds = opts && opts.seconds !== undefined ? ` ${waitSecondsWords(opts.seconds)}` : ''
    return `${waiting}${seconds}`
  }
  if (status === 'win') return `${picture.winner === 'black' ? 'Black' : 'White'} wins`
  if (status === 'draw') return 'It is a draw'
  if (status === 'lesson_done') return 'Step done'
  if (status === 'idle' || status === 'preview') return 'Ready to play'
  return status
}

// The line about the agent, in one small row. An approval needs the person, so it
// wins over "working"; working wins over the finished line.
function agentNotice(busy, finished, approval) {
  if (approval) return { text: 'Hermes needs your approval in the chat.', back: true }
  if (busy) return { text: 'Hermes is working…', back: false }
  if (finished) return { text: 'Hermes finished: back to chat', back: true }
  return null
}

function focusChat(ctx) {
  try {
    if (ctx && typeof ctx.runAction === 'function') {
      const answer = ctx.runAction('composer.focus')
      if (!answer || answer.ok !== false) return true
    }
  } catch {
    // An older desktop without runAction: the route below is the fallback.
  }
  try {
    if (SDK_HOST && typeof SDK_HOST.navigate === 'function') {
      SDK_HOST.navigate('/')
      return true
    }
  } catch {
    // Nothing else to try; the chat is still one click away in the window.
  }
  return false
}

// Leave Game Center and land on the chat. Focusing the chat box alone can leave this
// page on screen, so go to the chat first and focus it after.
function closeGameCenter(ctx) {
  try {
    if (SDK_HOST && typeof SDK_HOST.navigate === 'function') SDK_HOST.navigate('/')
  } catch {
    // Fall through to focusing the chat.
  }
  return focusChat(ctx)
}

// Reveal the pane from an explicit user action. revealPane is the SDK's own door;
// the layout event is only a fallback for a desktop that predates it.
// Hermes gives a plugin no call to close its only pane (its own Close would disable the
// whole plugin, and a hide-only tab cannot hide the last tab of its zone). So the pane is
// registered only while it is wanted: × unregisters it and it leaves the layout completely;
// the status item and the palette register it again. The choice survives a restart.
const WAIT_PANE_SLOT = { ctx: null, make: null, dispose: null }
const PANE_GONE_KEY = 'gameshelf.pane.gone'

function paneGone() {
  try {
    return window.localStorage.getItem(PANE_GONE_KEY) === '1'
  } catch {
    return false
  }
}

function rememberPaneGone(gone) {
  try {
    if (gone) window.localStorage.setItem(PANE_GONE_KEY, '1')
    else window.localStorage.removeItem(PANE_GONE_KEY)
  } catch {
    // No storage: the pane still goes away for this visit.
  }
}

function mountWaitPane() {
  if (WAIT_PANE_SLOT.dispose || !WAIT_PANE_SLOT.ctx || !WAIT_PANE_SLOT.make) return false
  try {
    WAIT_PANE_SLOT.dispose = WAIT_PANE_SLOT.ctx.registerMany([WAIT_PANE_SLOT.make()])
    // The doors (the Games header button and the status-bar item) are told the pane is
    // back the moment it is, not on the next poll.
    announcePaneChrome()
    return true
  } catch {
    return false
  }
}

function unmountWaitPane() {
  const dispose = WAIT_PANE_SLOT.dispose
  WAIT_PANE_SLOT.dispose = null
  if (typeof dispose !== 'function') return false
  try {
    dispose()
  } catch {
    // Already gone with the plugin.
  }
  announcePaneChrome()
  return true
}

function openWaitPane() {
  // The way back from a closed or minimized pane, and the way in when it hides:
  // one door, so the status item and the palette behave the same.
  rememberPaneGone(false)
  if (mountWaitPane()) {
    // A freshly registered pane is adopted into the layout on the next tick; reveal it then.
    setTimeout(() => {
      try { restoreWaitPane() } catch { /* nothing to reveal into */ }
    }, 0)
    return true
  }
  try { restoreWaitPane() } catch { /* the reveal below still applies */ }
  try {
    if (SDK_HOST && typeof SDK_HOST.revealPane === 'function') {
      SDK_HOST.revealPane(PANE_ID)
      return true
    }
  } catch {
    // Fall through to the event.
  }
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('hermes:pane-toggle-reveal', { detail: { id: PANE_ID, mode: 'open' } }))
      return true
    }
  } catch {
    // A plain browser QA page has no layout to reveal.
  }
  return false
}

// One surface at a time: Game Center full screen and the Play while you code pane
// are the same game in two places, so opening one closes the other. The handoff
// carries the game across so the person lands on the same board, not the list.
const PAGE_HANDOFF = { game: '' }

function paneFromPage(ctx, gameId) {
  if (typeof gameId === 'string' && gameId) {
    paneWatch.game = gameId
    storeValue(ctx, PANE_GAME_KEY, gameId)
  }
  closeGameCenter(ctx)
  openWaitPane()
  return true
}

function pageFromPane(ctx) {
  const game = paneWatch.game || savedPaneGame(ctx)
  PAGE_HANDOFF.game = game || ''
  rememberPaneGone(true)
  if (!unmountWaitPane()) {
    try {
      if (SDK_HOST && typeof SDK_HOST.dismissPane === 'function') SDK_HOST.dismissPane(PANE_ID)
    } catch {
      // The navigate below still leaves the pane behind.
    }
  }
  try {
    if (SDK_HOST && typeof SDK_HOST.navigate === 'function') SDK_HOST.navigate(ROUTE)
  } catch {
    // Nothing else to try; the page is still one click away.
  }
}

// The full-screen page appeared: the pane must go, or the same game would be on
// screen twice. The saved pane game is deliberately left alone so the pane can
// come back to it.
function leavePaneForPage() {
  if (!WAIT_PANE_SLOT.dispose) return
  rememberPaneGone(true)
  unmountWaitPane()
}

function useChatBusy() {
  // The SDK's documented per-chat busy atom. A host without it (or a QA page
  // with no gateway) simply reports not busy, so the pane still works.
  if (typeof useValue !== 'function') return false
  const atom = (SDK_HOST && SDK_HOST.state && SDK_HOST.state.busy) || IDLE_CHAT
  return Boolean(useValue(atom))
}

function useHermesFinished(busy) {
  const [finished, setFinished] = useState(false)
  const wasBusy = useRef(false)
  useEffect(() => {
    if (busy) {
      wasBusy.current = true
      setFinished(false)
      return
    }
    if (wasBusy.current) {
      wasBusy.current = false
      setFinished(true)
    }
  }, [busy])
  // message.complete is the gateway's own end-of-reply event; the busy atom is
  // what the status bar reads. Either one says Hermes is done.
  useEffect(() => {
    if (!SDK_HOST || typeof SDK_HOST.onEvent !== 'function') return undefined
    let stop = () => {}
    try {
      stop = SDK_HOST.onEvent('message.complete', () => setFinished(true)) || stop
    } catch {
      // No event stream on this host: the busy atom alone drives the line.
    }
    return () => {
      try { stop() } catch { /* already gone */ }
    }
  }, [])
  return finished && !busy
}

function useApprovalNotice() {
  const [needs, setNeeds] = useState(false)
  useEffect(() => {
    if (!SDK_HOST || typeof SDK_HOST.onEvent !== 'function') return undefined
    const stops = []
    try {
      stops.push(SDK_HOST.onEvent('approval.request', () => setNeeds(true)))
      stops.push(SDK_HOST.onEvent('approval.settled', () => setNeeds(false)))
      stops.push(SDK_HOST.onEvent('approval.cancelled', () => setNeeds(false)))
      // The gateway publishes approval.settled when a prompt is answered
      // (gateway/session_commands.py); a reply that completes is the other safe end.
      stops.push(SDK_HOST.onEvent('message.complete', () => setNeeds(false)))
    } catch {
      // The event stream is not there: no approval line, and nothing else changes.
    }
    return () => stops.forEach(stop => { try { stop() } catch { /* gone */ } })
  }, [])
  return needs
}

function notifyAlert(ctx, label, gameId, title) {
  if (typeof ALERTS_OFF !== 'undefined' && ALERTS_OFF) return null
  try {
    if (!ctx || !ctx.os || typeof ctx.os.notify !== 'function') return false
    ctx.os.notify({
      title: label,
      body: label === 'Your turn' ? `Your move in ${title || gameId}.` : `Someone is looking for a ${title || gameId} game.`,
      silent: true,
      onActivate: () => openWaitPane()
    })
    return true
  } catch {
    return false
  }
}

// Someone online is waiting for a game the person asked to hear about. Same
// silent notification as a turn, with one click to the pane.
function notifyOnline(ctx, alert) {
  if (typeof ALERTS_OFF !== 'undefined' && ALERTS_OFF) return null
  try {
    if (!ctx || !ctx.os || typeof ctx.os.notify !== 'function') return false
    ctx.os.notify({
      title: 'Someone is waiting online',
      body: String((alert && alert.text) || 'Someone online wants a game.'),
      silent: true,
      onActivate: () => openWaitPane()
    })
    return true
  } catch {
    return false
  }
}

function agentRow(notice, ctx) {
  if (!notice) return null
  return jsxs('div', {
    role: 'status',
    'aria-live': 'polite',
    className: 'games-agent-notice',
    style: {
      display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between',
      padding: '6px 10px', borderRadius: 8, border: `1px solid ${stroke}`, background: fill,
      fontSize: 12, color: text.secondary
    },
    children: [
      jsx('span', { children: notice.text }),
      notice.back ? textLink('Back to chat', () => focusChat(ctx)) : null
    ]
  })
}

// The online source, as the pane reads it: everything the page shows comes from
// /view's "online" answer, and every action goes through one of the /online
// doors. Nothing here talks to the lobby server itself, and nothing at all
// happens until the person's own yes is stored.
function onlineView(view) {
  const online = (view && view.online) || {}
  return {
    on: Boolean(online.on),
    url: online.url || ONLINE_URL,
    linked: Boolean(online.linked),
    name: online.name || '',
    disclosure: online.disclosure || '',
    offline: Boolean(online.offline),
    offlineText: online.offline_text || '',
    game: online.game || '',
    looking: online.looking || {},
    waitingNames: online.waiting_names || [],
    match: online.match || null,
    alerts: online.alerts || {},
    ladder: online.ladder || {},
    league: online.league || {},
    bot: online.bot || {},
    staff: online.staff || { role: '', name: '', key: false, powers: [] }
  }
}

function onlineHost(url) {
  return String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
}

// The one plain sentence about where online play stands.
function onlineLine(online, title) {
  if (!online.on) return 'Off. Games with other people are a separate service; nothing is sent until you turn it on.'
  if (online.offline) return online.offlineText || 'The online lobby cannot be reached right now. Everything here that runs on this computer still works.'
  if (online.match) return `Your table is ready: ${online.match.opponent || 'someone'} for ${online.match.title || online.match.game}.`
  if (!online.linked) return 'On. Choose the name you play as, or enter the key you already have.'
  if (online.game) return `Looking for a ${title || online.game} match. This keeps looking while you use Hermes.`
  return 'On. Nothing is sent until you press Find a match or Enter ladder.'
}

function ladderLine(ladder) {
  const state = String((ladder && ladder.state) || 'idle')
  if (state === 'idle') return ''
  if (state === 'starting') return 'Entering the ladder…'
  if (state === 'waiting') return 'Waiting for another bot to enter the ladder.'
  if (state === 'playing') return `${(ladder && ladder.text) || 'Playing.'} Move ${(ladder && ladder.plies) || 0}.`
  if (state === 'stopped') return 'Ladder game stopped.'
  if (state === 'error') return (ladder && ladder.text) || 'The ladder game stopped.'
  return (ladder && ladder.text) || 'The ladder game is over.'
}

// ----- Out of the way: minimize, close, Esc -----------------------------------
//
// The pane must leave easily and come back at once. Both are one session state,
// remembered in sessionStorage: 'min' collapses the pane to a slim strip, 'closed'
// does the same and asks the layout to hide the pane outright where it can (the
// narrow overlay). The status-bar item and the palette are always the way back.
const PANE_CHROME_KEY = 'gameshelf-pane-chrome'
const PANE_CHROME_EVENT = 'gameshelf:pane-chrome'

function paneChromePref() {
  try {
    const value = window.sessionStorage.getItem(PANE_CHROME_KEY)
    return value === 'min' || value === 'closed' ? value : 'open'
  } catch {
    return 'open'
  }
}

function rememberPaneChrome(value) {
  try {
    if (value === 'min' || value === 'closed') window.sessionStorage.setItem(PANE_CHROME_KEY, value)
    else window.sessionStorage.removeItem(PANE_CHROME_KEY)
  } catch {
    // No session storage (a plain QA page): the pane just stays as it is.
  }
  announcePaneChrome()
}

// Every door that opens, closes or minimizes the pane says so on this one event, and the
// doors that are drawn elsewhere (the Games header button, the status-bar item) listen for
// it: one announcement, so two surfaces can never disagree about where the pane is.
function announcePaneChrome() {
  try {
    window.dispatchEvent(new CustomEvent(PANE_CHROME_EVENT))
  } catch {
    // Nowhere to announce it.
  }
}

// Is the pane on the screen? The one read both doors use. The pane registers itself when it
// is wanted (a fresh load, or the palette/status door) and unregisters on ×, so its
// registration is the truth; a session that chose 'closed' stays closed even where the host
// kept the pane mounted.
function paneOnScreen() {
  if (paneChromePref() === 'closed') return false
  return Boolean(WAIT_PANE_SLOT.dispose)
}

// The same read, as state a component re-renders on: the way back in must be visible, not only in
// the command palette.
function usePaneOnScreen() {
  const [onScreen, setOnScreen] = useState(paneOnScreen)
  useEffect(() => {
    const sync = () => setOnScreen(paneOnScreen())
    try {
      window.addEventListener(PANE_CHROME_EVENT, sync)
      sync()
      return () => { try { window.removeEventListener(PANE_CHROME_EVENT, sync) } catch { /* gone */ } }
    } catch {
      return undefined
    }
  }, [])
  return onScreen
}

// Hide/show the pane frame where the layout supports it (narrow overlay); a wide
// dock ignores this and keeps the strip inside the pane.
function revealWaitPane(mode) {
  try {
    window.dispatchEvent(new CustomEvent('hermes:pane-toggle-reveal', { detail: { id: PANE_ID, mode } }))
  } catch {
    // No layout to talk to.
  }
}

function minimizeWaitPane() {
  rememberPaneChrome('min')
}

function closeWaitPane() {
  rememberPaneChrome('closed')
  rememberPaneGone(true)
  // Clear the saved game so reopening the pane starts fresh, not restoring
  // the last game. The pane reopens to the game list, not a stale board.
  try {
    if (typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined') {
      window.sessionStorage.removeItem(PANE_GAME_KEY)
    }
  } catch {
    // sessionStorage might not be available in some contexts.
  }
  // Off the screen completely: the pane's registration goes away with it.
  if (unmountWaitPane()) return
  // A desktop with dismissPane takes the pane and its column out of the layout
  // without disabling the plugin; revealPane (openWaitPane) brings it back.
  try {
    if (SDK_HOST && typeof SDK_HOST.dismissPane === 'function') {
      SDK_HOST.dismissPane(PANE_ID)
      return
    }
  } catch {
    // Fall back to the layout event below.
  }
  revealWaitPane('close')
}

function restoreWaitPane() {
  rememberPaneChrome('open')
  revealWaitPane('open')
  try {
    if (SDK_HOST && typeof SDK_HOST.revealPane === 'function') SDK_HOST.revealPane(PANE_ID)
  } catch {
    // The event above already covers older layouts.
  }
}

// Esc closes the pane while the person is working in it (focus inside the pane),
// and never while they are typing in the chat composer beside it.
function usePaneEscape(rootRef, onClose) {
  useEffect(() => {
    const onKey = event => {
      if (event.key !== 'Escape') return
      const root = rootRef && rootRef.current
      const focused = typeof document !== 'undefined' && document.activeElement
      if (!root || !focused || !root.contains(focused)) return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rootRef, onClose])
}

// A floating choice (start-over confirm, ladder ask) also closes on Esc and on a
// click anywhere outside it, the same way every dialog in the app does.
function useOutsideDone(open, ref, onDone) {
  useEffect(() => {
    if (!open) return undefined
    const onKey = event => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onDone()
    }
    const onClick = event => {
      const box = ref && ref.current
      if (box && event.target instanceof Node && box.contains(event.target)) return
      onDone()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onClick, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onClick, true)
    }
  }, [open, ref, onDone])
}

// The four strengths, in the product's own words. /opponents carries the same ids with
// the server's own labels; this fallback keeps the pane honest on an older host.
const LEVEL_CHOICES = [
  { id: 'beginner', label: 'Beginner' },
  { id: 'intermediate', label: 'Intermediate' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'expert', label: 'Expert' }
]
// The same words keyed by id, for whatever strengths a server advertises.
const LEVEL_LABELS = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced', expert: 'Expert', easy: 'Beginner', normal: 'Intermediate', hard: 'Advanced' }
