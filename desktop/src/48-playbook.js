// ---- 48-playbook.js: the champion's playbook, its Hermes pet, and the Bot Passport card
// A champion is a pet's body playing a written brain. The brain is a "playbook": a
// read checklist, tactics, one scout rule and a voice, all in plain words with caps
// the server enforces. The body is the person's own installed Hermes pet, drawn from
// Hermes's own pet cells. We never copy a pet file into this plugin: we ask the
// gateway for its cells and draw the half-blocks it hands back.

// The seven states a Hermes pet animates through, and what each one means at a table.
const PET_GAME_STATES = [
  { id: 'idle', label: 'Idle', use: 'At the table with nothing to answer.' },
  { id: 'wave', label: 'Wave', use: 'A taunt before the match, or after a good move.' },
  { id: 'run', label: 'Run', use: 'Charging a line of play.' },
  { id: 'jump', label: 'Jump', use: 'The attack, and the win.' },
  { id: 'failed', label: 'Failed', use: 'Taking a hit, and the loss.' },
  { id: 'review', label: 'Review', use: 'Thinking about the next move.' },
  { id: 'waiting', label: 'Waiting', use: 'The other side is to move.' }
]

// One place that turns what is happening into a pet state, so the mapping stays honest.

// What a state is called out loud, so a caption never reads like a machine code.
function petStateLabel(state) {
  const named = {
    idle: 'Ready', wave: 'Taunt', run: 'Pressing', jump: 'Won',
    failed: 'Lost', review: 'Thinking', waiting: 'Your turn'
  }
  return named[String(state || '').toLowerCase()] || 'Ready'
}

// The editor counts words the way the server does: runs of non-space characters.
function wordCount(value) {
  const text = String(value == null ? '' : value).trim()
  return text ? text.split(/\s+/).length : 0
}

function playbookWords(draft) {
  const rows = draft || {}
  const read = (Array.isArray(rows.read) ? rows.read : []).reduce((total, line) => total + wordCount(line), 0)
  const tactics = (Array.isArray(rows.tactics) ? rows.tactics : []).reduce((total, line) => total + wordCount(line), 0)
  const scout = wordCount(rows.scout)
  const voice = wordCount(rows.voice)
  return { read, tactics, scout, voice, total: read + tactics + scout + voice }
}

// The server names its caps in Python constants; this is the one place that maps them.
function playbookLimits(limits) {
  const raw = limits || {}
  const pick = (...names) => {
    for (const name of names) {
      const value = Number(raw[name])
      if (Number.isFinite(value) && value > 0) return value
    }
    return 0
  }
  return {
    total: pick('cap_total_words', 'total') || 250,
    readQuestions: pick('cap_read_questions', 'read_questions') || 3,
    minReadQuestions: pick('min_read_questions') || 2,
    readQuestion: pick('cap_read_question_words', 'read_question') || 20,
    tactics: pick('cap_tactics', 'tactics') || 4,
    tactic: pick('cap_tactic_words', 'tactic') || 40,
    scout: pick('cap_scout_words', 'scout') || 40,
    voice: pick('cap_voice_words', 'voice') || 40,
    dossier: pick('max_dossier_words') || 80
  }
}

// A saved version carries its word counts either as a number or as the counted block.
function versionWords(version) {
  const words = version && version.words
  if (typeof words === 'number') return words
  if (words && typeof words.total === 'number') return words.total
  return 0
}

// Hermes hands a pet over as half-block cells: [tr,tg,tb,ta, br,bg,bb,ba]. Two pixels in
// one character cell, so the top half is one colour and the bottom half the other.
function petCellStyle(cell) {
  const [tr, tg, tb, ta, br, bg, bb, ba] = cell
  const alpha = value => Math.max(0, Math.min(255, Number(value) || 0)) / 255
  const top = `rgba(${tr || 0},${tg || 0},${tb || 0},${alpha(ta).toFixed(3)})`
  const bottom = `rgba(${br || 0},${bg || 0},${bb || 0},${alpha(ba).toFixed(3)})`
  return { background: `linear-gradient(to bottom, ${top} 0 50%, ${bottom} 50% 100%)` }
}

