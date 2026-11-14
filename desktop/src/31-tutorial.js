// ---- 31-tutorial.js: the shared Play & Learn step player.
// One sheet, three tabs, used by every game screen: a rules card with a small
// animated diagram, a computer-vs-computer demo with narration and transport
// controls, and the door to a guided first game. The words come from the game's
// own learn.json (served by GET /learn); nothing here calls a model.

const LEARN_TABS = ['How to play', 'Watch it played', 'Play & Learn']
const LEARN_SPEEDS = [0.5, 1, 2]

// The tutorial text for one game, fetched once per open. The caller keeps it
// while the sheet is open; closing and reopening refetches, so an edited
// learn.json shows up without a reload.
function useLearnData(ctx, gameId, wanted) {
  const [state, setState] = useState({ gameId: '', data: null, error: '' })
  useEffect(() => {
    if (!wanted || !gameId) return undefined
    let alive = true
    setState({ gameId, data: null, error: '' })
    ctx.rest(`/learn?game=${encodeURIComponent(gameId)}`, { method: 'GET' })
      .then(answer => {
        if (!alive) return
        if (answer && answer.ok) setState({ gameId, data: answer.learn, error: '' })
        else setState({ gameId, data: null, error: (answer && answer.text) || 'No tutorial for this game yet.' })
      })
      .catch(() => { if (alive) setState({ gameId, data: null, error: 'The tutorial did not load. Try again.' }) })
    return () => { alive = false }
  }, [ctx, gameId, wanted])
  return state.gameId === gameId && (state.data || state.error) ? state : { gameId, data: null, error: '' }
}

const PIP_FACES = {
  1: [[1, 1]], 2: [[0, 0], [2, 2]], 3: [[0, 0], [1, 1], [2, 2]],
  4: [[0, 0], [0, 2], [2, 0], [2, 2]], 5: [[0, 0], [0, 2], [1, 1], [2, 0], [2, 2]],
  6: [[0, 0], [0, 2], [1, 0], [1, 2], [2, 0], [2, 2]]
}

// One static or one-frame diagram drawn small and quiet: the rules card's
// picture, not a second board. Frames animate through LearnDiagram's index.
// The plain grid pictures (letters on blank squares) read as nothing to a new player in every game,
// so they stay hidden until they are redrawn on the real board; dice, cards and seats still show.
function shownDiagram(diagram) {
  return diagram && (diagram.kind || 'grid') !== 'grid' ? diagram : null
}

