// ---- 65-wait-pane.js: the pane itself, and the status-bar badge that opens it

// FUTURE(2026-11-11): the bot ladder on the pane — remove if never built.
// Rated bot-versus-bot works server-side, but it is not proven end to end and a person in the pane
// has no way to follow it (the model calls happen on this computer, the game on the lobby server).
// It belongs with Champions. The section below is kept whole; this one line is what keeps it off
// the pane, so bringing it back is flipping a boolean rather than rebuilding it.
const PANE_LADDER_OFF = true
// FUTURE(2026-11-11): Bots & leagues on the pane — remove if never built.
// Leagues, watching a live table and bot passports all work against the lobby server, but watching
// leaves Hermes for the browser and the pane is not where a league belongs. The block is kept
// whole; this line hides it on the pane (it is the only surface that mounts it).
const PANE_LEAGUES_OFF = true
// FUTURE(2026-11-11): the online-alert checkbox on the pane — remove if never built.
// "Tell me when someone online wants this game" saves its flag, but the system notification it
// promises returns immediately, so the switch would promise an alert nothing raises. Kept whole;
// this line hides it.
const PANE_ONLINE_ALERT_OFF = true

function WaitPane({ ctx }) {
  const saved = useRef(savedPaneGame(ctx))
  const [view, setView] = useState(null)
  const [gameId, setGameId] = useState(saved.current)
  const [board, setBoard] = useState({ text: '', picture: null })
  const [reply, setReply] = useState('')
  const [problem, setProblem] = useState('')
  const [tab, setTab] = useState('game')
  // JACKPOT v2 in the pane. It is not a server game (no /board), so it is its own view rather than a
  // tile in the curated picker; the machine reads the same wallet through the same routes.
  const [jackpot, setJackpot] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [chat, setChat] = useState('')
  const [name, setName] = useState('')
  const [alerts, setAlerts] = useState(() => paneAlerts(ctx))
  const [restarting, setRestarting] = useState(false)
  // Start over / new game: NOTHING is chosen until the person chooses.
  // '' means neither radio, which is also what keeps Start disabled: no game is ever dealt against
  // an opponent the person did not name.
  const [dealWho, setDealWho] = useState('')
  // The route the person picked in the shared ModelPicker, and the routes this Hermes has (read
  // when the model choice is first opened, never on a pane that does not touch it).
  const [dealModel, setDealModel] = useState('')
  const [modelRoutes, setModelRoutes] = useState([])
  const [onlineBusy, setOnlineBusy] = useState(false)
  const [onlineNote, setOnlineNote] = useState('')
  const [onlineProblem, setOnlineProblem] = useState('')
  const [keyToCopy, setKeyToCopy] = useState('')
  const [onlineName, setOnlineName] = useState('')
  const [onlineKey, setOnlineKey] = useState('')
  const [ladderAsk, setLadderAsk] = useState(null)
  const [ladderChampion, setLadderChampion] = useState('')
  // "Play here": the room of a match the lobby handed over, played in this pane on the server
  // table rather than in a browser. Empty means the pane is on its own quick games.
  const [onlineRoom, setOnlineRoom] = useState('')
  const [playingHere, setPlayingHere] = useState(false)
  // Out of the way: 'open' | 'min' | 'closed', remembered for the session.
  const [chrome, setChrome] = useState(paneChromePref)
  const [level, setLevel] = useState(QUICK_LEVEL)
  // The move the person has just made, drawn at once (12-board-input.js pendingCells).
  // A model or a search takes its time to answer, and the person's own move must land
  // the moment they make it, never after the answer.
  const [preview, setPreview] = useState(null)
  const [boardH, setBoardH] = useState(300)
  // Backgammon's dice have a state of their own (waiting behind Roll, tumbling, spent) that the
  // picture cannot carry: the board reports it and the one status line below says it.
  const [bgPhase, setBgPhase] = useState('move')
  // Settings, in the pane: the very same rows the Games app shows, from the same component, so the
  // two can never drift. The skin is the page's own hook, so the Look switch here writes the same
  // storage key and nothing new is invented.
  const [settings, setSettings] = useState(false)
  const [skin, setSkin] = useSkin(ctx)
  const rootBox = useRef(null)
  const confirmBox = useRef(null)
  const ladderBox = useRef(null)
  const boardBox = useRef(null)
  const toldOnline = useRef(0)
  const latest = useRef({ game: saved.current, board: null })
  const alive = useRef(true)
  // Every load takes a number. A slow answer for game A that arrives after the
  // person moved to game B is dropped instead of painting A's board under B.
  const generation = useRef(0)
  const busy = useChatBusy()
  const finished = useHermesFinished(busy)
  const approval = useApprovalNotice()

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // The status bar and the palette can restore the pane from anywhere; when they
  // do, this instance follows the session pref instead of its stale state.
  useEffect(() => {
    const sync = () => setChrome(paneChromePref())
    window.addEventListener(PANE_CHROME_EVENT, sync)
    return () => window.removeEventListener(PANE_CHROME_EVENT, sync)
  }, [])

  const collapse = useCallback(() => {
    setChrome('closed')
    closeWaitPane()
  }, [])
  usePaneEscape(rootBox, collapse)
  useOutsideDone(Boolean(restarting), confirmBox, () => setRestarting(false))
  useOutsideDone(Boolean(ladderAsk), ladderBox, () => setLadderAsk(null))

  // Boards scale with the pane: the same BoardSvg, sized to the width it gets.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !boardBox.current) return undefined
    const meter = new ResizeObserver(entries => {
      const width = entries && entries[0] && entries[0].contentRect ? entries[0].contentRect.width : 0
      if (width > 120) setBoardH(Math.max(200, Math.min(460, Math.round(width * 0.92))))
    })
    meter.observe(boardBox.current)
    return () => meter.disconnect()
  }, [])

  const widen = () => {
    setChrome('open')
    restoreWaitPane()
  }

  // A game whose board keeps failing is set aside for a minute so the pane moves on to
  // another game instead of retrying the broken one forever.
  const boardMisses = useRef({ game: '', count: 0 })
  const setAside = useRef(new Map())

  // The last board is never left on screen across a game switch or a new deal, and a
  // move drawn ahead of its answer must not outlive the answer either.
  const clearBoard = () => {
    setPreview(null)
    setBoard({ text: '', picture: null })
  }

  const load = useCallback(async (id, known) => {
    const wanted = id === undefined ? latest.current.game : id
    // Only a game the person picked (or a new deal) makes the reads already on their way stale. A
    // plain poll repeats the same intent, so it must not invalidate the read that is already in
    // flight: bumping the generation on every poll made the pane blind whenever /view took longer
    // than the one-second poll — each response was superseded before it landed, so the picker sat on
    // "No curated games are installed here." for seconds after opening.
    // The Games page's own refresh already has this shape: its selection generation moves on a pick.
    const mine = id === undefined ? generation.current : generation.current + 1
    generation.current = mine
    try {
      const next = await ctx.rest('/view')
      if (!alive.current || generation.current !== mine) return
      setView(next)
      setError('')
      const now = Date.now()
      setAside.current.forEach((until, game) => { if (until <= now) setAside.current.delete(game) })
      const usable = { ...next, play: ((next && next.play) || []).filter(item => !setAside.current.has(item.id)) }
      const chosen = paneGame(usable, wanted)
      if (!chosen) {
        latest.current = { game: '', board: null }
        if (alive.current && generation.current === mine) setBoard({ text: '', picture: null })
        return
      }
      let shown
      // A caller that already holds the board for this game (a move's own reply carries
      // one) hands it over instead of reading it again: the answer is the authority, and
      // the second round trip only delayed the paint.
      if (known && known.game === chosen) {
        shown = { text: '', picture: known }
      } else {
        try {
          shown = await ctx.rest(`/board?game=${encodeURIComponent(chosen)}`)
        } catch (failure) {
          if (!alive.current || generation.current !== mine) return
          const misses = boardMisses.current.game === chosen ? boardMisses.current.count + 1 : 1
          boardMisses.current = { game: chosen, count: misses }
          if (misses >= 2) {
            setAside.current.set(chosen, Date.now() + 60000)
            boardMisses.current = { game: '', count: 0 }
            latest.current = { game: '', board: null }
            paneWatch.game = ''
            storeValue(ctx, PANE_GAME_KEY, '')
            setBoard({ text: '', picture: null })
            setError(`${chosen} could not load, so the pane moved to another game. It will try ${chosen} again in a minute.`)
          }
          return
        }
      }
      if (!alive.current || generation.current !== mine) return
      boardMisses.current = { game: '', count: 0 }
      latest.current = { game: chosen, board: shown.picture || null }
      paneWatch.game = chosen
      rememberPaneGame(ctx, chosen)
      setGameId(chosen)
      setPreview(null)
      setBoard({ text: shown.text || '', picture: shown.picture || null })
    } catch {
      if (alive.current && generation.current === mine) {
        setError('The pane cannot reach Game Center yet. It tries again every few seconds.')
      }
    }
  }, [ctx])

  useEffect(() => {
    load()
    // The waiting pane is watched, not glanced at: a three-second poll is why the machine in it
    // moved a beat behind the person. It now reads every second, and the board itself only when the
    // game changed or three seconds have passed, so the extra reads stay cheap.
    const timer = setInterval(() => load(), 1000)
    return () => clearInterval(timer)
  }, [load])

  // A message being sent spins the machine: ask straight away instead of waiting for the next tick.
  useEffect(() => {
    if (!SDK_HOST || typeof SDK_HOST.onEvent !== 'function') return undefined
    let stop = () => {}
    try {
      stop = SDK_HOST.onEvent('message.start', () => load()) || stop
    } catch {
      // An older host has no event stream; the one-second poll still catches the spin.
    }
    return () => { try { stop() } catch { /* nothing to unwire */ } }
  }, [load])

  // An online alert, told once, never while a table of the person's own is
  // running or waiting: that gets the match line, not a notification.
  useEffect(() => {
    const fresh = view && view.online && view.online.alert
    if (!fresh || !fresh.at || Number(fresh.at) <= toldOnline.current) return
    const pictured = latest.current.board
    if (pictured && pictured.status === 'active') return
    if (view.online && view.online.match) return
    toldOnline.current = Number(fresh.at)
    notifyOnline(ctx, fresh)
  }, [view, ctx])

  const say = useCallback(async line => {
    try {
      const answer = await ctx.rest('/command', { method: 'POST', body: { line } })
      if (alive.current) {
        setReply(answer && answer.text || '')
        setProblem(answer && answer.ok === false ? (answer.text || 'That did not work.') : '')
      }
      return answer || {}
    } catch {
      if (alive.current) {
        setReply('')
        setProblem('That did not reach Game Center. Try again.')
      }
      return { ok: false }
    }
  }, [ctx])

  // One door for every online action: the answer carries the new online view, so
  // the page paints the server's own answer instead of guessing at it.
  const onlineCall = useCallback(async (path, body, method) => {
    setOnlineBusy(true)
    setOnlineProblem('')
    try {
      const options = body === undefined ? { method: method || 'POST' } : { method: 'POST', body }
      const answer = await ctx.rest(path, options)
      if (!alive.current) return {}
      if (answer && answer.online) {
        setView(current => ({ ...(current || {}), online: answer.online }))
      }
      if (answer && answer.key_to_copy) setKeyToCopy(String(answer.key_to_copy))
      setOnlineNote((answer && answer.text) || '')
      if (answer && answer.ok === false) setOnlineProblem(String(answer.text || 'That did not work.'))
      return answer || {}
    } catch {
      if (alive.current) setOnlineProblem('That did not reach Game Center. Try again.')
      return { ok: false }
    } finally {
      if (alive.current) setOnlineBusy(false)
    }
  }, [ctx])

  // "Play here": open the room on the lobby server, then play it in this pane. It is the same
  // server match the browser would show — the person just does not have to leave Hermes for it.
  const playHere = useCallback(async match => {
    if (playingHere) return
    setPlayingHere(true)
    setOnlineProblem('')
    try {
      const answer = await openOnlineTable(ctx, match && match.room_id, match && match.game)
      if (answer && answer.ok === false) {
        if (alive.current) setOnlineProblem(String(answer.text || 'That table would not open.'))
        return
      }
      if (alive.current) setOnlineRoom(String((match && match.room_id) || ''))
    } finally {
      if (alive.current) setPlayingHere(false)
    }
  }, [ctx, playingHere])

  const showLadderAsk = useCallback(async () => {
    const chosen = latest.current.game
    if (!chosen) return
    setOnlineBusy(true)
    setOnlineProblem('')
    try {
      const answer = await ctx.rest(`/online/ladder?game=${encodeURIComponent(chosen)}`)
      if (alive.current) setLadderAsk(answer || null)
    } catch {
      if (alive.current) setOnlineProblem('The ladder cannot be reached right now.')
    } finally {
      if (alive.current) setOnlineBusy(false)
    }
  }, [ctx])

  const start = async (id, who, atLevel = level) => {
    if (!id || working) return
    setWorking(true)
    setReply('')
    setRestarting(false)
    // The old board must not stay pressable under the new game's name while its own
    // board is on the way.
    clearBoard()
    try {
      const answer = await say(quickGameLine(id, who, atLevel))
      if (answer.ok === false) return
      latest.current = { game: id, board: null }
      paneWatch.game = id
      setGameId(id)
      rememberPaneGame(ctx, id)
      setTab('game')
      await load(id)
    } finally {
      if (alive.current) setWorking(false)
    }
  }

  const move = async (id, token) => {
    // Only the board that is on screen may be played, and only for the game it belongs to.
    if (!id || working || id !== latest.current.game) return
    setWorking(true)
    try {
      const pictured = latest.current.board
      const needsNew = !pictured || pictured.preview || pictured.status === 'idle' || pictured.status === 'abandoned'
      if (needsNew) {
        const started = await say(quickGameLine(id, 'computer', level))
        if (started.ok === false) return
      }
      const answer = await say(`${id} move ${token}`)
      if (answer.ok === false) return
      // The move line's own answer carries the board it left behind - the person's move
      // and the computer's answer - so the paint happens here, the moment it arrives,
      // instead of waiting for the read below.
      if (answer.picture) {
        latest.current = { game: id, board: answer.picture }
        paneWatch.game = id
        setBoard({ text: answer.text || '', picture: answer.picture })
      }
      await load(id, answer.picture || null)
    } finally {
      if (alive.current) { setWorking(false); setPreview(null) }
    }
  }

  // Starting over while a game is active: resign it, then deal a new one against the
  // chosen opponent. Two presses, never a surprise. A house table (Blackjack) never
  // "finishes", so this is also how its opponent is changed.
  const restart = async (id, who = 'computer') => {
    if (!id || working) return
    setRestarting(false)
    setWorking(true)
    setReply('')
    try {
      // The resign is best effort: it ends a game in progress, and says there is nothing to end
      // when the table is fresh. Either way the deal below answers, and its refusal is what the
      // person is shown. Bailing out of the resign used to leave the press doing nothing at all.
      await say(`${id} resign`)
      const started = await say(quickGameLine(id, who, level))
      if (started.ok === false) return
      latest.current = { game: id, board: null }
      paneWatch.game = id
      rememberPaneGame(ctx, id)
      clearBoard()
      await load(id)
    } finally {
      if (alive.current) setWorking(false)
    }
  }

  const chooseGame = async id => {
    if (!id) return
    setRestarting(false)
    // Picking a table puts the cabinet away: one surface at a time in a pane this narrow.
    setJackpot(false)
    latest.current = { game: id, board: null }
    paneWatch.game = id
    setGameId(id)
    rememberPaneGame(ctx, id)
    setReply('')
    // The previous game's board is not this game's board: clear it before the new one
    // arrives, so no press on it can be sent to the game the picker just chose.
    clearBoard()
    await load(id)
  }

  const saveAlerts = next => {
    setAlerts(next)
    storeValue(ctx, PANE_ALERTS_KEY, next)
  }

  const toggleAlert = id => saveAlerts({ ...alerts, games: { ...alerts.games, [id]: !alerts.games[id] } })
  const togglePaused = () => saveAlerts({ ...alerts, paused: !alerts.paused })

  const games = paneGames(view)
  const game = games.find(item => item.id === gameId) || games[0] || null
  const soloGame = Boolean(game && game.solo)
  const current = game ? game.id : ''
  const pictured = board.picture || (board.text ? null : game ? startingPicture(game.id) : null)
  const access = pictured ? tableAccess(pictured, view) : { can_move: false }
  const playingNow = Boolean(pictured && pictured.status === 'active')
  // A table whose other seat can be a machine: every board game, and a solo table that
  // seats one (Blackjack's dealer). Slots seats nobody, so it offers no opponent at all.
  const seatsNobody = gameSeatsNobody(game, pictured)
  const aiSeats = Boolean(!seatsNobody && (!soloGame || (game && game.bots !== false)))
  // The wait line under the board, and its clock: the pane names whose move it is, with the
  // seconds running, from the moment the wait begins.
  const paneWait = pictured && pictured.status === 'active' ? waitWords(pictured, view, { working }) : ''
  const waited = useWaitSeconds(Boolean(paneWait))
  // "Start over" / "New game": ONE door, and the opponent is chosen inside it - never assumed.
  // The dialog opens with nothing picked and Start disabled, so no game
  // is ever dealt against an opponent the person did not name, and the words always match the pick.
  const playedNow = Number((latest.current.board || {}).plies || 0) > 0
  // Whether a deal ends something here: a board game in play, or a solo session with hands behind
  // it. Only then does the confirm resign first; a fresh table is a single press (the server's rule).
  const endsSomething = soloGame ? playedNow : playingNow
  // Whether this pane has read this game's board from the shelf at all. Until it has, nothing on
  // screen can say a game is in play - and the shelf can still hold one, so a plain deal would be
  // refused and the press would look like it did nothing. A picture from the shelf carries a
  // schema_version; the starting picture drawn before the first read does not.
  const boardRead = Boolean(board.picture && board.picture.schema_version)
  const dealEndsFirst = endsSomething || !boardRead
  const dealWords = who => (who === 'agent' ? 'your Hermes model' : 'the computer')
  const dealLine = () => {
    const against = dealWho ? ` against ${dealWords(dealWho)}` : ''
    if (soloGame) return endsSomething
      ? `Starting over ends this session and deals a new one${against}.`
      : `A new session${against}. Chips already bet on a settled hand stay settled.`
    return endsSomething
      ? `Starting over resigns this game and deals a new one${against}.`
      : `A new game${against}.`
  }
  const openDeal = () => {
    if (!current || working) return
    setDealWho('')
    setReply('')
    setRestarting(true)
  }
  const deal = () => {
    if (!current || working || !dealWho) return
    const who = dealWho === 'agent' ? 'agent' : 'computer'
    setRestarting(false)
    setDealWho('')
    return dealEndsFirst ? restart(current, who) : start(current, who)
  }
  // The routes this Hermes may hand a seat, for the shared ModelPicker. It is read the first time
  // the model choice is opened: a pane that never touches it sends no request. A host without the
  // route leaves the picker with the one entry every seat has (this Hermes's own chat model).
  useEffect(() => {
    if (!restarting || dealWho !== 'agent' || modelRoutes.length) return undefined
    let live = true
    const load = async () => {
      try {
        const answer = await ctx.rest('/models')
        if (live && answer && answer.ok !== false && Array.isArray(answer.routes)) setModelRoutes(answer.routes)
      } catch (failure) {
        // Nothing to list: the seat's own model is still named in words above the picker.
      }
    }
    load()
    return () => { live = false }
  }, [restarting, dealWho, modelRoutes.length, ctx])
  const lobby = (view && view.lobby) || { lines: [], looking: [] }
  const myName = (view && view.player && view.player.name) || ''
  const found = current ? othersLooking(lobby, current, myName) : []

  // Out of the way beats everything else: a slim strip with one way back. The
  // polls above keep running quietly, so the dot still means your turn.
  if (chrome !== 'open') {
    const stripTurn = myTurn(latest.current.board, view)
    return jsx('div', {
      className: 'games-wait-pane-strip',
      style: { height: 34, display: 'flex', alignItems: 'center', background: paper, boxSizing: 'border-box' },
      children: jsx('button', {
        type: 'button',
        'aria-label': 'Games. Restore the play pane',
        title: 'Play while you code — restore the pane',
        onClick: widen,
        style: {
          display: 'flex', width: '100%', height: '100%', alignItems: 'center', gap: 8,
          padding: '0 12px', border: 'none', background: 'transparent',
          color: text.secondary, fontSize: 12, fontWeight: 650, cursor: 'pointer'
        },
        children: [
          jsx('span', { children: 'Games' }),
          stripTurn ? jsx('span', {
            'aria-hidden': true,
            'data-dot': 'turn',
            style: { width: 6, height: 6, borderRadius: '50%', background: accent, display: 'inline-block' }
          }) : null,
          jsx('span', { style: { fontWeight: 400, color: text.tertiary }, children: '— tap to reopen' })
        ]
      })
    })
  }

  if (error) {
    return jsx('div', { role: 'alert', style: { padding: 12, fontSize: 12, color: text.secondary }, children: error })
  }

  const iconTitles = {
    'Full screen': 'Open this game in Game Center full screen. The pane closes.',
    Minimize: 'Shrink to a strip. The badge keeps watching.',
    Close: 'Close the pane. The status item and the palette bring it back.',
    Settings: 'Game Center settings — the same ones as in the Games app. Press again to come back to the pane.'
  }
  const iconButton = (glyph, label, onClick) => jsx('button', {
    type: 'button',
    'aria-label': label,
    title: iconTitles[label] || label,
    onClick,
    style: {
      width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      border: 'none', background: 'transparent', color: text.tertiary,
      fontSize: 13, lineHeight: 1, cursor: 'pointer', borderRadius: 6, padding: 0
    },
    children: glyph
  })

  const header = jsxs('div', {
    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
    children: [
      jsx('div', { style: { fontWeight: 700, fontSize: 14 }, children: 'Play while you code' }),
      jsxs('div', { style: { display: 'flex', gap: 6, alignItems: 'center' }, children: [
        button('Game', () => { setSettings(false); setTab('game') }, { primary: tab === 'game' && !settings }),
        button('Lobby', () => { setSettings(false); setTab('lobby') }, { primary: tab === 'lobby' && !settings }),
        // What the person has earned, right here under the two tabs they use most.
        jsx(PointsChip, { ctx, style: { marginLeft: 2 } }),
        // One press in and out of Settings: the full screen's own Settings, in a pane too narrow for
        // the whole page.
        iconButton('⚙', 'Settings', () => setSettings(open => !open)),
        iconButton('⤢', 'Full screen', () => pageFromPane(ctx)),
        iconButton('–', 'Minimize', () => { setChrome('min'); minimizeWaitPane() }),
        iconButton('✕', 'Close', collapse)
      ] })
    ]
  })

  // The pane's Settings view: the Games app's own panel, with a way back welded to the pane. No new
  // storage keys, no second copy of the rows - whatever Settings gains, this gains with it.
  const settingsView = jsx('div', {
    'data-pane-settings': '1',
    style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' },
    // The panel is drawn from the same /view answer the pane already polls; before the first one
    // lands there is nothing to fill its rows from, so the pane says so rather than drawing blanks.
    children: view
      ? jsx(SettingsPanel, {
          view,
          ctx,
          skin,
          onSkin: setSkin,
          backLabel: 'Back to the play pane',
          backTitle: 'Back to the game in this pane',
          onSaved: () => load(),
          onBack: () => setSettings(false)
        })
      : jsx('div', {
          className: 'games-settings',
          style: { padding: 18, fontSize: 12, color: text.tertiary },
          children: 'Reading your settings…'
        })
  })

  // The strengths' names are the product's own words, whichever ids the server
  // uses; a level the server really has keeps its own name when it is unmapped.
  // A strength press SETS the strength and nothing else: it never deals a game and never
  // resigns one. The strength the next game is dealt at is the one
  // lit here, and the deal itself is the dialog's own Start.
  const serverLevels = ((((view || {}).opponents || []).find(item => item.id === 'computer') || {}).levels || [])
    .filter(item => item && item.id && item.label)
  const levelChoices = serverLevels.length
    ? serverLevels.map(item => ({ id: item.id, label: LEVEL_LABELS[item.id] || item.label }))
    : LEVEL_CHOICES
  const levelRow = jsxs('div', {
    'aria-label': 'Difficulty',
    style: { display: 'flex', gap: 6, flexWrap: 'wrap' },
    children: levelChoices.map(item => jsx('button', {
      type: 'button',
      'data-level': item.id,
      onClick: () => setLevel(item.id),
      disabled: working || !current || !(view && view.allow_ai),
      title: (view && view.allow_ai)
        ? `You vs the computer (${item.label}) in ${(game && game.title) || current}. Free and instant. This only sets the strength; press Start to deal.`
        : 'AI seats are off for this profile.',
      style: {
        padding: '4px 9px', borderRadius: 7, cursor: 'pointer', fontSize: 12, fontWeight: 600,
        border: `1px solid ${item.id === level ? accent : stroke}`,
        background: item.id === level ? fill : 'transparent',
        color: item.id === level ? text.primary : text.secondary
      },
      children: item.label
    }, item.id))
  })

  // How a quick game is dealt, in one plain sentence: the tiles pick the game, the one door
  // under the board picks the opponent, and the strength belongs to the computer choice.
  const quick = jsxs('section', {
    'aria-label': 'Quick game',
    style: { display: 'flex', flexDirection: 'column', gap: 6 },
    children: [
      heading('Quick game'),
      soloGame ? null : jsx('div', {
        style: { fontSize: 12, color: text.tertiary },
        children: `Pick the game, then press New game: the built-in computer plays ${sideWordsOf(pictured).black.toLowerCase()} and never uses your chat model, or your own Hermes model takes the seat.`
      })
    ]
  })

  // The model seat's own picker: the shared, searchable ModelPicker every model seat uses
  // (50-model-picker.js), so the search, the grouping and the keyboard behave the same here as in
  // Champions. It lists every route this Hermes has and marks the one this seat really plays; the
  // line above says which that is, and a pick that cannot take effect yet says so rather than
  // pretending (pinning a route to the seat is the next slice).
  const seatModel = String(((view || {}).opponent || {}).model || '')
  const seatRouteId = (() => {
    if (!seatModel) return MODEL_CHAT_ID
    const found = modelPickerRoutes(modelRoutes).find(item => item.model === seatModel)
    return found ? modelPickerKey(found) : ''
  })()
  const modelChoice = jsxs('div', {
    'data-deal-model': '1',
    style: { display: 'flex', flexDirection: 'column', gap: 6, border: `1px solid ${stroke}`, borderRadius: 8, padding: '8px 10px' },
    children: [
      jsx('div', {
        style: { fontSize: 11, color: text.tertiary, lineHeight: 1.45 },
        children: `This seat plays ${seatModel ? `${seatModel} — the model` : 'the model'} pinned in Hermes Settings → Models → "Game Shelf opponent".`
      }),
      jsx(ModelPicker, {
        routes: modelRoutes,
        current: dealModel || seatRouteId,
        ctx,
        hint: 'Type to filter by provider or model. Up and down move, Enter picks.',
        onPick: route => setDealModel(route && route.id ? String(route.id) : '')
      }),
      dealModel && dealModel !== seatRouteId
        ? jsx('div', {
            role: 'status', 'aria-live': 'polite',
            style: { fontSize: 11, color: text.secondary, lineHeight: 1.45 },
            children: `Picked ${dealModel}. This seat still plays ${seatModel || 'the model pinned in Hermes Settings'} until a pick here can be pinned to it.`
          })
        : null
    ]
  })

  // Tiles, not a drop-down: every game is one press, on screen, no menu.
  const rankOf = id => { const at = QUICK_GAMES.indexOf(id); return at === -1 ? 99 : at }
  const orderedGames = games.slice().sort((a, b) => rankOf(a.id) - rankOf(b.id))
  const picker = games.length
    ? jsx('div', {
        className: 'games-pane-games',
        role: 'group',
        'aria-label': 'Game',
        style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 },
        children: orderedGames.map(item => jsx('button', {
          type: 'button',
          'aria-pressed': item.id === 'slots' ? jackpot : item.id === current,
          'data-game-tile': item.id,
          title: `Play ${item.title || item.id} in this pane.`,
          // Slots goes to the dedicated pane-sized Jackpot view (its own frame and floor), never the
          // board slot - the same path the old separate Slots button took.
          onClick: () => (item.id === 'slots' ? openJackpot() : chooseGame(item.id)),
          disabled: working,
          style: {
            padding: '8px 10px', borderRadius: 8, cursor: 'pointer', textAlign: 'center', fontSize: 12, fontWeight: 600,
            border: `1px solid ${item.id === current ? accent : stroke}`,
            background: item.id === current ? fill : card,
            color: item.id === current ? text.primary : text.secondary
          },
          children: item.title || item.id
        }, item.id))
      })
    : jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: 'No curated games are installed here.' })

  const boardView = pictured
    ? jsxs('div', {
        'aria-label': 'Game board',
        ref: boardBox,
        style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, width: '100%' },
        children: [
          // Who is across the board, said above it. Blackjack
          // carries its own label on the felt; Slots has no opponent at all.
          pictured.view === 'blackjack' || pictured.view === 'slots' ? null : jsx(OpponentLine, { pictured, view, solo: soloGame }),
          pictured.view === 'slots' ? jsx(Jackpot2Full, { ctx }) : pictured.view === 'blackjack'
            ? jsx(BlackjackTable, {
                picture: pictured,
                against: opponentWords(pictured, view, soloGame),
                interactive: Boolean(current && access.can_move && !working),
                busy: working,
                onMove: token => move(current, token),
                onSetting: (path, body) => ctx.rest(path, { method: 'POST', body })
              })
          : pictured.view === 'seabattle'
            ? jsx(SeaBattleTable, {
                picture: pictured,
                interactive: Boolean(current && access.can_move && !working),
                busy: working,
                onMove: token => move(current, token)
              })
            : jsx(pictured && pictured.view === 'backgammon' ? BackgammonSvg : BoardSvg, {
                picture: pictured,
                height: boardH,
                flat: true,
                onPhase: setBgPhase,
                interactive: Boolean(current && access.can_move && !working),
                // The person's own move is drawn the moment they make it, while the
                // table's answer is still on its way: a search or a model takes its time,
                // and a board that sits still reads as a board that did not hear the click.
                pending: preview,
                onPending: mv => { if (access.can_move && !working) setPreview(mv) },
                onMove: token => move(current, token)
              }),
          pictured.view === 'slots' ? null : jsxs('div', {
            role: 'status', 'aria-live': 'polite', className: 'games-status',
            style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13, fontWeight: 650 },
            children: [
              // Whose move it is, with the seconds running while the other seat works, in the same
              // words the full table uses. On the person's own Backgammon
              // turn the board owns the words (roll, then spend the dice: 14b-backgammon-svg.js).
              jsx('span', {
                children: (pictured.view === 'backgammon' && myTurn(pictured, view)
                  ? backgammonTurnLine(pictured, true, bgPhase) : '') || paneStatus(pictured, view, { working, seconds: waited })
              }),
              working && !paneWait ? jsx('span', { style: { fontSize: 12, color: text.tertiary, fontWeight: 400 }, children: 'one moment…' }) : null
            ]
          })
        ]
      })
    : null

  // JACKPOT v2 in the pane: the same cabinet as the Games page and the over-chat copy. In the game
  // tab's board slot — the pane's Slots game — it is mounted with no frame of its own, so it measures
  // the element it is really in: the pane's own width and height decide the scale, never the window,
  // and the machine can land nowhere but inside its frame. JP2_PANE_MIN_HEIGHT is the floor for the
  // cabinet's own row below: 440 px tall puts it at 0.6 of its design size, and below that its small
  // text stops being readable, so a shorter pane scrolls (the pane root already does) rather than
  // clipping the machine.
  const JP2_PANE_MIN_HEIGHT = 440
  const openJackpot = () => {
    setJackpot(true)
    setRestarting(false)
    setReply('')
    setProblem('')
  }
  // Its own row, not a tile in the curated picker: that group is the turn-based tables served by
  // /board, and the cabinet is not one of them.
  const jackpotRow = jsx('div', {
    'aria-label': 'Jackpot cabinet',
    style: { display: 'flex', gap: 6, flexWrap: 'wrap' },
    children: jsx('button', {
      type: 'button',
      'data-jp2': 'pane-tile',
      'data-game-tile': 'slots',
      'aria-pressed': jackpot,
      title: 'Play Slots in this pane. Same wallet as the tables, no model spend.',
      onClick: openJackpot,
      disabled: working,
      style: {
        padding: '8px 10px', borderRadius: 8, cursor: working ? 'default' : 'pointer', fontSize: 12, fontWeight: 600,
        border: `1px solid ${jackpot ? accent : stroke}`,
        background: jackpot ? fill : card,
        color: jackpot ? text.primary : text.secondary
      },
      children: 'Slots'
    }, JP2L_ID)
  })

  const jackpotView = jsxs('div', {
    'data-jp2': 'pane',
    style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, width: '100%', flex: '1 1 auto', minHeight: 0 },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
        children: [
          jsx('div', { style: { fontWeight: 650, fontSize: 13 }, children: 'Jackpot' }),
          button('Back to games', () => setJackpot(false), { title: 'Back to this pane’s game list.' })
        ]
      }),
      jsxs('div', {
        'data-jp2': 'pane-frame',
        style: {
          position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: '100%', flex: '1 1 auto', minHeight: JP2_PANE_MIN_HEIGHT, minWidth: 0, overflow: 'hidden'
        },
        children: jsx(JackpotMachine, { ctx, mode: 'full' })
      })
    ]
  })

  const gameTab = jsxs('div', {
    // While the cabinet is up it takes the pane to itself: a ~400 px column with the game list above it
    // pushed the machine's bottom below the fold, and "scroll down to see it" is not "nothing clipped".
    // The list comes back with the Back control, exactly as the Games page swaps its column for the
    // full view.
    style: {
      display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0,
      ...(jackpot ? { flex: '1 1 auto', minHeight: 0 } : {})
    },
    children: jackpot ? [jackpotView] : [
      soloGame ? null : quick,
      picker,
      // The separate Slots button only when the grid has no Slots tile (a server list without it), so
      // the Jackpot cabinet is always one press away and never shown twice.
      games.some(item => item.id === 'slots') ? null : jackpotRow,
      // Who takes the other seat, on one row: ONE door, and the choice is made inside it. The
      // dialog opens with NOTHING picked, so a game is never dealt against an opponent the person
      // did not name - and the words match the pick, never "the computer" for a model game.
      // A solo table that seats a machine gets the same door
      // (Blackjack's dealer); a table that seats nobody (Slots) gets neither.
      aiSeats ? jsxs('div', {
              'data-pane-opponents': '1',
              style: { display: 'flex', gap: 6, flexWrap: 'wrap' },
              children: [
                restarting
                  ? jsxs('div', {
                      role: 'alertdialog', 'aria-label': endsSomething ? 'Start over' : 'New game',
                      ref: confirmBox,
                      style: { display: 'flex', flexDirection: 'column', gap: 8, border: `1px solid ${accent}`, borderRadius: 8, padding: '8px 10px', fontSize: 12 },
                      children: [
                        jsx('div', { children: dealLine() }),
                        jsxs('div', {
                          role: 'radiogroup', 'aria-label': 'Who plays the other side',
                          style: { display: 'flex', flexDirection: 'column', gap: 6 },
                          children: [
                            dealChoiceElement('computer', 'Computer', 'The built-in player. Free, instant, and it never uses your chat model.', dealWho === 'computer', setDealWho),
                            dealChoiceElement('agent', 'Your Hermes model', 'Your own model plays one move per turn, one call each.', dealWho === 'agent', setDealWho)
                          ]
                        }),
                        dealWho === 'computer' ? levelRow : null,
                        dealWho === 'agent' ? modelChoice : null,
                        jsxs('div', { style: { display: 'flex', gap: 6 }, children: [
                          button('Start', deal, {
                            primary: true,
                            disabled: working || !dealWho,
                            title: dealWho
                              ? `Deal a game against ${dealWords(dealWho)} in ${(game && game.title) || current}.`
                              : 'Pick who plays the other side first.'
                          }),
                          button('Cancel', () => { setRestarting(false); setDealWho('') }, {
                            title: endsSomething ? 'Keep this game exactly as it is.' : 'Leave the table as it is.'
                          })
                        ] })
                      ]
                    })
                  : button(endsSomething ? 'Start over' : 'New game', openDeal, {
                      disabled: working || !current,
                      title: `Choose who plays ${(game && game.title) || current} with you: the built-in computer, or your own Hermes model.`
                    })
              ]
            })
        : null,
      boardView,
      ALERTS_OFF ? null : jsxs('details', {
        className: 'games-pane-alerts',
        style: { border: `1px solid ${stroke}`, borderRadius: 8, padding: '6px 10px' },
        children: [
          jsx('summary', { style: { cursor: 'pointer', fontSize: 12, color: text.secondary, fontWeight: 650 }, children: 'Alerts' }),
          jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 8, fontSize: 12, color: text.secondary }, children: [
            jsxs('label', { style: { display: 'flex', gap: 8, alignItems: 'center' }, children: [
              jsx('input', { type: 'checkbox', checked: Boolean(alerts.games[current]), onChange: () => toggleAlert(current), disabled: !current }),
              jsx('span', { children: 'Tell me when it is my turn (system notification, off by default)' })
            ] }),
            jsxs('label', { style: { display: 'flex', gap: 8, alignItems: 'center' }, children: [
              jsx('input', { type: 'checkbox', checked: Boolean(alerts.paused), onChange: togglePaused }),
              jsx('span', { children: 'Pause every alert' })
            ] }),
            jsx('div', { style: { fontSize: 11, color: text.tertiary }, children: 'No sound. The badge on the Games item always shows your turn, and the system notification only appears while Hermes is in the background.' })
          ] })
        ]
      })
    ]
  })

  // The online source, under the local lobby. Both are behind the same two
  // buttons (Find a match, Stop looking); this one only appears once the person
  // has turned it on, and every action is one of the /online doors.
  const online = onlineView(view)
  const title = (game && game.title) || current || ''
  const ladderStatus = online.ladder || {}
  const ladderRunning = ['starting', 'waiting', 'playing'].includes(String(ladderStatus.state || ''))
  const ladderEstimate = ladderAsk && ladderAsk.estimate ? ladderAsk.estimate : null
  const ladderReady = Boolean(ladderAsk && ladderAsk.model_ready)
  const champions = (ladderAsk && ladderAsk.champions) || []
  const onlineOffline = online.offline && online.on
  const onlineAlert = (view && view.online && view.online.alert) || null

  const onlineSection = jsxs('section', {
    'aria-label': 'Online play',
    style: { display: 'flex', flexDirection: 'column', gap: 6, border: `1px solid ${stroke}`, borderRadius: 8, padding: '8px 10px' },
    children: [
      jsx('div', { style: { fontWeight: 650, fontSize: 13 }, children: 'Play with people online' }),
      jsx('div', { style: { fontSize: 12, color: onlineOffline ? text.tertiary : text.secondary }, children: onlineLine(online, title) }),
      !online.on ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 }, children: [
        jsx('div', {
          style: { fontSize: 11, color: text.tertiary, lineHeight: 1.45, border: `1px solid ${stroke}`, borderRadius: 6, padding: '6px 8px' },
          children: online.disclosure || `Online play talks to ${online.url} and nothing else.`
        }),
        jsxs('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' }, children: [
          button('Turn on online play', () => onlineCall('/online/on'), { primary: true, disabled: onlineBusy }),
          button('Not now', () => setOnlineNote('Online stays off. Everything here still plays on this computer.'), { disabled: onlineBusy })
        ] })
      ] }) : null,
      online.on && !online.linked ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 }, children: [
        jsx('div', { style: { fontSize: 12, color: text.secondary }, children: `Games with other people happen on ${onlineHost(online.url)}. Pick the name you will be known by there.` }),
        jsxs('div', { style: { display: 'flex', gap: 6 }, children: [
          field(onlineName, setOnlineName, 'Your name online', () => onlineCall('/online/signup', { name: onlineName.trim() })),
          button('Create my player', () => onlineCall('/online/signup', { name: onlineName.trim() }), { primary: true, disabled: onlineBusy || !onlineName.trim() })
        ] }),
        jsxs('div', { style: { display: 'flex', gap: 6 }, children: [
          field(onlineKey, setOnlineKey, 'Recovery key you saved', () => onlineCall('/online/signin', { name: onlineName.trim(), key: onlineKey.trim() })),
          button('I have a key', () => onlineCall('/online/signin', { name: onlineName.trim(), key: onlineKey.trim() }), { disabled: onlineBusy || !onlineName.trim() || !onlineKey.trim() })
        ] }),
      ] }) : null,
      keyToCopy ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 }, children: [
        jsx('div', { style: { fontSize: 11, color: text.tertiary }, children: 'This is your recovery key. It is shown once, and it is what signs you in on another computer. It is kept with your other Hermes credentials.' }),
        jsx('div', { style: { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12, overflowWrap: 'anywhere' }, children: keyToCopy }),
        jsxs('div', { style: { display: 'flex', gap: 8, alignItems: 'center' }, children: [
          button('Copy recovery key', () => copyText(keyToCopy, setOnlineNote), { primary: true }),
          textLink('Hide this key', () => setKeyToCopy(''))
        ] })
      ] }) : null,
      online.on && online.linked ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 }, children: [
        jsxs('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: text.secondary }, children: [
          jsx('span', { children: `You are ${online.name} online.` }),
          textLink('Sign out here', () => onlineCall('/online/forget'))
        ] }),
        onlineAlert ? jsx('div', {
          role: 'status', 'aria-live': 'polite',
          style: { fontSize: 12, border: `1px solid ${accent}`, borderRadius: 8, padding: '6px 10px' },
          children: onlineAlert.text || 'Someone online wants this game.'
        }) : null,
        online.match ? jsxs('div', {
          role: 'status', 'aria-live': 'polite',
          style: { display: 'flex', flexDirection: 'column', gap: 6, border: `1px solid ${accent}`, borderRadius: 8, padding: '6px 10px', fontSize: 12 },
          children: [
            jsx('div', { children: `Your table is ready: ${online.match.opponent || 'someone'} for ${online.match.title || online.match.game}. ${online.match.side ? `You play ${online.match.side}.` : ''}` }),
            jsxs('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }, children: [
              // The table, played right here on the same server match the browser would show.
              button('Play here', () => playHere(online.match), {
                primary: true,
                disabled: onlineBusy || playingHere || !online.match.room_id,
                title: 'Play this match in the pane, with the board and the moves on the lobby server. Hermes does not run it.'
              }),
              button('Not now', () => onlineCall('/online/match/close'), { disabled: onlineBusy })
            ] }),
            jsx('div', { style: { fontSize: 11, color: text.tertiary }, children: 'Live tables are held by the lobby server; press Play here to play this one inside Hermes.' })
          ]
        }) : jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 }, children: [
          jsxs('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' }, children: [
            online.game
              ? button('Stop looking online', () => onlineCall('/online/queue/stop'), { disabled: onlineBusy })
              : button(`Find a match online${title ? `: ${title}` : ''}`, () => onlineCall('/online/queue', { game: current }), { primary: true, disabled: onlineBusy || !current })
          ] }),
          online.waitingNames.length
            ? jsx('div', { style: { fontSize: 11, color: text.tertiary }, children: `Waiting for this game now: ${online.waitingNames.join(', ')}.` })
            : null,
          // FUTURE(2026-11-11): the online-alert checkbox — remove if never built.
          // "Tell me when someone online wants this game" writes its flag, but the system
          // notification behind it returns immediately, so the switch would promise an alert
          // nothing raises. The row is kept below the gate; PANE_ONLINE_ALERT_OFF hides it.
          PANE_ONLINE_ALERT_OFF ? null : jsxs('label', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: text.secondary }, children: [
            jsx('input', {
              type: 'checkbox',
              checked: Boolean(current && online.alerts[current]),
              disabled: !current || onlineBusy,
              onChange: event => onlineCall('/online/alerts', { game: current, enabled: event.target.checked })
            }),
            jsx('span', { children: 'Tell me when someone online wants this game (at most once every ten minutes, never during a match)' })
          ] })
        ] })
      ] }) : null,
      // Whoever turned it on can turn it off, signed in or not: an unlinked person
      // must not be stuck with online play on.
      online.on ? jsx('div', { style: { display: 'flex', marginTop: 6 }, children: textLink('Turn online play off', () => onlineCall('/online/off')) }) : null
    ]
  })

  const ladderSection = jsxs('section', {
    'aria-label': 'Bot ladder',
    style: { display: 'flex', flexDirection: 'column', gap: 6, border: `1px solid ${stroke}`, borderRadius: 8, padding: '8px 10px' },
    children: [
      jsx('div', { style: { fontWeight: 650, fontSize: 13 }, children: 'Bot ladder' }),
      !online.on || !online.linked
        ? jsx('div', { style: { fontSize: 12, color: text.secondary }, children: 'Turn on online play and choose a name first. Your champion then plays rated games against other people\'s bots.' })
        : jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 }, children: [
          jsx('div', { style: { fontSize: 12, color: text.secondary }, children: 'Your champion or agent can climb the bot ladder. Its model runs on this computer, and only the move it picks is sent.' }),
          ladderRunning ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 }, children: [
            jsx('div', { role: 'status', 'aria-live': 'polite', style: { fontSize: 12 }, children: ladderLine(ladderStatus) }),
            jsx('div', { style: { display: 'flex' }, children: button('Stop the ladder game', () => onlineCall('/online/ladder', { action: 'stop' }), { disabled: onlineBusy }) })
          ] }) : null,
          !ladderRunning && ladderEstimate ? jsxs('div', {
            role: 'status', 'aria-live': 'polite',
            ref: ladderBox,
            style: { display: 'flex', flexDirection: 'column', gap: 6, border: `1px solid ${accent}`, borderRadius: 8, padding: '6px 10px', fontSize: 12 },
            children: [
              jsx('div', { children: ladderEstimate.text }),
              champions.length
                ? jsxs('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }, children: [
                    jsx('span', { children: 'Playing as' }),
                    button('Your agent', () => setLadderChampion(''), { primary: ladderChampion === '' }),
                    ...champions.map(item => button(item.name, () => setLadderChampion(item.id), { primary: ladderChampion === item.id }))
                  ] })
                : null,
              ladderReady
                ? jsxs('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' }, children: [
                    button('Start ladder game', () => { onlineCall('/online/ladder', { action: 'start', game: current, champion: ladderChampion }); setLadderAsk(null) }, { primary: true, disabled: onlineBusy || !current }),
                    button('Cancel', () => setLadderAsk(null))
                  ] })
                : jsx('div', { style: { color: text.secondary }, children: 'Pick a model in Settings, Models, Game Shelf opponent, then press Enter ladder again.' })
            ]
          }) : null,
          !ladderRunning && !ladderEstimate ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 }, children: [
            ladderLine(ladderStatus) ? jsx('div', { role: 'status', 'aria-live': 'polite', style: { fontSize: 12 }, children: ladderLine(ladderStatus) }) : null,
            jsx('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' }, children: [
              button('Enter ladder', showLadderAsk, { disabled: onlineBusy || !current }),
              online.bot && online.bot.name ? jsx('span', { style: { fontSize: 11, color: text.tertiary, alignSelf: 'center' }, children: `Bot: ${online.bot.name}` }) : null
            ] })
          ] }) : null
        ] })
    ]
  })

  const lobbyTab = jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 },
    children: [
      view && view.player && view.player.named
        ? jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: `You are ${view.player.name}` })
        : jsxs('div', {
            style: { display: 'flex', gap: 6 },
            children: [
              field(name, setName, 'Your name', () => { say(`name ${name.trim()}`); setName('') }),
              button('Set', () => { say(`name ${name.trim()}`); setName('') }, { disabled: !name.trim() })
            ]
          }),
      jsx('div', { style: { fontWeight: 650, fontSize: 13 }, children: `Find a match${current ? `: ${(game && game.title) || current}` : ''}` }),
      jsx('div', {
        style: { fontSize: 12, color: text.secondary },
        children: isLooking(lobby, current, myName)
          ? 'Looking. This keeps searching while you use Hermes; you will be told when someone wants this game.'
          : 'Ask to be listed, then play while Hermes works. Nothing interrupts you.'
      }),
      jsxs('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' }, children: [
        isLooking(lobby, current, myName)
          ? button('Stop looking', () => say('looking stop'), { disabled: working || !current })
          : button('Find a match', () => say(`looking ${current}`), { primary: true, disabled: working || !current || !myName })
      ] }),
      found.length
        ? jsx('div', {
            role: 'status', 'aria-live': 'polite',
            style: { fontSize: 12, color: text.primary, border: `1px solid ${accent}`, borderRadius: 8, padding: '6px 10px' },
            children: `Match found: ${found.map(row => row.name).join(', ')} wants ${(game && game.title) || current}. Say hello below.`
          })
        : null,
      jsx('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: text.secondary, maxHeight: 140, overflow: 'auto' },
        children: lobby.lines.length
          ? lobby.lines.slice(-8).map((item, index) => {
              const timestamp = item.at ? new Date(item.at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
              return jsxs('div', {
                style: { display: 'flex', gap: 6, fontSize: 11 },
                children: [
                  jsx('span', { style: { color: text.tertiary, whiteSpace: 'nowrap', minWidth: 40 }, children: timestamp }),
                  jsx('span', { style: { fontWeight: 650 }, children: `${item.name}: ` }),
                  jsx('span', { children: item.text, style: { flex: 1, minWidth: 0, wordWrap: 'break-word' } })
                ]
              }, index);
            })
          : jsx('div', { style: { color: text.tertiary }, children: 'No messages yet.' })
      }),
      jsxs('div', { style: { display: 'flex', gap: 6 }, children: [
        field(chat, setChat, view && view.player && view.player.named ? 'Say something' : 'Set a name first', () => { if (chat.trim()) { say(`chat say ${chat.trim()}`); setChat('') } }),
        button('Send', () => { say(`chat say ${chat.trim()}`); setChat('') }, { disabled: !chat.trim() || !(view && view.player && view.player.named) })
      ] }),
      onlineProblem
        ? jsx('div', { role: 'alert', style: { fontSize: 12, color: text.primary, border: `1px solid ${accent}`, borderRadius: 8, padding: '6px 10px' }, children: onlineProblem })
        : null,
      onlineNote
        ? jsx('div', { role: 'status', 'aria-live': 'polite', style: { fontSize: 12, color: text.secondary }, children: onlineNote })
        : null,
      onlineSection,
      // FUTURE(2026-11-11): the bot ladder — remove if never built.
      // The section is kept whole (above); PANE_LADDER_OFF keeps it off the pane, so bringing it
      // back is one boolean rather than a rebuild. Rated bot-versus-bot is not proven end to end,
      // and it belongs with Champions.
      PANE_LADDER_OFF ? null : ladderSection,
      // FUTURE(2026-11-11): Bots & leagues — remove if never built.
      // Leagues, watching a live table and bot passports all work against the lobby server, but
      // watching leaves Hermes for the browser. Kept whole (64-leagues.js); PANE_LEAGUES_OFF hides
      // it on the pane, which is the only surface that mounts it.
      PANE_LEAGUES_OFF || !(online.on && online.linked)
        ? null
        : jsx(BotsLeagues, { online, busy: onlineBusy, call: onlineCall, ctx, setNote: setOnlineNote })
    ]
  })

  // A match being played here on the lobby server takes the pane's body: the server's own picture
  // is the board, and it is not a local game, so the quick-game controls step aside entirely. The
  // pane's own header stays: × and – must not disappear just because a table is open.
  const hereRoom = onlineRoom || serverOnlineRoom(view)
  if (hereRoom) {
    return jsxs('div', {
      className: 'games-wait-pane',
      ref: rootBox,
      style: { display: 'flex', flexDirection: 'column', gap: 10, padding: 10, height: '100%', minHeight: 0, overflow: 'hidden', boxSizing: 'border-box', background: paper },
      children: [
        header,
        settings
          ? settingsView
          : jsx('div', {
              style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' },
              children: jsx(OnlineTable, {
                game, view, ctx, roomId: hereRoom, height: boardH,
                onBack: () => setOnlineRoom(''),
                onClose: () => setOnlineRoom('')
              })
            })
      ]
    })
  }

  return jsxs('div', {
    className: 'games-wait-pane',
    ref: rootBox,
    style: { display: 'flex', flexDirection: 'column', gap: 10, padding: 10, height: '100%', minHeight: 0, overflow: 'auto', background: paper, boxSizing: 'border-box' },
    children: settings ? [header, settingsView] : [
      header,
      agentRow(agentNotice(busy, finished, approval), ctx),
      problem ? jsx('div', { role: 'alert', style: { fontSize: 12, color: text.primary, border: `1px solid ${accent}`, borderRadius: 8, padding: '6px 10px', overflowWrap: 'anywhere' }, children: problem }) : null,
      noteLine(reply) ? jsx('div', { role: 'status', 'aria-live': 'polite', style: { fontSize: 12, color: text.secondary }, children: noteLine(reply) }) : null,
      tab === 'lobby' ? lobbyTab : gameTab
    ]
  })
}

