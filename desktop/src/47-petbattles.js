// ---- 47-petbattles.js: Pet Battles, the Labs turn-based pet battle
//
// The engine has already resolved the whole turn; this file only draws what came back and
// plays the new log lines one at a time, so a hit, a shield and a faint each get their own
// beat. Every control is a button: nothing here is typed, and nothing is a drop-down.
//
// The pets are the person's own Hermes pets and the Petdex gallery, shown through Hermes:
// `pet.gallery` says what exists, `pet.thumb` renders a real sprite. A pet file is never
// copied into this repo. Only when no sprite can be reached does a drawn stand-in appear,
// and the screen says so instead of pretending it is a real pet.
//
// Every beat is one of Hermes's own pet states: run is the attack dash, jump is a hit and
// the win, failed is a hurt pet and a faint, wave is a taunt, review is choosing a move,
// waiting is the other side's turn.

const PETB_ID = 'pet-battles'
const PETB_MOVE_MS = 460
const PETB_WATCH_MS = 950
const PETB_HOWTO_KEY = 'gameshelf.petbattles.howto'
const PETB_STATES = ['idle', 'wave', 'run', 'jump', 'failed', 'review', 'waiting']

const PETB_TYPES = {
  Ember: '#ff7a59',
  Tide: '#4fa8ff',
  Verdant: '#63c76a',
  Data: '#b07bff',
  Shadow: '#8b8fb5',
  Steel: '#8fa3ad'
}

// Colour, health colour and the state a line of the log puts a pet in. These are pure so the
// UI harness can check them without a browser.
function petbColour(type) {
  return PETB_TYPES[type] || 'var(--ui-accent)'
}

function petbHpPercent(slot) {
  const max = Number(slot && slot.maxhp) || 0
  const hp = Number(slot && slot.hp) || 0
  if (max <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((hp / max) * 100)))
}

function petbHpColour(percent) {
  if (percent <= 25) return '#e0574f'
  if (percent <= 55) return '#e0a33f'
  return '#4fb86a'
}

// Which pet a log line moves: the one acting, or the one on the receiving end.
function petbStateSide(event) {
  if (!event) return ''
  if (event.kind === 'hit' || event.kind === 'faint') return event.target || ''
  if (event.kind === 'move' || event.kind === 'shield' || event.kind === 'heal'
    || event.kind === 'buff' || event.kind === 'switch' || event.kind === 'miss') return event.side || ''
  if (event.kind === 'status') return event.target || event.side || ''
  return ''
}

// One Hermes pet state per battle beat. `run` is the dash, `jump` the hit, `failed` the hurt,
// `wave` the taunt around a buff or a switch, `review` the thinking pose.
function petbStateFor(event) {
  if (!event) return 'idle'
  switch (event.kind) {
    case 'move': return 'run'
    case 'hit': return 'jump'
    case 'faint': return 'failed'
    case 'switch': return 'wave'
    case 'shield': return 'wave'
    case 'heal': return 'wave'
    case 'buff': return 'wave'
    case 'status': return 'wave'
    case 'miss': return 'review'
    default: return 'idle'
  }
}

// What a pet does while nobody is acting: the side to move thinks (`review`), the other side
// waits (`waiting`), and a finished battle leaves the winner jumping and the loser failed.
function petbRestState(side, status) {
  const won = status === 'won'
  const lost = status === 'lost'
  const draw = status === 'draw'
  if (status === 'active') return side === 'you' ? 'review' : 'waiting'
  if (status === 'watch') return 'waiting'
  if (won) return side === 'you' ? 'jump' : 'failed'
  if (lost) return side === 'you' ? 'failed' : 'jump'
  if (draw) return 'failed'
  return 'idle'
}

// A pet's line in the log, kept short: the sentence the engine wrote is already plain English.
function petbLogLine(event) {
  if (!event) return ''
  return event.text || ''
}

// The frame a watch mode is playing, clamped: a slider or a late tick can never index out.
function petbFrame(frames, index) {
  const list = Array.isArray(frames) ? frames : []
  if (!list.length) return null
  return list[Math.max(0, Math.min(list.length - 1, Number(index) || 0))]
}

// ---- Petdex ------------------------------------------------------------------
// The gateway answers `pet.gallery` as one flat `pets` list with an `installed` flag; the
// plugin's own fallback route answers with the two lists already split. Both become one shape.

function petbGalleryShape(answer) {
  const empty = { installed: [], gallery: [], source: 'local', reason: '', active: '' }
  if (!answer || typeof answer !== 'object') return { ...empty, reason: 'no-answer' }
  if (Array.isArray(answer.installed) || Array.isArray(answer.gallery)) {
    return {
      installed: Array.isArray(answer.installed) ? answer.installed.filter(pet => pet && pet.slug) : [],
      gallery: Array.isArray(answer.gallery) ? answer.gallery.filter(pet => pet && pet.slug) : [],
      source: answer.source === 'local' ? 'local' : 'petdex',
      reason: String(answer.reason || ''),
      active: String(answer.active || '')
    }
  }
  const pets = Array.isArray(answer.pets) ? answer.pets.filter(pet => pet && pet.slug) : []
  return {
    installed: pets.filter(pet => pet.installed),
    gallery: pets.filter(pet => !pet.installed),
    source: pets.length ? 'petdex' : 'local',
    reason: pets.length ? '' : 'no-pets',
    active: String(answer.active || '')
  }
}

// A seed in, the same order out: the same battle seed always meets the same opponents, so a
// replay and a rematch never disagree about who was on the field.
function petbSeedRandom(seed) {
  let state = (Number(seed) || 1) >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let step = Math.imul(state ^ (state >>> 15), 1 | state)
    step = (step + Math.imul(step ^ (step >>> 7), 61 | step)) ^ step
    return ((step ^ (step >>> 14)) >>> 0) / 4294967296
  }
}

// The computer's team, drawn from the Petdex gallery: curated pets first, then the rest,
// never one of the person's own installed pets.
function petbPickOpponents(gallery, seed, count = 3) {
  const pool = (gallery || []).filter(pet => pet && pet.slug && !pet.installed)
  const curated = pool.filter(pet => pet.curated)
  const ordered = curated.concat(pool.filter(pet => !pet.curated))
  const random = petbSeedRandom(seed)
  for (let index = ordered.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const held = ordered[index]
    ordered[index] = ordered[swap]
    ordered[swap] = held
  }
  const picked = []
  const seen = new Set()
  for (const pet of ordered) {
    if (seen.has(pet.slug)) continue
    seen.add(pet.slug)
    picked.push({ slug: pet.slug, name: pet.displayName || pet.slug })
    if (picked.length >= count) break
  }
  return picked
}

// The person's three pets: the one they picked leads, then the rest of their installed pets.
function petbTeamIdentities(installed, leadSlug, count = 3) {
  const pets = (installed || []).filter(pet => pet && pet.slug)
  const lead = pets.find(pet => pet.slug === leadSlug) || pets[0]
  const ordered = lead ? [lead, ...pets.filter(pet => pet.slug !== lead.slug)] : []
  return ordered.slice(0, count).map(pet => ({ slug: pet.slug, name: pet.displayName || pet.slug }))
}

// `slug=Name` tokens, one shlex word each: spaces and accents are percent-encoded.
function petbIdentityTokens(list) {
  return (list || [])
    .filter(pet => pet && pet.slug)
    .map(pet => `${pet.slug}=${encodeURIComponent(pet.name || pet.slug)}`)
    .join(' ')
}

// ---- critters ---------------------------------------------------------------
// One shape per type, all from a handful of primitives. This is the stand-in the screen
// draws only when no real sprite could be fetched; `state` changes the eyes and the CSS
// class the wrapper carries, so the same drawing still animates.

