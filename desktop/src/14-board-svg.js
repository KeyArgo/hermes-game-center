// ---- 14-board-svg.js: the one component that draws a board, plus the chess pieces and covers
// One cell's piece: the vendored drawing is 800x800, so a nested svg scales it
// to whatever the board is drawn at. The pieces take no clicks of their own.
function chessPiece(mark, x, y, cell, key) {
  const shapes = PIECE_ART[mark]
  if (!shapes) return null
  const size = cell * 0.92
  const inset = (cell - size) / 2
  return jsx('svg', {
    x: x + inset,
    y: y + inset,
    width: size,
    height: size,
    viewBox: '0 0 800 800',
    style: { pointerEvents: 'none' },
    children: shapes.map((shape, i) => jsx(shape[0], { ...shape[1], style: { pointerEvents: 'none' } }, `${key}-${i}`))
  }, key)
}

function BoardSvg({ picture, height, interactive, onMove, flat, pending, onPending, coachArrows }) {
  const [picked, setPicked] = useState([])
  const [hover, setHover] = useState(null)
  // The piece in the person's hand. Present from the press until the release, so a press
  // lifts it and a drag carries it; a press without movement is a click on that square.
  const [grip, setGrip] = useState(null)
  const gripRef = useRef(null)
  const [promotion, setPromotion] = useState(null)
  const [falling, setFalling] = useState(null)
  const [pop, setPop] = useState(1)
  const [flipScale, setFlipScale] = useState(1)
  const [flips, setFlips] = useState(() => new Set())
  const seenLast = useRef('')
  const prevCells = useRef(null)

  useEffect(() => {
    setPicked([])
    setPromotion(null)
    setGrip(null)
    gripRef.current = null
  }, [picture && picture.last, picture && picture.turn, picture && picture.status, picture && picture.game])

  useEffect(() => {
    const key = `${picture.game}:${picture.table_id || ''}:${picture.plies || ''}:${picture.last}:${picture.status}`
    if (!picture.last || key === seenLast.current) return
    seenLast.current = key
    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      prevCells.current = picture.cells ? picture.cells.map(row => row.slice()) : null
      setFalling(null)
      setPop(1)
      setFlipScale(1)
      setFlips(new Set())
      return
    }
    const to = picture.last_to || (picture.view === 'connect4' && /^\d+$/.test(String(picture.last || ''))
      ? (() => {
          const col = parseInt(picture.last, 10) - 1
          const cells = picture.cells || []
          for (let row = 0; row < cells.length; row += 1) {
            if ((cells[row] || [])[col] && cells[row][col] !== '.') return { row, col, name: picture.last }
          }
          return null
        })()
      : null)
    if (picture.view === 'connect4' && to) {
      const pad = 10
      const cell = 36
      const startY = pad + 18
      const landY = pad + to.row * cell + cell / 2
      const t0 = performance.now()
      let frame = 0
      const tick = now => {
        const u = Math.min(1, (now - t0) / 280)
        setFalling({ col: to.col, row: to.row, y: startY + (landY - startY) * u * u * u })
        if (u < 1) frame = requestAnimationFrame(tick)
        else setTimeout(() => setFalling(null), 60)
      }
      frame = requestAnimationFrame(tick)
      return () => cancelAnimationFrame(frame)
    }
    const prev = prevCells.current
    const next = picture.cells
    const changed = new Set()
    if (prev && next) {
      for (let row = 0; row < next.length; row += 1) {
        for (let col = 0; col < (next[row] || []).length; col += 1) {
          const a = (prev[row] || [])[col]
          const b = (next[row] || [])[col]
          if (a && b && a !== '.' && b !== '.' && a !== b) changed.add(`${row}-${col}`)
        }
      }
    }
    prevCells.current = next ? next.map(row => row.slice()) : null
    if (picture.view === 'reversi') {
      setFlips(changed)
      const t0 = performance.now()
      let frame = 0
      const tick = now => {
        const u = Math.min(1, (now - t0) / 180)
        setFlipScale(u < 0.5 ? 1 - u * 2 : (u - 0.5) * 2)
        setPop(Math.min(1, u + 0.2))
        if (u < 1) frame = requestAnimationFrame(tick)
        else {
          setFlipScale(1)
          setPop(1)
          setFlips(new Set())
        }
      }
      setPop(0.2)
      frame = requestAnimationFrame(tick)
      return () => cancelAnimationFrame(frame)
    }
    if (picture.view === 'gomoku' || picture.view === 'tictactoe') {
      const t0 = performance.now()
      let frame = 0
      const tick = now => {
        const u = Math.min(1, (now - t0) / 140)
        setPop(0.2 + 0.8 * u)
        if (u < 1) frame = requestAnimationFrame(tick)
        else setPop(1)
      }
      setPop(0.2)
      frame = requestAnimationFrame(tick)
      return () => cancelAnimationFrame(frame)
    }
    prevCells.current = next ? next.map(row => row.slice()) : prevCells.current
  }, [picture.last, picture.view, picture.game, picture.status, picture.table_id, picture.plies])

  const view = picture.view
  const announcePending = move => {
    if (onPending) onPending(move)
  }
  const sideMark = (picture.turn === 'black' ? (picture.marks && picture.marks[1]) : (picture.marks && picture.marks[0])) || (picture.turn === 'black' ? 'O' : 'X')
  // Chess and checkers (and Breakthrough, which uses the checkers board) move a piece that is
  // already on the board. Everything else puts a new piece on the square or column you touch.
  const pieces = view === 'chess' || view === 'checkers'
  const legal = picture.legal || []
  const startsAt = name => legal.some(item => view === 'chess'
    ? String(item).slice(0, 2) === name
    : String(item).replace(/-/g, ' ').split(/\s+/)[0] === name)

  // A chess move may be a choice: the pawn reaching the last rank can become four things.
  // Ask on the board with four pieces instead of quietly taking the queen.
  const playChessMove = (from, to) => {
    const base = `${from}${to}`
    const longer = legal.filter(item => String(item).indexOf(base) === 0 && String(item).length === base.length + 1)
    if (longer.length > 1) {
      setPromotion({ from, to, choices: longer.map(item => String(item).slice(base.length)) })
      setPicked([])
      return
    }
    const match = legal.find(item => item === base) || longer[0]
    if (!match) return
    setPromotion(null)
    announcePending({ view, from, to })
    setPicked([])
    if (onMove) onMove(match)
  }

  const playChessFrom = (from, to) => {
    if (!startsAt(from)) return
    playChessMove(from, to)
  }

  // One tap: choose a piece, then choose where it goes. Dragging is the same two choices with
  // the finger held down.
  const legalToken = name => (picture.legal || []).find(item => String(item).toLowerCase() === String(name).toLowerCase())
  const tap = hit => {
    if (!onMove || !hit) return
    if (view === 'connect4') {
      if ((picture.legal || []).includes(String(hit.col + 1))) {
        announcePending({ view, col: hit.col, side: picture.turn || 'white' })
        onMove(String(hit.col + 1))
      }
      return
    }
    if (view === 'kalah') {
      if (hit.kind === 'pit' && (picture.legal || []).includes(String(hit.pit))) onMove(String(hit.pit))
      return
    }
    if (hit.kind !== 'cell') return
    if (view === 'reversi' || view === 'gomoku' || view === 'tictactoe' || view === 'hex') {
      const token = legalToken(hit.name)
      if (!token) return
      announcePending({ view, to: hit.name, mark: sideMark })
      onMove(token)
      return
    }
    if (view === 'checkers') {
      // Announce from inside the callback: a click that is not a move (re-picking, or a stray
      // square) must never leave the person's piece drawn on a square it cannot reach.
      setPicked(clickPath(picture.legal || [], picked, hit.name, move => {
        const parts = String(move).replace(/-/g, ' ').split(/\s+/).filter(Boolean)
        const last = parts.length ? parts[parts.length - 1] : hit.name
        const from = parts.length > 1 ? parts[parts.length - 2] : (picked[picked.length - 1] || '')
        announcePending({ view, from, to: last })
        if (onMove) onMove(move)
      }))
      return
    }
    if (view === 'chess') {
      if (picked.length && picked[0] !== hit.name && chessTargets(legal, picked).includes(hit.name)) {
        playChessMove(picked[0], hit.name)
        return
      }
      setPicked(startsAt(hit.name) ? [hit.name] : [])
    }
  }

  // What the person just clicked is on the board at once, before the table answers.
  const shown = pending ? { ...picture, cells: pendingCells(picture, pending) } : picture
  const liftCell = grip ? { row: grip.row, col: grip.col } : null
  const shownHover = interactive ? hover : null

  let drawn
  if (view === 'connect4') {
    drawn = renderConnect4(shown, { interactive, falling, lift: grip, hoverCol: shownHover && shownHover.kind === 'column' ? shownHover.col : null })
  } else if (view === 'kalah') drawn = renderKalah(shown, { interactive, hoverPit: shownHover && shownHover.kind === 'pit' ? shownHover.pit : null })
  else if (view === 'hex') drawn = renderHex(shown, { interactive, hoverName: shownHover && shownHover.kind === 'cell' ? shownHover.name : null })
  else drawn = renderGrid(shown, {
    interactive, picked, flips, flipScale, pop, lift: liftCell,
    hoverCell: shownHover && shownHover.kind === 'cell' ? shownHover : null,
    coachArrows
  })
  if (grip) {
    // The piece in hand, drawn last so it floats over the squares it passes.
    const size = (drawn.geom && drawn.geom.cell) || 36
    const lift = 1.12
    if (view === 'chess') drawn.kids.push(chessPiece(grip.mark, grip.x - size * lift / 2, grip.y - size * lift / 2, size * lift, 'drag-piece'))
    else drawn.kids.push(disc(grip.x, grip.y, size * 0.34 * lift, grip.mark && grip.mark.toLowerCase() === 'x' ? '#f0d0b0' : '#7a2018', { opacity: 0.95, style: { pointerEvents: 'none' } }, 'drag-piece'))
  }
  if (hover && hover.kind === 'column') {
    const cx = ((drawn.geom && drawn.geom.pad) || 10) + hover.col * ((drawn.geom && drawn.geom.cell) || 36) + ((drawn.geom && drawn.geom.cell) || 36) / 2
    drawn.kids.push(jsx('circle', { cx, cy: ((drawn.geom && drawn.geom.pad) || 10) + 18, r: 14, fill: '#f5d76e', opacity: 0.42, style: { pointerEvents: 'none' } }, 'hover-drop'))
  }

  const pointOf = event => pointerToBoard(event, (event && event.currentTarget) || null, drawn)
  const hitOf = event => boardHit(drawn, picture, pointOf(event))
  const movable = hit => Boolean(pieces && interactive && hit && hit.kind === 'cell'
    && (picture.cells[hit.row] || [])[hit.col] && (picture.cells[hit.row] || [])[hit.col] !== '.'
    && startsAt(hit.name))

  const start = event => {
    if (!interactive) return
    const hit = hitOf(event)
    if (!movable(hit)) return
    const point = pointOf(event)
    const next = {
      name: hit.name, row: hit.row, col: hit.col,
      mark: picture.cells[hit.row][hit.col],
      x: point.x, y: point.y,
      startX: event.clientX, startY: event.clientY, moved: false
    }
    gripRef.current = next
    setGrip(next)
    setPicked([hit.name])
    if (event.currentTarget && typeof event.currentTarget.setPointerCapture === 'function') {
      try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* a plain host has no capture */ }
    }
  }

  const move = event => {
    const current = gripRef.current
    if (current) {
      const point = pointOf(event)
      const next = { ...current, x: point.x, y: point.y, moved: current.moved || Math.hypot((event.clientX || 0) - current.startX, (event.clientY || 0) - current.startY) > 4 }
      gripRef.current = next
      setGrip(next)
      return
    }
    if (!interactive) return
    if (view === 'connect4') {
      const col = connect4Column(event, event.currentTarget, drawn, 7, 36, 10)
      setHover(col == null ? null : { kind: 'column', col })
      return
    }
    const hit = hitOf(event)
    setHover(hit && (hit.kind === 'cell' || hit.kind === 'pit') ? hit : null)
  }

  const end = event => {
    const current = gripRef.current
    gripRef.current = null
    setGrip(null)
    if (!interactive) return
    const hit = hitOf(event)
    if (!current) {
      tap(hit)
      return
    }
    if (!current.moved) {
      tap({ kind: 'cell', row: current.row, col: current.col, name: current.name })
      return
    }
    // Dropped on a square this piece can reach: play it. Dropped anywhere else: it goes back.
    if (!hit || hit.kind !== 'cell' || hit.name === current.name) { setPicked([]); return }
    if (view === 'chess') {
      if (!chessTargets(legal, [current.name]).includes(hit.name)) { setPicked([]); return }
      playChessFrom(current.name, hit.name)
      return
    }
    setPicked(clickPath(legal, [current.name], hit.name, move => {
      announcePending({ view, from: current.name, to: hit.name })
      if (onMove) onMove(move)
    }))
  }

  const stage = jsx('div', {
    className: 'games-board-stage',
    style: {
      position: 'relative',
      width: '100%',
      aspectRatio: `${drawn.w} / ${drawn.h}`,
      maxHeight: height ? `${height}px` : undefined,
      margin: '0 auto'
    },
    children: jsxs('svg', {
      role: 'img',
      'aria-label': `${picture.game || picture.view} board${picture.turn ? `, ${picture.turn} to move` : ''}${picture.last ? `, last move ${picture.last}` : ''}`,
      viewBox: `0 0 ${drawn.w} ${drawn.h}`,
      preserveAspectRatio: 'xMidYMid meet',
      onPointerDown: start,
      onPointerMove: move,
      onPointerUp: end,
      onPointerCancel: () => { gripRef.current = null; setGrip(null); setHover(null) },
      onPointerLeave: () => setHover(null),
      style: {
        width: '100%',
        height: '100%',
        display: 'block',
        background: flat ? 'transparent' : '#101820',
        // the board is drawn dark in both themes, so anything that inherits its text colour
        // must be the light ink; otherwise light mode paints near-black labels on near-black art
        color: '#e9e3d7',
        touchAction: 'none',
        cursor: interactive ? (pieces ? 'grab' : 'pointer') : 'default',
        borderRadius: flat ? 0 : 12
      },
      children: drawn.kids
    })
  })
  if (!promotion) return stage
  // Promotion: four pieces, on the board, pressed like any other square.
  const pieceName = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }
  return jsxs('div', { className: 'games-board-wrap', style: { position: 'relative', width: '100%' }, children: [
    stage,
    jsxs('div', {
      className: 'games-promotion', role: 'group', 'aria-label': 'Choose a promotion piece',
      style: {
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: 10, background: 'rgba(8, 12, 18, .82)', borderRadius: 12
      },
      children: [
        jsx('div', { style: { fontSize: 13, fontWeight: 650, color: '#e8edf4' }, children: 'Your pawn becomes:' }),
        jsx('div', { style: { display: 'flex', gap: 8 }, children: promotion.choices.map(choice => jsx('button', {
          type: 'button',
          'aria-label': pieceName[choice] || choice,
          onClick: () => {
            const move = `${promotion.from}${promotion.to}${choice}`
            setPromotion(null)
            announcePending({ view, from: promotion.from, to: promotion.to })
            if (onMove) onMove(move)
          },
          style: { width: 64, height: 64, borderRadius: 10, border: '1px solid #394656', background: '#1a2430', color: '#e8edf4', fontSize: 12, fontWeight: 650, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 },
          children: [
            jsx('span', { 'aria-hidden': true, style: { display: 'block', width: 34, height: 34 }, children: chessPiece(picture.turn === 'black' ? String(choice).toLowerCase() : String(choice).toUpperCase(), 0, 0, 34, `pick-${choice}`) }),
            jsx('span', { children: pieceName[choice] || choice })
          ]
        }, choice)) })
      ]
    })
  ] })
}

function coverArt(id, height) {
  const pictured = startingPicture(id)
  if (pictured && pictured.view === 'arena') {
    return jsx(ArenaStage, { picture: pictured, height: height || 110 })
  }
  if (id === 'blackjack' || id === 'slots') {
    // The Play grid draws every board into one 130 px stage. These two scenes used to be drawn
    // 160 wide and stretched across the whole tile, so the slot cabinet and the card table read
    // bigger than the boards beside them. Draw them square in the same stage and centre them.
    const side = height || 110
    return jsx('div', {
      style: { width: side, height: side, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
      children: worldScene(id, side, side)
    })
  }
  if (pictured && pictured.view === 'seabattle') {
    return seaBattleCover(160, height || 110)
  }
  // Backgammon points, bar and off tray are its own board (BackgammonSvg), so it needs its own
  // cover: without this branch the picture below would fall through to BoardSvg's grid renderer and
  // draw a chess-like grid on the tile. Owner's ask, 2026-11-11.
  if (pictured && pictured.view === 'backgammon') {
    return backgammonCover(160, height || 110)
  }
  if (pictured) {
    return jsx(BoardSvg, { picture: pictured, height: height || 110, interactive: false })
  }
  return worldScene(id, 160, height || 110)
}
