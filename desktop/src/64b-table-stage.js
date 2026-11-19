// ---- 64b-table-stage.js: the one switch from a picture to the component that draws it
//
// A picture says which game it is (`view`). One table draws blackjack as the card table, Sea Battle
// as the two fleets, Backgammon as its own points, Slots as the person's own machine, and every grid
// game on the one board. The local pane (65-wait-pane.js) and the online table (73-online-table.js)
// both come through here, so the two can never drift: a game online draws exactly what the same game
// draws at home, and there is only one place to teach a new renderer.
//
// A view no stage here knows says so in words. It is never handed to the grid renderer: an empty
// 8x8 chess board under a table that is not chess is a lie about what the person is looking at.
const BOARD_VIEWS = new Set([
  'connect4', 'checkers', 'chess', 'gomoku', 'tictactoe', 'hex', 'reversi',
  'kalah', 'mancala', 'go', 'breakthrough', 'dame'
])

// Everything a stage may need, one argument: the picture, the box it is drawn in, who may press,
// and where a press goes. A caller passes only what it has; nothing here reads the host app.
function tableStage(options) {
  const opts = options || {}
  const pictured = opts.picture || null
  const view = String((pictured && pictured.view) || '')
  if (view === 'blackjack') {
    return jsx(BlackjackTable, {
      picture: pictured, against: opts.against, dealer: opts.dealer,
      interactive: Boolean(opts.interactive), busy: Boolean(opts.busy), onMove: opts.onMove
    })
  }
  if (view === 'seabattle') {
    return jsx(SeaBattleTable, {
      picture: pictured, interactive: Boolean(opts.interactive), busy: Boolean(opts.busy), onMove: opts.onMove
    })
  }
  if (view === 'backgammon') {
    return jsx(BackgammonSvg, {
      picture: pictured, height: opts.height, interactive: Boolean(opts.interactive),
      onMove: opts.onMove, onPhase: opts.onPhase
    })
  }
  if (view === 'slots') {
    const machine = jsx(Jackpot2Full, { ctx: opts.ctx })
    if (!opts.slotsNote) return machine
    // One line under the machine, for a table where the side-by-side floor is not built yet.
    return jsxs('div', {
      className: 'games-stage-slots',
      style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
      children: [
        machine,
        jsx('div', {
          className: 'games-stage-note',
          style: { fontSize: 12, color: text.tertiary, textAlign: 'center' },
          children: opts.slotsNote
        })
      ]
    })
  }
  // A grid game carries its cells; the views in BOARD_VIEWS are the ones the board draws even
  // when a picture arrives without them, exactly as the local pane always drew them.
  if (BOARD_VIEWS.has(view) || Array.isArray(pictured && pictured.cells)) {
    return jsx(BoardSvg, {
      picture: pictured, height: opts.height, flat: opts.flat === undefined ? true : Boolean(opts.flat),
      interactive: Boolean(opts.interactive), onMove: opts.onMove,
      pending: opts.pending, onPending: opts.onPending, coachArrows: opts.coachArrows
    })
  }
  return jsx('div', {
    role: 'status', className: 'games-stage-unknown',
    style: {
      padding: 18, border: `1px solid ${stroke}`, borderRadius: 12, background: card,
      fontSize: 13, color: text.secondary, maxWidth: 420, textAlign: 'center'
    },
    children: opts.unknownText || "This game can't be drawn yet."
  })
}