// ---- One radio of the start-over dialog -------------------------------------
// The dialog opens with nothing checked: the whole point of the control
// is that no opponent is assumed, so a game is never dealt against a seat the person did not name.
// The radios are real inputs in one named group, so arrow keys and a screen reader work as they do
// anywhere else, and the label carries the promise each choice makes.
function dealChoiceElement(id, label, note, chosen, onPick) {
  return jsxs('label', {
    style: { display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' },
    children: [
      jsx('input', {
        type: 'radio',
        name: 'games-pane-deal',
        'data-deal-choice': id,
        checked: Boolean(chosen),
        onChange: () => onPick(id),
        style: { marginTop: 2, flex: '0 0 auto' }
      }),
      jsxs('span', {
        style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
        children: [
          jsx('span', { style: { fontWeight: 650 }, children: label }),
          jsx('span', { style: { fontSize: 11, color: text.tertiary }, children: note })
        ]
      })
    ]
  }, id)
}

// ---- The obvious door -------------------------------------------------------
// The pane used to come back only from the command palette. Two doors now carry it: a
// button in the Games header, beside the chips, and a status-bar item on the right. Both
// read the one pane state (usePaneOnScreen) and press the same two functions, so they can
// never disagree about where the pane is. The elements below are built by plain functions
// that take that state as an argument, so the surfaces can draw them without a second hook
// apiece and a test can draw either face on its own.
function paneDoorWords(onScreen) {
  return onScreen ? 'Close side pane' : 'Play while you code'
}

function paneDoorTitle(onScreen) {
  return onScreen
    ? 'Close the side pane. The status-bar item and the command palette bring it back.'
    : 'Open the side pane: play a quick game beside the chat while Hermes works.'
}

// The Games header's own button: light, beside the chips, and it says what the next press
// does — open the pane, or close it while it is open. Plain words, no icon: the header is
// where the door has to be unmistakable (the status-bar item is the one that wears the icon).
function paneDoorButtonElement(onScreen, style, onOpen) {
  return jsx('button', {
    type: 'button',
    'data-games-pane-door': onScreen ? 'close' : 'open',
    'aria-pressed': onScreen,
    'aria-label': paneDoorWords(onScreen),
    title: paneDoorTitle(onScreen),
    onClick: () => (onScreen ? closeWaitPane() : (onOpen ? onOpen() : openWaitPane())),
    style: Object.assign({
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 999,
      fontSize: 12, fontWeight: 650, whiteSpace: 'nowrap', cursor: 'pointer',
      border: `1px solid ${onScreen ? stroke : accent}`,
      background: onScreen ? 'transparent' : accent,
      color: onScreen ? text.secondary : 'var(--ui-text-on-accent, white)'
    }, style || {}),
    children: paneDoorWords(onScreen)
  })
}

// The status bar's own item: a small game icon and the words, and nothing at all while the
// pane is open (the ask is explicit: it shows only while the pane is closed).
function paneDoorItemElement(onScreen) {
  if (onScreen) return null
  return jsxs('button', {
    type: 'button',
    'data-games-pane-door': 'status',
    'aria-label': 'Play while you code',
    title: paneDoorTitle(false),
    autoFocus: false,
    onClick: () => openWaitPane(),
    style: {
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '0 6px',
      border: 'none', background: 'transparent', color: text.primary, fontSize: 11, cursor: 'pointer'
    },
    children: [
      paneDoorIconElement(13),
      jsx('span', { children: 'Play while you code' })
    ]
  })
}

// The ONE status-bar item: the pane's door and the news that needs saying —
// your turn, a match, your bot's result, or people waiting for a game you asked to hear
// about. The news is quiet while there is nothing to say; the door
// stands while the pane is off the screen and hides while it is open. Neither ever takes the
// keyboard, and a click opens the pane (or the match) instead of nagging.
function GamesStatusItem({ ctx }) {
  const [label, setLabel] = useState('')
  // One memory per kind of news, so a turn that is waiting cannot hide a match.
  const toldTurn = useRef('')
  const toldMatch = useRef('')
  // Where the pane is, so the door follows × and the palette without a second polling loop.
  const onScreen = usePaneOnScreen()
  useEffect(() => {
    let alive = true
    const check = async () => {
      try {
        const next = await ctx.rest('/view')
        const name = (next.player && next.player.name) || ''
        const titleOf = id => (paneGames(next).find(item => item.id === id) || {}).title || id
        // A match is my own looking row plus somebody else on the same game. It
        // comes from the lobby, so it survives a closed pane and a reload.
        const matchGame = matchFound(next.lobby, name)
        // ... and the wider count, for games the person asked to hear about.
        let crowdGame = ''
        let crowdCount = 0
        paneGames(next).forEach(item => {
          if (!alertsOn(ctx, item.id)) return
          const count = othersLooking(next.lobby, item.id, name).length
          if (count > crowdCount) { crowdCount = count; crowdGame = item.id }
        })
        const watching = paneWatch.game || savedPaneGame(ctx)
        let turnNow = false
        let botWord = ''
        if (watching) {
          const shown = await ctx.rest(`/board?game=${encodeURIComponent(watching)}`)
          turnNow = myTurn(shown && shown.picture, next)
          const picture = (shown && shown.picture) || null
          const over = picture && (picture.status === 'win' || picture.status === 'draw')
          const mine = over ? (picture.seats || []).find(seat => seat.kind === 'agent') : null
          if (over && mine) {
            botWord = picture.status === 'draw'
              ? 'Your bot drew'
              : `Your bot ${picture.winner === mine.side ? 'won' : 'lost'}`
          }
          // Only a notification actually sent is remembered: a turn that arrives while
          // alerts are paused still tells them once they unpause this game. The stamp is
          // the move on the board, so a new turn is a new line even between polls.
          const stamp = `${(picture && picture.plies) || ''}:${(picture && picture.last) || ''}:${(picture && picture.turn) || ''}`
          if (turnNow) {
            const key = `${watching}:${stamp}`
            if (key !== toldTurn.current && alertsOn(ctx, watching)) {
              notifyAlert(ctx, 'Your turn', watching, titleOf(watching))
              toldTurn.current = key
            }
          } else {
            toldTurn.current = ''
          }
        }
        if (matchGame) {
          if (matchGame !== toldMatch.current && alertsOn(ctx, matchGame)) {
            notifyAlert(ctx, 'Match found', matchGame, titleOf(matchGame))
            toldMatch.current = matchGame
          }
        } else {
          toldMatch.current = ''
        }
        if (!alive) return
        // The item says the most immediate thing only: the rest is still there
        // on the next quiet poll, never stacked.
        const label = turnNow
          ? `Your turn (${titleOf(watching)})`
          : matchGame
            ? 'Match found'
            : botWord || (crowdGame ? `${crowdCount} looking for ${titleOf(crowdGame)}` : '')
        setLabel(label)
      } catch {
        if (alive) setLabel('')
      }
    }
    check()
    const timer = setInterval(check, 8000)
    return () => { alive = false; clearInterval(timer) }
  }, [ctx])

  const door = paneDoorItemElement(onScreen)
  const news = !label ? null : jsxs('button', {
    type: 'button',
    'data-games-status': 'action',
    'aria-label': `Games: ${label}`,
    title: `${label} — open the side pane`,
    onClick: () => openWaitPane(),
    autoFocus: false,
    style: {
      display: 'flex', gap: 5, alignItems: 'center',
      padding: '0 6px', border: 'none', background: 'transparent',
      color: text.primary, fontSize: 11, cursor: 'pointer'
    },
    children: [
      jsx('span', {
        'aria-hidden': true,
        style: { width: 6, height: 6, borderRadius: '50%', background: accent, display: 'inline-block' }
      }),
      jsx('span', { children: label })
    ]
  })
  if (!door && !news) return null
  return jsxs('span', {
    'data-games-status-bar': '1',
    style: { display: 'inline-flex', alignItems: 'center', gap: 8 },
    children: [door, news]
  })
}
