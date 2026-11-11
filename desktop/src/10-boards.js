// ---- 10-boards.js: one drawing per board shape, and the picture a fresh game starts from
function emptyGrid(rows, cols) {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => '.'))
}

function checkersStart() {
  const cells = emptyGrid(8, 8)
  for (let vis = 0; vis < 8; vis += 1) {
    const py = 7 - vis
    for (let col = 0; col < 8; col += 1) {
      if ((py + col) % 2) continue
      if (py <= 2) cells[vis][col] = 'x'
      else if (py >= 5) cells[vis][col] = 'o'
    }
  }
  return cells
}

function startingPicture(id) {
  if (id === ARENA_ID) {
    return {
      view: 'arena',
      game: id,
      preview: true,
      status: 'idle',
      winner: '',
      frames: [],
      events: [],
      combatants: ARENA_SEATS.map(seat => ({ seat: seat.seat, name: seat.name, colour: seat.colour })),
      arena: { w: 960, h: 600 },
      result: { winner: 0, reason: '', kills: [0, 0, 0, 0], damage: [0, 0, 0, 0], hp: [100, 100, 100, 100] },
      duration: 0,
      key_interval_seconds: 0.08,
      battle_id: '',
      card_line: ''
    }
  }
  if (id === 'connect4') {
    return { view: 'connect4', game: id, cells: emptyGrid(6, 7), files: '1234567', ranks: [6, 5, 4, 3, 2, 1], legal: [], preview: true }
  }
  if (id === 'kalah') {
    return { view: 'kalah', game: id, pits: [4, 4, 4, 4, 4, 4, 0, 4, 4, 4, 4, 4, 4, 0], legal: [], preview: true, turn: 'white' }
  }
  if (id === 'reversi') {
    const cells = emptyGrid(8, 8)
    cells[3][3] = 'O'
    cells[4][4] = 'O'
    cells[3][4] = 'X'
    cells[4][3] = 'X'
    return { view: 'reversi', game: id, cells, files: 'abcdefgh', ranks: [1, 2, 3, 4, 5, 6, 7, 8], legal: [], preview: true }
  }
  if (id === 'gomoku') {
    return {
      view: 'gomoku',
      game: id,
      cells: emptyGrid(15, 15),
      files: 'abcdefghijklmno',
      ranks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      legal: [],
      preview: true
    }
  }
  if (id === 'checkers') {
    return { view: 'checkers', game: id, cells: checkersStart(), files: 'abcdefgh', ranks: [8, 7, 6, 5, 4, 3, 2, 1], legal: [], preview: true }
  }
  if (id === 'breakthrough') {
    // Two full ranks a side, round pieces: the checkers board draws it exactly.
    const cells = emptyGrid(8, 8)
    for (let row = 0; row < 8; row += 1) {
      if (row < 2) cells[row] = Array.from({ length: 8 }, () => 'o')
      else if (row > 5) cells[row] = Array.from({ length: 8 }, () => 'x')
    }
    return { view: 'checkers', game: id, cells, files: 'abcdefgh', ranks: [8, 7, 6, 5, 4, 3, 2, 1], legal: [], preview: true }
  }
  if (id === 'go') {
    return { view: 'gomoku', game: id, cells: emptyGrid(9, 9), files: 'abcdefghi', ranks: [1, 2, 3, 4, 5, 6, 7, 8, 9], legal: [], preview: true }
  }
  if (id === 'hex') {
    return { view: 'hex', game: id, cells: emptyGrid(11, 11), files: 'abcdefghijk', ranks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], legal: [], preview: true }
  }
  if (id === 'seabattle') {
    // The still picture before a table exists: one fleet afloat, a couple of pegs.
    const own = emptyGrid(10, 10)
    const enemy = emptyGrid(10, 10)
    const put = (row, col, mark) => { own[row][col] = mark }
    ;[[9, 0], [9, 1], [9, 2], [9, 3], [9, 4]].forEach(([row, col]) => put(row, col, 'S'))
    ;[[7, 0], [7, 1], [7, 2], [7, 3]].forEach(([row, col]) => put(row, col, 'S'))
    ;[[5, 0], [5, 1], [5, 2]].forEach(([row, col]) => put(row, col, 'S'))
    ;[[9, 5], [8, 5], [7, 5]].forEach(([row, col]) => put(row, col, 'S'))
    ;[[6, 7], [5, 7]].forEach(([row, col]) => put(row, col, 'S'))
    enemy[2][4] = 'M'
    enemy[4][6] = 'H'
    enemy[8][8] = 'M'
    return {
      view: 'seabattle', game: id, preview: true, status: 'idle', phase: 'place', your_side: '',
      files: 'abcdefghij', ranks: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
      own_cells: own, enemy_cells: enemy, own_ships: [], enemy_ships: [], tray: [],
      shots: { you: 0, them: 0, your_hits: 0, their_hits: 0 },
      ships_left: { you: 5, them: 5 }, last_shot: null, cover: null,
      levels: [
        { id: 'beginner', label: 'Beginner', line: 'allow-ai seabattle black=local level=beginner' },
        { id: 'intermediate', label: 'Intermediate', line: 'allow-ai seabattle black=local level=intermediate' },
        { id: 'advanced', label: 'Advanced', line: 'allow-ai seabattle black=local level=advanced' },
        { id: 'expert', label: 'Expert', line: 'allow-ai seabattle black=local level=expert' }
      ],
      // The game's own words, so the sentence beside the button reads "(Intermediate)" and not
      // the generic "(Normal)" before a table exists.
      level: 'intermediate', remembered_level: 'intermediate'
    }
  }
  if (id === 'backgammon') {
    // The still picture before a table exists: the standard opening position, no dice rolled yet.
    // Backgammon draws itself on its own board (BackgammonSvg, 14b-backgammon-svg.js) rather than
    // on the grid, and coverArt gives it the same 130 px stage every other Play tile gets.
    const points = Array(24).fill(0)
    ;[[24, 2], [13, 5], [8, 3], [6, 5], [1, -2], [12, -5], [17, -3], [19, -5]]
      .forEach(([number, count]) => { points[number - 1] = count })
    return {
      view: 'backgammon', game: id, preview: true, status: 'idle',
      points, bar: { white: 0, black: 0 }, off: { white: 0, black: 0 }, dice: [], legal: []
    }
  }
  if (id === 'doctrine') {
    const cells = emptyGrid(11, 11)
    // The store cover shows the three beacons and two bots about to meet.
    cells[5][5] = '·'
    cells[2][1] = '1'
    cells[8][9] = '2'
    return {
      view: 'hex', game: id, cells, files: 'abcdefghijk',
      ranks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], legal: [], preview: true,
      doctrine: { mode: 'idle', status: 'idle', frames: [], scoreboard: [], house: [], improve_ready: false, improve_note: '', tree: '', ladder: [], events: [], result: [], pending: {} }
    }
  }
  if (id === 'chess' || id === 'chessboard') {
    return {
      view: 'chess',
      game: id,
      cells: [
        ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'],
        ['p', 'p', 'p', 'p', 'p', 'p', 'p', 'p'],
        ['.', '.', '.', '.', '.', '.', '.', '.'],
        ['.', '.', '.', '.', '.', '.', '.', '.'],
        ['.', '.', '.', '.', '.', '.', '.', '.'],
        ['.', '.', '.', '.', '.', '.', '.', '.'],
        ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'],
        ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R']
      ],
      files: 'abcdefgh',
      ranks: [8, 7, 6, 5, 4, 3, 2, 1],
      legal: [],
      preview: true
    }
  }
  // Card and slot tables draw their own screens; the preview only has to say which one.
  if (id === 'blackjack') {
    return { view: 'blackjack', game: id, preview: true, status: 'idle', phase: 'bet', hand: [], dealer: [], legal: [], bets: [], chips: 0, bet: 0, outcome: '' }
  }
  if (id === 'slots') {
    return { view: id, game: id, preview: true, status: 'idle', reels: ['7', '7', '7'], legal: [], history: [], paytable: [], chips: 0, bet: 0, last_win: 0 }
  }
  if (id === 'tictactoe') {
    return { view: 'tictactoe', game: id, cells: emptyGrid(3, 3), files: 'abc', ranks: [1, 2, 3], legal: [], preview: true }
  }
  return null
}

