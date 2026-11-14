// ---- 35-talking-table.js: the talking tables: seats, a log, one click per move
// A talking table: seats round a table, a log this person may read, and one click per move.
// Typing is only ever for conversation, and only while that game is in a talking phase.
const TALKING_IDS = ['mafia', 'liars-dice', 'liars-dice-2v2', 'prisoners-dilemma', 'blind-auction']
// Experiments that live on the Labs shelf but still play on this screen.
const LABS_TALKING_IDS = ['liars-dice-2v2']

const TALK_KIND = {
  human: 'You',
  local: 'Built-in player',
  agent: 'Your agent',
  champion: 'Champion'
}

function talkSpot(index, count) {
  const angle = -Math.PI / 2 + (index * 2 * Math.PI) / Math.max(1, count)
  return { left: `${50 + Math.cos(angle) * 39}%`, top: `${50 + Math.sin(angle) * 36}%` }
}

function talkKindWord(place) {
  if (place.you) return 'You'
  return TALK_KIND[place.kind] || 'Built-in player'
}

function talkSeat(place, count, thinking) {
  const mine = Boolean(place.you)
  const speaking = Boolean(place.playing)
  return jsxs('div', {
    className: 'games-talk-seat',
    'data-seat': String(place.seat),
    style: {
      position: 'absolute',
      ...talkSpot(place.seat, count),
      transform: 'translate(-50%, -50%)',
      width: 108,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 3,
      opacity: place.out ? 0.42 : 1
    },
    children: [
      jsx('div', {
        'data-role': place.role || '',
        style: {
          width: 46,
          height: 46,
          borderRadius: 23,
          display: 'grid',
          placeItems: 'center',
          fontSize: 22,
          color: place.colour || text.primary,
          border: `2px solid ${speaking ? accent : stroke}`,
          background: mine ? 'var(--ui-fill-secondary, rgba(127,127,127,0.16))' : fill,
          boxShadow: speaking ? `0 0 0 3px ${accent}33` : 'none'
        },
        children: place.avatar || '●'
      }),
      jsx('div', {
        style: { fontSize: 12, fontWeight: 700, color: mine ? text.primary : text.secondary, maxWidth: 108, textAlign: 'center' },
        children: place.name + (mine ? ' (you)' : '')
      }),
      jsx('div', {
        style: { fontSize: 10, color: text.tertiary, textAlign: 'center' },
        children: place.role ? place.role : [talkKindWord(place), place.note].filter(Boolean).join(' · ')
      }),
      speaking && thinking
        ? jsx('div', { style: { fontSize: 10, color: accent }, children: 'thinking…' })
        : null
    ]
  })
}

function talkBidWord(bid) {
  if (!bid || !bid.quantity) return 'No bid yet'
  return `${bid.quantity} × ${bid.face}s`
}

// The middle of the table: just enough to play from, never another seat's secrets.
function talkMiddle(pictured) {
  const mine = pictured.mine || {}
  const rows = []
  if (pictured.game === 'mafia') {
    rows.push(['Your role', mine.role || 'not dealt yet'])
    rows.push(['Alive', String((pictured.places || []).filter(place => !place.out).length)])
  } else if (pictured.game === 'liars-dice') {
    rows.push(['Bid on the table', talkBidWord(pictured.bid)])
    rows.push(['Your dice', (mine.dice || []).join(' · ') || 'none left'])
  } else if (pictured.game === 'blind-auction') {
    rows.push(['Your coins', String(mine.capital == null ? '—' : mine.capital)])
    // Your own valuation of each lot: it is the only thing this seat may see, and
    // without it the talk before the bids has nothing to talk about.
    const lots = mine.items || []
    if (lots.length) {
      lots.forEach(item => rows.push([item.name, `${item.value} to you`]))
    } else {
      rows.push(['Lots on the block', '0'])
    }
  } else if (pictured.game === 'prisoners-dilemma') {
    rows.push(['Your points', String(mine.points == null ? 0 : mine.points)])
    rows.push(['Match', `${(pictured.match && pictured.match.index) || 1} of ${(pictured.match && pictured.match.count) || 1}`])
  }
  return jsxs('div', {
    className: 'games-talk-middle',
    style: {
      position: 'absolute',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
      width: 210,
      padding: 14,
      borderRadius: 16,
      border: `1px solid ${stroke}`,
      background: card,
      textAlign: 'center'
    },
    children: [
      jsx('div', { style: { fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: text.tertiary }, children: 'Table' }),
      jsx('div', { style: { fontSize: 15, fontWeight: 700, margin: '4px 0 8px' }, children: pictured.phase }),
      ...rows.map((row, index) =>
        jsxs('div', {
          key: `row-${index}`,
          style: { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, color: text.secondary, padding: '2px 0' },
          children: [
            jsx('span', { children: row[0] }),
            jsx('span', { style: { color: text.primary, fontWeight: 600 }, children: row[1] })
          ]
        })
      )
    ]
  })
}

