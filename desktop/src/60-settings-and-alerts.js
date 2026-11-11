// ---- 60-settings-and-alerts.js: the welcome, Settings and the quiet alert line

// Owner's ask, 2026-11-09: no alerts in any game for now. One switch, so every surface that could
// raise one - the line on the page, the pane's list, the desktop notification - is silent together,
// and bringing them back is this one line. The components stay in the bundle.
const ALERTS_OFF = true
// ---------------------------------------------------------------------------
// First run, Settings and the quiet "someone wants a match" alert.
//
// Nothing here goes anywhere. The rows the alert shows come from /alerts, which
// reads this Hermes's own /games looking list: people in this Hermes and the
// chats it shares. No popup, no sound, no focus steal, and the badge is only a
// small number on the Games item already in the status bar.
const WELCOME_LINE = 'Game Center is where you play the board games that come with Hermes — against the computer, your own agent, or someone here.'
const HERE_LINE = 'People in this Hermes and the chats it shares.'
const MATCH_LINE = 'Tell me when someone wants a match'

// One switch: a title, a plain sentence, and On / Off. The whole row is not a
// button, so a stray click next to it changes nothing.
function toggleRow({ title, note, on, onToggle, name }) {
  const says = name ? `${MATCH_LINE}: ${name}` : title
  return jsxs('div', {
    style: { display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', borderBottom: `1px solid ${stroke}` },
    children: [
      jsxs('div', {
        style: { minWidth: 0 },
        children: [
          jsx('div', { style: { fontSize: 13, color: text.primary }, children: title }),
          note ? jsx('div', { style: { fontSize: 11, color: text.tertiary, marginTop: 2 }, children: note }) : null
        ]
      }),
      button(on ? 'On' : 'Off', onToggle, { primary: on, label: says, title: says })
    ]
  })
}

// The welcome: what this is, a name that is already filled in, and the games a
// person would play with someone. Continue and Skip both end it for good.
function WelcomePanel({ view, ctx, onDone }) {
  const setup = view.setup || {}
  const [name, setName] = useState(setup.name || setup.suggested_name || '')
  const [games, setGames] = useState(() => Object.keys(setup.watched || {}))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const list = view.play || []

  const pick = id => setGames(current => (current.includes(id) ? current.filter(item => item !== id) : current.concat([id])))

  const finish = async body => {
    setBusy(true)
    try {
      const answer = await ctx.rest('/setup', { method: 'POST', body: { ...body, done: true } })
      if (answer && answer.ok === false) {
        setNote(answer.text || 'That name did not work. Try another.')
        setBusy(false)
        return
      }
      setBusy(false)
      onDone(answer)
    } catch (failure) {
      setNote((failure && failure.message) || 'Game Center could not save that. Try again.')
      setBusy(false)
    }
  }

  return jsx('div', {
    className: 'games-welcome',
    style: { padding: 18, background: paper, height: '100%', overflow: 'auto' },
    children: jsxs('div', {
      style: { maxWidth: 620, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14, border: `1px solid ${stroke}`, borderRadius: 16, padding: 22, background: card },
      children: [
        jsx('div', { style: { fontWeight: 700, fontSize: 24, letterSpacing: '-0.03em' }, children: 'Welcome to Game Center' }),
        jsx('div', { style: { fontSize: 14, lineHeight: 1.5, color: text.secondary }, children: WELCOME_LINE }),
        jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: 'No account, no email, nothing sent anywhere. About 20 seconds.' }),
        jsxs('div', {
          style: { display: 'flex', flexDirection: 'column', gap: 6 },
          children: [
            jsx('div', { style: { fontSize: 13, fontWeight: 650 }, children: 'Pick a name' }),
            jsx('div', { style: { display: 'flex', gap: 8 }, children: [
              field(name, setName, setup.suggested_name || 'Your name', () => {}, { label: 'Your name' }),
              button('Use this', () => setName(setup.suggested_name || ''), { disabled: !setup.suggested_name, title: 'Use the name Game Center suggests' })
            ] }),
            jsx('div', { style: { fontSize: 11, color: text.tertiary }, children: 'This is the name other players see. You can change it later in Settings.' })
          ]
        }),
        list.length
          ? jsxs('div', {
              style: { display: 'flex', flexDirection: 'column', gap: 6 },
              children: [
                jsx('div', { style: { fontSize: 13, fontWeight: 650 }, children: 'Games you would play with someone' }),
                jsx('div', { style: { fontSize: 11, color: text.tertiary }, children: 'Optional. A game switched on shows a quiet badge when someone here wants a match.' }),
                jsx('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' }, children: list.map(game =>
                  button(game.title, () => pick(game.id), { primary: games.includes(game.id), label: `Play with someone: ${game.title}`, title: games.includes(game.id) ? `${game.title}: on` : `${game.title}: off` })
                ) })
              ]
            })
          : null,
        note ? jsx('div', { role: 'status', 'aria-live': 'polite', style: { fontSize: 12, color: text.primary }, children: note }) : null,
        jsxs('div', {
          style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', paddingTop: 4 },
          children: [
            button('Continue', () => finish({ name: name.trim(), games }), { primary: true, disabled: busy, title: 'Save this name and start playing' }),
            button('Skip for now', () => finish({}), { disabled: busy, title: 'Start playing without a name; you can set one in Settings' })
          ]
        })
      ]
    })
  })
}

