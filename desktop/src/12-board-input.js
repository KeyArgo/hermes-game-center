// ---- 12-board-input.js: where a pointer or a key is on the board, and what a click means
// Where a pointer sits in the drawing's own coordinates.
//
// The svg is laid out by CSS (a width, and a height cap) and fits its viewBox with
// preserveAspectRatio="xMidYMid meet", so the drawing is scaled by whichever side runs out first
// and letterboxed on the other. Dividing by the element's client width ignores that, which is what
// put the Connect Four column highlight to the right of the pointer. getScreenCTM is exact when the
// browser offers it; the arithmetic below is the same letterbox, for tests and older hosts.
function pointerToBoard(event, element, drawn) {
  const matrix = element && typeof element.getScreenCTM === 'function' ? element.getScreenCTM() : null
  if (matrix && element && typeof element.createSVGPoint === 'function') {
    const point = element.createSVGPoint()
    point.x = event.clientX
    point.y = event.clientY
    const local = point.matrixTransform(matrix.inverse())
    return { x: local.x, y: local.y }
  }
  const box = (element && typeof element.getBoundingClientRect === 'function' && element.getBoundingClientRect()) || {}
  const width = Number(box.width) || 0
  const height = Number(box.height) || 0
  if (!width || !height) return { x: 0, y: 0 }
  const scale = Math.min(width / drawn.w, height / drawn.h) || 1
  const left = (Number(box.left) || 0) + (width - drawn.w * scale) / 2
  const top = (Number(box.top) || 0) + (height - drawn.h * scale) / 2
  return { x: (event.clientX - left) / scale, y: (event.clientY - top) / scale }
}

// What is under the pointer, named the way the game names it: a square ("e4"), a column
// (Connect Four's "1".."7"), or a pit (Kalah's 1..6). Every game answers the same question,
// so dragging and tapping share one path.
function boardHit(drawn, picture, point) {
  const geom = drawn && drawn.geom
  if (!geom || !point) return null
  if (geom.kind === 'grid') {
    const col = Math.floor((point.x - geom.pad) / geom.cell)
    const row = Math.floor((point.y - geom.pad) / geom.cell)
    if (row < 0 || row >= geom.rows || col < 0 || col >= geom.cols) return null
    return { kind: 'cell', row, col, name: squareAt(picture, col, row) }
  }
  if (geom.kind === 'columns') {
    const bottom = geom.pad + geom.rows * geom.cell
    if (point.y < geom.pad || point.y > bottom) return null
    const col = Math.floor((point.x - geom.pad) / geom.cell)
    if (col < 0 || col >= geom.cols) return null
    return { kind: 'column', col, name: String(col + 1) }
  }
  if (geom.kind === 'hex') {
    let best = null
    for (let row = 0; row < geom.size; row += 1) {
      for (let col = 0; col < geom.size; col += 1) {
        const cx = geom.pad + geom.dx / 2 + col * geom.dx + row * (geom.dx / 2)
        const cy = geom.pad + geom.r + row * geom.dy
        const away = Math.hypot(point.x - cx, point.y - cy)
        if (!best || away < best.away) best = { away, row, col }
      }
    }
    if (!best || best.away > geom.r) return null
    return { kind: 'cell', row: best.row, col: best.col, name: `${geom.files[best.col]}${geom.ranks[best.row]}` }
  }
  if (geom.kind === 'bowls') {
    let best = null
    geom.bowls.forEach(bowl => {
      const away = Math.hypot((point.x - bowl.x) / bowl.rx, (point.y - bowl.y) / bowl.ry)
      if (!best || away < best.away) best = { away, pit: bowl.pit }
    })
    if (!best || best.away > 1) return null
    return { kind: 'pit', pit: best.pit, name: String(best.pit) }
  }
  return null
}

function connect4Column(event, element, drawn, columns, cell, pad) {
  const point = pointerToBoard(event, element, drawn)
  const bottom = drawn.h - pad
  if (point.y < pad || point.y > bottom) return null
  const col = Math.floor((point.x - pad) / cell)
  return col >= 0 && col < columns ? col : null
}

// The square a board name points at, e.g. "e4" or "h8".
function boardPoint(picture, name) {
  const files = String((picture && picture.files) || '')
  const ranks = (picture && picture.ranks) || []
  const raw = String(name == null ? '' : name).trim().toLowerCase()
  if (!raw || !files) return null
  const col = files.indexOf(raw[0])
  const row = ranks.findIndex(rank => String(rank) === raw.slice(1))
  if (col < 0 || row < 0) return null
  return { row, col }
}

// The move a person just clicked, drawn at once.
//
// "Your agent" is a model call, so the table can take a while to answer. The person's own move
// must already be on the board while that happens, never an unchanged board and a silent wait.
// This only moves what the person can already see: the piece they picked, or their own mark.
function pendingCells(picture, pending) {
  const cells = ((picture && picture.cells) || []).map(row => (row || []).slice())
  if (!pending || !cells.length) return cells
  if (pending.view === 'connect4') {
    const col = Number(pending.col)
    const columns = (cells[0] || []).length
    if (!Number.isInteger(col) || col < 0 || col >= columns) return cells
    const mark = pending.side === 'black' ? 'O' : 'X'
    for (let row = cells.length - 1; row >= 0; row -= 1) {
      if (!cells[row] || col >= cells[row].length) continue
      if (cells[row][col] === '.' || cells[row][col] === '') {
        cells[row][col] = mark
        return cells
      }
    }
    return cells
  }
  const to = boardPoint(picture, pending.to)
  if (!to) return cells
  const from = pending.from ? boardPoint(picture, pending.from) : null
  let mark = pending.mark
  if (from && cells[from.row]) mark = cells[from.row][from.col]
  if (!mark || mark === '.') return cells
  if (from && cells[from.row] && (from.row !== to.row || from.col !== to.col)) {
    cells[from.row][from.col] = '.'
  }
  if (cells[to.row]) cells[to.row][to.col] = mark
  return cells
}