function petbEyes(state, x1, x2, y) {
  if (state === 'failed') {
    return [
      jsx('path', { d: `M${x1 - 5} ${y - 4} l10 8 M${x1 + 5} ${y - 4} l-10 8`, stroke: '#1b2030', strokeWidth: 2.4, strokeLinecap: 'round', fill: 'none' }, 'eye-a'),
      jsx('path', { d: `M${x2 - 5} ${y - 4} l10 8 M${x2 + 5} ${y - 4} l-10 8`, stroke: '#1b2030', strokeWidth: 2.4, strokeLinecap: 'round', fill: 'none' }, 'eye-b')
    ]
  }
  if (state === 'jump' || state === 'run') {
    return [
      jsx('circle', { cx: x1, cy: y, r: 4.2, fill: '#1b2030' }, 'eye-a'),
      jsx('circle', { cx: x2, cy: y, r: 4.2, fill: '#1b2030' }, 'eye-b')
    ]
  }
  return [
    jsxs('g', { children: [
      jsx('circle', { cx: x1, cy: y, r: 5.2, fill: '#fdfdff' }),
      jsx('circle', { cx: x1 + 1, cy: y + 0.5, r: 2.6, fill: '#1b2030' })
    ] }, 'eye-a'),
    jsxs('g', { children: [
      jsx('circle', { cx: x2, cy: y, r: 5.2, fill: '#fdfdff' }),
      jsx('circle', { cx: x2 + 1, cy: y + 0.5, r: 2.6, fill: '#1b2030' })
    ] }, 'eye-b'),
    jsx('path', { d: `M${x1 + 4} ${y + 13} q${(x2 - x1) / 2 - 4} 6 ${x2 - x1 - 8} 0`, stroke: '#1b2030', strokeWidth: 2, fill: 'none', strokeLinecap: 'round' }, 'smile')
  ]
}

function petbCritter(type, state, size = 150) {
  const colour = petbColour(type)
  const dark = '#1b2030'
  const common = { width: size, height: size, viewBox: '0 0 100 100', role: 'img', 'aria-label': `${type} pet` }
  if (type === 'Tide') {
    return jsxs('svg', { ...common, children: [
      jsx('path', { d: 'M50 12 C74 30 84 48 84 62 a34 26 0 0 1 -68 0 C16 48 26 30 50 12 Z', fill: colour }),
      jsx('path', { d: 'M50 12 C58 26 60 34 58 42 C52 36 46 34 42 42 C40 32 44 22 50 12 Z', fill: '#dff2ff', opacity: 0.8 }),
      jsx('path', { d: 'M22 58 q10 -8 20 0', stroke: '#dff2ff', strokeWidth: 3, fill: 'none', opacity: 0.6 }),
      ...petbEyes(state, 39, 61, 58),
      jsx('path', { d: 'M28 78 q22 10 44 0', stroke: dark, strokeWidth: 2, fill: 'none', opacity: 0.25 })
    ] })
  }
  if (type === 'Verdant') {
    return jsxs('svg', { ...common, children: [
      jsx('ellipse', { cx: 30, cy: 28, rx: 11, ry: 18, fill: '#3f8f47', transform: 'rotate(-28 30 28)' }),
      jsx('ellipse', { cx: 70, cy: 28, rx: 11, ry: 18, fill: '#3f8f47', transform: 'rotate(28 70 28)' }),
      jsx('circle', { cx: 50, cy: 60, r: 30, fill: colour }),
      jsx('path', { d: 'M50 30 q6 -12 0 -20', stroke: '#3f8f47', strokeWidth: 3, fill: 'none' }),
      ...petbEyes(state, 40, 60, 56),
      jsx('circle', { cx: 34, cy: 72, r: 4, fill: '#3f8f47', opacity: 0.5 }),
      jsx('circle', { cx: 66, cy: 74, r: 3, fill: '#3f8f47', opacity: 0.4 })
    ] })
  }
  if (type === 'Data') {
    return jsxs('svg', { ...common, children: [
      jsx('line', { x1: 50, y1: 16, x2: 50, y2: 30, stroke: colour, strokeWidth: 3 }),
      jsx('circle', { cx: 50, cy: 14, r: 5, fill: '#f0e6ff' }),
      jsx('rect', { x: 20, y: 30, width: 60, height: 52, rx: 10, fill: colour }),
      jsx('rect', { x: 20, y: 30, width: 60, height: 52, rx: 10, fill: 'none', stroke: '#f0e6ff', strokeWidth: 1.5, opacity: 0.45 }),
      ...petbEyes(state, 40, 60, 54),
      jsx('rect', { x: 36, y: 68, width: 28, height: 6, rx: 3, fill: '#f0e6ff', opacity: 0.55 }),
      jsx('rect', { x: 10, y: 46, width: 8, height: 18, rx: 4, fill: colour }),
      jsx('rect', { x: 82, y: 46, width: 8, height: 18, rx: 4, fill: colour })
    ] })
  }
  if (type === 'Shadow') {
    return jsxs('svg', { ...common, children: [
      jsx('path', { d: 'M50 12 C74 12 84 32 84 56 v26 q-8 -8 -16 0 q-8 8 -18 0 q-10 -8 -18 0 q-8 8 -16 0 V56 C16 32 26 12 50 12 Z', fill: colour }),
      jsxs('g', { opacity: 0.85, children: [
        jsx('circle', { cx: 39, cy: 46, r: 7, fill: '#e9e6ff' }),
        jsx('circle', { cx: 61, cy: 46, r: 7, fill: '#e9e6ff' })
      ] }),
      petbEyes(state, 39, 61, 47)[2] || null,
      jsx('path', { d: 'M44 62 q6 5 12 0', stroke: '#e9e6ff', strokeWidth: 2, fill: 'none' })
    ] })
  }
  if (type === 'Steel') {
    return jsxs('svg', { ...common, children: [
      jsx('polygon', { points: '50,12 84,32 84,70 50,88 16,70 16,32', fill: colour }),
      jsx('polygon', { points: '50,20 76,36 76,66 50,80 24,66 24,36', fill: '#dfe9ee', opacity: 0.35 }),
      ...petbEyes(state, 40, 60, 50),
      jsx('circle', { cx: 30, cy: 70, r: 3, fill: '#5b6b73' }),
      jsx('circle', { cx: 70, cy: 70, r: 3, fill: '#5b6b73' }),
      jsx('rect', { x: 42, y: 66, width: 16, height: 4, rx: 2, fill: '#5b6b73', opacity: 0.6 })
    ] })
  }
  // Ember, and the fallback for a type this build does not know yet.
  return jsxs('svg', { ...common, children: [
    jsx('path', { d: 'M50 8 C40 24 32 30 38 42 C42 34 46 32 48 26 C54 38 64 42 60 54 C70 44 66 24 50 8 Z', fill: '#ffb347' }),
    jsx('ellipse', { cx: 50, cy: 64, rx: 31, ry: 26, fill: colour }),
    jsx('path', { d: 'M30 40 l-8 -16 16 8 Z', fill: colour }),
    jsx('path', { d: 'M70 40 l8 -16 -16 8 Z', fill: colour }),
    ...petbEyes(state, 40, 60, 62),
    jsx('ellipse', { cx: 50, cy: 76, rx: 12, ry: 6, fill: '#ffd9a0', opacity: 0.55 })
  ] })
}

// ---- Petdex sprite -----------------------------------------------------------
// A real Hermes pet sprite when `pet.thumb` answered for this slug, else the drawn stand-in
// (labelled on the wrapper so nobody mistakes it for the person's pet).

function PetbSprite({ slot, state, facing, scale, thumbs, onNeedThumb }) {
  const slug = (slot && slot.slug) || ''
  const name = (slot && slot.name) || 'Pet'
  const type = (slot && slot.type) || 'Ember'
  const uri = slug ? ((thumbs && thumbs[slug]) || '') : ''
  const size = scale || 150
  useEffect(() => {
    if (slug && !uri && typeof onNeedThumb === 'function') onNeedThumb(slug)
  }, [slug, uri])
  if (uri) {
    return jsx('img', {
      src: uri,
      alt: `${name}, the Hermes pet`,
      'data-pet-slug': slug,
      draggable: false,
      style: {
        width: size, height: size, objectFit: 'contain', display: 'block',
        imageRendering: 'pixelated', userSelect: 'none'
      }
    })
  }
  return jsx('div', {
    'data-pet-drawn': slug || 'none',
    title: slug ? `The sprite for ${slug} has not arrived, so this is a drawn stand-in.` : '',
    style: { lineHeight: 0 },
    children: petbCritter(type, state, size)
  })
}

// A pet on the field: the real sprite (or the stand-in), the Hermes state class, and the name.
function PetbPet({ slot, state, facing, scale, thumbs, onNeedThumb }) {
  const percent = petbHpPercent(slot)
  const name = (slot && slot.name) || 'Pet'
  return jsxs('div', {
    'data-testid': `petb-pet-${facing}`,
    'data-state': state || 'idle',
    'data-pet-slug': (slot && slot.slug) || '',
    style: {
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 4,
      filter: percent <= 0 ? 'grayscale(1)' : 'none',
      transition: 'filter 300ms ease'
    },
    children: [
      jsx('div', {
        className: `petb-state-${state || 'idle'}`,
        style: { lineHeight: 0, transform: facing === 'foe' ? 'scaleX(-1)' : 'none' },
        children: jsx(PetbSprite, { slot, state, facing, scale: scale || 150, thumbs, onNeedThumb })
      }),
      jsx('div', {
        style: { fontSize: 12, color: text.tertiary, transform: facing === 'foe' ? 'scaleX(-1)' : 'none' },
        children: name
      })
    ]
  })
}

