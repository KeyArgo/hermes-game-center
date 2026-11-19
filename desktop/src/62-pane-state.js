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
// The width the owner settled on by dragging (2026-11-18: "default where it is now"), so the pane
// opens at it on every computer; it can still be dragged from 300 px to 1200 px.
const PANE_WIDTH = '368px'
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

// Set while "Let people invite me" is on. Cleared when it is turned off, so the next
// time it is turned on the pane is shown again even if the person had closed it.
const INVITE_PANE_SEEN_KEY = 'gameshelf.pane.inviteOn'

function invitePaneSeen() {
  try {
    return window.localStorage.getItem(INVITE_PANE_SEEN_KEY) === '1'
  } catch {
    return false
  }
}

function rememberInvitePaneSeen(on) {
  try {
    if (on) window.localStorage.setItem(INVITE_PANE_SEEN_KEY, '1')
    else window.localStorage.removeItem(INVITE_PANE_SEEN_KEY)
  } catch {
    // The pane still follows the switch for this visit.
  }
}

// The switch came on: the pane is shown, including after the person had closed it.
function showPaneForInvites() {
  rememberPaneGone(false)
  rememberInvitePaneSeen(true)
  if (mountWaitPane()) {
    setTimeout(() => {
      try { restoreWaitPane() } catch { /* nothing to reveal into */ }
    }, 0)
    return true
  }
  try { restoreWaitPane() } catch { /* already where it should be */ }
  return Boolean(WAIT_PANE_SLOT.dispose)
}

// A hall snapshot. On shows the pane the first time, and again when the switch
// is turned on after being off. Closing the pane is remembered for as long as
// the switch stays on: a later snapshot does not put it back.
function invitePaneFollow(snap) {
  if (!snap || !snap.prefs || typeof snap.prefs.open !== 'boolean') return false
  if (!snap.prefs.open) {
    rememberInvitePaneSeen(false)
    return false
  }
  if (!invitePaneSeen()) return showPaneForInvites()
  if (paneGone()) return false
  return mountWaitPane() || Boolean(WAIT_PANE_SLOT.dispose)
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

// ---- The online account: one set of steps, drawn by the pane and by the Games page -------
//
// Turning online play on, picking a name, signing in with a saved key, changing that name,
// showing the key: the pane (65-wait-pane.js) and the Games page's Get online card
// (70-home.js) ask the person the same things, so they draw the same steps from here. The
// form's own state is the hook below and the markup is the block below it; each surface
// passes its own door (its own ctx.rest wrapper, with its own busy and note lines) and the
// online view it is already showing. Nothing here talks to the lobby server itself.

function useOnlineFields() {
  // '' until the person types: no name is ever filled in for them.
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  // The key the server handed out once, and the saved key the person asked to see. Either
  // one is put away again by a press, and neither is kept anywhere else.
  const [shownKey, setShownKey] = useState('')
  const [revealed, setRevealed] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [newName, setNewName] = useState('')
  return {
    name, setName, key, setKey, shownKey, setShownKey, revealed, setRevealed,
    renaming, setRenaming, newName, setNewName
  }
}

// "Suggest a name" is a route of its own (plugin_api.suggest_a_name). A build without it
// answers with an error, so the button asks once, quietly, and stays off the screen when
// there is nothing behind it: a button that cannot work is worse than no button.
const SUGGEST_PATH = '/name/suggest'

function useOnlineSuggest(ctx, wanted) {
  const [can, setCan] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!wanted || !ctx || typeof ctx.rest !== 'function') return undefined
    let alive = true
    ctx.rest(SUGGEST_PATH).then(
      answer => { if (alive) setCan(Boolean(answer && answer.ok !== false && (answer.name || answer.suggested_name))) },
      () => { if (alive) setCan(false) }
    )
    return () => { alive = false }
  }, [ctx, wanted])
  const suggest = async () => {
    if (!can || busy) return ''
    setBusy(true)
    try {
      const answer = await ctx.rest(SUGGEST_PATH)
      return String((answer && (answer.name || answer.suggested_name)) || '').trim()
    } catch {
      return ''
    } finally {
      setBusy(false)
    }
  }
  return { can, busy, suggest }
}

// The mask stands in for the key until the person asks to see it: what is on the screen is
// not a credential until it has been asked for.
const KEY_MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'