// Our own small figure, drawn here rather than downloaded: it stands in when this Hermes
// has no pet support or the person has not adopted a pet yet. Three shapes, theme colours.
function CritterFallback({ state = 'idle', size = 72 }) {
  const body = state === 'failed' || state === 'loss' ? 'var(--ui-text-tertiary)' : accent
  const hop = state === 'jump' || state === 'win' ? -0.06 : 0
  return jsx('svg', {
    width: size, height: Math.round(size * 0.9), viewBox: '0 0 40 36', role: 'img',
    'aria-label': `Placeholder champion figure (${state})`,
    style: { display: 'block', transform: `translateY(${hop * size}px)` },
    children: jsxs('g', { children: [
      jsx('rect', { x: 8, y: 10, width: 24, height: 20, rx: 8, fill: body, opacity: 0.85 }),
      jsx('circle', { cx: 16, cy: 19, r: 2.4, fill: 'var(--ui-bg-solid, #101820)' }),
      jsx('circle', { cx: 24, cy: 19, r: 2.4, fill: 'var(--ui-bg-solid, #101820)' }),
      jsx('rect', { x: 11, y: 6, width: 4, height: 7, rx: 2, fill: body, opacity: 0.6 }),
      jsx('rect', { x: 25, y: 6, width: 4, height: 7, rx: 2, fill: body, opacity: 0.6 })
    ] })
  })
}

// The champion's body: the person's own Hermes pet, in one of the seven game states.
// Frames come from the gateway (GET /pet/cells) and are drawn as a grid of half-block cells.
function PetSprite({ ctx, pet, state = 'idle', size = 72, cols = 24, caption = '' }) {
  const [frames, setFrames] = useState([])
  const [frameMs, setFrameMs] = useState(1100)
  const [frame, setFrame] = useState(0)
  const [missing, setMissing] = useState(!(pet && pet.enabled))
  const cache = useRef({})
  const slug = (pet && pet.slug) || ''
  const shown = PET_GAME_STATES.some(item => item.id === state) ? state : 'idle'

  useEffect(() => {
    setMissing(!(pet && pet.enabled))
  }, [pet && pet.enabled, slug])

  useEffect(() => {
    if (!ctx || !pet || !pet.enabled || !slug) return undefined
    let live = true
    const key = `${slug}:${shown}:${cols}`
    const cached = cache.current[key]
    if (cached) { setFrames(cached.frames); setFrameMs(cached.frameMs); setFrame(0); return undefined }
    const read = async () => {
      try {
        // The sanctioned door first: the desktop host's gateway JSON-RPC, the same
        // pet.cells the Hermes app itself draws with. The plugin route below is the
        // fallback for a host without it (and for the browser preview).
        const request = host && typeof host.request === 'function' ? host.request : null
        let answer = null
        if (request) {
          try {
            answer = await request('pet.cells', { state: shown, cols })
          } catch (failure) {
            answer = null
          }
        }
        if (!answer || !answer.enabled) answer = await ctx.rest(`/pet/cells?state=${encodeURIComponent(shown)}&cols=${cols}`)
        if (!live) return
        if (answer && answer.enabled && Array.isArray(answer.frames) && answer.frames.length) {
          cache.current[key] = { frames: answer.frames, frameMs: Number(answer.frameMs) || 1100 }
          setFrames(answer.frames)
          setFrameMs(Number(answer.frameMs) || 1100)
          setFrame(0)
          setMissing(false)
        } else {
          setMissing(true)
        }
      } catch (failure) {
        if (live) setMissing(true)
      }
    }
    read()
    return () => { live = false }
  }, [ctx, slug, shown, cols, pet && pet.enabled])

  useEffect(() => {
    if (frames.length <= 1) return undefined
    const timer = setInterval(() => setFrame(current => (current + 1) % frames.length), Math.max(90, frameMs))
    return () => clearInterval(timer)
  }, [frames, frameMs])

  const grid = frames.length ? frames[Math.min(frame, frames.length - 1)] : []
  const cell = Math.max(2, Math.round(size / Math.max(1, cols)))
  const height = grid.length ? grid.length * cell : Math.round(size * 0.9)
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 },
    children: [
      grid.length && !missing
        ? jsx('div', {
          role: 'img',
          'aria-label': `${(pet && pet.displayName) || 'Hermes pet'}, ${shown}`,
          style: {
            width: cols * cell, height, display: 'grid',
            gridTemplateColumns: `repeat(${cols}, ${cell}px)`, gridAutoRows: `${cell}px`
          },
          children: grid.flatMap((row, y) => row.map((value, x) => jsx('div', {
            key: `${y}-${x}`, style: { width: cell, height: cell, ...petCellStyle(value) }
          })))
        })
        : jsx(CritterFallback, { state: shown, size }),
      caption ? jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: caption }) : null
    ]
  })
}

