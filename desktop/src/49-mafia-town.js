// ---- 49-mafia-town.js: Mafia Town, the talking-table Mafia drawn as a place ----
//
// A skin, not a second game: the picture and every command are the classic table's
// (`mafia …`), only the drawing changes. The town square darkens at night, dawn names
// who is gone, speech bubbles carry the day's talk, and a vote is one click on a
// portrait. Watching a town of bots is the same scene with the buttons at rest.

// Pure helpers first: the UI harness asserts on these without a browser.

// Which scene to draw. The picture's phase line is English ("Night 2 · the table
// sleeps"), so this reads the words, not a field only the table knows.
function townPhaseOf(label, status) {
  if (status === 'done') return 'done'
  const word = String(label || '')
  if (!word || word === 'Not started') return 'setup'
  if (word.indexOf('Night') === 0) return 'night'
  if (word.indexOf('voting') >= 0) return 'vote'
  if (word.indexOf('talking') >= 0) return 'talk'
  return 'day'
}

// The latest thing each seat said. Only day talk shows bubbles; the map is keyed by
// the name the log row carries, which is the name the seat shows.
function townBubbles(places, log) {
  const said = {}
  ;(Array.isArray(log) ? log : []).forEach(row => {
    if (!row || row.kind !== 'say' || !row.name) return
    const text = String(row.text || '').slice(0, 90)
    if (text) said[row.name] = text
  })
  const bubbles = {}
  ;(Array.isArray(places) ? places : []).forEach(place => {
    if (place && place.name && said[place.name]) bubbles[place.seat] = said[place.name]
  })
  return bubbles
}

// The one action word this phase's buttons share ('vote', 'eliminate', …), or ''.
function townVerbOf(actions) {
  const first = (Array.isArray(actions) && actions[0] && actions[0].id) || ''
  const dash = String(first).indexOf('-')
  return dash > 0 ? String(first).slice(0, dash) : ''
}

// Seats that are gone now but were not a moment ago: the dawn list and the dust.
function townNewlyOut(prevOut, places) {
  const before = new Set(Array.isArray(prevOut) ? prevOut : [])
  const now = []
  ;(Array.isArray(places) ? places : []).forEach(place => {
    if (place && place.out && !before.has(place.seat)) now.push(place.seat)
  })
  return now
}

const TOWN_STARS = [[6, 8], [14, 18], [24, 6], [33, 14], [47, 9], [58, 16], [66, 7], [74, 13], [86, 8], [92, 18], [40, 20], [70, 22]]
const TOWN_HOUSES = [
  { left: '2%', top: '30%', scale: 1 }, { left: '15%', top: '8%', scale: 0.8 },
  { left: '38%', top: '3%', scale: 0.9 }, { left: '62%', top: '4%', scale: 0.85 },
  { left: '82%', top: '9%', scale: 1 }, { left: '92%', top: '32%', scale: 0.9 }
]

function TownHouse(props) {
  const { left, top, scale = 1, night } = props
  const width = 86 * scale
  return jsx('div', {
    'aria-hidden': 'true',
    'data-town-house': 'true',
    style: {
      position: 'absolute', left, top, width, height: 64 * scale, pointerEvents: 'none',
      filter: night ? 'brightness(0.55)' : 'none', transition: 'filter .8s'
    },
    children: jsxs('div', { style: { position: 'relative', width: '100%', height: '100%' }, children: [
      // The roof: a plain triangle.
      jsx('div', { style: {
        position: 'absolute', top: 0, left: 0, width: '100%', height: '46%',
        background: 'var(--ui-fill-secondary, rgba(127,127,127,0.2))',
        clipPath: 'polygon(50% 0, 100% 100%, 0 100%)'
      } }),
      // The body.
      jsx('div', { style: {
        position: 'absolute', bottom: 0, left: '12%', width: '76%', height: '56%',
        background: 'var(--ui-fill-tertiary, rgba(127,127,127,0.12))',
        border: `1px solid ${stroke}`
      } }),
      // Windows: they glow when the town sleeps.
      jsx('div', { 'data-town-window': 'true', style: {
        position: 'absolute', bottom: '18%', left: '26%', width: '18%', height: '26%',
        background: night ? 'var(--ui-accent)' : 'var(--ui-fill-secondary, rgba(127,127,127,0.2))',
        opacity: night ? 0.85 : 1, transition: 'background .8s, opacity .8s',
        boxShadow: night ? '0 0 6px var(--ui-accent)' : 'none'
      } }),
      jsx('div', { 'data-town-window': 'true', style: {
        position: 'absolute', bottom: '18%', right: '26%', width: '18%', height: '26%',
        background: night ? 'var(--ui-accent)' : 'var(--ui-fill-secondary, rgba(127,127,127,0.2))',
        opacity: night ? 0.85 : 1, transition: 'background .8s, opacity .8s',
        boxShadow: night ? '0 0 6px var(--ui-accent)' : 'none'
      } })
    ] })
  })
}

