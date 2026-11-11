// ---- 72-lobby.js: the home lobby and its chat column

// Every two-player game the lobby server can seat, with the label its switch wears.
// This mirrors online/requests.py REQUESTABLE, and a test compares the two lists, so
// a game added on the server cannot quietly go missing from the lobby.
const LOBBY_GAMES = [
  ['connect4', 'Connect 4'],
  ['reversi', 'Reversi'],
  ['checkers', 'Checkers'],
  ['gomoku', 'Gomoku'],
  ['chessboard', 'Chess'],
  ['go', 'Go'],
  ['hex', 'Hex'],
  ['breakthrough', 'Breakthrough'],
  ['seabattle', 'Sea Battle']
]
const LOBBY_GAME_IDS = LOBBY_GAMES.map(item => item[0])
const LOBBY_TITLES = Object.fromEntries(LOBBY_GAMES)
const lobbyTitle = id => LOBBY_TITLES[id] || id

// A lobby post is a day old at most: the server deletes the rest, and this screen
// never draws anything older even in the moment before that sweep.
const LOBBY_POST_MS = 24 * 3600 * 1000

// "08-04 21:35" - the date and the time on every post, in this computer's own clock.
function lobbyStamp(at) {
  const ms = Number(at || 0) * 1000
  if (!ms) return ''
  const when = new Date(ms)
  const pad = number => String(number).padStart(2, '0')
  return `${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`
}

// Only lines this screen can date, and only ones from the last day.
function freshLobbyLines(lines) {
  const now = Date.now()
  return (Array.isArray(lines) ? lines : []).filter(item =>
    item && Number(item.at || 0) > 0 && now - Number(item.at) * 1000 < LOBBY_POST_MS)
}

// The short "How to play" card for the lobby page, in the same shape as the other
// surfaces' how-to cards: a header button, plain words, one way out.
function LobbyHowTo({ onClose }) {
  const paragraph = { fontSize: 13, color: text.secondary, lineHeight: 1.5 }
  return jsx('div', {
    'data-testid': 'lobby-howto',
    style: {
      position: 'fixed', inset: 0, zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(8,11,16,0.7)', backdropFilter: 'blur(3px)', padding: 16, overflowY: 'auto'
    },
    children: jsxs('div', {
      style: {
        width: 'min(520px, 100%)', maxHeight: '90%', overflow: 'auto', borderRadius: 18,
        border: `1px solid ${stroke}`, background: 'var(--ui-bg-elevated, #141c26)', padding: 20,
        display: 'flex', flexDirection: 'column', gap: 10, boxShadow: '0 18px 50px rgba(0,0,0,0.4)'
      },
      children: [
        jsx('div', { style: { fontSize: 18, fontWeight: 700 }, children: 'How to play' }),
        jsx('div', { style: paragraph, children: 'This is Game Center: board games you can sit down at right now. Under Play, press a game — then pick a level to face the computer, or Choose how to play for the other ways in. You move by clicking the board.' }),
        jsx('div', { style: paragraph, children: 'To play a person: open the lobby and press Find match on the games you want (one, several, or All games) — the lobby pairs you with anyone else who wants one of them right now, and a dialog asks you to join when a match is found. Chat with everyone in #games on the right (set a name first). When a table is ready, press Play here and the match opens on this page.' }),
        jsx('div', { style: paragraph, children: 'Each game decides its own winner — Connect 4 gets four discs in a row, Reversi turns the board over. The screen always says whose turn it is and how the game ended.' }),
        jsxs('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 2 }, children: [
          button('Got it', onClose, { primary: true })
        ] })
      ]
    })
  })
}

function usePetAvatar() {
  const [pet, setPet] = useState('')
  useEffect(() => {
    let active = true
    async function load() {
      try {
        if (typeof host === 'undefined' || !host || typeof host.request !== 'function') return
        const info = await host.request('pet.info', {})
        if (!info || !info.enabled || !info.slug) return
        const thumb = await host.request('pet.thumb', { slug: info.slug, url: '' })
        if (active && thumb && thumb.ok && typeof thumb.dataUri === 'string') setPet(thumb.dataUri)
      } catch { /* A pet is optional. */ }
    }
    load()
    return () => { active = false }
  }, [])
  return pet
}

