// ---- 05-primitives.js: the small pieces every screen is built from
function button(label, onClick, options = {}) {
  return jsx('button', {
    type: 'button',
    onClick,
    disabled: options.disabled,
    autoFocus: options.autoFocus,
    title: options.title,
    'aria-label': options.label,
    // A tile that stands for the current choice says so, for a screen reader and for
    // anyone who cannot see which one is lit.
    'aria-pressed': options.pressed,
    style: {
      padding: '8px 13px',
      borderRadius: 8,
      border: `1px solid ${options.primary ? accent : stroke}`,
      background: options.primary ? accent : 'transparent',
      color: options.primary ? 'var(--ui-text-on-accent, white)' : text.secondary,
      cursor: options.disabled ? 'default' : 'pointer',
      opacity: options.disabled ? 0.5 : 1,
      fontSize: 13,
      fontWeight: 600
    },
    children: label
  })
}

function field(value, setValue, placeholder, onEnter, options = {}) {
  return jsx('input', {
    value,
    placeholder,
    'aria-label': options.label,
    onChange: event => setValue(event.target.value),
    onKeyDown: event => {
      if (event.key === 'Enter' && value.trim()) onEnter()
    },
    style: {
      flex: 1,
      minWidth: 0,
      padding: '7px 10px',
      borderRadius: 8,
      border: `1px solid ${stroke}`,
      background: 'transparent',
      color: 'inherit',
      fontSize: 12
    }
  })
}

function pre(body) {
  return jsx('pre', {
    style: {
      margin: 0,
      padding: 12,
      border: `1px solid ${stroke}`,
      borderRadius: 8,
      fontFamily: 'var(--font-mono, ui-monospace, monospace)',
      fontSize: 12,
      lineHeight: 1.35,
      whiteSpace: 'pre',
      overflow: 'auto',
      background: fill
    },
    children: body
  })
}

function copyText(value, onDone) {
  const shown = String(value || '')
  if (!shown) return
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(shown).then(
      () => onDone('Copied ' + shown),
      () => onDone('Join ' + shown)
    )
    return
  }
  onDone('Join ' + shown)
}

// ---- The one "Open in browser" affordance ---------------------------------
// Every surface that has an online page (game, lobby, match, passport, replay)
// uses these. The address always comes from the online lobby URL setting —
// view.online.url, the plugin's lobby_url — never a host written into a file,
// so a test lobby on 127.0.0.1 and a self-hosted lobby both work unchanged.
// Hermes stays the usable surface: the button only ever hands the address to
// the person's own browser, and the note beside it says that in one short line.
function openInBrowser(ctx, url, setNote) {
  const shown = String(url || '')
  if (!shown) return
  // Only a web address may reach the operating system's handler. Server data and the
  // lobby setting are outside Hermes, and `javascript:`, `file:` or a custom scheme
  // would hand the click to whatever registered it.
  if (!/^https?:\/\//i.test(shown)) {
    if (setNote) setNote('That address is not a web link, so nothing was opened.')
    return
  }
  const fallback = () => copyText(shown, setNote)
  try {
    const opened = ctx && ctx.os && typeof ctx.os.openExternal === 'function'
      ? ctx.os.openExternal(shown)
      : Promise.resolve(false)
    Promise.resolve(opened).then(ok => {
      if (ok && setNote) setNote(`Opened ${shown} in your browser.`)
      else if (!ok) fallback()
    }, fallback)
  } catch {
    fallback()
  }
}

// The button. Pass the full target (built from the lobby URL setting) and the
// note it should write; the title always says where it goes and that it is
// the online lobby, so the network use is disclosed before the click too.
function browserButton(ctx, url, setNote, options = {}) {
  const shown = String(url || '')
  return button(options.label || 'Open in browser', () => openInBrowser(ctx, shown, setNote), {
    primary: options.primary,
    disabled: !shown,
    title: options.title || (shown
      ? `Opens ${shown} in your browser — that is the online lobby, outside Hermes.`
      : 'No online lobby address is set.')
  })
}

// The honest one-liner worn next to every Open-in-browser control.
function browserNote(url, say) {
  return jsx('div', {
    style: { fontSize: 11, color: text.tertiary, lineHeight: 1.45 },
    children: `${say || 'This opens the online lobby'} at ${onlineHost(url)} in your browser — outside Hermes.`
  })
}

function heading(label) {
  return jsx('div', {
    style: {
      fontSize: 12,
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      color: text.tertiary,
      margin: '4px 0 8px'
    },
    children: label
  })
}

// ---- The room's furniture ---------------------------------------------------
// One display face for every screen's headline: a system serif, so nothing is
// fetched from the network and no webfont is shipped.
const DISPLAY_FONT = 'var(--gc-font-display, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, ui-serif, serif)'

// A number that changes while you watch is set in tabular figures.
const TABULAR = { fontVariantNumeric: 'tabular-nums', fontFeatureSettings: '"tnum" 1' }


function badge(label) {
  return jsx('span', {
    style: {
      fontSize: 12,
      color: text.secondary,
      border: `1px solid ${stroke}`,
      borderRadius: 999,
      padding: '3px 9px'
    },
    children: label
  })
}

// A feature that is not built yet says so plainly: a small card with its name,
// a Coming soon pill and one line about what it will do. It never pretends to
// be a control.
function comingSoon(title, line) {
  return jsxs('div', {
    'data-coming-soon': title,
    'aria-label': 'Coming soon: ' + title,
    title: 'Coming soon: ' + title,
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      minWidth: 150,
      padding: 12,
      borderRadius: 12,
      border: `1px solid ${stroke}`,
      background: card
    },
    children: [
      jsxs('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }, children: [
        jsx('div', { style: { fontSize: 13, fontWeight: 650, color: text.primary }, children: title }),
        jsx('span', {
          style: {
            fontSize: 10,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: accent,
            border: `1px solid ${accent}`,
            borderRadius: 999,
            padding: '2px 8px'
          },
          children: 'Coming soon'
        })
      ] }),
      jsx('div', { style: { fontSize: 12, color: text.secondary, lineHeight: 1.45 }, children: line })
    ]
  })
}

// A quiet link, for the one thing that is deliberately not on the main page. The fourth argument is
// the key a caller mapping a list of links hands to React; a lone link passes nothing.
function textLink(label, onClick, ariaLabel, key) {
  return jsx('button', {
    type: 'button',
    onClick,
    'aria-label': ariaLabel || undefined,
    style: {
      background: 'transparent',
      border: 0,
      padding: 0,
      font: 'inherit',
      fontSize: 13,
      color: accent,
      cursor: 'pointer',
      textDecoration: 'underline'
    },
    children: label
  }, key)
}

// ----- Champions and tournaments -------------------------------------------
// A champion is a local character: a name, a glyph, a colour and a creative
// brief, played by this Hermes's own model. Tournaments are round-robin,
// both colours, run in the background by the backend, and rated with Elo.

function saveFile(name, text) {
  try {
    if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') return false
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    return true
  } catch (failure) {
    return false
  }
}