// ---- Liar's Dice 2v2: two teams, one shared pool each, talk in the open ----
// Ten pips stand for the team's shared pool: solid while the team still holds the
// die, hollow once it is gone. The count is always written next to them, so the
// picture never relies on colour alone.
function talkPoolPips(pool, out) {
  const pips = []
  for (let index = 0; index < 10; index += 1) {
    const full = index < pool
    pips.push(jsx('span', {
      key: `pip-${index}`,
      'data-pip': full ? 'full' : 'empty',
      style: {
        width: 11,
        height: 11,
        borderRadius: 3,
        boxSizing: 'border-box',
        border: `1px solid ${full ? accent : stroke}`,
        background: full ? accent : 'transparent',
        opacity: out ? 0.35 : full ? 0.92 : 0.7
      }
    }))
  }
  return pips
}

function talkTeamSeat(place) {
  const speaking = Boolean(place.playing)
  return jsxs('div', {
    key: `team-seat-${place.seat}`,
    'data-team-seat': String(place.seat),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 8px 4px 4px',
      borderRadius: 999,
      border: `1px solid ${speaking ? accent : stroke}`,
      background: place.you ? 'var(--ui-fill-secondary, rgba(127,127,127,0.16))' : 'transparent',
      opacity: place.out ? 0.45 : 1
    },
    children: [
      jsx('span', {
        style: {
          width: 26, height: 26, borderRadius: 13, display: 'grid', placeItems: 'center',
          fontSize: 14, color: place.colour || text.primary, background: fill
        },
        children: place.avatar || '●'
      }),
      jsxs('span', { style: { display: 'flex', flexDirection: 'column', lineHeight: 1.15, minWidth: 0 }, children: [
        jsx('span', { style: { fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }, children: place.name + (place.you ? ' (you)' : '') }),
        jsx('span', { style: { fontSize: 10, color: text.tertiary }, children: place.note || '' })
      ] })
    ]
  })
}

function talkTeamRow(team, places, mine, label) {
  if (!team) return null
  const yours = mine && mine.team === team.team
  const seated = places.filter(place => (team.seats || []).includes(place.seat))
  return jsxs('div', {
    'data-team': String(team.team),
    className: 'games-talk-team',
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      padding: '10px 14px',
      border: `1px solid ${yours ? accent : stroke}`,
      borderRadius: 14,
      background: card,
      opacity: team.out ? 0.55 : 1,
      flexWrap: 'wrap'
    },
    children: [
      jsxs('div', { style: { minWidth: 104 }, children: [
        jsx('div', { style: { fontSize: 10, letterSpacing: '.09em', textTransform: 'uppercase', color: text.tertiary }, children: yours ? 'Your team' : label || 'Their team' }),
        jsx('div', { 'data-team-dice': String(team.dice), style: { fontSize: 16, fontWeight: 700 }, children: `${team.dice} ${team.dice === 1 ? 'die' : 'dice'}` }),
        jsx('div', { style: { fontSize: 11, color: text.tertiary }, children: team.out ? 'out of dice' : `shared pool · split ${team.spread.join(' + ')}` })
      ] }),
      jsx('div', { 'aria-hidden': 'true', style: { display: 'grid', gridTemplateColumns: 'repeat(5, 11px)', gap: 3 }, children: talkPoolPips(team.dice, team.out) }),
      jsx('div', { style: { display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }, children: seated.map(talkTeamSeat) })
    ]
  })
}

function talkTeamCenter(pictured) {
  const bid = pictured.bid || {}
  const places = pictured.places || []
  const turn = places.find(place => place.playing) || null
  const mine = pictured.mine || {}
  const rows = [
    ['Bid on the table', talkBidWord(bid)],
    ['Round', String(pictured.round || 1)],
    ['Your cup this round', (mine.dice || []).join(' · ') || 'no dice'],
    ['To act', turn ? turn.name : (pictured.status === 'active' ? '—' : 'game over')]
  ]
  return jsxs('div', {
    className: 'games-talk-center',
    style: {
      display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 16px',
      border: `1px solid ${stroke}`, borderRadius: 14, background: fill, alignSelf: 'center', minWidth: 260
    },
    children: [
      jsx('div', { style: { fontSize: 10, letterSpacing: '.09em', textTransform: 'uppercase', color: text.tertiary, textAlign: 'center' }, children: 'Table' }),
      jsx('div', { 'data-talk-bid': String(bid.quantity || 0), style: { fontSize: 20, fontWeight: 700, textAlign: 'center' }, children: talkBidWord(bid) }),
      ...rows.map((row, index) => jsxs('div', {
        key: `centre-${index}`,
        style: { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, color: text.secondary },
        children: [
          jsx('span', { children: row[0] }),
          jsx('span', { style: { color: text.primary, fontWeight: 600 }, children: row[1] })
        ]
      }))
    ]
  })
}

// Who won, in the words that fit this table: "You win!" for the person in a seat,
// the winning seats by name for a watcher, and team words for the 2v2 experiment.
function talkWinnerLine(pictured) {
  const reveal = pictured.reveal || {}
  const winners = Array.isArray(reveal.winners) ? reveal.winners : []
  const seat = pictured.your_seat
  if (pictured.game === 'liars-dice-2v2') {
    if (seat != null) return winners.includes(seat) ? 'Your team wins' : 'Your team loses'
    const teams = pictured.teams || []
    const team = teams.find(row => (row.seats || []).some(value => winners.includes(value)))
    return team ? `Team ${Number(team.team) + 1} wins` : (winners.length ? 'A team wins' : 'Game over')
  }
  if (seat != null) return winners.includes(seat) ? 'You win!' : 'You lose.'
  const names = {}
  ;(pictured.places || []).forEach(place => { names[place.seat] = place.name })
  const won = winners.map(value => names[value] || `Player ${value + 1}`).filter(Boolean)
  if (!won.length) return 'Game over'
  return won.length === 1
    ? `${won[0]} wins`
    : `${won.slice(0, -1).join(', ')} and ${won[won.length - 1]} win`
}

