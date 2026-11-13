// ---- 79-version.js: the version chip, so the install on screen can be identified at a glance
/**
 * One source: the plugin's own backend (/v1/version -> version_stamp), never a number typed into
 * this bundle. A hard-coded badge drifts the moment the manifest moves, and drifts silently.
 *
 * It is a chip, and it is drawn twice from the one component (owner, 2026-11-11): small and muted at
 * the top of the Games header, beside the wordmark, and at the top of Settings — which is what the
 * full-screen Games app shows and what the play-while-you-wait pane's own gear opens (owner,
 * 2026-11-10: "keep everything in the status bar except the version chip. The version chip lives in
 * Settings"). One component, so the two copies can never drift apart; the header copy only passes a
 * smaller, dimmer `style` so it stays a whisper beside the title.
 *
 * It is also click-to-copy (owner's ask, 2026-11-11): one press — or Enter/Space from the keyboard —
 * puts the full chip text on the clipboard and says "Copied" for a breath, so a bug report can quote
 * the exact build without anyone retyping it.
 */

// How long the chip wears "Copied". Long enough to see, short enough not to look stuck.
const CHIP_COPIED_MS = 1500

// Copies one line and resolves true once it is on the clipboard, through the app's own door first.
//
// `ctx.os.writeClipboard` is the SDK's curated clipboard and the only one a plugin should use: it is
// attributed to the plugin, it resolves false (never throws) where the capability is missing, and it
// needs nothing of the document. What it replaced was a hidden <textarea> appended to the app's <body>
// and an execCommand — the same reach into the app's markup the review asked us to stop doing
// (2026-11-12), for a copy that the browser's own clipboard API already does.
function copyChipText(text, ctx) {
  try {
    const door = ctx && ctx.os && typeof ctx.os.writeClipboard === 'function' ? ctx.os : null
    if (door) {
      return Promise.resolve(door.writeClipboard(text)).then(done => {
        if (done !== false) return true
        return copyWithNavigator(text)
      }, () => copyWithNavigator(text))
    }
  } catch (error) { /* fall through to the browser's own clipboard */ }
  return copyWithNavigator(text)
}

function copyWithNavigator(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return Promise.resolve(navigator.clipboard.writeText(text)).then(() => true, () => false)
    }
  } catch (error) { /* no clipboard on this host */ }
  return Promise.resolve(false)
}

function GamesVersionChip({ ctx, style }) {
  const [build, setBuild] = useState(null)
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)
  useEffect(() => {
    let live = true
    Promise.resolve(ctx.rest('/v1/version'))
      .then(answer => { if (live && answer && answer.version) setBuild(answer) })
      .catch(() => {})
    return () => { live = false }
  }, [ctx])
  // A chip that leaves the screen mid-breath must not leave a timer behind.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  if (!build) return null
  // version · build date · short commit — the same line `--version` prints.
  const parts = ['v' + build.version]
  if (build.commit_date) parts.push(String(build.commit_date).slice(0, 10))
  if (build.commit_short || build.commit) parts.push(String(build.commit_short || build.commit).slice(0, 8))
  const line = parts.join(' · ') + (build.dirty ? ' · modified' : '')
  const explain = [
    'Game Center ' + build.version,
    build.commit ? 'commit ' + build.commit : 'no commit (installed copy)',
    build.commit_date ? 'committed ' + build.commit_date : '',
    build.built_at ? 'installed ' + build.built_at : '',
    build.channel ? 'channel ' + build.channel : '',
    build.source ? 'read from ' + build.source : '',
    'Click to copy the version'
  ].filter(Boolean).join('\n')
  // The chip copies its own text — the same line it shows, so what is pasted is what was read. It only
  // says "Copied" when the copy actually happened: a host with no clipboard at all must not claim one.
  const copy = () => {
    Promise.resolve(copyChipText(line, ctx)).then(done => {
      if (!done) return
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), CHIP_COPIED_MS)
    })
  }
  return jsx('span', {
    'data-games-version': 'chip',
    role: 'button',
    tabIndex: 0,
    title: explain,
    onClick: copy,
    onKeyDown: event => {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        if (event.preventDefault) event.preventDefault()
        copy()
      }
    },
    style: Object.assign({
      display: 'inline-flex',
      alignItems: 'center',
      padding: '2px 8px',
      borderRadius: 999,
      border: `1px solid ${stroke}`,
      fontSize: 11,
      letterSpacing: '0.04em',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      color: build.dirty ? '#b45309' : text.tertiary,
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      ...TABULAR
    }, style || {}),
    children: copied ? 'Copied' : line
  })
}
