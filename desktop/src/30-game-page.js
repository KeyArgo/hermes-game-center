// ---- 30-game-page.js: the table itself, and the launch cards for other people's games
// Permissions from the gateway are authoritative. Identity fallback is for older gateways.
function tableAccess(picture, view) {
  const p = picture || {}
  const seats = p.seats || []
  const id = view.viewer_id || p.viewer_id || (view.player && view.player.id)
  const own = seats.filter(seat => id && seat.kind === 'human' && seat.id === id)
  const legacy = !p.schema_version && !p.seats
  const active = p.status === 'active'
  const idle = !p.status || p.preview || p.status === 'idle' || p.status === 'abandoned'
  const manage = legacy || Boolean(id && (p.owner_id === id || (idle && !p.owner_id)))
  const defaults = {
    can_move: active && (legacy || own.some(seat => seat.side === p.turn)),
    can_join: idle || (active && seats.some(seat => seat.open) && !own.length),
    can_manage: manage,
    can_resign: active && (legacy || own.length > 0),
    can_draw: active && (legacy || own.length > 0) && p.draws !== false && p.draws_allowed !== false,
    can_rematch: !active && !idle && (legacy || own.length > 0 || manage),
    can_step: active && manage && seats.length === 2 && seats.every(seat => seat.kind === 'local' || seat.kind === 'agent'),
    // Review My Game: only after a finished game with one person at the table,
    // and only that person. A game against the computer or your own agent
    // counts; two people at one keyboard does not.
    can_review: (p.status === 'win' || p.status === 'draw')
      && seats.filter(seat => seat.kind === 'human').length === 1
      && own.length > 0
  }
  if (p.permissions) {
    Object.keys(defaults).forEach(key => { defaults[key] = p.permissions[key] === true })
  }
  return defaults
}

// One cancellable timer, and never another step until the last request settles.
function startTableWatch(step, canContinue, onError) {
  let cancelled = false
  let timer
  const queue = () => {
    if (!cancelled && canContinue()) timer = setTimeout(tick, WATCH_MS)
  }
  const tick = async () => {
    if (cancelled || !canContinue()) return
    try {
      const ok = await step()
      if (ok !== false) queue()
    } catch (error) {
      if (!cancelled) onError(error)
    }
  }
  queue()
  return () => { cancelled = true; clearTimeout(timer) }
}

// The opponent chooser at the table. The backend lists it (dashboard/plugin_api.py) so the model
// named here is the model that will really play; the fallback keeps an older backend usable.
// The old three spellings map onto the new four so an older backend's ids still read right.
const LEVEL_NAMES = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced', expert: 'Expert', easy: 'Beginner', normal: 'Intermediate', hard: 'Advanced' }
const LEVEL_FALLBACK = ['beginner', 'intermediate', 'advanced', 'expert']

function levelLabel(said, guided) {
  // The guided game is the app's Beginner game: the built-in player plays its
  // Easy level, but everywhere else the app calls that opponent the Beginner.
  const word = String(said || '').toLowerCase()
  if (guided && word === 'easy') return 'Beginner'
  return LEVEL_NAMES[word] || ''
}

// Not every table plays White against Black. Connect Four drops red discs against
// yellow ones, and Kalah counts seeds in a bottom half and a top half — so the game
// says what its sides are called (kit.py side_words / seat_words) and every place a
// side is named uses those plain words instead of chess's.
function sideWordsOf(pictured) {
  const given = (pictured && pictured.side_words) || {}
  return {
    white: String(given.white || 'White'),
    black: String(given.black || 'Black')
  }
}

function seatWordsOf(pictured) {
  const sides = sideWordsOf(pictured)
  const given = (pictured && pictured.seat_words) || {}
  return {
    white: String(given.white || `${sides.white} pieces`),
    black: String(given.black || `${sides.black} pieces`)
  }
}

function opponentChoices(view) {
  const listed = view && Array.isArray(view.opponents)
    ? view.opponents.filter(item => item && item.id)
    : []
  if (listed.length) return listed
  const reaches = (view && view.opponent) || {}
  return [
    {
      id: 'computer', label: 'The computer', kind: 'local',
      note: 'The built-in player. No model needed, and it moves at once.',
      line: 'allow-ai {game} black=local', levels: []
    },
    {
      id: 'agent', label: 'Your agent', kind: 'agent',
      note: 'Your own Hermes model plays one move at a time. Change it in Settings → Models → "Game Shelf opponent".',
      line: 'allow-ai {game} black=agent', levels: [],
      model: reaches.model || '', where: reaches.where || '',
      settings: 'Hermes Settings → Models → "Game Shelf opponent"'
    }
  ]
}

// The words on the wait line: one wording, the same two names the rest of the shell uses, and the
// words the person reads while the other side works. The model itself is named on the "You vs …" chip
// above the board, and on the wait line's
// own hover, where there is room for "Your Hermes model (deepseek-v4-flash)" — never on the line
// itself, which is read at a glance.
function trafficName(seat) {
  const kind = seat && seat.kind
  if (kind === 'agent') return 'Hermes'
  if (kind === 'local') return 'Computer'
  return 'the other player'
}

// What the table says while it waits for an answer. A model takes its time, so the wait is
// always named: who is playing, and what they were asked to do.
function waitingLine(asking, seat) {
  if (!asking) return ''
  const who = trafficName(seat)
  if (asking.kind === 'hint') return `${who} is thinking about a hint…`
  if (asking.kind === 'improve') return `${who} is writing a new card…`
  const played = asking.token ? `You played ${asking.token}. ` : ''
  // Two people on one screen: no bot is thinking, so say who we are waiting for.
  if (!seat || (seat.kind !== 'agent' && seat.kind !== 'local')) return `${played}Waiting for the other player…`
  return `${played}${who} is thinking…`
}

// The short line under the board. "Played c3-b4" and other raw table output belong under
// More options; only a hint or a heads-up about a stand-in move is worth a plain sentence here.
function noteLine(text) {
  const said = String(text || '')
  if (/^Hint:/i.test(said)) return said
  if (/built-in player chose/i.test(said)) return 'The built-in player covered for your bot.'
  return ''
}

function pieceWord(letter) {
  return { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[String(letter || '').toLowerCase()] || ''
}

// Who is across the table, said in one line, from the seats the table already has.
//
// A table must always say who you are playing - "vs Computer (Beginner)" or "vs Hermes
// model: <name>" - because a board that names nobody leaves a person unable to tell
// whether their own model is spending tokens on the game.
// One seat answers it: seat.kind "local" is the built-in player, "agent" is the
// person's own Hermes model, and a house table (Blackjack) names the seat's role
// (the dealer) instead of a strength it does not have.
function opponentSeatOf(pictured) {
  const seats = (pictured && pictured.seats) || []
  return seats.find(seat => seat.kind === 'agent') || seats.find(seat => seat.kind === 'local') || null
}

// The strength the built-in player is at, named as kit.py names it.
function seatLevelOf(pictured) {
  const said = String((pictured && pictured.level) || '').toLowerCase()
  if (!said) return ''
  const listed = (pictured && Array.isArray(pictured.levels) ? pictured.levels : [])
    .find(item => String(item.id) === said)
  return String((listed && listed.label) || LEVEL_NAMES[said] || said)
}

function opponentWords(pictured, view, solo, opts) {
  const seat = opponentSeatOf(pictured)
  const sides = sideWordsOf(pictured)
  const model = String((view && view.opponent && view.opponent.model) || '')
  const me = String((view && (view.viewer_id || (view.player && view.player.id))) || '')
  const shared = Boolean(opts && opts.shared)
  const tableSeats = (pictured && pictured.seats) || []
  // Two Hermes seats at one table: the opponent is the pair, named "Two models" the way the
  // chooser names that shape ("Watch two Hermes models play each other").
  if (tableSeats.length === 2 && tableSeats.every(item => item && item.kind === 'agent' && !item.open)) {
    return { who: 'You vs Two models', kind: 'agent', why: 'Two Hermes models play each other here; you watch and the moves are logged.' }
  }
  if (!seat) {
    const other = ((pictured && pictured.seats) || []).find(item =>
      item.kind === 'human' && !item.open && String(item.id || '') !== me)
    if (other) return { who: `You vs ${other.name || 'Person here'}`, kind: 'human', why: `${other.name || 'Another person'} is across the table.` }
    // Two people on one keyboard: named the same way everywhere, "Person here".
    return shared ? { who: 'You vs Person here', kind: 'human', why: 'Two people at one keyboard, taking turns.' } : null
  }
  // A table with no strength to name says what the seat is: Blackjack's dealer plays the
  // house rules, so "Computer (the dealer)" is the honest line, not a skill level.
  const role = solo && sides.black ? ` (the ${String(sides.black).toLowerCase()})` : ''
  if (seat.kind === 'agent') {
    return {
      who: `You vs Your Hermes model${model ? ` (${model})` : ''}${role}`,
      kind: 'agent',
      why: `A Hermes model plays ${String(sides.black).toLowerCase()}${model ? ` (${model})` : ''}, one call per move — it thinks before it fires.`
        + (model ? '' : ' Pick the model in Hermes Settings → Models → "Game Shelf opponent".')
    }
  }
  const level = solo ? '' : seatLevelOf(pictured)
  return {
    who: `You vs Computer${level ? ` (${level})` : ''}${role}`,
    kind: 'local',
    why: solo
      ? `The built-in player is the house: ${String(sides.black).toLowerCase()} plays the table's own rules and never uses your chat model.`
      : `The built-in computer plays ${String(sides.black).toLowerCase()}${level ? ` at ${level}` : ''}`
        + `${pictured && pictured.level_note ? ` · ${pictured.level_note}` : ''}; it answers at once and never uses your chat model.`
  }
}

// The label itself: one chip, with the whole story behind it on hover.
function OpponentLine({ pictured, view, solo, shared, style }) {
  const said = opponentWords(pictured, view, solo, { shared })
  if (!said) return null
  const agent = said.kind === 'agent'
  return jsx('span', {
    'data-gm-vs': said.kind,
    // The one who-line keeps the seat-kind hook the page has always carried, so a
    // single "You vs <opponent>" line names the opponent for tests and for a reader.
    'data-gm-opponent': said.kind,
    title: said.why,
    'aria-label': `${said.who}. ${said.why}`,
    style: {
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px',
      borderRadius: 999, border: `1px solid ${stroke}`, background: card,
      fontSize: 12, fontWeight: 650, color: text.secondary, ...(style || {})
    },
    children: [
      jsx('span', {
        'aria-hidden': true,
        style: { color: agent ? accent : text.tertiary },
        children: agent ? '◆' : '▣'
      }, 'mark'),
      jsx('span', { children: said.who }, 'who')
    ]
  })
}

// How a finished game ended, in the game's own words and then in plain English. The
// result card on the board says one of these, so a checkmate is never mistaken for a
// table that has frozen.
const RESULT_WORDS = {
  checkmate: 'Checkmate!',
  stalemate: 'Draw by stalemate.',
  repetition: 'Draw by repetition.',
  fifty_moves: 'Draw by the fifty-move rule.',
  material: 'Draw: not enough pieces left to mate.',
  four: 'Four in a row!',
  five: 'Five in a row!',
  board_full: 'Draw: the board is full.',
  quiet: 'Draw: too many quiet moves.',
  connected: 'Connected!',
  far_rank: 'A pawn reached the far rank!',
  no_pieces: 'No pawns left.',
  score: 'Counted up.',
  move_limit: 'Draw: the move limit was reached.',
  agreement: 'Draw by agreement.',
  resignation: 'Resignation.',
  // Deliberately blank: these end a game without a word of their own ("final score",
  // "the other side had no move"), so the headline falls back to plain words.
  no_moves: '',
  final: ''
}

function resultWords(pictured) {
  const detail = String((pictured && pictured.result_detail) || '')
  const reason = String((pictured && pictured.result_reason) || '')
  return RESULT_WORDS[detail] || RESULT_WORDS[reason] || ''
}

// One line for the result card: what decided the game, then who won, in the words that
// fit this table ("You win!", "Computer wins", "Black wins" at a shared keyboard).
function resultHeadline(said) {
  const words = resultWords(said.pictured)
  if (said.status === 'draw') return words || 'Draw.'
  const who = said.iWon ? 'You win!'
    : said.machineWon ? `${said.machineName || 'The computer'} wins`
    : `${said.sideName || 'White'} wins`
  return words ? `${words} ${who}` : who
}

// A counted game (Go) has to say the count. "Counted up. Computer wins" on its own
// left people opening More options just to find out how they lost, so the card says the
// two totals the game already worked out (go/game.py score_now) in the same words the
// text board uses, komi and all.
function resultCountLine(pictured) {
  const now = pictured && pictured.score_now
  if (!now || typeof now.white !== 'number' || typeof now.black !== 'number') return ''
  const sides = sideWordsOf(pictured)
  const komi = Number(pictured.komi)
  const komiNote = Number.isFinite(komi) && komi ? ` (${sides.black.toLowerCase()} includes ${komi} komi)` : ''
  return `Final count: ${sides.white.toLowerCase()} ${now.white}, ${sides.black.toLowerCase()} ${now.black}${komiNote}.`
}

// Online play is the in-Hermes lobby now: a table opened there is drawn by
// OnlineTable (73-online-table.js), and this screen keeps no browser door, no
// lobby address and no copy-the-link invite. Nothing here opens the person's web
// browser for a game.

// How long the other seat has been on move. A still caption reads as a frozen screen after a few
// seconds, with no way to tell whose turn it is; a counter reads as work happening.
function useWaitSeconds(active) {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (!active) { setSeconds(0); return undefined }
    const started = Date.now()
    setSeconds(0)
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [active])
  return seconds
}

