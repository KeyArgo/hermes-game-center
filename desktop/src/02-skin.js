// ---- 02-skin.js: the Signal Hall skin and the look the person chose
//
// Classic is the look the plugin shipped with: it stays pixel-identical because
// every new rule is scoped to [data-skin="signal"]. Signal Hall is a night-hall
// reskin: deep ground, one hot colour for "needs you" and one cool colour for
// "someone is here / go". Boards stay the art; only the chrome takes the skin.
const SKIN_KEY = 'skin'

const SKIN_CSS = `
.games-center-shell[data-skin="signal"] {
  --gc-ground: #070b14;
  --gc-surface: #101826;
  --gc-raised: #182338;
  --gc-line: #243044;
  --gc-ink: #eef3fb;
  --gc-muted: #9aa8bd;
  --gc-faint: #6d7c93;
  --gc-signal: #ff5d73;
  --gc-ion: #3ee0c5;
  --gc-violet: #a99bff;
  --gc-warn: #ffb020;
  --gc-danger: #ff4d4d;
  --gc-ok: #8dffb3;
  --gc-font-display: ui-sans-serif, "Segoe UI Variable Display", "Avenir Next", "Segoe UI", system-ui, sans-serif;
  --gc-font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --ui-bg-solid: var(--gc-ground);
  --ui-bg-editor: var(--gc-ground);
  --ui-bg-elevated: var(--gc-surface);
  --ui-bg-card: var(--gc-surface);
  --ui-fill-tertiary: var(--gc-raised);
  --ui-stroke-secondary: var(--gc-line);
  --ui-text-primary: var(--gc-ink);
  --ui-text-secondary: var(--gc-muted);
  --ui-text-tertiary: var(--gc-faint);
  --ui-accent: var(--gc-ion);
  --ui-text-on-accent: var(--gc-ground);
  color: var(--gc-ink);
  color-scheme: dark;
  background-color: var(--gc-ground) !important;
  background-image:
    radial-gradient(60% 50% at 0% 0%, rgba(62, 224, 197, .08), transparent 70%),
    radial-gradient(55% 45% at 100% 100%, rgba(169, 155, 255, .06), transparent 70%),
    repeating-linear-gradient(0deg, rgba(62, 224, 197, .04) 0 1px, transparent 1px 32px),
    repeating-linear-gradient(90deg, rgba(62, 224, 197, .04) 0 1px, transparent 1px 32px) !important;
}

/* Every page-level surface stays opaque (sticky headers, the tutorial, result cards sit on it), and they
   all share ONE grid fixed to the viewport, so the hall reads as one continuous floor. */
.games-center-shell[data-skin="signal"] [style*="--ui-bg-editor"] {
  background-color: var(--gc-ground) !important;
  background-image:
    radial-gradient(60% 50% at 0% 0%, rgba(62, 224, 197, .08), transparent 70%),
    radial-gradient(55% 45% at 100% 100%, rgba(169, 155, 255, .06), transparent 70%),
    repeating-linear-gradient(0deg, rgba(62, 224, 197, .04) 0 1px, transparent 1px 32px),
    repeating-linear-gradient(90deg, rgba(62, 224, 197, .04) 0 1px, transparent 1px 32px) !important;
  background-attachment: fixed !important;
}

.games-center-shell[data-skin="signal"] [style*="--ui-bg-elevated"]:not(.games-result) {
  border-color: var(--gc-line) !important;
  border-radius: 14px !important;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .04) !important;
  transition: border-color 160ms ease;
}
.games-center-shell[data-skin="signal"] [style*="--ui-bg-elevated"]:not(.games-result):hover {
  border-color: rgba(62, 224, 197, .35) !important;
}

.games-center-shell[data-skin="signal"] button {
  transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
}
.games-center-shell[data-skin="signal"] button[style*="background: var(--ui-accent)"] {
  box-shadow: 0 0 0 1px var(--gc-ion), 0 6px 20px rgba(62, 224, 197, .25) !important;
}
.games-center-shell[data-skin="signal"] button[style*="background: var(--ui-accent)"]:hover:not(:disabled) {
  transform: translateY(-1px);
}
.games-center-shell[data-skin="signal"] button:not([style*="background: var(--ui-accent)"]):not([style*="text-decoration: underline"]):hover:not(:disabled) {
  border-color: var(--gc-violet) !important;
}

/* Text links stay links: a thin ion underline set a little below the words, no box. */
.games-center-shell[data-skin="signal"] button[style*="text-decoration: underline"] {
  text-decoration-color: rgba(62, 224, 197, .45) !important;
  text-underline-offset: 3px;
}
.games-center-shell[data-skin="signal"] [style*="--gc-font-display"] {
  font-weight: 650 !important;
  letter-spacing: -.02em !important;
}
.games-center-shell[data-skin="signal"] [style*="text-transform: uppercase"] {
  color: rgba(62, 224, 197, .8) !important;
}

.games-center-shell[data-skin="signal"] :focus-visible {
  outline: 2px solid var(--gc-ion);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .games-center-shell[data-skin="signal"] *,
  .games-center-shell[data-skin="signal"] *::before,
  .games-center-shell[data-skin="signal"] *::after {
    transition: none !important;
    animation: none !important;
  }
}
`

function readSkin(ctx) {
  try {
    if (!ctx || !ctx.storage || typeof ctx.storage.get !== 'function') return 'signal'
    const value = ctx.storage.get(SKIN_KEY, 'signal')
    return value === 'classic' ? 'classic' : 'signal'
  } catch {
    return 'signal'
  }
}

function storeSkin(ctx, skin) {
  try {
    if (ctx && ctx.storage && typeof ctx.storage.set === 'function') ctx.storage.set(SKIN_KEY, skin)
  } catch {
    // An older host without plugin storage: the skin still applies for this visit.
  }
}

function useSkin(ctx) {
  const [skin, setSkinState] = useState(() => readSkin(ctx))
  const setSkin = value => {
    const next = value === 'classic' ? 'classic' : 'signal'
    storeSkin(ctx, next)
    setSkinState(next)
  }
  return [skin, setSkin]
}

function skinToggle(skin, onSkin) {
  const classic = skin === 'classic'
  return toggleRow({
    title: 'Classic look',
    note: 'Off is Signal Hall, a night-hall skin. On keeps the old Game Center colours.',
    on: classic,
    onToggle: () => {
      if (typeof onSkin === 'function') onSkin(classic ? 'signal' : 'classic')
    }
  })
}

// Screens that return early (first run, loading, an error, Admin, Champions) are wrapped here so
// no screen of the page falls back to the host's own colours.
function skinShell(skin, child) {
  return jsxs('div', {
    className: 'games-center-shell',
    'data-skin': skin,
    style: { height: '100%', minHeight: 0, minWidth: 0 },
    children: [jsx('style', { children: SKIN_CSS }), child]
  })
}
