// ---- 77-invite-bell.js: an invite reaches the person wherever they are
//
// A play request is shown wherever the person is in Hermes, not only on the Games page (the
// Hall's request cards and the Play with people card). Someone reading their chat, or working
// on another screen, sees that another person has asked them to play without going looking.
//
// WHAT THIS IS. One contribution to the status bar and one to the titlebar's right cluster —
// the two areas this plugin already renders into (78-overchat-slot.js draws its stage from
// exactly this pair, for the same reason: they are mounted for as long as the window is open) —
// and the fixed line at the top of the side pane (65-wait-pane.js). Nothing here reads, writes
// or styles the host's markup: the invite is a component in a slot the host owns, and every
// press goes out through the same four doors the Hall uses.
//
// ONE OF THE TWO DRAWS. The titlebar copy is the stand-in for a status bar that is not on
// screen (Simple mode rests it hidden, a narrow window clips it, anyone may hide it). Each copy
// watches its OWN element with an IntersectionObserver (useInviteSurface); the status-bar copy
// draws while its element is in sight, and the titlebar copy draws while it is not. No host
// element is ever looked up.
//
// THE POLL IS ONE READ, SHARED, AND IT BELONGS TO THE PLUGIN. Registration starts it
// (80-plugin.js) and the plugin's disposal stops it, so which slots happen to be mounted never
// decides whether an invite arrives. It reads /online/hall — the door the Hall itself reads —
// every 3 s while something is moving (a request either way, a search, the pane's Play with
// people tab on screen) and every 8 s when nothing is, and it does not read at all while the
// window is hidden: a minimised Hermes asks the lobby nothing. The Hall's own 3 s read feeds
// this store as well (inviteBellFeed), and a feed younger than INVITE_FEED_FRESH_MS is what the
// timer counts as its own answer, so on the Games page there is one read, not two.
//
// THE SYSTEM NOTIFICATION. ctx.os.notify is the SDK's own notice. One silent notice is sent per
// request id, only while "Open to invites" is on, and only when none of the three surfaces that
// draw an invite is on screen. A surface reports itself a moment after it mounts, so the notice
// waits INVITE_NOTICE_WAIT_MS before it decides.
const INVITE_POLL_PENDING_MS = 3000
const INVITE_POLL_IDLE_MS = 8000
// A Hall feed younger than this is the answer the timer would have asked for.
const INVITE_FEED_FRESH_MS = 2000
// How long a new request waits for a surface to say it is on screen before the notice goes out.
const INVITE_NOTICE_WAIT_MS = 1500

// The order the two chrome surfaces are offered in: the status bar first (it is the one in the
// chrome the person already reads), the titlebar as its stand-in.
const INVITE_SURFACE_ORDER = ['statusbar', 'titlebar']

// The one store every surface reads. `request` is the pending ask addressed to this person, or
// null when nobody is asking. `seen` is which surfaces are on screen right now, by name.
const INVITE_BELL = {
  request: null,
  snap: null,
  error: '',
  ctx: null,
  fresh: 0,
  notified: new Set(),
  readGeneration: 0,
  noticeTimer: null,
  watching: false,
  timer: null,
  eager: 0,
  seen: {},
  listeners: new Set()
}

function inviteBellWindow() {
  return typeof window === 'undefined' ? null : window
}

// The document, for the one thing this needs from it: whether the window is on screen.
function inviteBellDocument() {
  if (typeof document !== 'undefined' && document) return document
  const win = inviteBellWindow()
  return (win && win.document) || null
}

// A hidden window is not watching, so nothing is read for it. The host's own tab visibility is
// what every web surface uses; it is not the app's markup and it is not a selector.
function inviteBellHidden() {
  const doc = inviteBellDocument()
  return Boolean(doc && doc.hidden)
}

// "Bea invites you to Connect 4" — one sentence, in the owner's words, naming the person and
// the game. Never a title from a manifest this surface cannot see: lobbyTitle is the lobby's own
// list, the same one the Hall draws from.
function inviteBellLine(request) {
  if (!request) return ''
  const name = String((request.from && request.from.name) || 'Someone')
  return `${name} invites you to ${lobbyTitle(request.game)}`
}

// The pending ask addressed to this person, if there is one. A match offer counts: it is a
// person asking this one to sit down and play, and it waits on the same answer.
function inviteOf(snap) {
  const you = (snap && snap.you) || {}
  const mine = String(you.id || '')
  if (!mine) return null
  const rows = Array.isArray(snap && snap.requests) ? snap.requests : []
  return rows.find(row => row && row.state === 'pending'
    && row.to && String(row.to.id) === mine) || null
}