function PlayTable({ game, view, board, playMove, send, onBack, ctx }) {
  const [watching, setWatching] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  const [confirmation, setConfirmation] = useState(null)
  const [legalMove, setLegalMove] = useState('')
  const [localSetup, setLocalSetup] = useState('')
  const [modelMenu, setModelMenu] = useState(false)
  const [preview, setPreview] = useState(null)
  const [asking, setAsking] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [resultHidden, setResultHidden] = useState(false)
  // Backgammon's dice have a state of their own (waiting behind Roll, tumbling, spent), which
  // the picture cannot carry: the board reports it and the one status line above says it.
  const [bgPhase, setBgPhase] = useState('move')
  // After leaving a seat with people at the table, the game is over but the table
  // still exists: this puts the game's own start screen back in front of the person.
  const [leftSeat, setLeftSeat] = useState(false)
  // Points, on the table itself. Every win outside blackjack is worth 100, and the number should
  // move in front of the person who earned it rather than live only in the slots panel. Reading it
  // is decoration: any failure leaves the table exactly as it was.
  const [points, setPoints] = useState(null)
  const readPoints = () => {
    try {
      if (!ctx || typeof ctx.rest !== 'function') return
      Promise.resolve(ctx.rest('/jackpot')).then(body => {
        const value = body && (body.bonus !== undefined ? body.bonus : body.points)
        if (typeof value === 'number') setPoints(value)
      }).catch(() => {})
    } catch (error) { /* the badge simply does not appear */ }
  }
  const pending = useRef(false)
  const alive = useRef(true)
  const watchStop = useRef(() => {})
  const latest = useRef(null)
  const stopWatching = () => { watchStop.current(); setWatching(false) }
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; watchStop.current() }
  }, [])
  // A setBusy(true) scheduled just before this instance mounted lands as a stale
  // update on the fresh mount, and the instance that made it will not clear it
  // (its alive guard is false) — the table then reads "thinking" forever while
  // the server says it is your turn. A mount-time reset catches that straggler.
  useEffect(() => { setBusy(false); pending.current = false }, [])
  const run = async action => {
    if (pending.current || !alive.current) return false
    pending.current = true
    setBusy(true)
    setFailure('')
    try {
      const answer = await action()
      if (answer && answer.ok === false) throw new Error(answer.text || 'The table refused that action.')
      if (alive.current) setNotice(answer && answer.text || 'Table updated.')
      return true
    } catch (error) {
      if (alive.current) { setFailure(error.message || 'That did not reach the table. Try again.'); setWatching(false) }
      return false
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }
  const command = line => run(() => send(line))
  // A move, a hint or "Improve my bot" can wait on a model. Ask with the words for why, so
  // the person always sees what is happening and whose turn it is.
  const submit = async (askingWhat, action) => {
    if (alive.current) setAsking(askingWhat || null)
    try {
      return await run(action)
    } finally {
      if (alive.current) { setAsking(null); setPreview(null) }
    }
  }
  const ask = (label, message, line, after, confirmLabel, cancelLabel) => {
    if (pending.current) return
    setWatching(false)
    setConfirmation({ label, message, line, after, confirmLabel, cancelLabel })
  }
  // A game with no drawn starting position (Blackjack, Jackpot) still gets a blank idle
  // picture, so nothing here reads a field off null before the first board arrives.
  const pictured = (board && board.picture) || startingPicture(game.id) ||
    { view: game.id, game: game.id, preview: true, status: 'idle', winner: '', legal: [] }
  const sideWords = sideWordsOf(pictured)
  const seatWords = seatWordsOf(pictured)
  const botOff = !view.allow_ai || game.bots === false
  // A solo game (Slots, Blackjack against the house) has no opponent to pick, no model
  // seat and no bots to watch: just sit down and play until you leave.
  const solo = Boolean(game.solo)
  // Slots has no skill in it: every spin has the same published odds, so the skill controls
  // are greyed out rather than hidden - the person can see they exist and why they are off.
  const skillless = Boolean(pictured && String(pictured.view || game.id) === 'slots')
  const SKILL_WHY = 'Slots has no skill levels: every spin has the same published odds.'
  const greyed = (child, why) => skillless
    ? jsx('div', {
      'data-skill-greyed': '1',
      title: why || SKILL_WHY,
      'aria-disabled': 'true',
      style: { opacity: 0.4, display: 'inline-flex', gap: 8, flexWrap: 'wrap' },
      children: child
    })
    : child
  const status = pictured && pictured.status
  const access = tableAccess(pictured, view)
  // The guided-game guide reads the game's own learn.json; nothing is fetched
  // until a learn table is actually on the board.
  const learnBook = useLearnData(ctx, game.id, Boolean(pictured && pictured.learn))
  const [guideStep, setGuideStep] = useState(0)
  const legacy = pictured && !pictured.schema_version && !pictured.seats
  const seats = (pictured && pictured.seats) || ['white', 'black'].map(side => ({
    side, kind: localSetup === 'bots' || (localSetup === 'human-bot' && side === 'black') ? 'local' : 'human', name: pictured && pictured[side], open: !(pictured && pictured[side])
  }))
  if (legacy && !pictured.permissions && localSetup === 'bots') access.can_step = status === 'active' && !botOff
  const playerId = view.viewer_id || (pictured && pictured.viewer_id) || (view.player && view.player.id)
  const ownSeats = seats.filter(seat => playerId && seat.id === playerId && seat.kind === 'human')
  const shared = ownSeats.length === 2
  const spectating = status === 'active' && !ownSeats.length && Boolean(pictured.schema_version || pictured.seats)
  // Which model is at the table: the opponent seat that is a machine, and the model name the
  // backend resolved for it (dashboard/plugin_api.py).
  const modelName = (view && view.opponent && view.opponent.model) || ''
  const aiSeat = seats.find(seat => seat.kind === 'agent') || seats.find(seat => seat.kind === 'local') || null
  const score = (pictured && pictured.score) || { white: 0, black: 0, draws: 0 }
  const moves = (pictured && pictured.moves) || []
  const over = Boolean(status && status !== 'active' && status !== 'idle' && status !== 'lesson_done')
  // The result card steps aside after 3 seconds so it never sits over the board.
  useEffect(() => {
    if (!over || resultHidden) return
    const timer = setTimeout(() => setResultHidden(true), 3000)
    return () => clearTimeout(timer)
  }, [over, resultHidden])
  const lesson = pictured && pictured.lesson
  // A review is a one-step look at a finished game, not one of the game's own
  // scripted lessons, so it gets its own words and its own ending.
  const reviewLesson = Boolean(lesson && (pictured.review === true || (lesson.custom && Number(lesson.of) === 1)))
  const lock = options => ({ ...options, disabled: busy || Boolean(options && options.disabled) })
  const drawOffer = pictured && pictured.draw_offer
  const offeredByMe = ownSeats.some(seat => seat.side === drawOffer || seat.id === drawOffer)
  const rematchRequests = pictured && pictured.rematch && pictured.rematch.requested_by || []
  const requestedByMe = rematchRequests.some(id => id === playerId || ownSeats.some(seat => seat.side === id))
  const newMatch = (line, after) => {
    if (status === 'active') ask('replace match', 'This ends the current match and replaces the board. The new setup uses your explicit seat choice.', line, after)
    else command(line).then(ok => { if (ok && alive.current && after) after() })
  }
  // Leaving the table. With no game in progress it is one press (Close table): the shelf
  // comes back and nothing is thrown away. While a game IS active the row's "Leave table"
  // asks once and says that leaving forfeits the game — a resignation
  // against another person, and a thrown-away board against the computer or a shared keyboard.
  const leaveTable = async () => {
    if (status !== 'active' || !ownSeats.length) {
      alive.current = false
      stopWatching()
      onBack()
      return
    }
    if (againstPeople) {
      ask('leave table', 'Leave this game? It counts as a resignation, so it forfeits the match.', `${game.id} leave`, () => setLeftSeat(true), 'Leave', 'Keep playing')
      return
    }
    ask('leave table', 'Leave this table? The game ends here — leaving forfeits it.', `${game.id} abandon`, () => setLeftSeat(true), 'Leave', 'Keep playing')
  }

  useEffect(() => { setConfirmation(null) }, [game.id, pictured && pictured.table_id, status, JSON.stringify(seats)])
  useEffect(() => { setLegalMove('') }, [game.id, pictured && pictured.table_id, pictured && pictured.last, pictured && pictured.turn, status])
  // A new game puts the board's result card away; leaving a seat is remembered only
  // while the person stays on the same table.
  useEffect(() => { setResultHidden(false) }, [game.id, pictured && pictured.table_id, status])
  useEffect(() => { readPoints() }, [pictured && pictured.table_id, status])
  useEffect(() => { setLeftSeat(false) }, [game.id, pictured && pictured.table_id])

  const bothLocal = seats.length === 2 && seats.every(seat => seat.kind === 'local' || seat.kind === 'agent')
  latest.current = { send, run, ready: !botOff && access.can_step && bothLocal && status === 'active' }
  useEffect(() => {
    if (!watching || !latest.current.ready) return
    const gameId = game.id
    watchStop.current = startTableWatch(
      () => latest.current.run(async () => {
        const answer = await latest.current.send(`${gameId} step`)
        if (answer && answer.picture && answer.picture.status !== 'active') latest.current.ready = false
        return answer
      }),
      () => alive.current && latest.current.ready,
      error => { if (alive.current) { setFailure(error.message || 'Bot playback stopped.'); stopWatching() } }
    )
    return () => watchStop.current()
  }, [watching, game.id])

  useEffect(() => {
    if (over || botOff || !access.can_step || !bothLocal) stopWatching()
  }, [watching, over, botOff, access.can_step, bothLocal])

  const machineSeat = seats.find(seat => seat.kind === 'local') || seats.find(seat => seat.kind === 'agent') || null
  const guidedBeginner = Boolean(pictured && pictured.learn) && String(pictured.level || '').toLowerCase() === 'easy'
  const levelWord = guidedBeginner
    ? 'Beginner'
    : (pictured && Array.isArray(pictured.levels)
      ? (pictured.levels.find(item => String(item.id) === String(pictured.level)) || {}).label
      : '') || levelLabel(pictured && pictured.level, pictured && pictured.learn) || (machineSeat ? 'Intermediate' : '')
  // Which engine really played, when the game knows (chess says Stockfish or built-in).
  // Shown next to the level so the label is honest about what beat you.
  const engineNote = (pictured && pictured.level_note) ? ` · ${pictured.level_note}` : ''
  const drawnView = (pictured && pictured.view) || ''
  const word = token => {
    const said = String(token == null ? '' : token)
    if (drawnView === 'connect4') return `column ${said}`
    if (drawnView === 'kalah') return `pit ${said}`
    if (drawnView === 'chess') {
      if (/^[a-h][1-8][a-h][1-8][qrbn]$/i.test(said)) return `${said.slice(0, 2)} → ${said.slice(2, 4)} (${pieceWord(said.slice(4))})`
      if (said.length === 4) return `${said.slice(0, 2)} → ${said.slice(2, 4)}`
      return said
    }
    if (/^[a-h][1-8][-]?[a-h][1-8]$/i.test(said)) {
      return `${said.slice(0, 2)} → ${said.slice(-2)}`
    }
    return said
  }
  const rows = []
  if (drawnView === 'chess') {
    for (let index = 0; index < moves.length; index += 2) {
      rows.push(`${index / 2 + 1}. ${word(moves[index])}${moves[index + 1] ? `   ${word(moves[index + 1])}` : ''}`)
    }
  } else {
    moves.forEach((move, index) => rows.push(`${index + 1}. ${word(move)}`))
  }
  // Every seat is named the way a person reads the table: 'You', a friend's
  // name, 'Computer (Hard)' or 'Your agent (model)' — never the internal word
  // 'local', and never a bare 'White'/'Black' when somebody is sitting there.
  const seatLabel = seat => {
    if (!seat || seat.open) return seat && seat.side === 'black' ? 'Black' : 'White'
    if (seat.kind === 'local') {
      const said = levelLabel(pictured && pictured.level, pictured && pictured.learn)
      return `Computer${said ? ` (${said})` : ''}`
    }
    if (seat.kind === 'agent') return `Your Hermes model${modelName ? ` (${modelName})` : ''}`
    if (seat.kind === 'profile') return 'Profile agent'
    if (seat.id && seat.id === playerId) return 'You'
    return seat.name || (seat.side === 'black' ? 'Black' : 'White')
  }
  const seatKindBadge = seat => (!seat || seat.open ? null
    : seat.kind === 'local' ? 'Computer'
      : seat.kind === 'agent' || seat.kind === 'profile' ? 'Model' : 'Human')
  const seatOn = side => seats.find(seat => seat.side === side) || { side, open: true }
  const winnerSide = pictured && pictured.winner
  // In pass-and-play one person holds both seats, so "you" cannot be the winner: the screen
  // names the side instead of claiming the other player's win.
  const mySide = ownSeats.length === 1 ? ownSeats[0].side : null
  const iWon = Boolean(winnerSide && mySide && winnerSide === mySide)
  const machineWon = Boolean(winnerSide && machineSeat && machineSeat.side === winnerSide)
  const twoModels = seats.length === 2 && seats.every(seat => seat.kind === 'agent')
  const versus = twoModels
    ? 'You vs Two models'
    : machineSeat && (ownSeats.length === 1 || !shared)
    ? `You vs ${machineSeat.kind === 'agent' ? `Your Hermes model${modelName ? ` (${modelName})` : ''}` : `Computer${levelWord ? ` (${levelWord}${engineNote})` : ''}`}`
    : shared ? 'You vs Person here'
    : spectating ? 'Watching this table' : 'Table'
  // Against a machine the sides are not colours to the person reading them: it is you and
  // the enemy. Colours only survive for pass-and-play and for watching a table.
  const resultLine = status === 'draw'
    ? 'It is a draw.'
    : iWon ? 'You win!'
    : machineWon ? `${machineSeat.kind === 'agent' ? 'Your Hermes model' : 'The enemy'} wins.`
    : winnerSide ? (shared || spectating ? `${winnerSide === 'white' ? 'White' : 'Black'} wins.` : 'The enemy wins.') : 'Game over.'
  // The big words on the board: what decided it, then who won.
  const headline = resultHeadline({ pictured, status, iWon, machineWon, sideName: winnerSide === 'black' ? 'Black' : 'White', machineName: machineSeat && machineSeat.kind === 'agent' ? 'Your Hermes model' : 'Computer' })
  // A counted game's totals, said on the card itself.
  const countLine = over ? resultCountLine(pictured) : ''
  // A game whose rules cannot end level offers no draw, anywhere on its screen.
  const drawable = game.draws !== false && (!pictured || pictured.draws_allowed !== false)
  // The series line: names, not colours — 'Patchfox (Bot) 2 ·
  // Computer (Hard) 1 · Draws 0'. Colours only appear while a seat is still empty.
  const seriesLine = `${seatLabel(seatOn('white'))} ${score.white || 0} · ${seatLabel(seatOn('black'))} ${score.black || 0}`
    + (drawable ? ` · Draws ${score.draws || 0}` : '')
  const levelId = String((pictured && (pictured.level || pictured.remembered_level)) || 'intermediate').toLowerCase()
  const machineLine = machineSeat ? `allow-ai ${game.id} ${machineSeat.side}=${machineSeat.kind === 'agent' ? 'agent' : 'local'} level=${levelId}` : `${game.id} new`
  const newGameLabel = machineSeat && machineSeat.kind === 'local'
    ? `New game (${levelLabel(levelId) || 'Intermediate'})`
    : 'New game'
  // "With people" means another person holds the other seat. Against the computer (or
  // at one shared keyboard) there is nobody to ask, so leaving is one press.
  const againstPeople = !shared && seats.some(seat => seat.kind === 'human' && seat.id && seat.id !== playerId)
  const showStart = Boolean(leftSeat) || !status || status === 'idle' || status === 'preview'
  // Never leave the person wondering whether it crashed: a model's seat is a wait the moment the
  // board says it is that seat's turn, and a machine seat answering a request of ours is a wait
  // while that request is out. A computer seat merely on move is NOT "thinking" — nothing of ours
  // is out, so the line says it is waiting instead of claiming work that is not happening.
  // My own turn is announced the moment the board says it is mine.
  const thinking = Boolean(status === 'active' && (agentOnMove(pictured) || (busy && machineSeat)))
  const someoneElse = Boolean(status === 'active' && !thinking && !access.can_move && !spectating && !over)
  const waited = useWaitSeconds(thinking || someoneElse)
  // Always a sentence about whose move it is - empty was the bug: your turn looked exactly like
  // waiting, and a model's turn looked like nothing at all.
  const myTurnNow = Boolean(status === 'active' && access.can_move && !over)
  const machineName = machineSeat ? trafficName(machineSeat) : shared ? 'Person here' : 'the other player'
  // The same wait line the pane uses, in the same words: "Hermes is thinking…", "Computer is
  // thinking…" (only while a reply is out), "Waiting for the computer…", "Waiting for <name>…".
  const waitPhrase = waitWords(pictured, view, { working: busy && Boolean(machineSeat) })
  const waitingOn = (() => {
    const other = seats.find(seat => seat.side !== (mySide || '') && seat.kind === 'human' && seat.id && seat.id !== playerId)
    if (other) return other.name || 'the other player'
    // Nobody across the table: name the seat that is on move, in the same words as the wait line.
    const onMove = seats.find(seat => seat.side === pictured.turn) || null
    if (onMove && onMove.kind === 'local') return 'the computer'
    if (onMove && onMove.kind === 'agent') return 'Hermes'
    return 'the other player'
  })()
  // One status line under the header, in one wording: "Your turn", "<who> is thinking… Ns",
  // "Waiting for <who>… Ns", or the result. A wait always names the seat the same way the
  // "You vs …" line does, never "your bot", and it always counts: a line that reads "0s" is
  // telling the person the clock is running.
  // Backgammon's own turn has steps (roll, then spend the dice), so on the person's own turn its
  // board owns the words (14b-backgammon-svg.js); every wait uses the shared line above.
  const backgammonLine = pictured && pictured.view === 'backgammon' && myTurnNow
    ? backgammonTurnLine(pictured, myTurnNow, bgPhase) : ''
  const caption = pictured && pictured.status === 'lesson_done'
    ? 'Step done.'
    : over ? resultLine
    : backgammonLine || (thinking
      ? `${asking ? waitingLine(asking, aiSeat) : (waitPhrase || `${machineName} is thinking…`)} ${waitSecondsWords(waited)}`
      : myTurnNow ? 'Your turn'
      : status === 'active' && spectating ? 'This table is in play'
      : someoneElse ? `${waitPhrase || `Waiting for ${waitingOn}…`} ${waitSecondsWords(waited)}`
      : 'Choose how to play')
  const turnDot = pictured && pictured.turn === 'black' ? '#20262e' : '#f0d0b0'
  const dotColor = !pictured ? '#7d8796' : over ? '#7d8796' : turnDot

  const levelButtons = (choice, setup, off) => {
    const offered = (pictured && Array.isArray(pictured.levels) && pictured.levels.length) ? pictured.levels : null
    const listed = offered && offered.length
      ? offered
      : (choice.levels || []).length
        ? choice.levels
        : LEVEL_FALLBACK.map(level => ({ id: level, label: LEVEL_NAMES[level], line: `allow-ai {game} black=local level=${level}` }))
    return jsx('div', {
      style: { display: 'flex', gap: 8, flexWrap: 'wrap' },
      children: listed.map(level => jsx('span', {
        key: level.label,
        children: button(
          level.label,
          () => newMatch(String(level.line || choice.line).replace('{game}', game.id), () => setLocalSetup(setup)),
          lock({
            primary: String(level.id || '').toLowerCase() === String(pictured && pictured.remembered_level || 'intermediate').toLowerCase(),
            disabled: off || skillless,
            title: skillless ? SKILL_WHY : `You vs Computer (${level.label})`
          })
        )
      }, level.label))
    })
  }

  const chosen = opponentChoices(view)
  const computerChoice = chosen.find(choice => choice.id !== 'agent') || chosen[0] || { id: 'computer', levels: [], line: 'allow-ai {game} black=local' }
  const agentChoice = chosen.find(choice => choice.id === 'agent') || null
  const startOff = botOff || !access.can_manage
  // A solo table that seats an AI side (Blackjack's dealer) is offered the same two ways
  // on as every board game. A solo table with nobody to seat (Slots) keeps the one Play button it
  // has always had.
  const seatsNobody = gameSeatsNobody(game, pictured)
  const seatsAnAi = !botOff && !seatsNobody
  const vsBlack = sideWords.black.toLowerCase()
  // A solo table is live from the moment it is placed, so a new setup has to end the
  // session standing on the felt first - the table's own rule refuses a new one while
  // hands are played. Nothing staked yet is one press; a session in play asks once, the
  // same two-press rule the side pane keeps.
  const soloNew = who => {
    const line = `allow-ai ${game.id} black=${who === 'agent' ? 'agent' : 'local'} level=${levelId}`
    const after = () => setLocalSetup(who === 'agent' ? 'human-agent' : 'human-bot')
    if (status === 'active' && Number(pictured.plies || 0) > 0) {
      ask('new game', `Starting a new game ends this session and deals a new one against ${who === 'agent' ? 'your Hermes model' : 'the computer'}. Chips already bet on a settled hand stay settled.`, `${game.id} abandon`, () => command(line))
      return
    }
    command(line).then(ok => { if (ok && alive.current) after() })
  }
  const soloControls = solo && seatsAnAi ? jsxs('div', {
    'data-gm-solo-opponents': '1',
    style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center' },
    children: [
      button('New game vs computer', () => soloNew('computer'), lock({
        primary: true,
        disabled: startOff,
        title: `The built-in player takes ${vsBlack}: the game's own rules, no model needed.`
      })),
      agentChoice ? button('Play my Hermes model', () => soloNew('agent'), lock({
        disabled: startOff,
        title: startOff ? 'AI seats are off for this profile.' : `Your own Hermes model plays ${vsBlack}, one call per move.`
      })) : null
    ]
  }) : null
  // What sits above the playing surface while a game is on: who is across the table for a
  // board game (the label goes on the felt itself for Blackjack, in 17-blackjack.js), and
  // the two ways onto a new solo session for a table that seats an AI side.
  const tableTop = !showStart && status && status !== 'idle' && status !== 'preview'
    ? jsxs('div', {
        className: 'games-table-top',
        style: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' },
        children: [
          solo ? null : jsx(OpponentLine, { pictured, view, solo, shared }),
          soloControls
        ]
      })
    : null

  const startPanel = solo ? jsxs('section', {
    'aria-label': 'Sit down',
    style: { padding: '14px 16px', border: `1px solid ${stroke}`, borderRadius: 14, background: card, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520, margin: '0 auto', width: '100%' },
    children: [
      jsx('div', { style: { fontSize: 18, fontWeight: 700 }, children: game.title || game.id }),
      jsx('div', { style: { fontSize: 13, color: text.secondary }, children: game.summary || '' }),
      soloControls
        ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 }, children: [
            jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }, children: [
              jsx('b', { style: { fontSize: 14 }, children: 'Who takes the other side?' }),
              jsx('span', { style: { fontSize: 12, color: text.tertiary }, children: 'Nothing here needs typing.' })
            ] }),
            soloControls
          ] })
        : jsx('div', { children: button('Play', () => newMatch(`${game.id} new`, () => setLocalSetup('shared')), lock({ primary: true, disabled: !access.can_manage })) })
    ]
  }) : jsxs('section', {
    'aria-label': 'Choose how to play',
    style: { padding: '14px 16px', border: `1px solid ${stroke}`, borderRadius: 14, background: card, display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 680, margin: '0 auto', width: '100%' },
    children: [
      jsxs('div', { children: [
        jsx('div', { style: { fontSize: 18, fontWeight: 700 }, children: 'Choose how to play' }),
        jsx('div', { style: { fontSize: 12, color: text.tertiary, marginTop: 4 }, children: 'Press a level, or invite a friend. Nothing here needs typing.' })
      ] }),
      jsxs('div', {
        'aria-label': 'Play the computer option',
        style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px', borderRadius: 10, border: `1px solid ${stroke}` },
        children: [
          jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }, children: [
            jsx('b', { style: { fontSize: 14 }, children: 'Play the computer' }),
            jsx('span', { style: { fontSize: 12, color: text.tertiary }, children: 'The computer moves at once, no model needed.' })
          ] }),
          jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }, children: [
            button('Play the computer', () => newMatch(String(computerChoice.line || 'allow-ai {game} black=local').replace('{game}', game.id), () => setLocalSetup('human-bot')), lock({
              primary: true,
              disabled: startOff,
              title: `You vs Computer (${levelWord || 'Intermediate'})`
            })),
            jsx('span', { style: { fontSize: 12, color: text.tertiary }, children: `You vs Computer (${levelWord || 'Intermediate'}${engineNote})` })
          ] }),
          levelButtons(computerChoice, 'human-bot', startOff),
          jsx('div', {
            className: 'games-level-note',
            style: { fontSize: 12, color: text.tertiary },
            children: (pictured && Array.isArray(pictured.levels) && pictured.levels.length > 1)
              ? `${pictured.levels[0].label} is gentlest, ${pictured.levels[pictured.levels.length - 1].label} is toughest. ${pictured.levels[1].label} until you pick, and the table remembers your choice for ${game.title || game.id}.`
              : `Beginner is gentlest, Expert is toughest. Intermediate until you pick, and the table remembers your choice for ${game.title || game.id}.`
          })
        ]
      }),
      agentChoice ? jsxs('div', {
        'aria-label': 'Play my bot option',
        style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px', borderRadius: 10, border: `1px solid ${stroke}` },
        children: [
          jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }, children: [
            jsx('b', { style: { fontSize: 14 }, children: 'Play my bot' }),
            jsx('span', { className: 'games-opponent-model', style: { fontSize: 12, color: text.secondary, fontFamily: 'var(--font-mono, monospace)', overflowWrap: 'anywhere' }, children: agentChoice.model ? `${agentChoice.model}${agentChoice.where ? ` · ${agentChoice.where}` : ''}` : 'Your agent · your model' })
          ] }),
          jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: `Your own Hermes model plays ${sideWords.black.toLowerCase()}, one move per turn. Pick the model in Hermes Settings → Models → "Game Shelf opponent".` }),
          // Choosing a Hermes model offers both shapes - you against a model, or two models
          // against each other so their play can be compared.
          modelMenu
            ? jsxs('div', {
                'data-model-menu': '1',
                style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 10px', borderRadius: 8, border: `1px dashed ${stroke}` },
                children: [
                  jsx('div', { style: { fontSize: 12, color: text.secondary }, children: 'How should the Hermes seats be filled?' }),
                  button(`Play against a Hermes model (${sideWords.black.toLowerCase()})`, () => {
                    setModelMenu(false)
                    newMatch(String(agentChoice.line || 'allow-ai {game} black=agent').replace('{game}', game.id), () => setLocalSetup('human-agent'))
                  }, lock({
                    primary: true,
                    disabled: startOff,
                    title: startOff ? 'AI seats are off for this profile.' : `You play ${sideWords.white.toLowerCase()}; a Hermes model plays ${sideWords.black.toLowerCase()}, one call per move.`
                  })),
                  button('Watch two Hermes models play each other', () => {
                    setModelMenu(false)
                    newMatch(`allow-ai ${game.id} white=agent black=agent`, () => { setLocalSetup('bots'); setWatching(true) })
                  }, lock({
                    disabled: startOff,
                    title: startOff ? 'AI seats are off for this profile.' : 'Two Hermes seats, both models: you watch and the moves are logged.'
                  })),
                  button('Cancel', () => setModelMenu(false), { title: 'Leave the seats as they are.' })
                ]
              })
            : button('Play my Hermes model(s)', () => setModelMenu(true), lock({
                primary: true,
                disabled: startOff,
                title: startOff ? 'AI seats are off for this profile.' : 'Choose: play against a Hermes model, or watch two of them play.'
              }))
        ]
      }) : null,
      jsxs('div', {
        'aria-label': 'Play a friend option',
        style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px', borderRadius: 10, border: `1px solid ${stroke}` },
        children: [
          jsx('b', { style: { fontSize: 14 }, children: 'Play a friend' }),
          // Online play is the in-Hermes lobby now (the Games sidebar), so this screen
          // keeps no browser door, no lobby address and no copy-the-link invite.
          jsx('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' }, children: [
            button('Same screen (pass and play)', () => newMatch(`${game.id} new`, () => setLocalSetup('shared')), lock({ disabled: !access.can_manage, title: 'Both sides on this keyboard, taking turns.' }))
          ] }),
          jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: 'To play someone online, open the lobby in the Games sidebar.' })
        ]
      })
    ]
  })

  const seatCards = jsx('div', {
    className: 'games-seats',
    style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 },
    children: seats.map(seat => {
      const toMove = status === 'active' && pictured.turn === seat.side
      return jsxs('section', {
        'aria-label': `${seat.side} seat`,
        style: { padding: '10px 12px', borderRadius: 10, border: `1px solid ${toMove ? accent : stroke}`, boxShadow: toMove ? `0 0 0 1px ${accent} inset` : 'none', background: card, display: 'flex', flexDirection: 'column', gap: 8 },
        children: [
          jsx('div', { style: { fontSize: 12, color: text.tertiary, textTransform: 'uppercase', letterSpacing: '.08em' }, children: `${sideWords[seat.side] || seat.side}${toMove ? ' · to move' : ''}` }),
          jsxs('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }, children: [
            jsx('div', { style: { fontSize: 16, fontWeight: 650, overflowWrap: 'anywhere' }, children: seat.open ? 'Open seat' : seatLabel(seat) }),
            seatKindBadge(seat) ? badge(seatKindBadge(seat)) : null
          ] }),
          jsx('div', { style: { color: text.secondary, fontSize: 13 }, children: seat.open
            ? 'Waiting for a human'
            : `${seatWords[seat.side] || `${sideWords[seat.side]} pieces`} · ${seatKindBadge(seat) || 'Human'}` }),
          seat.open ? button(`Sit as ${sideWords[seat.side] || (seat.side === 'white' ? 'White' : 'Black')}`, () => command(`${game.id} sit ${seat.side}`), lock({ disabled: !access.can_join })) : null
        ]
      }, seat.side)
    })
  })

  const advanced = jsxs('details', {
    className: 'games-advanced',
    style: { border: `1px solid ${stroke}`, borderRadius: 12, background: card, padding: '8px 12px' },
    children: [
      jsx('summary', { style: { cursor: 'pointer', fontSize: 12, color: text.secondary, fontWeight: 650 }, children: 'More options' }),
      jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 10 }, children: [
        jsxs('div', {
          style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: text.secondary },
          children: [
            badge(shared ? 'Pass-and-play · shared keyboard' : bothLocal && access.can_manage ? 'Watching bots · table owner' : spectating ? 'Spectating · read-only' : ownSeats.length ? 'You are seated' : 'Choose your seat'),
            badge(seriesLine),
            pictured && pictured.table_id ? jsx('span', { style: { overflowWrap: 'anywhere' }, children: `Table ${pictured.table_id}` }) : null
          ]
        }),
        seatCards,
        jsxs('div', {
          style: { display: 'flex', flexWrap: 'wrap', gap: 8 },
          children: [
            button('Two players', () => newMatch(`${game.id} new`, () => setLocalSetup('shared')), lock({ disabled: !access.can_manage, title: 'Pass-and-play: both human sides share this keyboard.' })),
            button('Learn to play', () => newMatch(`${game.id} lesson`, () => setLocalSetup('lesson')), lock({
              disabled: !access.can_manage || pictured.has_lesson === false || skillless,
              title: skillless ? SKILL_WHY : 'A few short steps on a real board. Nothing is scored.'
            })),
            button('Watch bots', () => newMatch(`allow-ai ${game.id} white=local black=local`, () => { setLocalSetup('bots'); setWatching(true) }), lock({
              disabled: botOff || !access.can_manage,
              title: botOff ? 'AI seats are off for this profile.' : 'You consent to two built-in players.'
            })),
            button('Agent vs bot', () => newMatch(`allow-ai ${game.id} white=agent black=local`, () => { setLocalSetup('agent-bot'); setWatching(true) }), lock({
              disabled: botOff || !access.can_manage,
              title: botOff ? 'AI seats are off for this profile.' : 'Watch your Hermes model play the built-in player.'
            })),
            watching ? button('Stop', stopWatching) : bothLocal && status === 'active' ? button('Resume bots', () => { if (!botOff && access.can_step) setWatching(true) }, lock({ disabled: botOff || !access.can_step, title: 'Continue this match with the already-consented built-in seats.' })) : null,
            bothLocal && status === 'active' ? button('Next move', () => command(`${game.id} step`), lock({ disabled: botOff || !access.can_step || watching })) : null
          ]
        }),
        jsxs('div', {
          style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
          children: drawnView === 'seabattle'
            // Sea Battle is played with the mouse only: a list of seven hundred
            // `place carrier …` lines is not a keyboard fallback, it is noise.
            ? [jsx('span', { style: { fontSize: 12, color: text.tertiary }, children: 'This table is played with the mouse: drag your ships, then click enemy waters. The move history below lists every move.' }, 'mouse-only')]
            : [
            jsx('select', {
              'aria-label': 'Legal move', value: legalMove,
              disabled: busy || !access.can_move || Boolean(confirmation),
              onChange: event => setLegalMove(event.target.value),
              style: { minWidth: 140, maxWidth: '100%', padding: '8px 10px', border: `1px solid ${stroke}`, borderRadius: 8, color: text.primary, background: card },
              children: [jsx('option', { value: '', children: access.can_move ? 'Choose a legal move…' : 'Waiting for your turn' }), ...((pictured && pictured.legal) || []).map(token => jsx('option', { value: String(token), children: String(token) }, String(token)))]
            }),
            button('Play move', () => {
              if (access.can_move && legalMove && (pictured.legal || []).includes(legalMove)) {
                submit({ kind: 'move', token: legalMove }, () => playMove(game.id, legalMove))
              }
            }, lock({ disabled: !access.can_move || !legalMove || Boolean(confirmation) })),
            jsx('span', { style: { color: text.tertiary, fontSize: 11 }, children: 'Keyboard players can pick a legal move here instead of using the board.' })
          ]
        }),
        rows.length ? jsxs('ol', {
          style: { margin: 0, paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 140, overflow: 'auto', fontFamily: 'var(--font-mono, monospace)', fontSize: 12, color: text.secondary },
          children: rows.map((row, index) => jsx('li', { style: { overflowWrap: 'anywhere' }, children: row }, index))
        }) : null,
        notice ? pre(notice) : null,
        board && board.text ? pre(board.text) : null
      ] })
    ]
  })

  // The single action row under the board, in one wording and one fixed order:
  // Undo move · Hint · Offer draw · Resign · Leave table. Only what this table can
  // actually do is drawn, and both Resign and Leave table confirm before they act
  // (leaveTable above says whether leaving keeps or forfeits the game).
  const canUndo = Boolean(pictured && pictured.lesson && pictured.lesson.undo)
  const actionRow = jsxs('div', {
    className: 'games-actions',
    role: 'group',
    'aria-label': 'Table actions',
    style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
    children: [
      canUndo ? button('Undo move', () => command(`${game.id} learn undo`), lock({ disabled: Boolean(confirmation), title: 'Take back that move and the computer reply, and try again.' })) : null,
      pictured && pictured.hint_ok && access.can_move ? greyed(button('Hint', () => submit({ kind: 'hint' }, () => send(`${game.id} hint`)), lock({ disabled: Boolean(confirmation) || skillless, title: skillless ? SKILL_WHY : 'The computer suggests a move, and your Hermes model says why. Only against the computer.' }))) : null,
      status === 'active' && drawable && !solo ? button(drawOffer && !offeredByMe ? 'Accept draw' : offeredByMe ? 'Draw offered' : 'Offer draw', () => ask(drawOffer && !offeredByMe ? 'draw' : 'offer draw', drawOffer && !offeredByMe ? 'Accepting ends this match as a draw.' : 'Offer a draw to your opponent. The game continues until accepted.', `${game.id} draw${drawOffer && !offeredByMe ? ' accept' : ''}`), lock({ disabled: !access.can_draw || offeredByMe })) : null,
      status === 'active' && !solo ? button('Resign', () => ask('resign', 'Resigning ends this match and awards the win to your opponent.', `${game.id} resign`), lock({ disabled: !access.can_resign })) : null,
      status === 'active' && ownSeats.length
        ? button('Leave table', leaveTable, lock({ disabled: Boolean(confirmation) }))
        : button('Close table', leaveTable, lock({ title: 'Back to the shelf. Nothing here is thrown away.' }))
    ]
  })

  // A proper move ledger, not a cramped ticker: two named columns (the shelf's
  // games all open with White), move numbers, larger text, its own scroll that
  // follows the newest move, and a fold for narrow panes.
  const pliesTotal = (pictured && pictured.plies) || moves.length
  const historyRef = useRef(null)
  const [historyOpen, setHistoryOpen] = useState(true)
  useEffect(() => {
    const node = historyRef.current
    if (node && historyOpen) node.scrollTop = node.scrollHeight
  }, [pliesTotal, historyOpen])
  const movePairs = []
  for (let index = 0; index < moves.length; index += 2) {
    movePairs.push({ number: index / 2 + 1, first: word(moves[index]), second: moves[index + 1] ? word(moves[index + 1]) : '' })
  }
  // The plies where the referee refused a model's moves and the built-in player
  // moved for it: the ledger badges that move, and the title says what was
  // proposed and why each one was refused, so the stand-in is never the model's.
  const refusedAt = {}
  for (const record of (pictured && pictured.refusals) || []) {
    if (record && Array.isArray(record.proposals) && record.proposals.length) refusedAt[Number(record.ply)] = record
  }
  const refusalBadge = record => (!record ? null : jsx('span', {
    className: 'games-refusal-badge',
    title: `${record.proposals.map(item => `${item.proposed}: ${item.reason}`).join('; ')}. Two refused moves, so the built-in player moved ${record.played} for it.`,
    style: { marginLeft: 6, fontSize: 10, fontWeight: 400, color: text.tertiary, border: `1px solid ${stroke}`, borderRadius: 999, padding: '1px 7px', whiteSpace: 'nowrap' },
    children: 'Referee said no'
  }, 'refused'))
  // The refusal, said out loud: when a refusal lands on the newest ply the referee's
  // own sentence stands above the board for a moment, and stays in the move list
  // under that move's badge. The banner is only ever the newest ply's, and it goes
  // away on its own after two and a half seconds.
  const newestPly = (pictured && typeof pictured.plies === 'number' ? pictured.plies : moves.length) || 0
  // A record's ply is the index of the move the built-in player made for the model,
  // so the newest move is index plies - 1.
  const newestRefusal = refusedAt[newestPly - 1] || null
  const [refusalBanner, setRefusalBanner] = useState(null)
  const bannerPlyRef = useRef(null)
  const refusalTimer = useRef(null)
  useEffect(() => {
    const record = newestRefusal
    const key = record && record.message ? `${newestPly}:${record.message}` : null
    if (!record || !record.message || bannerPlyRef.current === key) return
    bannerPlyRef.current = key
    setRefusalBanner(record.message)
    if (refusalTimer.current) clearTimeout(refusalTimer.current)
    refusalTimer.current = setTimeout(() => {
      refusalTimer.current = null
      setRefusalBanner(null)
    }, 2500)
  }, [newestPly, newestRefusal])
  useEffect(() => () => { if (refusalTimer.current) clearTimeout(refusalTimer.current) }, [])
  const refusalBannerEl = refusalBanner ? jsx('div', {
    className: 'games-refusal-banner',
    role: 'status',
    style: {
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 6,
      width: '100%', padding: '8px 12px', borderRadius: 10,
      border: `1px solid ${accent}`, background: 'var(--ui-accent-soft, var(--ui-fill-secondary, rgba(127, 127, 127, 0.18)))',
      fontSize: 13, fontWeight: 650, color: text.primary, textAlign: 'center', overflowWrap: 'anywhere'
    },
    children: refusalBanner
  }, `refusal-banner-${newestPly}`) : null
  const refusalLine = record => (!record || !record.message ? null : jsx('div', {
    style: { gridColumn: '2 / 4', marginTop: 2, fontSize: 11, color: text.tertiary, overflowWrap: 'anywhere' },
    children: record.message
  }, `refusal-line-${record.ply}`))
  const historyGrid = { display: 'grid', gridTemplateColumns: '40px minmax(0, 1fr) minmax(0, 1fr)', gap: '3px 10px', alignItems: 'baseline' }
  const moveList = jsxs('section', {
    className: 'games-move-history',
    'aria-label': 'Move history',
    style: { border: `1px solid ${stroke}`, borderRadius: 12, padding: '10px 14px', background: card, minWidth: 0 },
    children: [
      jsxs('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: text.tertiary }, children: [
        button(historyOpen ? 'Hide moves' : 'Show moves', () => setHistoryOpen(open => !open), { title: historyOpen ? 'Fold the move list away.' : 'Unfold the full move list.' }),
        jsx('b', { style: { color: text.secondary }, children: pliesTotal === 1 ? 'Move history · 1 move' : `Move history · ${pliesTotal} moves` }),
        pictured && pictured.last ? jsx('span', { className: 'games-last-move', children: `Last move: ${word(pictured.last)}` }) : null
      ] }),
      historyOpen ? jsxs('div', {
        ref: historyRef,
        style: { maxHeight: 184, overflowY: 'auto', overflowX: 'hidden', marginTop: 8, minWidth: 0, fontFamily: 'var(--font-mono, monospace)', fontSize: 14, color: text.secondary }
      , children: [
          movePairs.length ? jsxs('div', { style: { ...historyGrid, position: 'sticky', top: 0, background: card, padding: '2px 0', borderBottom: `1px solid ${stroke}`, marginBottom: 4 }, children: [
            jsx('span', { style: { color: text.tertiary, fontSize: 12 }, children: '#' }),
            jsx('span', { style: { color: text.secondary, fontSize: 12, overflowWrap: 'anywhere' }, children: `${seatLabel(seatOn('white'))} · ${sideWords.white}` }),
            jsx('span', { style: { color: text.secondary, fontSize: 12, overflowWrap: 'anywhere' }, children: `${seatLabel(seatOn('black'))} · ${sideWords.black}` })
          ] }) : null,
          movePairs.length ? jsx('div', { style: historyGrid, children: movePairs.map(pair => [
            jsx('span', { style: { color: text.tertiary, fontSize: 12, textAlign: 'right' }, children: `${pair.number}.` }, `n${pair.number}`),
            jsxs('span', { style: { overflowWrap: 'anywhere' }, children: [pair.first, refusalBadge(refusedAt[(pair.number - 1) * 2])] }, `w${pair.number}`),
            jsxs('span', { style: { overflowWrap: 'anywhere' }, children: [pair.second, refusalBadge(refusedAt[(pair.number - 1) * 2 + 1])] }, `b${pair.number}`),
            refusalLine(refusedAt[(pair.number - 1) * 2]),
            refusalLine(refusedAt[(pair.number - 1) * 2 + 1])
          ]), }) : jsx('div', { style: { fontSize: 13, color: text.tertiary, marginTop: 2 }, children: 'No moves yet.' })
        ] }) : null
    ]
  })

  // The result card that sits ON the board. Big words, the deciding thing ringed on the
  // drawing underneath, and the four ways on. It stays until one of them is pressed.
  const resultCard = over ? jsx('div', {
    className: 'games-result',
    onClick: () => setResultHidden(true),
    style: {
      position: 'absolute', inset: 0, zIndex: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 12, background: 'rgba(8, 12, 18, .58)', borderRadius: 12, cursor: 'pointer'
    },
    children: jsxs('section', {
      role: 'alert', 'aria-label': 'Game over', 'aria-live': 'assertive',
      onClick: e => e.stopPropagation(),
      style: { display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', textAlign: 'center', maxWidth: 470, padding: '18px 20px', borderRadius: 16, border: `2px solid ${iWon ? accent : stroke}`, background: card, boxShadow: '0 20px 44px rgba(0, 0, 0, .55)' },
      children: [
        jsx('div', { className: 'games-result-title', style: { fontSize: 30, fontWeight: 800, lineHeight: 1.1 }, children: headline }),
        // The payout, said out loud: a win outside blackjack is worth 100 points, and the card shows
        // it landing rather than leaving the person to find the number later.
        iWon ? jsxs('div', {
          'data-gm-win-bonus': '100',
          style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, animation: 'gm-bonus 900ms cubic-bezier(.2,.9,.3,1.25) both' },
          children: [
            jsx('style', { children: '@keyframes gm-bonus { 0% { transform: scale(.4); opacity: 0 } 60% { transform: scale(1.14); opacity: 1 } 100% { transform: scale(1); opacity: 1 } }' }, 'bonus-style'),
            jsx('div', {
              style: { fontSize: 34, fontWeight: 900, letterSpacing: 1, color: '#f5c542', textShadow: '0 2px 0 #7f1d1d, 0 0 26px rgba(245,197,66,.55)' },
              children: '+100 POINTS'
            }),
            jsx('div', { style: { fontSize: 12, color: text.secondary }, children: points !== null ? `Your score: ${Number(points).toLocaleString()} points` : 'Added to your score.' })
          ]
        }) : null,
        jsx('div', { className: 'games-result-why', style: { fontSize: 13, color: text.secondary }, children: versus }),
        countLine ? jsx('div', { className: 'games-result-count', style: { fontSize: 14, fontWeight: 650, color: text.secondary }, children: countLine }) : null,
        // The overlay names every player with their badge, so a finished board
        // says who did it — not just which colour won.
        jsx('div', { className: 'games-result-players', style: { display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', fontSize: 13 }, children: ['white', 'black'].map(side => {
          const seat = seatOn(side)
          if (seat.open) return null
          return jsxs('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center' }, children: [
            jsx('b', { style: { overflowWrap: 'anywhere' }, children: seatLabel(seat) }),
            badge(seatKindBadge(seat)),
            jsx('span', { style: { color: text.tertiary }, children: seat.side === 'white' ? score.white || 0 : score.black || 0 })
          ] }, side)
        }) }),
        score.white || score.black || (drawable && score.draws)
          ? jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: `Series: ${seriesLine}` })
          : null,
        jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 2 }, children: [
          access.can_review ? button('Review my game', () => command(`${game.id} review`), lock({ title: 'We look at one move you could have played better. Nothing is scored, and you can play again right after.' })) : null,
          button(requestedByMe ? 'Rematch requested' : rematchRequests.length ? 'Accept rematch' : 'Rematch', () => ask('rematch', 'Start another game with the same seats and series score. Any built-in bot seats are included in your consent.', `${game.id} rematch`), lock({ primary: true, disabled: !access.can_rematch || requestedByMe || (botOff && seats.some(seat => seat.kind === 'local')) })),
          button(newGameLabel, () => newMatch(machineLine, () => setLocalSetup(machineSeat && machineSeat.kind === 'agent' ? 'human-agent' : machineSeat ? 'human-bot' : 'shared')), lock({ disabled: !access.can_manage, title: 'A fresh game with the same opponent.' })),
          button('Back to games', () => {
            alive.current = false
            stopWatching()
            onBack()
          })
        ] }),
        textLink('Look at the board', () => setResultHidden(true))
      ]
    })
  }) : null

  // Kept on the page when the card is put away by hand, so the result is never hidden
  // and never auto-dismissed.
  const resultBar = over && resultHidden ? jsxs('section', {
    className: 'games-result-bar', 'aria-label': 'Game over',
    style: { display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', padding: '10px 14px', border: `1px solid ${iWon ? accent : stroke}`, borderRadius: 12, background: card },
    children: [
      jsxs('div', { children: [
        jsx('div', { style: { fontSize: 18, fontWeight: 750 }, children: headline }),
        jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: versus }),
        countLine ? jsx('div', { className: 'games-result-count', style: { fontSize: 13, fontWeight: 650, color: text.secondary }, children: countLine }) : null
      ] }),
      jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' }, children: [
        button('Show result', () => setResultHidden(false), { primary: true }),
        button('Back to games', () => { alive.current = false; stopWatching(); onBack() })
      ] })
    ]
  }) : null

  // An online table is the same match, held by the lobby server and played here. When one is
  // open for this person — for *this* game — it *is* this screen: the local board is not drawn,
  // nothing on it can send a local game command, and OnlineTable posts every click to
  // /online/table/cmd instead.
  const onlineRoom = onlineRoomFor(view, game.id)
  if (onlineRoom) return jsx(OnlineTable, { game, view, ctx, roomId: onlineRoom, onBack })

  return jsxs('div', {
    className: 'games-play-table',
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      padding: 14,
      paddingBottom: 96,
      minWidth: 0,
      minHeight: 0,
      overflow: 'auto',
      background: paper,
      height: '100%'
    },
    children: [
      jsxs('div', {
        // Sticky at the top of this scroller: reaching More options at the bottom scrolls the
        // page, and a header that scrolls away leaves Back off-screen (y negative) with the
        // winner overlay open. Pinned here, Back stays on screen and clickable in every state.
        style: {
          display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap',
          paddingBottom: 12, borderBottom: `1px solid ${stroke}`,
          position: 'sticky', top: 0, zIndex: 5, background: paper
        },
        children: [
          jsxs('div', { style: { display: 'flex', gap: 12, alignItems: 'center', minWidth: 0 }, children: [
            button('Back to games', () => {
              alive.current = false
              stopWatching()
              onBack()
            }),
            jsxs('div', { style: { minWidth: 0 }, children: [
              jsx('div', { style: { fontWeight: 600, fontSize: 24, fontFamily: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, ui-serif, serif', letterSpacing: '-.015em', lineHeight: 1.15 }, children: game.title }),
              game.subtitle ? jsx('div', { style: { fontSize: 12, fontStyle: 'italic', color: text.secondary }, children: game.subtitle }) : null,
              jsx('div', { className: 'games-headline-players', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }, children: ['white', 'black'].map(side => {
                const seat = seatOn(side)
                if (seat.open) return null
                return jsxs('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }, children: [
                  jsx('b', { style: { color: text.secondary, overflowWrap: 'anywhere' }, children: seatLabel(seat) }),
                  badge(seatKindBadge(seat)),
                  jsx('span', { style: { color: text.tertiary }, children: seat.side === 'white' ? score.white || 0 : score.black || 0 })
                ] }, side)
              }) })
            ] })
          ] }),
          // The header, left to right after the name: who you are playing (points), then the
          // two doors every table shares - How to play and Settings. The "You vs <opponent>"
          // line sits under this header, above the board, in one wording.
          jsxs('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }, children: [
            // Points live on the table, so a win that pays 100 is visible where it happened.
            points !== null ? jsxs('span', {
              'data-gm-points': String(points),
              title: 'Your Game Center points: 100 for every game won outside blackjack, plus what your tokens buy.',
              style: {
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px',
                borderRadius: 999, border: `1px solid ${stroke}`, background: card,
                fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums'
              },
              children: [
                jsx('span', { 'aria-hidden': true, style: { color: accent }, children: '✦' }, 'mark'),
                jsx('span', { children: `${Number(points).toLocaleString()} points` }, 'value')
              ]
            }) : null,
            solo ? null : jsx(LearnButton, {
              game,
              ctx,
              label: 'How to play',
              onStartLearn: () => newMatch(
                `${String(computerChoice.line || 'allow-ai {game} black=local').replace('{game}', game.id)} learn`,
                () => { setGuideStep(0); setLocalSetup('human-bot') }
              )
            }),
            button('Settings', () => setSettingsOpen(open => !open), {
              pressed: settingsOpen,
              title: 'Sound and the table’s own settings.'
            })
          ] })
        ]
      }),
      // The settings sheet, opened from the header: the one switch a board table really has
      // (its sound), read and written through the same remembered key as the app Settings.
      settingsOpen ? jsxs('section', {
        'aria-label': 'Settings',
        className: 'games-table-settings',
        style: { border: `1px solid ${stroke}`, borderRadius: 12, background: card, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 },
        children: [
          jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }, children: [
            jsx('b', { style: { fontSize: 14 }, children: 'Settings' }),
            jsx('span', { style: { fontSize: 12, color: text.tertiary }, children: 'Sound for this table. Nothing here needs typing.' })
          ] }),
          jsx(SoundSetting, {})
        ]
      }) : null,
      // The one "You vs <opponent>" line, directly under the header and above the board.
      tableTop,
      jsxs('div', {
        role: 'status', 'aria-live': 'polite', className: 'games-status',
        style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 14, fontWeight: 650 },
        children: [
          over ? null : jsx('span', {
            'aria-hidden': true, className: 'games-turn-dot',
            style: { display: 'inline-block', width: 12, height: 12, borderRadius: '50%', background: dotColor, border: turnDot === '#20262e' ? '1px solid #7d8796' : '1px solid #8a704f' }
          }),
          jsx('span', {
            'data-turn-line': thinking ? 'thinking' : myTurnNow ? 'mine' : someoneElse ? 'theirs' : over ? 'over' : 'setup',
            // The model behind a Hermes seat is named on hover: the line itself stays two words
            // and a clock, and which model is spending the tokens is still one hover away.
            title: thinking && aiSeat && aiSeat.kind === 'agent' && modelName ? `${caption} — ${modelName}` : undefined,
            style: myTurnNow ? { color: accent, fontWeight: 800 } : thinking || someoneElse ? { color: text.secondary } : null,
            children: caption
          }),
          // A moving dot while the other seat works, so the line is visibly alive. The keyframes
          // ride with the strip: the game page has no stylesheet of its own to edit.
          thinking || someoneElse
            ? jsx('style', { children: '@keyframes games-spin { to { transform: rotate(360deg) } }' })
            : null,
          thinking || someoneElse
            ? jsx('span', { 'aria-hidden': true, className: 'games-spin', style: { display: 'inline-block', width: 10, height: 10, borderRadius: '50%', border: '2px solid ' + text.tertiary, borderTopColor: 'transparent', animation: 'games-spin 900ms linear infinite' } })
            : null,
          // Chess says check out loud, so nobody plays on without seeing it.
          status === 'active' && pictured && pictured.check
            ? jsx('span', {
                className: 'games-check', role: 'alert',
                style: { padding: '2px 9px', borderRadius: 999, background: '#c0392b', color: '#fff', fontSize: 12, fontWeight: 800, letterSpacing: '.04em' },
                children: 'Check!'
              })
            : null,
          // The wait is said once, in the status line above; nothing repeats it here.
          notice && noteLine(notice) ? jsx('span', { style: { fontSize: 12, color: text.tertiary, fontWeight: 400 }, children: noteLine(notice) }) : null
        ]
      }),
      showStart ? startPanel : null,
      refusalBannerEl,
      leftSeat ? jsx('div', { role: 'status', className: 'games-left-seat', style: { fontSize: 13, color: text.secondary }, children: 'You left the table. Pick how to play again, or press Back.' }) : null,
      !showStart && pictured && status && status !== 'idle' && status !== 'preview'
        ? jsxs('div', {
            className: 'games-board-hero',
            // Fixed height, not a flexible one: with `1 1 auto` opening More options shrank this box
            // while the SVG kept its height, so the board drew over the header and covered Back.
            style: { display: 'flex', flex: '0 0 auto', alignItems: 'center', justifyContent: 'center', padding: 4, position: 'relative' },
            children: [
              drawnView === 'blackjack' || drawnView === 'slots'
                ? jsx(drawnView === 'blackjack' ? BlackjackTable : SlotsTable, {
                    picture: pictured,
                    // The felt says who is across it.
                    against: opponentWords(pictured, view, solo),
                    interactive: Boolean(game.installed && access.can_move && !busy && !confirmation),
                    busy,
                    onMove: token => {
                      if (!access.can_move || confirmation) return
                      submit({ kind: 'move', token }, () => playMove(game.id, token))
                    },
                    onSetting: (path, body) => ctx.rest(path, { method: 'POST', body })
                  })
              : drawnView === 'seabattle'
                ? jsx(SeaBattleTable, {
                    picture: pictured,
                    interactive: Boolean(game.installed && (game.kind || 'table') === 'table' && access.can_move && !busy && !confirmation),
                    busy,
                    onMove: token => {
                      if (!access.can_move || confirmation) return
                      submit({ kind: 'move', token }, () => playMove(game.id, token))
                    }
                  })
                : jsx(pictured && pictured.view === 'backgammon' ? BackgammonSvg : BoardSvg, {
                  picture: pictured,
                  coachArrows: coachArrowPairs(pictured),
                  height: PLAY_HEIGHT,
                  flat: true,
                  pending: preview,
                  onPhase: setBgPhase,
                  onPending: move => { if (access.can_move && !confirmation) setPreview(move) },
                  interactive: Boolean(game.installed && (game.kind || 'table') === 'table' && access.can_move && !busy && !confirmation),
                  onMove: token => {
                    if (!access.can_move || confirmation) return
                    const label = pictured && pictured.view === 'connect4' ? `column ${token}` : String(token)
                    submit({ kind: 'move', token: label }, () => playMove(game.id, token))
                  }
                }),
              resultHidden ? null : resultCard
            ]
          })
        : null,
      pictured && pictured.learn ? jsx(CoachGuide, { game, pictured, learn: learnBook.data, guideStep, setGuideStep }) : null,
      greyed(jsx(CoachStrip, { game, pictured, command, lock })),
      !showStart ? resultBar : null,
      failure ? jsx('div', { role: 'alert', style: { padding: 12, border: '1px solid #d76b65', borderRadius: 8, fontSize: 13 }, children: failure }) : null,
      confirmation ? jsxs('section', {
        role: 'alertdialog', 'aria-label': `Confirm ${confirmation.label}`, 'aria-describedby': 'games-match-confirmation',
        onKeyDown: event => { if (event.key === 'Escape') setConfirmation(null) },
        style: { padding: 16, border: `1px solid ${accent}`, borderRadius: 12, background: card },
        children: [
          jsx('p', { id: 'games-match-confirmation', style: { margin: '0 0 12px', fontSize: 13 }, children: confirmation.message }),
          jsxs('div', { style: { display: 'flex', gap: 8 }, children: [
            button(confirmation.cancelLabel || 'Cancel', () => setConfirmation(null), { autoFocus: true }),
            button(confirmation.confirmLabel || `Confirm ${confirmation.label}`, async () => {
              const choice = confirmation
              setConfirmation(null)
              const ok = await command(choice.line)
              if (ok && alive.current && choice.after) choice.after()
            }, lock({ primary: true }))
          ] })
        ]
      }) : null,
      lesson ? jsxs('section', {
        'aria-label': reviewLesson ? 'Review of your game' : 'Lesson',
        style: { padding: '10px 12px', border: `1px solid ${accent}`, borderLeft: `4px solid ${accent}`, borderRadius: 8, background: card, display: 'flex', flexDirection: 'column', gap: 6 },
        children: [
          jsx('b', { style: { fontSize: 13 }, children: reviewLesson ? 'Your game, one move at a time' : `Lesson · step ${lesson.step} of ${lesson.of}` }),
          jsx('div', { style: { fontSize: 14 }, children: lesson.say }),
          reviewLesson && lesson.custom && lesson.custom.coach
            ? jsx(CoachReview, { coach: lesson.custom.coach, onWhy: () => command(`${game.id} hint`) })
            : null,
          lesson.note ? jsx('div', { role: 'status', style: { fontSize: 13, color: text.secondary }, children: lesson.note }) : null,
          jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' }, children: reviewLesson
            ? [
                status === 'lesson_done' ? button('Rematch', () => command(`${game.id} rematch`), lock({ primary: true, title: 'Play another game against the same opponent, with the series score kept.' })) : null
              ]
            : [
                status === 'lesson_done' && lesson.step < lesson.of ? button('Next step', () => command(`${game.id} lesson next`), lock({ primary: true })) : null,
                status === 'lesson_done' && lesson.step >= lesson.of ? button('Play the computer', () => command(`allow-ai ${game.id} black=local`).then(ok => { if (ok && alive.current) setLocalSetup('human-bot') }), lock({ primary: true, disabled: botOff })) : null,
                button('Start this step again', () => command(`${game.id} lesson ${lesson.step}`), lock({}))
              ] })
        ]
      }) : null,
      pictured?.view === 'chess' && pictured.coach && (pictured.coach.in_book || pictured.coach.left_ply != null) ? jsx(CoachPanel, { coach: pictured.coach }) : null,
      // Game-specific move controls (Go's Pass) sit just above the one action row.
      (pictured && (pictured.legal || []).includes('pass')) && access.can_move ? jsx('div', {
        style: { display: 'flex', gap: 8, alignItems: 'center' },
        children: [
          button('Pass', () => submit({ kind: 'move', token: 'pass' }, () => playMove(game.id, 'pass')), lock({ disabled: Boolean(confirmation) })),
          jsx('span', { style: { fontSize: 12, color: text.tertiary }, children: 'Nothing useful to place? Pass and let your opponent move.' })
        ]
      }) : null,
      // The one action row, directly under the board.
      actionRow,
      // Move history stays the expandable section below the action row.
      !status || status === 'idle' || status === 'preview' ? null : moveList,
      solo ? null : advanced
    ]
  })
}

