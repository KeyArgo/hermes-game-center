// ---- 16-seabattle.js: Sea Battle, two ten-by-ten waters, a ship tray, and drag placement
// The board is plain divs, not the shared SVG: a fleet is placed by dragging a ship from the
// tray, which the one-square click path in BoardSvg cannot say, and the enemy's fleet must never
// be drawn. Every coordinate the person sees is the game's own (a1 … j10).


const SEA_FILES = 'abcdefghij'
const SEA_RANKS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
const SEA_SHIP_LABELS = {
  carrier: 'Carrier', battleship: 'Battleship', cruiser: 'Cruiser',
  submarine: 'Submarine', destroyer: 'Destroyer'
}
// Game art only: these sit on the board, never on chrome (which uses the host's theme tokens).
const SEA_WATER = ['#1b3b5a', '#16324d']
const SEA_FOG = ['#1f2d3d', '#1a2634']
const SEA_GRID = '#2b4c6f'
const SEA_HULL = '#64748b'
const SEA_HULL_EDGE = '#94a3b8'
const SEA_HIT = '#ef4444'
const SEA_HIT_RING = '#fca5a5'
const SEA_MISS = '#93c5fd'
const SEA_SUNK = '#451a1a'
const SEA_SUNK_EDGE = '#dc2626'
const SEA_GLOW = '#38bdf8'
const SEA_BAD = '#ef4444'
const SEA_LAST = '#facc15'
// The two boards must never be mistaken for each other: yours is teal and says DEFEND,
// theirs is orange and says FIRE. Colour alone is not enough, so each carries its word.
const SEA_TONE = {
  own: { edge: '#2dd4bf', strip: '#14b8a6', title: '#5eead4', word: 'DEFEND', glyph: '⚓' },
  enemy: { edge: '#fb923c', strip: '#f97316', title: '#fdba74', word: 'FIRE', glyph: '✛' }
}

// Landing a shot on the enemy fleet is the loudest moment in the game: the board takes the
// hit with it, not just a caption. Reduced-motion users get the words and no shake.
const SEA_STYLE = `
@keyframes sea-shake { 0%, 100% { transform: translate(0, 0) } 20% { transform: translate(-5px, 3px) } 40% { transform: translate(5px, -3px) } 60% { transform: translate(-4px, 2px) } 80% { transform: translate(3px, -1px) } }
@keyframes sea-flash { 0% { opacity: .9; transform: translate(-50%, -50%) scale(.55) } 100% { opacity: 0; transform: translate(-50%, -50%) scale(1.15) } }
@keyframes sea-pop { 0% { transform: translate(-50%, -50%) scale(.72) } 35% { transform: translate(-50%, -50%) scale(1.1) } 100% { transform: translate(-50%, -50%) scale(1) } }
@media (prefers-reduced-motion: reduce) { .games-seabattle, .games-seabattle * { animation: none !important } }
`


function seaFootprint(size, row, col, orient) {
  const cells = []
  for (let step = 0; step < size; step += 1) {
    cells.push({ row: row + (orient === 'v' ? step : 0), col: col + (orient === 'h' ? step : 0) })
  }
  return cells
}

function seaFits(cells, grid) {
  return cells.every(cell => {
    if (cell.row < 0 || cell.row > 9 || cell.col < 0 || cell.col > 9) return false
    const line = grid[cell.row] || []
    return (line[cell.col] || '.') === '.'
  })
}

// The square to name when a hull is dropped. Horizontal hulls grow along a rank, so
// the square under the pointer is already the hull's first cell. A vertical hull grows
// toward higher ranks on the server, while the board draws rank 10 at the top and the
// ghost hangs downward, so the server's anchor is the hull's far end, not the square
// under the pointer. Sending the near square put every vertical ship on the wrong side
// of the drop: a carrier dropped at a5 was stored at a5..a9 while the ghost showed
// a5..a1.
function seaAnchor(size, row, col, orient) {
  const rank = 10 - (orient === 'v' ? row + size - 1 : row)
  return `${SEA_FILES[col]}${rank}`
}

// Where each hull cell sits inside its ship, so the ends can be rounded and the
// middle left square: one flat silhouette instead of five loose tiles.
function seaHulls(picture) {
  const found = {}
  ;(picture.own_ships || []).forEach(ship => {
    const cells = ship.cells || []
    const axis = new Set(cells.map(name => String(name).slice(1))).size === 1 ? 'h' : 'v'
    cells.forEach((name, index) => {
      found[name] = {
        ship: ship.name, axis, first: index === 0, last: index === cells.length - 1,
        sunk: Boolean(ship.sunk)
      }
    })
  })
  return found
}

function seaMark(code) {
  if (code === 'M') return 'M'
  if (code === 'H' || code === 'X') return 'H'
  return ''
}