function inviteBellPublish(patch) {
  let changed = false
  for (const key of Object.keys(patch)) {
    if (INVITE_BELL[key] !== patch[key]) { INVITE_BELL[key] = patch[key]; changed = true }
  }
  if (changed) for (const listener of Array.from(INVITE_BELL.listeners)) listener()
}

// One Hall snapshot, from whichever surface read it. The Hall and the Play with people card both
// hand their own poll over, so the bell paints from the read that already happened.
function inviteBellFeed(snap) {
  if (!snap || typeof snap !== 'object') return
  INVITE_BELL.fresh = Date.now()
  inviteBellPublish({ snap, error: '' })
  const request = inviteOf(snap)
  inviteBellPublish({ request })
  if (request) inviteBellNotice(request)
  inviteBellSchedule()
}

// Drop a request this surface just answered, so the callout leaves at the press rather than on
// the next read. The server's own update follows and keeps it away.
function inviteBellDrop(id) {
  const current = INVITE_BELL.request
  if (current && String(current.id) === String(id)) inviteBellPublish({ request: null })
}

// Is any surface that draws an invite on screen? The status bar and the titlebar between them
// always draw one (the titlebar stands in when the status bar is out of sight), and the pane
// draws its own line on every tab and in its strip.
function inviteBellShown() {
  const seen = INVITE_BELL.seen || {}
  return Boolean(seen.statusbar || seen.titlebar || seen.pane)
}

// The notice for one request, decided INVITE_NOTICE_WAIT_MS after the read that found it, so a
// surface that has just mounted has had the moment it needs to say whether it is on screen.
function inviteBellNotice(request) {
  const id = String((request && request.id) || '')
  if (!id || INVITE_BELL.notified.has(id) || INVITE_BELL.noticeTimer) return
  INVITE_BELL.noticeTimer = setTimeout(() => {
    INVITE_BELL.noticeTimer = null
    inviteBellNotify(id)
  }, INVITE_NOTICE_WAIT_MS)
}

// The notice itself: still the request on screen, invitations still open, nothing showing it,
// and never twice for one request id.
function inviteBellNotify(id) {
  const request = INVITE_BELL.request
  if (!request || String(request.id) !== id || INVITE_BELL.notified.has(id)) return
  const prefs = (INVITE_BELL.snap && INVITE_BELL.snap.prefs) || {}
  // Nobody can ask a person who has invitations off; a request that arrived before the switch
  // went off is still shown and still answerable, and it makes no notice.
  if (!prefs.open) return
  if (inviteBellShown()) return
  const ctx = INVITE_BELL.ctx
  if (!ctx || !ctx.os || typeof ctx.os.notify !== 'function') return
  INVITE_BELL.notified.add(id)
  try {
    ctx.os.notify({
      title: 'Someone wants to play',
      body: inviteBellLine(request),
      silent: true,
      onActivate: () => inviteBellOpen()
    })
  } catch {
    // A notice is optional; the callout is not.
  }
}

// Where an accepted invite goes from the chrome: the Games screen, which draws the table the
// lobby just seated.
function inviteBellOpen() {
  if (typeof host !== 'undefined' && host && typeof host.navigate === 'function') host.navigate(ROUTE)
}

// Something is moving: a request either way, a search, or a surface that asked for the quick
// rhythm (the pane's Play with people tab).
function inviteBellLively() {
  if (INVITE_BELL.request || INVITE_BELL.eager > 0) return true
  const snap = INVITE_BELL.snap || {}
  const you = snap.you || {}
  if (Array.isArray(you.looking) && you.looking.length) return true
  const mine = String(you.id || '')
  const rows = Array.isArray(snap.requests) ? snap.requests : []
  return Boolean(mine) && rows.some(row => row && row.state === 'pending' && row.from && String(row.from.id) === mine)
}

function inviteBellNextDelay() {
  return inviteBellLively() ? INVITE_POLL_PENDING_MS : INVITE_POLL_IDLE_MS
}

// The timer is re-armed after every read, so the cadence follows the news: 3 s while something
// is moving, 8 s otherwise.
function inviteBellSchedule() {
  if (!INVITE_BELL.watching) return
  if (INVITE_BELL.timer) { clearTimeout(INVITE_BELL.timer); INVITE_BELL.timer = null }
  if (inviteBellHidden()) return
  INVITE_BELL.timer = setTimeout(inviteBellTick, inviteBellNextDelay())
}