function LearnDiagramView({ diagram, index }) {
  const kind = (diagram && diagram.kind) || 'grid'
  // Pips, cards and seats carry their values on the frame being shown; older
  // single-frame diagrams keep them at the top level, so read both.
  const frames = (diagram && diagram.frames) || []
  const frame = frames.length ? (frames[Math.min(Math.max(0, index || 0), frames.length - 1)] || frames[0]) : {}
  if (kind === 'pips') {
    const values = frame.values || (diagram && diagram.values) || []
    const face = 40
    return jsx('svg', {
      viewBox: `0 0 ${values.length * (face + 8)} ${face}`, role: 'img',
      'aria-label': `Dice showing ${values.join(', ')}`,
      style: { maxWidth: '100%', height: 'auto' },
      children: values.map((value, at) => jsxs('g', { transform: `translate(${at * (face + 8)}, 0)`, children: [
        jsx('rect', { x: 0, y: 0, width: face, height: face, rx: 8, fill: card, stroke }, `d${at}`),
        ...(PIP_FACES[value] || []).map(([gy, gx], dot) => jsx('circle', {
          cx: 10 + gx * 10, cy: 10 + gy * 10, r: 3.4, fill: text.primary
        }, `p${at}-${dot}`))
      ] }, at))
    })
  }
  if (kind === 'cards') {
    const labels = frame.cards || (diagram && diagram.cards) || []
    const cardWidth = 62
    return jsx('svg', {
      viewBox: `0 0 ${labels.length * (cardWidth + 8)} 56`, role: 'img',
      'aria-label': `Cards: ${labels.join(', ')}`,
      style: { maxWidth: '100%', height: 'auto' },
      children: labels.map((label, at) => jsxs('g', { transform: `translate(${at * (cardWidth + 8)}, 0)`, children: [
        jsx('rect', { x: 0, y: 0, width: cardWidth, height: 56, rx: 7, fill: card, stroke }, `c${at}`),
        jsx('text', { x: cardWidth / 2, y: 33, textAnchor: 'middle', fontSize: 14, fill: text.primary }, `t${at}`)
      ] }, at))
    })
  }
  if (kind === 'seats') {
    const seats = frame.seats || (diagram && diagram.seats) || []
    return jsx('div', {
      style: { display: 'flex', gap: 8, flexWrap: 'wrap' },
      children: seats.map((seat, at) => jsxs('div', {
        style: { padding: '8px 12px', borderRadius: 10, border: `1px solid ${stroke}`, background: card, textAlign: 'center' },
        children: [
          jsx('div', { style: { fontSize: 13, fontWeight: 650 }, children: seat.name }, `n${at}`),
          seat.tag ? jsx('div', { style: { fontSize: 11, color: text.tertiary }, children: seat.tag }, `t${at}`) : null
        ]
      }, at))
    })
  }
  // grid: cols x rows cells; the current frame fills its cells and rings them.
  const cols = Math.max(1, Number(diagram.cols) || 8)
  const rows = Math.max(1, Number(diagram.rows) || 8)
  const size = Math.max(14, Math.floor(Math.min(360 / cols, 240 / rows, 34)))
  const marks = {}
  ;(frame.cells || []).forEach(cell => { marks[`${cell[0]}:${cell[1]}`] = String(cell[2] || '') })
  const squares = []
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const mark = marks[`${row}:${col}`]
      squares.push(jsx('rect', {
        x: col * size + 1, y: row * size + 1, width: size - 2, height: size - 2, rx: 3,
        fill: mark ? accent : fill, stroke: mark ? accent : stroke,
        opacity: mark ? 0.9 : 1
      }, `${row}-${col}`))
      if (mark) squares.push(jsx('text', {
        x: col * size + size / 2, y: row * size + size / 2 + 5, textAnchor: 'middle',
        fontSize: Math.min(16, size - 6), fontWeight: 700, fill: 'var(--ui-text-on-accent, white)'
      }, `m-${row}-${col}`))
    }
  }
  return jsx('svg', {
    viewBox: `0 0 ${cols * size} ${rows * size}`, role: 'img',
    'aria-label': `${diagram.label || 'Diagram'}, frame ${(index || 0) + 1} of ${(diagram.frames || []).length}`,
    style: { maxWidth: '100%', height: 'auto' },
    children: squares
  })
}