// One capped box of plain text with its own word counter.
function PlaybookField({ label, hint, value, onChange, words, cap, rows = 2, placeholder, blockSpace = false }) {
  const over = words > cap
  return jsxs('label', {
    style: { display: 'flex', flexDirection: 'column', gap: 4 },
    children: [
      jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }, children: [
        jsx('span', { style: { fontSize: 12, color: text.secondary, fontWeight: 600 }, children: label }),
        jsx('span', {
          style: { fontSize: 12, color: over ? 'var(--ui-warning, #d9a441)' : text.secondary, whiteSpace: 'nowrap' },
          children: `${words} / ${cap} words`
        })
      ] }),
      jsx('textarea', {
        value,
        rows,
        placeholder,
        'aria-label': label,
        onChange: event => onChange(event.target.value),
        // A new word cannot be started once the field or the whole playbook is at its cap.
        // Text pasted over the cap still lands, and then saving is refused with a sentence.
        onKeyDown: event => {
          if (blockSpace && event.key === ' ') event.preventDefault()
        },
        style: {
          width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8,
          border: `1px solid ${over ? 'var(--ui-warning, #d9a441)' : stroke}`,
          background: 'transparent', color: 'inherit', fontSize: 12.5, fontFamily: 'inherit',
          resize: 'vertical', lineHeight: 1.4
        }
      }),
      hint ? jsx('span', { style: { fontSize: 12, color: text.tertiary }, children: hint }) : null
    ]
  })
}

