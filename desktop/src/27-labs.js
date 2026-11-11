// ---- 27-labs.js: the Labs shelf, where a Phase 1 experiment is shown as one
// Labs is one shelf, one badge and one card shape. Another lane adds its experiment by adding a
// `labsBlock(...)` inside the shelf, and its cards with `labsCard(...)`; it never adds a second
// badge, a second heading style or a new colour. Nothing in Labs is Play: no experiment here is
// reviewed, seated, rated or visible to a lobby, and every card says who made it.

const LABS_BADGE = 'Labs · experiment'
const LABS_NOTE = 'New experiments that may change or be removed at any time. Nothing here is part of the reviewed Play shelf.'

// ---- The lock on the Experimental section (owner's ask 2026-11-10, #7) -------------------------
// The Experimental section is a shop window, not a door: every game in it stays visible and cannot
// be opened, so a draft that is not finished never costs the shelf a mark on polish. The lock is
// one vocabulary written once here - one badge, one tooltip, one dim - so every lane's card reads
// the same and no card invents its own way of saying no.
const LABS_LOCK_BADGE = '🔒 Coming soon'
const LABS_LOCK_TITLE = 'Experimental — not open yet. Coming soon.'
const LABS_LOCK_HELP = 'Early experiments. You can see them; they open when they are ready.'
// How dim a locked card is. Slightly dimmed on purpose: still readable, plainly not a door.
const LABS_LOCK_OPACITY = 0.55

// The badge itself: a label, not an alert, in the same voice as the Labs badge beside it.
function labsLockTag() {
  return jsx('span', {
    'data-labs-lock': '1',
    style: {
      fontSize: 11,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      color: text.tertiary,
      whiteSpace: 'nowrap'
    },
    children: LABS_LOCK_BADGE
  })
}

// What every locked card wears: dimmed, no pointer cursor, announced as disabled, the tooltip
// saying why. tabIndex 0 so a screen reader still finds it; a div has no default action, so Enter
// and Space on it do nothing.
function labsLockStyle(extra) {
  return Object.assign({
    position: 'relative',
    opacity: LABS_LOCK_OPACITY,
    cursor: 'not-allowed',
    minWidth: 0
  }, extra || {})
}

// A locked card whose art is drawn by a file this lane does not own (Pet Battles, Mafia Town): the
// card keeps its own picture, and this wrapper takes its doors away. Clicks and keys are stopped in
// the capture phase, so a button inside never runs its handler - by mouse or by Enter/Space - and
// the inner copy takes no pointer events at all, so the cursor stays not-allowed over it.
function labsLocked(children, id) {
  const swallow = event => {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
  }
  return jsxs('div', {
    'data-labs-locked': id || 'true',
    'aria-disabled': 'true',
    role: 'group',
    tabIndex: 0,
    title: LABS_LOCK_TITLE,
    onClickCapture: swallow,
    onKeyDownCapture: swallow,
    style: labsLockStyle({ display: 'flex', flexDirection: 'column' }),
    children: [
      jsx('div', { style: { position: 'absolute', top: 10, right: 12, zIndex: 1 }, children: labsLockTag() }, 'lock'),
      jsx('div', { style: { minWidth: 0, pointerEvents: 'none' }, children }, 'body')
    ]
  })
}

// A label, not a warning: a micro caps line, no pill and no border, so it never reads as an
// alert or as a status of its own.
function labsBadge() {
  return jsx('span', {
    'data-labs-badge': LABS_BADGE,
    style: {
      fontSize: 12,
      letterSpacing: '0.09em',
      textTransform: 'uppercase',
      color: text.tertiary,
      whiteSpace: 'nowrap'
    },
    children: LABS_BADGE
  })
}

// The shelf heading, written once so every lane renders the same words in the same place.
function labsHeading(note = LABS_NOTE) {
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10, minWidth: 0 },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
        children: [
          jsx('div', {
            style: { fontFamily: DISPLAY_FONT, fontSize: 22, lineHeight: 1.15, letterSpacing: '-.015em', fontWeight: 600 },
            children: 'Labs'
          }),
          labsBadge()
        ]
      }),
      jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: note })
    ]
  })
}

// One experiment: a small title, one plain sentence, then its own cards. One card and six cards
// both look deliberate, because a block is always the same column.
function labsBlock(title, note, children) {
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 },
    children: [
      jsxs('div', { style: { borderBottom: `1px solid ${stroke}`, paddingBottom: 6 }, children: [
        jsx('div', { style: { fontFamily: DISPLAY_FONT, fontSize: 16, letterSpacing: '-.01em', fontWeight: 600 }, children: title }),
        note ? jsx('div', { style: { fontSize: 12, color: text.tertiary, marginTop: 2 }, children: note }) : null
      ] }),
      children
    ]
  })
}

