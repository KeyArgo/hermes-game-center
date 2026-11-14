// ---- 20-library.js: Play, Your games and the store cards

// What each of the two home sections promises, in one sentence each.
const PLAY_NOTE = 'Only games we checked for seats, turns, a clear winner, replays, a computer opponent and a lobby.'

// The account total, read from the shelf's own /jackpot route: the CHIPS the machines play with and
// the points the person has earned. One small chip, used by the Game Center masthead and by the
// Play-while-you-wait pane under its Game and Lobby buttons: the person should be able to see what
// they have earned without opening a game. Chips first, then points, so the header shows the wallet
// and not only the points.
function PointsChip({ ctx, style }) {
  const [wallet, setWallet] = useState(null)
  useEffect(() => {
    let alive = true
    const read = async () => {
      try {
        const answer = await ctx.rest('/jackpot')
        if (!alive || !answer) return
        // One read, both numbers, from the one route the machine itself uses: the chip can never
        // drift from what a spin would spend.
        setWallet({
          chips: Number(answer.chips) || 0,
          points: Number(answer.bonus) || 0,
          record: answer.record || null
        })
      } catch {
        // A failed read leaves the last known numbers; a chip is not worth an error line.
      }
    }
    read()
    const timer = setInterval(read, 20000)
    return () => { alive = false; clearInterval(timer) }
  }, [ctx])
  if (wallet === null) return null
  const { chips, points } = wallet
  const r = wallet.record || {}
  const total = (Number(r.wins) || 0) + (Number(r.losses) || 0) + (Number(r.draws) || 0)
  return jsx('span', {
    'data-points': String(points),
    'data-chips': String(chips),
    title: `Chips: ${chips} — what the machines play with. Points: ${points} — 100 per game won, 10 per 1M tokens in or out`,
    style: Object.assign({
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 999,
      border: `1px solid ${stroke}`, fontSize: 11, color: text.secondary, whiteSpace: 'nowrap'
    }, style || {}),
    children: [
      jsx('b', { style: { color: text.primary }, children: `${SM_chips(chips)} chips` }, 'chips'),
      jsx('span', { 'data-points-value': String(points), style: { color: text.tertiary }, children: `${SM_chips(points)} pts` }, 'pts'),
      total ? jsx('span', { 'data-record': `${r.wins || 0}-${r.losses || 0}`, children: `${r.wins || 0}W ${r.losses || 0}L` }, 'rec') : null
    ]
  })
}

// One line for the whole shelf, so the page says "experiment" once instead of four times. It sells
// them by being honest about what an experiment is for: trying something early, breaking it, and
// saying so.
const EXPERIMENTS_NOTE = 'Work in progress, shown here so you can see what is coming: games other plugins installed, and prototypes still being built. Nothing here is rated or in a lobby, and nothing here opens yet - if one is good, tell me and it graduates to Play.'
const YOUR_NOTE = EXPERIMENTS_NOTE