function squareAt(picture, col, row) {
  const files = picture.files || ''
  const ranks = picture.ranks || []
  return `${files[col]}${ranks[row]}`
}

function clickPath(legal, picked, square, onMove) {
  const next = picked.concat([square])
  const space = next.join(' ')
  const exact = (legal || []).find(item => {
    const parts = String(item).replace(/-/g, ' ')
    return parts === space
  })
  if (exact) {
    onMove(String(exact).replace(/-/g, ' '))
    return []
  }
  const prefix = (legal || []).some(item => {
    const parts = String(item).replace(/-/g, ' ').split(/\s+/)
    return parts.slice(0, next.length).join(' ') === space
  })
  if (prefix) return next
  const starts = (legal || []).some(item => String(item).replace(/-/g, ' ').split(/\s+/)[0] === square)
  return starts ? [square] : []
}

function targetsFrom(legal, picked) {
  if (!picked.length) return []
  const space = picked.join(' ')
  const found = []
  ;(legal || []).forEach(item => {
    const parts = String(item).replace(/-/g, ' ').split(/\s+/)
    if (parts.slice(0, picked.length).join(' ') === space && parts[picked.length]) {
      found.push(parts[picked.length])
    }
  })
  return found
}

function chessTargets(legal, picked) {
  if (!picked.length) return []
  return (legal || [])
    .filter(item => item.slice(0, 2) === picked[0])
    .map(item => item.slice(2, 4))
}

