// ---- 73-online-table.js: the lobby's table, played inside Hermes
//
// CONTRACT C, the dashboard routes this screen speaks:
//   GET  /online/table          -> {"table": null} or {"table": {...}}
//   POST /online/table/open     {room_id}
//   POST /online/table/cmd      {action, args}
//   POST /online/table/chat     {text}          -> {ok, text}
//   POST /online/table/close
// The table payload is {room_id, state, picture, room, side, opponent:{name}, error, finished,
// chat:[{id, player_id, name, role, text, at, bot, staff, removed}]} — the last 50 messages the
// server has for this seat, the same list the website's table chat draws — and chat_error
// {text, sent, at} when the server turned a message down: its own words, and the text it refused
// (the last this seat sent, since a chat frame carries no id to match a refusal against).
//
// "picture" is this seat's own picture — the same schema the game's own table draws (64b-table-stage.js
// picks the renderer both places use), including permissions.can_move, legal, plies, turn and status
// — so this screen draws the very table the local game draws; only where a move is sent changes.
//
// One rule above the rest: this is a table between people on the lobby server. Nothing here may
// send a local game command, and nothing here may claim a Hermes model is thinking. The turn line
// says whose move it is, and nothing else.
//
// The chat panel beside the board follows the same rule as the board: a message appears when the
// table has taken it, never when the finger leaves the key. Sending is one route, and the message
// comes back on the polled feed like anybody else's.
const ONLINE_TABLE_POLL_MS = 400

// "Play here" remembers the room in this window so the full-screen table opens on it. The same
// shape as PAGE_HANDOFF (62-pane-state.js): one module value, set by the press, read by the table.
// The game is remembered with it, so a table opened for one game can never appear over another.
// A table that closes or finishes forgets it again, so the game's own local table comes back.
const ONLINE_ROOM = { roomId: '', gameId: '' }

function rememberOnlineRoom(roomId, gameId) {
  ONLINE_ROOM.roomId = String(roomId == null ? '' : roomId)
  ONLINE_ROOM.gameId = ONLINE_ROOM.roomId ? String(gameId == null ? '' : gameId) : ''
}

// The room the server itself says it is holding for this person (when the view carries it).
function serverOnlineRoom(view) {
  const table = (view && view.online && view.online.table) || null
  return String((table && table.room_id) || '')
}

// The game the server's table is for, when its answer says.
function serverOnlineGame(view) {
  const table = (view && view.online && view.online.table) || null
  if (!table) return ''
  return String(table.game || (table.picture && table.picture.game) || '')
}

// Which room to play at *this* game's table: the server's own answer first, then the one "Play
// here" opened. Never a room for another game — a Connect Four room over Reversi would be a
// different game's board, played under the wrong title.
function onlineRoomFor(view, gameId) {
  const wanted = String(gameId || '')
  const fromServer = serverOnlineRoom(view)
  if (fromServer) {
    const theirs = serverOnlineGame(view)
    return theirs && wanted && theirs !== wanted ? '' : fromServer
  }
  if (!ONLINE_ROOM.roomId) return ''
  return ONLINE_ROOM.gameId && wanted && ONLINE_ROOM.gameId !== wanted ? '' : ONLINE_ROOM.roomId
}

// "Play here": one press opens the room on the lobby server and hands the room to the surface
// that asked, which then paints this table. The person is moved only once the server has taken it.
async function openOnlineTable(ctx, roomId, gameId) {
  const room = String(roomId == null ? '' : roomId).trim()
  if (!room) return { ok: false, text: 'That table has no room to open.' }
  if (!ctx || typeof ctx.rest !== 'function') return { ok: false, text: 'This window cannot reach Game Center.' }
  try {
    const answer = await ctx.rest('/online/table/open', { method: 'POST', body: { room_id: room } })
    if (answer && answer.ok === false) return answer
    rememberOnlineRoom(room, gameId)
    return answer || { ok: true }
  } catch (error) {
    return { ok: false, text: 'That did not reach Game Center. Try again.' }
  }
}

// Who is across the table, in plain words — never a blank name.
function onlineOpponent(table) {
  return String((table && table.opponent && table.opponent.name) || '') || 'your opponent'
}

// May this seat move? The server's per-seat permissions are authoritative; the older
// identity-based reading is the fallback for a picture that carries none.
function onlineCanMove(picture, view) {
  if (!picture || picture.status !== 'active') return false
  if (picture.permissions && typeof picture.permissions.can_move === 'boolean') return picture.permissions.can_move
  return tableAccess(picture, view || {}).can_move
}

