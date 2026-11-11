// ---- 06-boundary.js: one broken game never traps the person on a dead screen
// Hermes's own error boundary replaces the whole page with "failed to render", which also
// takes away Back and Close. This one sits inside the page and the pane: a crash in one game
// shows a small card with a way out, and the rest of Game Center keeps working.
class GamesBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failure: null, generation: 0 }
  }

  static getDerivedStateFromError(failure) {
    return { failure }
  }

  componentDidCatch(failure) {
    try {
      console.error('[gameshelf] a screen crashed and was contained', failure)
    } catch {
      // Logging must never be the second crash.
    }
  }

  render() {
    if (!this.state.failure) {
      return jsx('div', { style: { display: 'contents' }, children: this.props.children }, `g${this.state.generation}`)
    }
    const reset = () => {
      try {
        if (this.props.onReset) this.props.onReset()
      } finally {
        // A new generation remounts the screen with fresh state, so the same crash is not replayed.
        this.setState(previous => ({ failure: null, generation: previous.generation + 1 }))
      }
    }
    const detail = String((this.state.failure && this.state.failure.message) || this.state.failure || '').slice(0, 160)
    return jsxs('div', {
      role: 'alert',
      'data-games-boundary': this.props.where || 'page',
      style: {
        margin: 16, padding: 16, borderRadius: 12, border: `1px solid ${stroke}`, background: card,
        color: text.primary, display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 520
      },
      children: [
        jsx('div', { style: { fontWeight: 700 }, children: 'This game hit a problem and was closed.' }),
        jsx('div', { style: { fontSize: 13, color: text.secondary }, children: 'Your other games are fine. Go back to the list and open it again.' }),
        detail ? jsx('div', { style: { fontSize: 12, color: text.tertiary, overflowWrap: 'anywhere' }, children: detail }) : null,
        jsxs('div', {
          style: { display: 'flex', gap: 8, flexWrap: 'wrap' },
          children: [
            button('Back to games', reset, { primary: true }),
            this.props.onClose ? button('Close', () => { reset(); this.props.onClose() }) : null
          ]
        })
      ]
    })
  }
}