// A Labs card for something that lives on another page: the name, who made it, one honest line
// about what it is, one quiet way out. Quiet, because only a game you can play here gets the solid
// accent button; a card that leaves Hermes never looks like one that starts something.
function labsCard(item, ctx, setNote) {
  const open = async () => {
    const url = String(item.url || '')
    if (!/^https:\/\//i.test(url)) {
      setNote('That card has no web address Game Center can open.')
      return
    }
    try {
      const opened = ctx && ctx.os && typeof ctx.os.openExternal === 'function'
        ? await ctx.os.openExternal(url)
        : false
      if (!opened) setNote(`Could not open ${url} in your browser.`)
    } catch {
      setNote(`Could not open ${url} in your browser.`)
    }
  }
  const official = item.kind === 'skill'
  return jsxs('div', {
    key: item.id,
    'data-labs-card': item.id,
    style: {
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      gap: 6,
      borderRadius: 14,
      padding: 16,
      background: card,
      minWidth: 0
    },
    children: [
      jsxs('div', { style: { minWidth: 0 }, children: [
        jsxs('div', {
          style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
          children: [
            jsx('div', { style: { fontFamily: DISPLAY_FONT, fontSize: 17, letterSpacing: '-.01em', fontWeight: 600 }, children: item.title }),
            jsx('span', {
              style: { fontSize: 12, letterSpacing: '0.09em', textTransform: 'uppercase', color: text.tertiary },
              children: official ? 'Official skill' : 'Plugin tool'
            })
          ]
        }),
        jsx('div', {
          style: { fontSize: 12, color: text.tertiary, marginTop: 2 },
          children: official
            ? `by ${item.maker} · official Hermes skill`
            : `by ${item.maker} · community-made, not affiliated`
        }),
        jsx('div', { style: { fontSize: 12, color: text.secondary, marginTop: 4, lineHeight: 1.35 }, children: item.summary }),
        item.note
          ? jsx('div', { style: { fontSize: 12, color: text.tertiary, marginTop: 4, lineHeight: 1.35 }, children: item.note })
          : null
      ] }),
      jsx('div', { style: { display: 'flex', gap: 8, marginTop: 6 }, children: [
        textLink(official ? 'Open skill page' : 'Open catalog page', open, `${item.title}: open the ${official ? 'skill' : 'catalog'} page`)
      ] })
    ]
  })
}

// A Labs card for a game that can be played right here - locked for now (owner's ask 2026-11-10,
// #7): the same quiet shape as the link-out cards, the same picture and words, and no way in. The
// `onOpen` a caller still passes is deliberately not wired: a locked card has no handler at all.
function labsPlayCard(item) {
  return jsxs('div', {
    key: item.id,
    'data-labs-play': item.id,
    'aria-disabled': 'true',
    tabIndex: 0,
    title: LABS_LOCK_TITLE,
    style: labsLockStyle({
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      gap: 8,
      borderRadius: 14,
      padding: 16,
      background: card
    }),
    children: [
      jsxs('div', { style: { minWidth: 0 }, children: [
        jsxs('div', {
          style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
          children: [
            jsx('div', { style: { fontFamily: DISPLAY_FONT, fontSize: 17, letterSpacing: '-.01em', fontWeight: 600 }, children: item.title }),
            labsBadge(),
            labsLockTag()
          ]
        }),
        jsx('div', { style: { fontSize: 12, color: text.tertiary, marginTop: 2 }, children: item.ship === false ? 'Built into Game Center · failed the ship gate' : 'Built into Game Center · experimental build' }),
        item.ship === false
          ? jsx('div', { style: { fontSize: 12, color: text.secondary, marginTop: 4, lineHeight: 1.35 }, children: `Hidden from Play: ${(item.gate_fails || []).slice(0, 2).join('; ') || 'the ship gate did not pass it'}` })
          : null,
        jsx('div', { style: { fontSize: 12, color: text.secondary, marginTop: 4, lineHeight: 1.35 }, children: item.summary })
      ] }),
      // Where the one solid button used to be: the same sentence, without a door.
      jsx('div', { style: { fontSize: 12, color: text.tertiary, marginTop: 4 }, children: 'Locked for now — this one opens when it is ready.' })
    ]
  })
}

// The whole shelf: heading, badge, one note, then the blocks. A lane with nothing to show returns
// null rather than an empty box.
function labsShelf(children, note = LABS_NOTE, options = {}) {
  const shown = (Array.isArray(children) ? children : [children]).filter(Boolean)
  if (!shown.length) return null
  // Under the Experiments heading the shelf does not repeat its own title: one heading for the
  // whole area (owner's ask, 2026-11-09).
  const withHeading = options.withHeading !== false
  return jsxs('div', {
    'data-labs-section': 'true',
    style: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 },
    children: withHeading ? [labsHeading(note), ...shown] : shown
  })
}

// A whole Labs block of link-out cards, with its own note under the cards. The Make games shelf is
// the first user of this; another lane's shelf is the second, and neither needs new styles.
function LabsLinks({ title, note, notice, items, ctx }) {
  const [said, setSaid] = useState('')
  if (!items || !items.length) return null
  return labsBlock(title, note, jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }, children: [
    jsx('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))', gap: 12 },
      children: items.map(item => labsCard(item, ctx, setSaid))
    }),
    notice
      ? jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: notice })
      : null,
    said
      ? jsx('div', { role: 'status', 'aria-live': 'polite', style: { fontSize: 12, color: text.secondary }, children: said })
      : null
  ] }))
}
