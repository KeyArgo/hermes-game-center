// ---- 17-blackjack.js: Blackjack against the house dealer, with Jackpot wallet chips
// The contract the page relies on: BlackjackTable({ picture, interactive, busy, onMove,
// against }) where picture.view === 'blackjack' and onMove(token) sends one of
// picture.legal (bet10, bet25, bet50, bet100, hit, stand, double). The table never
// judges a move. `against` is who is across the felt - { who, why } from
// opponentWords() in 30-game-page.js ("vs Computer (the dealer)", "vs Hermes model: x")
// - drawn on the felt with the whole story on hover. It is words only: the table still
// never decides anything about the game.

// Card-game art only: these sit on the felt and the cards, never on chrome
// (which uses the host's theme tokens).
const BJ_FELT = '#0d4a32'
const BJ_FELT_LIGHT = '#12603f'
const BJ_FELT_EDGE = '#0a3a27'
const BJ_CARD_FACE = '#f8f5ec'
const BJ_CARD_EDGE = '#cfc8b8'
const BJ_CARD_RED = '#c0392b'
const BJ_CARD_BLACK = '#1d2733'
const BJ_CARD_BACK = '#1e3a5f'
const BJ_CARD_STRIPE = '#2b5378'
const BJ_CHIP = '#e3b341'
const BJ_CHIP_EDGE = '#a9822a'
const BJ_CHIP_TEXT = '#2b2410'
const BJ_SHADOW = 'rgba(0, 0, 0, 0.35)'

const BJ_SUITS = { S: '\u2660', H: '\u2665', D: '\u2666', C: '\u2663' }
const BJ_SUIT_NAMES = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' }

function bjCardLabel(card) {
  if (!card || card === '??') return 'Face-down card'
  const rank = String(card).slice(0, -1)
  const suit = String(card).slice(-1)
  return `${rank} of ${BJ_SUIT_NAMES[suit] || suit}`
}

function BJPlayingCard({ card, width }) {
  const size = width || 62
  const height = Math.round(size * 1.46)
  const hidden = !card || card === '??'
  if (hidden) {
    return jsx('div', {
      'aria-label': 'Face-down card',
      style: {
        width: size, height, borderRadius: 7, boxSizing: 'border-box',
        border: `2px solid ${BJ_CARD_EDGE}`, background: BJ_CARD_BACK,
        backgroundImage: `repeating-linear-gradient(45deg, ${BJ_CARD_STRIPE} 0 4px, transparent 4px 8px)`,
        boxShadow: `0 2px 5px ${BJ_SHADOW}`, flex: '0 0 auto'
      }
    }, 'back')
  }
  const rank = String(card).slice(0, -1)
  const suit = String(card).slice(-1)
  const red = suit === 'H' || suit === 'D'
  const ink = red ? BJ_CARD_RED : BJ_CARD_BLACK
  return jsxs('div', {
    'aria-label': bjCardLabel(card),
    style: {
      width: size, height, borderRadius: 7, boxSizing: 'border-box',
      border: `2px solid ${BJ_CARD_EDGE}`, background: BJ_CARD_FACE,
      boxShadow: `0 2px 5px ${BJ_SHADOW}`, position: 'relative',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flex: '0 0 auto', color: ink, fontFamily: 'var(--font-mono, monospace)'
    },
    children: [
      jsxs('span', {
        style: {
          position: 'absolute', top: 4, left: 6, display: 'flex',
          flexDirection: 'column', alignItems: 'center', lineHeight: 1
        },
        children: [
          jsx('span', { style: { fontSize: Math.round(size * 0.25), fontWeight: 800 }, children: rank }, 'rank'),
          jsx('span', { style: { fontSize: Math.round(size * 0.2) }, children: BJ_SUITS[suit] || suit }, 'suit')
        ]
      }, 'corner'),
      jsx('span', {
        'aria-hidden': true,
        style: { fontSize: Math.round(size * 0.5), opacity: 0.85 },
        children: BJ_SUITS[suit] || suit
      }, 'pip')
    ]
  }, card)
}