// A square is a button only while a press on it does something real: a held ship
// can land on it, a placed hull can be lifted off it, or an unfired enemy square
// can be shot. Every other square is plain water — a div — so the screen never
// offers two hundred presses that change nothing. The drop/unplace/fire actions
// themselves live in the table's window mouse-up handler, keyed off
// [data-sea-cell], so the play path is the same whatever the tag is.
function SeaCell({ hull, cell, tint, mark, last, onPick, onEnter, ghost, ghostOk, actionable, label, cursor }) {
  const kids = []
  const isCursor = cursor === label
  if (hull) {
    const round = hull.axis === 'h'
      ? { borderTopLeftRadius: hull.first ? 9 : 2, borderBottomLeftRadius: hull.first ? 9 : 2, borderTopRightRadius: hull.last ? 9 : 2, borderBottomRightRadius: hull.last ? 9 : 2 }
      : { borderTopLeftRadius: hull.first ? 9 : 2, borderTopRightRadius: hull.first ? 9 : 2, borderBottomLeftRadius: hull.last ? 9 : 2, borderBottomRightRadius: hull.last ? 9 : 2 }
    kids.push(jsx('span', {
      'aria-hidden': true,
      style: {
        position: 'absolute', inset: 2, background: hull.sunk ? SEA_SUNK : SEA_HULL,
        border: `1px solid ${hull.sunk ? SEA_SUNK_EDGE : SEA_HULL_EDGE}`, ...round
      }
    }, 'hull'))
    kids.push(jsx('span', {
      'aria-hidden': true,
      style: {
        position: 'absolute', left: '50%', top: '50%', width: cell * 0.26, height: cell * 0.26,
        transform: 'translate(-50%, -50%)', background: hull.sunk ? SEA_SUNK_EDGE : '#475569', borderRadius: 2
      }
    }, 'deck'))
  }
  if (mark === 'H') {
    kids.push(jsx('span', {
      'aria-hidden': true,
      style: {
        position: 'absolute', left: '50%', top: '50%', width: cell * 0.5, height: cell * 0.5,
        transform: 'translate(-50%, -50%)', background: SEA_HIT, borderRadius: '50%',
        border: `2px solid ${SEA_HIT_RING}`
      }
    }, 'hit'))
  } else if (mark === 'M') {
    kids.push(jsx('span', {
      'aria-hidden': true,
      style: {
        position: 'absolute', left: '50%', top: '50%', width: cell * 0.22, height: cell * 0.22,
        transform: 'translate(-50%, -50%)', background: SEA_MISS, borderRadius: '50%',
        boxShadow: `0 0 0 2px ${SEA_MISS}55`
      }
    }, 'miss'))
  }
  if (ghost) {
    kids.push(jsx('span', {
      'aria-hidden': true,
      style: {
        position: 'absolute', inset: 1, borderRadius: 3,
        background: ghostOk ? `${SEA_GLOW}47` : `${SEA_BAD}52`,
        border: `2px solid ${ghostOk ? SEA_GLOW : SEA_BAD}`
      }
    }, 'ghost'))
  }
  if (last) {
    kids.push(jsx('span', {
      'aria-hidden': true,
      style: { position: 'absolute', inset: 1, border: `2px solid ${SEA_LAST}`, borderRadius: 3 }
    }, 'last'))
  }
  if (isCursor && !hull) {
    kids.push(jsx('span', {
      'aria-hidden': true,
      style: { position: 'absolute', inset: 0, border: `3px solid ${accent}`, borderRadius: 2, boxShadow: `inset 0 0 8px ${accent}4a`, pointerEvents: 'none' }
    }, 'cursor'))
  }
  const style = {
    width: cell, height: cell, position: 'relative', boxSizing: 'border-box', padding: 0,
    border: `1px solid ${SEA_GRID}`, background: tint, overflow: 'hidden',
    cursor: onPick || onEnter ? 'pointer' : 'default'
  }
  if (!actionable) {
    return jsx('div', {
      className: 'games-sea-cell',
      'aria-label': label,
      'data-sea-cell': label,
      onMouseEnter: onEnter,
      style,
      children: kids
    }, label)
  }
  return jsx('button', {
    type: 'button',
    className: 'games-sea-cell',
    'aria-label': label,
    'data-sea-cell': label,
    onClick: onPick,
    onMouseEnter: onEnter,
    style,
    children: kids
  }, label)
}

function SeaBoard({ title, badge, cells, fog, hulls, cell, interactive, onCell, ghostCells, ghostOk, lastSquare, cursor }) {
  const tone = SEA_TONE[fog ? 'enemy' : 'own']
  const ghost = new Set((ghostCells || []).map(item => `${item.row}-${item.col}`))
  const rows = SEA_RANKS.map((rank, row) => jsxs('div', {
    role: 'row',
    style: { display: 'contents' },
    children: SEA_FILES.split('').map((file, col) => {
      const name = `${file}${rank}`
      const code = (cells[row] || [])[col] || '.'
      const isGhost = ghost.has(`${row}-${col}`)
      // Enemy squares are pressable while they are still unfired waters and it is your
      // turn to fire; own squares while a ship hovers over them or a hull sits on them.
      const actionable = Boolean(interactive) &&
        (fog ? code === '.' : Boolean((hulls && hulls[name]) || isGhost))
      return jsx(SeaCell, {
        label: name,
        cell,
        hull: hulls ? hulls[name] : null,
        tint: fog ? SEA_FOG[(row + col) % 2] : SEA_WATER[(row + col) % 2],
        mark: seaMark(code),
        ghost: isGhost,
        ghostOk,
        actionable,
        last: lastSquare === name,
        cursor,
        onPick: actionable ? () => onCell(row, col, name) : null,
        onEnter: interactive ? () => onCell(row, col, name, true) : null
      }, name)
    })
  }, `r${row}`))
  const files = SEA_FILES.split('').map((file, index) => jsx('span', { children: file }, `lf${index}`))
  const labels = SEA_RANKS.map((rank, row) => jsx('span', { style: { lineHeight: `${cell}px` }, children: rank }, `lr${row}`))
  return jsxs('section', {
    'aria-label': title,
    'data-sea-board': fog ? 'enemy' : 'own',
    style: {
      border: `2px solid ${tone.edge}`, borderRadius: 12, background: card,
      boxShadow: `inset 0 0 0 1px ${tone.edge}33`,
      padding: cell >= 26 ? 12 : 8, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0
    },
    children: [
      jsxs('div', {
        'data-sea-tone': fog ? 'enemy' : 'own',
        style: {
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
          borderBottom: `1px solid ${tone.edge}55`, paddingBottom: 5, marginBottom: 1
        },
        children: [
          jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }, children: [
            jsx('span', { 'aria-hidden': true, style: { color: tone.title, fontSize: 13, lineHeight: 1 }, children: tone.glyph }),
            jsx('b', { style: { fontSize: 12, letterSpacing: 0.6, color: tone.title, whiteSpace: 'nowrap' }, children: title }),
            jsx('span', {
              style: {
                fontSize: 9, letterSpacing: 0.9, fontWeight: 700, color: '#0b1220',
                background: tone.strip, borderRadius: 4, padding: '1px 5px', lineHeight: 1.5
              },
              children: tone.word
            })
          ] }),
          badge ? jsx('span', { style: { fontSize: 11, color: text.tertiary, fontFamily: 'var(--font-mono, monospace)' }, children: badge }) : null
        ]
      }),
      jsxs('div', {
        style: { display: 'flex', gap: 6, alignItems: 'flex-start' },
        children: [
          jsx('div', {
            'aria-hidden': true,
            style: {
              display: 'grid', gridTemplateRows: `repeat(10, ${cell}px)`, alignItems: 'center', width: 20,
              fontFamily: 'var(--font-mono, monospace)', fontSize: 10, color: text.tertiary, textAlign: 'right'
            },
            children: labels
          }),
          jsxs('div', {
            style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
            children: [
              jsx('div', {
                role: 'grid',
                'aria-label': `${title} board`,
                style: { display: 'grid', gridTemplateColumns: `repeat(10, ${cell}px)`, gridAutoRows: `${cell}px`, background: SEA_GRID },
                children: rows
              }),
              jsx('div', {
                'aria-hidden': true,
                style: {
                  display: 'grid', gridTemplateColumns: `repeat(10, ${cell}px)`,
                  fontFamily: 'var(--font-mono, monospace)', fontSize: 10, color: text.tertiary, textAlign: 'center'
                },
                children: files
              })
            ]
          })
        ]
      })
    ]
  })
}