function disc(cx, cy, r, fillColor, extra, key) {
  return jsx('circle', { cx, cy, r, fill: fillColor, ...(extra || {}) }, key)
}

function worldScene(id, width, height) {
  const w = width || 160
  const h = height || 100
  const kids = []
  if (id === 'blackjack') {
    // Green felt with a dealt hand: an ace and a king, the blackjack.
    kids.push(jsx('rect', { width: w, height: h, fill: '#0f4a2c' }, 'felt'))
    kids.push(jsx('ellipse', { cx: w / 2, cy: h * 1.05, rx: w * 0.62, ry: h * 0.7, fill: 'none', stroke: '#d4b45a', strokeWidth: 1.5, opacity: 0.6 }, 'arc'))
    ;[['A', '♠', '#111827', -10, w / 2 - 34], ['K', '♥', '#c81e1e', 8, w / 2 + 2]].forEach(([rank, suit, ink, tilt, x]) => {
      kids.push(jsxs('g', {
        transform: `rotate(${tilt} ${x + 16} ${h * 0.5})`,
        children: [
          jsx('rect', { x, y: h * 0.22, width: 32, height: 46, rx: 4, fill: '#f8fafc', stroke: '#cbd5e1' }),
          jsx('text', { x: x + 5, y: h * 0.22 + 13, fontSize: 11, fontWeight: 700, fill: ink, children: rank }),
          jsx('text', { x: x + 16, y: h * 0.22 + 33, fontSize: 16, textAnchor: 'middle', fill: ink, children: suit })
        ]
      }, rank))
    })
    kids.push(jsx('circle', { cx: w * 0.18, cy: h * 0.78, r: 8, fill: '#b91c1c', stroke: '#fecaca', strokeDasharray: '3 2' }, 'chip1'))
    kids.push(jsx('circle', { cx: w * 0.82, cy: h * 0.78, r: 8, fill: '#1d4ed8', stroke: '#bfdbfe', strokeDasharray: '3 2' }, 'chip2'))
  } else if (id === 'slots') {
    kids.push(jsx('rect', { width: w, height: h, fill: '#2a0f3d' }, 'bg'))
    kids.push(jsx('rect', { x: w * 0.12, y: h * 0.16, width: w * 0.76, height: h * 0.62, rx: 8, fill: '#7c2d12', stroke: '#facc15', strokeWidth: 2 }, 'cab'))
    ;[0, 1, 2].forEach(index => {
      const x = w * 0.18 + index * w * 0.22
      kids.push(jsx('rect', { x, y: h * 0.26, width: w * 0.2, height: h * 0.42, rx: 3, fill: '#fefce8' }, `reel${index}`))
      kids.push(jsx('text', { x: x + w * 0.1, y: h * 0.56, fontSize: h * 0.26, fontWeight: 800, textAnchor: 'middle', fill: '#dc2626', children: '7' }, `seven${index}`))
    })
    kids.push(jsx('text', { x: w / 2, y: h * 0.92, fontSize: 10, fontWeight: 800, letterSpacing: 2, textAnchor: 'middle', fill: '#facc15', children: 'JACKPOT' }, 'word'))
  } else if (id === 'luanti') {
    kids.push(jsx('rect', { width: w, height: h, fill: '#152228' }))
    kids.push(jsx('rect', { x: 0, y: h * 0.62, width: w, height: h * 0.38, fill: '#2a5a3a' }))
    ;[
      [18, 48, 28, '#3d8f6a'],
      [44, 36, 34, '#2f7a58'],
      [78, 42, 30, '#4aa87a'],
      [110, 30, 38, '#357a52']
    ].forEach((cube, index) => {
      kids.push(jsx('rect', { x: cube[0], y: cube[1], width: cube[2], height: cube[2], fill: cube[3], rx: 2 }, index))
      kids.push(jsx('rect', { x: cube[0], y: cube[1], width: cube[2], height: 8, fill: '#7ee0b0', opacity: 0.35 }, `t${index}`))
    })
  } else if (id === 'teeworlds') {
    kids.push(jsx('rect', { width: w, height: h, fill: '#2a1810' }))
    kids.push(jsx('rect', { x: 0, y: h * 0.7, width: w, height: h * 0.3, fill: '#4a2a18' }))
    kids.push(disc(70, 48, 16, '#ff8a5b'))
    kids.push(disc(64, 44, 3, '#1a0c08'))
    kids.push(disc(76, 44, 3, '#1a0c08'))
    kids.push(jsx('rect', { x: 82, y: 46, width: 28, height: 6, fill: '#c0c8d0', rx: 2 }))
    kids.push(jsx('circle', { cx: 112, cy: 38, r: 5, fill: '#ffd36a' }))
  } else {
    kids.push(jsx('rect', { width: w, height: h, fill: '#1a080c' }))
    kids.push(jsx('polygon', { points: `0,${h} ${w * 0.45},${h * 0.35} ${w},${h}`, fill: '#3a1018' }))
    kids.push(jsx('rect', { x: w * 0.42, y: h * 0.2, width: w * 0.16, height: h * 0.55, fill: '#12060a' }))
    kids.push(jsx('rect', { x: 0, y: 0, width: w, height: h * 0.22, fill: '#6a1820' }))
    kids.push(jsx('circle', { cx: w * 0.18, cy: h * 0.72, r: 7, fill: '#e25b5b' }))
    kids.push(jsx('circle', { cx: w * 0.78, cy: h * 0.68, r: 7, fill: '#7ec8ff' }))
  }
  return jsxs('svg', {
    viewBox: `0 0 ${w} ${h}`,
    preserveAspectRatio: 'xMidYMid slice',
    style: { width: '100%', height: h, display: 'block' },
    children: kids
  })
}