async function inviteBellRead(ctx) {
  if (!ctx || typeof ctx.rest !== 'function') return
  try {
    const generation = ++INVITE_BELL.readGeneration
    const answer = await ctx.rest('/online/hall')
    if (generation !== INVITE_BELL.readGeneration) return
    if (answer && typeof answer === 'object') inviteBellFeed(answer)
    else inviteBellPublish({ error: '' })
  } catch {
    // The last invite stays on screen: a read that failed is not an invite that went away.
    inviteBellPublish({ error: 'The lobby could not be read just now.' })
  }
}

// A read now, for a surface that has just changed something on the lobby (a search, an ask) and
// wants its answer drawn without waiting for the timer. The read re-arms the one timer.
function inviteBellRefresh() {
  return inviteBellRead(INVITE_BELL.ctx)
}

async function inviteBellTick() {
  INVITE_BELL.timer = null
  if (!INVITE_BELL.watching || inviteBellHidden()) return
  // A Hall on screen has just answered for us: asking again would be the second read of one
  // question. Only a read older than INVITE_FEED_FRESH_MS is worth making.
  const fed = Date.now() - Number(INVITE_BELL.fresh || 0) < INVITE_FEED_FRESH_MS
  if (!fed) await inviteBellRead(INVITE_BELL.ctx)
  inviteBellSchedule()
}

// Coming back is a read at once; going away is no reads at all.
function inviteBellVisibility() {
  if (inviteBellHidden()) {
    if (INVITE_BELL.timer) { clearTimeout(INVITE_BELL.timer); INVITE_BELL.timer = null }
    return
  }
  inviteBellTick()
}

function inviteBellWatch() {
  INVITE_BELL.watching = true
  const doc = inviteBellDocument()
  if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', inviteBellVisibility)
  // The first look is now, not after a delay: a request that arrived while this window was
  // closed is on screen the moment the plugin is up.
  inviteBellTick()
}

function inviteBellUnwatch() {
  INVITE_BELL.watching = false
  if (INVITE_BELL.timer) { clearTimeout(INVITE_BELL.timer); INVITE_BELL.timer = null }
  if (INVITE_BELL.noticeTimer) { clearTimeout(INVITE_BELL.noticeTimer); INVITE_BELL.noticeTimer = null }
  const doc = inviteBellDocument()
  if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', inviteBellVisibility)
}

// The plugin's poll: started once at registration, stopped by the plugin's disposal.
function inviteBellStart(ctx) {
  INVITE_BELL.ctx = ctx || INVITE_BELL.ctx
  if (!INVITE_BELL.watching) inviteBellWatch()
  return inviteBellStop
}

function inviteBellStop() {
  INVITE_BELL.readGeneration += 1
  inviteBellUnwatch()
}

// The quick rhythm, while a surface that shows the lobby live is on screen. Still the one timer.
function inviteBellEager(on) {
  INVITE_BELL.eager = Math.max(0, Number(INVITE_BELL.eager || 0) + (on ? 1 : -1))
  if (on && INVITE_BELL.watching && INVITE_BELL.timer) inviteBellSchedule()
}

// One chrome surface draws at a time: the first in INVITE_SURFACE_ORDER whose element is on
// screen, or the stand-in at the end of the list when none is.
function inviteBellDraws(where) {
  const first = INVITE_SURFACE_ORDER.find(name => INVITE_BELL.seen[name])
  return (first || INVITE_SURFACE_ORDER[INVITE_SURFACE_ORDER.length - 1]) === where
}

function inviteBellSeen(where, on) {
  const seen = { ...INVITE_BELL.seen }
  if (on) seen[where] = true
  else delete seen[where]
  if (Boolean(INVITE_BELL.seen[where]) !== Boolean(on)) inviteBellPublish({ seen })
}

// What an observer entry says: on screen only with some of the element actually in view, so a bar
// clipped to nothing counts as out of sight.
function inviteBellInSight(entry) {
  if (!entry || !entry.isIntersecting) return false
  const box = entry.intersectionRect
  return !box || (Number(box.width) > 0 && Number(box.height) > 0)
}