// The result sits on the table itself: the same big card the board games use. It
// names the winner, says what decided it, and offers the three ways on. Every
// way on is a button, so the end can be reached with the mouse alone.
function talkResultOverlay(pictured, actions) {
  if (pictured.status === 'active') return null
  const reveal = pictured.reveal || {}
  const winners = Array.isArray(reveal.winners) ? reveal.winners : []
  const seat = pictured.your_seat
  const won = seat != null ? winners.includes(seat) : null
  const permissions = pictured.permissions || {}
  return jsx('div', {
    className: 'games-result',
    'data-outcome': won == null ? 'watched' : won ? 'win' : 'lose',
    role: 'alert',
    'aria-label': 'Game over',
    'aria-live': 'assertive',
    style: {
      position: 'absolute', inset: 0, zIndex: 4, display: 'flex', alignItems: 'center',
      justifyContent: 'center', padding: 12, borderRadius: 18,
      background: 'rgba(8, 12, 18, .58)'
    },
    children: jsxs('section', {
      style: {
        display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', textAlign: 'center',
        maxWidth: 470, padding: '18px 20px', borderRadius: 16,
        border: `2px solid ${won ? accent : stroke}`, background: card,
        boxShadow: '0 20px 44px rgba(0, 0, 0, .55)'
      },
      children: [
        jsx('div', { className: 'games-result-title', style: { fontSize: 28, fontWeight: 800, lineHeight: 1.1 }, children: talkWinnerLine(pictured) }),
        reveal.reason
          ? jsx('div', { className: 'games-result-why', style: { fontSize: 13, color: text.secondary }, children: reveal.reason })
          : null,
        jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 2 }, children: [
          button('Rematch', actions.rematch, { primary: true, disabled: actions.busy || permissions.can_rematch === false }),
          button('New game', actions.newGame, { disabled: actions.busy || permissions.can_manage === false }),
          button('Back', actions.back)
        ] })
      ]
    })
  })
}

function talkTeamsBoard(pictured, actions) {
  const teams = pictured.teams || []
  const mine = pictured.mine || {}
  const myTeam = teams.find(team => team.team === mine.team) || teams[0]
  const otherTeam = teams.find(team => myTeam && team.team !== myTeam.team) || teams[1]
  const places = pictured.places || []
  return jsxs('div', {
    className: 'games-talk-teams',
    style: {
      position: 'relative', display: 'flex', flexDirection: 'column', gap: 10,
      padding: 14, border: `1px solid ${stroke}`, borderRadius: 18, background: fill,
      minHeight: 330
    },
    children: [
      talkTeamRow(otherTeam, places, mine, 'Other team'),
      talkTeamCenter(pictured),
      talkTeamRow(myTeam, places, mine, 'Your team'),
      talkResultOverlay(pictured, actions)
    ]
  })
}

function talkLog(pictured) {
  const rows = pictured.log || []
  return jsxs('div', {
    className: 'games-talk-log',
    style: { display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%', border: `1px solid ${stroke}`, borderRadius: 12, background: card },
    children: [
      jsx('div', {
        style: { padding: '10px 12px', borderBottom: `1px solid ${stroke}`, fontSize: 12, fontWeight: 700, color: text.secondary },
        children: 'What happened'
      }),
      jsx('ol', {
        'aria-label': 'Table log',
        style: { listStyle: 'none', margin: 0, padding: '8px 12px', overflowY: 'auto', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 6 },
        children: rows.length
          ? rows.map((row, index) =>
              jsxs('li', {
                key: `log-${index}`,
                style: {
                  fontSize: 12,
                  lineHeight: 1.4,
                  color: row.kind === 'say' ? text.primary : text.tertiary,
                  fontStyle: row.kind === 'say' ? 'normal' : 'italic'
                },
                children: [
                  row.name ? jsx('span', { style: { fontWeight: 700, marginRight: 6, color: text.secondary }, children: `${row.name}:` }) : null,
                  jsx('span', { children: row.text })
                ]
              })
            )
          : jsx('li', { style: { fontSize: 12, color: text.tertiary }, children: 'Nothing has been said yet.' })
      })
    ]
  })
}

function talkReveal(pictured) {
  const reveal = pictured.reveal || {}
  const names = {}
  ;(pictured.places || []).forEach(place => { names[place.seat] = place.name })
  const rows = []
  if (pictured.game === 'mafia') {
    ;(reveal.roles || []).forEach(row => rows.push([names[row.seat] || `Player ${row.seat + 1}`, row.role]))
  } else if (pictured.game === 'liars-dice') {
    ;(reveal.dice || []).forEach(row => rows.push([names[row.seat] || `Player ${row.seat + 1}`, (row.dice || []).join(' · ') || 'no dice left']))
  } else if (pictured.game === 'blind-auction') {
    ;(reveal.lots || []).forEach(row => rows.push([
      row.name,
      row.winner == null ? 'nobody' : `${names[row.winner] || `Player ${row.winner + 1}`} paid ${row.paid}`
    ]))
  } else if (pictured.game === 'prisoners-dilemma') {
    ;(reveal.points || []).forEach(row => rows.push([names[row.seat] || `Player ${row.seat + 1}`, `${row.points} points in the last match`]))
  }
  return jsxs('section', {
    'aria-label': 'Reveal',
    style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, border: `1px solid ${stroke}`, borderRadius: 12, background: fill },
    children: [
      jsx('div', { style: { fontSize: 13, fontWeight: 700 }, children: 'The reveal' }),
      rows.length
        ? jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 }, children: rows.map((row, index) =>
            jsxs('div', { key: `reveal-${index}`, style: { display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12 }, children: [
              jsx('span', { style: { color: text.secondary }, children: row[0] }),
              jsx('span', { style: { color: text.primary, fontWeight: 600 }, children: row[1] })
            ] })) })
        : null,
      reveal.reason ? jsx('div', { style: { fontSize: 12, color: text.secondary }, children: reveal.reason }) : null
    ]
  })
}