function renderConnect4(picture, options) {
  const cells = picture.cells || emptyGrid(6, 7)
  const cols = 7
  const rows = 6
  const cell = 36
  const pad = 10
  const w = pad * 2 + cols * cell
  const h = pad * 2 + rows * cell
  const legal = new Set(picture.legal || [])
  const highlight = new Set((picture.highlight || []).map(cell => `${cell.row}-${cell.col}`))
  const last = picture.last_to || {}
  const falling = options.falling
  const hover = options.hoverCol
  const lift = options.lift
  const kids = [jsx('rect', { width: w, height: h, rx: 12, fill: '#1a4d86' })]
  // One column is lit at a time: the column under the pointer, or the one a keyboard player picked.
  const lit = hover != null ? hover : lift && lift.kind === 'column' ? lift.col : null
  if (lit != null) {
    kids.push(jsx('rect', {
      x: pad + lit * cell, y: pad, width: cell, height: rows * cell,
      fill: '#ffffff', opacity: 0.14, style: { pointerEvents: 'none' }
    }, 'column-lit'))
  }
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const cx = pad + col * cell + cell / 2
      const cy = pad + row * cell + cell / 2
      const mark = (cells[row] || [])[col] || '.'
      const isLast = last.row === row && last.col === col
      const hideLanded = falling && isLast
      const color = hideLanded ? '#0c2438' : mark === 'X' ? '#f5d76e' : mark === 'O' ? '#e25b5b' : '#0c2438'
      const open = legal.has(String(col + 1))
      kids.push(
        jsx(
          'circle',
          {
            cx,
            cy,
            r: 14,
            fill: color,
            stroke: isLast && !falling ? '#7ec8ff' : open && mark === '.' ? '#7ec8ff' : 'none',
            strokeWidth: isLast && !falling ? 3 : open && mark === '.' ? 2 : 0,
            style: { pointerEvents: 'none' }
          },
          `${row}-${col}`
        )
      )
      if (highlight.has(`${row}-${col}`)) {
        kids.push(jsx('circle', {
          cx, cy, r: 16, fill: 'none', stroke: '#ff6b57', strokeWidth: 4, className: 'games-decider',
          style: { pointerEvents: 'none' }
        }, `hl${row}-${col}`))
      }
    }
  }
  if (lit != null) {
    const cx = pad + lit * cell + cell / 2
    // Decoration only: the pointer is read from the svg, so no child needs to catch it.
    kids.push(jsx('circle', { cx, cy: pad + 18, r: 14, fill: lit === hover ? '#f5d76e' : '#7ec8ff', opacity: 0.35, style: { pointerEvents: 'none' } }, 'ghost'))
  }
  if (falling) {
    const cx = pad + falling.col * cell + cell / 2
    const mark = (cells[falling.row] || [])[falling.col]
    kids.push(
      jsx(
        'circle',
        {
          cx,
          cy: falling.y,
          r: 14,
          fill: mark === 'O' ? '#e25b5b' : '#f5d76e',
          stroke: '#7ec8ff',
          strokeWidth: 3,
          style: { pointerEvents: 'none' }
        },
        'fall'
      )
    )
  }
  return { kids, w, h, geom: { kind: 'columns', pad, cell, cols, rows } }
}

