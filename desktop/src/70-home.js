// ---- 70-home.js: the Games page: Play, Experimental Games, the lobby and the tabs

// ---- Inference Slot Machine: one button, on the screen people arrive at ----------
// "Spin while Hermes thinks" is TWO settings, and both are needed:
//
//   - the wallet's autoplay switch (POST /jackpot/autoplay) is permission for a hook to spin at all;
//   - the Jackpot backdrop switch ('jackpot2.overchat', 19-jackpot2-layer.js) is what puts a machine on
//     screen — and the shelf refuses a reply's spin while NO machine reports itself visible.
//
// One press here sets both, so the person gets a working feature instead of half of one, and the button
// is ON only while BOTH are on: flip either switch anywhere else (the cabinet's panel, Settings, the
// status bar) and this one says so, because it reads the wallet and the store rather than its own
// memory of the last press.
const INFERENCE_AUTOPLAY_TIP = 'Spins the slot machine each time Hermes starts thinking, shown as a see-through backdrop over the chat.'

function inferenceAutoplayOn(autoplay, backdrop) {
  return Boolean(autoplay) && Boolean(backdrop)
}

function InferenceAutoPlayButton({ ctx }) {
  const [backdrop, setBackdrop] = useJp2LOverchat(ctx)
  // null until the wallet has answered once: before that the button is off, never a guess.
  const [autoplay, setAutoplay] = useState(null)
  const [trouble, setTrouble] = useState('')
  const [busy, setBusy] = useState(false)
  // The wallet's own switch, read from the route the cabinet and the status bar read. A failed read
  // keeps the last good answer and says nothing: this is a control, not a report.
  useEffect(() => {
    let alive = true
    const read = async () => {
      try {
        const next = await ctx.rest('/jackpot')
        if (alive && next) setAutoplay(Boolean(next.autoplay))
      } catch { /* the last answer stands */ }
    }
    read()
    const timer = setInterval(read, POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [ctx])
  const on = inferenceAutoplayOn(autoplay, backdrop)
  const press = async () => {
    if (busy) return
    const want = !on
    setBusy(true)
    setTrouble('')
    // The backdrop switch follows the finger at once — that is the part this window owns — and the
    // wallet's answer decides what stays.
    setBackdrop(want)
    try {
      const answer = await ctx.rest('/jackpot/autoplay', { method: 'POST', body: { on: want } })
      const confirmed = answer && typeof answer.autoplay === 'boolean' ? answer.autoplay : want
      setAutoplay(confirmed)
      if (confirmed !== want) {
        setBackdrop(!want)
        setTrouble(`The wallet did not ${want ? 'start' : 'stop'} it.`)
      }
    } catch (error) {
      // Back to the truth that is known: the wallet refused, so nothing would have spun.
      setBackdrop(!want)
      setTrouble(`Inference Slot Machine could not ${want ? 'start' : 'stop'}: ${jp2Reason(error)}.`)
    } finally {
      setBusy(false)
    }
  }
  return jsxs('span', {
    'data-inference-autoplay-host': '1',
    style: { display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 },
    children: [
      jsx('button', {
        type: 'button',
        'data-inference-autoplay': on ? 'on' : 'off',
        'aria-pressed': on,
        'aria-busy': busy ? 'true' : undefined,
        // A second press while the first is in flight would post again: the button waits its turn.
        disabled: busy,
        title: INFERENCE_AUTOPLAY_TIP,
        onClick: press,
        children: on ? 'Stop Inference Slot Machine' : 'Start Inference Slot Machine',
        style: {
          padding: '8px 13px', borderRadius: 8, fontFamily: 'inherit', fontSize: 13, fontWeight: 700,
          cursor: busy ? 'progress' : 'pointer',
          opacity: busy ? 0.7 : 1,
          border: `1px solid ${on ? '#ff5d73' : accent}`,
          // The on look is a change of ink and a ring, not a shade: a running machine must be obvious
          // from across the room, and the label changes with it so colour is never the only signal.
          background: on ? '#ff5d73' : accent,
          color: 'var(--ui-text-on-accent, white)',
          boxShadow: on ? '0 0 0 2px rgba(255,93,115,.30)' : 'none',
          transition: 'background 160ms linear, box-shadow 160ms linear'
        }
      }, 'button'),
      jsx('span', {
        'data-inference-autoplay-state': on ? 'on' : 'off',
        style: {
          fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase',
          color: on ? '#ff5d73' : text.tertiary
        },
        children: on ? 'On' : 'Off'
      }, 'state'),
      trouble ? jsx('span', {
        'data-inference-autoplay-note': '1', role: 'status', 'aria-live': 'polite',
        style: { fontSize: 11, color: text.secondary },
        children: trouble
      }, 'note') : null
    ]
  })
}

// ---- Get online: the one card at the top of the Games page ---------------------------------
//
// Everything a person needs to start playing with other people, in the order they meet it:
// which Game Center this window is on, turning online play on, a name (or the player they
// already have), the name they are known by, their key, and Check online. The steps are the
// pane's own (onlineAccountBlock, 62-pane-state.js), so the two surfaces cannot drift. Once
// there is nothing left to do, the card is one line, and Manage opens it again.
const ONLINE_SETTINGS_ROUTE = '/settings?tab=gateway'

function OnlineGetOnlineCard({ ctx, view }) {
  const fresh = onlineView(view)
  // The last answer to one of the card's own presses, painted at once. The page's own poll
  // replaces it on its next turn, so the card never shows something the gateway has moved on
  // from: a stale answer would be a card that disagrees with the rest of the page.
  const [live, setLive] = useState(null)
  const online = live || fresh
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState('')
  const [managed, setManaged] = useState(false)
  // The Hermes connection this window is using: '' or 'local' is this computer, anything else
  // is another machine's Hermes (the desktop's registered gateways).
  const [where, setWhere] = useState(null)
  const fields = useOnlineFields()
  const suggest = useOnlineSuggest(ctx, online.on && !online.linked)
  const check = useOnlineCheck(ctx)

  useEffect(() => { setLive(null) }, [view])

  useEffect(() => {
    let alive = true
    async function read() {
      try {
        if (typeof host === 'undefined' || !host || typeof host.connections !== 'function') return
        const answer = await host.connections()
        const rows = Array.isArray(answer) ? answer : (answer && Array.isArray(answer.connections) ? answer.connections : [])
        const active = typeof host.activeConnectionId === 'function' ? String(host.activeConnectionId() || '') : ''
        const mine = rows.find(row => row && String(row.id) === active) || null
        if (alive) {
          setWhere({
            active,
            label: mine ? String(mine.label || mine.id || '') : active,
            canOpen: typeof host.navigate === 'function'
          })
        }
      } catch {
        // An older desktop has no registry: the card then says what it does know.
        if (alive) setWhere({ active: '', label: '', canOpen: false })
      }
    }
    read()
    return () => { alive = false }
  }, [ctx])

  // One door for every online action, the same shape the pane uses: the answer carries the
  // new online view, so what is painted is the server's own answer and not a guess.
  const call = async (path, body, method) => {
    if (!ctx || typeof ctx.rest !== 'function') return { ok: false, text: 'Game Center cannot be reached.' }
    setBusy(true)
    setProblem('')
    try {
      const options = body === undefined ? { method: method || 'POST' } : { method: 'POST', body }
      const answer = await ctx.rest(path, options)
      if (answer && answer.online) setLive(answer.online)
      if (answer && answer.key_to_copy) fields.setShownKey(String(answer.key_to_copy))
      setNote((answer && answer.text) || '')
      if (answer && answer.ok === false) setProblem(String(answer.text || 'That did not work.'))
      return answer || {}
    } catch {
      setProblem('That did not reach Game Center. Try again.')
      return { ok: false }
    } finally {
      setBusy(false)
    }
  }

  const hostWord = onlineHost(online.url)
  const remote = Boolean(where && where.active && where.active !== 'local')
  const settled = online.on && online.linked && !online.offline

  if (settled && !managed) {
    return jsxs('div', {
      'data-online-card': 'collapsed',
      style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: text.secondary },
      children: [
        jsx('span', { 'data-online-card-line': '1', children: `Online as ${online.name} on ${hostWord} ✓` }),
        jsx('span', { 'aria-hidden': true, children: '·' }),
        textLink('Manage', () => setManaged(true), 'Open the online steps again')
      ]
    })
  }

  const whereBlock = jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }, children: [
    jsx('div', {
      'data-online-card-host': '1',
      style: { fontSize: 13, fontWeight: 650 },
      children: `Game Center on ${hostWord}`
    }),
    remote
      ? jsxs('div', { 'data-online-card-connection': 'remote', style: { fontSize: 12, color: text.secondary, lineHeight: 1.5 }, children: [
          jsx('span', { children: `This window runs Game Center on ${where.label || where.active}. To use this computer’s, switch the connection to This device in the status bar` }),
          where.canOpen
            ? jsx('span', { children: ', or press ' })
            : jsx('span', { children: ', in Settings → Gateways.' }),
          where.canOpen
            ? jsx('button', {
                type: 'button',
                'data-online-card-settings': '1',
                onClick: () => {
                  try { host.navigate(ONLINE_SETTINGS_ROUTE) } catch { /* an older desktop has no router */ }
                },
                style: { background: 'transparent', border: 0, padding: 0, font: 'inherit', color: accent, cursor: 'pointer', textDecoration: 'underline' },
                children: 'Open connection settings'
              })
            : null
        ] })
      : jsx('div', {
          'data-online-card-connection': 'this-device',
          style: { fontSize: 12, color: text.secondary, lineHeight: 1.5 },
          children: 'This window runs Game Center on this computer.'
        })
  ] })

  return jsxs('section', {
    'data-online-card': 'open',
    'aria-label': 'Get online',
    style: {
      display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
      border: `1px solid ${stroke}`, borderRadius: 10, background: card, padding: '10px 12px'
    },
    children: [
      jsxs('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }, children: [
        jsx('div', { style: { fontSize: 15, fontWeight: 700 }, children: 'Get online' }),
        settled ? textLink('Hide', () => setManaged(false), 'Fold the card back to one line') : null
      ] }),
      whereBlock,
      onlineAccountBlock({ online, fields, call, busy, note, problem, setNote, suggest }),
      onlineCheckBlock(check)
    ]
  })
}