// ---- Watch it think: your own bot's working, and the corner coach ----
// A bot's Read answers and its scratchpad are private. The backend sends them
// only to the person whose seat shares that bot; this panel renders what it was
// given and never asks for more.
function talkThinkHeading(label) {
  return jsxs('div', {
    style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
    children: [
      jsx('div', { style: { fontSize: 12, fontWeight: 700, color: text.secondary }, children: label }),
      jsx('span', { style: { fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: text.tertiary }, children: 'only you' })
    ]
  })
}

function talkReadRows(entry) {
  const rows = entry.read || []
  if (!rows.length) return null
  return jsx('div', {
    className: 'games-think-read',
    style: { display: 'flex', flexDirection: 'column', gap: 6 },
    children: rows.map((row, index) => jsxs('div', {
      key: `read-${entry.seat}-${index}`,
      style: { display: 'flex', flexDirection: 'column', gap: 1 },
      children: [
        jsx('div', { style: { fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', color: text.tertiary }, children: row.label }),
        jsx('div', { style: { fontSize: 11.5, lineHeight: 1.4, color: text.secondary }, children: row.text || '—' })
      ]
    }))
  })
}

function talkThinkEntry(entry) {
  return jsxs('div', {
    key: `think-${entry.seat}`,
    className: 'games-think-entry',
    style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 10, borderRadius: 12, border: `1px solid ${stroke}`, background: card },
    children: [
      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }, children: [
        jsx('span', {
          style: { width: 24, height: 24, borderRadius: 12, display: 'grid', placeItems: 'center', fontSize: 13, border: `1px solid ${stroke}`, flex: '0 0 auto' },
          children: entry.avatar || '●'
        }),
        jsx('div', { style: { fontSize: 12, fontWeight: 700, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: entry.name })
      ] }),
      entry.action
        ? jsx('div', {
            className: 'games-think-action',
            title: entry.action,
            style: {
              fontSize: 11, lineHeight: 1.4, color: accent, overflowWrap: 'anywhere',
              border: `1px solid ${accent}`, borderRadius: 8, padding: '3px 7px'
            },
            children: entry.action
          })
        : null,
      entry.fallback
        ? jsx('div', { style: { fontSize: 11.5, color: text.tertiary }, children: 'Its model did not answer, so the built-in player took that turn.' })
        : null,
      talkReadRows(entry),
      entry.scratch
        ? jsx('div', {
            className: 'games-think-scratch',
            style: {
              fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 11.5, lineHeight: 1.45,
              color: text.secondary, background: fill, border: `1px solid ${stroke}`, borderRadius: 8,
              padding: '8px 9px', maxHeight: 120, overflowY: 'auto', whiteSpace: 'pre-wrap'
            },
            children: entry.scratch
          })
        : null
    ]
  })
}