function onlineAccountBlock({ online, fields, call, busy, note, problem, setNote, suggest }) {
  const host = onlineHost(online.url)
  const rows = []
  const line = { fontSize: 12, color: text.secondary }
  const muted = { fontSize: 11, color: text.tertiary, lineHeight: 1.45 }
  const mono = { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12, overflowWrap: 'anywhere' }
  const row = (key, children, style) => jsx('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', ...(style || {}) }, children }, key)

  if (!online.on) {
    rows.push(jsx('div', {
      'data-online-disclosure': '1',
      style: { ...muted, border: `1px solid ${stroke}`, borderRadius: 6, padding: '6px 8px' },
      children: online.disclosure || `Online play talks to ${online.url} and nothing else.`
    }, 'disclosure'))
    rows.push(row('turn-on', [
      button('Turn on online play', () => call('/online/on'), { primary: true, disabled: busy }),
      button('Not now', () => setNote('Online stays off. Everything here still plays on this computer.'), { disabled: busy })
    ]))
  } else {
    if (!online.linked) {
      rows.push(jsx('div', {
        style: line,
        children: `Games with other people happen on ${host}. Pick the name you will be known by there.`
      }, 'where'))
      rows.push(row('pick-name', [
        field(fields.name, fields.setName, 'Your name online', () => fields.setName(fields.name.trim()), { label: 'Your name online' }),
        suggest.can
          ? button('Suggest a name', async () => {
              const name = await suggest.suggest()
              if (name) fields.setName(name)
            }, { disabled: busy || suggest.busy, title: 'Gives you a name nobody has taken yet. Press it again for another.' })
          : null
      ], { alignItems: 'stretch' }))
      rows.push(row('create', [
        button('Create my player', () => {
          // A press on a disabled button must still post nothing: the guard is here, not only
          // in the disabled flag.
          if (!fields.name.trim()) return undefined
          return call('/online/signup', { name: fields.name.trim() })
        }, {
          primary: true,
          disabled: busy || !fields.name.trim(),
          title: 'Makes this name yours on the lobby server and shows the key that signs you in on another computer.'
        })
      ]))
      rows.push(row('saved-key', [
        field(fields.key, fields.setKey, 'Recovery key you saved', () => signIn(), { label: 'Recovery key you saved' }),
        button('I have a player', () => signIn(), {
          disabled: busy || !fields.name.trim() || !fields.key.trim(),
          title: 'Signs in as the player you already have, with the name and key you saved.'
        })
      ], { alignItems: 'stretch' }))
    } else {
      rows.push(row('me', [
        jsx('span', { style: line, children: `You are ${online.name} online` }, 'name'),
        textLink('Change my name', () => {
          fields.setRenaming(!fields.renaming)
          fields.setNewName(fields.renaming ? '' : online.name)
          setNote('')
        }, 'Change the name other people see, once every 30 days'),
        textLink('Sign out', () => call('/online/forget'), 'Stop using this computer’s key. The account stays.', 'sign-out')
      ]))
      if (fields.renaming) {
        rows.push(row('rename', [
          field(fields.newName, fields.setNewName, 'New name', () => saveName(), { label: 'The name you want instead' }),
          button('Save name', () => saveName(), { primary: true, disabled: busy || !fields.newName.trim() }),
          textLink('Cancel', () => { fields.setRenaming(false); fields.setNewName('') }, 'Keep the name you have')
        ], { alignItems: 'stretch' }))
      }
      // The key the server handed out is on screen once, until it is put away.
      if (fields.shownKey) {
        rows.push(jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 }, children: [
          jsx('div', { style: muted, children: 'This is your recovery key. It is shown once, and it is what signs you in on another computer. It is kept with your other Hermes credentials.' }),
          jsx('div', { 'data-online-new-key': '1', style: mono, children: fields.shownKey }),
          row('copy-new', [
            button('Copy recovery key', () => copyText(fields.shownKey, () => setNote('Copied to the clipboard.')), { primary: true }),
            textLink('Hide this key', () => fields.setShownKey(''))
          ])
        ] }, 'fresh-key'))
      }
      rows.push(row('show-key', [
        jsx('span', { style: muted, children: fields.revealed ? 'Your key:' : `Your key: ${KEY_MASK}` }, 'mask'),
        fields.revealed
          ? button('Copy my key', () => copyText(fields.revealed, () => setNote('Copied to the clipboard.')))
          : null,
        textLink(fields.revealed ? 'Hide my key' : 'Show my key', async () => {
          if (fields.revealed) { fields.setRevealed(''); setNote(''); return }
          const answer = await call('/online/key', undefined, 'GET')
          if (answer && answer.ok && answer.key) fields.setRevealed(String(answer.key))
        }, 'Show the key saved in Hermes’s credentials on this computer')
      ]))
      rows.push(jsx('div', {
        'data-online-revealed': fields.revealed ? 'shown' : 'masked',
        style: fields.revealed ? mono : { display: 'none' },
        children: fields.revealed
      }, 'revealed'))
      rows.push(row('save-file', [
        textLink('Save my account file', async () => {
          const answer = await call('/online/account-file')
          if (answer && answer.ok && answer.path) setNote(`Saved in ${answer.path}`)
        }, 'Write your name, key and server to a file in your Downloads folder')
      ]))
    }
    // Whoever turned it on can turn it off, signed in or not: a person who never got as far as
    // a name must not be stuck with online play on.
    rows.push(row('turn-off', [
      textLink('Turn online play off', () => call('/online/off'), 'Stops everything online. Local play is untouched.')
    ], { marginTop: 6 }))
  }
  if (problem) {
    rows.push(jsx('div', {
      role: 'alert', 'data-online-problem': '1',
      style: { ...line, color: text.primary, border: `1px solid ${accent}`, borderRadius: 8, padding: '6px 10px' },
      children: problem
    }, 'problem'))
  } else if (note) {
    rows.push(jsx('div', {
      role: 'status', 'aria-live': 'polite', 'data-online-note': '1',
      style: { ...line, color: text.secondary },
      children: note
    }, 'note'))
  }
  return jsxs('div', {
    'data-online-account': online.linked ? 'linked' : online.on ? 'named-not-yet' : 'off',
    style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
    children: rows
  })

  // Change my name is the server's decision, so its own sentence is what comes back.
  async function saveName() {
    const wanted = fields.newName.trim()
    if (!wanted) return
    const answer = await call('/online/rename', { name: wanted })
    if (answer && answer.ok) { fields.setRenaming(false); fields.setNewName('') }
  }

  // Signing in needs both halves; a press with either one missing posts nothing.
  function signIn() {
    const name = fields.name.trim()
    const key = fields.key.trim()
    if (!name || !key) return
    return call('/online/signin', { name, key })
  }
}