// A ship drawn as a ship, not as a row of squares: hull with a raked bow, a deck line, the
// superstructure and turrets that grow with the class, a funnel and a mast. It is the picture on
// the tray chip and on the shipyard strip, so the setup phase looks like a navy yard instead of a
// list of words (owner's ask, 2026-11-09).
function SeaShipArt({ name = 'cruiser', size = 3, width = 96, lit = false, tone = '' }) {
  const height = Math.max(18, Math.round(width * 0.26))
  // In the end-of-game review a hull is red when it went down and grey when it survived; anywhere
  // else it keeps the fleet's teal (or gold, when it is the one in the hand).
  const sunkTone = tone === 'sunk'
  const aliveTone = tone === 'afloat'
  const hull = sunkTone ? '#7f1d1d' : (aliveTone ? '#334155' : SEA_HULL)
  const edge = sunkTone ? '#fca5a5' : (aliveTone ? '#94a3b8' : (SEA_HULL_EDGE || '#0f766e'))
  const deck = sunkTone ? '#f87171' : (aliveTone ? '#94a3b8' : (lit ? '#fbbf24' : '#0f766e'))
  const y = height / 2
  const hullDepth = height * 0.34
  // Bow at the right: the top deck runs flat, then rakes down to a point.
  const hullPath = [
    `M ${width * 0.04} ${y - hullDepth * 0.45}`,
    `L ${width * 0.82} ${y - hullDepth * 0.45}`,
    `L ${width * 0.98} ${y}`,
    `L ${width * 0.82} ${y + hullDepth * 0.5}`,
    `L ${width * 0.06} ${y + hullDepth * 0.5}`,
    'Z'
  ].join(' ')
  const turrets = Math.max(1, Math.min(3, size - 1))
  return jsxs('svg', {
    'data-sea-ship-art': name,
    width, height, viewBox: `0 0 ${width} ${height}`, role: 'img',
    'aria-label': `${SEA_SHIP_LABELS[name] || name} silhouette`,
    style: { display: 'block' },
    children: [
      jsx('path', { d: hullPath, fill: hull, stroke: edge, strokeWidth: Math.max(0.6, height * 0.02) }, 'hull'),
      jsx('line', {
        x1: width * 0.08, y1: y - hullDepth * 0.45, x2: width * 0.8, y2: y - hullDepth * 0.45,
        stroke: deck, strokeWidth: Math.max(0.7, height * 0.03), opacity: 0.9
      }, 'deck'),
      // Superstructure: a block whose length grows with the class.
      jsx('rect', {
        x: width * 0.34, y: y - hullDepth * 0.95, width: width * (0.1 + size * 0.02), height: hullDepth * 0.5,
        fill: sunkTone ? '#991b1b' : (aliveTone ? '#475569' : (lit ? '#f59e0b' : '#115e59')), stroke: edge, strokeWidth: 0.5, rx: 1
      }, 'bridge'),
      jsx('rect', {
        x: width * 0.52, y: y - hullDepth * 1.25, width: width * 0.045, height: hullDepth * 0.8,
        fill: sunkTone ? '#b91c1c' : (aliveTone ? '#64748b' : (lit ? '#fbbf24' : '#134e4a')), stroke: edge, strokeWidth: 0.4
      }, 'funnel'),
      jsx('line', {
        x1: width * 0.27, y1: y - hullDepth * 1.5, x2: width * 0.27, y2: y - hullDepth * 0.5,
        stroke: sunkTone ? '#fecaca' : (aliveTone ? '#cbd5e1' : (lit ? '#fbbf24' : '#99f6e4')), strokeWidth: 0.8
      }, 'mast'),
      ...Array.from({ length: turrets }, (unused, index) => jsx('circle', {
        cx: width * (0.2 + index * 0.16), cy: y - hullDepth * 0.62, r: Math.max(1.2, hullDepth * 0.13),
        fill: sunkTone ? '#fca5a5' : (aliveTone ? '#cbd5e1' : (lit ? '#fde68a' : '#5eead4')), stroke: edge, strokeWidth: 0.4
      }, `turret-${index}`))
    ]
  })
}

// The end-of-game review: five hulls a side, the ones that went down in red, the survivors grey.
// Your kills are drawn in the enemy's waters, your losses in your own, so the picture answers
// "what did I get, what did they get" at a glance (owner's ask, 2026-11-09).
function SeaFleetReview({ ships, where, label }) {
  if (!ships || !ships.length) return null
  return jsxs('div', {
    'data-sea-fleet': where,
    style: {
      display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', alignItems: 'flex-end',
      padding: '6px 8px', borderRadius: 10, border: `1px solid ${stroke}`, background: card,
      maxWidth: '100%', boxSizing: 'border-box'
    },
    children: [
      jsx('span', { style: { width: '100%', fontSize: 11, color: text.tertiary, textAlign: 'center' }, children: label }),
      ...ships.map(ship => jsxs('div', {
        'data-sea-fleet-ship': `${ship.name}:${ship.sunk ? 'sunk' : 'afloat'}`,
        title: `${SEA_SHIP_LABELS[ship.name] || ship.name} — ${ship.sunk ? 'sunk' : 'still afloat'}`,
        style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, opacity: ship.sunk ? 1 : 0.55 },
        children: [
          jsx(SeaShipArt, { name: ship.name, size: ship.size, width: 34 + ship.size * 9, tone: ship.sunk ? 'sunk' : 'afloat' }),
          jsx('span', { style: { fontSize: 10, color: ship.sunk ? '#fca5a5' : text.tertiary }, children: SEA_SHIP_LABELS[ship.name] || ship.name })
        ]
      }, ship.name))
    ]
  })
}

function SeaTrayChip({ ship, held, onGrab, onRelease }) {
  const lit = held && held.name === ship.name
  const art = jsx(SeaShipArt, { name: ship.name, size: ship.size, width: 34 + ship.size * 12, lit }, 'art')
  return jsxs('button', {
    type: 'button',
    className: 'games-sea-chip',
    'data-sea-chip': ship.name,
    title: `${SEA_SHIP_LABELS[ship.name] || ship.name} (${ship.size}) — press and drag onto your waters. A click turns it.`,
    onMouseDown: event => { event.preventDefault(); onGrab(ship) },
    onMouseUp: () => onRelease(ship),
    style: {
      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 8,
      border: `1px solid ${lit ? accent : stroke}`, background: lit ? fill : 'transparent',
      color: text.secondary, cursor: 'grab', fontSize: 12, fontWeight: 600, userSelect: 'none'
    },
    children: [
      art,
      jsx('span', { style: { fontFamily: 'var(--font-mono, monospace)', fontSize: 11, color: text.tertiary }, children: ship.size }, 'len'),
      jsx('span', { children: SEA_SHIP_LABELS[ship.name] || ship.name }, 'name')
    ]
  }, ship.name)
}

