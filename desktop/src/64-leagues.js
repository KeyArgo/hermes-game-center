// ---- 64-leagues.js: bots, leagues, card bouts and watching, inside the Lobby tab
//
// Everything here comes from the server's own answer (shelf/online_source.py caches it
// for twenty seconds). No number on this screen is invented: a section with nothing to
// show says so, in a sentence a person can act on.
//
// The plugin's jsx() takes children inside the props object (that is the shape the rest
// of these parts use), so every element here is written as jsx(tag, { …, children }).

// FUTURE(2026-11-11): the Stock league "Read the design" — remove if never built.
// A stock league plays a server-owned character instead of somebody's own bot: it is designed
// (docs/STOCK-LEAGUE.md) and not built, and its "Read the design" button opened a short list of
// what it would need. The row is kept whole; this line keeps it off the screen, so completing the
// design is un-hiding it rather than rebuilding it.
const STOCK_LEAGUE_OFF = true

function leagueOf(online) {
  const league = (online && online.league) || {}
  const rows = value => (Array.isArray(value) ? value.filter(row => row && typeof row === 'object') : [])
  return {
    ranked: rows(league.ranked_games),
    casual: rows(league.casual_games),
    pairLegs: Number(league.pair_legs || 2),
    live: rows(league.live),
    passports: rows(league.passports),
    challenges: rows(league.challenges),
    cards: rows(league.cards),
    open: league.open || {},
    stock: league.stock || {},
    at: Number(league.at || 0)
  }
}

function leagueGameName(row) {
  return String((row && (row.title || row.id)) || '')
}

function bestRating(bot) {
  const games = Array.isArray(bot && bot.games) ? bot.games : []
  if (!games.length) return 'No rated games yet'
  const best = games.slice().sort((one, two) => Number(two.rating || 0) - Number(one.rating || 0))[0]
  return `${leagueGameName(best)} ${best.rating}${best.provisional ? ' (provisional)' : ''}`
}

function smallLine(text, style) {
  return jsx('div', { style: { fontSize: 12, color: text.tertiary, lineHeight: 1.45, ...(style || {}) }, children: text })
}

// One bot's row: name, owner, best rating, and the way in.
function passportRow(bot, onChallenge, ctx, lobbyBase, setNote) {
  return jsx('div', {
    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderTop: `1px solid ${stroke}` },
    children: [
      jsx('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
        children: [
          jsx('div', { style: { fontSize: 12, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: bot.name }),
          smallLine(`${bot.owner ? `owned by ${bot.owner} · ` : ''}${bestRating(bot)}`)
        ]
      }),
      jsxs('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }, children: [
        // The passport page is a real page on the lobby server; this only hands
        // its address to the person's browser.
        browserButton(ctx, `${lobbyBase}/b/${encodeURIComponent(String(bot.id || ''))}`, setNote, {
          title: `Opens ${bot.name}'s passport at ${lobbyBase}/b/${bot.id} in your browser — the online lobby, outside Hermes.`
        }),
        button('Challenge', () => onChallenge(bot), {
          primary: true,
          title: `Ask ${bot.name}'s owner to bring it to a table. The invitation waits ten minutes.`
        })
      ] })
    ]
  })
}

function challengeCard(bot, games, busy, onPick, onSend, onCancel) {
  return jsx('div', {
    role: 'group', 'aria-label': `Challenge ${bot.name}`,
    style: { display: 'flex', flexDirection: 'column', gap: 6, border: `1px solid ${accent}`, borderRadius: 8, padding: '8px 10px' },
    children: [
      jsx('div', { style: { fontSize: 12, fontWeight: 650 }, children: `Challenge ${bot.name}` }),
      smallLine('Pick the game. The invitation goes to the bot\'s owner, who brings their bot to the table.'),
      jsx('div', {
        style: { display: 'flex', gap: 6, flexWrap: 'wrap' },
        children: games.slice(0, 8).map(game => button(leagueGameName(game), () => onPick(game.id), {
          primary: Boolean(bot.game === game.id)
        }))
      }),
      jsx('div', {
        style: { display: 'flex', gap: 6 },
        children: [
          button('Send challenge', onSend, { primary: true, disabled: busy || !bot.game }),
          button('Cancel', onCancel, { disabled: busy })
        ]
      })
    ]
  })
}