function talkThinkPanel(pictured) {
  const entries = pictured.think || []
  const owned = (pictured.places || []).filter(place => place.kind === 'agent' || place.kind === 'champion')
  const shell = children => jsxs('section', {
    'aria-label': 'Inside its head',
    className: 'games-think',
    style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 10, borderRadius: 12, border: `1px solid ${stroke}`, background: fill, minHeight: 0, flex: '0 0 auto' },
    children: [talkThinkHeading('Inside its head'), ...children]
  })
  if (!owned.length) {
    return shell([jsx('div', {
      style: { fontSize: 11.5, lineHeight: 1.45, color: text.tertiary },
      children: 'Their thinking stays private at a table you are not sitting at.'
    })])
  }
  if (!entries.length) {
    const names = owned.map(place => place.name).join(' and ')
    return shell([jsx('div', {
      className: 'games-think-waiting',
      style: { fontSize: 11.5, lineHeight: 1.45, color: text.tertiary },
      children: `${names} has not moved yet. Its Read answers and working appear here, and only you see them.`
    })])
  }
  return shell([
    pictured.coach && pictured.coach.used_round && pictured.coach.text
      ? jsxs('div', {
          className: 'games-think-coach',
          style: { fontSize: 11.5, color: text.secondary, borderLeft: `2px solid ${accent}`, paddingLeft: 8 },
          children: [
            jsx('div', { style: { fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', color: text.tertiary }, children: 'Your whisper this round' }),
            jsx('div', { children: pictured.coach.text })
          ]
        })
      : null,
    ...entries.map(talkThinkEntry)
  ])
}

// One sentence, 15 seconds, once a round. The clock is the backend's; this only
// draws it down between polls so the window does not look frozen.
function TalkCoachBox({ pictured, whisper, busy }) {
  const coach = pictured.coach || {}
  const [said, setSaid] = useState('')
  const [, setTick] = useState(0)
  const until = Number(coach.until || 0)
  useEffect(() => {
    if (!coach.open) return undefined
    const timer = setInterval(() => setTick(value => value + 1), 500)
    return () => clearInterval(timer)
  }, [coach.open, until])
  if (!coach.available) return null
  const left = until ? Math.max(0, until - Math.floor(Date.now() / 1000)) : 0
  const open = Boolean(coach.open) && left > 0
  const used = Boolean(coach.used_round)
  const name = coach.name || 'your bot'
  const state_ = used
    ? `Whispered${coach.text ? `: “${coach.text}”` : ''}. ${name} reads it before its next move.`
    : open
      ? `${left}s left of this round's whisper window.`
      : `One whisper a round, between rounds. Next window opens when the round turns.`
  return jsxs('section', {
    'aria-label': 'Corner Coach',
    className: 'games-coach',
    style: { display: 'flex', flexDirection: 'column', gap: 7, padding: 10, borderRadius: 12, border: `1px solid ${open ? accent : stroke}`, background: card },
    children: [
      jsxs('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }, children: [
        jsx('div', { style: { fontSize: 12, fontWeight: 700, color: text.secondary }, children: 'Corner Coach' }),
        jsx('div', { className: 'games-coach-clock', style: { fontSize: 11, color: open ? accent : text.tertiary }, children: open ? `${left}s` : used ? 'sent' : 'waiting' })
      ] }),
      open
        ? jsx('div', {
            'aria-hidden': 'true',
            style: { height: 3, borderRadius: 2, background: fill, overflow: 'hidden' },
            children: jsx('div', { style: { height: '100%', width: `${Math.min(100, Math.max(0, (left / 15) * 100))}%`, background: accent, transition: 'width .5s linear' } })
          })
        : null,
      open
        ? jsxs('div', { style: { display: 'flex', gap: 6, alignItems: 'center' }, children: [
            jsx('input', {
              value: said,
              'aria-label': 'One sentence for your bot',
              placeholder: `One sentence for ${name}`,
              maxLength: 120,
              disabled: busy,
              onChange: event => setSaid(event.target.value.slice(0, 120)),
              onKeyDown: event => {
                if (event.key === 'Enter' && said.trim() && !busy) { whisper(said.trim()); setSaid('') }
              },
              style: { flex: 1, minWidth: 0, padding: '7px 9px', borderRadius: 8, border: `1px solid ${stroke}`, background: 'transparent', color: 'inherit', fontSize: 12 }
            }),
            button('Whisper', () => { if (said.trim()) { whisper(said.trim()); setSaid('') } },
              { primary: true, disabled: busy || !said.trim(), label: 'Whisper this sentence to your bot' })
          ] })
        : null,
      jsx('div', { className: 'games-coach-state', style: { fontSize: 11, lineHeight: 1.4, color: used ? text.secondary : text.tertiary }, children: state_ }),
      open ? jsx('div', { style: { fontSize: 10.5, color: text.tertiary }, children: `${said.length} of 120 characters` }) : null
    ]
  })
}