// ---- Play with people: the card right under Get online -------------------------------
//
// The accept list and Find match used to live only inside The Hall, a panel down the page,
// which is why the owner could not find them. Both rows are here now, on the page a person
// already is, and they write exactly what The Hall writes (lobbyAcceptBody / lobbyLookingBody,
// 72-lobby.js): the lobby server is the one copy of that state, so the two surfaces cannot
// disagree. The card is drawn only when this window is signed in to online play.
function PlayWithPeople({ ctx, view }) {
  const online = onlineView(view)
  const signedIn = Boolean(online.on && online.linked && !online.offline)
  // The Hall's own snapshot, read here every few seconds. It is the same door The Hall reads,
  // so an accept made in either place is what this card shows on its next turn.
  const [snap, setSnap] = useState(null)
  const [pending, setPending] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!signedIn || !ctx || typeof ctx.rest !== 'function') return undefined
    let alive = true
    let timer = null
    const read = async () => {
      try {
        const answer = await ctx.rest('/online/hall')
        if (alive && answer && typeof answer === 'object') setSnap(answer)
      } catch { /* the last snapshot stands; the next tick tries again */ }
    }
    read()
    timer = setInterval(read, HALL_POLL_MS)
    return () => { alive = false; if (timer) clearInterval(timer) }
  }, [ctx, signedIn])

  if (!signedIn) return null

  // One door for both rows, held while its own POST is out, and a refusal is said in the
  // lobby's own words rather than swallowed.
  const post = async (key, path, body) => {
    if (pending) return { ok: false }
    setPending(key)
    setNote('')
    try {
      const answer = ctx && typeof ctx.rest === 'function'
        ? await ctx.rest(path, { method: 'POST', body })
        : { ok: false, text: 'Game Center cannot be reached.' }
      if (answer && answer.ok === false) setNote(String(answer.text || ''))
      return answer || { ok: true }
    } catch {
      setNote('That did not reach Game Center. Try again.')
      return { ok: false }
    } finally {
      setPending('')
    }
  }

  const you = (snap && snap.you) || {}
  const prefs = (snap && snap.prefs) || { open: false, games: {}, until: {} }
  const requests = (snap && snap.requests) || []
  const mine = Array.isArray(you.looking) ? you.looking : []
  const nowSeconds = Date.now() / 1000
  const sent = requests.filter(req => req && req.state === 'pending' && req.offer
    && req.from && String(req.from.id) === String(you.id))
  const came = requests.filter(req => req && req.state === 'pending' && req.offer
    && req.to && String(req.to.id) === String(you.id))
  const asking = sent[0] || null
  // How long the offer has left, in whole seconds: "Asking Bea — 42 s".
  const left = asking
    ? Math.max(0, Math.round(Number(asking.created || 0) + Number(asking.expires || 0) - nowSeconds))
    : 0
  const comingOffer = came[0] || null
  const held = say => ({ disabled: Boolean(pending), title: pending ? HALL_BUSY_NOTE : say })
  const muted = { fontSize: 11, color: text.tertiary, lineHeight: 1.5, minWidth: 0 }

  // One label row: the row's name, then the sentence that says what pressing it does.
  const rowHead = (key, label, say) => jsxs('div', {
    'data-people-row': key,
    style: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8, minWidth: 0 },
    children: [
      jsx('span', { style: { fontSize: 13, fontWeight: 650 }, children: label }),
      jsx('span', { style: { ...muted, whiteSpace: 'normal' }, children: say })
    ]
  })

  return jsxs('section', {
    'data-people-card': 'open',
    'aria-label': 'Play with people',
    style: {
      display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, flexWrap: 'wrap',
      border: `1px solid ${stroke}`, borderRadius: 10, background: card, padding: '10px 12px'
    },
    children: [
      jsx('div', { style: { fontSize: 15, fontWeight: 700 }, children: 'Play with people' }),
      rowHead('accept', 'Games I accept', 'People who press Play can invite you to these.'),
      // Called as the block it is, the way onlineAccountBlock is: no state of its own, so the
      // chip row is drawn in place and its presses go through this card's one door.
      LobbyAcceptChips({ until: prefs.until, games: prefs.games, post, pending, busyNote: HALL_BUSY_NOTE }),
      rowHead('play', 'Play now', 'Asks people who accept that game, longest-waiting first, one at a time.'),
      jsx('div', {
        role: 'group', 'aria-label': 'Play now',
        style: { display: 'flex', flexWrap: 'wrap', gap: 6, minWidth: 0 },
        children: LOBBY_GAMES.map(([id, label]) => jsx('button', {
          'data-play-now': id,
          ...held(`Ask people who accept ${label} for a game now.`),
          onClick: () => post(`play:${id}`, '/online/hall/looking', lobbyLookingBody([id])),
          style: {
            fontSize: 11, padding: '3px 8px', borderRadius: 999, cursor: 'pointer', whiteSpace: 'normal',
            border: `1px solid ${stroke}`, background: 'transparent', color: text.secondary
          },
          children: `Play ${label}`
        }, id))
      }),
      // The search itself: who is being asked, or that nobody is free yet. Stop looking is
      // here, beside the sentence it ends, so the way out is where the person is looking.
      asking || mine.length
        ? jsxs('div', {
            'data-people-status': '1', role: 'status', 'aria-live': 'polite',
            style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0 },
            children: [
              jsx('span', { style: { ...muted, color: text.secondary, flex: 1 }, children: asking
                ? `Asking ${(asking.to && asking.to.name) || 'someone'} — ${left} s`
                : `Nobody is free for ${mine.map(lobbyTitle).join(', ')} right now — still looking` }),
              jsx('button', {
                'data-people-stop': '1',
                ...held('Stop looking for a match.'),
                onClick: () => post('stop', '/online/hall/looking', lobbyLookingBody([])),
                style: { fontSize: 11, padding: '2px 8px', borderRadius: 999, border: `1px solid ${stroke}`, background: 'transparent', color: text.tertiary, cursor: 'pointer' },
                children: 'Stop looking'
              })
            ]
          })
        : jsx('div', { style: muted, children: 'Press Play beside a game to ask the people who accept it.' }),
      // An offer that came in: the same sentence the Hall uses, and the same dialog it opens.
      comingOffer
        ? jsx('div', {
            'data-people-offer': String(comingOffer.id), role: 'status', 'aria-live': 'polite',
            style: { ...muted, color: text.secondary, whiteSpace: 'normal' },
            children: `${lobbyOfferLine((comingOffer.from && comingOffer.from.name) || '', comingOffer.game)} — Join or Not now on the dialog.`
          })
        : null,
      note ? jsx('div', { role: 'alert', style: { ...muted, color: text.primary }, children: note }) : null
    ]
  })
}

