// ---- 80-plugin.js: what Hermes loads: the page, the pane, the palette and the badges
export default {
  id: 'hermes-gameshelf',
  name: 'Game Center',
  register(ctx) {
    // The wait pane is registered on its own so × can take it off the screen (see 62-pane-state.js).
    WAIT_PANE_SLOT.ctx = ctx
    // A fresh load starts clean: the host already disposed the previous load's pane.
    WAIT_PANE_SLOT.dispose = null
    WAIT_PANE_SLOT.make = () => ({
      id: 'pane',
      area: PANES_AREA,
      title: 'Play while you code',
      // Beside the chat, as its own column. It lands minimized so installing the
      // plugin never reshapes a layout, and it is hide-only so Hermes never offers
      // its own Close (that would disable the whole plugin); our × unregisters it.
      data: {
        placement: 'right',
        // `enforce` is the host's standing invariant, not a one-time migration: it re-homes the pane
        // onto this anchor at every boot's first adoption pass when it is anywhere else, with no user
        // exemption (apps/desktop/src/components/pane-shell/tree/store.ts, enforceDockedPanes). The
        // pane stayed wrong for good otherwise - the host adopts a contributed pane once and then
        // remembers where it was, so one drag, or one host update, was permanent (owner, 2026-11-18:
        // "pane always right").
        dock: { pane: 'workspace', pos: 'right', enforce: true },
        width: PANE_WIDTH,
        minWidth: '300px',
        maxWidth: '1200px',
        defaultCollapsed: true,
        hideOnly: true
      },
      render: () => jsx(GamesBoundary, {
        where: 'pane',
        // Back to the pane's game list: forget the game that crashed so it is not reopened.
        onReset: () => {
          paneWatch.game = ''
          storeValue(ctx, PANE_GAME_KEY, '')
        },
        children: jsx(WaitPane, { ctx })
      })
    })
    if (!paneGone()) mountWaitPane()
    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: ROUTE },
        render: () => jsx(GameCenterRoute, { ctx })
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        data: { path: ROUTE, label: 'Games', codicon: 'game' }
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-gameshelf.open',
          label: 'Open Game Center',
          keywords: ['games', 'shelf', 'lobby', 'store', 'install'],
          run: () => host.navigate(ROUTE)
        }
      },
      {
        id: 'wait',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-gameshelf.wait',
          label: 'Play while you code',
          keywords: ['game', 'pane', 'play', 'wait', 'code', 'agent', 'quick', 'side'],
          run: () => openWaitPane()
        }
      },
      {
        id: 'status',
        area: STATUSBAR_AREAS.right,
        order: 140,
        // ONE item (owner, 12:25): hidden while there is nothing to say, one
        // actionable line when there is. It renders null, not a permanent label.
        render: () => jsx(GamesStatusItem, { ctx })
      },
      {
        // The two see-through machines, in the composer's own slot (78-overchat-slot.js). A slot, not an
        // overlay: the app owns where it goes and how wide it is, so an app update cannot break it and it
        // cannot break the app (review, 2026-11-12). The strip draws only while a switch is on, and the
        // switches themselves live where they always did — the Slots table, the cabinet's own panel and
        // Settings.
        id: 'overchat',
        area: COMPOSER_AREAS.underside,
        render: () => jsx(OverChatStrip, { ctx })
      },
      {
        // An invite, on a surface that is mounted all the time (77-invite-bell.js). The status bar
        // is the one the person already reads; the titlebar copy below is its stand-in for a window
        // whose status bar is hidden. Only one of the two ever draws.
        id: 'invite',
        area: STATUSBAR_AREAS.right,
        order: 142,
        render: () => jsx(InviteBell, { ctx, where: 'statusbar' })
      },
      {
        id: 'invite-titlebar',
        area: TITLEBAR_AREAS.right,
        order: 998,
        render: () => jsx(InviteBell, { ctx, where: 'titlebar' })
      },
      {
        // The fixed stage that draws those machines at the top of the window. It lives in the status bar
        // because the composer dock is centred with a transform, which traps a fixed box drawn inside it
        // (78-overchat-slot.js). It renders nothing while both switches are off.
        id: 'overchat-stage',
        area: STATUSBAR_AREAS.right,
        order: 141,
        render: () => jsx(OverChatStage, { ctx, where: 'statusbar' })
      },
      {
        // The stand-in for the stage above, for a window whose status bar is hidden (Simple mode rests it
        // hidden). The titlebar's right cluster is always drawn and has no transform; it draws nothing while
        // the status-bar stage is drawing (78-overchat-slot.js).
        id: 'overchat-stage-titlebar',
        area: TITLEBAR_AREAS.right,
        order: 999,
        render: () => jsx(OverChatStage, { ctx, where: 'titlebar' })
      }
    ])
  }
}

// Shared with Game Center Online (online/web/app.js), which draws the same boards in a browser.
export { BoardSvg, coverArt, startingPicture, tableAccess }

// The Game Center page and its one way out. On the Games screen Close Game Center sits in the
// header, top right, beside search (owner's ask, 2026-11-11); on every other screen (Settings,
// Champions, Community, ...) it floats top right instead of the old bottom-right corner.
function GameCenterRoute({ ctx }) {
  // The page is a Game Center surface: its own errors and heap go to the plugin's log.
  useEffect(() => diagSurfaceOpen(ctx), [ctx])
  const [area, setArea] = useState('games')
  return jsxs('div', {
    style: { position: 'relative', height: '100%' },
    children: [
      jsx(GamesBoundary, { where: 'page', onClose: () => closeGameCenter(ctx), children: jsx(GameCenterPage, { ctx, onArea: setArea }) }),
      area === 'games' ? null : jsx('div', {
        'data-gc-close-float': '1',
        style: { position: 'absolute', right: 16, top: 12, zIndex: 40 },
        children: closeGameCenterButton(ctx)
      })
    ]
  })
}

function closeGameCenterButton(ctx) {
  return button('Close Game Center', () => closeGameCenter(ctx), { title: 'Back to the chat. Your game stays where you left it.' })
}