// The playbook editor: plain text, live counters, hard caps, versions, and a sparring game.
function PlaybookEditor({ ctx, champion, limits, pet, onClose, onChanged }) {
  const caps = playbookLimits(limits)
  const empty = { read: ['', ''], tactics: [''], scout: '', voice: '' }
  const [draft, setDraft] = useState(empty)
  const [name, setName] = useState('')
  const [versions, setVersions] = useState([])
  const [current, setCurrent] = useState(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [spar, setSpar] = useState(null)
  const [sparId, setSparId] = useState('')
  const alive = useRef(true)

  const load = useCallback(async () => {
    try {
      const answer = await ctx.rest(`/playbook?champion=${encodeURIComponent(champion.id)}`)
      if (!alive.current) return
      if (answer && answer.ok) {
        setVersions(answer.versions || [])
        const chosen = answer.current
        setCurrent(chosen || null)
        if (chosen && chosen.playbook) {
          setDraft({
            read: chosen.playbook.read && chosen.playbook.read.length ? chosen.playbook.read : ['', ''],
            tactics: chosen.playbook.tactics && chosen.playbook.tactics.length ? chosen.playbook.tactics : [''],
            scout: chosen.playbook.scout || '',
            voice: chosen.playbook.voice || ''
          })
          setName(chosen.name || '')
        }
      } else {
        setError((answer && answer.text) || 'The playbook could not be read.')
      }
    } catch (failure) {
      if (alive.current) setError(failure.message || 'The playbook could not be read.')
    }
  }, [ctx, champion.id])

  useEffect(() => {
    alive.current = true
    load()
    return () => { alive.current = false }
  }, [load])

  // The sparring game runs on the backend; this asks it how it is going.
  useEffect(() => {
    if (!sparId) return undefined
    let live = true
    const timer = setInterval(async () => {
      try {
        const answer = await ctx.rest(`/playbook/test?id=${encodeURIComponent(sparId)}`)
        if (!live || !alive.current) return
        if (answer && answer.ok) {
          setSpar(answer)
          if (answer.status !== 'running') { setSparId(''); onChanged && onChanged() }
        }
      } catch (failure) {
        if (live && alive.current) setError(failure.message || 'The test game could not be read.')
      }
    }, 1200)
    return () => { live = false; clearInterval(timer) }
  }, [sparId, ctx, onChanged])

  const counts = playbookWords(draft)
  const capTotal = caps.total
  const capRead = caps.readQuestion
  const capTactic = caps.tactic
  const capScout = caps.scout
  const capVoice = caps.voice
  const maxRead = caps.readQuestions
  const maxTactics = caps.tactics
  const readOver = (draft.read || []).some(line => wordCount(line) > capRead)
  const tacticsOver = (draft.tactics || []).some(line => wordCount(line) > capTactic)
  const over = counts.total > capTotal || readOver || tacticsOver
  const emptyPlaybook = counts.total === 0
  const canSave = !over && !busy && !emptyPlaybook
  const state = spar && spar.status === 'running' ? 'review' : spar && spar.winner === 'champion' ? 'jump' : spar && spar.winner === 'house' ? 'failed' : 'idle'

  const setLine = (key, index, value) => setDraft(currentDraft => {
    const rows = [...(currentDraft[key] || [])]
    rows[index] = value
    return { ...currentDraft, [key]: rows }
  })
  const addLine = key => setDraft(currentDraft => {
    const rows = [...(currentDraft[key] || [])]
    if (rows.length >= (key === 'read' ? maxRead : maxTactics)) return currentDraft
    return { ...currentDraft, [key]: [...rows, ''] }
  })
  const dropLine = (key, index) => setDraft(currentDraft => {
    const rows = (currentDraft[key] || []).filter((_row, at) => at !== index)
    const floor = key === 'read' ? 2 : 1
    return { ...currentDraft, [key]: rows.length >= floor ? rows : [...rows, ''] }
  })

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const answer = await ctx.rest('/playbook/save', {
        method: 'POST',
        body: { champion: champion.id, name: name.trim(), playbook: draft }
      })
      if (answer && answer.ok) {
        setNote(answer.text || 'Version saved.')
        setCurrent(answer.version || null)
        await load()
        onChanged && onChanged()
      } else {
        setError((answer && answer.text) || 'That version could not be saved.')
      }
    } catch (failure) {
      setError(failure.message || 'That version could not be saved.')
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const openVersion = async version => {
    if (!version || !version.id) return
    try {
      const answer = await ctx.rest('/playbook/select', {
        method: 'POST', body: { champion: champion.id, version: version.id }
      })
      if (answer && answer.ok) {
        setNote(`Now playing ${version.name}.`)
        await load()
        onChanged && onChanged()
      } else {
        setError((answer && answer.text) || 'That version could not be opened.')
      }
    } catch (failure) {
      setError(failure.message || 'That version could not be opened.')
    }
  }

  const test = async () => {
    setError('')
    setSpar(null)
    try {
      const answer = await ctx.rest('/playbook/test', {
        method: 'POST', body: { champion: champion.id, game: 'connect4' }
      })
      if (answer && answer.ok && (answer.id || (answer.test && answer.test.id))) {
        setSparId(answer.id || answer.test.id)
        setSpar({ status: 'running', moves: [], reads: [], game: 'connect4' })
      } else {
        setError((answer && answer.text) || 'The test game could not start.')
      }
    } catch (failure) {
      setError(failure.message || 'The test game could not start.')
    }
  }

  const totalColour = counts.total > capTotal ? 'var(--ui-warning, #d9a441)' : text.tertiary
  const readRows = draft.read || []
  const tacticRows = draft.tactics || []

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 12 },
    children: [
      jsxs('div', { style: { display: 'flex', gap: 12, alignItems: 'center', paddingBottom: 10, borderBottom: `1px solid ${stroke}`, flexWrap: 'wrap' }, children: [
        jsx(PetSprite, { ctx, pet, state, size: 56, caption: petStateLabel(state) }),
        jsxs('div', { style: { minWidth: 0 }, children: [
          jsx('div', { style: { fontFamily: DISPLAY_FONT, fontSize: 22, lineHeight: 1.15, letterSpacing: '-.015em', fontWeight: 600 }, children: `Playbook · ${champion.name}` }),
          jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: current ? `Playing ${current.name} · ${counts.total} of ${capTotal} words in the box` : 'No version saved yet. The box below is the whole brain.' })
        ] }),
        jsx('div', { style: { marginLeft: 'auto', display: 'flex', gap: 6 }, children: button('Back to champions', onClose) })
      ] }),
      jsxs('div', {
        style: { borderRadius: 14, padding: 16, background: card, display: 'flex', flexDirection: 'column', gap: 12 },
        children: [
          jsxs('div', { style: { display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }, children: [
            jsxs('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 200 }, children: [
              jsx('span', { style: { fontSize: 12, color: text.secondary, fontWeight: 600 }, children: 'Version name' }),
              jsx('input', {
                value: name,
                placeholder: 'Patient wall v3',
                'aria-label': 'Version name',
                onChange: event => setName(event.target.value),
                style: { padding: '7px 10px', borderRadius: 8, border: `1px solid ${stroke}`, background: 'transparent', color: 'inherit', fontSize: 12.5 }
              })
            ] }),
            jsxs('div', { style: { fontSize: 12, color: totalColour, textAlign: 'right', minWidth: 170 }, children: [
              jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: 'Playbook total' }),
              jsx('div', { style: { fontWeight: 700, fontSize: 14 }, children: `${counts.total} / ${capTotal} words` }),
              jsx('div', { children: over
                ? `Over the cap by ${counts.total - capTotal}. Shorten a line before saving.`
                : counts.total >= capTotal - 25 ? `Near the word limit (${capTotal - counts.total} words left).`
                  : 'Read, tactics, scout and voice together.' })
            ] })
          ] }),
          jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 }, children: [
            jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }, children: [
              jsx('div', { style: { fontSize: 12, color: text.secondary, fontWeight: 600 }, children: `Read checklist — ${readRows.length} of ${maxRead} questions` }),
              readRows.length < maxRead ? button('Add a question', () => addLine('read')) : null
            ] }),
            jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: 'The bot answers these privately before every move. Two questions are enough; three is the most.' }),
            ...readRows.map((line, index) => jsxs('div', { key: `read-${index}`, style: { display: 'flex', gap: 6, alignItems: 'flex-start' }, children: [
              jsx('div', { style: { flex: 1 }, children: jsx(PlaybookField, {
                label: `Question ${index + 1}`,
                value: line,
                rows: 2,
                cap: capRead,
                words: wordCount(line),
                blockSpace: wordCount(line) >= capRead || counts.total >= capTotal,
                placeholder: index === 0 ? 'What does their last move leave undefended?' : 'What is the cheapest way to make them answer?',
                onChange: value => setLine('read', index, value)
              }) }),
              readRows.length > 2 ? button('Remove', () => dropLine('read', index)) : null
            ] }))
          ] }),
          jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, borderTop: `1px solid ${stroke}`, paddingTop: 10 }, children: [
            jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }, children: [
              jsx('div', { style: { fontSize: 12, color: text.secondary, fontWeight: 600 }, children: `Tactics — ${tacticRows.length} of ${maxTactics} rules` }),
              tacticRows.length < maxTactics ? button('Add a rule', () => addLine('tactics')) : null
            ] }),
            jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: 'Write each rule as if this, then that. Four rules is the most; 40 words each.' }),
            ...tacticRows.map((line, index) => jsxs('div', { key: `tactic-${index}`, style: { display: 'flex', gap: 6, alignItems: 'flex-start' }, children: [
              jsx('div', { style: { flex: 1 }, children: jsx(PlaybookField, {
                label: `Rule ${index + 1}`,
                value: line,
                rows: 2,
                cap: capTactic,
                words: wordCount(line),
                blockSpace: wordCount(line) >= capTactic || counts.total >= capTotal,
                placeholder: index === 0 ? 'If they stack one column, then open the other side and keep the trade even.' : 'If a trade is offered, then take it only when it wins a tempo.',
                onChange: value => setLine('tactics', index, value)
              }) }),
              tacticRows.length > 1 ? button('Remove', () => dropLine('tactics', index)) : null
            ] }))
          ] }),
          jsxs('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', borderTop: `1px solid ${stroke}`, paddingTop: 10 }, children: [
            jsx('div', { style: { flex: 1, minWidth: 220 }, children: jsx(PlaybookField, {
              label: 'Scout rule',
              hint: 'After each match the bot writes up to 80 words about that rival, from this rule.',
              value: draft.scout,
              cap: capScout,
              words: counts.scout,
              blockSpace: counts.scout >= capScout || counts.total >= capTotal,
              rows: 2,
              placeholder: 'Note what they do when they are behind, and which side they always open.',
              onChange: value => setDraft(currentDraft => ({ ...currentDraft, scout: value }))
            }) }),
            jsx('div', { style: { flex: 1, minWidth: 220 }, children: jsx(PlaybookField, {
              label: 'Voice',
              hint: 'How it talks in public chat: short, plain, no insults.',
              value: draft.voice,
              cap: capVoice,
              words: counts.voice,
              blockSpace: counts.voice >= capVoice || counts.total >= capTotal,
              rows: 2,
              placeholder: 'Dry, brief, gives credit when it loses.',
              onChange: value => setDraft(currentDraft => ({ ...currentDraft, voice: value }))
            }) })
          ] }),
          over ? jsx('div', {
            role: 'alert',
            style: { fontSize: 12, color: 'var(--ui-warning, #d9a441)' },
            children: counts.total > capTotal
              ? `This playbook is ${counts.total} words. The cap is ${capTotal}.`
              : 'One line is over its own cap. Shorten it to save.'
          }) : null,
          error ? jsx('div', { role: 'alert', style: { fontSize: 12, color: 'var(--ui-text-primary, inherit)' }, children: error }) : null,
          note ? jsx('div', { role: 'status', style: { fontSize: 12, color: text.secondary }, children: note }) : null,
          jsxs('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }, children: [
            button('Save as a new version', save, { primary: true, disabled: !canSave }),
            button(sparId ? 'Testing…' : 'Test vs house bot', test, { disabled: Boolean(sparId) || !current }),
            jsx('span', { style: { fontSize: 12, color: text.tertiary }, children: current
              ? 'The test plays the saved version against the built-in computer.'
              : 'Save a version first: the test plays the saved version.' })
          ] })
        ]
      }),
      versions.length ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 }, children: [
        jsx('div', { style: { fontSize: 12, color: text.secondary, fontWeight: 600 }, children: 'Saved versions' }),
        jsxs('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' }, children: versions.map(version => button(
          `${current && current.id === version.id ? '● ' : ''}${version.name} · ${versionWords(version)} words`,
          () => openVersion(version),
          { primary: Boolean(current && current.id === version.id) }
        )) })
      ] }) : null,
      spar ? jsxs('div', {
        'data-spar': 'result',
        style: { border: `1px solid ${stroke}`, borderRadius: 16, padding: 14, background: card, display: 'flex', gap: 12, alignItems: 'flex-start' },
        children: [
          jsx(PetSprite, { ctx, pet, state, size: 64, caption: petStateLabel(state) }),
          jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 }, children: [
            jsx('div', { style: { fontSize: 12, letterSpacing: '0.1em', textTransform: 'uppercase', color: text.tertiary }, children: 'Test result' }),
            jsx('div', { style: { fontWeight: 700, fontSize: 14 }, children: spar.status === 'running'
              ? 'Playing the house computer…'
              : spar.winner === 'champion' ? 'The champion won.' : spar.winner === 'house' ? 'The house computer won.' : 'Drawn.' }),
            jsx('div', { style: { fontSize: 12, color: text.secondary }, children: `Moves: ${(spar.moves || []).join(' ') || 'none yet'}` }),
            (spar.reads || []).length ? jsxs('div', { style: { fontSize: 12, color: text.secondary }, children: [
              jsx('div', { style: { color: text.tertiary, fontSize: 12 }, children: 'Its private read, last move' }),
              ...(spar.reads || []).map((line, index) => jsx('div', { key: index, style: { fontStyle: 'italic' }, children: `“${line}”` }))
            ] }) : null,
            spar.text ? jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: spar.text }) : null
          ] })
        ]
      }) : null
    ]
  })
}

