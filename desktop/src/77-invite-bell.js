// ---- 77-invite-bell.js: an invite reaches the person wherever they are
//
// A play request used to exist only where the Games page draws it — the Hall's request cards
// and the Play with people card. Someone reading their chat, or working on another screen, had
// no way to know that another person had asked them to play until they went looking. The owner
// (2026-11-19): "make sure it actually pops up on their screen no matter where they are instead
// of requiring them to be in game center".
//
// WHAT THIS IS. One contribution to the status bar and one to the titlebar's right cluster —
// the two areas this plugin already renders into (78-overchat-slot.js draws its stage from
// exactly this pair, for the same reason: they are mounted for as long as the window is open).
// An invite drawn there is drawn wherever the person is in Hermes. Nothing here reads, writes or
// styles the host's markup: the invite is a component in a slot the host owns, and every press
// goes out through the same four doors the Hall uses.
//
// ONE OF THE TWO DRAWS. The titlebar copy is the stand-in for a window whose status bar is not
// there (Simple mode rests it hidden, and anyone may hide it). Both mount, only the first in
// INVITE_SURFACE_ORDER that is on screen draws, so the person never sees the same invite twice.
//
// THE POLL IS ONE READ, SHARED. Both surfaces subscribe to one store, and the store owns one
// timer: the first surface to mount starts it and the last to leave stops it. It reads
// /online/hall — the door the Hall itself reads — every 3 s while a request is pending and every
// 8 s (the alert line's own rhythm) when nothing is, and it does not read at all while the
// window is hidden: a minimised Hermes asks the lobby nothing. The Hall's own 3 s read feeds
// this store as well (inviteBellFeed), and a feed younger than INVITE_FEED_FRESH_MS is what the
// timer counts as its own answer, so on the Games page there is one read, not two.
//
// THE SYSTEM NOTIFICATION. ctx.os.notify is the SDK's own notice. One is sent per invite, and
// only under the switch that already means "tell me when someone wants a match" for that game
// (alertsOn in 62-pane-state.js): the person asked for a notice about that game, so they get
// one. With that switch off nothing pops up over their work — the callout above is still there,
// which is the surface that has to carry it.
const INVITE_POLL_PENDING_MS = 3000
const INVITE_POLL_IDLE_MS = 8000
// A Hall feed younger than this is the answer the timer would have asked for.
const INVITE_FEED_FRESH_MS = 2000

// The order the two surfaces are offered in: the status bar first (it is the one in the chrome
// the person already reads), the titlebar as its stand-in.
const INVITE_SURFACE_ORDER = ['statusbar', 'titlebar']

// The one store both surfaces read. `request` is the pending ask addressed to this person, or
// null when nobody is asking.
const INVITE_BELL = {
  request: null,
  snap: null,
  error: '',
  ctx: null,
  fresh: 0,
  notified: '',
  watching: false,
  timer: null,
  surfaces: {},
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
  if (request) inviteBellNotify(request, snap)
  inviteBellSchedule()
}

// Drop a request this surface just answered, so the callout leaves at the press rather than on
// the next read. The server's own update follows and keeps it away.
function inviteBellDrop(id) {
  const current = INVITE_BELL.request
  if (current && String(current.id) === String(id)) inviteBellPublish({ request: null })
}