function talkSetup({ game, pictured, seats, setSeats, level, setLevel, agent, setAgent, champions, setChampions, busy, start, startLearn, back, watch, openShared, failure, ctx, aiAllowed = true }) {
  const limits = pictured.limits || { min: 2, max: 6, default: 2 }
  const offered = pictured.champions || []
  const levels = pictured.levels || []
  const invitesMax = pictured.max_invites == null ? seats - 1 : Number(pictured.max_invites)
  const picked = invitesMax - champions.length - (agent ? 1 : 0)
  const seatButtons = []
  for (let count = limits.min; count <= limits.max; count += 1) {
    seatButtons.push(button(`${count} seats`, () => setSeats(count), { primary: count === seats }))
  }
  const invites = [
    button(agent ? 'Your agent is in' : 'Seat your agent', () => setAgent(!agent),
      { primary: agent, disabled: !aiAllowed || (picked <= 0 && !agent) })
  ].concat(offered.map(champion =>
    button(
      champions.includes(champion.id) ? `${champion.name} is in` : `Invite ${champion.name}`,
      () => setChampions(champions.includes(champion.id)
        ? champions.filter(id => id !== champion.id)
        : (picked > 0 ? champions.concat([champion.id]) : champions)),
      { primary: champions.includes(champion.id) })
  ))
  return jsxs('div', {
    className: 'games-talk-setup',
    style: { display: 'flex', flexDirection: 'column', gap: 14, padding: 18, overflow: 'auto', height: '100%' },
    children: [
      jsx('div', { style: { fontSize: 20, fontWeight: 700 }, children: pictured.title || game.title }),
      game.subtitle ? jsx('div', { style: { fontSize: 12, fontStyle: 'italic', color: text.secondary }, children: game.subtitle }) : null,
      jsx('div', { style: { fontSize: 13, color: text.secondary, maxWidth: 640, lineHeight: 1.5 }, children: pictured.blurb || game.summary }),
      jsxs('div', { children: [
        jsx('div', { style: { fontSize: 12, fontWeight: 700, color: text.secondary, marginBottom: 6 }, children: 'How many seats' }),
        limits.max > limits.min
          ? jsx('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' }, children: seatButtons })
          : jsx('div', { style: { fontSize: 12.5, color: text.secondary }, children: 'Four seats: you and a partner on one team, two computer players on the other. Turns alternate between the teams.' })
      ] }),
      levels.length
        ? jsxs('div', { children: [
            jsx('div', { style: { fontSize: 12, fontWeight: 700, color: text.secondary, marginBottom: 6 }, children: 'Computer strength' }),
            jsx('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' }, children: levels.map(entry =>
              button(entry.label, () => setLevel(entry.id), { primary: entry.id === (level || levels[1]?.id || levels[0]?.id) })) })
          ] })
        : null,
      jsxs('div', { children: [
        jsx('div', { style: { fontSize: 12, fontWeight: 700, color: text.secondary, marginBottom: 6 }, children: 'Who sits down' }),
        jsx('div', {
          style: { fontSize: 12, color: text.tertiary, marginBottom: 6 },
          children: pictured.max_invites === 1
            ? 'Seat 1 is you, and your guest sits opposite you on the same team. The other two seats are the computer pair.'
            : 'Seat 1 is you. Every other seat is the built-in player unless you seat your agent or invite a champion.'
        }),
        jsx('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' }, children: invites })
      ] }),
      jsx('div', {
        style: { fontSize: 12, color: text.secondary, padding: '10px 12px', border: `1px solid ${stroke}`, borderRadius: 10 },
        children: agent || champions.length
          ? `This table will ask a model about ${pictured.estimate || 0} time(s). Any answer that is late or not allowed is covered by the built-in player, and the table says so.`
          : 'No model is needed for this table: every other seat is the built-in player.'
      }),
      aiAllowed ? null : jsx('div', {
        style: { fontSize: 12, color: text.secondary },
        children: 'AI is off for this profile, so there is nobody to sit at this table with you. Turn it back on in Game Center settings to play a talking table.'
      }),
      failure ? jsx('div', {
        role: 'alert',
        style: { fontSize: 12, color: 'var(--ui-danger, #e06c75)' },
        children: failure
      }) : null,
      jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }, children: [
        button('Start the game', start, { primary: true, disabled: busy || !aiAllowed }),
        button('Watch computers play', watch, { disabled: busy || !aiAllowed, title: 'No person in any seat: you only watch, and no secrets are shown.' }),
        button('Back', back),
        jsx(LearnButton, { game, ctx, onStartLearn: startLearn }),
        jsx('label', { style: { fontSize: 12, color: text.secondary, display: 'inline-flex', alignItems: 'center', gap: 6 }, children: [
          'Open a game file',
          jsx('input', { type: 'file', accept: '.json,application/json', onChange: openShared, style: { fontSize: 11 } })
        ] })
      ] })
    ]
  })
}