function GameCenterPage({ ctx, onArea }) {
  const [skin, setSkin] = useSkin(ctx)
  const [view, setView] = useState(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState('')
  const [playing, setPlaying] = useState('')
  // Mafia Town: the Labs skin for the mafia table. The card turns it on; opening the
  // game anywhere else puts the classic table back.
  const [town, setTown] = useState(false)
  const [board, setBoard] = useState({ text: '', picture: null })
  const [reply, setReply] = useState('')
  const [move, setMove] = useState('')
  const [chat, setChat] = useState('')
  const [name, setName] = useState('')
  const [hostAddr, setHostAddr] = useState('')
  const [query, setQuery] = useState('')
  const [area, setArea] = useState('games')
  // The route draws Close Game Center itself off the Games screen; it needs to know which screen.
  useEffect(() => { if (typeof onArea === 'function') onArea(area) }, [area])
  // The lobby's short How to play card, opened from the header like the other
  // surfaces' how-to cards.
  const [lobbyHowto, setLobbyHowto] = useState(false)
  // The welcome is shown until it is answered or skipped in this visit. The saved
  // answer lives in /setup, so it is never asked again after that.
  const [welcomeClosed, setWelcomeClosed] = useState(false)
  const selectionGen = useRef(0)
  // Whether the side pane is on the screen, so the header's one button says what its next
  // press does. One read, shared with the status-bar item.
  const paneOn = usePaneOnScreen()

  // Full screen and the pane are one at a time. Arriving here closes the pane and
  // opens the game it was showing, so the handoff lands on the same board.
  useEffect(() => {
    leavePaneForPage()
    if (PAGE_HANDOFF.game) {
      setSelected(PAGE_HANDOFF.game)
      PAGE_HANDOFF.game = ''
    }
  }, [])

  const refresh = useCallback(async () => {
    const genAtStart = selectionGen.current
    try {
      const next = await ctx.rest('/view')
      // A refresh whose /view was already in flight when the person switched
      // games is stale: drop it before it paints anything, so game A's board
      // can never land under game B.
      if (selectionGen.current !== genAtStart) return { ok: true, picture: null }
      setView(next)
      setError('')
      const listed = next.store || (next.games || []).concat(next.more || [])
      const current = selected || (listed[0] && listed[0].id) || ''
      if (current && current !== selected) {
        selectionGen.current++
        setSelected(current)
      }
      const myGen = selectionGen.current
      const card = listed.find(item => item.id === current)
      if (current && card) {
        try {
          const shown = card.installed
            ? await ctx.rest(`/board?game=${encodeURIComponent(current)}`)
            : { text: '', picture: startingPicture(current) }
          // Drop this board if the person selected a different game while it was
          // in flight (selectionGen changes only on pick/open, never per poll),
          // so game A's board never paints under game B and a slow /view+/board
          // cannot starve the next poll out of a render.
          if (selectionGen.current !== myGen) return { ok: true, picture: null }
          const picture = shown.picture || (!shown.text ? startingPicture(current) : null)
          setBoard({ text: shown.text || '', picture, error: '' })
          return { ok: true, picture }
        } catch (failure) {
          if (selectionGen.current !== myGen) return { ok: true, picture: null }
          // While the gateway restarts, keep the last real board of this game on
          // screen; swapping in the blank starting board looks like a lost game.
          // Say so out loud, with a way back, instead of retrying behind a blank board.
          const said = String((failure && failure.message) || 'the game did not answer').slice(0, 140)
          setBoard(prev => (prev.picture && prev.picture.game === current && !prev.picture.preview
            ? { ...prev, error: said }
            : { text: '', picture: startingPicture(current), error: said }))
          return { ok: false, text: failure.message || 'Could not refresh the board.' }
        }
      } else {
        if (selectionGen.current !== myGen) return { ok: true, picture: null }
        setBoard({ text: '', picture: null })
        return { ok: true, picture: null }
      }
    } catch (failure) {
      const detail = failure && (failure.message || failure.status || failure.error)
      setError(
        'Game Center is waiting on the Hermes gateway. hermes-gameshelf is already enabled. Stay on this page — it retries every few seconds. If this lasts more than a minute, command palette → Reload desktop plugins.'
        + (detail ? ` (${String(detail).slice(0, 120)})` : '')
      )
      return { ok: false, text: detail ? String(detail) : 'Could not refresh the table.' }
    }
  }, [ctx, selected])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const send = useCallback(
    async line => {
      try {
        const answer = await ctx.rest('/command', { method: 'POST', body: { line } })
        setReply(answer.text || '')
        // Paint the board the command itself returned, so a move shows the moment the server answers
        // instead of after a second round trip.
        if (answer && answer.picture) setBoard({ text: answer.text || '', picture: answer.picture, error: '' })
        const refreshed = await refresh()
        return { ...answer, ...refreshed, ok: answer.ok !== false && refreshed.ok, text: refreshed.ok ? answer.text || '' : refreshed.text }
      } catch (failure) {
        const message = failure.message || 'That did not reach the Game Center.'
        setReply(message)
        return { ok: false, text: message }
      }
    },
    [ctx, refresh]
  )

  const playMove = useCallback(
    async (gameId, token) => {
      const pictured = board && board.picture
      const needsNew = !pictured || pictured.preview || pictured.status === 'idle' || pictured.status === 'abandoned'
      try {
        if (needsNew) {
          const started = await ctx.rest('/command', { method: 'POST', body: { line: `${gameId} new` } })
          setReply(started.text || '')
        }
        const answer = await ctx.rest('/command', { method: 'POST', body: { line: `${gameId} move ${token}` } })
        setReply(answer.text || '')
        if (answer && answer.picture) setBoard({ text: answer.text || '', picture: answer.picture, error: '' })
        const refreshed = await refresh()
        return { ...answer, ...refreshed, ok: answer.ok !== false && refreshed.ok, text: refreshed.ok ? answer.text || '' : refreshed.text }
      } catch (failure) {
        const message = failure.message || 'That did not reach the Game Center.'
        setReply(message)
        return { ok: false, text: message }
      }
    },
    [ctx, board, refresh]
  )

  if (error) {
    return skinShell(skin, jsx('div', { style: { padding: 16, color: text.secondary }, children: error }))
  }
  if (!view) {
    return skinShell(skin, jsx('div', { style: { padding: 16, color: text.tertiary }, children: 'Loading Game Center…' }))
  }

  const catalog = view.store || (view.games || []).concat(view.more || [])
  const needle = query.trim().toLowerCase()
  const matches = item => !needle || `${item.title} ${item.id} ${item.summary || ''} ${item.plugin || ''}`.toLowerCase().includes(needle)
  // Play is the curated list that ships with the plugin. Experimental Games is everything else the
  // person has installed, so nothing there can be mistaken for a match-ready table.
  // An experiment is never drawn among the Play tiles: the Labs shelf is where it belongs.
  const playList = (view.play || []).filter(matches).filter(item => !item.labs)
  const yourList = (view.your_games || []).filter(matches)
  // Suggestions are catalog pages, not games on this computer, so a search for a game never
  // surfaces them and they never pretend to be installed.
  const suggestions = view.your_suggestions || []
  const makers = view.makers || { note: '', notice: '', items: [] }
  const labsPlay = (view.labs_games || []).filter(matches)
  const playProblems = view.play_problems || []
  const community = view.community || { notice: '', games: [], problems: [] }
  const submit = submitTarget(view.submit)
  const game = catalog.find(item => item.id === selected) || (view.play || [])[0] || catalog[0]
  const lobby = view.lobby || { lines: [], looking: [] }
  const setup = view.setup || {}
  const alerts = view.alerts || { rows: [], count: 0 }
  const online = onlineView(view)
  const current = selected || ((view.play || [])[0] || {}).id || ''
  const waitingCount = id => online.on ? (online.looking[id] || 0) : (lobby.looking || []).filter(row => row.game === id).length

  // First run: one short panel before the games, and never again once answered.
  if (setup.welcome_needed && !welcomeClosed) {
    return skinShell(skin, jsx(WelcomePanel, {
      view,
      ctx,
      onDone: async () => {
        setWelcomeClosed(true)
        setArea('games')
        await refresh()
      }
    }))
  }

  // A card opens its own game screen. Only Play cards and our own launch panels reach here,
  // so a game another plugin brings can never end up at Game Center's table.
  const openTable = id => {
    selectionGen.current++
    setSelected(id)
    setReply('')
    setBoard({ text: '', picture: null })
    setTown(false)
    setPlaying(id)
  }

  // The Jackpot cabinets (JACKPOT v2, 19-jackpot2-layer.js) are not a server game: they are their
  // own screen with the same wallet, so they open straight into Game Center's left column.
  const openJackpot = () => {
    setPlaying(JP2L_ID)
    setReply('')
    setBoard({ text: '', picture: null })
  }

  // Join opens that game's table, which is where seats are taken. It never claims to
  // connect to anyone: this build has no network, and the wording says so.
  const joinAlert = row => {
    const inPlay = (view.play || []).some(item => item.id === row.game)
    if (inPlay) openTable(row.game)
    else if (row && row.game) setReply(`${row.title || row.game} is not at a table here. /games looking ${row.game} in the chat.`)
  }

  // Dismiss hides one row for a while, quietly: no dialog, no sound, no focus change.
  const dismissAlert = async row => {
    if (!row || !row.key) return
    try {
      await ctx.rest('/alerts/dismiss', { method: 'POST', body: { key: row.key } })
    } catch { /* the next refresh reads the truth either way */ }
    await refresh()
  }

  // Experimental games open their own screen, or nothing at all. A card that cannot open says so on
  // itself, and the rest of the page keeps working.
  const openYourGame = async card => {
    if (card.error) return String(card.error)
    if (card.opens === 'screen' && card.desktop_route) {
      try {
        if (!host || typeof host.navigate !== 'function') return 'Game Center cannot open another plugin’s screen here.'
        host.navigate(card.desktop_route)
        return ''
      } catch {
        return `Could not open ${card.title}. Its own screen is not available here.`
      }
    }
    if (card.opens === 'panel' && card.builtin) {
      openTable(card.id)
      return ''
    }
    return `This game has no screen of its own. In chat, /games install ${card.id} adds it, then /games ${card.id} plays it.`
  }

  // Submit your game: the form in this page, the same one Add your own game opens. A submission page
  // from the settings is offered as a second link inside the form, never instead of it.
  const openSubmit = () => {
    setReply('')
    setArea('submit')
  }

  const staffRole = (view.online && view.online.staff && view.online.staff.role) || ''
  const tabs = jsxs('div', {
    style: { display: 'flex', gap: 6, padding: area === 'champions' ? '12px 18px 0' : '0', background: paper },
    children: [
      button('Games', () => setArea('games'), { primary: area === 'games' }),
      button('Champions', () => setArea('champions'), { primary: area === 'champions' }),
      // The Admin tab appears only for a staff key that works with this account.
      staffRole ? button('Admin', () => setArea('admin'), { primary: area === 'admin' }) : null,
      // The way out, top right of the Games screen, level with the tabs.
      // Other screens get the same button floated top right by GameCenterRoute (80-plugin.js).
      area === 'games' ? jsx('span', { 'data-gc-close-header': '1', style: { marginLeft: 'auto' }, children: closeGameCenterButton(ctx) }) : null
    ]
  })

  if (area === 'admin') {
    return skinShell(skin, jsxs('div', {
      style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: paper },
      children: [jsx('div', { style: { padding: '12px 18px 0' }, children: tabs }), jsx(AdminPage, { ctx, view, onBack: () => setArea('games') })]
    }))
  }

  if (area === 'champions') {
    // Champions is not ready to run matches, so the tab says so plainly instead of opening a
    // page whose buttons would answer with an error. The page stays in the bundle, unreferenced,
    // so bringing it back is one line.
    return skinShell(skin, jsxs('div', {
      style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: paper },
      children: [tabs, jsxs('div', {
        'data-champions-coming-soon': '1',
        style: { padding: '18px 18px 24px', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' },
        children: [
          comingSoon('Champions', 'Build a champion, run it against the other seats and keep its record. Not switched on yet: the matches it needs do not run in this version.'),
          jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: 'Play and Experimental are unaffected.' })
        ]
      })]
    }))
  }

  // Settings: the name, the per-game switches, the pause and the AI choice. It is a
  // side link, not a section of the home page, so nothing there shifts around.
  if (area === 'settings') {
    return jsxs('div', {
      className: 'games-center-shell',
      'data-skin': skin,
      style: { display: 'flex', flexDirection: 'column', gap: 0, height: '100%', minHeight: 0, background: paper },
      children: [
        jsx('style', { children: SKIN_CSS }),
        jsx('div', { style: { padding: '12px 18px 0' }, children: tabs }),
        jsx(SettingsPanel, {
          view,
          ctx,
          skin,
          onSkin: setSkin,
          onBack: next => setArea(next === 'community' ? 'community' : 'games'),
          onCommunity: () => setArea('community'),
          onSaved: refresh,
          onReopen: async () => {
            setWelcomeClosed(false)
            setArea('games')
            // Bring the saved answer in now, so the welcome is what is on screen next
            // rather than a games page that a poll would replace a moment later.
            await refresh()
          }
        })
      ]
    })
  }

  // Add your own game is a screen of its own: two choices, one form, and the finished form becomes a
  // GitHub issue the person's browser opens to review and send.
  if (area === 'submit') {
    return jsxs('div', {
      className: 'games-center-shell',
      'data-skin': skin,
      style: { display: 'flex', flexDirection: 'column', gap: 0, height: '100%', minHeight: 0, background: paper, overflow: 'auto', paddingBottom: 96 },
      children: [
        jsx('style', { children: SKIN_CSS }),
        jsx('div', { style: { padding: '12px 18px 0' }, children: tabs }),
        jsx(SubmitGameForm, {
          ctx,
          onBack: () => setArea('games'),
          submitHref: submit.href,
          submitLabel: submit.label,
          onNote: setReply
        })
      ]
    })
  }

  // Community creations is a side link, never part of the Play page: link-out cards only,
  // the same labels and the same disclosure as before.
  if (area === 'community') {
    return jsxs('div', {
      className: 'games-center-shell',
      'data-skin': skin,
      style: { display: 'flex', flexDirection: 'column', gap: 0, height: '100%', minHeight: 0, background: paper, overflow: 'auto', paddingBottom: 96 },
      children: [
        jsx('style', { children: SKIN_CSS }),
        jsx('div', { style: { padding: '12px 18px 0' }, children: tabs }),
        jsxs('div', {
          style: { display: 'flex', flexDirection: 'column', gap: 14, padding: 18, minWidth: 0 },
          children: [
            jsxs('div', {
              style: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'end', flexWrap: 'wrap' },
              children: [
                jsxs('div', {
                  children: [
                    jsx('div', { style: { fontFamily: DISPLAY_FONT, fontSize: 26, lineHeight: 1.15, letterSpacing: '-.02em', fontWeight: 600 }, children: 'Community creations' }),
                    jsx('div', {
                      style: { fontSize: 12, color: text.tertiary, marginTop: 4 },
                      children: 'Games other people made. Game Center only opens the link in your browser.'
                    })
                  ]
                }),
                jsxs('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }, children: [
                  button(submit.label, openSubmit, {
                    primary: true,
                    title: 'Choose Community or Game Center, fill in the form, and send it from your own browser'
                  }),
                  button('Back to Game Center', () => setArea('games'))
                ] })
              ]
            }),
            jsx(CommunityShelf, { community, ctx }),
            reply
              ? jsx('div', { role: 'status', 'aria-live': 'polite', style: { fontSize: 12, color: text.secondary }, children: reply })
              : null
          ]
        })
      ]
    })
  }

  const tileGrid = children => jsx('div', {
    // 200 px a card, not 260: the lobby panel gives up half its width on the main screen, and that
    // width buys one more column of game cards.
    style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 200px), 1fr))', gap: 12 },
    children
  })

  // Labs: the experiment shelf. The Make games workshop is its first block; a new experiment is one
  // more entry in this list, with the same element and no new styles. Each block is a real
  // component, so its own state never depends on which other screens have been on this page before.
  const labsBlocks = [
    labsPlay.length
      ? jsx('div', {
          key: 'playable-experiments',
          style: { display: 'contents' },
          children: labsBlock('From the workshop',
            'Drafts you can see now. They open when they are ready; nothing here is rated or in a lobby, and it may change or be removed.',
            tileGrid(labsPlay.map(item => labsPlayCard(item, openTable))))
        })
      : null,
    (makers.items || []).length
      ? jsx(LabsLinks, {
          title: 'Make games',
          note: makers.note || 'Tools for making games, not playing them. Each card opens that tool’s own page.',
          notice: makers.notice,
          items: makers.items,
          ctx
        }, 'make-games')
      : null,
    // Pet Battles is an experiment, so it lives here and not on the Play shelf - and it is locked
    // with the rest of this shelf: visible, no way in.
    jsx('div', {
      key: 'pet-battles-labs',
      style: { minWidth: 0 },
      children: labsBlock(
        'Play a battle',
        'A turn-based 3v3 pet battle with original critters. Pick a type and four moves, then take on the computer.',
        labsLocked(jsx(PetBattlesLabsCard, {}), 'pet-battles')
      )
    }, 'pet-battles-labs'),
    // Mafia Town: the same mafia table with the town square drawn on top. Locked like its neighbours.
    jsx('div', {
      key: 'mafia-town-labs',
      style: { minWidth: 0 },
      children: labsBlock(
        'Play a different table',
        'The Mafia talking table drawn as a town square: night, dawn, speech bubbles, and votes by portrait.',
        labsLocked(jsx(MafiaTownCard, {}), 'mafia-town')
      )
    }, 'mafia-town-labs')
  ].filter(Boolean)

  // One shelf for everything that is not curated Play: the games a plugin installed and the
  // prototypes from the workshop, under a single heading and a single sentence. Two sections
  // both saying "experimental" read as a filing system, not as something to try. The whole shelf -
  // the Coming-soon cards and the Labs blocks - is off the main page and behind ONE small
  // "Experimental" link, where it is kept locked and hidden for later. Nothing of it is drawn on
  // the Play page any more.
  const experiments = jsxs('div', {
    'data-experiments': '1',
    style: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 },
    children: [
      heading('Experimental'),
      // The one short line under the heading: the shelf is a window.
      jsx('div', { 'data-experimental-help': '1', style: { fontSize: 13, color: text.secondary, marginBottom: 2, maxWidth: 620 }, children: LABS_LOCK_HELP }),
      jsx('div', { 'data-experiments-note': '1', style: { fontSize: 12, color: text.tertiary, marginBottom: 2, maxWidth: 620 }, children: EXPERIMENTS_NOTE }),
      yourList.length
        ? tileGrid(yourList.map(item => jsx(YourGameCard, { item, onOpen: openYourGame }, item.id)))
        : jsx('div', { style: { fontSize: 13, color: text.tertiary }, children: 'Nothing installed yet. A game another plugin ships lands here the moment the plugin is on.' }),
      // The workshop blocks keep their own titles; the shelf heading above covers the section.
      labsShelf(labsBlocks, undefined, { withHeading: false }),
      suggestionRow(suggestions, ctx)
    ]
  })

  // The one small link's destination. It is the shelf above, drawn on its own screen so the Play
  // page stays clean; every card in it is still locked, so the screen is a window, not a door.
  if (area === 'experimental') {
    return jsxs('div', {
      className: 'games-center-shell',
      'data-skin': skin,
      style: { display: 'flex', flexDirection: 'column', gap: 0, height: '100%', minHeight: 0, background: paper, overflow: 'auto', paddingBottom: 96 },
      children: [
        jsx('style', { children: SKIN_CSS }),
        jsx('div', { style: { padding: '12px 18px 0' }, children: tabs }),
        jsxs('div', {
          style: { display: 'flex', flexDirection: 'column', gap: 14, padding: 18, minWidth: 0 },
          children: [
            jsxs('div', {
              style: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
              children: [
                jsx('div', {
                  style: { fontSize: 12, color: text.tertiary },
                  children: 'Kept here for a look, off the Play page. Nothing in it opens yet.'
                }),
                button('Back to Game Center', () => setArea('games'))
              ]
            }),
            experiments
          ]
        })
      ]
    })
  }

  const store = jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 18, padding: 18, paddingBottom: 96, minWidth: 0, overflow: 'auto', background: paper },
    children: [
      tabs,
      // Get online: the first thing on the page, because playing with another person starts
      // here - which Game Center this window is on, and the four steps that sign you in.
      jsx(OnlineGetOnlineCard, { ctx, view }),
      // Right under it: who may invite you, and Play now. Signed in only, and drawn from the
      // lobby's own answer, so this card and The Hall always agree.
      jsx(PlayWithPeople, { ctx, view }),
      jsxs('div', {
        style: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'end', flexWrap: 'wrap' },
        children: [
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 },
            children: [
              jsx(GameCenterMark, { size: 48 }),
              jsxs('div', {
                children: [
                  // The install in view, at the TOP of the Games screen beside the wordmark: small and
                  // muted, one source (/v1/version), the same component Settings mounts.
                  jsxs('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', minWidth: 0 }, children: [
                    jsx(GameCenterWordmark, {}),
                    jsx('span', {
                      'data-games-version-header': '1',
                      children: jsx(GamesVersionChip, {
                        ctx,
                        style: { fontSize: 10, padding: '1px 6px', opacity: 0.8, letterSpacing: '0.02em' }
                      })
                    })
                  ] }),
                  jsx('div', {
                    style: { fontSize: 12, color: text.tertiary, marginTop: 4 },
                    children: view.player.named ? `You are ${view.player.name}` : 'Pick a name in Settings to chat'
                  }),
                  jsx('div', {
                    style: { marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
                    children: [
                      jsx(PointsChip, { ctx }),
                      // One press, both settings, on the screen people arrive at rather than inside
                      // the machine.
                      jsx(InferenceAutoPlayButton, { ctx }),
                      // The obvious door: one press opens the side pane and keeps a game beside
                      // the chat while Hermes works. While the pane is open the same button reads
                      // Close side pane.
                      // From full screen the door LEAVES Game Center: back to the chat with the
                      // pane on the right, on the same game.
                      paneDoorButtonElement(paneOn, null, () => paneFromPage(ctx, selected))
                    ]
                  })
                ]
              })
            ]
          }),
          jsxs('div', { style: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }, children: [
            jsx('div', { style: { width: 220 }, children: field(query, setQuery, 'Search games', () => {}) }),
            // The clear way back: one link, back under the chat, wherever this page was left.
            textLink('Back to chat', () => closeGameCenter(ctx)),
            textLink('How to play', () => setLobbyHowto(true)),
            // One small link, and the only trace of the experiments on this page: the Coming-soon
            // cards and the Labs shelf live behind it.
            textLink('Experimental', () => setArea('experimental')),
            textLink('Settings', () => setArea('settings')),
            textLink('Community creations', () => setArea('community'))
          ] })
        ]
      }),
      // The way out to the project itself: one row of three links, settled
      // right under the header beside Experimental / Settings / Community creations, each handed to
      // the person's own browser by the same door the community shelf uses — except Add your own game,
      // which opens this plugin's submission form.
      jsx(GameCenterLinks, { ctx, onNote: setReply, onAdd: () => { setReply(''); setArea('submit') } }),
      // No alert drops anywhere for now. The rows are still read from
      // /alerts and the component is still in the bundle, so bringing it back is this one line.
      null,
      // Find match lives in the lobby panel now, where it can see the lobby's own answer:
      // the stand-alone bar here used to press with whatever game happened to be selected,
      // which is how it could say it was looking for blackjack.
      jsx(LobbyWhoOnline, {
        view, ctx, current,
        // "Play here" on a Hall row: the lobby server took the room, so open that game's table,
        // which draws the server's picture instead of a local game.
        onPlayHere: match => openTable((match && match.game) || current)
      }),
      view.notice ? jsx('div', {
        role: 'status', 'aria-live': 'polite',
        style: { padding: '10px 12px', borderRadius: 8, border: `1px solid ${accent}`, fontSize: 13, color: text.primary, background: card },
        children: view.notice
      }) : null,
      playProblems.length
        ? jsx('div', { role: 'status', style: { fontSize: 12, color: text.secondary }, children: playProblems.join(' ') })
        : null,
      jsxs('div', {
        children: [
          heading('Play'),
          jsx('div', { style: { fontSize: 12, color: text.tertiary, marginBottom: 8 }, children: PLAY_NOTE }),
          playList.length
            ? tileGrid(jp2LPlayTiles(playList, openTable, waitingCount, openJackpot, matches))
            : jsx('div', { style: { fontSize: 13, color: text.tertiary }, children: 'No curated games to show.' })
        ]
      }),
      jsx(LobbyLadder, { view, current }),
      null
    ]
  })
  const right = jsx(LobbyChatColumn, {
    view, ctx, send, chat, setChat, name, setName, current,
    // "Play here" on the match card: the lobby server has taken the room, so open that game's
    // table, which draws the server's own picture instead of a local game.
    onPlayHere: match => openTable((match && match.game) || current)
  })

  return jsx('div', {
    className: 'games-center-shell',
    'data-skin': skin,
    style: { height: '100%', minHeight: 0, minWidth: 0, containerType: 'inline-size' },
    children: jsx('div', {
    className: 'games-center-layout',
    style: {
      display: 'grid',
      gridTemplateColumns: playing ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) minmax(220px, 280px)',
      height: '100%',
      minHeight: 0,
      background: paper,
      isolation: 'isolate',
      position: 'relative',
      zIndex: 1
    },
    children: [
      jsx('style', { children: `
        .games-center-layout { container-type: inline-size; }
        .games-play-table { box-sizing: border-box; }
        .games-play-table button:focus-visible, .games-play-table select:focus-visible { outline: 2px solid var(--ui-accent, #7ec8ff); outline-offset: 3px; }
        .games-board-panel > .games-board-stage, .doctrine-board-panel > .games-board-stage { min-width: 0; flex-shrink: 0; }
        .games-seabattle-boards { min-width: 0; }
        @container (max-width: 880px) {
          .games-seabattle-boards { flex-direction: column !important; align-items: center !important; }
        }
        @container (max-width: 520px) { .games-seats { grid-template-columns: minmax(0, 1fr) !important; } }
        @container (max-width: 820px) {
          .games-center-layout { grid-template-columns: minmax(0, 1fr) !important; grid-auto-rows: max-content; overflow: auto; }
          .games-center-layout > .games-play-table { height: auto !important; overflow: visible !important; padding: 14px !important; }
          .games-center-lobby { min-width: 0 !important; border-left: 0 !important; border-top: 1px solid var(--ui-stroke-secondary); max-height: 260px; }
        }
        @media (max-width: 900px) {
          .games-center-layout { grid-template-columns: minmax(0, 1fr) !important; grid-auto-rows: max-content; overflow: auto; }
          .games-center-layout > .games-play-table { height: auto !important; overflow: visible !important; padding: 14px !important; }
          .games-center-lobby { min-width: 0 !important; border-left: 0 !important; border-top: 1px solid var(--ui-stroke-secondary); max-height: 260px; }
        }
        @media (prefers-reduced-motion: reduce) { .games-play-table * { animation: none !important; transition: none !important; } }
      ` + SKIN_CSS }),
      playing && board.error
        ? jsxs('div', {
            role: 'alert',
            'data-games-board-error': playing,
            style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 12px', borderRadius: 10, border: `1px solid ${stroke}`, background: card, color: text.secondary, fontSize: 13 },
            children: [
              jsx('span', { children: `This game could not load (${board.error}). Retrying every few seconds.` }),
              button('Back to games', () => setPlaying(''))
            ]
          })
        : null,
      // JACKPOT v2 first: it is not a server game, so it never asks the shelf for a board — it is
      // the machine itself, at the size this column allows, and nothing of it is clipped.
      playing === JP2L_ID || playing === 'slots'
        ? jsx(Jackpot2Full, { ctx, onBack: () => setPlaying('') })
        : playing && game && game.id === playing
        ? game.id === 'doctrine'
          ? jsx(DoctrinePanel, {
              game,
              view,
              board,
              send,
              playMove,
              importText: async text => {
                const answer = await ctx.rest('/doctrine/import', { method: 'POST', body: { text } })
                return answer
              },
              refresh,
              ctx,
              onBack: () => setPlaying('')
            })
          : game.id === ARENA_ID
            ? jsx(ArenaPanel, { game, view, board, send, ctx, onBack: () => setPlaying('') })
            : game.id === PETB_ID
              ? jsx(PetBattlePanel, {
                  game,
                  view,
                  board,
                  send,
                  ctx,
                  onBack: () => setPlaying('')
                })
              : game.id === 'mafia' && town
              ? jsx(MafiaTown, {
                  game,
                  view,
                  board,
                  send,
                  ctx,
                  onBack: () => setPlaying(''),
                  onClassic: () => setTown(false)
                })
              : TALKING_IDS.includes(game.id)
              ? jsx(TalkingTable, {
                  game,
                  view,
                  board,
                  send,
                  refresh,
                  ctx,
                  onBack: () => setPlaying('')
                })
              : (game.kind || 'table') === 'table'
              ? jsx(PlayTable, {
                  game,
                  view,
                  board,
                  playMove,
                  send,
                  ctx,
                  onBack: () => setPlaying('')
                })
              : jsx(LaunchPanel, { game, view, board, send, ctx, onBack: () => setPlaying('') })
        : store,
      playing ? null : right,
      playing || !lobbyHowto ? null : jsx(LobbyHowTo, { onClose: () => setLobbyHowto(false) })
    ]
    })
  })
}