function TownBubble({ text }) {
  return jsx('div', {
    'data-town-bubble': 'true',
    style: {
      position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
      marginBottom: 6, width: 148, padding: '5px 8px', borderRadius: 10,
      background: card, border: `1px solid ${stroke}`, color: text.primary,
      fontSize: 10.5, lineHeight: 1.35, textAlign: 'center', zIndex: 5,
      boxShadow: '0 2px 8px rgba(0,0,0,0.25)'
    },
    children: [
      text,
      jsx('div', { 'aria-hidden': 'true', style: {
        position: 'absolute', top: '100%', left: '50%', marginLeft: -4,
        width: 0, height: 0, border: '4px solid transparent', borderTopColor: stroke
      } })
    ]
  })
}

function TownSeat(props) {
  const { place, count, phase, bubble, myTurn, targeted, justOut, role, grave, onPick } = props
  const mine = Boolean(place.you)
    const clickable = Boolean(myTurn && targeted && !grave && place.env_seat != null)
    return jsxs('button', {
    'data-town-seat': String(place.seat),
    'data-town-out': grave ? 'true' : 'false',
    onClick: () => { if (clickable) onPick(place) },
    disabled: !clickable,
    style: {
      position: 'absolute', ...talkSpot(place.seat, count), transform: 'translate(-50%, -50%)',
      width: 96, padding: 0, border: 'none', background: 'transparent', cursor: clickable ? 'pointer' : 'default',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
      opacity: place.out ? 0.55 : 1
    },
    children: [
      bubble ? jsx(TownBubble, { text: bubble }) : null,
      justOut ? jsx('div', { 'data-town-puff': 'true', 'aria-hidden': 'true', style: {
        position: 'absolute', top: -6, width: 40, height: 40, borderRadius: 20,
        background: 'radial-gradient(circle, rgba(255,255,255,0.5), rgba(255,255,255,0))',
        animation: 'townPuff 1.4s ease-out forwards'
      } }) : null,
      grave
        ? jsx('div', { 'data-town-grave': 'true', title: `${place.name} is out`, style: {
            width: 34, height: 30, margin: '8px 0',
            background: 'var(--ui-fill-secondary, rgba(127,127,127,0.3))',
            borderRadius: '16px 16px 3px 3px', border: `1px solid ${stroke}`
          } })
        : jsx('div', {
            'data-town-face': 'true',
            style: {
              width: 52, height: 52, borderRadius: 26, display: 'grid', placeItems: 'center',
              fontSize: 24, color: place.colour || text.primary,
              border: `2px solid ${place.playing ? accent : (targeted && myTurn ? accent : stroke)}`,
              background: mine ? 'var(--ui-fill-secondary, rgba(127,127,127,0.16))' : card,
              boxShadow: place.playing ? `0 0 0 4px rgba(127,127,127,0.1)` : 'none',
              transition: 'border-color .4s, box-shadow .4s'
            },
            children: place.avatar || '●'
          }),
      jsx('div', { style: {
        fontSize: 11, fontWeight: 700, color: mine ? text.primary : text.secondary,
        maxWidth: 96, textAlign: 'center', textShadow: '0 1px 2px rgba(0,0,0,0.4)'
      }, children: place.name + (mine ? ' (you)' : '') }),
      role
        ? jsx('div', { 'data-town-role': 'true', style: { fontSize: 10, color: accent }, children: role })
        : null
    ]
  })
}

