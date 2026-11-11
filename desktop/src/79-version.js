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

// Where the async clipboard is missing or refuses (an older desktop, a page without the permission),
// a hidden textarea and the old copy command are the fallback, so a copy never silently does nothing.
function copyWithTextarea(text) {
  try {
    if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') return false
    const box = document.createElement('textarea')
    box.value = text
    box.setAttribute('readonly', '')
    box.style.position = 'fixed'
    box.style.top = '-1000px'
    box.style.opacity = '0'
    document.body.appendChild(box)
    box.select()
    const done = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
    document.body.removeChild(box)
    return done !== false
  } catch (error) {
    return false
  }
}

// Copies one line and resolves true once it is on the clipboard, whichever door worked.
function copyChipText(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return Promise.resolve(navigator.clipboard.writeText(text))
        .then(() => true, () => copyWithTextarea(text))
    }
  } catch (error) { /* fall through to the textarea */ }
  return Promise.resolve(copyWithTextarea(text))
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
  // The chip copies its own text — the same line it shows, so what is pasted is what was read.
  const copy = () => {
    Promise.resolve(copyChipText(line)).then(() => {
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