function PetbHpCard({ side, slot, active, total, hp }) {
  const shown = hp == null ? slot : { ...slot, hp }
  const percent = petbHpPercent(shown)
  const colour = petbHpColour(percent)
  const right = side === 'foe'
  return jsxs('div', {
    'data-testid': `petb-hpcard-${side}`,
    style: {
      position: 'absolute',
      [right ? 'top' : 'bottom']: 12,
      [right ? 'left' : 'right']: 12,
      width: 'min(62%, 300px)',
      padding: '9px 11px',
      borderRadius: 10,
      background: 'var(--ui-bg-elevated, rgba(12,18,26,0.86))',
      minWidth: 0
    },
    children: [
      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 6, justifyContent: right ? 'flex-start' : 'flex-end' }, children: [
        jsx('span', {
          style: {
            fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
            color: '#10141c', background: petbColour(slot && slot.type), borderRadius: 999, padding: '1px 7px'
          },
          children: (slot && slot.type) || '—'
        }),
        jsx('span', { style: { fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, children: (slot && slot.name) || '—' })
      ] }),
      jsx('div', {
        style: { height: 9, borderRadius: 999, background: 'rgba(127,127,127,0.22)', marginTop: 6, overflow: 'hidden' },
        children: jsx('div', {
          'data-testid': `petb-hpbar-${side}`,
          style: {
            width: `${percent}%`, height: '100%', borderRadius: 999, background: colour,
            transition: 'width 420ms ease, background 300ms ease'
          }
        })
      }),
      jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }, children: [
        jsxs('div', { style: { display: 'flex', gap: 4 }, children: (total || []).map((pet, index) =>
          jsx('span', {
            key: `pip-${index}`,
            title: pet.name,
            style: {
              width: 8, height: 8, borderRadius: 999,
              background: pet.fainted ? 'rgba(127,127,127,0.3)' : petbColour(pet.type),
              outline: index === (active || 0) ? `2px solid ${pet.fainted ? 'transparent' : 'var(--ui-text-secondary, #cfd6e4)'}` : 'none',
              outlineOffset: 1
            }
          }, `pip-${index}`)) }),
        jsx('span', { style: { fontSize: 12, color: text.secondary, fontVariantNumeric: 'tabular-nums' }, children: `${Math.max(0, Number(shown.hp) || 0)} / ${Number(shown.maxhp) || 0}` })
      ] })
    ]
  })
}

function PetbMoveButton({ action, index, disabled, onPick }) {
  const colour = petbColour(action.type)
  return jsxs('button', {
    type: 'button',
    'data-testid': `petb-move-${index}`,
    'aria-label': `${action.name}, ${action.type}, ${action.note || ''}`,
    onClick: () => { if (!disabled) onPick(action) },
    disabled,
    style: {
      textAlign: 'left',
      padding: '9px 11px',
      borderRadius: 6,
      border: 0,
      borderLeft: `2px solid ${disabled ? stroke : colour}`,
      background: disabled ? 'transparent' : fill,
      color: text.primary,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.55 : 1,
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      minWidth: 0
    },
    children: [
      jsxs('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }, children: [
        jsx('span', { style: { fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, children: action.name }),
        jsx('span', { style: { fontSize: 12, color: colour, fontWeight: 700 }, children: action.type })
      ] }),
      jsx('span', { style: { fontSize: 12, color: text.tertiary }, children: action.note || `${action.power} power` })
    ]
  })
}

function PetbSwitchButton({ action, disabled, onPick }) {
  return jsxs('button', {
    type: 'button',
    'data-testid': `petb-switch-${action.slot}`,
    onClick: () => { if (!disabled) onPick(action) },
    disabled,
    style: {
      padding: '7px 9px',
      borderRadius: 10,
      border: `1px solid ${stroke}`,
      background: 'transparent',
      color: text.secondary,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.45 : 1,
      fontSize: 12,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      minWidth: 0
    },
    children: [
      jsx('span', { style: { width: 8, height: 8, borderRadius: 999, background: petbColour(action.type) } }),
      jsx('span', { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, children: `Switch to ${action.name}` }),
      jsx('span', { style: { color: text.tertiary }, children: `${action.hp}/${action.maxhp}` })
    ]
  })
}

// The Labs card on the Game Center home page: one name, one honest line, one way in.
function PetBattlesLabsCard({ onOpen }) {
  return jsxs('div', {
    'data-labs-card': PETB_ID,
    style: {
      display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 8,
      borderRadius: 14, padding: 16, background: card, minWidth: 0
    },
    children: [
      jsxs('div', { children: [
        jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, children: [
          jsx('div', { style: { fontFamily: DISPLAY_FONT, fontSize: 18, letterSpacing: '-.01em', fontWeight: 600 }, children: 'Pet Battles' }),
          labsBadge()
        ] }),
        jsx('div', { style: { fontSize: 12, color: text.tertiary, marginTop: 2 }, children: 'by Game Center · your Hermes pets, three a side' }),
        jsx('div', {
          style: { fontSize: 12, color: text.secondary, marginTop: 4, lineHeight: 1.35 },
          children: 'Fight with the pets installed in Hermes against pets drawn from the Petdex gallery. Pick four moves, then take on the computer at Beginner, Intermediate, Advanced or Expert.'
        })
      ] }),
      jsxs('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }, children: [
        button('Open Pet Battles', onOpen, { primary: true }),
        jsx('span', { style: { fontSize: 12, color: text.tertiary }, children: 'Runs offline · no model calls in play' })
      ] })
    ]
  })
}

// ---- the pet gateway ---------------------------------------------------------
// Desktop: `host.request` (the same JSON-RPC the Hermes app uses). Anything else, including
// the browser preview: the plugin's own read-only routes, which render through Hermes too.
function usePetdex(ctx) {
  const [data, setData] = useState({ loading: true, source: '', reason: '', installed: [], gallery: [], active: '' })
  const [thumbs, setThumbs] = useState({})
  const asked = useRef({})
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const ask = useCallback(async (method, params) => {
    if (typeof host !== 'undefined' && host && typeof host.request === 'function') {
      try {
        return await host.request(method, params)
      } catch (failure) {
        // A host without the pet methods falls through to the plugin route.
      }
    }
    if (ctx && typeof ctx.rest === 'function') {
      if (method === 'pet.gallery') return ctx.rest('/pet/gallery')
      if (method === 'pet.thumb') {
        return ctx.rest(`/pet/thumb?slug=${encodeURIComponent(params.slug || '')}&url=${encodeURIComponent(params.url || '')}`)
      }
    }
    throw new Error(`no pet gateway for ${method}`)
  }, [ctx])

  // A sprite is either in the gateway answer or in the plugin's own route. A host that
  // answers "no" (a preview without pets, an older build) is not the end of the road.
  const askThumb = useCallback(async (slug, url) => {
    if (typeof host !== 'undefined' && host && typeof host.request === 'function') {
      try {
        const answer = await host.request('pet.thumb', { slug, url })
        if (answer && answer.ok && answer.dataUri) return answer
      } catch (failure) {
        // fall through to the plugin route
      }
    }
    if (ctx && typeof ctx.rest === 'function') {
      return ctx.rest(`/pet/thumb?slug=${encodeURIComponent(slug)}&url=${encodeURIComponent(url || '')}`)
    }
    return { ok: false }
  }, [ctx])

  useEffect(() => {
    let live = true
    ask('pet.gallery', {}).then(answer => {
      if (!live) return
      setData({ loading: false, ...petbGalleryShape(answer) })
    }).catch(() => {
      if (live) setData(current => ({ ...current, loading: false, source: 'local', reason: 'no-gateway' }))
    })
    return () => { live = false }
  }, [ask])

  const loadThumb = useCallback(async slug => {
    if (!slug || asked.current[slug]) return
    asked.current[slug] = true
    const entry = (data.installed || []).find(pet => pet.slug === slug)
      || (data.gallery || []).find(pet => pet.slug === slug)
      || {}
    try {
      const answer = await askThumb(slug, entry.spritesheetUrl || '')
      if (answer && answer.ok && answer.dataUri && alive.current) {
        setThumbs(current => ({ ...current, [slug]: answer.dataUri }))
      }
    } catch (failure) {
      // The drawn stand-in stays, and the screen says the sprite is missing.
    }
  }, [askThumb, data])

  return { ...data, thumbs, loadThumb }
}