// Settings: the name, one switch per Play game, a pause, and whether AI seats
// may play here. Every change is saved as it is made.
//
// The version chip lives at the top of THIS panel (owner, 2026-11-10: "keep everything in the status
// bar except the version chip. The version chip lives in Settings"), so it is on the full-screen
// Settings screen and on the play-while-you-wait pane's own Settings view, both drawn by this one
// component. The three navigation hooks are optional because they only make sense on the full page:
// the pane welds a way back to itself and no links it cannot honour. Everything else — every row,
// every switch, every route — is shared, so the two views cannot drift apart.
function SettingsPanel({ view, ctx, onBack, onSaved, onReopen, skin, onSkin, backLabel, backTitle, onCommunity }) {
  const setup = view.setup || {}
  const [name, setName] = useState(setup.name || setup.suggested_name || '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const list = view.play || []
  const watched = setup.watched || {}
  const player = view.player || {}

  const save = async (body, said) => {
    setBusy(true)
    try {
      const answer = await ctx.rest('/settings', { method: 'POST', body })
      if (answer && answer.ok === false) setNote(answer.text || 'That did not save.')
      else setNote(said || answer.text || 'Saved.')
      if (onSaved) await onSaved()
    } catch (failure) {
      setNote((failure && failure.message) || 'Game Center could not save that. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const reopen = async () => {
    try {
      await ctx.rest('/setup', { method: 'POST', body: { reopen: true } })
    } catch { /* the welcome shows again on the next refresh, or not at all */ }
    // Read the shelf again before showing it: the welcome is drawn from the saved
    // answer, so without this the page would open on the games and be replaced by the
    // welcome on the next poll, possibly in the middle of something.
    if (onReopen) await onReopen()
  }

  // Navigation, not settings: each link is drawn only for a surface that can honour it, so the pane's
  // Settings view never offers a door that would land somewhere else than it says.
  const links = [
    onReopen ? textLink('Show the welcome again', reopen) : null,
    onCommunity ? textLink('Community creations', () => onCommunity()) : null
  ].filter(Boolean)

  return jsx('div', {
    className: 'games-settings',
    style: { padding: 18, background: paper, height: '100%', overflow: 'auto' },
    children: jsxs('div', {
      style: { maxWidth: 620, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 },
      children: [
        // The install in view, at the top of Settings and nowhere else: not the status bar, not the
        // Games header, not the foot of the pane.
        jsx('div', {
          'data-games-version-top': '1',
          style: { display: 'flex', justifyContent: 'flex-end', minWidth: 0 },
          children: jsx(GamesVersionChip, { ctx })
        }),
        jsxs('div', {
          style: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'start', flexWrap: 'wrap' },
          children: [
            jsxs('div', { children: [
              jsx('div', { style: { fontWeight: 700, fontSize: 22, letterSpacing: '-0.03em' }, children: 'Game Center settings' }),
              jsx('div', { style: { fontSize: 12, color: text.tertiary, marginTop: 4 }, children: 'Everything here stays on this machine.' })
            ] }),
            button(backLabel || 'Back to Game Center', () => onBack('games'), { title: backTitle || 'Back to the games' })
          ]
        }),
        jsxs('section', {
          'aria-label': 'Your name',
          style: { display: 'flex', flexDirection: 'column', gap: 6, border: `1px solid ${stroke}`, borderRadius: 12, padding: 14, background: card },
          children: [
            heading('Your name'),
            jsx('div', { style: { display: 'flex', gap: 8 }, children: [
              field(name, setName, 'Your name', () => save({ name: name.trim() }), { label: 'Your name' }),
              button('Save name', () => save({ name: name.trim() }), { primary: true, disabled: busy || !name.trim() })
            ] }),
            jsx('div', { style: { fontSize: 11, color: text.tertiary }, children: player.named ? `You are ${player.name}. This is the name other players see.` : 'Other players see this name. Game Center does not ask for an account or an email.' })
          ]
        }),
        jsxs('section', {
          'aria-label': 'Match alerts',
          style: { display: 'flex', flexDirection: 'column', gap: 4, border: `1px solid ${stroke}`, borderRadius: 12, padding: 14, background: card },
          children: [
            heading('When someone wants a match'),
            jsx('div', { style: { fontSize: 11, color: text.tertiary, marginBottom: 6 }, children: `${HERE_LINE} Nothing is searched on the internet.` }),
            list.length
              ? jsx('div', { children: list.map(game =>
                  toggleRow({
                    title: game.title,
                    note: MATCH_LINE,
                    name: game.title,
                    on: Boolean(watched[game.id]),
                    onToggle: () => save({ watch: { [game.id]: !watched[game.id] } })
                  })
                ) })
              : jsx('div', { style: { fontSize: 13, color: text.tertiary }, children: 'No curated games to watch yet.' }),
            toggleRow({
              title: 'Pause all of these',
              note: 'No badge and no line until you switch this back on.',
              on: Boolean(setup.paused),
              onToggle: () => save({ paused: !setup.paused })
            })
          ]
        }),
        jsxs('section', {
          'aria-label': 'AI seats',
          style: { display: 'flex', flexDirection: 'column', gap: 4, border: `1px solid ${stroke}`, borderRadius: 12, padding: 14, background: card },
          children: [
            heading('AI seats'),
            toggleRow({
              title: 'Let AI seats play here',
              note: 'Off means no game here seats an AI. On still asks you at the table each time.',
              on: Boolean(setup.allow_ai),
              onToggle: () => save({ allow_ai: !setup.allow_ai })
            }),
            jsx('div', { style: { fontSize: 11, color: text.tertiary, marginTop: 6 }, children: setup.ai_choice === null || setup.ai_choice === undefined ? "Starts from the plugin's own setting. What you choose here wins." : 'Your choice here wins over the plugin setting.' })
          ]
        }),
        jsxs('section', {
          'aria-label': 'Sound',
          style: { display: 'flex', flexDirection: 'column', gap: 4, border: `1px solid ${stroke}`, borderRadius: 12, padding: 14, background: card },
          children: [
            heading('Sound'),
            jsx(SoundSetting, {}, 'sound')
          ]
        }),
        // The Jackpot cabinet's own switch, in Settings too (owner's ask, 2026-11-11): the SAME
        // component the cabinet's panel and the status bar draw, reading and writing the same three
        // keys — so the two Settings views (the page's and the play-while-you-wait pane's, which is
        // this very component) can never drift from the machine. Guarded by name so a bundle built
        // without the layer part still draws Settings.
        typeof Jackpot2OverChatControls === 'function' ? jsxs('section', {
          'aria-label': 'Jackpot over the chat',
          style: { display: 'flex', flexDirection: 'column', gap: 4, border: `1px solid ${stroke}`, borderRadius: 12, padding: 14, background: card },
          children: [
            heading('Jackpot over the chat'),
            jsx('div', {
              style: { fontSize: 11, color: text.tertiary, marginBottom: 6 },
              children: 'Float the Jackpot cabinet over the conversation, and set how big and how see-through it is. The same switch as the status bar and the cabinet’s own panel.'
            }),
            jsx(Jackpot2OverChatControls, { ctx, tone: 'settings' })
          ]
        }) : null,
        jsxs('section', {
          'aria-label': 'Look',
          style: { display: 'flex', flexDirection: 'column', gap: 4, border: `1px solid ${stroke}`, borderRadius: 12, padding: 14, background: card },
          children: [
            heading('Look'),
            skinToggle(skin, onSkin)
          ]
        }),
        note ? jsx('div', { role: 'status', 'aria-live': 'polite', style: { fontSize: 12, color: text.secondary }, children: note }) : null,
        links.length
          ? jsx('div', {
              style: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
              children: links
            })
          : null
      ]
    })
  })
}

// The quiet line on the home page. No dialog, no sound: it appears above Play,
// says who wants what, and offers Join and Dismiss.
function AlertLine({ alerts, onJoin, onDismiss }) {
  const rows = (alerts && alerts.rows) || []
  const total = Math.max(Number((alerts && alerts.count) || 0), rows.length)
  if (!rows.length) return null
  return jsxs('div', {
    className: 'games-alert',
    role: 'status',
    'aria-live': 'polite',
    style: { display: 'flex', flexDirection: 'column', gap: 6, border: `1px solid ${accent}`, borderRadius: 10, padding: '10px 12px', background: card },
    children: [
      jsx('div', { style: { fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: text.tertiary }, children: rows.length === 1 ? 'Someone wants a match' : 'People want a match' }),
      ...rows.map(row => jsxs('div', {
        style: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' },
        children: [
          jsx('div', {
            style: { fontSize: 13, color: text.primary, minWidth: 0 },
            // The address is shown when the person gave one with /games looking, so
            // nothing they typed is dropped. Join still only opens our own table: this
            // build has no way to reach another machine, and the line does not pretend.
            children: `${row.name} is looking for a ${row.title || row.game} match${row.where ? ` at ${row.where}` : ''}.`
          }),
          jsxs('div', {
            style: { display: 'flex', gap: 6 },
            children: [
              button('Join', () => onJoin(row), { primary: true, label: `Join ${row.name} at ${row.title || row.game}`, title: `Open the ${row.title || row.game} table` }),
              button('Dismiss', () => onDismiss(row), { label: `Dismiss ${row.name} at ${row.title || row.game}`, title: 'Hide this until they look again' })
            ]
          })
        ]
      }, row.key || `${row.game}:${row.name}`)),
      total > rows.length
        ? jsx('div', { style: { fontSize: 12, color: text.secondary }, children: `${total - rows.length} more ${total - rows.length === 1 ? 'person' : 'people'} are looking too; the count on Games has everyone.` })
        : null,
      jsx('div', { style: { fontSize: 11, color: text.tertiary }, children: HERE_LINE })
    ]
  })
}

