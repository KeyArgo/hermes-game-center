// ---- 14b-backgammon-svg.js: the Backgammon board — 24 points, a bar, an off tray and two dice
//
// Played by pointing, never by typing: tap a checker to light the points its dice can reach,
// tap a lit point to move it (dragging the checker onto the point does the same thing). Only
// the moves the engine lists as legal are ever lit or sent — the board judges nothing itself.
//
// The dice are the engine's own. It rolls a turn's dice the moment the turn starts, and this
// board shows them land: a fresh roll waits behind a Roll button, so the roll is something the
// person watches happen, and the pips that come to rest are the engine's values, never invented
// ones. Doubles tumble four dice, because in backgammon doubles are four moves.
//
// ``backgammonTurnLine`` and the roll phase are shared with the full table (30-game-page.js) and
// the side pane (65-wait-pane.js), so the one status line all three draw says the same thing.

// What the dice still allow, in the words the status line uses: "6, 3" or "4, 4, 4, 4".
function bgDiceWords(dice) {
  return (dice || []).map(String).join(', ')
}

// The first step of a move token ("24-18-6" -> "24", "bar-23-1" -> "bar", "6-off-6" -> "6").
function bgFrom(token) {
  return String(token == null ? '' : token).split('-')[0]
}

// The second step: the point a move lands on, or "off" when the checker leaves the board.
function bgTo(token) {
  return String(token == null ? '' : token).split('-')[1]
}

function bgMoves(legal) {
  return (legal || []).map(token => ({ token: String(token), from: bgFrom(token), to: bgTo(token) }))
}

function bgReducedMotion() {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch (error) {
    return false
  }
}

// The one sentence about whose turn it is, for a backgammon table. ``myTurn`` is the caller's own
// read (the table's access.can_move, the pane's myTurn); ``phase`` is the board's roll phase
// ("roll" while the dice wait behind the button, "rolling" while they tumble, "move" after).
// Returns "" whenever the surface's own wording is better — a result, or another person's turn.
function backgammonTurnLine(picture, myTurn, phase) {
  const p = picture || {}
  if (String(p.status || '') !== 'active') return ''
  if (!myTurn) {
    const seat = (p.seats || []).find(item => item.side === p.turn)
    if (seat && seat.kind === 'local') return 'Computer is thinking…'
    return ''
  }
  if (phase === 'roll' || phase === 'rolling') return 'Your turn — roll'
  const dice = p.dice || []
  if (!dice.length) return 'Your turn — no move left: press Pass'
  return `Your turn — move (${bgDiceWords(dice)} left)`
}

// The pips of a die face, as fractions of its box.
const BG_PIPS = {
  1: [[0.5, 0.5]],
  2: [[0.29, 0.29], [0.71, 0.71]],
  3: [[0.29, 0.29], [0.5, 0.5], [0.71, 0.71]],
  4: [[0.29, 0.29], [0.71, 0.29], [0.29, 0.71], [0.71, 0.71]],
  5: [[0.29, 0.29], [0.71, 0.29], [0.5, 0.5], [0.29, 0.71], [0.71, 0.71]],
  6: [[0.29, 0.24], [0.71, 0.24], [0.29, 0.5], [0.71, 0.5], [0.29, 0.76], [0.71, 0.76]]
}

function bgDieFace(value, size) {
  const pips = BG_PIPS[value] || BG_PIPS[1]
  return [
    jsx('rect', { x: 0, y: 0, width: size, height: size, rx: 6, fill: '#f7efdf', stroke: '#8a704f', strokeWidth: 1.5 }, 'face'),
    ...pips.map((pip, index) => jsx('circle', { cx: pip[0] * size, cy: pip[1] * size, r: size * 0.095, fill: '#2b2118' }, `pip${index}`))
  ]
}

// The dice, and the one line that says what is left to do with them. A fresh roll is drawn face
// down behind Roll until it is pressed, then the pips tumble for ~600 ms and come to rest on the
// engine's own numbers. ``prefers-reduced-motion`` skips the tumble and lands them at once.
const BG_TUMBLE_CSS = `
@keyframes bg-tumble {
  0% { transform: rotate(0deg) scale(1); }
  35% { transform: rotate(-155deg) scale(.82); }
  70% { transform: rotate(115deg) scale(1.07); }
  100% { transform: rotate(360deg) scale(1); }
}
.bg-die-rolling { animation: bg-tumble 600ms cubic-bezier(.2,.7,.3,1) both; }
@media (prefers-reduced-motion: reduce) { .bg-die-rolling { animation: none; } }
`