// Submit your game goes to the configured page. When that is unset, the guide link is shown
// instead, so the button never opens nothing.
function submitTarget(submit) {
  const url = String((submit && submit.url) || '')
  const docs = String((submit && submit.docs) || '')
  if (/^https:\/\//i.test(url)) return { href: url, label: 'Submit your game' }
  if (/^https:\/\//i.test(docs)) return { href: docs, label: 'How to submit a game' }
  return { href: '', label: 'Submit your game' }
}

// The three ways out to the project itself, and the only links on the main screen that leave Hermes.
// Every address is a fixed https page on the repository, and the click is
// handed to the person's own browser through the same openInBrowser door the Submit button and the
// community shelf use — nothing is ever framed or navigated inside Hermes. The guide link is the
// file the repo ships at docs/SUBMIT-A-GAME.md (docs/ADD-YOUR-GAME.md is its shorter sibling).
const GAMES_REPO = 'https://github.com/KeyArgo/hermes-game-center'
const GAMES_LINKS = [
  { id: 'report', label: 'Report a problem', href: GAMES_REPO + '/issues/new',
    title: 'Open a new issue on the Game Center repository in your browser' },
  { id: 'contribute', label: 'Contribute', href: GAMES_REPO,
    title: 'The Game Center repository on GitHub, in your browser' },
  { id: 'add', label: 'Add your own game', href: GAMES_REPO + '/blob/main/docs/SUBMIT-A-GAME.md',
    title: 'How to add a game: docs/SUBMIT-A-GAME.md on GitHub, in your browser' }
]

// One row, three quiet links, drawn near Experimental / Settings / Community creations. Each is the
// shared textLink, so it looks like the side links beside it and a keyboard can reach it.
function GameCenterLinks({ ctx, onNote }) {
  return jsx('div', {
    'data-games-links': 'repo',
    style: { display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', minWidth: 0 },
    children: GAMES_LINKS.map(link => textLink(
      link.label,
      () => openInBrowser(ctx, link.href, onNote),
      link.title,
      link.id
    ))
  })
}

// A Play card: a curated, match-ready game. Pressing it opens Game Center's own table. It carries
// the same data-game-tile handle the pane's own picker uses, so both surfaces name a game the same
// way and a real-browser test can drive either by it (Slots opens the Jackpot machine — see
// playing === 'slots' in 70-home.js).
function playTile(item, onOpen, waiting = 0) {
  return jsxs('button', {
    type: 'button',
    'aria-label': item.title,
    'data-game-tile': item.id,
    onClick: () => onOpen(item.id),
    style: {
      textAlign: 'left',
      padding: 0,
      borderRadius: 12,
      background: card,
      color: 'inherit',
      cursor: 'pointer',
      overflow: 'hidden',
      minWidth: 0
    },
    children: [
      // Every board is drawn to the same 130 px stage and centred in it, so the grid of
      // tiles has one rhythm whatever the board's own shape is.
      jsx('div', {
        style: { height: 130, overflow: 'hidden', background: paper, display: 'flex', alignItems: 'center', justifyContent: 'center' },
        children: coverArt(item.id, 130)
      }),
      jsxs('div', {
        style: { padding: '11px 13px 13px', display: 'flex', flexDirection: 'column', gap: 4 },
        children: [
          jsx('div', { style: { fontFamily: DISPLAY_FONT, fontSize: 17, lineHeight: 1.2, letterSpacing: '-.01em', fontWeight: 600 }, children: item.title }),
          item.subtitle
            ? jsx('div', { style: { fontSize: 12, fontStyle: 'italic', color: text.secondary }, children: item.subtitle })
            : null,
          jsx('div', { style: { fontSize: 12, color: text.tertiary, lineHeight: 1.35 }, children: item.summary }),
          jsx('div', { style: { fontSize: 12, color: text.secondary }, children: 'Ready to play' }),
          waiting > 0 ? jsx('span', { style: { alignSelf: 'flex-start', padding: '2px 7px', borderRadius: 10, background: fill, color: text.secondary, fontSize: 12 }, children: `${waiting} waiting` }) : null
        ]
      })
    ]
  })
}

// A card in the Experimental section: the title, the plugin it came from, one plain line about what
// it is not - and no way in. The section is visible but locked, so this card is drawn like every
// other locked card (labsLockStyle/labsLockTag in 27-labs.js). The `onOpen`
// the page still passes is deliberately not wired: a locked card has no handler at all.
function YourGameCard({ item }) {
  return jsxs('div', {
    'data-your-game': item.id,
    'aria-disabled': 'true',
    tabIndex: 0,
    title: LABS_LOCK_TITLE,
    style: labsLockStyle({
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      gap: 6,
      borderRadius: 14,
      padding: 16,
      background: card
    }),
    children: [
      jsxs('div', { style: { minWidth: 0 }, children: [
        jsxs('div', {
          style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
          children: [
            jsx('div', { style: { fontWeight: 700, fontSize: 16 }, children: item.title }),
            labsLockTag()
          ]
        }),
        item.subtitle
          ? jsx('div', { style: { fontSize: 12, fontStyle: 'italic', color: text.secondary, marginTop: 2 }, children: item.subtitle })
          : null,
        jsx('div', { style: { fontSize: 12, color: text.tertiary, marginTop: 2 }, children: `From ${item.plugin || 'another plugin'}` }),
        jsx('div', { style: { fontSize: 12, color: text.secondary, marginTop: 4 }, children: item.line || 'Opens in its own screen. No lobby or matchmaking.' })
      ] }),
      // Where the Open button used to be: the same sentence, without a door.
      jsx('div', { style: { fontSize: 12, color: text.tertiary, marginTop: 6 }, children: 'Locked for now — this one opens when it is ready.' })
    ]
  })
}

// A suggestion in Your games: a game plugin Game Center knows by name that is not running on this
// computer, or is installed and turned off. A suggestion is a card, never a shop: what it is, the
// plain truth about its state, and one button to its catalog page. Hermes's own catalog page is
// where an install happens, after the person agrees there; Game Center never installs anything.
const SUGGESTION_NOTE = 'Game plugins Game Center knows by name that are not running here. The button opens the catalog page, where Hermes does the install itself.'

function SuggestionCard({ item, ctx }) {
  const [note, setNote] = useState('')
  const catalog = String(item.catalog || '')
  const open = async () => {
    if (!/^https:\/\//i.test(catalog)) {
      setNote('This suggestion has no catalog page Game Center can open. In chat, hermes plugins search finds it.')
      return
    }
    try {
      const opened = ctx && ctx.os && typeof ctx.os.openExternal === 'function'
        ? await ctx.os.openExternal(catalog)
        : false
      if (!opened) setNote(`Could not open ${catalog} in your browser.`)
    } catch {
      setNote(`Could not open ${catalog} in your browser.`)
    }
  }
  const off = item.state === 'installed-off'
  return jsxs('div', {
    'data-suggestion': item.id,
    style: {
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      gap: 6,
      borderRadius: 14,
      padding: 16,
      background: card,
      minWidth: 0
    },
    children: [
      jsxs('div', { style: { minWidth: 0 }, children: [
        jsxs('div', {
          style: { display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' },
          children: [
            jsx('div', { style: { fontWeight: 400, fontSize: 14, color: text.secondary }, children: item.title }),
            jsx('span', {
              style: { fontSize: 12, color: text.tertiary, border: `1px solid ${stroke}`, borderRadius: 999, padding: '1px 7px', whiteSpace: 'nowrap' },
              children: off ? 'Installed · Turned off' : 'Not installed'
            })
          ]
        }),
        jsx('div', {
          style: { fontSize: 12, color: text.tertiary, marginTop: 2 },
          children: `${item.maker ? `by ${item.maker}` : 'Hermes catalog'} · ${off ? 'turned off on this machine' : 'not on this machine'}`
        }),
        jsx('div', { style: { fontSize: 12, color: text.secondary, marginTop: 4, lineHeight: 1.35 }, children: item.summary }),
        item.note
          ? jsx('div', { style: { fontSize: 12, color: text.tertiary, marginTop: 4 }, children: item.note })
          : null,
        item.line
          ? jsx('div', { style: { fontSize: 12, color: text.tertiary, marginTop: 4, lineHeight: 1.35 }, children: item.line })
          : null
      ] }),
      note
        ? jsx('div', { role: 'status', 'aria-live': 'polite', style: { fontSize: 12, color: text.secondary }, children: note })
        : null,
      jsx('div', { style: { display: 'flex', gap: 8, marginTop: 6 }, children: [
        textLink('Open catalog page', open, `Open the ${item.title} catalog page`)
      ] })
    ]
  })
}

// Suggestions are capped, because five names in a row is a shop and Your games is not one. The one
// line underneath says how many more there are, so the cap is never a silent lie.
const SUGGESTION_CAP = 3

function suggestionRow(list, ctx) {
  const shown = list.slice(0, SUGGESTION_CAP)
  const rest = list.length - shown.length
  if (!shown.length) return null
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, marginTop: 14 },
    children: [
      jsx('div', {
        style: { fontSize: 12, letterSpacing: '0.12em', textTransform: 'uppercase', color: text.tertiary },
        children: 'More in the Hermes catalog · not installed'
      }),
      jsx('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))', gap: 12 },
        children: shown.map(item => jsx(SuggestionCard, { item, ctx }, item.id))
      }),
      rest > 0
        ? jsx('div', {
            style: { fontSize: 12, color: text.tertiary },
            children: `${rest} more game plugin${rest === 1 ? '' : 's'} ${rest === 1 ? 'is' : 'are'} on the Hermes catalog.`
          })
        : null
    ]
  })
}