// A game that is not played on a drawn board (Doom, Luanti, OpenTTD, Wesnoth) or that runs
// somewhere else (a server, a hosted table, another plugin's screen) still gets its own screen
// with a Back button, instead of a panel at the bottom of the library page.
function LaunchPanel({ game, view, board, send, ctx, onBack }) {
  const kind = game.kind || 'play'
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  const [hostAddr, setHostAddr] = useState('')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  // Same straggler guard as PlayTable: a setBusy(true) scheduled before this
  // panel mounted can land on the fresh mount and never be cleared.
  useEffect(() => { setBusy(false) }, [])
  const run = async line => {
    if (busy) return false
    setBusy(true)
    setFailure('')
    try {
      const answer = await send(line)
      if (answer && answer.ok === false) throw new Error(answer.text || 'That did not reach the game.')
      if (alive.current) setNotice((answer && answer.text) || '')
      return true
    } catch (error) {
      if (alive.current) setFailure(error.message || 'That did not reach the game.')
      return false
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const pictured = (board && board.picture) || startingPicture(game.id)
  const worlds = (game.worlds && game.worlds.length) ? game.worlds : [{ title: game.title, where: game.where, join: game.join }]
  const where = worlds.length ? (worlds[0].where || (worlds[0].join ? `${worlds[0].join.host}:${worlds[0].join.port}` : '')) : ''
  return jsxs('div', {
    className: 'games-play-table',
    style: { display: 'flex', flexDirection: 'column', gap: 12, padding: 18, paddingBottom: 96, minWidth: 0, minHeight: 0, overflow: 'auto', background: paper, height: '100%' },
    children: [
      jsxs('div', {
        // Same pin as the play table: Back stays on screen and clickable even after the
        // page scrolls to reach More options at the bottom.
        style: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', position: 'sticky', top: 0, zIndex: 5, background: paper },
        children: [
          jsxs('div', { style: { display: 'flex', gap: 12, alignItems: 'center', minWidth: 0 }, children: [
            button('Back', () => { alive.current = false; onBack() }),
            jsx(LearnButton, { game, ctx, disabled: false }),
            jsxs('div', { children: [
              jsx('div', { style: { fontWeight: 700, fontSize: 20 }, children: game.title }),
              game.subtitle ? jsx('div', { style: { fontSize: 12, fontStyle: 'italic', color: text.secondary }, children: game.subtitle }) : null
            ] })
          ] }),
          kind === 'external'
            ? button('Open', () => host.navigate(game.desktop_route), { primary: true, disabled: Boolean(game.error) || !game.desktop_route })
            : kind === 'play'
              ? button(busy ? 'Starting…' : 'Play', () => run(`${game.id} play`), { primary: true, disabled: busy })
              : kind === 'server'
                ? button('Join world', () => copyText(where, setNotice), { primary: true, disabled: !where })
                : button('I am hosting', () => { if (hostAddr.trim()) run(`host ${game.id} ${hostAddr.trim()}`) }, { primary: true, disabled: busy || !hostAddr.trim() || !view.player.named })
        ]
      }),
      jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 760 }, children: [
        pictured ? jsx(pictured && pictured.view === 'backgammon' ? BackgammonSvg : BoardSvg, { picture: pictured, height: pictured.view === 'gomoku' ? 420 : pictured.view === 'kalah' ? 200 : pictured.view === 'hex' ? 360 : 320 }) : worldScene(game.id, 640, 220),
        jsx('div', { style: { fontSize: 14, color: text.secondary }, children: game.summary }),
        game.error ? jsx('div', { role: 'alert', style: { fontSize: 13, border: `1px solid ${accent}`, borderRadius: 8, padding: '8px 10px' }, children: game.error }) : null,
        notice ? jsx('div', { role: 'status', style: { fontSize: 13, color: text.secondary }, children: notice }) : null,
        failure ? jsx('div', { role: 'alert', style: { fontSize: 13, color: '#d76b65' }, children: failure }) : null
      ] }),
      jsxs('details', {
        className: 'games-advanced',
        style: { border: `1px solid ${stroke}`, borderRadius: 12, background: card, padding: '8px 12px' },
        children: [
          jsx('summary', { style: { cursor: 'pointer', fontSize: 12, color: text.secondary, fontWeight: 650 }, children: 'More options' }),
          jsxs('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', paddingTop: 10 }, children: [
            kind === 'server' && game.wake ? button('Start', () => run(`${game.id} start`), { disabled: busy }) : null,
            kind === 'server' && game.wake ? button('Stop', () => run(`${game.id} stop`), { disabled: busy }) : null,
            kind === 'server' ? jsx('span', { style: { fontSize: 12, color: text.tertiary }, children: where ? `Server ${where}` : 'No server address yet.' }) : null,
            kind === 'listen' ? field(hostAddr, setHostAddr, 'host:port you are hosting', () => { if (hostAddr.trim()) run(`host ${game.id} ${hostAddr.trim()}`) }) : null,
            button('Remove from library', () => run(`remove ${game.id}`), { disabled: busy, title: 'The game stays in the store; only this library card goes.' }),
            kind === 'play' && game.id === ARENA_ID ? null : null
          ] })
        ]
      })
    ]
  })
}
