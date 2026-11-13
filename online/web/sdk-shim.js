// Stand-in for @hermes/plugin-sdk so the Desktop module loads in a plain browser.
// The web page imports the board drawing from desktop/plugin.js; nothing here
// registers into a host. Every name the module imports must exist here, or the
// whole module fails to load and the site stays on its boot screen.
export const host = {
  navigate() {},
  revealPane() {},
  onEvent() { return () => {} },
  state: { busy: { get: () => false, subscribe: () => () => {} } }
}
export const PALETTE_AREA = 'palette'
export const PANES_AREA = 'panes'
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar-nav'
export const STATUSBAR_AREAS = { left: 'status-left', right: 'status-right' }
// The composer's seams. The site never draws the composer (it shows a board), but the module names
// these areas when it registers, so the import has to resolve.
export const COMPOSER_AREAS = { top: 'composer.top', bottom: 'composer.bottom', underside: 'composer.underside' }
// The site draws the board; it does not run the pane, so reading an atom once is
// enough to satisfy the import.
export const useValue = atom => (atom && typeof atom.get === 'function' ? atom.get() : undefined)