function renderKalah(picture, options) {
  const pits = picture.pits || [4, 4, 4, 4, 4, 4, 0, 4, 4, 4, 4, 4, 4, 0]
  const legal = new Set(picture.legal || [])
  const turn = picture.turn || 'white'
  const w = 420
  const h = 180
  const kids = [jsx('rect', { width: w, height: h, rx: 16, fill: '#2a2118' })]
  const bowls = []
  const hovered = options.hoverPit

  function bowl(cx, cy, rx, ry, count, pit, key) {
    const open = legal.has(String(pit))
    if (pit) bowls.push({ pit, x: cx, y: cy, rx, ry })
    if (pit && hovered === pit) {
      kids.push(jsx('ellipse', { cx, cy, rx: rx + 4, ry: ry + 4, fill: 'none', stroke: '#f5d76e', strokeWidth: 2, style: { pointerEvents: 'none' } }, `${key}-hover`))
    }
    kids.push(
      jsx(
        'ellipse',
        {
          cx,
          cy,
          rx,
          ry,
          fill: open ? '#5a4028' : '#3a2e22',
          stroke: open ? '#e0b36a' : '#6a5438',
          strokeWidth: open ? 3 : 1,
          style: { pointerEvents: 'none' }
        },
        key
      )
    )

    kids.push(
      jsx(
        'ellipse',
        {
          cx,
          cy,
          rx,
          ry,
          fill: open ? '#5a4028' : '#3a2e22',
          stroke: open ? '#e0b36a' : '#6a5438',
          strokeWidth: open ? 3 : 1,
          onClick:
            options.interactive && pit
              ? () => options.onMove(String(pit))
              : undefined,
          style: options.interactive && pit ? { cursor: open ? 'pointer' : 'default' } : undefined
        },
        key
      )
    )
    kids.push(
      jsx(
        'text',
        {
          x: cx,
          y: cy + 5,
          textAnchor: 'middle',
          fill: '#e0b36a',
          fontSize: 16,
          fontWeight: 700,
          style: { pointerEvents: 'none' },
          children: count
        },
        `${key}-n`
      )
    )
  }

  bowl(36, 90, 22, 58, pits[13], 0, 'store-b')
  bowl(384, 90, 22, 58, pits[6], 0, 'store-w')
  for (let i = 0; i < 6; i += 1) {
    const pit = turn === 'black' ? 6 - i : 0
    bowl(90 + i * 48, 48, 20, 24, pits[12 - i], turn === 'black' ? 6 - i : 0, `t${i}`)
    bowl(90 + i * 48, 132, 20, 24, pits[i], turn === 'white' ? i + 1 : 0, `b${i}`)
  }
  // The two halves are the bottom and the top of the board, not chess colours: the
  // game's own words for its sides label the stores.
  const sides = (picture && picture.side_words) || {}
  kids.push(jsx('text', { x: 210, y: 18, textAnchor: 'middle', fill: '#c4a574', fontSize: 11, children: sides.black || 'Black' }))
  kids.push(jsx('text', { x: 210, y: 174, textAnchor: 'middle', fill: '#c4a574', fontSize: 11, children: sides.white || 'White' }))
  return { kids, w, h, geom: { kind: 'bowls', bowls } }
}