// A surface's own element, watched. The returned callback is the element's ref: it observes that
// element and nothing else. A mounted surface counts as on screen until its observer answers, and
// a host with no IntersectionObserver keeps that answer.
function useInviteSurface(where) {
  const held = useRef({ node: null, observer: null })
  useEffect(() => {
    inviteBellSeen(where, true)
    const watch = held.current
    return () => {
      if (watch.observer) { try { watch.observer.disconnect() } catch { /* already gone */ } }
      watch.observer = null
      watch.node = null
      inviteBellSeen(where, false)
    }
  }, [where])
  return useCallback(node => {
    const watch = held.current
    if (watch.node === node) return
    if (watch.observer) { try { watch.observer.disconnect() } catch { /* already gone */ } }
    watch.observer = null
    watch.node = node || null
    if (!node || typeof IntersectionObserver === 'undefined') return
    try {
      watch.observer = new IntersectionObserver(entries => {
        const list = Array.isArray(entries) ? entries : []
        if (list.length) inviteBellSeen(where, inviteBellInSight(list[list.length - 1]))
      }, { threshold: [0, 1] })
      watch.observer.observe(node)
    } catch {
      watch.observer = null
    }
  }, [where])
}

// The store, as a component reads it: re-render on every change. Reading never starts or stops
// the poll; that is the plugin's (inviteBellStart).
function useInviteBell(ctx) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const listener = () => setTick(count => count + 1)
    INVITE_BELL.listeners.add(listener)
    INVITE_BELL.ctx = ctx || INVITE_BELL.ctx
    return () => { INVITE_BELL.listeners.delete(listener) }
  }, [ctx])
  return INVITE_BELL
}

// "Bea asks to play Chess": the pane's own words for an invite, short enough for one line at the
// pane's narrowest.
function paneInviteWords(request) {
  if (!request) return ''
  const name = String((request.from && request.from.name) || 'Someone')
  return `${name} asks to play ${lobbyTitle(request.game)}`
}

// The fixed line at the top of the side pane: "Bea asks to play Chess · Accept · Decline". The
// pane draws it above its scrolling body on every tab, so it cannot scroll away. The words and
// the two answers are the bell's; this only places them.
function paneInviteBlock(ctx, request, busy, note, onAnswer) {
  if (!request) return null
  const name = String((request.from && request.from.name) || 'them')
  const title = lobbyTitle(request.game)
  const press = primary => ({
    type: 'button',
    disabled: Boolean(busy),
    style: {
      fontSize: 12, padding: '2px 10px', borderRadius: 999, cursor: busy ? 'default' : 'pointer', flex: '0 0 auto',
      border: `1px solid ${primary ? accent : stroke}`,
      background: primary ? accent : 'transparent',
      color: primary ? 'var(--ui-text-on-accent, white)' : text.secondary
    }
  })
  return jsxs('div', {
    'data-pane-invite': String(request.id),
    role: 'status',
    'aria-live': 'polite',
    style: {
      flex: '0 0 auto', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0,
      borderBottom: `1px solid ${accent}`, padding: '8px 10px', background: fill
    },
    children: [
      jsx('span', {
        'data-pane-invite-line': '1',
        style: { flex: '1 1 150px', minWidth: 0, fontSize: 13, fontWeight: 650, lineHeight: 1.4 },
        children: paneInviteWords(request)
      }),
      jsx('button', {
        ...press(true),
        'data-pane-invite-accept': '1',
        'aria-label': `Accept ${name}'s invitation to ${title}`,
        onClick: () => onAnswer(true),
        children: 'Accept'
      }),
      jsx('button', {
        ...press(false),
        'data-pane-invite-decline': '1',
        'aria-label': `Decline ${name}'s invitation to ${title}`,
        onClick: () => onAnswer(false),
        children: 'Decline'
      }),
      note ? jsx('span', { 'data-pane-invite-note': '1', style: { flexBasis: '100%', fontSize: 11, color: text.secondary }, children: note }) : null
    ]
  })
}