function Avatar({ name, pet, kind }) {
  const circle = { width: 18, height: 18, borderRadius: '50%', flexShrink: 0 }
  return jsxs('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 3 }, children: [
    pet && kind !== 'bot'
      ? jsx('img', { src: pet, alt: '', style: { ...circle, objectFit: 'cover' } })
      : jsx('span', { style: { ...circle, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: fill, color: text.secondary, fontSize: 10 }, children: String(name || '?')[0].toUpperCase() }),
    kind === 'bot' ? jsx('span', { style: { fontSize: 9, color: text.tertiary }, children: 'BOT' }) : null
  ] })
}

// Find match: chips, one per game the server can seat, plus All games. What is picked
// is what the server is looking for right now - the chips read back the server's own
// answer, so a chip can never claim to be looking for a game the lobby was not told
// about. Nothing is picked by default: pressing Find match yourself turns one on, and
// pressing the last one off (or Stop) turns it off.
function LobbyFindMatch({ looking, post, pending, busyNote }) {
  const mine = LOBBY_GAME_IDS.filter(id => (looking || []).includes(id))
  const all = mine.length === LOBBY_GAME_IDS.length
  const held = say => ({ disabled: Boolean(pending), title: pending ? busyNote : say })
  const chipStyle = on => ({
    fontSize: 11, padding: '3px 8px', borderRadius: 999, cursor: 'pointer',
    border: `1px solid ${on ? accent : stroke}`,
    background: on ? fill : 'transparent', color: text.secondary
  })
  const chip = (id, label, on) => jsx('button', {
    'data-lobby-chip': id,
    'aria-pressed': on ? 'true' : 'false',
    ...held(on ? `Stop looking for ${label}.` : `Look for a game of ${label} right now.`),
    onClick: () => {
      const next = on ? mine.filter(item => item !== id) : mine.concat([id])
      post(`looking:${id}`, '/online/hall/looking',
        next.length ? { games: next } : { on: false })
    },
    style: chipStyle(on),
    children: label
  })
  // "All games" is not one more game in the list: it is the server's own all, so a game
  // added on the server later is looked for too without this screen being changed.
  const allChip = jsx('button', {
    'data-lobby-chip': 'all',
    'aria-pressed': all ? 'true' : 'false',
    ...held(all ? 'Stop looking for a match.' : 'Look for every game the server can seat right now.'),
    onClick: () => post('looking:all', '/online/hall/looking', all ? { on: false } : { all: true }),
    style: chipStyle(all),
    children: 'All games'
  })
  const wanted = all
    ? 'Looking for a game in every game the lobby can seat right now — the first person who wants one of them gets the offer.'
    : mine.length
      ? `Looking for ${mine.map(lobbyTitle).join(', ')} right now — the lobby pairs you with anyone else who wants one of them.`
      : 'Nothing picked yet: press a game to start looking, and the lobby pairs you with anyone else who wants it.'
  return jsxs('div', {
    'data-lobby-find': '1',
    style: { display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${stroke}`, paddingTop: 10 }
  , children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, children: [
      jsx('span', { style: { fontSize: 12, fontWeight: 650 }, children: 'Find match' }),
      mine.length ? jsx('button', {
        'data-lobby-find-stop': '1',
        ...held('Stop looking for a match.'),
        onClick: () => post('looking:stop', '/online/hall/looking', { on: false }),
        style: { fontSize: 11, padding: '2px 8px', borderRadius: 999, border: `1px solid ${stroke}`, background: 'transparent', color: text.tertiary, cursor: 'pointer' },
        children: 'Stop looking'
      }) : null
    ] }),
    jsx('div', { role: 'group', 'aria-label': 'Games to find a match in', style: { display: 'flex', flexWrap: 'wrap', gap: 6 }, children: [
      ...LOBBY_GAMES.map(([id, label]) => chip(id, label, mine.includes(id))),
      allChip
    ] }),
    jsx('div', { style: { fontSize: 11, color: text.tertiary, lineHeight: 1.45 }, children: wanted })
  ] })
}

// A match offer. Find match made it, so neither person sent it: whichever of you
// presses Join sits both down at the same private table. The dialog is the ask; the
// dim line under the roster is the same news kept on the panel.
function LobbyOfferDialog({ card, other, otherName, onJoin, onNotNow, busy, busyNote }) {
  const title = `${otherName} wants to play ${lobbyTitle(card.game)}`
  return jsx('div', {
    'data-lobby-offer': String(card.id),
    role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
    style: {
      position: 'fixed', inset: 0, zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(8,11,16,0.62)', backdropFilter: 'blur(2px)', padding: 16
    },
    children: jsxs('div', {
      style: {
        width: 'min(420px, 100%)', borderRadius: 16, border: `1px solid ${stroke}`,
        background: 'var(--ui-bg-elevated, #141c26)', padding: 18, display: 'flex', flexDirection: 'column', gap: 10,
        boxShadow: '0 18px 50px rgba(0,0,0,0.4)'
      },
      children: [
        jsx('div', { style: { fontSize: 16, fontWeight: 700 }, children: title }),
        jsx('div', { style: { fontSize: 12, color: text.secondary, lineHeight: 1.5 }, children: 'You are both looking for this game. Join and you sit down together at a private table inside Hermes — no code to copy.' }),
        jsxs('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 2 }, children: [
          jsx('button', {
            'data-lobby-offer-notnow': '1',
            disabled: Boolean(busy), title: busy ? busyNote : 'Say not this time.',
            onClick: onNotNow,
            style: { fontSize: 13, padding: '6px 12px', borderRadius: 10, border: `1px solid ${stroke}`, background: 'transparent', color: text.secondary, cursor: 'pointer' },
            children: 'Not now'
          }),
          button('Join', onJoin, { primary: true, disabled: Boolean(busy), title: busy ? busyNote : `Sit down with ${otherName}.` })
        ] })
      ]
    })
  })
}

// ---- The Hall: who is here right now, and the game requests between you -----
// While online play is on, Game Center keeps one lobby socket open (even with the
// dock closed); this screen reads that socket's snapshot from GET /online/hall and
// sends every move through the four /online/hall/* doors. It never shows an
// address, a key or an invite code — only names, the game each person accepts, and
// the requests you have open.
const HALL_POLL_MS = 3000

// post() lets one Hall action through at a time. Every other control on the panel is held
// while that one is out — and says so on hover, rather than looking pressable and being ignored.
const HALL_BUSY_NOTE = 'Another Hall action is still going through. Wait for it, then try again.'

// online is ready to play, away is here but idle, playing is already at a table.
const HALL_STATUS_DOT = { online: '#3ee0c5', away: '#ffb020', playing: 'var(--ui-fill-tertiary, rgba(127,127,127,0.45))' }

function LobbyHall({ ctx, current, view, onPlayHere }) {
  const [snap, setSnap] = useState(null)
  // A read that failed. The last snapshot stays on screen — it is still the best picture
  // there is — but never as if it were live.
  const [stale, setStale] = useState(false)
  // The one control whose POST is in flight; that control, and only it, is locked.
  const [pending, setPending] = useState('')
  const [ack, setAck] = useState('')
  // A seat the server offered that would not open, in the server's own words, and how many
  // times the person has asked for it again.
  const [seatProblem, setSeatProblem] = useState(null)
  const [seatAttempt, setSeatAttempt] = useState(0)
  // Rooms already opened, so a seat the server keeps reporting opens the table once.
  const handled = useRef(new Set())
  const alive = useRef(true)

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  // The Hall snapshot, read every 3 s while this screen is up. The socket is the
  // shelf's; this only paints its latest answer, and clears the poll on unmount. A read
  // that fails is said out loud rather than leaving an old roster looking live.
  useEffect(() => {
    if (!ctx || typeof ctx.rest !== 'function') return undefined
    let timer = null
    const read = async () => {
      try {
        const answer = await ctx.rest('/online/hall')
        if (!alive.current) return
        if (answer && typeof answer === 'object') setSnap(answer)
        setStale(false)
      } catch (error) {
        // Keep the last snapshot; the next tick retries. It is simply not live any more.
        if (alive.current) setStale(true)
      }
    }
    read()
    timer = setInterval(read, HALL_POLL_MS)
    return () => { if (timer) clearInterval(timer) }
  }, [ctx])

  const state = snap ? String(snap.state || '') : 'connecting'
  const you = (snap && snap.you) || {}
  const prefs = (snap && snap.prefs) || { open: false, games: {} }
  const roster = (snap && snap.roster) || []
  const requests = (snap && snap.requests) || []
  const seated = (snap && snap.seated) || null
  // Appearing offline and find match come with "you": they are about this account, not
  // about the row it shows in the list.
  const invisible = Boolean(you.invisible)
  const looking = Array.isArray(you.looking) ? LOBBY_GAME_IDS.filter(id => you.looking.includes(id)) : []

  // A seat the server has made opens the online table here, then hands the room to
  // the page — once. The same room never opens twice on the next poll. A room that
  // will not open is not marked handled: nothing moves the person to a table that
  // never opened, the server's own words are shown, and the same seat can be asked
  // for again.
  useEffect(() => {
    const room = seated && seated.room_id ? String(seated.room_id) : ''
    if (!room || handled.current.has(room)) return
    handled.current.add(room)
    ;(async () => {
      let answer = null
      try { answer = await openOnlineTable(ctx, room, seated.game) } catch (error) { answer = { ok: false } }
      if (!answer || answer.ok === false) {
        handled.current.delete(room)
        if (alive.current) setSeatProblem({ room, text: String((answer && answer.text) || '') || 'That table would not open. Try again.' })
        return
      }
      if (alive.current) setSeatProblem(null)
      if (onPlayHere) onPlayHere({ room_id: room, game: seated.game })
    })()
  }, [seated && seated.room_id, seatAttempt])

  // The retry the refusal offers: the same room, asked for again.
  const retrySeat = () => setSeatAttempt(count => count + 1)

  // One door for every control: it is locked while its own POST is out, and a
  // refusal is shown in the server's own words rather than swallowed.
  const post = async (key, path, body) => {
    if (pending) return { ok: false }
    setPending(key)
    setAck('')
    try {
      const answer = ctx && typeof ctx.rest === 'function'
        ? await ctx.rest(path, { method: 'POST', body })
        : { ok: false, text: 'Game Center cannot be reached.' }
      if (alive.current && answer && answer.ok === false) setAck(String(answer.text || ''))
      return answer || { ok: true }
    } catch (error) {
      if (alive.current) setAck('That did not reach Game Center. Try again.')
      return { ok: false }
    } finally {
      if (alive.current) setPending('')
    }
  }

  const muted = { fontSize: 12, color: text.tertiary }
  // Every control on this panel posts through the one pending slot, so every control wears the
  // same lock and the same reason while anything is out.
  const held = say => ({ disabled: Boolean(pending), title: pending ? HALL_BUSY_NOTE : say })
  const shell = children => jsxs('div', {
    'data-hall': '1', 'data-hall-state': state,
    style: { borderTop: `1px solid ${stroke}`, paddingTop: 10, marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 },
    children: [heading('The Hall'), ...children]
  })
  const note = say => shell([jsx('div', { style: muted, children: say })])

  if (state === 'off') return note('Turn online play on to see who is here.')
  if (state === 'old-server') return note('This lobby server has no Hall yet. Find a match still works.')
  if (state !== 'live') return note(stale ? 'Reconnecting…' : 'Joining the Hall…')

  // The switches, in the order the person meets them: appear offline first (the one
  // control that takes you out of the lobby), then the master "Take game requests", then
  // one switch per game the server can seat. Every one of them is held while any Hall
  // POST is out, like every other control on this panel.
  const toggle = (label, checked, key, body, title, only) => jsxs('label', {
    title: pending ? HALL_BUSY_NOTE : title, 'data-hall-toggle': key,
    ...(only ? { 'data-hall-game': only } : {}),
    style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: text.secondary, cursor: 'pointer' },
    children: [
      jsx('input', { type: 'checkbox', checked: Boolean(checked), disabled: Boolean(pending),
        onChange: event => post(key === 'game' ? `game:${only}` : key, '/online/hall/prefs', body(event.target.checked)) }),
      jsx('span', { children: label })
    ]
  })
  const offered = LOBBY_GAME_IDS.filter(id => prefs.games && prefs.games[id])
  const header = jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 }, children: [
    toggle('Appear offline', invisible, 'invisible', on => ({ invisible: on }),
      'When this is on, nobody sees you in the lobby list and nobody can ask you to a game. Turn it off to be listed again.'),
    jsx('div', { style: muted, children: invisible
      ? 'You are appearing offline: you are not in anyone else\u2019s lobby list, and requests to you are refused.'
      : `You are ${you.name || 'in the lobby'} and everyone else in the lobby can see you.` }),
    toggle('Take game requests', prefs.open, 'open', on => ({ open: on }),
      'When this is on, other players can ask you to a game. Turn it off and new requests stop; your per-game choices are kept.'),
    jsx('div', { style: { fontSize: 11, color: text.tertiary }, children: offered.length
      ? `Taking requests for: ${offered.map(lobbyTitle).join(', ')}.`
      : 'No game is switched on yet, so nobody can ask you for one.' }),
    jsx('div', { role: 'group', 'aria-label': 'Games you take requests for', style: { display: 'flex', flexWrap: 'wrap', gap: 10 }, children:
      LOBBY_GAMES.map(([id, label]) => toggle(label, prefs.games && prefs.games[id], 'game',
        on => ({ games: { [id]: on } }),
        `Accept requests for ${label}. The master switch above still has to be on.`, id))
    })
  ] })

  // A match offer from find match. Which of the two sent it does not matter: the dialog
  // is the same for both, and either side may join.
  const offerCards = requests.filter(req => req && req.state === 'pending' && req.offer)
  const offer = offerCards[0] || null
  const offerOther = offer
    ? (String(offer.from && offer.from.id) === String(you.id) ? (offer.to || {}) : (offer.from || {}))
    : null

  // The roster, you left out. A dot says whether each person can play now, and Ask is
  // offered only to someone online who accepts a game you are also taking.
  const others = roster.filter(row => String(row.id) !== String(you.id))
  const anyMine = LOBBY_GAME_IDS.some(id => prefs.games && prefs.games[id])
  const myAccepted = (prefs.open || anyMine) ? LOBBY_GAME_IDS.filter(id => prefs.games && prefs.games[id]) : LOBBY_GAME_IDS
  const rosterRows = others.length ? others.map(row => {
    const status = String(row.status || '')
    const shared = (Array.isArray(row.games) ? row.games : []).filter(id => myAccepted.includes(id))
    const askGame = shared[0] || ''
    const canAsk = status === 'online' && Boolean(askGame)
    const askKey = `ask:${row.id}`
    return jsxs('div', {
      'data-hall-row': String(row.id),
      style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: text.secondary },
      children: [
        jsx('span', { 'aria-hidden': true, style: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: HALL_STATUS_DOT[status] || text.tertiary } }),
        jsx('span', { style: { flex: 1, minWidth: 0 }, children: row.name }),
        shared.length ? jsx('span', { style: { ...muted, flexShrink: 0 }, children: shared.map(lobbyTitle).join(', ') }) : null,
        jsx('span', { 'data-hall-status': status, style: muted, children: status }),
        canAsk ? button('Ask', () => post(askKey, '/online/hall/request', { to: row.id, game: askGame }),
          held(`Ask ${row.name} to a game of ${lobbyTitle(askGame)}.`)) : null
      ]
    }, String(row.id))
  }) : jsx('div', { style: muted, children: 'Nobody else is here right now.' })

  // The requests between you: the ones to answer, then the ones you are waiting on.
  // A match offer is neither - it has its own dialog and its own line.
  const cardStyle = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, fontSize: 12, color: text.secondary, border: `1px solid ${stroke}`, borderRadius: 10, padding: '8px 10px', background: card }
  const inbound = requests.filter(req => req.state === 'pending' && !req.offer && req.to && String(req.to.id) === String(you.id))
  const outbound = requests.filter(req => req.state === 'pending' && !req.offer && req.from && String(req.from.id) === String(you.id))
  const requestCards = [
    ...inbound.map(req => jsxs('div', { 'data-hall-request': String(req.id), style: cardStyle, children: [
      jsx('span', { style: { flex: 1, minWidth: 120 }, children: `${req.from.name} wants to play ${req.game}` }),
      button('Accept', () => post(`respond:${req.id}`, '/online/hall/respond', { id: req.id, accept: true }),
        { primary: true, ...held(`Accept and sit down with ${req.from.name}.`) }),
      button('Decline', () => post(`respond:${req.id}`, '/online/hall/respond', { id: req.id, accept: false }),
        held('Say no to this request.'))
    ] }, String(req.id))),
    ...outbound.map(req => jsxs('div', { 'data-hall-request': String(req.id), style: cardStyle, children: [
      jsx('span', { style: { flex: 1, minWidth: 120 }, children: `Asked ${req.to.name}… ` }),
      button('Cancel', () => post(`cancel:${req.id}`, '/online/hall/cancel', { id: req.id }),
        held(`Take back your request to ${req.to.name}.`))
    ] }, String(req.id)))
  ]

  return shell([
    header,
    stale ? jsx('div', {
      role: 'status', 'aria-live': 'polite', 'data-hall-reconnecting': '1',
      style: { ...muted, color: text.secondary },
      children: 'Reconnecting… the list below is the last one this computer saw.'
    }) : null,
    jsx(LobbyFindMatch, { looking, post, pending, busyNote: HALL_BUSY_NOTE }),
    offer ? jsxs('div', {
      'data-lobby-offer-line': '1', role: 'status', 'aria-live': 'polite',
      style: { fontSize: 11, color: text.tertiary, lineHeight: 1.45 },
      children: [
        jsx('span', { children: `${offerOther.name || 'Someone'} wants to play ${lobbyTitle(offer.game)} — Join or Not now on the dialog.` }),
        jsx('span', { children: ' (Not sent to the model: Game Center shows this itself.)' })
      ]
    }) : null,
    seatProblem ? jsxs('div', {
      role: 'alert', 'data-hall-seat-problem': '1',
      style: { ...muted, color: text.primary, border: `1px solid ${accent}`, borderRadius: 10, padding: '8px 10px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
      children: [
        jsx('span', { style: { flex: 1, minWidth: 120 }, children: `Your table could not be opened: ${seatProblem.text}` }),
        button('Try again', retrySeat, { title: 'Ask the lobby server to open that same table again.' })
      ]
    }) : null,
    jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 }, children: rosterRows }),
    requestCards.length ? jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 }, children: requestCards }) : null,
    ack ? jsx('div', { role: 'status', 'aria-live': 'polite', style: { ...muted, color: text.secondary }, children: ack }) : null,
    offer ? jsx(LobbyOfferDialog, {
      card: offer, other: offerOther, otherName: String(offerOther.name || 'Someone'),
      busy: Boolean(pending), busyNote: HALL_BUSY_NOTE,
      onJoin: () => post(`offer:${offer.id}`, '/online/hall/respond', { id: offer.id, accept: true }),
      onNotNow: () => post(`offer:${offer.id}`, '/online/hall/respond', { id: offer.id, accept: false })
    }) : null
  ])
}

function LobbyWhoOnline({ view, ctx, current, onPlayHere }) {
  const pet = usePetAvatar()
  const online = onlineView(view)
  const presence = (view.online && view.online.presence) || {}
  const muted = { fontSize: 12, color: text.tertiary }
  if (!online.on || online.offline) {
    const rows = (view.lobby && view.lobby.looking) || []
    return jsxs('div', { children: [
      jsxs('div', { style: { borderTop: `1px solid ${stroke}`, paddingTop: 10 }, children: [
        heading('Seen in the lobby'),
        jsx('div', { style: muted, children: 'This computer and the chats it shares.' }),
        rows.length ? rows.map((row, index) => jsx('div', { style: { fontSize: 12, color: text.secondary }, children: row.name }, index))
          : jsx('div', { style: muted, children: 'Nobody is online yet.' })
      ] }),
      jsx(LobbyHall, { view, ctx, current, onPlayHere })
    ] })
  }
  const group = (label, rows, kind, empty) => jsxs('div', { style: { minWidth: 150 }, children: [
    jsx('div', { style: { fontSize: 12, fontWeight: 650 }, children: label }),
    rows.length ? rows.map((row, index) => jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: text.secondary, marginTop: 4 }, children: [
      jsx(Avatar, { name: row.name, kind, pet: row.name === (view.player && view.player.name) ? pet : '' }),
      jsx('span', { children: row.name }),
      row.game ? jsx('span', { children: row.game }) : null,
      row.rating != null ? jsx('span', { children: `${row.provisional ? '~' : ''}${row.rating}` }) : null
    ] }, row.id || index)) : jsx('div', { style: muted, children: empty })
  ] })
  return jsxs('div', { children: [
    jsxs('div', { style: { borderTop: `1px solid ${stroke}`, paddingTop: 10 }, children: [heading('Seen in the lobby'), jsxs('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 20 }, children: [
      group('People', presence.humans || [], 'human', 'No people right now.'),
      group('Bots', presence.bots || [], 'bot', 'No bots right now.')
    ] })] }),
    jsx(LobbyHall, { view, ctx, current, onPlayHere })
  ] })
}

function LobbyLadder({ view, current }) {
  const pet = usePetAvatar()
  const online = onlineView(view)
  const rows = ((view.online && view.online.ladder_board) || {})[current] || []
  const status = ladderLine(online.ladder)
  const muted = { fontSize: 12, color: text.tertiary }
  let content
  if (!online.on) content = 'Turn on online play to see the ladder.'
  else if (online.offline) content = onlineLine(online)
  else if (!rows.length) content = 'No rated bot games yet.'
  return jsxs('div', { children: [
    heading('Ladder'),
    content ? jsx('div', { style: muted, children: content }) : rows.map((row, index) => jsxs('div', {
      style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: text.secondary, marginTop: 4 },
      children: [
        jsx('span', { children: `#${index + 1}` }),
        jsx(Avatar, { name: row.name, pet: online.bot.id && row.id === online.bot.id ? pet : '', kind: online.bot.id && row.id === online.bot.id ? 'human' : 'bot' }),
        jsx('span', { children: row.name }),
        jsx('span', { children: `${row.provisional ? '~' : ''}${row.rating}` }),
        jsx('span', { children: `${row.wins || 0}/${row.losses || 0}/${row.draws || 0}` })
      ]
    }, row.id || index)),
    status ? jsx('div', { style: { ...muted, marginTop: 6 }, children: status }) : null
  ] })
}