// A one-line, honest account of where the pets came from; it only appears when something is
// missing, so a working Hermes never sees a caveat it does not need.
function petdexNote(petdex) {
  if (!petdex || petdex.loading) return null
  const installed = petdex.installed || []
  const lines = []
  if (!installed.length) {
    lines.push('No Hermes pet is installed, so drawn stand-ins are playing. Install or hatch one in Hermes ▸ Settings ▸ Appearance ▸ Pet.')
  }
  if (petdex.source !== 'petdex' || petdex.reason === 'no-gateway') {
    lines.push('The Petdex gallery could not be reached, so the computer fields drawn stand-ins.')
  }
  if (!lines.length) return null
  return jsx('div', {
    'data-testid': 'petdex-note',
    style: { fontSize: 11, color: 'var(--ui-warning, #d9a441)', lineHeight: 1.35 },
    children: lines.join(' ')
  })
}

// The whole screen. It reads `board.picture` and sends short command lines; it never judges
// a move and never computes damage itself.
function PetBattlePanel({ game, view, board, send, ctx, onBack }) {
  const picture = (board && board.picture) || null
  const status = (picture && picture.status) || 'idle'
  const log = (picture && picture.log) || []
  const catalogue = (picture && picture.catalogue) || { types: [], moves: [] }
  const petdex = usePetdex(ctx)
  const [type, setType] = useState('Ember')
  const [moves, setMoves] = useState(['cinder-lash', 'guard-up', 'quick-jab', 'scorch'])
  const [petSlug, setPetSlug] = useState('')
  const [watchLevel, setWatchLevel] = useState('intermediate')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [shownLog, setShownLog] = useState([])
  const [states, setStates] = useState({})
  const [hpNow, setHpNow] = useState({})
  const [activeNow, setActiveNow] = useState({})
  const [frame, setFrame] = useState(0)
  const [auto, setAuto] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [replaying, setReplaying] = useState(false)
  const [howto, setHowto] = useState(false)
  const seen = useRef(0)
  const token = useRef(0)
  const alive = useRef(true)
  const pending = useRef(null)
  const starting = useRef(null)
  const logBox = useRef(null)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // The short "How to play" card opens once, the first time this screen is ever opened.
  // Dismissing it is remembered locally; the header button brings it back on demand.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(PETB_HOWTO_KEY) !== 'seen') setHowto(true)
    } catch (failure) {
      // No storage: the card simply does not auto-open, and the header button still works.
    }
  }, [])
  const closeHowto = () => {
    setHowto(false)
    try { window.localStorage.setItem(PETB_HOWTO_KEY, 'seen') } catch (failure) { /* fine */ }
  }

  // The saved enlistment is the one the buttons start from, so a person who picked Shadow
  // yesterday finds Shadow still picked rather than reset to the default.
  useEffect(() => {
    const saved = picture && picture.enlist
    if (!saved || !saved.type) return
    setType(current => (current === 'Ember' ? saved.type : current))
    if (Array.isArray(saved.moves) && saved.moves.length === 4) {
      setMoves(current => (current.join(',') === 'cinder-lash,guard-up,quick-jab,scorch' ? saved.moves : current))
    }
  }, [picture && picture.enlist && picture.enlist.type])

  const battleKey = `${(picture && picture.seed) || ''}:${status}`
  useEffect(() => {
    // A new battle starts with an empty log on screen: the old hits must not replay.
    seen.current = 0
    setShownLog([])
    setStates({})
    setHpNow({})
    setActiveNow({})
    setFrame(0)
    setAuto(true)
    setReplaying(false)
  }, [battleKey])

  const sleeping = ms => new Promise(resolve => setTimeout(resolve, ms))

  // One line of log, one beat: the Hermes state, the health it moved, the pet it brings on.
  const playEvents = async (events, tick) => {
    for (const event of events) {
      if (!alive.current || token.current !== tick) return false
      setShownLog(lines => lines.concat([event]))
      const side = petbStateSide(event)
      if (side) setStates(current => ({ ...current, [side]: petbStateFor(event) }))
      if (event.kind === 'hit') setHpNow(current => ({ ...current, [event.target]: Number(event.hp) }))
      if (event.kind === 'faint') setHpNow(current => ({ ...current, [event.target]: 0 }))
      if (event.kind === 'switch' && typeof event.slot === 'number') {
        setActiveNow(current => ({ ...current, [event.side]: event.slot }))
      }
      await sleeping(PETB_MOVE_MS)
      if (!alive.current || token.current !== tick) return false
      setStates({})
    }
    return true
  }

  useEffect(() => {
    if (status === 'watch' || !picture) return
    if (log.length < seen.current) {
      seen.current = log.length
      setShownLog(log.slice(0, log.length))
      return
    }
    const fresh = log.slice(seen.current)
    seen.current = log.length
    if (!fresh.length) {
      // A rerun with nothing new (a poll, or a superseded animation) must not leave a
      // pet frozen in its hit pose: a stuck state would hide the result.
      setStates(current => (Object.keys(current).length ? {} : current))
      return
    }
    const tick = ++token.current
    ;(async () => {
      try {
        await playEvents(fresh, tick)
      } finally {
        if (alive.current && token.current === tick) {
          setStates({})
          setHpNow({})
          setActiveNow({})
        }
      }
    })()
  }, [log.length, status, picture && picture.seed])

  useEffect(() => {
    if (logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight
  }, [shownLog.length])

  useEffect(() => {
    if (!picture || status !== 'watch') return
    const frames = (picture.watch && picture.watch.frames) || []
    if (!auto || frame >= frames.length - 1) return
    const timer = setTimeout(() => setFrame(value => Math.min(value + 1, frames.length - 1)), PETB_WATCH_MS / speed)
    return () => clearTimeout(timer)
  }, [auto, frame, speed, status, picture && picture.seed, picture && picture.watch && picture.watch.frames.length])

  // A press that lands while the last turn is still resolving is a real turn, not noise:
  // it waits for the one in flight and then goes. Dropping it made a fast click look
  // broken, and the action bar then looked stuck.
  const command = async line => {
    if (pending.current) {
      try { await pending.current } catch (failure) { /* the earlier one already said so */ }
    }
    const work = (async () => {
      setBusy(true)
      setNotice('')
      try {
        const answer = await send(line)
        if (answer && answer.ok === false) setNotice((answer && answer.text) || 'That did not reach the battle.')
        return answer
      } catch (failure) {
        setNotice(failure && failure.message ? failure.message : 'That did not reach the battle.')
        return null
      } finally {
        pending.current = null
        setBusy(false)
      }
    })()
    pending.current = work
    return work
  }

  // The person's three pets and the computer's three, both named through Hermes. The lead is
  // the card they picked; the computer's team comes from the Petdex gallery for this seed.
  const installed = petdex.installed || []
  const savedPets = (picture && picture.enlist && picture.enlist.pets) || []
  const leadSlug = petSlug || (savedPets[0] && savedPets[0].slug) || (installed[0] && installed[0].slug) || ''

  // One press of Rematch is one battle, whenever it lands. A press that arrived while
  // the last turn's command was still travelling used to be dropped on the floor: the
  // player sat under a result curtain that claimed to be replaying a battle that was
  // already over (the bug hunt's dead Rematch). Now it waits its turn behind whatever
  // is in flight, and a second press joins the start already running.
  const start = level => {
    if (moves.length !== 4) {
      setNotice('Pick exactly four moves to start.')
      return Promise.resolve()
    }
    if (starting.current) return starting.current
    const run = (async () => {
      try {
        const seed = Math.floor(Math.random() * 999999) + 1
        const mine = petbTeamIdentities(installed, leadSlug, 3)
        const theirs = petbPickOpponents(petdex.gallery, seed, 3)
        const enlistLine = [`${game.id} enlist ${type} ${moves.join(',')}`, petbIdentityTokens(mine)].filter(Boolean).join(' ')
        const newLine = [`${game.id} new ${level} ${seed}`, petbIdentityTokens(theirs)].filter(Boolean).join(' ')
        await command(enlistLine)
        await command(newLine)
      } finally {
        starting.current = null
      }
    })()
    starting.current = run
    return run
  }

  const watch = async level => {
    if (busy) return
    const chosen = typeof level === 'string' ? level : watchLevel
    setWatchLevel(chosen)
    await command(`${game.id} watch ${chosen}`)
  }

  const newBattle = () => command(`${game.id} reset`)
  const back = () => { if (typeof onBack === 'function') onBack() }

  // Watch replay of the battle just played: the same log, played again from turn one.
  const replayBattle = async () => {
    if (replaying || !log.length) return
    const tick = ++token.current
    setReplaying(true)
    setShownLog([])
    setStates({})
    setHpNow({})
    setActiveNow({})
    setNotice('')
    try {
      await playEvents(log, tick)
    } finally {
      if (alive.current && token.current === tick) {
        setStates({})
        setHpNow({})
        setActiveNow({})
        setShownLog(log)
      }
      if (alive.current) setReplaying(false)
    }
  }

  if (!picture) {
    return jsxs('div', { style: { padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }, children: [
      jsx('div', { style: { fontFamily: DISPLAY_FONT, fontSize: 26, lineHeight: 1.15, fontWeight: 600, letterSpacing: '-.02em' }, children: 'Pet Battles' }),
      jsx('div', { style: { fontSize: 13, color: text.tertiary }, children: 'Waiting for the battle field…' }),
      jsxs('div', { style: { display: 'flex', gap: 8 }, children: [
        jsx(LearnButton, { game, ctx }),
        button('Back to games', back)
      ] })
    ] })
  }

  const you = picture.you || { slots: [], active: 0, name: 'You' }
  const foe = picture.foe || { slots: [], active: 0, name: 'The computer' }
  // Watch mode draws the frame being played, so both the health bars and the pets on the
  // field move with the replay instead of showing the finished result from the first beat.
  const watchFrames = (picture.watch && picture.watch.frames) || []
  const watchFrame = status === 'watch' ? petbFrame(watchFrames, frame) : null
  const youSlots = watchFrame ? watchFrame.you : you.slots || []
  const foeSlots = watchFrame ? watchFrame.foe : foe.slots || []
  const youActive = activeNow.you != null ? activeNow.you : (watchFrame ? watchFrame.active.you : you.active)
  const foeActive = activeNow.foe != null ? activeNow.foe : (watchFrame ? watchFrame.active.foe : foe.active)
  const youSlot = youSlots[youActive] || { name: '—', type: 'Ember', hp: 0, maxhp: 1 }
  const foeSlot = foeSlots[foeActive] || { name: '—', type: 'Ember', hp: 0, maxhp: 1 }
  const legal = picture.legal || []
  const moveActions = legal.filter(action => action.kind === 'move')
  const switchActions = legal.filter(action => action.kind === 'switch')
  // A beat plays for about half a second, but the buttons do not wait for it: the engine
  // decides what is legal, and gating input on a cosmetic flag meant a beat that never
  // finished clearing could lock the whole action bar.
  const youState = states.you || petbRestState('you', status)
  const foeState = states.foe || petbRestState('foe', status)
  // In watch mode the replay runs first and the curtain waits for the last frame; a
  // battle that has just finished has no replay to wait for. `curtain` is the one answer
  // every control uses, so nothing hides behind a card that is not there.
  const watchFramesAll = (picture.watch && picture.watch.frames) || []
  const watchDone = status !== 'watch' || watchFramesAll.length < 2 || frame >= watchFramesAll.length - 1
  const curtain = Boolean(picture.overlay && !replaying && watchDone)

  const header = jsxs('div', {
    style: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', paddingBottom: 8, borderBottom: `1px solid ${stroke}` },
    children: [
      jsxs('div', { children: [
        jsxs('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }, children: [
          jsx('div', { style: { fontFamily: DISPLAY_FONT, fontSize: 28, lineHeight: 1.15, letterSpacing: '-.02em', fontWeight: 600 }, children: 'Pet Battles' }),
          labsBadge(),
          status === 'idle' ? null : jsx('span', {
            'data-testid': 'petb-turn',
            children: badge(`${picture.level_label || 'Intermediate'} · turn ${picture.turn || 0}`)
          })
        ] }),
        jsx('div', {
          'data-testid': 'petb-status',
          style: { fontSize: 12, color: text.secondary, marginTop: 2 },
          children: status === 'idle'
            ? 'Pick your pet, a type, four moves and a level. Everything happens with clicks.'
            : status === 'watch'
              ? 'Two computer teams are playing. Nothing you press changes the result.'
              : status === 'active'
                ? 'Your turn: choose a move or switch a pet.'
                : 'The battle is finished.'
        })
      ] }),
      jsxs('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' }, children: [
        button('How to play', () => setHowto(true)),
        status === 'idle' ? null : button('Watch bots', watch, { disabled: busy }),
        // A battle left half played must never be a trap: the picks are one press away,
        // and the result curtain carries its own copy of this button.
        status === 'idle' || curtain ? null : button('New battle', newBattle, { disabled: busy }),
        button('Back to games', back),
        jsx(LearnButton, { game, ctx })
      ] })
    ]
  })

  const field = jsxs('div', {
    'data-testid': 'petb-field',
    style: {
      position: 'relative',
      minHeight: 300,
      borderRadius: 12,
      overflow: 'hidden',
      background: 'var(--ui-bg-solid, #0b0a09)'
    },
    children: [
      // The floor is drawn, not lit: a horizon rule, a centre ring with four ticks, and
      // two corner chevrons. The same marks every battle, so a replay still looks identical.
      jsx('div', { style: { position: 'absolute', left: '6%', right: '6%', top: '52%', height: 1, background: `linear-gradient(90deg, transparent, ${stroke}, transparent)` } }),
      jsxs('div', {
        style: {
          position: 'absolute', left: '50%', top: '52%', width: 220, height: 220, marginLeft: -110, marginTop: -110,
          borderRadius: '50%', border: `1px solid ${stroke}`, opacity: 0.5
        },
        children: [0, 90, 180, 270].map(angle => jsx('span', {
          key: `tick-${angle}`,
          style: {
            position: 'absolute', left: '50%', top: '50%', width: 1, height: 10, background: stroke,
            transform: `rotate(${angle}deg) translateY(-110px)`, transformOrigin: '0 0'
          }
        }))
      }),
      jsx('div', { style: { position: 'absolute', left: 14, top: 12, width: 22, height: 1, background: stroke } }),
      jsx('div', { style: { position: 'absolute', left: 14, top: 12, width: 1, height: 22, background: stroke } }),
      jsx('div', { style: { position: 'absolute', right: 14, top: 12, width: 22, height: 1, background: stroke } }),
      jsx('div', { style: { position: 'absolute', right: 14, top: 12, width: 1, height: 22, background: stroke } }),
      jsx('div', { style: { position: 'absolute', left: '7%', bottom: '9%', width: '36%', height: 20, borderRadius: '50%', background: 'rgba(127,127,127,0.10)' } }),
      jsx('div', { style: { position: 'absolute', right: '7%', bottom: '9%', width: '36%', height: 20, borderRadius: '50%', background: 'rgba(127,127,127,0.10)' } }),
      jsx('div', { style: { position: 'absolute', left: '9%', bottom: '18%' }, children:
        jsx(PetbPet, { slot: youSlot, state: youState, facing: 'you', scale: 158, thumbs: petdex.thumbs, onNeedThumb: petdex.loadThumb }) }),
      jsx('div', { style: { position: 'absolute', right: '9%', top: '18%' }, children:
        jsx(PetbPet, { slot: foeSlot, state: foeState, facing: 'foe', scale: 158, thumbs: petdex.thumbs, onNeedThumb: petdex.loadThumb }) }),
      jsx(PetbHpCard, { side: 'foe', slot: foeSlot, active: foeActive, total: foeSlots, hp: hpNow.foe }),
      jsx(PetbHpCard, { side: 'you', slot: youSlot, active: youActive, total: youSlots, hp: hpNow.you })
    ]
  })

  const actionBar = status === 'active'
    ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 }, children: [
        jsx('div', {
          style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 190px), 1fr))', gap: 8 },
          children: moveActions.map(action =>
            jsx(PetbMoveButton, {
              action,
              index: action.index,
              disabled: busy || !picture.can_move,
              onPick: picked => command(`${game.id} move ${picked.index}`)
            }, `move-${action.index}`))
        }),
        switchActions.length
          ? jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }, children: [
              jsx('span', { style: { fontSize: 12, color: text.tertiary }, children: 'Or switch:' }),
              ...switchActions.map(action =>
                jsx(PetbSwitchButton, {
                  action,
                  disabled: busy || !picture.can_move,
                  onPick: picked => command(`${game.id} switch ${picked.slot}`)
                }, `switch-${action.slot}`))
            ] })
          : null
      ] })
    : status === 'watch'
      ? jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }, children: [
          button(auto ? 'Pause' : 'Play', () => setAuto(value => !value), { primary: !auto, disabled: frame >= ((picture.watch && picture.watch.frames.length) || 1) - 1 && auto }),
          button('1×', () => setSpeed(1), { primary: speed === 1 }),
          button('2×', () => setSpeed(2), { primary: speed === 2 }),
          button('Replay', () => { setFrame(0); setAuto(true) }),
          jsxs('span', { style: { fontSize: 12, color: text.secondary }, children: [
            `Frame ${Math.min(frame + 1, (picture.watch && picture.watch.frames.length) || 1)} of ${(picture.watch && picture.watch.frames.length) || 1}`
          ] })
        ] })
      : status === 'idle'
        ? null
        // The result curtain carries these four buttons, so the action bar keeps out of
        // the way while it is up: two copies of Rematch under one curtain is a mouse
        // target that cannot be reached.
        : curtain
          ? null
          : jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }, children: [
          button('Rematch', () => start(picture.level || 'intermediate'), { primary: true }),
          button('New battle', newBattle, { disabled: busy }),
          button('Watch replay', replayBattle, { disabled: busy || replaying }),
          jsx('span', { style: { fontSize: 11, color: text.tertiary }, children: `Seed ${picture.seed || '—'} · same seed replays the same battle` })
        ] })

  const logPanel = jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0, minWidth: 0 },
    children: [
      jsx('div', { style: { fontSize: 12, letterSpacing: '0.12em', textTransform: 'uppercase', color: text.tertiary }, children: 'Battle log' }),
      jsxs('div', {
        ref: logBox,
        'data-testid': 'petb-log',
        style: {
          flex: '1 1 auto', minHeight: 140, overflowY: 'auto', padding: '10px 12px',
          borderRadius: 10, background: card,
          display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, lineHeight: 1.35
        },
        children: shownLog.length || log.length
          ? (status === 'watch' ? watchLogLines(picture, frame) : shownLog).map((event, index) =>
              jsx('div', {
                style: {
                  color: event.kind === 'win' ? text.primary : event.kind === 'faint' ? '#e0574f' : text.secondary,
                  fontWeight: event.kind === 'win' || event.kind === 'faint' ? 650 : 400,
                  borderLeft: event.kind === 'hit' ? `2px solid ${petbColour(event.move_type)}` : '2px solid transparent',
                  paddingLeft: 6
                },
                children: petbLogLine(event)
              }, `line-${index}`))
          : jsx('div', { style: { color: text.tertiary }, children: status === 'idle' ? 'No battle yet. The log fills in as the turns play.' : 'The first turn starts when you pick a move.' })
      }),
      petdexNote(petdex),
      notice ? jsx('div', { role: 'status', style: { fontSize: 12, color: text.secondary }, children: notice }) : null
    ]
  })

  const result = curtain
    ? jsx(PetbResult, {
        overlay: picture.overlay,
        picture,
        thumbs: petdex.thumbs,
        onNeedThumb: petdex.loadThumb,
        busy,
        notice: status === 'watch' ? '' : notice,
        mode: status === 'watch' ? 'watch' : 'battle',
        onRematch: status === 'watch' ? () => { setFrame(0); setAuto(true) } : () => start(picture.level || 'intermediate'),
        onNew: status === 'watch' ? () => command(`${game.id} reset`) : newBattle,
        onReplay: status === 'watch' ? () => { setFrame(0); setAuto(true) } : replayBattle,
        onBack: back
      })
    : null

  return jsxs('div', {
    'data-testid': 'petb-screen',
    'data-status': status,
    'data-petdex': petdex.source || 'loading',
    className: 'games-petb',
    style: {
      position: 'relative',
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 1fr) minmax(230px, 300px)',
      gap: 14,
      padding: 16,
      height: '100%',
      minHeight: 0,
      background: paper
    },
    children: [
      jsx('style', { children: `
        @keyframes petb-bob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-5px) } }
        @keyframes petb-run { 0% { transform: translate(0,0) } 30% { transform: translate(-26px,-6px) } 55% { transform: translate(18px,-12px) } 100% { transform: translate(0,0) } }
        @keyframes petb-jump { 0% { transform: translate(0,0); filter: brightness(1) } 32% { transform: translate(0,-22px) scale(1.06); filter: brightness(2.1) } 100% { transform: translate(0,0) scale(1); filter: brightness(1) } }
        @keyframes petb-failed { 0% { transform: translateY(0) rotate(0); opacity: 1 } 100% { transform: translateY(30px) rotate(-7deg); opacity: 0.35 } }
        @keyframes petb-wave { 0%,100% { transform: rotate(0) } 25% { transform: rotate(-7deg) translateY(-6px) } 60% { transform: rotate(6deg) translateY(-4px) } }
        @keyframes petb-review { 0%,100% { transform: translateY(0) scale(1) } 50% { transform: translateY(-3px) scale(1.02) } }
        @keyframes petb-waiting { 0%,100% { opacity: 0.72 } 50% { opacity: 1 } }
        .petb-state-idle { animation: petb-bob 2.6s ease-in-out infinite }
        .petb-state-run { animation: petb-run 440ms ease-out }
        .petb-state-jump { animation: petb-jump 460ms ease-out }
        .petb-state-failed { animation: petb-failed 520ms ease-in forwards }
        .petb-state-wave { animation: petb-wave 620ms ease-in-out }
        .petb-state-review { animation: petb-review 1.5s ease-in-out infinite }
        .petb-state-waiting { animation: petb-waiting 1.8s ease-in-out infinite }
        @media (prefers-reduced-motion: reduce) {
          [class^="petb-state-"] { animation: none !important }
        }
        @container (max-width: 760px) {
          .games-petb { grid-template-columns: minmax(0, 1fr) !important; overflow: auto; }
        }
      ` }),
      jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, minHeight: 0, overflow: 'auto' }, children: [
        header,
        status === 'idle'
          ? jsx(PetbEnlist, {
              picture, catalogue, type, setType, moves, setMoves, busy, notice,
              petdex, leadSlug, setPetSlug,
              watchLevel, setWatchLevel, onStart: start, onWatch: watch
            })
          : field,
        actionBar
      ] }),
      status === 'idle' ? null : logPanel,
      result,
      howto ? jsx(PetbHowTo, { onClose: closeHowto }) : null
    ]
  })
}