// True when a keystroke belongs to a text field rather than to this board. The chat
// composer sits beside the board, so a window-level key listener must never act on
// keys typed there (space, Enter and the arrows were being swallowed).
function seaTyping(event) {
  // The focused element is the truth: in the desktop app the chat composer can own the
  // keystroke while the event target is the window, so a–j / 0–9 were moving the board's
  // cursor as the person typed. A text field anywhere in focus means the board stays still.
  const active = typeof document !== 'undefined' ? document.activeElement : null
  if (active) {
    if (active.isContentEditable) return true
    const tag = String(active.tagName || '').toUpperCase()
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  }
  const target = event && event.target
  if (!target) return false
  if (target.isContentEditable) return true
  return Boolean(target.closest && target.closest('input, textarea, select, [contenteditable]'))
}

// The one line under the boards: who fired, where, and — when a ship goes down — whose
// ship it was and which one, so a kill is never reported as a plain "hit".
// Which explosion the board plays: only the player's own hits on the enemy fleet shake
// the water. Being hit is the enemy's moment and gets words, not fireworks.
function seaBoomFor(last, side) {
  if (!last || !side || last.side !== side) return ''
  if (last.result === 'sunk') return 'sunk'
  return last.result === 'hit' ? 'hit' : ''
}

function seaShotWords(last, side) {
  if (!last) return ''
  const mine = last.side === side
  const who = mine ? 'You' : (side ? 'The computer' : (last.side === 'white' ? 'White' : 'Black'))
  if (last.result === 'sunk') {
    const ship = String(SEA_SHIP_LABELS[last.ship] || last.ship || 'ship').toLowerCase()
    return mine
      ? `💥 You sank the enemy ${ship} at ${last.square}`
      : `☠ The enemy sank your ${ship} at ${last.square}`
  }
  return `${who} ${last.result === 'hit' ? 'hit' : 'missed'} at ${last.square}`
}

// Where the hit graphics go. A shot is fired at one square of one fleet, so the flash
// belongs on that square and the banner belongs on those waters — not on the whole panel,
// where a bloom between the boards reads as if the middle of the table was hit.
// Both take two client rects (the container, and the target) and answer in the container's
// own coordinates, which is what a position:absolute child wants.
function seaBoomCentre(boardBox, cellBox) {
  const width = (cellBox && cellBox.width) || 28
  return {
    x: Math.round((cellBox.left || 0) - (boardBox.left || 0) + width / 2),
    y: Math.round((cellBox.top || 0) - (boardBox.top || 0) + ((cellBox.height || width) / 2)),
    size: Math.max(120, Math.round(width * 5))
  }
}

function seaBoardCentre(boardBox, areaBox) {
  return {
    x: Math.round((areaBox.left || 0) - (boardBox.left || 0) + (areaBox.width || 0) / 2),
    y: Math.round((areaBox.top || 0) - (boardBox.top || 0) + (areaBox.height || 0) / 2)
  }
}