// Check online: each step from this computer to the lobby, in the server's own words where
// it refuses. The Hall shows it under its roster and the Get online card shows it in place,
// so the run and the rows are here and both surfaces mount them.
function useOnlineCheck(ctx) {
  const [checked, setChecked] = useState(null)
  const [checking, setChecking] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const runCheck = async () => {
    if (checking || !ctx || typeof ctx.rest !== 'function') return
    setChecking(true)
    try {
      const answer = await ctx.rest('/online/check')
      if (alive.current) setChecked(answer && typeof answer === 'object' ? answer : { ok: false, steps: [] })
    } catch {
      if (alive.current) setChecked({ ok: false, steps: [{ name: 'Game Center', ok: false, text: 'Game Center did not answer. Reopen Hermes and try again.' }] })
    } finally {
      if (alive.current) setChecking(false)
    }
  }
  return { checked, checking, runCheck }
}

function onlineCheckBlock({ checked, checking, runCheck }) {
  return jsxs('div', { 'data-hall-check': '1', style: { display: 'flex', flexDirection: 'column', gap: 4 }, children: [
    jsxs('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }, children: [
      button(checking ? 'Checking…' : 'Check online', runCheck, {
        disabled: checking,
        title: 'Checks each step from this computer to the lobby and says which one is not working.'
      })
    ] }),
    checked ? jsxs('div', { role: 'status', 'aria-live': 'polite', style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11 }, children: [
      ...(Array.isArray(checked.steps) ? checked.steps : []).map((row, index) => jsxs('div', {
        'data-hall-check-row': row.ok ? 'ok' : 'fix',
        children: [
          jsx('span', { style: { fontWeight: 650, color: row.ok ? text.secondary : accent }, children: `${row.ok ? 'OK' : 'Fix'} · ${row.name}: ` }),
          jsx('span', { style: { color: text.secondary }, children: String(row.text || '') })
        ]
      }, index)),
      checked.ok ? jsx('div', { style: { color: text.tertiary }, children: 'Every step works.' }) : null
    ] }) : null
  ] })
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