// Watch mode draws the log up to the frame being played, not the whole finished battle.
function watchLogLines(picture, frame) {
  const frames = (picture.watch && picture.watch.frames) || []
  const current = petbFrame(frames, frame)
  const turn = current ? current.turn : 0
  const events = (picture.watch && picture.watch.events) || []
  return events.filter(event => Number(event.turn) <= turn)
}

// The winner, for the result card: the engine names the pet that finished the battle; an
// old saved battle without that key falls back to the winning side's pet on the field.
function petbWinnerPet(picture, overlay) {
  if (overlay && overlay.winner_pet && overlay.winner_pet.name) return overlay.winner_pet
  if (!overlay) return null
  const you = (picture && picture.you) || { slots: [], active: 0 }
  const foe = (picture && picture.foe) || { slots: [], active: 0 }
  if (overlay.result === 'win') return you.slots[you.active] || null
  if (overlay.result === 'lose') return foe.slots[foe.active] || null
  return you.slots[you.active] || foe.slots[foe.active] || null
}

// The end of a battle: the winner and their pet, then every way out. Back is always one of
// them, so a finished battle can never trap the person on the field.
function PetbResult({ overlay, picture, thumbs, onNeedThumb, busy, notice, onRematch, onNew, onReplay, onBack, mode }) {
  if (!overlay) return null
  const win = overlay.result === 'win'
  const draw = overlay.result === 'draw'
  const colour = draw ? text.secondary : win ? '#4fb86a' : '#e0574f'
  const winner = petbWinnerPet(picture, overlay)
  const watching = mode === 'watch'
  const sideLabel = watching
    ? (winner && winner.side === 'foe' ? 'Team Orange' : 'Team Blue')
    : win ? 'Your pet' : draw ? 'Last out' : 'The computer’s pet'
  return jsx('div', {
    'data-testid': 'petb-result',
    style: {
      // Fixed, not absolute: the screen is a grid, and an absolutely placed child is
      // laid out inside a grid cell, which put the card off to one side and under the
      // fold where the buttons could not be reached. Fixed pins it to the window.
      position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(8,11,16,0.72)', backdropFilter: 'blur(4px)', padding: 16, overflowY: 'auto'
    },
    children: jsxs('div', {
      style: {
        width: 'min(460px, 100%)', maxHeight: 'calc(100vh - 32px)', overflowY: 'auto',
        borderRadius: 18, border: `1px solid ${stroke}`,
        background: 'var(--ui-bg-elevated, #141c26)', padding: 20, textAlign: 'center',
        display: 'flex', flexDirection: 'column', gap: 8, boxShadow: '0 18px 50px rgba(0,0,0,0.4)'
      },
      children: [
        jsx('div', { style: { fontSize: 11, letterSpacing: '0.16em', textTransform: 'uppercase', color: text.tertiary }, children: draw ? 'Draw' : win ? 'Victory' : 'Defeat' }),
        jsxs('div', {
          'data-testid': 'petb-result-pet',
          style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, margin: '2px 0 4px' },
          children: [
            jsx('div', { style: { lineHeight: 0 }, children:
              jsx(PetbSprite, { slot: winner || {}, state: win ? 'jump' : 'failed', facing: 'you', scale: 128, thumbs, onNeedThumb }) }),
            jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', justifyContent: 'center' }, children: [
              jsx('span', { style: { fontSize: 15, fontWeight: 700 }, children: (winner && winner.name) || '—' }),
              winner && winner.type ? jsx('span', {
                style: {
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
                  color: '#10141c', background: petbColour(winner.type), borderRadius: 999, padding: '1px 7px'
                },
                children: winner.type
              }) : null,
              jsx('span', { style: { fontSize: 11, color: text.tertiary }, children: sideLabel })
            ] })
          ]
        }),
        jsx('div', { style: { fontSize: 26, fontWeight: 800, color: colour, letterSpacing: '-0.02em' }, children: overlay.title }),
        jsx('div', { style: { fontSize: 13, color: text.secondary, lineHeight: 1.4 }, children: overlay.line }),
        jsx('div', { style: { fontSize: 11, color: text.tertiary }, children: `${overlay.turns || 0} turns · seed ${(picture && picture.seed) || '—'}` }),
        // A Rematch that the battle refused to start says so here, on the card the
        // person is looking at, instead of as a quiet line behind the curtain.
        notice ? jsx('div', { role: 'status', style: { fontSize: 12, color: '#e0574f', lineHeight: 1.35 }, children: notice }) : null,
        jsxs('div', { style: { display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', marginTop: 6 }, children: [
          // Never disabled: the card it sits on is the way out, and a greyed-out way out
          // with no explanation is how the stuck result curtain read as a dead button.
          button(watching ? 'Play again' : 'Rematch', onRematch, { primary: true }),
          button('New battle', onNew, { disabled: busy }),
          button('Watch replay', onReplay, { disabled: busy }),
          button('Back to games', onBack)
        ] })
      ]
    })
  })
}