function SeaBattleTable({ picture, interactive, busy, onMove }) {
  const [held, setHeld] = useState(null)
  const [hover, setHover] = useState(null)
  const [pressed, setPressed] = useState(null)
  const [refused, setRefused] = useState('')
  useEffect(() => { setHeld(null); setHover(null); setPressed(null) },
    [picture.table_id, picture.phase, picture.your_side, picture.turn, picture.status])

  const cell = 28
  const side = picture.your_side || ''
  const own = picture.own_cells || []
  const enemy = picture.enemy_cells || []
  const tray = picture.tray || []
  const phase = picture.phase
  const over = Boolean(picture.status && !['active', 'idle', 'preview', 'abandoned'].includes(picture.status))
  const cover = picture.cover && !over ? picture.cover : null
  const yourTurn = picture.turn === side && picture.status === 'active'
  const canPlace = Boolean(interactive) && phase === 'place' && Boolean(side) && tray.length > 0 && !cover
  const canFire = Boolean(interactive) && phase === 'fire' && yourTurn && !cover
  const hulls = seaHulls(picture)
  const shots = picture.shots || { you: 0, them: 0, your_hits: 0, their_hits: 0 }
  const left = picture.ships_left || { you: 5, them: 5 }
  const last = picture.last_shot || null

  const footprint = held && hover ? seaFootprint(held.size, hover.row, hover.col, held.orient) : []
  const fits = held && hover ? seaFits(footprint, own) : false

  const placing = held && hover
    ? `Placing the ${SEA_SHIP_LABELS[held.name] || held.name} at ${SEA_FILES[hover.col]}${10 - hover.row}${fits ? '' : ' — not enough water there'}`
    : ''
  const note = placing || refused || seaShotWords(last, side)
  // What the player has actually destroyed, in words, for as long as the game lasts:
  // the banner is gone in two seconds, the kill list is not.
  const sunkNames = (picture.enemy_ships || []).map(ship => SEA_SHIP_LABELS[ship.name] || ship.name)

  // The big moment: a hit or a sinking gets a banner across the boards for a couple of
  // seconds, so the person feels the shot land instead of reading a footnote. Keyed on
  // the shot itself, so a re-render or a poll never replays an old banner.
  const boardRef = useRef(null)
  // Whether this table is actually on screen. A table that is mounted somewhere hidden (a route the
  // app keeps alive, a collapsed pane) must never make a sound or a banner: that was the periodic
  // firing the owner heard with no game open (2026-11-09).
  const [onScreen, setOnScreen] = useState(true)
  useEffect(() => {
    const node = boardRef.current
    if (!node || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver(
      entries => setOnScreen(entries.some(entry => entry.isIntersecting && entry.intersectionRatio > 0.03)),
      { threshold: [0, 0.03] }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const [boom, setBoom] = useState(null)
  const [blast, setBlast] = useState(null)
  // A turn's own shot and the computer's answer arrive together, so the board reads the
  // whole tail of the log and plays each new shot in turn rather than only the newest.
  const shotsNow = (Array.isArray(picture.last_shots) && picture.last_shots.length)
    ? picture.last_shots
    : (last ? [last] : [])
  const shotStamp = shot => `${shot.side}:${shot.square}:${shot.result}`
  const shotKey = shotsNow.map(shotStamp).join('|')
  // Which shots have been announced, and whether this mount has taken its first look at the board.
  // The old effect replayed the newest shot whenever the pass card lifted, staggered the banners
  // 520 ms apart, and could re-announce what it had already said - the owner's report, 2026-11-09:
  // "it tells me things late or after it already told me, and seems random". One shot, once, now:
  // only the newest unannounced hit is spoken, immediately, and a shot that lands behind the pass
  // card is spoken when the card lifts.
  const seenShots = useRef(new Set())
  const primed = useRef(false)
  // The square the shot landed on, and the waters it landed in, measured at the moment the flash is
  // played, inside the frame that draws that fleet's water: a hit blooms on the square that was
  // fired at and the lettering sits in those waters, never in the gap between the two boards
  // (bughunter, 2026-11-09). Null when there is no layout to measure (a test host, a hidden pane);
  // the render then falls back to the middle of that board.
  const seaTargets = shot => {
    const node = boardRef.current
    if (!node || !node.getBoundingClientRect || !node.querySelector) return { cell: null, waters: null }
    const board = shot.side === side ? 'enemy' : 'own'
    const frame = node.querySelector(`[data-sea-frame="${board}"]`)
    if (!frame || !frame.getBoundingClientRect) return { cell: null, waters: null }
    const frameBox = frame.getBoundingClientRect()
    const square = frame.querySelector(`[data-sea-board="${board}"] [data-sea-cell="${shot.square}"]`)
    return {
      cell: square && square.getBoundingClientRect ? seaBoomCentre(frameBox, square.getBoundingClientRect()) : null,
      waters: seaBoardCentre(frameBox, frameBox)
    }
  }
  useEffect(() => {
    if (!onScreen) return undefined
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return undefined
    const newest = shotsNow[shotsNow.length - 1]
    if (!newest) return undefined
    if (!primed.current) {
      // Arriving mid-game is not news: everything already on the board is history. The newest is
      // history too unless the screen was covered when it landed.
      primed.current = true
      shotsNow.slice(0, -1).forEach(shot => seenShots.current.add(shotStamp(shot)))
      if (!cover) seenShots.current.add(shotStamp(newest))
    }
    // While the pass card is up nothing is marked seen, so it plays as soon as it can be looked at.
    if (cover) return undefined
    const fresh = shotsNow.filter(shot => !seenShots.current.has(shotStamp(shot)))
    if (!fresh.length) return undefined
    // The biggest news among the new shots, not merely the newest: the computer answers a shot at
    // once, so the person's own sinking shot usually arrives with a reply miss behind it and was
    // being dropped (owner's report, 2026-11-11). A sinking beats a hit beats a miss; a tie goes
    // to the latest.
    const weight = row => (row.result === 'sunk' ? 2 : row.result === 'hit' ? 1 : 0)
    const shot = fresh.reduce((best, row) => (weight(row) >= weight(best) ? row : best), fresh[0])
    fresh.forEach(row => seenShots.current.add(shotStamp(row)))
    if (shot.result === 'miss') return undefined
    const shipName = SEA_SHIP_LABELS[shot.ship] || 'ship'
    const mine = shot.side === side
    const words = shot.result === 'sunk'
      ? (mine ? `💥 You sank their ${shipName}!` : `☠ Your ${shipName} went down!`)
      : (mine ? '🔥 Direct hit!' : '⚠ You took a hit!')
    // The lettering belongs over the fleet it is about: a hit on their ship over ENEMY WATERS, a
    // hit on ours over YOUR WATERS. The flash is measured on the square that was fired at, inside
    // that fleet's own frame, so both graphics sit on the board the shot happened on instead of in
    // the middle of the table (bughunter, 2026-11-09).
    const at = seaTargets(shot)
    setBlast({ words, good: mine, big: shot.result === 'sunk', where: mine ? 'enemy' : 'own', at: at.waters })
    gamesSound(shot.result === 'sunk' ? 'sunk' : (mine ? 'hitlight' : 'hit'))
    if (shot.result === 'sunk' || shot.result === 'hit') setBoom({ kind: shot.result, where: mine ? 'enemy' : 'own', at: at.cell })
    const timers = [
      setTimeout(() => setBlast(null), shot.result === 'sunk' ? 2000 : 1500),
      setTimeout(() => setBoom(null), shot.result === 'sunk' ? 1000 : 700)
    ]
    return () => timers.forEach(clearTimeout)
  }, [shotKey, cover, onScreen])

  // Pressing a chip picks the ship up at once, so the drag that follows has a
  // hull to carry. Releasing it on the chip itself (no drag) turns it instead.
  // The ref is set in the same event as the state: a drop that arrives before
  // React has painted the new state still finds the ship in the hand.
  const heldRef = useRef(null)
  const grab = ship => {
    const next = heldRef.current && heldRef.current.name === ship.name
      ? heldRef.current
      : { name: ship.name, size: ship.size, orient: 'h' }
    heldRef.current = next
    setPressed({ name: ship.name })
    setHeld(next)
    setHover(null)
    setRefused('')
  }
  const release = ship => {
    if (!pressed || pressed.name !== ship.name) return
    const same = heldRef.current && heldRef.current.name === ship.name
    const next = { name: ship.name, size: ship.size, orient: same && heldRef.current.orient === 'h' ? 'v' : 'h' }
    heldRef.current = next
    setHeld(next)
    setPressed(null)
  }

  const ownCell = (row, col, name, entering) => {
    if (entering) {
      if (held) setHover({ row, col })
    }
  }

  // Every drop is resolved from the pointer's own position at mouse-up. A cell's
  // own handler can be skipped while the table re-renders (the board briefly
  // turns non-interactive while a move is applied), and a dropped ship would be
  // silently lost; a window-level listener sees the same real mouse and always
  // finds the square under it.
  const [cursor, setCursor] = useState(null)
  const live = useRef({})
  live.current = { phase, side, cover, canFire, own, enemy, hulls, onMove, cursor }
  useEffect(() => { heldRef.current = null }, [picture.table_id, picture.phase, picture.your_side, picture.turn, picture.status])
  useEffect(() => {
    const onUp = event => {
      const node = document.elementFromPoint(event.clientX, event.clientY)
      const cell = node && node.closest ? node.closest('[data-sea-cell]') : null
      const board = cell && cell.closest('[data-sea-board]')
      if (!cell || !board) return
      const name = cell.getAttribute('data-sea-cell') || ''
      const col = SEA_FILES.indexOf(name.slice(0, 1))
      const row = 10 - Number(name.slice(1))
      if (col < 0 || !(row >= 0 && row <= 9)) return
      const now = live.current
      if (board.getAttribute('data-sea-board') === 'own') {
        const carried = heldRef.current
        if (carried) {
          const cells = seaFootprint(carried.size, row, col, carried.orient)
          if (seaFits(cells, now.own)) {
            now.onMove(`place ${carried.name} ${seaAnchor(carried.size, row, col, carried.orient)} ${carried.orient}`)
            heldRef.current = null
            setHeld(null)
            setHover(null)
            setRefused('')
          } else {
            // A refused drop is not a cancelled one: keep the hull in the hand and say
            // why, or the ship looks like it fell out of the game.
            setRefused(`${SEA_SHIP_LABELS[carried.name] || carried.name} needs more clear water there — try another square.`)
          }
          setPressed(null)
        } else if (now.phase === 'place' && now.side && !now.cover) {
          const hull = now.hulls[name]
          if (hull) now.onMove(`unplace ${hull.ship}`)
        }
      } else if (now.canFire) {
        const code = (now.enemy[row] || [])[col]
        if (!code || code === '.') now.onMove(`fire ${name}`)
      }
    }
    const onDown = event => {
      const now = live.current
      if (!now.phase || !now.side) return
      // Never take a keystroke the person is typing: the chat composer sits beside this
      // board, and swallowing space, Enter and the arrow keys there made typing impossible.
      if (seaTyping(event)) return
      const { key } = event
      // Arrow keys for navigation
      if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
        event.preventDefault()
        const [file, rank] = cursor ? [SEA_FILES.indexOf(cursor[0]), 10 - Number(cursor.slice(1))] : [0, 0]
        let newCol = file, newRow = rank
        if (key === 'ArrowLeft') newCol = Math.max(0, newCol - 1)
        if (key === 'ArrowRight') newCol = Math.min(9, newCol + 1)
        if (key === 'ArrowUp') newRow = Math.max(0, newRow - 1)
        if (key === 'ArrowDown') newRow = Math.min(9, newRow + 1)
        setCursor(`${SEA_FILES[newCol]}${10 - newRow}`)
      }
      // Direct coordinate entry (a-j and 0-9)
      if (/^[a-j]$/i.test(key)) {
        const file = SEA_FILES.indexOf(key.toLowerCase())
        const rank = cursor ? 10 - Number(cursor.slice(1)) : 0
        setCursor(`${SEA_FILES[file]}${10 - rank}`)
      }
      if (/^[0-9]$/.test(key)) {
        const rankNum = key === '0' ? 10 : Number(key)
        const file = cursor ? SEA_FILES.indexOf(cursor[0]) : 0
        if (rankNum >= 1 && rankNum <= 10) setCursor(`${SEA_FILES[file]}${rankNum}`)
      }
      // Enter to fire or interact
      if ((key === 'Enter' || key === ' ') && cursor) {
        event.preventDefault()
        const col = SEA_FILES.indexOf(cursor[0])
        const row = 10 - Number(cursor.slice(1))
        if (now.canFire) {
          const code = (now.enemy[row] || [])[col]
          if (!code || code === '.') now.onMove(`fire ${cursor}`)
        } else if (now.phase === 'place' && !now.cover) {
          const hull = now.hulls[cursor]
          if (hull) now.onMove(`unplace ${hull.ship}`)
        }
      }
    }
    window.addEventListener('mouseup', onUp)
    window.addEventListener('keydown', onDown)
    return () => {
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('keydown', onDown)
    }
  }, [cursor])

  // The ships still to place, drawn under the board they go onto. It wraps inside the column
  // rather than spanning both boards, so a chip is never further from the water than it must be.
  const trayBlock = phase === 'place' && side && tray.length
    ? jsxs('div', {
        'aria-label': 'Ship tray',
        'data-sea-tray': '1',
        style: {
          display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', width: '100%',
          padding: '8px 10px', border: `1px solid ${stroke}`, borderRadius: 10, background: card, boxSizing: 'border-box'
        },
        children: [
          jsx('span', { style: { fontSize: 12, color: text.tertiary, textAlign: 'center' }, children: 'Drag a ship onto your waters. A click turns it.' }),
          jsx('span', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }, children: tray.map(ship => jsx(SeaTrayChip, { ship, held, onGrab: grab, onRelease: release }, ship.name)) }),
          // The shipyard: the hull in the hand, drawn big, turning with it, so the person can see
          // what they are about to put on the water.
          held ? jsxs('div', {
            'data-sea-shipyard': held.name,
            style: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' },
            children: [
              jsx('div', {
                style: { transform: held.orient === 'v' ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' },
                children: jsx(SeaShipArt, { name: held.name, size: held.size, width: 70 + held.size * 14, lit: true })
              }),
              jsx('span', { style: { fontSize: 11, color: text.tertiary }, children: `${SEA_SHIP_LABELS[held.name] || held.name}, ${held.size} long · ${held.orient === 'v' ? 'vertical' : 'horizontal'} (click to turn)` })
            ]
          }) : null,
          jsxs('div', {
            style: { display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' },
            children: [
              button('Random fleet', () => onMove('random'), { disabled: busy }),
              button('Same fleet for both sides', () => onMove('duplicate'), {
                disabled: busy,
                title: 'Ranked fairness: both fleets use the same published layout, so a match turns on hunting, not on placement luck.'
              })
            ]
          })
        ]
      })
    : null
  // A banner centred on the board it is about. It is rendered inside that board's own column, so it
  // cannot drift to a corner of the water: the column's centre is where it lands (owner's ask,
  // 2026-11-09 - a half-width guess put the lettering off to one side).
  // The flash that marks a hit, drawn inside the board it happened on so it is centred on that
  // water rather than on the gap between the two.
  const seaBoom = where => (boom && boom.where === where
    ? jsx('div', {
      'aria-hidden': true,
      'data-sea-boom': where,
      // Where it was put, so a proof can read the square off the page rather than guess it
      // (bughunter, 2026-11-09).
      'data-sea-boom-at': boom.at ? `${boom.at.x},${boom.at.y}` : 'waters',
      style: {
        position: 'absolute', zIndex: 4, pointerEvents: 'none', borderRadius: '50%',
        // On the square that was fired at, in the waters that square belongs to. With no layout
        // to measure, the middle of this board - never the middle of the panel between the two.
        left: boom.at ? boom.at.x : '50%', top: boom.at ? boom.at.y : '42%',
        width: boom.at ? boom.at.size : '80%', height: boom.at ? boom.at.size : '80%',
        transform: 'translate(-50%, -50%)',
        background: boom.kind === 'sunk'
          ? 'radial-gradient(circle at 50% 50%, rgba(255,180,60,0.95), rgba(220,38,38,0.55) 38%, rgba(220,38,38,0) 72%)'
          : 'radial-gradient(circle at 50% 50%, rgba(255,220,120,0.8), rgba(239,68,68,0.4) 40%, rgba(239,68,68,0) 70%)',
        animation: 'sea-flash 620ms ease-out forwards'
      }
    }, `boom-${where}`)
    : null)

  const seaBanner = where => (blast && blast.where === where
    ? jsx('div', {
      role: 'alert',
      'aria-live': 'assertive',
      'data-sea-blast': blast.big ? 'sunk' : 'hit',
      'data-sea-blast-where': where,
      'data-sea-blast-at': blast.at ? `${blast.at.x},${blast.at.y}` : 'waters',
      style: {
        position: 'absolute', left: '50%', top: '42%', transform: 'translate(-50%, -50%)', zIndex: 5,
        pointerEvents: 'none', padding: blast.big ? '12px 18px' : '8px 14px', borderRadius: 14,
        // The banner lives inside the board: a long line wraps instead of spilling over the water.
        fontSize: blast.big ? 22 : 16, fontWeight: 900, letterSpacing: 0.3, whiteSpace: 'normal',
        animation: blast.big ? 'sea-pop 420ms ease-out' : undefined,
        maxWidth: '86%', textAlign: 'center', lineHeight: 1.15, overflowWrap: 'break-word',
        color: '#fff', textShadow: '0 2px 8px rgba(0,0,0,0.6)',
        background: blast.good ? 'rgba(220,38,38,0.88)' : 'rgba(30,41,59,0.92)',
        border: `3px solid ${blast.good ? '#fca5a5' : '#f59e0b'}`,
        boxShadow: blast.good ? '0 0 40px rgba(239,68,68,0.7)' : '0 0 30px rgba(245,158,11,0.5)'
      },
      children: blast.words
    }, `blast-${where}`)
    : null)

  const trayDone = phase === 'place' && side && !tray.length
    ? jsx('div', {
        'data-sea-tray': 'done',
        style: { fontSize: 12, color: text.tertiary, textAlign: 'center' },
        children: 'Fleet deployed. The other side places next.'
      })
    : null

  // The result is a band at the top, under the game's own header (owner's ask, 2026-11-09): it was
  // a card inside the water, which hid the board and read as decoration. Above the boards it is the
  // first thing the eye lands on, on one line, and the water stays visible behind it.
  const result = over
    ? jsxs('div', {
        'data-sea-result': String(picture.winner || 'over'),
        role: 'status',
        'aria-live': 'polite',
        style: {
          display: 'flex', gap: 10, alignItems: 'baseline', justifyContent: 'center', flexWrap: 'wrap',
          padding: '8px 12px', borderRadius: 10, border: `1px solid ${accent}`,
          background: 'rgba(8, 12, 18, 0.55)', textAlign: 'center'
        },
        children: [
          jsx('b', { style: { fontSize: 20, fontWeight: 800 }, children: picture.winner === side && side ? 'You win!' : side && picture.winner && picture.winner !== side ? 'The enemy wins.' : side ? 'Game over.' : `${picture.winner === 'white' ? 'White' : 'Black'} wins.` }),
          jsx('span', { style: { fontSize: 12, color: text.secondary }, children: picture.result_reason === 'resignation' ? 'By resignation.' : 'The losing fleet is at the bottom of the sea.' }),
          jsx('span', { style: { fontSize: 11, color: text.tertiary }, children: `You fired ${shots.you} and hit ${shots.your_hits}. They fired ${shots.them} and hit ${shots.their_hits}.` })
        ]
      })
    : null

  const coverCard = cover
    ? jsxs('div', {
        role: 'status',
        style: {
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', gap: 10,
          alignItems: 'center', justifyContent: 'center', background: paper, borderRadius: 12,
          border: `1px solid ${stroke}`, textAlign: 'center', padding: 18
        },
        children: [
          jsx('div', { style: { fontSize: 18, fontWeight: 700 }, children: `Pass the screen to ${cover.name || (cover.side === 'white' ? 'White' : 'Black')}` }),
          jsx('div', { style: { fontSize: 13, color: text.secondary, maxWidth: 380 }, children: 'Both fleets are hidden while the next player takes the keyboard.' }),
          button('I have the screen', () => onMove('look'), { primary: true, disabled: busy })
        ]
      })
    : null

  const turnLine = over
    ? 'Game over'
    : cover ? 'Screen covered'
      : phase === 'place' ? (canPlace ? 'Place your fleet' : 'Waiting for the other fleet')
        : yourTurn ? 'Fire at enemy waters' : 'The computer fires…'

  // What to do next, in one line, always on screen: the board is a picture a person has to be told
  // how to use, and after placement it used to say nothing at all (owner's ask, 2026-11-09).
  const hint = over
    ? 'The game is over. Play again to lay a new fleet.'
    : cover
      ? 'Press I have the screen when the next player is ready.'
      : phase === 'place'
        ? (canPlace
            ? 'Drag a ship from the tray under YOUR WATERS onto the water, or click a ship to turn it. All five, then fire.'
            : (tray.length
                ? 'Waiting for the other side to place their fleet.'
                : 'Fleet deployed. Waiting for the other side to place theirs.'))
        : yourTurn
          ? 'Click any square in ENEMY WATERS to fire. Hits are marked, misses are rings, and a sunk ship is named above.'
          : 'Waiting for their shot. Your waters are on the left, so watch what they hit.'

  return jsxs('div', {
    className: 'games-seabattle',
    'data-sea-held': held ? `${held.name}:${held.orient}` : '',
    'data-sea-interactive': interactive ? '1' : '0',
    'data-sea-canplace': canPlace ? '1' : '0',
    'data-sea-canfire': canFire ? '1' : '0',
    // Focusable, and it takes focus on a click, so the board owns the keyboard while it
    // is being played and gives it back to the chat composer the moment either is clicked.
    ref: boardRef,
    tabIndex: -1,
    onMouseDown: () => { const node = boardRef.current; if (node && node.focus) node.focus() },
    'data-sea-boom': boom ? boom.kind : '',
    style: {
      display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, flex: '1 1 auto', position: 'relative',
      outline: 'none', animation: boom ? 'sea-shake 520ms ease-in-out' : undefined
    },
    children: [
      jsx('style', { children: SEA_STYLE }, 'style'),
      jsxs('div', {
        style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' },
        children: [
          jsxs('div', {
            style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
            children: [
              jsx('span', {
                'aria-hidden': true,
                style: { width: 10, height: 10, borderRadius: '50%', background: over ? '#7d8796' : yourTurn ? accent : '#7d8796' }
              }, 'dot'),
              jsx('b', { style: { fontSize: 15 }, children: turnLine }, 'turn'),
              note ? jsx('span', { className: 'games-sea-note', style: { fontSize: 12, color: text.secondary }, children: note }, 'note') : null
            ]
          }),
          jsxs('div', {
            'aria-label': 'Scoreboard',
            style: { display: 'flex', gap: 12, fontFamily: 'var(--font-mono, monospace)', fontSize: 11, color: text.tertiary },
            children: [
              jsx('span', { children: `You ${left.you}/5 afloat` }, 'you'),
              jsx('span', { children: `Them ${left.them}/5 afloat` }, 'them'),
              jsx('span', { children: `Shots ${shots.you}–${shots.them}` }, 'shots'),
              sunkNames.length
                ? jsx('span', { 'data-sea-sunk': sunkNames.join(','), style: { color: text.secondary }, children: `Enemy sunk: ${sunkNames.join(', ')}` }, 'sunk')
                : null
            ]
          })
        ]
      }),
      result,
        hint
          ? jsx('div', {
              'data-sea-hint': '1',
              'aria-live': 'polite',
              style: {
                fontSize: 12, lineHeight: 1.4, color: text.secondary, textAlign: 'center',
                padding: '6px 10px', borderRadius: 8, border: `1px solid ${stroke}`, background: card,
                maxWidth: 620, margin: '0 auto', boxSizing: 'border-box'
              },
              children: hint
            })
          : null,
      jsxs('div', {
        className: 'games-seabattle-boards',
        style: { display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'center', flex: '1 1 auto', minHeight: 0 },
        children: [
          // Your waters and the ships you still have to place sit in one column, so the tray is
          // under the board you drag onto instead of under the enemy's (owner's ask, 2026-11-09).
          jsxs('div', {
            className: 'games-sea-own-column',
            style: { position: 'relative', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', minWidth: 0, maxWidth: '100%' },
            children: [
              // The board and its lettering share one frame the exact size of the water, so "You
              // took a hit!" is centred on YOUR WATERS even when the tray or the fleet review makes
              // the column taller or wider (owner's report, 2026-11-09).
              jsxs('div', {
                'data-sea-frame': 'own',
                style: { position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center' },
                children: [
                  jsx(SeaBoard, {
                    title: side ? 'YOUR WATERS' : 'WHITE WATERS', badge: `${left.you}/5 afloat`, cells: own, fog: false,
                    hulls: side || over ? hulls : null, cell, interactive: canPlace || (phase === 'place' && Boolean(side) && !cover), onCell: ownCell,
                    ghostCells: canPlace ? footprint : [], ghostOk: fits,
                    lastSquare: last && last.side !== side ? last.square : '', cursor
                  }, 'own'),
                  seaBanner('own'),
                  seaBoom('own')
                ]
              }, 'own-frame'),
              trayBlock,
              trayDone,
              over ? jsx(SeaFleetReview, {
                ships: picture.own_ships, where: 'own',
                label: `Your fleet — ${(picture.own_ships || []).filter(ship => ship.sunk).length} lost`
              }) : null
            ]
          }, 'own-column'),
          jsxs('div', {
            className: 'games-sea-enemy-column',
            style: { position: 'relative', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', minWidth: 0, maxWidth: '100%' },
            children: [
              jsxs('div', {
                'data-sea-frame': 'enemy',
                style: { position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center' },
                children: [
                  jsx(SeaBoard, {
                    title: side ? 'ENEMY WATERS' : 'BLACK WATERS', badge: `${left.them}/5 afloat`, cells: enemy, fog: true, hulls: null,
                    cell, interactive: canFire, onCell: () => {},
                    lastSquare: last && last.side === side ? last.square : '', cursor
                  }, 'enemy'),
                  seaBanner('enemy'),
                  seaBoom('enemy')
                ]
              }, 'enemy-frame'),
              over ? jsx(SeaFleetReview, {
                ships: picture.enemy_fleet, where: 'enemy',
                label: `Their fleet — ${(picture.enemy_fleet || []).filter(ship => ship.sunk).length} you sank`
              }) : null
            ]
          }, 'enemy-column')
        ]
      }),
      coverCard
    ]
  })
}

// The store card and the start panel: a small still picture of a fleet and two pegs.
function seaBattleCover(width, height) {
  const w = width || 160
  const h = height || 110
  const cell = Math.min((w * 0.36) / 10, (h * 0.7) / 10)
  const gap = 10
  const total = cell * 10
  const left = (w - total * 2 - gap) / 2
  const top = (h - total) / 2
  const kids = [jsx('rect', { width: w, height: h, fill: '#101d2a' }, 'bg')]
  for (let row = 0; row < 10; row += 1) {
    for (let col = 0; col < 10; col += 1) {
      kids.push(jsx('rect', {
        x: left + col * cell, y: top + row * cell, width: cell - 1, height: cell - 1,
        fill: SEA_WATER[(row + col) % 2]
      }, `w${row}-${col}`))
      kids.push(jsx('rect', {
        x: left + total + gap + col * cell, y: top + row * cell, width: cell - 1, height: cell - 1,
        fill: SEA_FOG[(row + col) % 2]
      }, `f${row}-${col}`))
    }
  }
  ;[[3, 1], [3, 2], [3, 3], [6, 5], [7, 5]].forEach((spot, index) => {
    kids.push(jsx('rect', {
      x: left + spot[1] * cell + 1, y: top + spot[0] * cell + 1, width: cell - 2, height: cell - 2,
      rx: 2, fill: SEA_HULL, stroke: SEA_HULL_EDGE, strokeWidth: 0.5
    }, `s${index}`))
  })
  ;[[2, 6], [5, 3], [8, 8]].forEach((spot, index) => {
    kids.push(jsx('circle', {
      cx: left + total + gap + spot[1] * cell + cell / 2, cy: top + spot[0] * cell + cell / 2,
      r: cell * 0.26, fill: index === 1 ? SEA_HIT : SEA_MISS
    }, `p${index}`))
  })
  return jsx('svg', {
    viewBox: `0 0 ${w} ${h}`,
    preserveAspectRatio: 'xMidYMid slice',
    style: { width: '100%', height: h, display: 'block' },
    children: kids
  }, 'sea-cover')
}