function BackgammonSvg({ picture, height, interactive, onMove, onPhase }) {
  const [picked, setPicked] = useState('')
  const [hint, setHint] = useState('')
  const [tumble, setTumble] = useState([])
  // Which roll key the person has already rolled, and which one is tumbling. The roll phase
  // itself is DERIVED below, from the picture and these two latches, so the Roll button appears
  // in the very same render as the roll it belongs to: a phase kept in state and moved by an
  // effect lagged the picture, and came back on its own every time the table went busy mid-turn.
  const [rolledKey, setRolledKey] = useState('')
  const [tumblingKey, setTumblingKey] = useState('')
  const grip = useRef('')
  const dragged = useRef(false)

  const moves = bgMoves(picture.legal)
  const points = picture.points || Array(24).fill(0)
  const bar = picture.bar || {}
  const off = picture.off || {}
  const dice = (picture.dice || []).map(Number)
  const diceKey = dice.join(',')
  const rollKey = `${picture.table_id || ''}|${picture.plies || 0}|${picture.turn || ''}|${diceKey}`
  // A turn that has not been played yet still holds its whole roll: two dice, or four for
  // doubles. One die spent and it no longer looks like a roll, so the button goes by itself.
  const fullRoll = dice.length === 2 || (dice.length === 4 && dice.every(value => value === dice[0]))
  const waitingRoll = Boolean(interactive) && fullRoll && rolledKey !== rollKey
  const rollPhase = !waitingRoll ? 'move' : (tumblingKey === rollKey ? 'rolling' : 'roll')

  useEffect(() => {
    setPicked('')
    setHint('')
    grip.current = ''
  }, [picture.last, picture.turn, picture.table_id])

  // The dice tumble for ~600 ms and come to rest on the engine's own values. Honouring
  // prefers-reduced-motion means landing them at once, with no roll step to watch.
  useEffect(() => {
    if (rollPhase !== 'rolling') { setTumble([]); return undefined }
    const faces = Math.max(dice.length, 1)
    const tick = () => setTumble(Array.from({ length: faces }, () => 1 + Math.floor(Math.random() * 6)))
    tick()
    const ticking = setInterval(tick, 90)
    const stop = setTimeout(() => {
      clearInterval(ticking)
      setTumble([])
      setRolledKey(rollKey)
      setTumblingKey('')
    }, 620)
    return () => { clearInterval(ticking); clearTimeout(stop) }
  }, [rollPhase, rollKey])

  // The surface above the board draws the one status line; it cannot see the roll phase from the
  // picture, so it is told here, once per change.
  useEffect(() => {
    if (typeof onPhase === 'function') onPhase(rollPhase)
  }, [rollPhase, onPhase])

  const roll = () => {
    if (rollPhase !== 'roll') return false
    if (bgReducedMotion()) { setRolledKey(rollKey); return true }
    setTumblingKey(rollKey)
    return true
  }
  // Pressing Roll, or pointing at the board before rolling: either way the roll happens and the
  // person is told what to do with the dice they now have.
  const startRoll = () => {
    if (!roll()) return false
    setHint('The dice are in. Tap a lit checker, then a lit point.')
    return true
  }

  const movable = name => moves.some(move => move.from === name)
  const target = name => Boolean(picked) && moves.some(move => move.from === picked && move.to === name)
  const litPoints = () => [...new Set(moves.map(move => move.to).filter(name => name !== 'off'))].join(', ')

  const moveNow = move => {
    setPicked('')
    setHint('')
    if (onMove) onMove(move.token)
  }

  // One tap: pick a checker, then pick a lit point. Tapping the picked checker again puts it back.
  const select = name => {
    if (!interactive || !onMove || !name) return
    if (rollPhase === 'roll') { startRoll(); return }
    if (rollPhase === 'rolling') return
    if (name === 'pass') { moveNow({ token: 'pass' }); return }
    const choice = picked ? moves.find(move => move.from === picked && move.to === name) : null
    if (choice) { moveNow(choice); return }
    if (name === picked) { setPicked(''); setHint(''); return }
    if (movable(name)) { setPicked(name); setHint(`Now tap a lit point${litPoints() ? ` (${litPoints()})` : ''}.`); return }
    setPicked('')
    setHint(picked ? 'That checker cannot reach there. Lit points show where it can go.'
      : 'No checker can move from there with these dice. A lit checker can.')
  }

  // Dragging is the same two choices with the finger held down.
  const nameAt = event => {
    if (typeof document === 'undefined' || !event) return ''
    const node = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(event.clientX, event.clientY) : null
    const holder = node && typeof node.closest === 'function' ? node.closest('[data-bg-point]') : null
    return holder ? String(holder.getAttribute('data-bg-point') || '') : ''
  }
  const boardDown = event => {
    if (!interactive) return
    if (rollPhase === 'roll') { startRoll(); return }
    if (rollPhase === 'rolling') return
    grip.current = nameAt(event)
    dragged.current = false
  }
  const boardMove = event => {
    if (!grip.current) return
    if (dragged.current) return
    dragged.current = true
    if (movable(grip.current)) { setPicked(grip.current); setHint(`Drop it on a lit point${litPoints() ? ` (${litPoints()})` : ''}.`) }
  }
  const boardUp = event => {
    const from = grip.current
    const wasDrag = dragged.current
    grip.current = ''
    dragged.current = false
    if (!interactive || !from) return
    const name = nameAt(event)
    if (!wasDrag) { select(name || from); return }
    if (!name || name === from) { if (movable(from)) setPicked(from); return }
    const choice = moves.find(move => move.from === from && move.to === name)
    if (choice) { moveNow(choice); return }
    setPicked(movable(from) ? from : '')
    setHint('That checker cannot reach there. Lit points show where it can go.')
  }

  const shapes = []
  for (let i = 0; i < 24; i += 1) {
    const top = i >= 12, col = top ? i - 12 : 11 - i
    const x = 20 + col * 39 + (col >= 6 ? 30 : 0), y = top ? 30 : 280
    const name = String(i + 1), count = points[i] || 0
    const here = name === picked
    const canMove = movable(name) && !picked
    shapes.push(jsx('polygon', {
      points: `${x},${y} ${x + 36},${y} ${x + 18},${top ? 142 : 168}`,
      'data-bg-point': name,
      fill: target(name) ? '#e6c85a' : (i % 2 ? '#9a5941' : '#e3bb85'),
      stroke: here ? '#ffe36a' : (canMove ? '#c9a24a' : 'none'),
      strokeWidth: here || canMove ? 2 : 0,
      style: { cursor: 'pointer' }
    }, `p${i}`))
    shapes.push(jsx('text', {
      x: x + 18, y: top ? 20 : 299, textAnchor: 'middle', 'data-bg-point': name,
      fill: target(name) ? '#ffe36a' : '#fff', fontSize: 11, fontWeight: target(name) ? 700 : 400,
      style: { cursor: 'pointer' }, children: name
    }, `n${i}`))
    for (let n = 0; n < Math.min(Math.abs(count), 5); n += 1) {
      shapes.push(jsx('circle', {
        cx: x + 18, cy: top ? 48 + n * 21 : 262 - n * 21, r: 15,
        'data-bg-point': name, 'data-bg-checker': name,
        fill: count > 0 ? '#f5e8d0' : '#30251f',
        stroke: here ? '#ffe36a' : (canMove ? '#f0c04a' : '#715c48'),
        strokeWidth: here ? 3 : (canMove ? 2 : 1),
        style: { cursor: 'pointer' }
      }, `c${i}-${n}`))
    }
    if (Math.abs(count) > 5) shapes.push(jsx('text', {
      x: x + 18, y: top ? 142 : 175, textAnchor: 'middle', 'data-bg-point': name,
      fill: '#fff', fontSize: 12, style: { cursor: 'pointer' }, children: String(Math.abs(count))
    }, `count${i}`))
  }

  const barHere = picked === 'bar'
  const barSource = movable('bar') && !picked
  const offTarget = target('off')
  shapes.push(jsx('g', {
    'data-bg-point': 'bar', style: { cursor: 'pointer' },
    children: [
      jsx('rect', {
        x: 470, y: 124, width: 56, height: 26, rx: 6,
        fill: barHere ? '#e6c85a' : 'rgba(255,255,255,0.06)',
        stroke: barHere ? '#ffe36a' : (barSource ? '#c9a24a' : '#715c48'), strokeWidth: barHere || barSource ? 2 : 1
      }, 'barTray'),
      jsx('text', { x: 498, y: 141, fill: barHere ? '#3a2a12' : '#fff', textAnchor: 'middle', fontSize: 12, children: `Bar ${bar.white || 0}/${bar.black || 0}` }, 'barLabel')
    ]
  }, 'bar'))
  shapes.push(jsx('g', {
    'data-bg-point': 'off', style: { cursor: 'pointer' },
    children: [
      jsx('rect', {
        x: 470, y: 147, width: 56, height: 26, rx: 6,
        fill: offTarget ? '#e6c85a' : 'rgba(255,255,255,0.06)',
        stroke: offTarget ? '#ffe36a' : '#715c48', strokeWidth: offTarget ? 2 : 1
      }, 'offTray'),
      jsx('text', { x: 498, y: 164, fill: offTarget ? '#3a2a12' : '#fff', textAnchor: 'middle', fontSize: 12, children: `Off ${off.white || 0}/${off.black || 0}` }, 'offLabel')
    ]
  }, 'off'))

  const rolling = rollPhase === 'rolling'
  const faces = rolling && tumble.length === dice.length && dice.length ? tumble : dice
  const diceSize = 34
  const dieEl = (value, index) => jsx('span', {
    key: `die${index}`,
    'data-bg-die': String(value),
    className: rolling ? 'bg-die bg-die-rolling' : 'bg-die',
    style: { display: 'inline-block', lineHeight: 0, animationDelay: `${index * 70}ms` },
    children: jsx('svg', {
      width: diceSize, height: diceSize, viewBox: `0 0 ${diceSize} ${diceSize}`,
      role: 'img', 'aria-label': `die ${value}`, children: bgDieFace(value, diceSize)
    }, 'face')
  })

  const movesLeft = dice.length
  const diceRow = jsxs('div', {
    className: 'bg-dice', 'data-bg-dice': diceKey, 'data-bg-moves-left': String(movesLeft),
    style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minHeight: diceSize + 4 },
    children: [
      faces.length
        ? jsx('div', { style: { display: 'flex', gap: 6, alignItems: 'center' }, children: faces.map((value, index) => dieEl(value, index)) })
        : jsx('span', { style: { fontSize: 13, opacity: 0.8 }, children: 'No dice yet' }),
      movesLeft
        ? jsx('span', { className: 'bg-dice-note', style: { fontSize: 12, opacity: 0.85 }, children: `${movesLeft} move${movesLeft === 1 ? '' : 's'} left` })
        : null,
      rollPhase === 'roll'
        ? jsx('button', {
            type: 'button', 'data-bg-roll': '1', onClick: roll,
            style: { fontWeight: 800, padding: '5px 14px', borderRadius: 8, cursor: 'pointer' },
            children: 'Roll'
          })
        : null,
      rolling
        ? jsx('span', { className: 'bg-rolling-note', style: { fontSize: 12, fontStyle: 'italic', opacity: 0.85 }, children: 'Rolling…' })
        : null
    ]
  })

  const controls = jsxs('div', {
    style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 },
    children: [
      jsx('button', {
        type: 'button', 'data-bg-pass': '1', disabled: !interactive || !moves.some(move => move.token === 'pass'),
        onClick: () => select('pass'), children: 'Pass'
      }),
      jsx('button', {
        type: 'button', 'data-bg-bar': '1', disabled: !interactive || !barSource,
        onClick: () => select('bar'), children: `Bar (${bar[picture.turn] || 0})`
      }),
      jsx('button', {
        type: 'button', 'data-bg-off': '1', disabled: !interactive || !offTarget,
        onClick: () => select('off'), children: 'Bear off'
      }),
      jsx('span', { style: { fontSize: 12, opacity: 0.7 }, children: 'Drag a checker, or tap it and then a lit point.' })
    ]
  })

  const words = hint || (picked
    ? `Now tap a lit point${litPoints() ? ` (${litPoints()})` : ''}.`
    : movable('bar') && !picked ? 'A checker is on the bar: tap Bar, then a lit point.'
      : moves.length && moves[0].token !== 'pass'
        ? 'Tap a lit checker, then a lit point. Drag works too.'
        : interactive ? 'Nothing can move with these dice. Press Pass.' : 'Your turn is over.')

  return jsxs('div', {
    'data-bg-turn': interactive ? 'mine' : 'theirs',
    'data-bg-phase': rollPhase,
    style: { width: '100%', maxWidth: 540 },
    children: [
    jsx('svg', {
      viewBox: '0 0 530 310', height: height || 320, width: '100%',
      role: 'img', 'aria-label': 'Backgammon board',
      onPointerDown: boardDown, onPointerMove: boardMove, onPointerUp: boardUp,
      onPointerCancel: () => { grip.current = ''; dragged.current = false },
      style: { touchAction: 'none', color: '#e9e3d7', cursor: interactive ? 'pointer' : 'default' },
      children: [
        jsx('rect', { x: 0, y: 0, width: 530, height: 310, rx: 8, fill: '#65412c' }, 'base'),
        ...shapes
      ]
    }),
    jsx('style', { children: BG_TUMBLE_CSS }),
    diceRow,
    controls,
    jsx('div', {
      role: 'status', 'aria-live': 'polite', 'data-bg-hint': hint ? 'warn' : 'help',
      className: 'bg-hint',
      style: { marginTop: 6, fontSize: hint ? 12.5 : 12, fontWeight: hint ? 650 : 400, color: hint ? '#ffd479' : '#cfc7ba' },
      children: words
    })
  ] })
}