// The Bot Passport: one champion's public identity — its pet, the playbook it plays, its record.
function PassportCard({ ctx, champion, avatars, colors, pet, badges: earned, onEdit, onOpenPlaybook, actions }) {
  const [dossiers, setDossiers] = useState(null)
  const [wave, setWave] = useState(false)
  const colour = (colors || []).find(item => item.id === champion.color) || { hex: '#d9a441' }
  const today = champion.playbook || null
  const records = champion.record_by_version || null
  const record = (champion.record || {})
  const rows = champion.dossiers || []
  const scouted = rows.reduce((total, row) => total + (Number(row.matches) || 0), 0)
  const line = today ? `Playbook: ${today.name} · ${versionWords(today)} words` : 'No playbook yet: it plays from its brief.'
  return jsxs('div', {
    'data-passport': champion.id,
    style: { borderRadius: 14, padding: 14, background: card, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 196 },
    children: [
      jsxs('div', { style: { display: 'flex', gap: 12, alignItems: 'center' }, children: [
        jsx('button', {
          type: 'button',
          title: 'Say hello',
          'aria-label': `${champion.name}'s pet`,
          onClick: () => { setWave(true); setTimeout(() => setWave(false), 1300) },
          style: { background: 'transparent', border: 0, padding: 0, cursor: 'pointer', borderRadius: 8 },
          children: jsx(PetSprite, { ctx, pet, state: wave ? 'wave' : 'idle', size: 58 })
        }),
        jsxs('div', { style: { minWidth: 0, flex: 1 }, children: [
          jsx('div', { style: { fontFamily: DISPLAY_FONT, fontSize: 18, lineHeight: 1.2, letterSpacing: '-.01em', fontWeight: 600 }, children: champion.name }),
          jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: champion.motto || 'No motto' })
        ] }),
        jsxs('div', { style: { textAlign: 'right' }, children: [
          jsx('div', { style: { fontSize: 12, letterSpacing: '.09em', textTransform: 'uppercase', color: text.tertiary }, children: 'Elo' }),
          jsx('div', { style: { ...TABULAR, fontSize: 18, fontWeight: 600, lineHeight: 1.1 }, children: Math.round(record.rating || 1500) })
        ] })
      ] }),
      jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 3, borderTop: `1px solid ${stroke}`, paddingTop: 8 }, children: [
        jsx('div', { style: { fontSize: 12, color: text.secondary }, children: line }),
        jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: `From ${colour.id}: its colour. W ${record.wins || 0} · L ${record.losses || 0} · D ${record.draws || 0}${records ? ` · this version ${records.wins || 0}-${records.losses || 0}-${records.draws || 0}` : ''}` })
      ] }),
      (earned || []).length ? jsx('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' }, children: (earned || []).map(name => badge(String(name).replace('_', ' '))) }) : null,
      jsxs('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }, children: [
        button(today ? 'Open playbook' : 'Write a playbook', onOpenPlaybook, { primary: !today }),
        rows.length ? button(`${rows.length} rival${rows.length === 1 ? '' : 's'} scouted`, () => setDossiers(dossiers ? null : rows)) : jsx('span', { style: { fontSize: 12, color: text.tertiary }, children: 'No rivals scouted yet' })
      ] }),
      dossiers ? jsxs('div', {
        style: { borderTop: `1px solid ${stroke}`, paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 },
        children: rows.map((row, index) => jsxs('div', { key: index, style: { fontSize: 12, color: text.secondary }, children: [
          jsx('div', { style: { fontWeight: 600, color: text.primary }, children: `${row.opponent_name || row.opponent} · ${row.matches || 0} match${(row.matches || 0) === 1 ? '' : 'es'}` }),
          jsx('div', { children: row.text || `${row.wins || 0} won, ${row.losses || 0} lost, ${row.draws || 0} drawn.` })
        ] }))
      }) : null,
      scouted ? jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: `Scout notes cover ${scouted} match${scouted === 1 ? '' : 'es'}.` }) : null,
      jsxs('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'auto' }, children: actions })
    ]
  })
}