// The address always comes from the online lobby URL setting (view.online.url),
// never from a host written into this file.
function lobbyBaseOf(online) {
  return String((online && online.url) || ONLINE_URL).replace(/\/+$/, '')
}

async function openTable(room, ctx, lobbyBase) {
  const url = `${lobbyBase}/t/${encodeURIComponent(String(room && room.id ? room.id : ''))}`
  // Only a web address may reach the operating system's handler: a lobby address with
  // another scheme would hand the click to whatever registered it (openInBrowser's rule).
  if (!/^https?:\/\//i.test(url)) return url
  try {
    if (ctx && ctx.os && typeof ctx.os.openExternal === 'function') {
      await ctx.os.openExternal(url)
      return url
    }
  } catch {
    /* the address line beside the button is the fallback */
  }
  return url
}

function liveRow(room, ctx, lobbyBase) {
  const seats = Array.isArray(room.seats) ? room.seats : []
  const white = seats.find(seat => seat.side === 'white') || {}
  const black = seats.find(seat => seat.side === 'black') || {}
  return jsx('div', {
    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderTop: `1px solid ${stroke}` },
    children: [
      jsx('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
        children: [
          jsx('div', { style: { fontSize: 12, fontWeight: 650 }, children: `${white.name || 'Bot'} v ${black.name || 'Bot'}` }),
          smallLine(`${room.title || room.game} · move ${Number(room.plies || 0) + 1}${room.pair && room.pair.leg ? ` · leg ${room.pair.leg} of ${room.pair.legs}` : ''}`)
        ]
      }),
      button('Watch', () => openTable(room, ctx, lobbyBase), { title: `Opens the live table at ${lobbyBase}/t/${room.id} in your browser — the online lobby, outside Hermes. Watching is read-only.` })
    ]
  })
}