function MafiaTownCard({ onOpen }) {
  return jsxs('div', {
    'data-labs-card': 'mafia-town',
    style: {
      display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 8,
      border: `1px solid ${stroke}`, borderRadius: 16, padding: 16, background: card, minWidth: 0
    },
    children: [
      jsxs('div', { children: [
        jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, children: [
          jsx('div', { style: { fontWeight: 700, fontSize: 15 }, children: 'Mafia Town' }),
          labsBadge()
        ] }),
        jsx('div', { style: { fontSize: 12, color: text.tertiary, marginTop: 2 }, children: 'by Game Center · the Mafia table, drawn as a town' }),
        jsx('div', {
          style: { fontSize: 12, color: text.secondary, marginTop: 4, lineHeight: 1.35 },
          children: 'The same table game with a skin: night falls on the square, dawn names who is gone, and a vote is one click on a portrait. Watch a town of bots play it out.'
        })
      ] }),
      jsx('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }, children: [
        button('Open Mafia Town', onOpen, { primary: true }),
        jsx('span', { style: { fontSize: 11, color: text.tertiary }, children: 'A skin on the table game · model calls only if you seat them' })
      ] })
    ]
  })
}

function MafiaTown({ game, view, board, send, refresh, ctx, onBack, onClassic }) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [notice, setNotice] = useState('')
  const [message, setMessage] = useState('')
  const [seats, setSeats] = useState(0)
  const [agent, setAgent] = useState(false)
  const [champions, setChampions] = useState([])
  const [dawn, setDawn] = useState(null)
  const [puff, setPuff] = useState([])
  const [roles, setRoles] = useState({})
  const latest = useRef(null)
  const seen = useRef({ phase: '', out: [], gone: [] })
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  const pictured = (board && board.picture) || null
  useEffect(() => {
    if (!pictured || !pictured.preview) return
    setSeats(Number((pictured.limits && pictured.limits.default) || 6))
  }, [game.id])
  const run = async line => {
    if (busy || !alive.current) return false
    setBusy(true)
    setFailure('')
    try {
      const answer = await send(line)
      if (answer && answer.ok === false) throw new Error(answer.text || 'The town refused that.')
      if (alive.current) setNotice((answer && answer.text) || '')
      return true
    } catch (error) {
      if (alive.current) setFailure(error.message || 'That did not reach the town.')
      return false
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const acting = Boolean(pictured && pictured.status === 'active' && pictured.can_step)
  latest.current = { ready: acting, step: () => send(`${game.id} step`) }
  // Machine seats play themselves while the town watches, one turn at a time — the
  // same watcher the classic table uses, so the two skins stay in step.
  useEffect(() => {
    if (!acting) return undefined
    return startTableWatch(
      async () => {
        const answer = await latest.current.step()
        if (answer && answer.ok === false) throw new Error(answer.text || 'A seat could not move.')
        return true
      },
      () => latest.current.ready,
      error => { if (alive.current) setFailure(error.message || 'A seat could not move.') }
    )
  }, [acting, game.id])

  const phaseLabel = (pictured && pictured.phase) || ''
  const phase = townPhaseOf(phaseLabel, pictured && pictured.status)
  const places = (pictured && pictured.places) || []
  const log = (pictured && pictured.log) || []
  const actions = (pictured && pictured.actions) || []
  const myTurn = Boolean(pictured && pictured.can_move)
  const verb = townVerbOf(myTurn ? actions : [])
  const bubbles = phase === 'talk' ? townBubbles(places, log) : {}

  // Night, death and dawn, all read off the diff between this picture and the last.
  useEffect(() => {
    if (!pictured || pictured.preview) return undefined
    const seenBefore = seen.current
    const outNow = places.filter(place => place.out).map(place => place.seat)
    const fresh = townNewlyOut(seenBefore.out, places)
    const nowPhase = phase
    const wasNight = seenBefore.phase === 'night'
    let gone = seenBefore.gone || []
    if (nowPhase === 'night') gone = Array.from(new Set(gone.concat(fresh)))
    let nextDawn = null
    if (wasNight && (nowPhase === 'talk' || nowPhase === 'vote' || nowPhase === 'day') && gone.length) {
      const names = {}
      places.forEach(place => { names[place.seat] = place.name })
      nextDawn = {
        day: (pictured.phase || '').match(/Day (\d+)/) && RegExp.$1,
        gone: gone.map(seat => names[seat] || `Player ${Number(seat) + 1}`).join(', ')
      }
      gone = []
    }
    seen.current = { phase: nowPhase, out: outNow, gone }
    const timers = []
    if (fresh.length) {
      setPuff(fresh)
      timers.push(setTimeout(() => { if (alive.current) setPuff([]) }, 1500))
    }
    if (nextDawn) {
      setDawn(nextDawn)
      timers.push(setTimeout(() => { if (alive.current) setDawn(null) }, 6000))
    }
    return () => timers.forEach(clearTimeout)
  }, [pictured])

  // The reveal puts every role on the table.
  useEffect(() => {
    const reveal = pictured && pictured.reveal
    const map = {}
    ;((reveal && reveal.roles) || []).forEach(row => { map[row.seat] = row.role })
    setRoles(reveal ? map : {})
  }, [pictured && pictured.reveal, pictured && pictured.table_id])

  if (!pictured) {
    return jsx('div', { style: { padding: 18, color: text.tertiary }, children: 'Walking to the square…' })
  }
  if (pictured.status === 'idle' || pictured.preview) {
    const start = () => {
      const parts = [`${game.id} new`, `seats=${seats || ((pictured.limits && pictured.limits.default) || 6)}`]
      if (agent) parts.push('agent=1')
      if (champions.length) parts.push(`champions=${champions.join(',')}`)
      run(parts.join(' '))
    }
    return jsx('div', {
      'data-town': 'mafia-town-setup',
      style: { height: '100%', minHeight: 0, background: paper },
      children: talkSetup({
        game, pictured,
        seats: seats || (pictured.limits && pictured.limits.default) || 6,
        setSeats, agent, setAgent, champions, setChampions, busy, start,
        watch: () => run(`${game.id} new seats=${seats || ((pictured.limits && pictured.limits.default) || 6)} bots=1`),
        back: () => onBack(),
        openShared: async () => true,
        failure,
        aiAllowed: !(view && view.allow_ai === false)
      })
    })
  }

  const done = pictured.status !== 'active'
  const night = phase === 'night'
  const say = () => {
    const line = message.trim()
    if (!line) return
    setMessage('')
    run(`${game.id} say ${line}`)
  }
  const pick = place => {
    if (!myTurn || !verb) return
    const id = `${verb}-${place.env_seat}`
    if (actions.some(item => item.id === id)) run(`${game.id} act ${id}`)
  }
  const targeted = seat => {
    if (!myTurn || !verb) return false
    return actions.some(item => item.id === `${verb}-${seat}`)
  }
  const grave = place => Boolean(place.out)
  const winners = ((pictured.reveal && pictured.reveal.winners) || []).map(Number)
    const mySeat = pictured.your_seat
  const won = mySeat != null && winners.includes(Number(mySeat))
  const verdict = (pictured.reveal && pictured.reveal.reason) || ''
  const statusLine = done
    ? 'The game is over.'
    : night
      ? (myTurn && actions.length
          ? `Your night move: ${String((actions[0] && actions[0].hint) || 'choose').toLowerCase()} — click a portrait.`
          : 'Night. The town sleeps while the roles move.')
      : phase === 'vote' && myTurn
        ? 'Click a portrait to vote them out.'
        : (pictured.watching
            ? `Watching the town · ${pictured.turn_name || 'a seat'} acts…`
            : (myTurn ? 'Your turn.' : `${pictured.turn_name || 'A seat'} is acting…`))

  return jsxs('div', {
    'data-town': 'mafia-town',
    'data-town-phase': phase,
    style: { display: 'flex', flexDirection: 'column', gap: 10, padding: 16, height: '100%', minHeight: 0, background: paper, overflow: 'auto' },
    children: [
      jsxs('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }, children: [
        jsxs('div', { children: [
          jsx('div', { style: { fontSize: 20, fontWeight: 700 }, children: 'Mafia Town' }),
          jsx('div', { className: 'games-status', 'data-town-status': 'true', style: { fontSize: 12, color: text.secondary }, children: statusLine })
        ] }),
        jsxs('div', { style: { display: 'flex', gap: 6 }, children: [
          pictured.watching ? jsx('span', { 'data-town-ribbon': 'true', style: {
            fontSize: 11, color: accent, border: `1px solid ${accent}`, borderRadius: 999, padding: '2px 9px'
          }, children: 'Watching' }) : null,
          button('Classic table', () => onClassic && onClassic(), { title: 'The same game on the plain talking table.' }),
          button('New town', () => run(`${game.id} abandon`), { disabled: busy }),
          jsx(LearnButton, { game, ctx }),
          button('Back', onBack)
        ] })
      ] }),
      // The square itself.
      jsxs('div', {
        'data-town-scene': 'true',
        style: {
          position: 'relative', width: '100%', minHeight: 380, aspectRatio: '16 / 9',
          border: `1px solid ${stroke}`, borderRadius: 18, overflow: 'hidden',
          background: night
            ? 'linear-gradient(180deg, rgba(20,32,58,0.9) 0%, rgba(24,34,54,0.7) 40%, var(--ui-fill-tertiary, rgba(127,127,127,0.12)) 100%)'
            : 'linear-gradient(180deg, rgba(255,214,140,0.10) 0%, rgba(255,255,255,0.02) 46%, var(--ui-fill-tertiary, rgba(127,127,127,0.12)) 100%)',
          transition: 'background 1s'
        },
        children: [
          night
            ? TOWN_STARS.map((star, index) => jsx('div', {
                'data-town-star': 'true', 'aria-hidden': 'true',
                style: {
                  position: 'absolute', left: `${star[0]}%`, top: `${star[1]}%`, width: 2, height: 2,
                  borderRadius: 1, background: 'rgba(255,255,255,0.8)'
                }, key: `star-${index}`
              }))
            : null,
          ...TOWN_HOUSES.map((house, index) => jsx(TownHouse, { ...house, night }, `house-${index}`)),
          // The well at the middle of the square.
          jsx('div', { 'data-town-well': 'true', 'aria-hidden': 'true', style: {
            position: 'absolute', left: '50%', top: '52%', transform: 'translate(-50%, -50%)',
            width: '13%', aspectRatio: '2 / 1', borderRadius: '50%',
            border: `3px solid ${stroke}`, background: night ? 'rgba(30,50,80,0.6)' : 'rgba(120,160,200,0.25)'
          } }),
          // Sun or moon.
          jsx('div', { 'data-town-sky': night ? 'moon' : 'sun', 'aria-hidden': 'true', style: {
            position: 'absolute', right: '4%', top: '7%', width: 26, height: 26, borderRadius: 13,
            background: night ? 'rgba(220,228,255,0.85)' : 'rgba(255,206,112,0.9)',
            boxShadow: night ? '0 0 12px rgba(220,228,255,0.6)' : '0 0 12px rgba(255,206,112,0.6)',
            transition: 'background 1s, box-shadow 1s'
          } }),
          phase === 'vote' && myTurn
            ? jsx('div', { 'data-town-hint': 'true', style: {
                position: 'absolute', left: '50%', bottom: 10, transform: 'translateX(-50%)',
                fontSize: 11, color: accent, border: `1px solid ${accent}`, borderRadius: 999,
                padding: '2px 10px', background: card
              }, children: 'Click a player to vote' })
            : null,
          ...places.map(place => jsxs(TownSeat, {
            place, count: places.length, phase, bubble: bubbles[place.seat] || '',
            myTurn, targeted: targeted(place.env_seat), justOut: puff.includes(place.seat),
            grave: grave(place), role: done ? (roles[place.env_seat] || '') : '',
            onPick: pick
          }, `town-seat-${place.seat}`)),
          // Night draws the curtain over everything but the sky's own dark.
          jsx('div', { 'data-town-nightshade': night ? 'true' : 'false', 'aria-hidden': 'true', style: {
            position: 'absolute', inset: 0, pointerEvents: 'none',
            background: 'linear-gradient(180deg, rgba(10,18,38,0.35), rgba(10,18,38,0.55))',
            opacity: night ? 1 : 0, transition: 'opacity 1s'
          } }),
          dawn
            ? jsx('div', { 'data-town-dawn': 'true', role: 'status', style: {
                position: 'absolute', left: 0, right: 0, top: '38%', padding: '10px 16px',
                background: 'linear-gradient(180deg, rgba(255,196,87,0.28), rgba(255,196,87,0.06))',
                borderTop: '1px solid rgba(255,196,87,0.6)', borderBottom: '1px solid rgba(255,196,87,0.6)',
                textAlign: 'center', fontSize: 14, fontWeight: 700, color: text.primary,
                animation: 'townDawn 1s ease-out'
              }, children: `Dawn — ${dawn.gone} is gone` })
            : null,
          // The result, laid over the town so the last frame stays visible behind it.
          done
            ? jsxs('div', { 'data-town-over': 'true', role: 'dialog', 'aria-label': 'Game over', style: {
                position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
                background: 'rgba(8,12,20,0.72)'
              }, children: [
                jsxs('div', { style: { textAlign: 'center', padding: 22, border: `1px solid ${stroke}`, borderRadius: 16, background: card, minWidth: 280 }, children: [
                  jsx('div', { 'data-town-verdict': 'true', style: { fontSize: 20, fontWeight: 700, marginBottom: 4 }, children:
                    mySeat != null ? (won ? 'You won' : 'You lost') : 'The game is over' }),
                  jsx('div', { style: { fontSize: 13, color: text.secondary, marginBottom: 12 }, children: verdict }),
                  jsx('div', { style: { display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }, children: [
                    button('Play again', () => run(`${game.id} rematch`), { primary: true, disabled: busy }),
                    button('Classic table', () => onClassic && onClassic()),
                    button('Back', onBack)
                  ] })
                ] })
              ] })
            : null
        ]
      }),
      // The day's talk, and the one line this seat may say.
      !done
        ? jsxs('div', { style: { display: 'flex', gap: 6, alignItems: 'center' }, children: [
            jsx('input', {
              value: message,
              placeholder: pictured.can_say ? 'Say something to the town' : 'You can talk when the day talks and it is your turn',
              disabled: !pictured.can_say,
              maxLength: 200,
              onChange: event => setMessage(event.target.value),
              onKeyDown: event => { if (event.key === 'Enter' && pictured.can_say) say() },
              'data-town-say': 'true',
              style: { flex: 1, minWidth: 0, padding: '8px 10px', borderRadius: 8, border: `1px solid ${stroke}`, background: 'transparent', color: 'inherit', fontSize: 13, opacity: pictured.can_say ? 1 : 0.6 }
            }),
            button('Say it', say, { primary: true, disabled: !pictured.can_say || !message.trim() || busy })
          ] })
        : null,
      jsx('div', {
        'data-town-log': 'true',
        style: { maxHeight: 130, overflowY: 'auto', border: `1px solid ${stroke}`, borderRadius: 12, background: card, padding: '8px 12px' },
        children: log.length
          ? log.slice(-40).map((row, index) => jsx('div', {
              key: `town-log-${index}`,
              style: { fontSize: 11.5, lineHeight: 1.45, color: row.kind === 'say' ? text.secondary : text.tertiary, fontStyle: row.kind === 'say' ? 'normal' : 'italic' },
              children: row.name ? `${row.name}: ${row.text}` : row.text
            }, index))
          : jsx('div', { style: { fontSize: 11.5, color: text.tertiary }, children: 'Nothing has happened yet.' })
      }),
      notice ? jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: notice }) : null,
      failure ? jsx('div', { role: 'alert', style: { fontSize: 12, color: 'var(--ui-danger, #e06c75)' }, children: failure }) : null,
      jsx('style', { children: `
        @keyframes townPuff { 0% { transform: scale(0.4); opacity: 0.9; } 100% { transform: scale(1.6); opacity: 0; } }
        @keyframes townDawn { 0% { transform: translateY(-14px); opacity: 0; } 100% { transform: translateY(0); opacity: 1; } }
        @media (prefers-reduced-motion: reduce) { [data-town] * { animation: none !important; transition: none !important; } }
      ` })
    ]
  })
}