function renderHex(picture, options) {
  const cells = picture.cells || []
  const size = cells.length || 11
  const files = picture.files || 'abcdefghijk'
  const ranks = picture.ranks || []
  const legal = new Set(picture.legal || [])
  const last = picture.last_to
  const r = 14
  const dx = r * Math.sqrt(3)
  const dy = r * 1.5
  const pad = 26
  const w = pad * 2 + dx * (size - 1) + (dx / 2) * (size - 1) + dx
  const h = pad * 2 + dy * (size - 1) + r * 2
  const kids = [jsx('rect', { width: w, height: h, rx: 12, fill: '#1c1712' }, 'bg')]
  const center = (row, col) => [pad + dx / 2 + col * dx + row * (dx / 2), pad + r + row * dy]
  const corner = (cx, cy, i) => {
    const a = (Math.PI / 180) * (60 * i - 30)
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  }
  const [x0, y0] = center(0, 0)
  const [x1] = center(0, size - 1)
  const [x2, y2] = center(size - 1, 0)
  const [x3] = center(size - 1, size - 1)
  const edge = (xa, ya, xb, yb, color, key, width = 6) =>
    kids.push(jsx('line', { x1: xa, y1: ya, x2: xb, y2: yb, stroke: color, strokeWidth: width, strokeLinecap: 'round' }, key))
  edge(x0, y0 - r - 3, x1, y0 - r - 3, '#f2f4f8', 'et')
  edge(x2, y2 + r + 3, x3, y2 + r + 3, '#f2f4f8', 'eb')
  edge(x0 - dx / 2 - 4, y0, x2 - dx / 2 - 4, y2, '#d9b48a', 'el', 9)
  edge(x1 + dx / 2 + 4, y0, x3 + dx / 2 + 4, y2, '#d9b48a', 'er', 9)
  edge(x0 - dx / 2 - 4, y0, x2 - dx / 2 - 4, y2, '#2a1c14', 'el2')
  edge(x1 + dx / 2 + 4, y0, x3 + dx / 2 + 4, y2, '#2a1c14', 'er2')
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const [cx, cy] = center(row, col)
      const name = `${files[col]}${ranks[row]}`
      const mark = (cells[row] && cells[row][col]) || '.'
      const open = options.interactive && legal.has(name)
      const points = [0, 1, 2, 3, 4, 5].map(i => corner(cx, cy, i).join(',')).join(' ')
      // Hex uses X/O. Doctrine puts bot numbers 1..4 on the same drawing.
      const tint = mark === 'X' || mark === '1' ? '#f2f4f8'
        : mark === 'O' || mark === '2' ? '#2a1c14'
        : mark === '3' ? '#7ec8ff'
        : mark === '4' ? '#f0b45c'
        : '#c9b48c'
      kids.push(
        jsx('polygon', {
          points,
          fill: tint,
          stroke: '#7a6448',
          strokeWidth: 1,
          style: { pointerEvents: 'none' }
        }, `hx${row}-${col}`)
      )
      if (options.hoverName && options.hoverName === name && open) {
        kids.push(jsx('polygon', { points, fill: '#f5d76e', opacity: 0.28, style: { pointerEvents: 'none' } }, `hv${row}-${col}`))
        kids.push(jsx('polygon', { points, fill: 'none', stroke: '#f5d76e', strokeWidth: 2, style: { pointerEvents: 'none' } }, `hv2${row}-${col}`))
      }
      if ('1234'.includes(mark) && mark !== '.') {
        kids.push(jsx('text', {
          x: cx, y: cy + 4, textAnchor: 'middle', fontSize: 11, fontWeight: 700,
          fill: mark === '2' ? '#f2f4f8' : '#101820',
          style: { pointerEvents: 'none' }
        }, `tx${row}-${col}`))
      }
      if (last && last.row === row && last.col === col) {
        kids.push(disc(cx, cy, r * 0.35, '#7ec8ff', { style: { pointerEvents: 'none' } }, `hl${row}-${col}`))
      }
    }
  }
  return { kids, w, h, geom: { kind: 'hex', pad, r, dx, dy, size, files, ranks } }
}