// A diagram that walks its own frames: two seconds a frame, dots to jump, and
// a one-line caption under it. Mouse only: the dots are the controls.
function LearnDiagram({ diagram }) {
  const frames = (diagram && diagram.frames) || []
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const clamped = Math.min(index, Math.max(0, frames.length - 1))
  useEffect(() => {
    if (paused || frames.length < 2) return undefined
    const timer = setInterval(() => setIndex(at => (at + 1) % frames.length), 2000)
    return () => clearInterval(timer)
  }, [paused, frames.length])
  if (!frames.length) return null
  const say = (frames[clamped] || {}).say || ''
  return jsxs('div', {
    className: 'games-learn-diagram',
    style: { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' },
    children: [
      jsx(LearnDiagramView, { diagram, index: clamped }),
      say ? jsx('div', { role: 'status', style: { fontSize: 13, color: text.secondary, textAlign: 'center', minHeight: 18 }, children: say }) : null,
      jsxs('div', { style: { display: 'flex', gap: 6, alignItems: 'center' }, children: [
        button(paused ? 'Play' : 'Pause', () => setPaused(!paused), { title: paused ? 'Keep showing the frames' : 'Hold this frame', label: paused ? 'Play diagram' : 'Pause diagram' }),
        frames.map((frame, at) => jsx('button', {
          type: 'button', 'aria-label': `Diagram frame ${at + 1}`, onClick: () => { setIndex(at); setPaused(true) },
          style: { width: 10, height: 10, borderRadius: '50%', border: `1px solid ${stroke}`, background: at === clamped ? accent : 'transparent', cursor: 'pointer', padding: 0 }
        }, at))
      ] })
    ]
  })
}

// Watch a game played by the built-in players, one narrated position at a
// time: play/pause, step back, step forward, speed. Frames come ready-drawn
// from the server (table games replay through the real rules engine).
function DemoPlayer({ demo }) {
  const frames = (demo && demo.frames) || []
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const clamped = Math.min(index, Math.max(0, frames.length - 1))
  useEffect(() => {
    if (!playing || frames.length < 2) return undefined
    const timer = setInterval(() => {
      setIndex(at => {
        if (at + 1 >= frames.length) { setPlaying(false); return at }
        return at + 1
      })
    }, Math.round(1800 / speed))
    return () => clearInterval(timer)
  }, [playing, speed, frames.length])
  if (!frames.length) return jsx('div', { style: { fontSize: 13, color: text.tertiary }, children: 'No demo for this game yet. The How to play card covers the rules.' })
  const frame = frames[clamped] || {}
  const atEnd = clamped >= frames.length - 1
  const icon = (label, onClick, disabled, marker) => button(label, onClick, {
    disabled, title: label, label, primary: Boolean(marker)
  })
  return jsxs('div', {
    className: 'games-learn-demo',
    style: { display: 'flex', flexDirection: 'column', gap: 10 },
    children: [
      demo.intro ? jsx('div', { style: { fontSize: 13, color: text.secondary }, children: demo.intro }) : null,
      jsxs('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }, children: [
        frame.picture
          ? jsx('div', { style: { flex: '1 1 320px', minWidth: 0 }, children: jsx(BoardSvg, { picture: frame.picture, height: 260, flat: true, interactive: false }) })
          : shownDiagram(frame.diagram)
            ? jsx('div', { style: { flex: '1 1 240px', minWidth: 0 }, children: jsx(LearnDiagramView, { diagram: frame.diagram, index: 0 }) })
            : null,
        jsx('div', {
          style: { flex: '1 1 220px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 },
          children: jsxs('div', { children: [
            frame.label ? jsx('div', { style: { fontSize: 12, color: text.tertiary, textTransform: 'uppercase', letterSpacing: '.08em' }, children: frame.label }) : null,
            jsx('div', { role: 'status', 'aria-live': 'polite', style: { fontSize: 14, lineHeight: 1.45, marginTop: 4 }, children: frame.say || 'Watch the board.' })
          ] })
        })
      ] }),
      atEnd && demo.outro ? jsx('div', { style: { fontSize: 13, color: text.secondary }, children: demo.outro }) : null,
      jsxs('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }, children: [
        icon(playing ? 'Pause' : 'Play', () => { if (atEnd && !playing) setIndex(0); setPlaying(!playing) }, false, true),
        icon('Back', () => { setPlaying(false); setIndex(Math.max(0, clamped - 1)) }, clamped === 0),
        icon('Next', () => { setPlaying(false); setIndex(Math.min(frames.length - 1, clamped + 1)) }, atEnd),
        button(`${speed}x`, () => setSpeed(LEARN_SPEEDS[(LEARN_SPEEDS.indexOf(speed) + 1) % LEARN_SPEEDS.length]), { title: 'Playback speed' }),
        jsxs('div', { 'aria-hidden': true, style: { flex: 1, minWidth: 90, height: 4, borderRadius: 2, background: fill } , children: [
          jsx('div', { style: { width: `${((clamped + 1) / frames.length) * 100}%`, height: '100%', borderRadius: 2, background: accent } })
        ] }),
        jsx('span', { style: { fontSize: 12, color: text.tertiary, fontVariantNumeric: 'tabular-nums' }, children: `${clamped + 1} / ${frames.length}` })
      ] })
    ]
  })
}

// The rules card: goal first, then setup, a few titled sections, the control
// list, and the animated diagram beside it.
function HowToCard({ howto }) {
  if (!howto) return jsx('div', { style: { fontSize: 13, color: text.tertiary }, children: 'The rules for this game are still being written.' })
  return jsxs('div', { style: { display: 'flex', gap: 18, flexWrap: 'wrap' }, children: [
    jsxs('div', { style: { flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }, children: [
      howto.goal ? jsxs('div', { children: [
        jsx('div', { style: { fontSize: 11, color: text.tertiary, textTransform: 'uppercase', letterSpacing: '.08em' }, children: 'Goal' }),
        jsx('div', { style: { fontSize: 15, fontWeight: 650, marginTop: 2 }, children: howto.goal })
      ] }) : null,
      howto.setup ? jsxs('div', { children: [
        jsx('div', { style: { fontSize: 11, color: text.tertiary, textTransform: 'uppercase', letterSpacing: '.08em' }, children: 'Setup' }),
        jsx('div', { style: { fontSize: 13, color: text.secondary, marginTop: 2 }, children: howto.setup })
      ] }) : null,
      ...(howto.sections || []).map((section, at) => jsxs('div', { children: [
        jsx('div', { style: { fontSize: 13, fontWeight: 650 }, children: section.title }, at),
        jsx('div', { style: { fontSize: 13, color: text.secondary, marginTop: 2, lineHeight: 1.45 }, children: section.text })
      ] }, at)),
      (howto.controls || []).length ? jsxs('div', { children: [
        jsx('div', { style: { fontSize: 11, color: text.tertiary, textTransform: 'uppercase', letterSpacing: '.08em' }, children: 'Controls' }),
        jsx('ul', { style: { margin: '4px 0 0', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 3 }, children:
          howto.controls.map((line, at) => jsx('li', { style: { fontSize: 13, color: text.secondary }, children: line }, at)) })
      ] }) : null
    ] }),
    shownDiagram(howto.diagram) ? jsx('div', { style: { flex: '1 1 240px', minWidth: 0 }, children: jsx(LearnDiagram, { diagram: howto.diagram }) }) : null
  ] })
}

