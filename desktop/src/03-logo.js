// A small, self-contained identity shared by the Games header and brand assets.
function GameCenterMark({ size = 64 }) {
  return jsxs('svg', {
    'data-game-center-mark': '1', 'aria-hidden': 'true', width: size, height: size,
    viewBox: '0 0 64 64', fill: 'none',
    style: { flex: '0 0 auto', filter: 'drop-shadow(0 4px 10px rgba(62,224,197,.22))' },
    children: [
      jsx('path', { d: 'M32 2 57.98 17v30L32 62 6.02 47V17L32 2Z', fill: '#070b14', stroke: '#a99bff', strokeWidth: 2 }),
      jsx('path', { d: 'M17 36c1-7 4-12 9-12h12c5 0 8 5 9 12l1 6c.4 3-3 5-5 3l-6-5H27l-6 5c-2 2-5.4 0-5-3l1-6Z', stroke: '#3ee0c5', strokeWidth: 3, strokeLinejoin: 'round' }),
      jsx('path', { d: 'M22 32h8m-4-4v8', stroke: '#3ee0c5', strokeWidth: 3, strokeLinecap: 'round' }),
      jsx('circle', { cx: 38, cy: 30, r: 2, fill: '#ff5d73' }),
      jsx('circle', { cx: 42, cy: 35, r: 2, fill: '#a99bff' }),
      jsx('path', { d: 'M25 15h14', stroke: '#a99bff', strokeWidth: 2, strokeLinecap: 'round' })
    ]
  })
}

function GameCenterWordmark() {
  return jsxs('div', { children: [
    jsx('div', { style: { fontSize: 10, letterSpacing: '.18em', fontWeight: 700, color: text.tertiary, marginBottom: 2 }, children: 'HERMES AGENT · GAME CENTER' }),
    jsx('div', { style: { fontFamily: DISPLAY_FONT, fontSize: 30, lineHeight: 1.12, letterSpacing: '-.022em', fontWeight: 700 }, children: 'Game Center' })
  ] })
}

// The small game icon both side-pane doors wear (owner's ask, 2026-11-11): the same pad the
// Game Center mark draws, at status-bar size and in whatever colour the door is set in. It
// takes no state, so it is a plain function and its element lands in the caller's own tree.
function paneDoorIconElement(size = 14) {
  return jsxs('svg', {
    'data-games-pane-icon': '1', 'aria-hidden': 'true', width: size, height: size,
    viewBox: '0 0 24 24', fill: 'none', style: { flex: '0 0 auto' },
    children: [
      jsx('path', {
        d: 'M8.6 8.5h6.8c2.1 0 3.4 1.2 3.9 3.2l.8 3.4c.4 1.7-1.6 2.8-2.9 1.7l-2-1.7h-6.4l-2 1.7c-1.3 1.1-3.3 0-2.9-1.7l.8-3.4c.5-2 1.8-3.2 3.9-3.2Z',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round'
      }),
      jsx('path', { d: 'M9 11.4v3.2M7.4 13h3.2', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      jsx('circle', { cx: 15.6, cy: 12.4, r: 1.1, fill: 'currentColor' }),
      jsx('circle', { cx: 17.8, cy: 14.6, r: 1.1, fill: 'currentColor' })
    ]
  })
}