// The answer, from any surface: the same POST the Hall's own Accept and Decline send, so every
// screen answers one request the same way. Accept then opens the table the lobby seated. From the
// chrome the Games screen paints it; with `here` (the side pane) nothing navigates and the seat is
// handed back, so the pane draws the table itself. A seat that has not arrived yet comes back as
// null, and the pane opens it from a later read.
async function inviteBellAnswer(ctx, request, accept, options = {}) {
  if (!ctx || typeof ctx.rest !== 'function') return { ok: false, text: 'Game Center cannot be reached.' }
  try {
    const answer = await ctx.rest('/online/hall/respond', { method: 'POST', body: { id: request.id, accept: Boolean(accept) } })
    if (answer && answer.ok === false) return { ok: false, text: String(answer.text || 'The lobby did not take that answer.') }
    inviteBellDrop(request.id)
    if (!accept) return answer || { ok: true }
    const seat = await inviteBellSeat(ctx, request)
    if (options.here) {
      if (seat) {
        const opened = await openOnlineTable(ctx, seat.room_id, seat.game)
        if (opened && opened.ok === false) return { ok: false, text: String(opened.text || 'That table would not open.') }
      }
      return { ...(answer || { ok: true }), seat: seat || null }
    }
    if (seat) await openOnlineTable(ctx, seat.room_id, seat.game)
    inviteBellOpen()
    return answer || { ok: true }
  } catch {
    return { ok: false, text: 'That did not reach Game Center. Try again.' }
  }
}

// The seat a snapshot carries for an accepted request, if it is one to open: not a room this
// person already left, and not a seat made for another request.
function inviteSeatOf(snap, requestId) {
  const seated = (snap && snap.seated) || null
  if (!seated || !seated.room_id) return null
  if (HALL_LEFT.has(String(seated.room_id))) return null
  const wanted = requestId ? String(requestId) : ''
  const got = seated.request_id ? String(seated.request_id) : ''
  if (wanted && got && wanted !== got) return null
  return seated
}

// The seat the lobby just made, read once. A read that lands before the lobby's own "seated"
// frame simply finds nothing; the surface opens the table from a later read.
async function inviteBellSeat(ctx, request) {
  try {
    const snap = await ctx.rest('/online/hall')
    if (!snap || typeof snap !== 'object') return null
    inviteBellFeed(snap)
    return inviteSeatOf(snap, request && request.id)
  } catch {
    return null
  }
}

// One chrome surface's copy of the invite: who it is from, what game, and the two answers. Its
// element is always there (empty while nobody asks) so it can watch itself: an observer on its own
// element says whether this copy is on screen.
function InviteBell({ ctx, where = 'statusbar' }) {
  const bell = useInviteBell(ctx)
  const surface = useInviteSurface(where)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const request = bell.request
  const drawing = Boolean(request) && inviteBellDraws(where)
  const anchor = children => jsx('span', {
    ref: surface,
    'data-invite-surface': where,
    style: { display: 'inline-flex', alignItems: 'center', minWidth: 1, minHeight: 1 },
    children
  })
  if (!drawing) return anchor(null)
  const line = inviteBellLine(request)
  const name = String((request.from && request.from.name) || 'them')
  const title = lobbyTitle(request.game)
  const answer = async accept => {
    if (busy) return
    setBusy(true)
    setNote('')
    try {
      const reply = await inviteBellAnswer(ctx, request, accept)
      if (reply && reply.ok === false) setNote(String(reply.text || 'The lobby did not take that answer.'))
    } finally {
      setBusy(false)
    }
  }
  const pill = primary => ({
    fontSize: 11, padding: '1px 8px', borderRadius: 999, cursor: busy ? 'default' : 'pointer',
    border: `1px solid ${primary ? accent : stroke}`,
    background: primary ? accent : 'transparent',
    color: primary ? 'var(--ui-text-on-accent, white)' : text.secondary,
    whiteSpace: 'nowrap'
  })
  return anchor(jsxs('span', {
    'data-invite-bell': where,
    role: 'status',
    'aria-live': 'polite',
    style: { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: 11, color: text.primary },
    children: [
      jsx('span', {
        'data-invite-line': '1',
        title: line,
        style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 },
        children: line
      }),
      jsx('button', {
        type: 'button',
        'data-invite-accept': '1',
        'aria-label': `Accept ${name}'s invitation to ${title}`,
        title: `Sit down with ${name} at ${title}.`,
        disabled: busy,
        autoFocus: false,
        onClick: () => answer(true),
        style: pill(true),
        children: 'Accept'
      }),
      jsx('button', {
        type: 'button',
        'data-invite-decline': '1',
        'aria-label': `Decline ${name}'s invitation to ${title}`,
        title: `Say no to ${name} for ${title}.`,
        disabled: busy,
        autoFocus: false,
        onClick: () => answer(false),
        style: pill(false),
        children: 'Decline'
      }),
      note ? jsx('span', { 'data-invite-note': '1', style: { color: text.secondary }, children: note }) : null
    ]
  }))
}