// The overlay sheet with the three tabs. Opening it never touches the table:
// it only reads /learn. "Start guided game" is the one button that does.
function LearnSheet({ game, ctx, onClose, onStartLearn }) {
  const [tab, setTab] = useState(LEARN_TABS[0])
  const { data, error } = useLearnData(ctx, game && game.id, true)
  const panel = !data && !error
    ? jsx('div', { style: { fontSize: 13, color: text.tertiary, padding: '18px 0' }, children: 'Opening the tutorial…' })
    : error
      ? jsx('div', { role: 'alert', style: { fontSize: 13, padding: '18px 0' }, children: error })
      : tab === LEARN_TABS[0]
        ? jsx(HowToCard, { howto: data.howto })
        : tab === LEARN_TABS[1]
          ? jsx(DemoPlayer, { demo: data.demo })
          : jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 }, children: [
              jsx('div', { style: { fontSize: 14, lineHeight: 1.45 }, children: 'Play a real game against the Beginner computer. It explains each of its moves, a guide appears when a rule first matters, and if the computer could win after your move you get a warning and an Undo.' }),
              onStartLearn
                ? button('Start guided game vs Beginner', () => onStartLearn(), { primary: true, title: 'Replaces this board with a fresh guided game against the built-in Beginner player.' })
                : jsxs('div', { children: [
                    jsx('div', { style: { fontSize: 13, fontWeight: 650 }, children: 'Tips for this game' }),
                    ((data.coach || {}).steps || []).map((step, at) => jsx('div', { key: at, style: { fontSize: 13, color: text.secondary, marginTop: 4 }, children: step.say }, at)),
                    !(((data.coach || {}).steps || []).length) ? jsx('div', { style: { fontSize: 13, color: text.tertiary }, children: 'Start the game from this screen and the guide will coach you as you play.' }) : null
                  ] })
            ] })
  return jsx('div', {
    role: 'dialog', 'aria-modal': true, 'aria-label': `How to play ${game.title || game.id}`,
    className: 'games-learn-sheet',
    style: { position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(6, 10, 16, 0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
    children: jsxs('div', {
      style: { width: 'min(880px, 96vw)', maxHeight: '92vh', overflow: 'auto', background: paper, border: `1px solid ${stroke}`, borderRadius: 16, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 },
      children: [
        jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }, children: [
          jsxs('div', { children: [
            jsx('div', { style: { fontSize: 20, fontWeight: 700 }, children: `Play & Learn · ${data ? data.title || game.title : game.title || game.id}` }),
            jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: 'Built-in notes. Nothing here sends your game to a model.' })
          ] }),
          button('Close', () => onClose(), { primary: true, autoFocus: true, label: 'Close tutorial' })
        ] }),
        jsx('div', { role: 'tablist', 'aria-label': 'Tutorial sections', style: { display: 'flex', gap: 8, flexWrap: 'wrap' }, children:
          LEARN_TABS.map(name => jsx('span', { key: name, style: { display: 'inline-flex' }, children:
            button(name, () => setTab(name), {
              title: name === LEARN_TABS[0] ? 'The rules in short.' : name === LEARN_TABS[1] ? 'The built-in players show you a game.' : 'A first game with a guide beside you.',
              primary: tab === name
            }) })) }),
        panel
      ]
    })
  })
}

// The Learn door on a game screen. Each screen drops one of these in its
// header row; the sheet it opens is the same for every game.
function LearnButton({ game, ctx, onStartLearn, disabled, title, label }) {
  const [open, setOpen] = useState(false)
  const startLearn = onStartLearn ? () => { setOpen(false); onStartLearn() } : undefined
  return jsxs('span', { style: { display: 'inline-flex' }, children: [
    button(label || 'Learn', () => setOpen(true), { disabled, title: title || 'The rules, a demo game, and a guided first game.' }),
    open ? jsx(LearnSheet, { game, ctx, onClose: () => setOpen(false), onStartLearn: startLearn }) : null
  ] })
}