// The short "How to play" card: the type chart, four moves, switching. TU's full tutorial
// replaces this later; until then this is the whole teaching surface.
function PetbHowTo({ onClose }) {
  const row = (attack, beaten) => jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }, children: [
    jsx('span', { style: { fontWeight: 700, color: petbColour(attack) }, children: attack }),
    jsx('span', { style: { color: text.tertiary, fontSize: 12 }, children: 'beats' }),
    jsx('span', { style: { fontWeight: 700, color: petbColour(beaten) }, children: beaten }),
    jsx('span', { style: { color: text.tertiary, fontSize: 11 }, children: 'and loses to the next one round the ring' })
  ] })
  return jsx('div', {
    'data-testid': 'petb-howto',
    style: {
      // Fixed for the same reason as the result curtain: a grid child placed absolutely
      // lands in a cell, not over the screen.
      position: 'fixed', inset: 0, zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(8,11,16,0.7)', backdropFilter: 'blur(3px)', padding: 16, overflowY: 'auto'
    },
    children: jsxs('div', {
      style: {
        width: 'min(520px, 100%)', maxHeight: '90%', overflow: 'auto', borderRadius: 18,
        border: `1px solid ${stroke}`, background: 'var(--ui-bg-elevated, #141c26)', padding: 20,
        display: 'flex', flexDirection: 'column', gap: 10, boxShadow: '0 18px 50px rgba(0,0,0,0.4)'
      },
      children: [
        jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 8 }, children: [
          jsx('div', { style: { fontSize: 18, fontWeight: 700 }, children: 'How to play' }),
          labsBadge()
        ] }),
        jsx('div', { style: { fontSize: 13, color: text.secondary, lineHeight: 1.45 },
          children: 'Three pets a side. Each turn you pick one of your four moves, or switch to another pet. Every pet starts at full health.' }),
        jsxs('div', { style: { border: `1px solid ${stroke}`, borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }, children: [
          jsx('div', { style: { fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: text.tertiary }, children: 'Types beat types' }),
          row('Ember', 'Verdant'),
          row('Verdant', 'Tide'),
          row('Tide', 'Ember'),
          row('Data', 'Shadow'),
          row('Shadow', 'Steel'),
          row('Steel', 'Data'),
          jsx('div', { style: { fontSize: 11, color: text.tertiary }, children: 'A move that matches your pet’s own type hits 25% harder. A good match-up is worth half as much again.' })
        ] }),
        jsxs('div', { style: { border: `1px solid ${stroke}`, borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 5 }, children: [
          jsx('div', { style: { fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: text.tertiary }, children: 'Four moves and a switch' }),
          jsx('div', { style: { fontSize: 12, color: text.secondary, lineHeight: 1.45 },
            children: 'You bring four moves and may use any of them every turn — there are no charges. Some moves shield, heal, raise a stat or leave a status on the other pet.' }),
          jsx('div', { style: { fontSize: 12, color: text.secondary, lineHeight: 1.45 },
            children: 'Switching uses your turn: the pet that comes in takes that turn’s hit. Switch when your pet is nearly out, or when the match-up is wrong.' }),
          jsx('div', { style: { fontSize: 12, color: text.secondary, lineHeight: 1.45 },
            children: 'When a pet faints the next one comes in. Beat all three of theirs to win.' })
        ] }),
        jsxs('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 2 }, children: [
          button('Got it', onClose, { primary: true })
        ] })
      ]
    })
  })
}