// The notice, once per invite, and only for a game the person asked to hear about.
function inviteBellNotify(request, snap) {
  if (!request || !inviteBellRemembered(request)) return
  const ctx = INVITE_BELL.ctx
  if (!ctx || typeof alertsOn !== 'function') return
  const prefs = (snap && snap.prefs) || {}
  // Nobody can ask a person who has invitations off; a request that arrived before the switch
  // went off is still shown and still answerable, and it still makes no sound.
  if (!prefs.open) return
  if (!alertsOn(ctx, request.game)) return
  try {
    if (!ctx.os || typeof ctx.os.notify !== 'function') return
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

// One notice per request id, so a 3 s read cannot ring the same bell twice.
function inviteBellRemembered(request) {
  const id = String(request.id || '')
  if (!id || INVITE_BELL.notified === id) return false
  INVITE_BELL.notified = id
  return true
}

// Where an accepted invite goes: the Games screen, which draws the table the lobby just seated.
function inviteBellOpen() {
  if (typeof host !== 'undefined' && host && typeof host.navigate === 'function') host.navigate(ROUTE)
}

function inviteBellNextDelay() {
  return INVITE_BELL.request ? INVITE_POLL_PENDING_MS : INVITE_POLL_IDLE_MS
}

// The timer is re-armed after every read, so the cadence follows the news: 3 s while somebody is
// waiting on an answer, the alert line's 8 s otherwise.
function inviteBellSchedule() {
  if (!INVITE_BELL.watching) return
  if (INVITE_BELL.timer) { clearTimeout(INVITE_BELL.timer); INVITE_BELL.timer = null }
  if (inviteBellHidden()) return
  INVITE_BELL.timer = setTimeout(inviteBellTick, inviteBellNextDelay())
}

async function inviteBellRead(ctx) {
  if (!ctx || typeof ctx.rest !== 'function') return
  try {
    const answer = await ctx.rest('/online/hall')
    if (answer && typeof answer === 'object') inviteBellFeed(answer)
    else inviteBellPublish({ error: '' })
  } catch {
    // The last invite stays on screen: a read that failed is not an invite that went away.
    inviteBellPublish({ error: 'The lobby could not be read just now.' })
  }
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
  // elsewhere is on screen the moment the surface mounts.
  inviteBellTick()
}

function inviteBellUnwatch() {
  INVITE_BELL.watching = false
  if (INVITE_BELL.timer) { clearTimeout(INVITE_BELL.timer); INVITE_BELL.timer = null }
  const doc = inviteBellDocument()
  if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', inviteBellVisibility)
}

// One surface on screen at a time: the first in INVITE_SURFACE_ORDER whose host mounted it.
function inviteBellDraws(where) {
  for (const name of INVITE_SURFACE_ORDER) {
    if (Number(INVITE_BELL.surfaces[name] || 0) > 0) return name === where
  }
  return false
}

function inviteBellMark(where, on) {
  const surfaces = { ...INVITE_BELL.surfaces }
  const count = Number(surfaces[where] || 0) + (on ? 1 : -1)
  if (count > 0) surfaces[where] = count
  else delete surfaces[where]
  inviteBellPublish({ surfaces })
}

// The store, as a component reads it: re-render on every change, and stand the shared poll up
// while at least one surface is mounted.
function useInviteBell(ctx) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const listener = () => setTick(count => count + 1)
    INVITE_BELL.listeners.add(listener)
    INVITE_BELL.ctx = ctx || INVITE_BELL.ctx
    return () => { INVITE_BELL.listeners.delete(listener) }
  }, [ctx])
  useEffect(() => {
    if (!INVITE_BELL.watching) inviteBellWatch()
    return () => { if (!INVITE_BELL.listeners.size) inviteBellUnwatch() }
  }, [])
  return INVITE_BELL
}

// The answer, from this surface: the same POST the Hall's own Accept and Decline send, so both
// screens answer one request the same way. Accept then opens the table the lobby seated: the room
// is opened here and the Games screen paints it, which is what "Accept" means to the person.
async function inviteBellAnswer(ctx, request, accept) {
  if (!ctx || typeof ctx.rest !== 'function') return { ok: false, text: 'Game Center cannot be reached.' }
  try {
    const answer = await ctx.rest('/online/hall/respond', { method: 'POST', body: { id: request.id, accept: Boolean(accept) } })
    if (answer && answer.ok === false) return { ok: false, text: String(answer.text || 'The lobby did not take that answer.') }
    inviteBellDrop(request.id)
    if (accept) {
      const seat = await inviteBellSeat(ctx)
      if (seat) await openOnlineTable(ctx, seat.room_id, seat.game)
      inviteBellOpen()
    }
    return answer || { ok: true }
  } catch {
    return { ok: false, text: 'That did not reach Game Center. Try again.' }
  }
}

// The seat the lobby just made, read once. A read that lands before the lobby's own "seated"
// frame simply finds nothing; the Games screen opens the table on its next look.
async function inviteBellSeat(ctx) {
  try {
    const snap = await ctx.rest('/online/hall')
    if (!snap || typeof snap !== 'object') return null
    inviteBellFeed(snap)
    const seated = snap.seated || null
    return seated && seated.room_id ? seated : null
  } catch {
    return null
  }
}

// One surface's copy of the invite: who it is from, what game, and the two answers.
function InviteBell({ ctx, where = 'statusbar' }) {
  const bell = useInviteBell(ctx)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  // This copy says it is on screen once, for as long as it is mounted: `where` is the surface the
  // registration names and never changes under a mounted component.
  useEffect(() => {
    inviteBellMark(where, true)
    return () => inviteBellMark(where, false)
  }, [])
  const request = bell.request
  if (!request || !inviteBellDraws(where)) return null
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
  return jsxs('span', {
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
  })
}