function renderGrid(picture, options) {
  const cells = picture.cells || []
  const rows = cells.length || 8
  const cols = (cells[0] && cells[0].length) || 8
  const view = picture.view
  const cell = view === 'gomoku' ? 22 : view === 'tictactoe' ? 64 : 36
  const pad = view === 'gomoku' ? 16 : 18
  const w = pad * 2 + cols * cell
  const h = pad * 2 + rows * cell
  const legal = picture.legal || []
  const picked = options.picked || []
  // The deciding cells — a mated king, the four or five that won — ringed in red so the
  // result card never covers up the reason it happened.
  const highlight = new Set((picture.highlight || []).map(cell => `${cell.row}-${cell.col}`))
  const showDots = legal.length > 0 && legal.length <= 40
  const kids = []
  const light = view === 'gomoku' ? '#d7c4a0' : view === 'reversi' ? '#1a3d24' : view === 'seabattle' ? '#16324d' : '#cfc3a8'
  const dark = view === 'gomoku' ? '#c4ae86' : view === 'reversi' ? '#16301c' : view === 'seabattle' ? '#1b3b5a' : '#6b4a2e'
  kids.push(jsx('rect', { width: w, height: h, fill: view === 'gomoku' ? '#c4ae86' : view === 'seabattle' ? '#1b3b5a' : '#241810' }))
  if (view === 'gomoku') {
    for (let i = 0; i < rows; i += 1) {
      const pos = pad + i * cell + cell / 2
      kids.push(jsx('line', { x1: pad + cell / 2, y1: pos, x2: w - pad - cell / 2, y2: pos, stroke: '#5a4630', strokeWidth: 1 }, `gh${i}`))
      kids.push(jsx('line', { x1: pos, y1: pad + cell / 2, x2: pos, y2: h - pad - cell / 2, stroke: '#5a4630', strokeWidth: 1 }, `gv${i}`))
    }
  }

  const legalSquares = new Set()
  if (view === 'chess') chessTargets(legal, picked).forEach(item => legalSquares.add(item))
  else if (view === 'checkers') targetsFrom(legal, picked).forEach(item => legalSquares.add(item))
  else legal.forEach(item => legalSquares.add(item))
  if (!picked.length && (view === 'reversi' || view === 'tictactoe' || view === 'gomoku')) {
    legal.forEach(item => legalSquares.add(item))
  }
  if (!picked.length && view === 'checkers') {
    legal.forEach(item => legalSquares.add(String(item).replace(/-/g, ' ').split(/\s+/)[0]))
  }
  if (!picked.length && view === 'chess') {
    legal.forEach(item => legalSquares.add(item.slice(0, 2)))
  }

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = pad + col * cell
      const y = pad + row * cell
      const name = squareAt(picture, col, row)
      const mark = (cells[row] || [])[col] || '.'
      const isDark = (row + col) % 2 === 1
      const selected = picked.includes(name)
      const target = legalSquares.has(name)
      const lifted = options.lift && options.lift.row === row && options.lift.col === col
      const hovered = options.hoverCell && options.hoverCell.row === row && options.hoverCell.col === col
      const last = picture.last_to || {}
      const isLast = last.row === row && last.col === col
      kids.push(
        jsx(
          'rect',
          {
            x,
            y,
            width: cell,
            height: cell,
            fill: view === 'gomoku' ? 'transparent' : selected ? '#7ec8ff' : view === 'reversi' ? light : isDark ? dark : light,
            stroke: view === 'tictactoe' ? '#8a94a4' : view === 'seabattle' ? '#2b4c6f' : 'none',
            strokeWidth: view === 'seabattle' ? 1 : 0,
            style: { pointerEvents: 'none' }
          },
          `s${row}-${col}`
        )
      )
      if (!lifted) {
      if (view === 'reversi' && (mark === 'X' || mark === 'O')) {
        const flipping = options.flips && options.flips.has(`${row}-${col}`)
        kids.push(
          disc(
            x + cell / 2,
            y + cell / 2,
            cell * 0.38,
            mark === 'X' ? '#f2f4f8' : '#14181c',
            {
              transform: flipping ? `scale(${options.flipScale}, 1)` : isLast && options.pop < 1 ? `scale(${options.pop})` : undefined,
              transformOrigin: `${x + cell / 2} ${y + cell / 2}`,
              style: { pointerEvents: 'none' }
            },
            `d${row}-${col}`
          )
        )
      } else if (view === 'checkers' && mark && mark !== '.') {
        const king = mark === 'X' || mark === 'O'
        const white = mark.toLowerCase() === 'x'
        kids.push(disc(x + cell / 2, y + cell / 2, cell * 0.34, white ? '#f0d0b0' : '#7a2018', { style: { pointerEvents: 'none' } }, `p${row}-${col}`))
        if (king) {
          kids.push(
            jsx('circle', {
              cx: x + cell / 2,
              cy: y + cell / 2,
              r: cell * 0.18,
              fill: 'none',
              stroke: '#f5d76e',
              strokeWidth: 2,
              style: { pointerEvents: 'none' }
            }, `k${row}-${col}`)
          )
        }
      } else if (view === 'chess' && mark && mark !== '.') {
        kids.push(chessPiece(mark, x, y, cell, `c${row}-${col}`))
      } else if (view === 'tictactoe' && mark !== '.') {
        kids.push(
          jsx(
            'text',
            {
              x: x + cell / 2,
              y: y + cell * 0.7,
              textAnchor: 'middle',
              fill: mark === 'X' ? '#7ec8ff' : '#e25b5b',
              fontSize: cell * 0.55,
              fontWeight: 700,
              style: { pointerEvents: 'none' },
              children: mark
            },
            `t${row}-${col}`
          )
        )
      } else if (view === 'gomoku' && mark !== '.') {
        kids.push(disc(x + cell / 2, y + cell / 2, cell * 0.36, mark === 'X' ? '#f2f4f8' : '#1a1210', { style: { pointerEvents: 'none' } }, `g${row}-${col}`))
      } else if (view === 'seabattle' && mark !== '.') {
        // Sea Battle: S=ship, H=hit, M=miss, X=sunk
        if (mark === 'S' || mark === 'X') {
          kids.push(jsx('rect', {
            x: x + 2, y: y + 2, width: cell - 4, height: cell - 4,
            fill: mark === 'X' ? '#451a1a' : '#64748b',
            stroke: mark === 'X' ? '#dc2626' : '#94a3b8',
            strokeWidth: 1,
            rx: 2,
            style: { pointerEvents: 'none' }
          }, `sea${row}-${col}`))
        } else if (mark === 'H') {
          kids.push(disc(x + cell / 2, y + cell / 2, cell * 0.25, '#ef4444', { style: { pointerEvents: 'none' } }, `hit${row}-${col}`))
          kids.push(jsx('circle', {
            cx: x + cell / 2, cy: y + cell / 2, r: cell * 0.25,
            fill: 'none', stroke: '#fca5a5', strokeWidth: 1,
            style: { pointerEvents: 'none' }
          }, `hitr${row}-${col}`))
        } else if (mark === 'M') {
          kids.push(disc(x + cell / 2, y + cell / 2, cell * 0.11, '#93c5fd', { style: { pointerEvents: 'none' } }, `miss${row}-${col}`))
        }
      }
      }
      // The empty square under the pointer, for the games where a tap places a piece.
      if (hovered && mark === '.' && (view === 'gomoku' || view === 'reversi' || view === 'tictactoe')) {
        const ghost = view === 'gomoku' ? (picture.turn === 'black' ? '#1a1210' : '#f2f4f8') : view === 'reversi' ? (picture.turn === 'black' ? '#14181c' : '#f2f4f8') : '#7ec8ff'
        kids.push(disc(x + cell / 2, y + cell / 2, cell * (view === 'reversi' ? 0.38 : 0.36), ghost, { opacity: 0.45, style: { pointerEvents: 'none' } }, `hover${row}-${col}`))
      }
      if (lifted) {
        // The piece is in the person's hand: the square it came from shows only a faint disc.
        kids.push(
          jsx('circle', {
            cx: x + cell / 2, cy: y + cell / 2, r: cell * 0.34, fill: '#7ec8ff', opacity: 0.16,
            style: { pointerEvents: 'none' }
          }, `lifted${row}-${col}`)
        )
      }
      if (showDots && target && mark === '.' && view !== 'checkers' && view !== 'chess') {
        kids.push(disc(x + cell / 2, y + cell / 2, 5, '#7ec8ff', { opacity: 0.85, style: { pointerEvents: 'none' } }, `dot${row}-${col}`))
      }
      if ((view === 'checkers' || view === 'chess') && target) {
        kids.push(
          jsx('circle', {
            cx: x + cell / 2,
            cy: y + cell / 2,
            r: mark === '.' ? 6 : cell * 0.42,
            fill: mark === '.' ? '#7ec8ff' : 'none',
            stroke: mark === '.' ? 'none' : '#7ec8ff',
            strokeWidth: 3,
            opacity: 0.85,
            style: { pointerEvents: 'none' }
          }, `tg${row}-${col}`)
        )
      }
      if (isLast && mark !== '.') {
        kids.push(
          jsx('circle', {
            cx: x + cell / 2,
            cy: y + cell / 2,
            r: cell * 0.44,
            fill: 'none',
            stroke: '#7ec8ff',
            strokeWidth: 3,
            style: { pointerEvents: 'none' }
          }, `last${row}-${col}`)
        )
      }
      if (highlight.has(`${row}-${col}`)) {
        kids.push(
          jsx('circle', {
            cx: x + cell / 2,
            cy: y + cell / 2,
            r: cell * 0.47,
            fill: 'none',
            stroke: '#ff6b57',
            strokeWidth: 4,
            className: 'games-decider',
            style: { pointerEvents: 'none' }
          }, `hl${row}-${col}`)
        )
      }
    }
  }
  coachArrowMarks(view, picture, options, pad, cell).forEach(kid => kids.push(kid))
  return { kids, w, h, geom: { kind: 'grid', pad, cell, rows, cols, view } }
}