// One card per real Hermes pet: the sprite Hermes renders for it, its name, and a ring when
// it leads your team.
function PetbPetCard({ pet, selected, onPick, thumbs, onNeedThumb }) {
  const colour = petbColour(pet.type || 'Data')
  return jsxs('button', {
    type: 'button',
    'data-testid': `petb-petcard-${pet.slug}`,
    'data-selected': selected ? 'true' : 'false',
    'aria-pressed': selected,
    title: selected ? `${pet.displayName || pet.slug} leads your team` : `Lead with ${pet.displayName || pet.slug}`,
    onClick: () => onPick(pet.slug),
    style: {
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '8px 6px',
      width: 96, borderRadius: 14, cursor: 'pointer', background: selected ? `${accent}22` : 'transparent',
      border: `2px solid ${selected ? accent : stroke}`, color: text.primary, minWidth: 0
    },
    children: [
      jsx('div', { style: { width: 64, height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 0 }, children:
        jsx(PetbSprite, {
          slot: { slug: pet.slug, name: pet.displayName, type: pet.type || 'Data' },
          state: 'idle', facing: 'you', scale: 64, thumbs, onNeedThumb
        }) }),
      jsx('span', {
        style: { fontSize: 11, fontWeight: 650, maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
        children: pet.displayName || pet.slug
      }),
      jsx('span', {
        style: { fontSize: 9, letterSpacing: '0.05em', textTransform: 'uppercase', color: colour },
        children: pet.type || 'ready'
      })
    ]
  })
}

// Pre-battle: your pets, a type, four moves, and four levels. Every choice is a button, and a
// choice that cannot start a battle explains itself instead of hiding.
function PetbEnlist({ picture, catalogue, type, setType, moves, setMoves, busy, notice, watchLevel, setWatchLevel, onStart, onWatch, petdex, leadSlug, setPetSlug }) {
  const types = catalogue.types || []
  const allMoves = catalogue.moves || []
  const installed = (petdex && petdex.installed) || []
  const pickup = petdex && petdex.loadThumb
  const thumbs = (petdex && petdex.thumbs) || {}
  const toggle = moveId => {
    setMoves(current => {
      if (current.includes(moveId)) return current.filter(item => item !== moveId)
      if (current.length >= 4) return current
      return current.concat([moveId])
    })
  }
  const ready = moves.length === 4 && Boolean(type)
  const levels = picture.levels || []
  return jsxs('div', {
    'data-testid': 'petb-enlist',
    style: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 },
    children: [
      // Your pets: the ones installed in Hermes, shown with the sprite Hermes itself renders.
      jsxs('div', { style: { border: `1px solid ${stroke}`, borderRadius: 14, padding: 12, background: card }, children: [
        jsxs('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 8 }, children: [
          jsx('div', { style: { fontSize: 12, fontWeight: 700 }, children: '1. Pick the pet who leads' }),
          jsx('div', { style: { fontSize: 11, color: text.tertiary }, children: 'your pets in Hermes · shown through Hermes, never copied' })
        ] }),
        installed.length
          ? jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' }, children: [
              ...installed.slice(0, 8).map(pet =>
                jsx(PetbPetCard, {
                  pet, selected: leadSlug === pet.slug, onPick: setPetSlug,
                  thumbs, onNeedThumb: pickup
                }, `pet-${pet.slug}`)),
              jsx('div', {
                'data-testid': 'petdex-gallery-line',
                style: { fontSize: 11, color: text.tertiary, alignSelf: 'center', maxWidth: 200, lineHeight: 1.35 },
                children: `${Math.max(0, (petdex.gallery || []).length)} pets from the Petdex gallery are waiting on the other side.`
              })
            ] })
          : jsxs('div', {
              'data-testid': 'petb-no-pet',
              style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', border: `1px dashed ${stroke}`, borderRadius: 12, padding: 12 },
              children: [
                jsx('div', { style: { fontSize: 12, color: text.secondary, lineHeight: 1.4, maxWidth: 360 },
                  children: 'No Hermes pet is installed yet. Hermes can hatch one with a model, or install one from the Petdex gallery — that is Hermes’s own flow, in Settings ▸ Appearance ▸ Pet.' }),
                button('Open pet gallery in Hermes', () => {
                  try {
                    if (typeof host !== 'undefined' && host && typeof host.navigate === 'function') host.navigate('/settings')
                  } catch (failure) { /* an older host: the line above already names the screen */ }
                }, { primary: true })
              ]
            }),
        // The other side, drawn from the Petdex gallery and shown by Hermes's own thumbnail.
        (petdex && (petdex.gallery || []).length)
          ? jsxs('div', {
              'data-testid': 'petdex-strip',
              style: { display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 10, paddingTop: 10, borderTop: `1px solid ${stroke}` },
              children: [
                jsx('span', { style: { fontSize: 11, color: text.tertiary, alignSelf: 'center' }, children: 'On the other side, from Petdex:' }),
                ...(petdex.gallery || []).slice(0, 6).map(pet =>
                  jsxs('div', {
                    key: `gallery-${pet.slug}`,
                    'data-gallery-pet': pet.slug,
                    title: `${pet.displayName || pet.slug} — one of the pets you might face`,
                    style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, width: 58 },
                    children: [
                      jsx('div', { style: { width: 46, height: 46, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 0 }, children:
                        jsx(PetbSprite, {
                          slot: { slug: pet.slug, name: pet.displayName, type: pet.type || 'Data' },
                          state: 'idle', facing: 'you', scale: 46, thumbs, onNeedThumb: pickup
                        }) }),
                      jsx('span', {
                        style: { fontSize: 9, color: text.tertiary, maxWidth: 58, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
                        children: pet.displayName || pet.slug
                      })
                    ]
                  }, `gallery-${pet.slug}`))
              ]
            })
          : null
      ] }),
      jsxs('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: 12 },
        children: [
          jsxs('div', { style: { border: `1px solid ${stroke}`, borderRadius: 14, padding: 12, background: card }, children: [
            jsx('div', { style: { fontSize: 12, fontWeight: 700, marginBottom: 8 }, children: '2. Pick your type' }),
            jsxs('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 }, children: types.map(item =>
              jsxs('button', {
                type: 'button',
                key: item.name,
                'data-testid': `petb-type-${item.name.toLowerCase()}`,
                onClick: () => setType(item.name),
                'aria-pressed': type === item.name,
                style: {
                  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 6,
                  border: 0,
                  background: type === item.name ? fill : 'transparent',
                  color: type === item.name ? text.primary : text.secondary,
                  boxShadow: type === item.name ? `inset 2px 0 0 ${item.colour}` : 'none',
                  cursor: 'pointer', fontSize: 12, fontWeight: 600
                },
                children: [
                  jsx('span', { style: { width: 9, height: 9, borderRadius: 999, background: item.colour } }),
                  item.name
                ]
              }, item.name)) }),
            jsx('div', { style: { fontSize: 12, color: text.tertiary, marginTop: 8, lineHeight: 1.4 },
              children: 'Ember ▸ Verdant ▸ Tide ▸ Ember · Data ▸ Shadow ▸ Steel ▸ Data. A move that matches your type hits 25% harder.' })
          ] }),
          jsxs('div', { style: { border: `1px solid ${stroke}`, borderRadius: 14, padding: 12, background: card }, children: [
            jsx('div', { style: { fontSize: 12, fontWeight: 700, marginBottom: 8 }, children: `3. Pick four moves — ${moves.length} of 4` }),
            jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 132px), 1fr))', gap: 6 }, children: allMoves.map(move => {
              const picked = moves.includes(move.id)
              const colour = petbColour(move.type)
              return jsxs('button', {
                type: 'button',
                key: move.id,
                'data-testid': `petb-pick-${move.id}`,
                'aria-pressed': picked,
                onClick: () => toggle(move.id),
                disabled: !picked && moves.length >= 4,
                style: {
                  textAlign: 'left', padding: '6px 8px', borderRadius: 6,
                  border: 0,
                  borderLeft: `2px solid ${picked ? colour : stroke}`,
                  background: picked ? fill : 'transparent',
                  color: picked ? text.primary : text.secondary,
                  fontSize: 12, cursor: picked || moves.length < 4 ? 'pointer' : 'default',
                  opacity: !picked && moves.length >= 4 ? 0.45 : 1,
                  display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0
                },
                children: [
                  jsx('span', { style: { fontWeight: 650, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, children: move.name }),
                  jsxs('span', { style: { color: colour, fontSize: 12 }, children: [
                    move.type,
                    move.power ? ` · ${move.power}` : move.kind === 'heal' ? ' · heal' : move.kind === 'shield' ? ' · shield' : ''
                  ] })
                ]
              }, move.id)
            }) })
          ] })
        ]
      }),
      jsxs('div', { style: { border: `1px solid ${stroke}`, borderRadius: 14, padding: 12, background: card }, children: [
        jsx('div', { style: { fontSize: 12, fontWeight: 700, marginBottom: 8 }, children: '4. Start a battle against the computer' }),
        jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }, children: [
          ...levels.map(level =>
            jsx('button', {
              type: 'button',
              key: level.id,
              'data-testid': `petb-level-${level.id}`,
              onClick: () => onStart(level.id),
              disabled: !ready || busy,
              style: {
                padding: '9px 14px', borderRadius: 6,
                border: `1px solid ${ready ? accent : stroke}`,
                background: ready ? `${accent}1f` : 'transparent',
                color: ready ? text.primary : text.tertiary,
                cursor: ready && !busy ? 'pointer' : 'default',
                fontSize: 13, fontWeight: 700, opacity: busy ? 0.6 : 1
              },
              children: level.label
            }, level.id)),
          jsx('span', {
            style: { fontSize: 12, color: ready ? text.tertiary : 'var(--ui-warning, #d9a441)' },
            children: ready ? `Lead pet: ${type}, four moves chosen.` : 'Pick exactly four moves to start.'
          })
        ] }),
        jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 12, paddingTop: 12, borderTop: `1px solid ${stroke}` }, children: [
          jsx('span', { style: { fontSize: 12, color: text.secondary }, children: 'Or just watch:' }),
          ...levels.map(level =>
            jsx('button', {
              type: 'button',
              key: `watch-${level.id}`,
              'data-testid': `petb-watch-level-${level.id}`,
              onClick: () => { setWatchLevel(level.id); onWatch(level.id) },
              disabled: busy,
              style: {
                padding: '6px 10px', borderRadius: 999,
                border: `1px solid ${watchLevel === level.id ? accent : stroke}`,
                background: watchLevel === level.id ? `${accent}1c` : 'transparent',
                color: text.secondary, cursor: busy ? 'default' : 'pointer', fontSize: 12
              },
              children: level.label
            }, `watch-${level.id}`)),
          button('Watch two computer teams', () => onWatch(watchLevel), { disabled: busy })
        ] })
      ] }),
      petdexNote(petdex),
      notice ? jsx('div', { role: 'status', style: { fontSize: 12, color: text.secondary }, children: notice }) : null
    ]
  })
}