function TalkingTable({ game, view, board, send, onBack, refresh, ctx }) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [notice, setNotice] = useState('')
  const [message, setMessage] = useState('')
  const [seats, setSeats] = useState(0)
  const [agent, setAgent] = useState(false)
  const [champions, setChampions] = useState([])
  const [level, setLevel] = useState('')
  const latest = useRef(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  const pictured = (board && board.picture) || null
  // Guided first game (Learn → Play & Learn): the rules' margin notes ride in the
  // table picture; the guide steps come from the game's learn.json.
  const learnBook = useLearnData(ctx, game.id, Boolean(pictured && pictured.learn))
  const [guideStep, setGuideStep] = useState(0)
  useEffect(() => {
    if (!pictured || !pictured.preview) return
    setSeats(Number((pictured.limits && pictured.limits.default) || 2))
  }, [game.id])
  const run = async line => {
    if (busy || !alive.current) return false
    setBusy(true)
    setFailure('')
    try {
      const answer = await send(line)
      if (answer && answer.ok === false) throw new Error(answer.text || 'The table refused that.')
      if (alive.current) setNotice((answer && answer.text) || '')
      return true
    } catch (error) {
      if (alive.current) setFailure(error.message || 'That did not reach the table.')
      return false
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const modelName = view && view.opponent && view.opponent.model
  const whisper = async text => {
    if (!text.trim() || busy) return false
    return run(`${game.id} coach ${text.trim()}`)
  }
  // Between rounds the table holds still for one whisper: while the person's own
  // bot is the next to move and the window is open, the machine seats wait.
  const coached = (pictured && (pictured.places || []).some(place =>
    place.playing && (place.kind === 'agent' || place.kind === 'champion'))) || false
  const holding = Boolean(pictured && pictured.coach && pictured.coach.open && coached)
  const acting = Boolean(pictured && pictured.status === 'active' && pictured.can_step && !holding)
  latest.current = { ready: acting, step: () => send(`${game.id} step`) }
  // Machine seats play themselves while the person watches, one turn at a time.
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
  useEffect(() => { setMessage(''); setGuideStep(0) }, [pictured && pictured.table_id, pictured && pictured.phase])
  // A shared file is opened from the same screen that offers it after a game: a person
  // who was sent one has no game of their own to finish first.
  const openShared = async event => {
    const file = event && event.target && event.target.files && event.target.files[0]
    if (!file) return
    try {
      const text = await file.text()
      const answer = await ctx.rest('/talk/import', { method: 'POST', body: { game: game.id, text } })
      if (answer.ok === false) throw new Error(answer.text || 'That file was refused.')
      if (refresh) await refresh()
      setNotice(answer.text || 'Opened the game file.')
    } catch (error) {
      setFailure(error.message || 'That file could not be opened.')
    }
  }
  if (!pictured) {
    return jsx('div', { style: { padding: 18, color: text.tertiary }, children: 'Opening the table…' })
  }
  if (pictured.status === 'idle' || pictured.preview) {
    const start = () => {
      const parts = [`${game.id} new`, `seats=${seats || ((pictured.limits && pictured.limits.default) || 2)}`]
      if (level) parts.push(`level=${level}`)
      else if ((pictured.levels || []).length) parts.push(`level=${pictured.levels[1] ? pictured.levels[1].id : pictured.levels[0].id}`)
      if (agent) parts.push('agent=1')
      if (champions.length) parts.push(`champions=${champions.join(',')}`)
      run(parts.join(' '))
    }
    return jsx('div', {
      style: { height: '100%', minHeight: 0, background: paper },
      children: talkSetup({
        game, pictured,
        seats: seats || (pictured.limits && pictured.limits.default) || 2,
        setSeats,
        level,
        setLevel,
        agent,
        setAgent,
        champions,
        setChampions,
        busy,
        start,
        startLearn: () => run(`${game.id} new seats=2 learn`),
        watch: () => run(`${game.id} new seats=${seats || ((pictured.limits && pictured.limits.default) || 2)} bots=1`),
        back: () => onBack(),
        openShared,
        failure,
        ctx,
        aiAllowed: !(view && view.allow_ai === false)
      })
    })
  }
  const places = pictured.places || []
  const done = pictured.status !== 'active'
  const yourTurn = Boolean(pictured.can_move)
  const say = () => {
    const line = message.trim()
    if (!line) return
    setMessage('')
    run(`${game.id} say ${line}`)
  }
  const act = id => run(`${game.id} act ${id}`)
  const shareReplay = () => {
    if (!pictured.share) return
    const saved = saveFile(`${game.id}-game.json`, JSON.stringify(pictured.share, null, 2))
    setNotice(saved ? 'Saved the game file.' : 'This window cannot save files.')
  }
  const standings = pictured.standings || []
  const groups = []
  ;(pictured.actions || []).forEach(item => {
    const group = item.group || ''
    let bucket = groups.find(entry => entry.group === group)
    if (!bucket) { bucket = { group, items: [] }; groups.push(bucket) }
    bucket.items.push(item)
  })
  const chips = groups.filter(group => group.group)
  const plain = groups.filter(group => !group.group).reduce((all, group) => all.concat(group.items), [])
  const statusLine = done
    ? 'The game is over.'
    : (holding
        ? `Corner Coach is listening — ${Math.max(0, Number((pictured.coach && pictured.coach.seconds_left) || 0))}s to whisper.`
        : (pictured.watching
            ? `You are watching · ${pictured.turn_name || 'a seat'} is playing…`
            : (yourTurn
                ? (pictured.can_say ? 'Your turn: say something.' : 'Your turn.')
                : `${pictured.turn_name || 'A seat'} is thinking…`)))

  const resultActions = {
    rematch: () => run(`${game.id} rematch`),
    newGame: () => run(`${game.id} abandon`),
    back: () => onBack(),
    busy
  }

  return jsxs('div', {
    className: 'games-talk',
    style: {
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 1fr) minmax(240px, 330px)',
      gap: 14,
      padding: 16,
      height: '100%',
      minHeight: 0,
      background: paper
    },
    children: [
      jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, minHeight: 0, overflow: 'auto' }, children: [
        jsxs('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }, children: [
          jsxs('div', { children: [
            jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, children: [
              jsx('div', { style: { fontSize: 20, fontWeight: 700 }, children: pictured.title || game.title }),
              LABS_TALKING_IDS.includes(game.id) ? labsBadge() : null
            ] }),
            game.subtitle ? jsx('div', { style: { fontSize: 12, fontStyle: 'italic', color: text.secondary }, children: game.subtitle }) : null,
            jsx('div', { className: 'games-status', style: { fontSize: 12, color: text.secondary }, children: statusLine })
          ] }),
          jsxs('div', { style: { display: 'flex', gap: 6 }, children: [
            button('New table', () => run(`${game.id} abandon`), { disabled: busy, title: 'Close this table and choose the seats again.' }),
            jsx(LearnButton, { game, ctx }),
            button('Back', onBack)
          ] })
        ] }),
        pictured.game === 'liars-dice-2v2'
          ? talkTeamsBoard(pictured, resultActions)
          : jsxs('div', {
              className: 'games-talk-table',
              style: { position: 'relative', width: '100%', minHeight: 330, aspectRatio: '4 / 3', border: `1px solid ${stroke}`, borderRadius: 18, background: fill, overflow: 'hidden' },
              children: [
                jsx('div', { style: { position: 'absolute', left: '22%', top: '24%', width: '56%', height: '52%', borderRadius: '50%', border: `1px solid ${stroke}` } }),
                ...places.map(place => talkSeat(place, places.length, acting)),
                done ? talkResultOverlay(pictured, resultActions) : talkMiddle(pictured)
              ]
            }),
        // Guided game: the rules walk one step at a time, and the machine seat
        // explains its own moves; a risky move gets a warning and Undo.
        pictured.learn ? jsx(CoachGuide, { game, pictured, learn: learnBook.data, guideStep, setGuideStep }) : null,
        jsx(CoachStrip, {
          game, pictured,
          command: line => run(line),
          lock: options => ({ ...options, disabled: busy || Boolean(options && options.disabled) })
        }),
        done
          ? talkReveal(pictured)
          : jsxs('div', { className: 'games-talk-actions', style: { display: 'flex', flexDirection: 'column', gap: 8 }, children: [
              plain.length
                ? jsx('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' }, children: plain.map(item =>
                    button(item.label, () => act(item.id),
                      { primary: item.id === 'send' || item.id === 'cooperate', disabled: busy || item.disabled, title: item.hint })) })
                : null,
              ...chips.map(group => jsxs('div', { key: group.group, style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }, children: [
                jsx('span', { style: { fontSize: 11, color: text.tertiary, minWidth: 52 }, children: group.group }),
                ...group.items.map(item => button(item.label, () => act(item.id),
                  { primary: item.on, disabled: busy || item.disabled, title: item.hint }))
              ] }))
            ] }),
        jsxs('div', { style: { display: 'flex', gap: 6, alignItems: 'center' }, children: [
          jsx('input', {
            value: message,
            placeholder: pictured.can_say ? 'Say something to the table' : 'You can talk when it is your turn in a talking phase',
            disabled: !pictured.can_say,
            maxLength: 200,
            onChange: event => setMessage(event.target.value),
            onKeyDown: event => { if (event.key === 'Enter' && pictured.can_say) say() },
            style: { flex: 1, minWidth: 0, padding: '8px 10px', borderRadius: 8, border: `1px solid ${stroke}`, background: 'transparent', color: 'inherit', fontSize: 13, opacity: pictured.can_say ? 1 : 0.6 }
          }),
          button('Say it', say, { primary: true, disabled: !pictured.can_say || !message.trim() || busy })
        ] }),
        notice ? jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: notice }) : null,
        failure ? jsx('div', { role: 'alert', style: { fontSize: 12, color: 'var(--ui-danger, #e06c75)' }, children: failure }) : null,
        (pictured.notes || []).length
          ? jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: pictured.notes[pictured.notes.length - 1] })
          : null,
        done
          ? jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }, children: [
              button('Play again', () => run(`${game.id} rematch`), { primary: true, disabled: busy }),
              button('Set up a new table', () => run(`${game.id} abandon`), { disabled: busy }),
              button('Save the game file', shareReplay, { disabled: !pictured.share }),
              jsx('label', { style: { fontSize: 12, color: text.secondary, display: 'inline-flex', alignItems: 'center', gap: 6 }, children: [
                'Open a game file',
                jsx('input', { type: 'file', accept: '.json,application/json', onChange: openShared, style: { fontSize: 11 } })
              ] })
            ] })
          : null
      ] }),
      jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflowY: 'auto' }, children: [
        done ? null : talkThinkPanel(pictured),
        jsx('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' }, children: talkLog(pictured) }),
        standings.length > 1
          ? jsxs('div', { style: { border: `1px solid ${stroke}`, borderRadius: 12, padding: 10, background: card }, children: [
              jsx('div', { style: { fontSize: 12, fontWeight: 700, color: text.secondary, marginBottom: 6 }, children: 'Scores' }),
              ...standings.map(row => jsxs('div', { key: `score-${row.seat}`, style: { display: 'flex', justifyContent: 'space-between', fontSize: 12, color: text.secondary }, children: [
                jsx('span', { children: row.name }),
                jsx('span', { style: { color: text.primary, fontWeight: 600 }, children: String(row.score) })
              ] }))
            ] })
          : null,
        jsx('div', {
          style: { fontSize: 11, color: text.tertiary },
          children: `Model calls: ${pictured.calls ? pictured.calls.used : 0} of ${pictured.calls ? pictured.calls.cap : 0}` +
            (pictured.calls && pictured.calls.fallbacks ? ` · ${pictured.calls.fallbacks} covered by the built-in player` : '') +
            (modelName ? ` · ${modelName}` : '')
        }),
        done ? null : jsx(TalkCoachBox, { pictured, whisper, busy })
      ] })
    ]
  })
}