function BJCardRow({ cards, label, width }) {
  const shown = cards || []
  return jsxs('div', {
    'aria-label': label,
    style: { display: 'flex', gap: 8, flexWrap: 'wrap', minHeight: width ? Math.round(width * 1.46) : 92 },
    children: shown.length
      ? shown.map((card, index) => jsx(BJPlayingCard, { card, width }, `${card}-${index}`))
      : jsx('span', { style: { fontSize: 12, color: text.tertiary, alignSelf: 'center' }, children: 'No cards yet' })
  })
}

function bjButton(label, token, canPress, onMove, options = {}) {
  const disabled = !canPress(token)
  return jsx('button', {
    type: 'button',
    disabled,
    onClick: () => { if (!disabled) onMove(token) },
    title: options.title,
    style: {
      padding: options.chip ? '10px 14px' : '9px 16px',
      borderRadius: options.chip ? 999 : 8,
      border: `1px solid ${options.chip ? BJ_CHIP_EDGE : stroke}`,
      background: options.chip ? BJ_CHIP : (options.primary ? accent : 'transparent'),
      color: options.chip ? BJ_CHIP_TEXT : (options.primary ? 'var(--ui-text-on-accent, white)' : text.secondary),
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.45 : 1,
      fontSize: 13,
      fontWeight: 700
    },
    children: label
  }, token)
}

