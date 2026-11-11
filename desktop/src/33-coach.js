// Chess Coach is a Labs experiment inside the table.
function coachArrowPairs(picture) {
  if (picture?.view !== 'chess' || !Array.isArray(picture?.coach?.book)) return []
  return picture.coach.book
    .filter(move => typeof move === 'string' && /^[a-h][1-8][a-h][1-8]/.test(move))
    .map(move => ({ from: move.slice(0, 2), to: move.slice(2, 4) }))
}

function coachArrowMarks(view, picture, options, pad, cell) {
  if (view !== 'chess' || !Array.isArray(options?.coachArrows) || options?.picked?.length) return []
  const files = picture?.files
  const ranks = picture?.ranks
  if (typeof files !== 'string' || !Array.isArray(ranks)) return []
  const centre = square => {
    if (typeof square !== 'string' || square.length !== 2) return null
    const col = files.indexOf(square[0])
    const row = ranks.indexOf(Number(square[1]))
    return col < 0 || row < 0 ? null : { x: pad + col * cell + cell / 2, y: pad + row * cell + cell / 2 }
  }
  return options.coachArrows.flatMap((pair, i) => {
    const from = centre(pair?.from)
    const to = centre(pair?.to)
    if (!from || !to) return []
    const dx = to.x - from.x
    const dy = to.y - from.y
    const length = Math.hypot(dx, dy)
    if (!length) return []
    const tip = { x: from.x + dx * 0.8, y: from.y + dy * 0.8 }
    const head = cell * 0.22
    const base = { x: tip.x - dx / length * head, y: tip.y - dy / length * head }
    const px = -dy / length * head * 0.55
    const py = dx / length * head * 0.55
    return [
      jsx('line', { x1: from.x, y1: from.y, x2: tip.x, y2: tip.y, stroke: accent, strokeWidth: 3, strokeLinecap: 'round', opacity: 0.45, style: { pointerEvents: 'none' } }),
      jsx('polygon', { points: `${tip.x},${tip.y} ${base.x + px},${base.y + py} ${base.x - px},${base.y - py}`, fill: accent, opacity: 0.45, style: { pointerEvents: 'none' } })
    ]
  })
}

function CoachPanel({ coach, onWhy }) {
  if (!coach) return null
  return jsxs('section', {
    'aria-label': 'Chess coach', 'data-coach-panel': 'true',
    style: { padding: '12px 14px', border: `1px solid ${stroke}`, borderRadius: 14, background: card, display: 'flex', flexDirection: 'column', gap: 4 },
    children: [
      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, children: [
        jsx('div', { style: { fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: text.tertiary }, children: 'Chess coach' }),
        labsBadge()
      ] }),
      coach.opening ? jsxs('div', { style: { fontSize: 14, fontWeight: 600 }, children: [
        `${coach.opening.eco} · ${coach.opening.name}`,
        coach.alt > 0 ? jsx('span', { style: { fontWeight: 400, color: text.tertiary }, children: ` +${coach.alt} more names` }) : null
      ] }) : null,
      // An opening begins with the first move; before that the card says so instead of
      // picking one of the 3,332 names the empty position technically shares.
      !coach.opening && coach.in_book ? jsx('div', { style: { fontSize: 14, fontWeight: 600 }, children: 'No opening named yet — the first move names it.' }) : null,
      coach.in_book && Array.isArray(coach.book) && coach.book.length ? jsx('div', { style: { fontSize: 12, color: text.secondary }, children: 'Book moves are marked on the board.' }) : null,
      coach.left_ply != null ? jsx('div', { style: { fontSize: 12, color: text.secondary }, children: `You left the book here — move ${Math.ceil(coach.left_ply / 2)}${coach.left_ply % 2 ? ' (White)' : ' (Black)'}.` }) : null,
      !coach.in_book && coach.left_ply == null ? jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: 'Unbooked position.' }) : null
    ]
  })
}

function CoachReview({ coach, onWhy }) {
  if (!Number.isFinite(coach?.ply) || coach.ply < 1 || typeof coach?.played_san !== 'string' || !coach.played_san || typeof coach?.better_san !== 'string' || !coach.better_san || !Number.isFinite(coach?.before) || !Number.isFinite(coach?.after) || typeof coach?.engine !== 'string' || !coach.engine) return null
  if (coach?.opening != null && (typeof coach.opening?.eco !== 'string' || typeof coach.opening?.name !== 'string')) return null
  if (coach?.left_ply != null && (!Number.isFinite(coach.left_ply) || coach.left_ply < 1)) return null
  const opening = coach?.opening ? `${coach.opening.eco} · ${coach.opening.name}` : '—'
  const book = coach?.left_ply != null ? `Left the book at move ${Math.ceil(coach.left_ply / 2)}.` : 'Never in book.'
  const cp = value => String(value).replace('-', '−')
  return jsxs('div', {
    'data-coach-review': 'true',
    style: { display: 'flex', flexDirection: 'column', gap: 4, borderTop: `1px solid ${stroke}`, paddingTop: 6, marginTop: 2 },
    children: [
      jsx('div', { style: { fontSize: 13 }, children: `Opening: ${opening}` }),
      jsx('div', { style: { fontSize: 13 }, children: book }),
      jsx('div', { style: { fontSize: 13 }, children: `Biggest mistake: move ${Math.ceil(coach.ply / 2)}${coach.ply % 2 ? ' (White)' : ' (Black)'} ${coach.played_san} (${cp(coach.before)} → ${cp(coach.after)} cp); ${coach.better_san} was better.` }),
      jsx('div', { style: { fontSize: 11, color: text.tertiary }, children: `evaluated by ${coach.engine}` }),
      typeof onWhy === 'function' ? textLink('Why this move?', onWhy) : null
    ]
  })
}