// Beside the board during a guided game: the computer's own words about its
// last move, and a red warning with Undo when the last move throws the game
// away. Both come from the table picture (kit.py), no model involved.
function CoachStrip({ game, pictured, command, lock }) {
  if (!pictured || !pictured.learn) return null
  const tip = String(pictured.coach_tip || '')
  const note = String(pictured.coach_note || '')
  if (!tip && !note) return null
  return jsxs('section', {
    'aria-label': 'Coach', role: 'status',
    style: {
      padding: '10px 12px', borderRadius: 8, fontSize: 13, lineHeight: 1.45,
      border: `1px solid ${tip ? '#d76b65' : accent}`,
      borderLeft: `4px solid ${tip ? '#d76b65' : accent}`,
      background: card, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap'
    },
    children: [
      tip
        ? jsxs('span', { style: { color: '#e08a85' }, children: [jsx('b', { children: 'Careful. ' }), tip] })
        : jsxs('span', { children: [jsx('b', { children: 'The computer says: ' }), note] })
      // The Undo lives in the table's single action row now ("Undo move"), so it is not
      // drawn twice; only the warning stays beside the board.
    ]
  })
}

// The guide that explains one rule at a time, as long as the guided game runs.
// Steps come from learn.json; the person moves forward with a mouse.
function CoachGuide({ game, pictured, learn, guideStep, setGuideStep }) {
  const steps = ((learn && learn.coach) || {}).steps || []
  if (!pictured || !pictured.learn || !steps.length) return null
  // A hint must point at a cell the person can still play: keep only the
  // highlighted cells the table itself lists as legal right now. A hint that
  // names a taken cell sends the person clicking at nothing, so it stays hidden.
  const legalList = Array.isArray(pictured.legal) ? pictured.legal.map(String) : null
  const seats = Array.isArray(pictured.seats) ? pictured.seats : []
  const humanSeat = seats.find(seat => seat && seat.kind === 'human')
  const whiteSeat = seats.find(seat => seat && seat.side === 'white')
  // Every game here gives White the first move. When White is the machine and
  // a move is already on the board, the computer opened the game.
  const computerOpened = Boolean(
    humanSeat && whiteSeat && whiteSeat.kind !== 'human' && (pictured.moves || []).length
  )
  const hintsGone = step => {
    const hinted = (step && step.highlight || []).map(cell => String(cell))
    return hinted.length > 0 && Boolean(legalList) && !hinted.some(cell => legalList.includes(cell))
  }
  // The last rule must keep the guide and its "Previous rule" button. A step
  // past the end (a click on Next at the last rule) is clamped to that rule.
  let at = Math.min(Math.max(0, guideStep), steps.length - 1)
  // A rule whose hinted cells are all taken has been followed. Show the next
  // rule instead, so the guide never tells the person to click a taken cell.
  while (at < steps.length - 1 && hintsGone(steps[at])) at += 1
  const step = steps[at] || {}
  let tries = (step.highlight || [])
    .map(cell => String(cell))
    .filter(cell => !legalList || legalList.includes(cell))
  if (computerOpened && !tries.length && legalList && legalList.length) {
    // The computer took the opening move: point at a legal move rather than
    // leave the first rule without a hint.
    tries = legalList.slice(0, 2)
  }
  return jsxs('section', {
    'aria-label': 'Guide',
    style: { padding: '10px 12px', borderRadius: 8, border: `1px dashed ${accent}`, background: card, display: 'flex', flexDirection: 'column', gap: 8 },
    children: [
      jsxs('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }, children: [
        jsx('b', { style: { fontSize: 13 }, children: `Guide · rule ${at + 1} of ${steps.length}` }),
        tries.length ? jsx('span', { style: { fontSize: 12, color: text.tertiary }, children: `Try: ${tries.join(', ')}` }) : null
      ] }),
      computerOpened ? jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: 'The computer moved first.' }) : null,
      jsx('div', { style: { fontSize: 14, lineHeight: 1.45 }, children: step.say }),
      jsxs('div', { style: { display: 'flex', gap: 8 }, children: [
        at < steps.length - 1 ? button('Next rule', () => setGuideStep(at + 1), { primary: true, title: 'Move on to the next rule.' }) : null,
        at > 0 ? button('Previous rule', () => setGuideStep(at - 1), { title: 'Read the last rule again.' }) : null
      ] })
    ]
  })
}