function LobbyChatColumn({ view, ctx, send, chat, setChat, name, setName, current, onPlayHere }) {
  // "Play here": the match the lobby just made, opened on the lobby server and played on this
  // page's own table (OnlineTable draws the server's own picture).
  const [playingHere, setPlayingHere] = useState(false)
  const [playProblem, setPlayProblem] = useState('')
  // What the lobby said about the last name or message. A refusal is shown, never swallowed.
  const [sayProblem, setSayProblem] = useState('')
  const playHere = async match => {
    if (playingHere) return
    setPlayingHere(true)
    setPlayProblem('')
    try {
      const answer = await openOnlineTable(ctx, match && match.room_id, match && match.game)
      if (answer && answer.ok === false) { setPlayProblem(String(answer.text || 'That table would not open.')); return }
      if (onPlayHere) onPlayHere(match)
    } finally {
      setPlayingHere(false)
    }
  }
  const lobby = view.lobby || { lines: [], looking: [] }
  const match = onlineView(view).match
  const looking = lobby.looking || []
  // Posts from the last day only, each with its own date and time beside it.
  const posts = freshLobbyLines(lobby.lines)
  const lookingLine = looking.length
    ? `Looking: ${looking.map(item => (item.address ? `${item.name} (${item.game}) @ ${item.address}` : `${item.name} (${item.game})`)).join(', ')}`
    : 'Nobody is looking yet.'
  // One door for the two drafts. A line the lobby refuses — a taken name, a message it will
  // not take — leaves the words where they are and says why; only a line the lobby has taken
  // clears the box, so nothing typed here is thrown away on a failure.
  const say = async line => {
    if (typeof send !== 'function') return { ok: false, text: 'Game Center cannot be reached.' }
    try { return (await send(line)) || { ok: true } }
    catch (error) { return { ok: false, text: 'That did not reach Game Center. Try again.' } }
  }
  const setPlayerName = async () => {
    const wanted = name.trim()
    if (!wanted) return
    setSayProblem('')
    const answer = await say(`name ${wanted}`)
    if (answer && answer.ok === false) { setSayProblem(String(answer.text || 'That name was not taken. Try again.')); return }
    setName('')
  }
  const sendChat = async () => {
    const said = chat.trim()
    if (!said) return
    setSayProblem('')
    const answer = await say(`chat say ${said}`)
    if (answer && answer.ok === false) { setSayProblem(String(answer.text || 'The lobby did not take that message. Try again.')); return }
    setChat('')
  }
  const muted = { fontSize: 11, color: text.tertiary }
  return jsxs('div', {
    className: 'games-center-lobby',
    // Compact on purpose (owner's ask, 2026-11-11): the column is a side panel, not a page. It is
    // capped at 140 px by the layout grid - half what it was, with the freed width going to one
    // more column of game cards - so everything here is one step smaller and tighter.
    style: { display: 'flex', flexDirection: 'column', gap: 6, padding: 10, borderLeft: `1px solid ${stroke}`, minWidth: 110, fontSize: 12, overflow: 'auto', background: paper },
    children: [
      // Only the lobby here (owner's ask, 2026-11-11): on the Game Center page the person is not at a
      // table, so there is no Game tab. A match the lobby has made shows as one card on top.
      match ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }, children: [
        jsx('div', { style: { fontSize: 11, color: text.secondary }, children: `Your table is ready: ${match.opponent || 'someone'} for ${match.title || match.game || current}.` }),
        // The same server table, whoever started it: Hermes plays it here on the board the
        // server sends. Closing it does not end the match.
        button('Play here', () => playHere(match), {
          primary: true,
          disabled: playingHere || !match.room_id,
          title: 'Plays this match here, on the lobby server, without leaving Hermes.'
        }),
        playProblem ? jsx('div', { role: 'alert', style: { fontSize: 11, border: `1px solid ${accent}`, borderRadius: 8, padding: '6px 10px' }, children: playProblem }) : null
      ] }) : null,
      jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }, children: [
          jsx('div', { style: { fontWeight: 650, fontSize: 12 }, children: '#games' }),
          view.player.named ? null : jsxs('div', { 'data-lobby-say-row': '1', style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }, children: [
            jsx('div', { style: { display: 'flex', alignSelf: 'stretch' }, children: field(name, setName, 'Your name', setPlayerName, { label: 'Your name' }) }), button('Set', setPlayerName, { disabled: !name.trim() })
          ] }),
          jsx('div', { style: muted, children: lookingLine }),
          jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, fontSize: 11 }, children: posts.length
            ? posts.map((item, index) => jsxs('div', { 'data-lobby-post': String(index), children: [
              jsx('span', { style: { fontWeight: 650 }, children: `${item.name}: ` }),
              jsx('span', { style: { color: text.secondary }, children: item.text }),
              jsx('span', { style: { color: text.tertiary, marginLeft: 4, whiteSpace: 'nowrap' }, children: lobbyStamp(item.at) })
            ] }, index)) : jsx('div', { style: { color: text.tertiary }, children: 'No messages yet.' }) }),
          jsxs('div', { 'data-lobby-say-row': '1', style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }, children: [
            jsx('div', { style: { display: 'flex', alignSelf: 'stretch' }, children: field(chat, setChat, view.player.named ? 'Say something' : 'Set a name first', sendChat, { label: 'Say something in the lobby chat' }) }),
            button('Send', sendChat, { disabled: !chat.trim() || !view.player.named })
          ] }),
          sayProblem ? jsx('div', {
            role: 'alert', 'data-lobby-say-note': '1',
            style: { fontSize: 11, color: text.primary, border: `1px solid ${accent}`, borderRadius: 8, padding: '6px 10px' },
            children: sayProblem
          }) : null
        ]
      })
    ]
  })
}