// The cover the Play grid draws into its 130 px stage (coverArt, 14-board-svg.js): the same brown
// board the table draws, seen from above, holding the standard opening position and nothing else -
// no controls, no dice, no clicks. It is the one picture on a Backgammon tile, so the tile reads as
// the game it opens instead of the dark stand-in scene worldScene draws for an unknown id.
function backgammonCover(width, height) {
  const w = width || 160
  const h = height || 110
  const pad = 8
  const innerW = w - pad * 2
  const innerH = h - pad * 2
  const barH = 8
  const half = (innerH - barH) / 2
  const colW = innerW / 12
  const r = Math.min(colW * 0.38, half * 0.15)
  const step = r * 1.75
  const points = Array(24).fill(0)
  ;[[24, 2], [13, 5], [8, 3], [6, 5], [1, -2], [12, -5], [17, -3], [19, -5]]
    .forEach(([number, count]) => { points[number - 1] = count })
  const kids = [
    jsx('rect', { x: 0, y: 0, width: w, height: h, rx: 8, fill: '#65412c' }, 'base'),
    jsx('rect', { x: pad, y: pad, width: innerW, height: innerH, rx: 4, fill: '#5a3a26' }, 'field'),
    jsx('rect', { x: pad, y: pad + half, width: innerW, height: barH, fill: '#3f2718' }, 'bar')
  ]
  for (let i = 0; i < 24; i += 1) {
    const top = i >= 12
    const col = top ? i - 12 : 11 - i
    const x = pad + col * colW
    const base = top ? pad : pad + innerH
    const tip = top ? pad + half * 0.9 : pad + innerH - half * 0.9
    kids.push(jsx('polygon', {
      points: `${x},${base} ${x + colW},${base} ${x + colW / 2},${tip}`,
      fill: i % 2 ? '#9a5941' : '#e3bb85'
    }, `point${i}`))
    const count = points[i]
    const stack = Math.min(Math.abs(count), 5)
    for (let k = 0; k < stack; k += 1) {
      const cy = top ? pad + r + k * step : pad + innerH - r - k * step
      kids.push(jsx('circle', {
        cx: x + colW / 2, cy, r,
        fill: count > 0 ? '#f5e8d0' : '#30251f', stroke: '#715c48', strokeWidth: 0.8
      }, `checker${i}-${k}`))
    }
  }
  return jsx('svg', {
    viewBox: `0 0 ${w} ${h}`,
    preserveAspectRatio: 'xMidYMid meet',
    style: { width: '100%', height: h, display: 'block' },
    children: kids
  }, 'backgammon-cover')
}