function BlackjackTable({ picture, interactive, busy, onMove, against }) {
  const legal = (picture && picture.legal) || []
  const phase = (picture && picture.phase) || 'bet'
  const hand = (picture && picture.hand) || []
  const dealer = (picture && picture.dealer) || []
  const status = (picture && picture.status) || ''
  const outcome = (picture && picture.outcome) || ''
  const bet = Number((picture && picture.bet) || 0)
  const chips = Number((picture && picture.chips) || 0)
  // The table stays open between hands: a finished hand is back in the bet phase with its
  // outcome set, so the result shows above the next bet's chips instead of ending the game.
  const won = Number((picture && picture.won) || 0)
  const over = Boolean(outcome)
  const canPress = token => Boolean(interactive) && !busy && legal.includes(token)
  // One sound per hand, keyed on the hand count so a poll or a re-render never replays it.
  const soundKey = picture ? `${Number(picture.hands || 0)}:${picture.outcome || ''}:${Number(picture.bet || 0)}` : ''
  const heard = useRef('')
  useEffect(() => {
    if (!soundKey || soundKey === heard.current) return
    const first = !heard.current
    heard.current = soundKey
    if (first) return
    if (picture.outcome === 'push') gamesSound('push')
    else if (picture.outcome === 'win' || picture.outcome === 'blackjack') gamesSound('win')
    else if (picture.outcome) gamesSound('lose')
    else gamesSound('deal')
  }, [soundKey])
  const result = (() => {
    if (!over) return ''
    if (outcome === 'blackjack') return `Blackjack! +${won}`
    if (outcome === 'win') return `You win +${won}`
    if (outcome === 'push') return 'Push — your bet comes back'
    if (outcome === 'bust') return `Bust ${won}`
    return `Dealer wins ${won}`
  })()
  const phaseLine = over
    ? `${result} · place your next bet, or leave the table`
    : phase === 'bet'
      ? 'Place your bet'
      : 'Your move: hit, stand or double'
  const betTokens = ((picture && picture.bets) || [10, 25, 50, 100, 500, 1000]).map(amount => `bet${amount}`)
  return jsxs('div', {
    'data-blackjack': 'table',
    'data-blackjack-phase': phase,
    style: {
      display: 'flex', flexDirection: 'column', gap: 14, width: '100%', maxWidth: 760,
      padding: 18, boxSizing: 'border-box', borderRadius: 18,
      border: `1px solid ${stroke}`,
      background: `radial-gradient(ellipse at 50% 18%, ${BJ_FELT_LIGHT}, ${BJ_FELT} 62%, ${BJ_FELT_EDGE})`,
      color: text.primary, boxShadow: `inset 0 0 40px ${BJ_SHADOW}`
    },
    children: [
      jsxs('div', {
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
        children: [
          jsxs('div', {
            children: [
              jsx('div', { style: { fontSize: 16, fontWeight: 800, letterSpacing: 0.3 }, children: 'Blackjack' }, 'title'),
              // Who is across the felt, on the felt (owner's ask 2026-11-10): a table
              // that names nobody leaves a person unable to tell whether their own
              // model is the one playing the dealer's cards.
              against
                ? jsx('div', {
                    'data-gm-vs': against.kind || 'blackjack',
                    title: against.why,
                    'aria-label': `${against.who}. ${against.why}`,
                    style: { fontSize: 12, fontWeight: 650, color: 'rgba(248, 245, 236, 0.82)', marginTop: 2, overflowWrap: 'anywhere' },
                    children: against.who
                  }, 'against')
                : null
            ]
          }, 'title-block'),
          jsxs('div', {
            'aria-label': 'Chips',
            style: { display: 'flex', gap: 12, fontSize: 12, fontFamily: 'var(--font-mono, monospace)', color: text.secondary },
            children: [
              jsx('span', { children: `Chips ${chips}` }, 'chips'),
              jsx('span', { children: `Bet ${bet}` }, 'bet')
            ]
          }, 'wallet')
        ]
      }, 'header'),
      jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 6 },
        children: [
          jsx('div', { style: { fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', color: text.tertiary }, children: 'Dealer' }, 'dealer-label'),
          jsx(BJCardRow, { cards: dealer, label: 'Dealer cards' }, 'dealer'),
          jsx('div', { style: { fontSize: 13, fontWeight: 700, color: text.secondary }, children: `Dealer shows ${Number((picture && picture.dealer_total) || 0)}` }, 'dealer-total')
        ]
      }, 'dealer-seat'),
      jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 6 },
        children: [
          jsx('div', { style: { fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', color: text.tertiary }, children: 'You' }, 'you-label'),
          jsx(BJCardRow, { cards: hand, label: 'Your cards' }, 'hand'),
          jsx('div', { style: { fontSize: 13, fontWeight: 700, color: text.secondary }, children: `Your total ${Number((picture && picture.player_total) || 0)}` }, 'player-total')
        ]
      }, 'player-seat'),
      jsxs('div', {
        role: 'status',
        'aria-live': 'polite',
        style: {
          fontSize: 15, fontWeight: 800, padding: '8px 12px', borderRadius: 10,
          background: over ? (outcome === 'win' || outcome === 'blackjack' ? 'rgba(227,179,65,0.18)' : fill) : 'transparent',
          border: `1px solid ${over ? accent : stroke}`,
          color: over ? text.primary : text.secondary
        },
        children: [
          jsx('div', { children: phaseLine }, 'line'),
          picture && picture.note
            ? jsx('div', { style: { fontSize: 12, fontWeight: 500, color: text.tertiary, marginTop: 3 }, children: picture.note }, 'note')
            : null
        ]
      }, 'result'),
      phase === 'bet'
        ? jsxs('div', {
            'aria-label': 'Bet chips',
            style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
            children: [
              jsx('span', { style: { fontSize: 12, color: text.tertiary }, children: 'Bet chips:' }, 'label'),
              ...betTokens.map(token => jsx('span', {
                children: bjButton(`Bet ${token.slice(3)}`, token, canPress, onMove, { chip: true })
              }, token))
            ]
          }, 'bets')
        : null,
      phase === 'play' && !over
        ? jsxs('div', {
            'aria-label': 'Blackjack moves',
            style: { display: 'flex', gap: 8, flexWrap: 'wrap' },
            children: [
              bjButton('Hit', 'hit', canPress, onMove, { primary: true }),
              bjButton('Stand', 'stand', canPress, onMove),
              bjButton('Double', 'double', canPress, onMove)
            ]
          }, 'moves')
        : null
    ]
  })
}