function OnlineTable({ game, view, ctx, roomId, height, onBack, onClose }) {
  const [table, setTable] = useState(null)
  const [read, setRead] = useState(false)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [resultShown, setResultShown] = useState(true)
  const alive = useRef(true)
  const inFlight = useRef(false)
  // Leaving is its own door. A move that is still out must not swallow Back.
  const leaving = useRef(false)
  // Which read is the newest. A 400 ms poll can overlap — a slow answer, or this screen
  // reading again when the room changes — and the answers can then arrive out of order.
  // Only the newest read may paint, so a late answer never puts an older board back on screen.
  const readSeq = useRef(0)
  // Whether this person has ever seen the table. One that is gone after being seen is closed for
  // good; one that has never arrived is still being opened, so the room is not forgotten yet.
  const seen = useRef(false)
  // The last board the server sent. A later read that comes back empty keeps a finished
  // one on screen instead of dropping through to the local computer game.
  const held = useRef(null)
  const latest = useRef({ roomId: '' })
  latest.current = { roomId: roomId || '' }

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // The same mount-time guard the local table needed for a straggler setBusy: a command in flight
  // when this screen was replaced must never leave the fresh one locked.
  useEffect(() => { setBusy(false); inFlight.current = false }, [])

  // The table, read every 400 ms while this screen is up. The server owns the state; this only
  // paints its answer, so a move played in the browser shows up here too.
  useEffect(() => {
    const mine = roomId || ''
    let timer = null
    const readTable = async () => {
      if (!ctx || typeof ctx.rest !== 'function') return
      const seq = readSeq.current + 1
      readSeq.current = seq
      try {
        const answer = await ctx.rest('/online/table')
        if (!alive.current || latest.current.roomId !== mine) return
        // A newer read has started while this one was out: its answer is the one that counts.
        if (seq !== readSeq.current) return
        const next = (answer && answer.table) || null
        if (next) {
          seen.current = true
          held.current = next
          setTable(next)
        } else if (seen.current) {
          // A finished game whose read came back empty stays on this screen. Forgetting
          // the room here is what put the local computer board underneath it. `held`
          // marks that this close is ours, so it is not the server saying the room is gone.
          const previous = held.current
          const previousStatus = String((previous && previous.picture && previous.picture.status) || '')
          const finished = ['win', 'draw', 'resigned', 'abandoned', 'done'].includes(previousStatus)
            || Boolean(previous && previous.finished)
          if (finished && previous) {
            const closed = { ...previous, state: 'closed', held: true }
            held.current = closed
            setTable(closed)
          } else {
            rememberOnlineRoom('')
            held.current = null
            setTable(null)
          }
        } else {
          setTable(null)
        }
        setProblem('')
        setRead(true)
      } catch (error) {
        if (!alive.current || latest.current.roomId !== mine) return
        if (seq !== readSeq.current) return
        setRead(true)
        setProblem('The table cannot be reached right now. It keeps trying.')
      }
    }
    readTable()
    timer = setInterval(readTable, ONLINE_TABLE_POLL_MS)
    return () => { if (timer) clearInterval(timer) }
  }, [ctx, roomId])

  // The table's chat: the server's own list, like the board, comes down the same poll — so a
  // message from anybody at this table, including this person's own, appears when the table has it.
  const chatLines = Array.isArray(table && table.chat) ? table.chat : []
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [chatProblem, setChatProblem] = useState('')
  const chatLog = useRef(null)

  // The newest line is the one in view. The element is only there in a real window, so a
  // missing one is simply nothing to scroll.
  useEffect(() => {
    const list = chatLog.current
    if (list && typeof list.scrollHeight === 'number') list.scrollTop = list.scrollHeight
  }, [chatLines.length])

  // A message the table turns down — muted by the host, silenced, or too fast — comes back on the
  // table's own feed, not as an answer to the press. It is shown in the server's words, and the
  // words that were refused go back in the box, so nothing typed here is lost.
  const chatRefusal = (table && table.chat_error) || null
  const seenRefusal = useRef(0)
  useEffect(() => {
    const at = chatRefusal && chatRefusal.at
    if (!at || at === seenRefusal.current) return
    seenRefusal.current = at
    setChatProblem(String(chatRefusal.text || 'The table did not take that message.'))
    setDraft(current => current || String(chatRefusal.sent || ''))
  }, [chatRefusal && chatRefusal.at])

  // One door for a message, the way the board has one door for a move. The line is not drawn
  // here: it is drawn by the next poll, once the table has taken it.
  const sendChat = async () => {
    const text = draft.trim()
    if (!text || sending || !alive.current) return
    if (!ctx || typeof ctx.rest !== 'function') return
    setSending(true)
    setChatProblem('')
    try {
      const answer = await ctx.rest('/online/table/chat', { method: 'POST', body: { text } })
      if (!alive.current) return
      if (answer && answer.ok === false) setChatProblem(String(answer.text || 'The table did not take that message.'))
      else setDraft('')
    } catch (error) {
      if (alive.current) setChatProblem('That did not reach the table. Try again.')
    } finally {
      if (alive.current) setSending(false)
    }
  }

  const picture = (table && table.picture) || null
  const state = String((table && table.state) || '')
  const status = String((picture && picture.status) || '')
  const over = ['win', 'draw', 'resigned', 'abandoned', 'done'].includes(status)
  // A live rematch has status active. A leftover finished flag must not freeze it.
  const done = Boolean(over || (status !== 'active' && table && table.finished && picture))
  const canMove = Boolean(!busy && !confirming && !done && state !== 'reconnecting' && onlineCanMove(picture, view))
  const myTurn = onlineCanMove(picture, view)
  // The chat is open while the table is: the same condition the server's own room uses.
  const atTable = state === 'live'
  const opponent = onlineOpponent(table)
  const mySide = String((table && table.side) || '')
  // What this picture is, so the header and the stage can speak the game's language and not
  // always chess's. A table with no picture yet falls back to the game the surface asked for.
  const stageView = String((picture && (picture.view || picture.game)) || (game && game.id) || '')
  // What is across the table, in this game's own words. Blackjack is not a white-versus-black
  // duel: two people each play their own hand against the same dealer. Slots has no other
  // person's board at all, so there is no side to name.
  const opponentLine = stageView === 'blackjack'
    ? `You and ${opponent} vs the dealer`
    : stageView === 'slots' ? `${opponent} is at this table`
    : `Against ${opponent}${mySide ? ` · you play ${mySide}` : ''}`
  // Go offers Pass as a move; the local table carries it, so this one does too.
  const passOffered = Boolean(picture && (picture.legal || []).includes('pass') && canMove)
  // A session table (blackjack, slots) has no match to resign: the felt is one hand after
  // another, so the only way out is putting the table away.
  const sessionTable = stageView === 'blackjack' || stageView === 'slots'
  const rematchRequests = (picture && picture.rematch && picture.rematch.requested_by) || []
  const viewerId = String((picture && picture.viewer_id) || '')
  const iAsked = rematchRequests.some(id => id === viewerId)
  const opponentAsked = rematchRequests.length > 0 && !iAsked
  const closedNote = String((table && table.closed_text) || '')
  const rematchNote = String((picture && picture.rematch_note) || '') || (state === 'closed' ? closedNote : '')
  const tableClosed = state === 'closed'
  const winner = String((picture && picture.winner) || '')
  const iWon = Boolean(winner && mySide && winner === mySide)
  const resultLine = status === 'draw' ? 'It is a draw.'
    : iWon ? 'You win!'
    : winner ? `${opponent} wins.`
    : 'Game over.'
  const headline = resultHeadline({
    pictured: picture, status, iWon, machineWon: false,
    sideName: winner === 'black' ? 'Black' : 'White'
  })
  // The turn line: your move the moment the server says it is yours;
  // otherwise it waits, by name. A table that is reconnecting says that instead of pretending.
  const reconnecting = state === 'reconnecting'
  const turnKind = reconnecting ? 'reconnecting' : done ? 'over' : myTurn ? 'mine' : 'theirs'
  const caption = reconnecting ? 'Reconnecting…'
    : done ? resultLine
    : myTurn ? 'Your turn'
    : `Waiting for ${opponent}`
  const dotColor = !picture || done ? '#7d8796' : picture.turn === 'black' ? '#20262e' : '#f0d0b0'

  // A new table, or a game that ends, brings the result card back even after it was put away by
  // hand — the same rule the local table uses.
  useEffect(() => { setResultShown(true) }, [table && table.room_id, status, done])
  // A new position leaves no stale question behind: a resign dialog belongs to the position it
  // was opened on. A refusal is deliberately not cleared here — the table's own words stay until
  // the next move, so a refused move can never look like it did nothing.
  useEffect(() => { setConfirming(false) }, [picture && picture.plies, status, state])

  // One door for every command: the board and the resign button both go through it, both are
  // locked while it is out, and the answer's picture is painted at once. No prediction — the
  // person's move appears when the table has taken it, never before.
  const command = async (action, args) => {
    if (inFlight.current || !alive.current) return { ok: false }
    inFlight.current = true
    setBusy(true)
    setFailure('')
    try {
      const answer = await ctx.rest('/online/table/cmd', { method: 'POST', body: { action, args: args || [] } })
      if (!alive.current) return answer || { ok: false }
      if (answer && answer.picture) setTable(current => ({ ...(current || {}), picture: answer.picture }))
      if (answer && answer.ok === false) setFailure(String(answer.text || 'The table refused that move.'))
      else setNotice((answer && answer.text) || '')
      return answer || { ok: true }
    } catch (error) {
      if (alive.current) setFailure('That did not reach the table. Try again.')
      return { ok: false }
    } finally {
      inFlight.current = false
      if (alive.current) setBusy(false)
    }
  }

  // Blackjack deals the next hand on its own, for the same bet. Leave table is how a person gets up.
  const dealtHand = useRef(0)
  useEffect(() => {
    const token = blackjackNextBet(picture)
    if (!token || !canMove) return undefined
    const hand = Number(picture.hands || 0)
    if (dealtHand.current === hand) return undefined
    const timer = setTimeout(() => {
      if (!alive.current || dealtHand.current === hand) return
      dealtHand.current = hand
      command('move', [token])
    }, BLACKJACK_NEXT_HAND_MS)
    return () => clearTimeout(timer)
  }, [picture && picture.phase, picture && picture.hands, picture && picture.next_bet, picture && picture.legal, canMove])

  // Back, Close table, and a room the server has already closed all leave this
  // screen. The request is a courtesy. A refused leave, a dead socket, or no
  // answer at all still forgets the room and returns to the Games page.
  const roomNow = () => String((table && table.room_id) || roomId || '')
  const goGames = () => {
    if (onBack) onBack()
    else if (onClose) onClose()
  }
  const bestEffort = (serverLeave) => {
    if (!ctx || typeof ctx.rest !== 'function') return
    const rest = ctx.rest
    // Leave and close are both optional. Neither one is waited on, so a hung
    // socket cannot keep the screen up.
    if (serverLeave) {
      Promise.resolve(rest('/online/table/cmd', { method: 'POST', body: { action: 'leave', args: [] } })).catch(() => {})
    }
    Promise.resolve(rest('/online/table/close', { method: 'POST' })).catch(() => {})
  }
  const leaveHome = (serverLeave) => {
    if (leaving.current) return
    leaving.current = true
    markHallLeft(roomNow())
    rememberOnlineRoom('')
    bestEffort(serverLeave)
    goGames()
  }
  const stepAway = () => leaveHome(true)
  // Putting the table away here is not resigning. The match stays on the lobby
  // server; this computer just stops pointing at it.
  const putAway = () => leaveHome(false)
  // No asks the server to decline. An old server answers "Unknown action." and
  // the person still leaves, the same way Back does.
  const declineRematch = async () => {
    if (leaving.current) return
    let answer = null
    try {
      if (ctx && typeof ctx.rest === 'function') {
        answer = await ctx.rest('/online/table/cmd', { method: 'POST', body: { action: 'decline', args: [] } })
      }
    } catch (error) {
      answer = null
    }
    if (answer && answer.ok !== false) {
      if (leaving.current) return
      leaving.current = true
      markHallLeft(roomNow())
      rememberOnlineRoom('')
      if (ctx && typeof ctx.rest === 'function') {
        ctx.rest('/online/table/close', { method: 'POST' }).catch(() => {})
      }
      goGames()
      return
    }
    leaveHome(true)
  }
  // A room the server says is gone is not a screen to sit on.
  useEffect(() => {
    if (!table || table.held) return undefined
    if (state !== 'closed' && state !== 'error') return undefined
    leaveHome(true)
    return undefined
  }, [state, table && table.held, table && table.room_id])

  const header = jsxs('div', {
    style: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap', paddingBottom: 10, borderBottom: `1px solid ${stroke}` },
    children: [
      jsxs('div', { style: { display: 'flex', gap: 12, alignItems: 'center', minWidth: 0 }, children: [
        button('Back', stepAway),
        jsxs('div', { style: { minWidth: 0 }, children: [
          jsx('div', { style: { fontSize: 20, fontWeight: 700 }, children: (game && game.title) || (picture && picture.game) || 'Online table' }),
          jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: opponentLine })
        ] })
      ] }),
      jsxs('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }, children: [
        status === 'active' && !done && !sessionTable ? button('Resign', () => setConfirming(true), { disabled: busy }) : null,
        stageView === 'blackjack' ? button('Leave table', stepAway, { title: 'Get up from the table. The screen leaves either way.' }) : null,
        button('Close table', putAway, { title: 'Puts this table away here. The match stays on the lobby server.' })
      ] })
    ]
  })

  const strip = jsxs('div', {
    role: 'status', 'aria-live': 'polite', className: 'games-status',
    style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 14, fontWeight: 650 },
    children: [
      jsx('span', {
        'aria-hidden': true, className: 'games-turn-dot',
        style: { display: 'inline-block', width: 12, height: 12, borderRadius: '50%', background: dotColor, border: dotColor === '#20262e' ? '1px solid #7d8796' : '1px solid #8a704f' }
      }),
      jsx('span', {
        'data-turn-line': turnKind,
        style: myTurn ? { color: accent, fontWeight: 800 } : { color: text.secondary },
        children: caption
      }),
      // Never "Hermes is thinking" here: nobody's model is playing this seat. A command that is
      // out is the table's own round trip, and it says so.
      busy ? jsx('span', { className: 'games-waiting', style: { fontSize: 12, color: text.tertiary, fontWeight: 400 }, children: 'sending…' }) : null,
      notice ? jsx('span', { style: { fontSize: 12, color: text.tertiary, fontWeight: 400 }, children: notice }) : null
    ]
  })

  const resultCard = done && resultShown ? jsx('div', {
    className: 'games-result',
    onClick: () => setResultShown(false),
    style: {
      position: 'absolute', inset: 0, zIndex: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 12, background: 'rgba(8, 12, 18, .58)', borderRadius: 12, cursor: 'pointer'
    },
    children: jsxs('section', {
      role: 'alert', 'aria-label': 'Game over', 'aria-live': 'assertive',
      onClick: event => event.stopPropagation(),
      style: { display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', textAlign: 'center', maxWidth: 470, padding: '18px 20px', borderRadius: 16, border: `2px solid ${iWon ? accent : stroke}`, background: card, boxShadow: '0 20px 44px rgba(0, 0, 0, .55)' },
      children: [
        jsx('div', { className: 'games-result-title', style: { fontSize: 30, fontWeight: 800, lineHeight: 1.1 }, children: headline }),
        jsx('div', { className: 'games-result-why', style: { fontSize: 13, color: text.secondary }, children: `You vs ${opponent}, on the lobby server` }),
        jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 2 }, children: [
          // Blackjack deals the next hand itself. Every other online game asks both people.
          // A closed room has nothing left to accept.
          stageView === 'blackjack' || tableClosed ? null : jsx('div', {
            'data-rematch': '1', style: { width: '100%', fontSize: 16, fontWeight: 750 },
            children: opponentAsked ? `${opponent} wants a rematch.` : 'Rematch?'
          }),
          stageView === 'blackjack' || tableClosed ? null : button(
            iAsked ? 'Rematch requested' : 'Yes',
            () => command('rematch'),
            { primary: true, disabled: busy || iAsked, title: 'Ask for another game with the same seats. It starts when you have both said yes.' }
          ),
          stageView === 'blackjack' || tableClosed ? null : button('No', declineRematch, {
            disabled: busy, title: 'Decline the rematch. The other person is told, and the table closes.'
          }),
          button('Back to games', stepAway, { primary: stageView === 'blackjack' })
        ] }),
        rematchNote ? jsx('div', {
          'data-rematch-note': '1', style: { fontSize: 13, color: text.secondary }, children: rematchNote
        }) : null,
        textLink('Look at the board', () => setResultShown(false))
      ]
    })
  }) : null

  const board = jsxs('div', {
    className: 'games-board-hero',
    style: { display: 'flex', flex: '0 0 auto', alignItems: 'center', justifyContent: 'center', padding: 4, position: 'relative' },
    children: [
      // One switch, shared with the local pane (64b-table-stage.js): an online game draws the
      // same table the game draws at home. A view with no renderer says so in words rather than
      // drawing an empty grid, and slots opens the person's own machine until the shared floor
      // is built.
      picture ? tableStage({
        picture,
        ctx,
        height: height || PLAY_HEIGHT,
        flat: true,
        interactive: canMove,
        busy,
        onMove: token => { if (canMove) command('move', [token]) },
        against: stageView === 'blackjack'
          ? { who: `You and ${opponent} vs the dealer`, kind: 'human', why: `${opponent} plays their own hand against the same dealer.` }
          : null,
        slotsNote: 'Side-by-side Slots online is coming; this is your own machine.',
        unknownText: "This game can't be drawn online yet"
      }) : jsx('div', {
        role: 'status', 'aria-live': 'polite',
        style: { fontSize: 13, color: text.secondary, border: `1px solid ${stroke}`, borderRadius: 12, padding: 14, background: card },
        children: 'Waiting for the table\'s board…'
      }),
      resultCard
    ]
  })

  // The panel itself is drawn by 74-online-chat.js, which owns how it looks; this screen owns the
  // state: what is typed, whether a message is out, and the table's own refusal.
  const chatPanel = onlineChatPanel({
    lines: chatLines, draft, problem: chatProblem, canType: atTable, sending,
    log: chatLog, onDraft: setDraft, onSend: sendChat
  })

  const body = !table
    ? jsx('div', {
        role: 'status', 'aria-live': 'polite',
        style: { fontSize: 13, color: text.secondary, border: `1px solid ${stroke}`, borderRadius: 12, padding: 14, background: card },
        children: read
          ? 'No table is open here. A match the lobby hands you opens with Play here.'
          : 'Looking for your table…'
      })
    : jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }, children: [
        jsxs('div', {
          className: 'games-online-table-row',
          style: { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start', minWidth: 0 },
          children: [board, chatPanel]
        }),
        // Go's Pass, in the same words as the local table and out the same command route.
        passOffered ? jsxs('div', {
          className: 'games-online-pass',
          style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
          children: [
            button('Pass', () => command('move', ['pass']), { disabled: !canMove }),
            jsx('span', { style: { fontSize: 12, color: text.tertiary }, children: 'Nothing useful to place? Pass and let your opponent move.' })
          ]
        }) : null,
        state === 'error' && table.error
          ? jsx('div', { role: 'alert', style: { fontSize: 13, border: '1px solid #d76b65', borderRadius: 8, padding: '8px 10px' }, children: String(table.error || 'The table stopped.') })
          : null,
        state === 'closed' ? jsx('div', { role: 'status', style: { fontSize: 13, color: text.secondary }, children: closedNote || 'This table is closed. The lobby is where a new one is found.' }) : null
      ] })

  return jsxs('div', {
    className: 'games-online-table',
    style: { display: 'flex', flexDirection: 'column', gap: 10, padding: 14, paddingBottom: 96, minWidth: 0, minHeight: 0, overflow: 'auto', background: paper, height: '100%' },
    children: [
      header,
      strip,
      body,
      problem ? jsx('div', { role: 'status', 'aria-live': 'polite', style: { fontSize: 12, color: text.secondary }, children: problem }) : null,
      failure ? jsx('div', { role: 'alert', style: { padding: 12, border: '1px solid #d76b65', borderRadius: 8, fontSize: 13 }, children: failure }) : null,
      // Resigning hands the game to the other person, so it is asked for once, in those words.
      confirming ? jsxs('section', {
        role: 'alertdialog', 'aria-label': 'Confirm resign', 'aria-describedby': 'games-online-resign',
        onKeyDown: event => { if (event.key === 'Escape') setConfirming(false) },
        style: { padding: 16, border: `1px solid ${accent}`, borderRadius: 12, background: card },
        children: [
          jsx('p', { id: 'games-online-resign', style: { margin: '0 0 12px', fontSize: 13 }, children: `Resigning ends this match and awards the win to ${opponent}.` }),
          jsxs('div', { style: { display: 'flex', gap: 8 }, children: [
            button('Cancel', () => setConfirming(false), { autoFocus: true }),
            button('Confirm resign', () => { setConfirming(false); command('resign', []) }, { primary: true, disabled: busy })
          ] })
        ]
      }) : null,
      jsx('div', { style: { fontSize: 11, color: text.tertiary, lineHeight: 1.45 }, children: 'This table is a match on the lobby server. Closing it here puts the table away; it does not resign the game.' })
    ]
  })
}