function BotsLeagues({ online, busy, call, ctx, setNote }) {
  const [challenge, setChallenge] = useState(null)
  const [cardPick, setCardPick] = useState(null)
  const [opponents, setOpponents] = useState([])
  const [bout, setBout] = useState(null)
  const [replay, setReplay] = useState('')
  const [showStock, setShowStock] = useState(false)
  const league = leagueOf(online)
  const games = league.ranked
  const lobbyBase = lobbyBaseOf(online)

  const sendChallenge = async () => {
    if (!challenge || !challenge.game) return
    const answer = await call('/online/challenge', { bot: challenge.id, game: challenge.game })
    setNote((answer && answer.text) || '')
    if (answer && answer.ok) setChallenge(null)
  }

  const loadOpponents = async game => {
    const answer = await call('/online/cards/public?game=' + encodeURIComponent(game), undefined, 'GET')
    setOpponents((answer && answer.cards) || [])
    setBout(null)
    setReplay('')
  }

  const playBout = async (mine, theirs) => {
    const answer = await call('/online/bout', { game: cardPick.game, mine, theirs })
    setNote((answer && answer.text) || '')
    if (answer && answer.ok) setBout(answer.bout || null)
  }

  const showReplay = async () => {
    if (!bout) return
    const answer = await call('/online/bout/replay?url=' + encodeURIComponent(bout.replay_url || ''), undefined, 'GET')
    if (!answer || !answer.ok) {
      setReplay('That replay could not be read.')
      return
    }
    const data = (answer.replay && answer.replay.replay) || {}
    const frames = Array.isArray(data.frames) ? data.frames : []
    const last = frames[frames.length - 1] || {}
    const events = Array.isArray(last.events) ? last.events.slice(-4).map(item => String(item)) : []
    setReplay(`Seed ${Number(bout.seed || 0)} · ${frames.length} frames${events.length ? ` · ${events.join(' · ')}` : ''}`)
  }

  const cards = league.cards.filter(card => card && card.game)
  const rankLine = league.casual.length
    ? `Ranked games are played twice on the same deal with the seats swapped, so one rating follows both legs. ${league.casual.map(leagueGameName).join(', ')} stay casual.`
    : 'Ranked games are played twice on the same deal with the seats swapped, so one rating follows both legs.'

  const challenges = league.challenges.length
    ? league.challenges.map(row => jsx('div', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderTop: `1px solid ${stroke}` },
        children: [
          jsx('div', {
            style: { display: 'flex', flexDirection: 'column', gap: 2 },
            children: [
              jsx('div', { style: { fontSize: 12, fontWeight: 650 }, children: `${row.challenger} invited ${row.bot_name}` }),
              smallLine(`${row.game} · expires in ${Math.max(0, Math.round((Number(row.expires || 0) - Date.now() / 1000) / 60))} min`)
            ]
          }),
          button('Decline', () => call('/online/challenge/decline', { id: row.id }), { disabled: busy })
        ]
      }))
    : [smallLine('No invitations right now.')]

  const live = league.live.length
    ? league.live.slice(0, 5).map(room => liveRow(room, ctx, lobbyBase))
    : [smallLine('No bot games are running.')]

  const passports = league.passports.length
    ? league.passports.slice(0, 6).map(bot => passportRow(bot, setChallenge, ctx, lobbyBase, setNote))
    : [smallLine('No bots have played yet. Your own bot appears here once it has a rated game.')]

  const cardRows = cards.length
    ? cards.map(card => jsx('div', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '5px 0', borderTop: `1px solid ${stroke}` },
        children: [
          jsx('div', {
            style: { display: 'flex', flexDirection: 'column', gap: 2 },
            children: [
              jsx('div', { style: { fontSize: 12, fontWeight: 650 }, children: card.name }),
              smallLine(`${card.game === 'doctrine_arena' ? 'Doctrine Arena' : 'Doctrine'} · ${card.rating && card.rating.games ? `rating ${card.rating.rating}` : 'unrated'}`)
            ]
          }),
          button('Play a bout', () => { setCardPick({ game: card.game, mine: card.id }); loadOpponents(card.game) }, { primary: true, disabled: busy })
        ]
      }))
    : [smallLine('No cards yet. Cards you save in Doctrine appear here.')]

  const boutPanel = cardPick ? jsx('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 6, border: `1px solid ${accent}`, borderRadius: 8, padding: '8px 10px' },
    children: [
      jsx('div', { style: { fontSize: 12, fontWeight: 650 }, children: `Opponent card (${cardPick.game === 'doctrine_arena' ? 'Arena' : 'Doctrine'})` }),
      opponents.length
        ? jsx('div', {
            style: { display: 'flex', gap: 6, flexWrap: 'wrap' },
            children: opponents.slice(0, 8).map(card =>
              button(card.name, () => playBout(cardPick.mine, card.id), { disabled: busy, title: card.owner }))
          })
        : smallLine('No other owner has a card for this game yet.'),
      jsx('div', {
        style: { display: 'flex', gap: 6 },
        children: [button('Close', () => { setCardPick(null); setOpponents([]) }, { disabled: busy })]
      }),
      bout ? jsx('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 4 },
        children: [
          jsx('div', { role: 'status', 'aria-live': 'polite', style: { fontSize: 12 }, children: bout.winner ? `${bout.winner_name} won` : 'A draw' }),
          jsx('div', {
            style: { display: 'flex', gap: 6, flexWrap: 'wrap' },
            children: [
              button('View replay', showReplay),
              // The replay itself is stored on the lobby server. bout.replay_url
              // arrives as a server-relative path (/api/card-arena/…); the button
              // prefixes the lobby URL setting to make it openable, never a guess.
              browserButton(ctx, bout.replay_url
                ? (/^https?:\/\//i.test(String(bout.replay_url)) ? String(bout.replay_url) : `${lobbyBase}${String(bout.replay_url)}`)
                : '', setNote, {
                title: bout.replay_url
                  ? `Opens this bout's replay in your browser — the online lobby, outside Hermes.`
                  : 'No replay address came back from the lobby server.'
              }),
              smallLine(`${bout.plies} frames`, { alignSelf: 'center' })
            ]
          }),
          replay ? smallLine(replay, { fontFamily: 'var(--font-mono, ui-monospace, monospace)' }) : null
        ]
      }) : null
    ]
  }) : null

  const stockNeeds = Array.isArray(league.stock.needs)
    ? league.stock.needs.map((line, index) => jsx('div', { key: `need-${index}`, children: smallLine(`• ${line}`) }))
    : []
  const stockNext = Array.isArray(league.stock.next)
    ? league.stock.next.slice(0, 2).map((line, index) => jsx('div', { key: `next-${index}`, children: smallLine(`• ${line}`) }))
    : []

  return jsx('section', {
    'aria-label': 'Bots and leagues',
    style: { display: 'flex', flexDirection: 'column', gap: 8, border: `1px solid ${stroke}`, borderRadius: 8, padding: '8px 10px' },
    children: [
      jsx('div', {
        style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
        children: [
          jsx('div', { style: { fontWeight: 650, fontSize: 13 }, children: 'Bots and leagues' }),
          badge('Labs · experiment')
        ]
      }),
      smallLine(rankLine),
      jsx('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 4 },
        children: [heading('Waiting for your bot'), ...challenges]
      }),
      jsx('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 4 },
        children: [
          heading('Watch a game'),
          ...live,
          smallLine(`Live tables open at ${lobbyBase} in your browser — the online lobby, outside Hermes. Watching is read-only.`)
        ]
      }),
      jsx('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 4 },
        children: [
          heading('Bot passports'),
          ...passports,
          challenge ? challengeCard(challenge, games, busy, game => setChallenge({ ...challenge, game }), sendChallenge, () => setChallenge(null)) : null
        ]
      }),
      jsx('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 4 },
        children: [
          heading('Card arena'),
          smallLine('Two owners\' locked Doctrine cards, played by the server. Rated, with a replay.'),
          ...cardRows,
          boutPanel
        ]
      }),
      jsx('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 4 },
        children: [
          heading('Open league'),
          jsx('div', {
            style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
            children: [
              badge(league.open.badge || 'self-hosted, unverified'),
              smallLine(`${Number(league.open.move_seconds || 30)} seconds a move`)
            ]
          }),
          smallLine(league.open.text || 'Everyone plays from their own computer. The server only referees and keeps the clock, so a seat cannot be checked: self-hosted, unverified.'),
          button('Enter the open league', () => call('/online/ladder', { action: 'start', game: (games[0] || {}).id || '', open_league: true }), {
            disabled: busy || !games.length,
            title: 'Your model plays from this computer, with a thirty-second clock.'
          })
        ]
      }),
      STOCK_LEAGUE_OFF ? null : jsx('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 4, opacity: 0.75 },
        children: [
          jsx('div', {
            style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
            children: [
              heading('Stock league'),
              badge('Labs · experiment'),
              smallLine('needs a server-side model')
            ]
          }),
          smallLine((league.stock && league.stock.text) || 'A stock league plays a server-owned character instead of someone\'s own bot. It is designed, not built.'),
          button(showStock ? 'Hide the design' : 'Read the design', () => setShowStock(!showStock), { disabled: busy }),
          showStock ? jsx('div', {
            style: { display: 'flex', flexDirection: 'column', gap: 4 },
            children: [
              smallLine('What it needs:', { fontWeight: 650, color: text.secondary }),
              ...stockNeeds,
              smallLine('The first step:', { fontWeight: 650, color: text.secondary }),
              ...stockNext
            ]
          }) : null
        ]
      })
    ]
  })
}
