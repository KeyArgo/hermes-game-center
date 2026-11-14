// ---- 40-doctrine.js: Doctrine: the card battle panel
function DoctrinePanel({ game, view, board, send, playMove, importText, refresh, ctx, onBack }) {
  const pictured = (board && board.picture) || startingPicture('doctrine')
  const d = (pictured && pictured.doctrine) || {}
  const frames = d.frames || []
  const watching = d.mode === 'watch' || d.mode === 'shared'
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [notice, setNotice] = useState('')
  const [auto, setAuto] = useState(false)
  const [index, setIndex] = useState(0)
  const [opponent, setOpponent] = useState('stone-bastion')
  const [seed, setSeed] = useState('1')
  const [pasted, setPasted] = useState('')
  const [cardText, setCardText] = useState(d.card_json || '')
  const [profile, setProfile] = useState('')
  const [panel, setPanel] = useState('')
  const [asking, setAsking] = useState(null)
  const alive = useRef(true)
  const pending = useRef(false)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => { setIndex(0); setAuto(false) }, [d.id])
  // Refresh the editor when the card really changed, but never overwrite unsaved edits.
  // A different card (new name) always replaces the editor.
  const lastCard = useRef(d.card_json || '')
  const lastName = useRef((d.your_card && d.your_card.name) || '')
  useEffect(() => {
    const next = d.card_json || ''
    const name = (d.your_card && d.your_card.name) || ''
    if (!next) return
    if (name !== lastName.current) {
      setCardText(next)
      lastCard.current = next
      lastName.current = name
      return
    }
    if (next !== lastCard.current) {
      const previous = lastCard.current
      setCardText(current => (current === previous ? next : current))
      lastCard.current = next
    }
  }, [d.card_json, d.your_card && d.your_card.name])
  useEffect(() => {
    if (!auto || !watching || !frames.length) return
    if (index >= frames.length - 1) { setAuto(false); return }
    const timer = setTimeout(() => setIndex(value => Math.min(value + 1, frames.length - 1)), WATCH_MS)
    return () => clearTimeout(timer)
  }, [auto, watching, index, frames.length])

  const run = async action => {
    if (pending.current || !alive.current) return false
    pending.current = true
    setBusy(true)
    setFailure('')
    try {
      const answer = await action()
      if (answer && answer.ok === false) throw new Error(answer.text || 'The table refused that action.')
      if (alive.current) setNotice((answer && answer.text) || '')
      return true
    } catch (error) {
      if (alive.current) setFailure(error.message || 'That did not reach the table.')
      return false
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }
  const command = line => run(() => send(`doctrine ${line}`))
  // Asking the person's own model (Improve my bot) can take a while: say so.
  const askFor = async (what, action) => {
    if (alive.current) setAsking(what)
    try {
      return await run(action)
    } finally {
      if (alive.current) setAsking(null)
    }
  }
  const importValue = text => run(async () => {
    // A replay is far bigger than one /command line, so the backend has a second door.
    const answer = importText ? await importText(text) : await send(`doctrine import ${text}`)
    if (refresh) await refresh()
    return answer
  })

  const at = Math.min(index, Math.max(0, frames.length - 1))
  const frame = watching ? frames[at] || null : frames[frames.length - 1] || null
  const shownPicture = {
    ...pictured,
    view: 'hex',
    game: 'doctrine',
    cells: (frame && frame.board) || pictured.cells || emptyGrid(11, 11),
    legal: watching ? [] : pictured.legal || []
  }
  const interactive = Boolean(!watching && d.can_move && !busy)
  const rows = (d.scoreboard || []).map(row => {
    const units = frame && frame.units && frame.units[row.id]
    const score = frame && frame.scores && frame.scores[row.id] !== undefined ? frame.scores[row.id] : row.score
    const beacons = frame && frame.beacons && frame.beacons[row.id] !== undefined ? frame.beacons[row.id] : row.beacons
    return {
      ...row,
      score,
      beacons,
      units: units ? units.length : row.units,
      hp: units ? units.reduce((total, unit) => total + (unit.hp || 0), 0) : row.hp
    }
  })
  const sentence = frame && frame.events && frame.events.length
    ? frame.events.join(' · ')
    : d.sentence || ''
  const leftToMove = Object.keys(d.legal_units || {}).length
  const houseOptions = (d.house || []).map(card => jsx('option', { value: card.id, children: card.name }, card.id))
  // "Your card" also lists this person's saved, improved and imported cards,
  // not only the four house cards.
  const cardOptions = (d.cards || d.house || []).map(card => jsx('option', {
    value: card.id,
    children: card.origin === 'yours' && !String(card.name).endsWith('(yours)') ? `${card.name} (yours)` : card.name
  }, `${card.id}:${card.name}`))
  const cardChoices = d.cards || d.house || []
  const yourId = cardChoices.find(card => card.current === true)
    || cardChoices.find(card => d.your_card
      && String(card.name).replace(' (yours)', '') === d.your_card.name)
  const download = async kind => {
    const answer = await send(kind ? `doctrine export ${kind}` : 'doctrine export')
    const value = answer && answer.text
    if (!value) { setFailure('Nothing to export yet.'); return }
    try {
      if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
        setNotice(value.slice(0, 400))
        return
      }
      const url = URL.createObjectURL(new Blob([value], { type: 'application/json' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = kind ? 'doctrine-replay.json' : 'doctrine-card.json'
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice(`Saved ${anchor.download}.`)
    } catch (error) {
      setFailure('This window cannot save files. Copy the JSON instead.')
    }
  }
  const readFile = async event => {
    const file = event.target.files && event.target.files[0]
    if (!file) return
    try {
      const text = await file.text()
      await importValue(text)
    } catch (error) {
      setFailure('That file could not be read.')
    }
    event.target.value = ''
  }

  return jsxs('div', {
    className: 'games-play-table doctrine-panel',
    style: { display: 'flex', flexDirection: 'column', gap: 12, padding: 18, paddingBottom: 96, minWidth: 0, overflow: 'auto', background: paper, height: '100%' },
    children: [
      jsxs('div', {
        style: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' },
        children: [
          jsx('div', { style: { fontWeight: 700, fontSize: 22 }, children: game.title || 'Doctrine' }),
          jsxs('div', { style: { display: 'flex', gap: 8 } , children: [
            jsx(LearnButton, { game, ctx }),
            button('Back', () => { alive.current = false; onBack() })
          ] })
        ]
      }),
      jsxs('div', {
        style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 12, color: text.secondary },
        children: [
          badge(d.mode === 'human' ? 'You against a card' : d.mode === 'watch' ? 'Watching bots' : d.mode === 'shared' ? 'Shared replay' : 'Choose a match'),
          badge(frames.length ? `Turn ${frame ? frame.turn : 0} of ${frames.length}` : d.mode === 'human' ? `Turn ${d.turn} of ${d.max_turns}` : 'No battle yet'),

          jsx('span', { style: { color: text.tertiary }, children: `Your card: ${(d.your_card && d.your_card.name) || 'none'}` })
        ]
      }),
      jsxs('section', {
        'aria-label': 'Score panel',
        style: { border: `1px solid ${stroke}`, borderRadius: 12, padding: 10, background: card, display: 'flex', flexDirection: 'column', gap: 6 },
        children: [
          heading('Score panel'),
          ...(rows.length ? rows.map(row => jsxs('div', {
            style: {
              display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) repeat(3, auto)', gap: 10, alignItems: 'baseline',
              fontFamily: 'var(--font-mono, monospace)', fontSize: 12, color: row.units === 0 ? text.tertiary : text.secondary
            },
            children: [
              jsx('span', { style: { color: text.primary, fontWeight: row.you ? 700 : 500, overflowWrap: 'anywhere' }, children: `${row.name}${row.you ? ' (you)' : ''}` }),
              jsx('span', { children: `${row.units} units · ${row.hp} hp` }),
              jsx('span', { children: `${row.beacons} beacons` }),
              jsx('b', { style: { color: text.primary }, children: String(row.score) })
            ]
          }, row.id)) : [jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: 'Start a match to see units, beacons and score.' })])
        ]
      }),
      jsx('div', {
        className: 'doctrine-board-panel',
        style: { display: 'flex', justifyContent: 'center', padding: 8, background: card, border: `1px solid ${stroke}`, borderRadius: 12, overflow: 'hidden' },
        children: jsx(BoardSvg, {
          picture: shownPicture,
          height: 460,
          flat: true,
          interactive,
          onMove: token => { if (interactive) run(() => playMove('doctrine', token)) }
        })
      }),
      jsxs('div', {
        role: 'status', 'aria-live': 'polite',
        style: { display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', fontSize: 13 },
        children: [
          jsx('b', { children: d.status === 'active' ? (d.can_move ? `Your turn — ${leftToMove} unit${leftToMove === 1 ? '' : 's'} still to move` : 'The bots are taking their turns') : d.status === 'idle' ? 'Pick a match below' : d.status === 'won' || d.status === 'draw' ? 'Battle finished' : d.status }),
          jsx('span', {
            className: 'games-waiting',
            style: { color: text.tertiary },
            children: busy ? (waitingLine(asking, { kind: 'agent', name: 'Your bot' }) || 'Sending…') : notice
          })
        ]
      }),
      sentence ? jsx('div', {
        role: 'status',
        style: { padding: '9px 12px', borderRadius: 8, border: `1px solid ${stroke}`, fontSize: 13, color: text.secondary, background: card },
        children: sentence
      }) : null,
      // Watch it think, Doctrine flavour: the working that led to the card it
      // just wrote. It is the person's own card, so only this screen has it.
      d.prep ? jsxs('section', {
        'aria-label': 'How it wrote this card',
        className: 'games-doctrine-prep',
        style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, border: `1px solid ${stroke}`, borderRadius: 12, background: card },
        children: [
          talkThinkHeading('How it wrote this card'),
          jsx('div', { style: { fontSize: 12, color: text.secondary }, children: `It wrote ${d.prep.name || 'a new card'}.` }),
          talkReadRows(d.prep),
          d.prep.scratch
            ? jsx('div', {
                className: 'games-think-scratch',
                style: {
                  fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 11.5, lineHeight: 1.45,
                  color: text.secondary, background: fill, border: `1px solid ${stroke}`, borderRadius: 8,
                  padding: '8px 9px', whiteSpace: 'pre-wrap', maxHeight: 160, overflowY: 'auto'
                },
                children: d.prep.scratch
              })
            : null,
          d.prep.action
            ? jsx('div', { className: 'games-think-action', style: { fontSize: 11, color: text.tertiary }, children: d.prep.action })
            : null
        ]
      }) : null,
      watching ? jsxs('div', {
        style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
        children: [
          button('Restart', () => { setAuto(false); setIndex(0) }, { disabled: !frames.length }),
          button('Step', () => setIndex(value => Math.min(value + 1, Math.max(0, frames.length - 1))), { disabled: !frames.length || at >= frames.length - 1 }),
          auto ? button('Stop', () => setAuto(false), { primary: true }) : button('Auto-play', () => setAuto(true), { primary: true, disabled: !frames.length || at >= frames.length - 1 }),
          jsx('span', { style: { fontSize: 12, color: text.tertiary }, children: `${frames.length} turns at the usual watch speed` })
        ]
      }) : null,
      !watching ? jsxs('div', {
        style: { display: 'flex', gap: 8, flexWrap: 'wrap' },
        children: [
          button('End turn', () => command('end'), { disabled: Boolean(busy) || !d.can_move }),
          jsx('span', { style: { fontSize: 12, color: text.tertiary, alignSelf: 'center' }, children: 'Click a highlighted hex, or End turn to hold the rest.' })
        ]
      }) : null,
      jsxs('div', {
        style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
        children: [
          button('Play a battle', () => command(`play ${opponent} seed=${seed || '1'}`), { primary: true, disabled: busy }),
          button('Watch four bots', () => command(`watch 4 seed=${seed || '1'}`), { disabled: busy }),
          button('Improve my bot', () => askFor({ kind: 'improve' }, () => send('doctrine improve')), {
            disabled: busy || !d.improve_ready,
            title: d.improve_ready ? 'Ask your own model for a new card. It is kept only if it wins more.' : d.improve_note
          })
        ]
      }),
      cardChoices.length ? jsxs('div', {
        style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: text.tertiary },
        children: [
          jsx('span', { children: 'Your card:' }),
          ...cardChoices.map(card => button(
            `${card.name}${card.current ? ' ✓' : ''}`,
            () => command(`pick ${card.id}`),
            { primary: Boolean(card.current), disabled: busy, title: 'Use this card in the next battle.' }
          ))
        ]
      }) : null,
      jsxs('details', {
        className: 'games-advanced',
        style: { border: `1px solid ${stroke}`, borderRadius: 12, background: card, padding: '8px 12px' },
        children: [
          jsx('summary', { style: { cursor: 'pointer', fontSize: 12, color: text.secondary, fontWeight: 650 }, children: 'More options' }),
          jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 10 }, children: [
            jsxs('div', {
              style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
              children: [
                jsx('select', {
                  'aria-label': 'Opponent card', value: opponent, onChange: event => setOpponent(event.target.value),
                  style: { minWidth: 150, padding: '7px 9px', border: `1px solid ${stroke}`, borderRadius: 8, color: text.primary, background: card },
                  children: houseOptions.length ? houseOptions : [jsx('option', { value: 'stone-bastion', children: 'Stone Bastion' })]
                }),
                jsx('input', {
                  'aria-label': 'Seed', value: seed, placeholder: 'Seed', onChange: event => setSeed(event.target.value.replace(/[^0-9]/g, '').slice(0, 9)),
                  style: { width: 88, padding: '7px 9px', border: `1px solid ${stroke}`, borderRadius: 8, color: text.primary, background: 'transparent' }
                }),
                button('Play 1v1', () => command(`play ${opponent} seed=${seed || '1'}`), { disabled: busy }),
                button('Watch 2', () => command(`watch 2 seed=${seed || '1'}`), { disabled: busy }),
                button('Watch 3', () => command(`watch 3 seed=${seed || '1'}`), { disabled: busy }),
                button('Watch 4', () => command(`watch 4 seed=${seed || '1'}`), { disabled: busy }),
                button('Ladder', () => { setPanel('ladder'); command('ladder') }, { disabled: busy })
              ]
            }),
            jsxs('div', {
              style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
              children: [
                jsx('select', {
                  'aria-label': 'Your card', value: yourId ? yourId.id : '', onChange: event => command(`pick ${event.target.value}`),
                  style: { minWidth: 150, padding: '7px 9px', border: `1px solid ${stroke}`, borderRadius: 8, color: text.primary, background: card },
                  children: [
                    ...(yourId ? [] : [jsx('option', { value: '', children: (d.your_card && d.your_card.name) || 'Your card' })]),
                    ...cardOptions
                  ]
                }),
                button(panel === 'tree' ? 'Hide tree' : 'Family tree', () => setPanel(panel === 'tree' ? '' : 'tree')),
                button(panel === 'card' ? 'Hide card' : 'Card JSON', () => setPanel(panel === 'card' ? '' : 'card')),
                button(panel === 'import' ? 'Hide share' : 'Share', () => setPanel(panel === 'import' ? '' : 'import'))
              ]
            })
          ] })
        ]
      }),
      !d.improve_ready && d.improve_note ? jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: d.improve_note }) : null,
      panel === 'ladder' ? jsxs('section', {
        'aria-label': 'Ladder',
        style: { border: `1px solid ${stroke}`, borderRadius: 12, padding: 12, background: card, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 },
        children: [
          heading('House ladder'),
          ...((d.ladder || []).length ? (d.ladder || []).map(row => jsx('div', {
            style: { fontFamily: 'var(--font-mono, monospace)' },
            children: `${row.wins}-${row.losses}-${row.draws} against ${row.name}`
          }, row.id)) : [jsx('div', { style: { color: text.tertiary }, children: 'Press Ladder to play your card against all four house cards.' })])
        ]
      }) : null,
      panel === 'tree' ? jsxs('section', {
        'aria-label': 'Family tree',
        style: { border: `1px solid ${stroke}`, borderRadius: 12, padding: 12, background: card, display: 'flex', flexDirection: 'column', gap: 6 },
        children: [
          heading('Family tree'),
          jsx('pre', { style: { margin: 0, fontSize: 12, fontFamily: 'var(--font-mono, monospace)', color: text.secondary, whiteSpace: 'pre-wrap' }, children: d.tree || 'No family yet.' })
        ]
      }) : null,
      panel === 'card' ? jsxs('section', {
        'aria-label': 'Card JSON',
        style: { border: `1px solid ${stroke}`, borderRadius: 12, padding: 12, background: card, display: 'flex', flexDirection: 'column', gap: 8 },
        children: [
          heading('Your card — data only'),
          jsx('textarea', {
            'aria-label': 'Card JSON', value: cardText, spellCheck: false, rows: 12,
            onChange: event => setCardText(event.target.value),
            style: { width: '100%', boxSizing: 'border-box', fontFamily: 'var(--font-mono, monospace)', fontSize: 12, padding: 10, borderRadius: 8, border: `1px solid ${stroke}`, background: 'transparent', color: text.primary }
          }),
          jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' }, children: [
            button('Save card', () => importValue(cardText), { primary: true, disabled: busy }),
            button('Export card', () => download(''), { disabled: busy }),
            button('Export replay', () => download('replay'), { disabled: busy || !frames.length })
          ] })
        ]
      }) : null,
      panel === 'import' ? jsxs('section', {
        'aria-label': 'Share a card or replay',
        style: { border: `1px solid ${stroke}`, borderRadius: 12, padding: 12, background: card, display: 'flex', flexDirection: 'column', gap: 8 },
        children: [
          heading('Share a card or replay'),
          jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: 'Export writes a small JSON file. Import checks it first and says plainly what is wrong.' }),
          jsx('textarea', {
            'aria-label': 'JSON to import', value: pasted, spellCheck: false, rows: 8, placeholder: 'Paste a card or replay JSON',
            onChange: event => setPasted(event.target.value),
            style: { width: '100%', boxSizing: 'border-box', fontFamily: 'var(--font-mono, monospace)', fontSize: 12, padding: 10, borderRadius: 8, border: `1px solid ${stroke}`, background: 'transparent', color: text.primary }
          }),
          jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }, children: [
            button('Import JSON', () => importValue(pasted), { primary: true, disabled: busy || !pasted.trim() }),
            jsx('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Choose a JSON file', onChange: readFile, style: { fontSize: 12, color: text.secondary } })
          ] }),
          jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }, children: [
            field(profile, setProfile, 'Signature', () => { if (profile.trim()) command(`author ${profile.trim()}`) }),
            // A signature, not a profile: this name is written into the card's author field and nothing
            // else. The card is written by the person's own model.
            button('Write a card', () => { if (profile.trim()) command(`author ${profile.trim()}`) }, { disabled: busy || !profile.trim(), title: 'Your own model writes one card, signed with the name you type. One word: letters, numbers, dots, dashes.' })
          ] })
        ]
      }) : null,
      failure ? jsx('div', { role: 'alert', style: { padding: 12, border: '1px solid #d76b65', borderRadius: 8, fontSize: 13 }, children: failure }) : null,
      d.result && d.result.length && !watching ? jsxs('section', {
        'aria-label': 'Result',
        style: { border: `1px solid ${stroke}`, borderRadius: 12, padding: 12, background: card, fontSize: 13, color: text.secondary, display: 'flex', flexDirection: 'column', gap: 4 },
        children: d.result.map((line, at2) => jsx('div', { children: line }, at2))
      }) : null
    ]
  })
}
