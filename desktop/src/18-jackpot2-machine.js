// ---- 18-jackpot2-machine.js: JACKPOT v2, the second cabinet, drawn from scratch
//
// A different machine from the Slots table's (18-slot-machine.js), not a reskin of it. It shares
// three things with the old one: the shelf's routes (GET /jackpot, POST /jackpot/spin - the route the
// old overlay spins with - /jackpot/autoplay, /jackpot/autobet, /jackpot/machine and /jackpot/cashin,
// so no new route and no new server work); the recorded sounds behind gamesSound() (07-sound.js /
// 08-slot-samples.js), so the mute switch and the master volume are the existing ones; and the
// picture symbols in SM_ART (18-slot-art.js), so the Nous stamp and the wing are the shipped artwork
// rather than a second copy of it.
//
// One fixed size: the cabinet is always 560x720 CSS pixels, and every caller scales that box with a
// CSS transform rather than resizing the drawing. In 'overlay' mode the caller does all the measuring
// (the layer owns those numbers). In 'full' mode the cabinet fits the element it is MOUNTED IN - the
// Games column, the play-while-you-wait pane, a test frame - and never the window: the same machine
// is mounted in a 400 px pane and a 1400 px page, and the frame around it is what must not clip it.
// window.__jp2 carries the test handle: { spinning } is true while the reels are travelling, and
// width/height/mode are published beside it so a harness can compute a fit without a laid-out DOM.
//
// Every effect here is driven by the result the shelf sends; nothing in this file decides an outcome.
// The reels run down under a motion blur (a filter plus a small vertical stretch) and each stops on
// its own beat with an overshoot curve and a landing bounce; a near miss (two of the shown symbols
// agree, the last one does not) runs the last reel much longer under a signal-coloured rim, with slow
// ticks so the wait is audible; a win lights its payline with a glow and a pulse, spills coins and
// counts the chips up; the payout climbs a tier ladder - the same chip steps the old machine uses,
// named BIG / MEGA / JACKPOT as it goes - and the banner grows with it, while a big one flashes the
// cabinet and sets the lights blinking; the lever kicks, the SPIN button sinks under the finger, and
// the bulbs chase around the cabinet. prefers-reduced-motion turns every animation off and lands the
// reels at once: the invite to spin, the win and the payline are still shown, they simply do not move.
//
// THE SCREEN DOES NOT QUOTE ODDS. The win chance and the return are still drawn by the shelf and still
// paid by it, exactly as before — this cabinet prints neither number. The over-chat switch is in this
// panel too, beside Auto-spin/Auto-bet; 19-jackpot2-layer.js owns the switch itself, so every surface
// shows the same one.

const JP2_W = 560
const JP2_H = 720
// The futuristic cabinet: dark navy with ion, signal and violet as the only accents.
const JP2_NAVY = '#070b14'
const JP2_ION = '#3ee0c5'
const JP2_SIGNAL = '#ff5d73'
const JP2_VIOLET = '#a99bff'
const JP2_INK = '#e8f4ff'
const JP2_DIM = '#8ea3bf'
// Coins are metal, not a theme colour; this one is only ever used for the pieces in the tray.
const JP2_COIN = '#ffd166'
const JP2_WINDOW_W = 440
// The copy of the strip the reels rest on: the same home-copy scheme the old machine uses, so the
// strips, the stops and the drawn repeats line up the same way.
const JP2_BASE_COPY = 4
const JP2_RUN_MS = [940, 1160, 1380]
const JP2_NEARMISS_MS = 2600
const JP2_KICK_MS = 150
const JP2_STAGGER_MS = 160
const JP2_LINE_MS = 430
const JP2_LINE_COLOURS = [JP2_ION, JP2_VIOLET, JP2_SIGNAL, JP2_ION, JP2_VIOLET]
// The win ladder. The chip steps are the existing ones (10, 50, 100, 200, 400, 500, 1000, 10000 -
// the same numbers the table's tiers climb), and the names escalate to BIG / MEGA / JACKPOT. A
// payout climbs to the highest step it reaches; the step decides how long the machine carries on,
// how many coins fall, and whether the alarm goes off. Nothing here changes an outcome.
const JP2_TIERS = [
  { chips: 10, name: 'CHING!', seconds: 2.2, rain: 12, coins: 5, alarm: 0 },
  { chips: 50, name: 'NICE!', seconds: 2.8, rain: 18, coins: 8, alarm: 0 },
  { chips: 100, name: 'BIG', seconds: 3.6, rain: 26, coins: 12, alarm: 0 },
  { chips: 200, name: 'BIG', seconds: 4.4, rain: 32, coins: 16, alarm: 0 },
  { chips: 400, name: 'BIG', seconds: 5.2, rain: 38, coins: 20, alarm: 0 },
  { chips: 500, name: 'MEGA', seconds: 6.4, rain: 46, coins: 24, alarm: 2 },
  { chips: 1000, name: 'MEGA', seconds: 8.4, rain: 56, coins: 32, alarm: 4 },
  { chips: 10000, name: 'JACKPOT', seconds: 16, rain: 90, coins: 54, alarm: 8 }
]

// The two sentences the cabinet carries, in one place each so the line, the tooltip and the tests
// quote the same words.
const JP2_AUTOSPIN_NOTE = 'Spins by itself while Hermes is thinking or using tools. Your points rack '
  + 'up from the tokens you spend (1 point per 100,000 tokens) and from games you win.'
const JP2_POINTS_NOTE = 'Points are your ranking. Cash some in for chips when you run low - it lowers '
  + 'your ranking.'

function jp2TierFor(payout) {
  const chips = Math.max(0, Number(payout) || 0)
  let tier = JP2_TIERS[0]
  for (const step of JP2_TIERS) if (chips >= step.chips) tier = step
  return tier
}

// The test handle. `spinning` is the documented key; the size and the mode ride along so a harness
// can work out a fit without a browser laying anything out.
const JP2_STATUS = { spinning: false, width: JP2_W, height: JP2_H, mode: '', ready: false }
try {
  if (typeof window !== 'undefined' && window) window.__jp2 = JP2_STATUS
} catch {
  // A sandbox with no window simply keeps the handle to itself.
}

function jp2Publish(patch) {
  const fields = patch || {}
  Object.keys(fields).forEach(key => { JP2_STATUS[key] = fields[key] })
  try {
    if (typeof window !== 'undefined' && window) window.__jp2 = JP2_STATUS
  } catch {
    // Nothing to publish to: the component still draws.
  }
  return JP2_STATUS
}

function jp2Spinning(on) {
  return jp2Publish({ spinning: !!on })
}

// The last good /jackpot answer, shared by every mounted cabinet: a second mount (the over-chat
// copy opening beside the Games page) opens with the real wallet and reels instead of an empty box.
let JP2_LAST = null

// ---- telling the shelf a cabinet is on screen -----------------------------------
// The automatic spin happens on the shelf's hook path - one spin for an inference reply, one for a
// tool call - and the shelf refuses it unless a machine says it is on screen. With this cabinet up and
// the original copy over the chat off (the usual case) the shelf used to refuse every hook, and the
// reels sat still through a whole conversation. The count is module-wide because one cabinet is mounted
// and unmounted per surface - the Games page, the play-while-you-wait pane and the over-chat copy -
// and what the shelf needs to know is whether ANY of them is drawn. 'jackpot2' is the name this
// surface reports under, so it cannot clear the original machine's own flag (or be cleared by it).
let JP2_VIEWERS = 0

async function jp2Visible(delta, ctx) {
  JP2_VIEWERS = Math.max(0, JP2_VIEWERS + Number(delta || 0))
  try {
    if (ctx && typeof ctx.rest === 'function') {
      await ctx.rest('/jackpot/visible', { method: 'POST', body: { on: JP2_VIEWERS > 0, source: 'jackpot2' } })
    }
  } catch (err) {
    // A report that did not arrive only means no automatic spin; nothing else waits on it.
  }
  return JP2_VIEWERS
}

// A paytable row is written as symbols separated by spaces ("NOUS NOUS NOUS", "🍒 🍒 –"): draw each
// one as the machine draws it on a reel, with the dashes as the blank stops they stand for.
function jp2Run(text, size, machine, winning) {
  const tokens = String(text || '').split(/\s+/).filter(Boolean)
  return tokens.map((token, index) => jsx('span', {
    key: `${token}-${index}`,
    style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', opacity: token === '–' ? 0.45 : 1 },
    children: token === '–' || token === '-' ? jsx('span', { style: { fontSize: Math.round(size * 0.5), color: JP2_DIM }, children: '–' })
      : jp2Symbol(token, size, machine, winning, true)
  }))
}

function jp2Style() {
  return `
@keyframes jp2-chase { 0%, 100% { opacity: .16; transform: scale(.82) } 50% { opacity: 1; transform: scale(1) } }
@keyframes jp2-blink { 0%, 49% { opacity: 1 } 50%, 100% { opacity: .12 } }
@keyframes jp2-bounce { 0% { transform: translateY(0) } 28% { transform: translateY(7px) scaleY(.975) } 58% { transform: translateY(-5px) scaleY(1.02) } 100% { transform: translateY(0) } }
@keyframes jp2-line { 0% { stroke-dashoffset: 70; opacity: .3 } 45% { opacity: 1 } 100% { stroke-dashoffset: 0; opacity: .6 } }
@keyframes jp2-cellwin { 0%, 100% { box-shadow: inset 0 0 0 1px rgba(62,224,197,.4), inset 0 0 20px rgba(62,224,197,.2) } 50% { box-shadow: inset 0 0 0 1px rgba(62,224,197,.95), inset 0 0 44px rgba(62,224,197,.5) } }
@keyframes jp2-coin { 0% { transform: translate(0, 0) rotate(0deg); opacity: 1 }
  55% { transform: translate(var(--jp2-dx), var(--jp2-up)) rotate(420deg); opacity: 1 }
  100% { transform: translate(calc(var(--jp2-dx) * 1.4), 60px) rotate(900deg); opacity: 0 } }
@keyframes jp2-rise { 0% { transform: translate(-50%, 8px); opacity: 0 } 18% { opacity: 1 } 100% { transform: translate(-50%, -74px); opacity: 0 } }
@keyframes jp2-banner { 0% { transform: scale(.5); opacity: 0 } 16% { transform: scale(1.14); opacity: 1 } 28% { transform: scale(1) } 78% { transform: scale(1.02); opacity: 1 } 100% { transform: scale(1.07); opacity: 0 } }
@keyframes jp2-flash { 0%, 100% { opacity: 0 } 14% { opacity: .7 } 30% { opacity: .05 } 46% { opacity: .6 } 64% { opacity: .04 } 80% { opacity: .42 } }
@keyframes jp2-scan { from { transform: translateY(-110%) } to { transform: translateY(210%) } }
@keyframes jp2-rim { 0%, 100% { opacity: .35 } 50% { opacity: 1 } }
@media (prefers-reduced-motion: reduce) { .jp2-machine, .jp2-machine * { animation: none !important; transition: none !important; } }
`
}

function jp2ReducedMotion() {
  try {
    return Boolean(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  } catch {
    return false
  }
}

function jp2Chips(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number).toLocaleString() : '0'
}

// The scale the FULL view takes to fit the element it is mounted in. Both directions are terms of a
// minimum, so the cabinet is never wider or taller than its frame - nothing is clipped in a short
// pane or a narrow column - and there is no upper floor: a small frame draws a small truthful copy
// rather than an oversized one with its bottom cut off. A frame with no measurable room (no layout
// yet) leaves the scale at 1, which the frame's own overflow makes visible.
function jp2FitScale(width, height) {
  const w = Number(width) > 0 ? Number(width) : 0
  const h = Number(height) > 0 ? Number(height) : 0
  const terms = []
  if (w > 0) terms.push(w / JP2_W)
  if (h > 0) terms.push(h / JP2_H)
  if (!terms.length) return 1
  return Math.max(0.05, Math.min.apply(null, terms))
}

// The footer note's own style. The reason a table cannot spin is part of the machine, not a tooltip.
function jp2NoteStyle() {
  return {
    display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap',
    fontSize: 11, color: JP2_DIM, pointerEvents: 'auto', maxWidth: '100%', overflowWrap: 'anywhere'
  }
}

// One reader for the machine, so every mount fails in the same, explainable way.
async function jp2Read(ctx) {
  if (!ctx || typeof ctx.rest !== 'function') throw new Error('this window has no shelf connection')
  return ctx.rest('/jackpot')
}

async function jp2Post(ctx, path, body) {
  if (!ctx || typeof ctx.rest !== 'function') throw new Error('this window has no shelf connection')
  return ctx.rest(path, body === undefined ? { method: 'POST' } : { method: 'POST', body })
}

function jp2Reason(err) {
  const raw = String((err && (err.message || err.error || err.detail)) || err || '').trim()
  if (!raw) return 'it did not answer'
  if (/404|not found|unknown (route|endpoint|method)/i.test(raw)) return 'the Game Center in this window is older than the shelf - restart Hermes'
  if (/timeout|timed out|abort/i.test(raw)) return 'it took too long to answer'
  if (/ECONNREFUSED|ENOTFOUND|offline|network/i.test(raw)) return 'the connection was refused'
  return raw.length > 130 ? `${raw.slice(0, 130)}...` : raw
}

// The shelf's own sound, at the shelf's own volume, behind the shelf's own mute switch. Wrapped
// because sound must never be the reason a cabinet fails to draw.
function jp2Sound(kind, options) {
  if (typeof gamesSound !== 'function') return
  try {
    gamesSound(kind, options)
  } catch {
    // Silence is the safe failure.
  }
}

// The symbol as this machine draws it: the machine's blank face instead of the internal blank stop.
function jp2Face(machine, symbol) {
  const blank = machine && machine.blank
  if (blank && symbol === blank) return (machine && machine.blank_face) || ''
  return symbol
}

// The shipped picture symbols, if this build has them loaded yet.
function jp2Art(face) {
  try {
    if (typeof SM_ART === 'undefined' || !SM_ART) return null
    return Object.prototype.hasOwnProperty.call(SM_ART, face) ? SM_ART[face] : null
  } catch {
    return null
  }
}

function jp2Symbol(symbol, size, machine, winning, reduced) {
  const face = jp2Face(machine, symbol)
  const art = jp2Art(face)
  if (art) {
    // The artwork is inked dark, so it sits on a pale disc - the same reasoning as the old machine's
    // plate: on a dark drum the drawn line reads as a smudge without it.
    return jsx('span', {
      'data-jp2-art': face,
      style: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: Math.round(size * 0.86), height: Math.round(size * 0.86), borderRadius: '50%',
        background: 'radial-gradient(circle at 38% 32%, #ffffff 0%, #eef6ff 55%, #c9d6e8 100%)',
        boxShadow: winning
          ? `0 0 0 2px ${JP2_ION}, 0 0 24px rgba(62,224,197,.9)`
          : '0 4px 10px rgba(0,0,0,.55), inset 0 0 0 1px rgba(7,11,20,.35)'
      },
      children: jsx('img', {
        src: art,
        alt: face === 'NOUS' ? 'Nous Research' : face === 'CADUCEUS' ? 'Caduceus' : 'Hermes wing',
        draggable: false,
        style: { width: Math.round(size * 0.64), height: Math.round(size * 0.64), objectFit: 'contain' }
      }, 'art')
    }, 'plate')
  }
  if (face === 'BAR') {
    return jsx('span', {
      style: {
        display: 'inline-block', padding: `${Math.round(size * 0.06)}px ${Math.round(size * 0.12)}px`,
        background: '#0b1220', color: JP2_INK, borderRadius: 4,
        border: `2px solid ${winning ? JP2_ION : 'rgba(169,155,255,.6)'}`,
        fontWeight: 900, fontSize: Math.round(size * 0.28), letterSpacing: 2, fontFamily: 'Georgia, serif',
        boxShadow: winning ? `0 0 18px rgba(62,224,197,.8)` : 'none'
      },
      children: 'BAR'
    }, 'bar')
  }
  if (face === '7') {
    return jsx('span', {
      style: {
        color: JP2_SIGNAL, fontWeight: 900, fontSize: Math.round(size * 0.66), lineHeight: 1,
        fontFamily: 'Georgia, serif', WebkitTextStroke: `1.5px rgba(255,209,102,.85)`,
        textShadow: winning ? `0 0 18px rgba(255,93,115,.95)` : '0 2px 0 rgba(0,0,0,.6)'
      },
      children: '7'
    }, 'seven')
  }
  return jsx('span', {
    style: { fontSize: Math.round(size * 0.5), lineHeight: 1, filter: winning ? `drop-shadow(0 0 10px ${JP2_ION})` : 'none' },
    children: face
  }, 'face')
}

// Where a reel's window sits for a stop: the stop is the middle row on a three-row machine.
function jp2TopIndex(stop, rows, size) {
  const offset = rows === 3 ? 1 : 0
  return (((Number(stop) - offset) % size) + size) % size
}

// A result's stop on one reel. The shelf sends stops; an answer that only carries the shown symbols
// has its stop found in the strip instead.
function jp2StopFor(result, machine, reel) {
  const strips = (machine && machine.strips) || []
  const strip = strips[reel] || []
  if (result && Array.isArray(result.stops) && result.stops.length === strips.length) return Number(result.stops[reel]) || 0
  const shown = (result && result.reels) || []
  const at = strip.indexOf(shown[reel])
  return at < 0 ? 0 : at
}

function jp2Targets(result, machine) {
  const strips = (machine && machine.strips) || []
  const rows = Number(machine && machine.rows) || 3
  return strips.map((strip, reel) => {
    const size = Math.max(1, strip.length)
    return JP2_BASE_COPY * size + jp2TopIndex(jp2StopFor(result, machine, reel), rows, size)
  })
}

function jp2Stamp(result) {
  if (!result) return ''
  return `${result.at || ''}|${(result.stops || []).join(',')}|${JSON.stringify(result.grid || result.reels || [])}`
}

// The symbols the machine is showing across the middle, whatever shape the answer came in.
function jp2Shown(result, machine) {
  if (!result) return []
  if (Array.isArray(result.reels) && result.reels.length) return result.reels.slice()
  const grid = Array.isArray(result.grid) ? result.grid : []
  const middle = grid[Math.floor(grid.length / 2)]
  return Array.isArray(middle) ? middle.slice() : []
}

// A near miss is the classic tease: everything but the last reel agrees, and the last one is one
// step away. The machine does not change the outcome - it only lets the last reel crawl.
function jp2NearMiss(result, machine) {
  const shown = jp2Shown(result, machine)
  if (shown.length < 2) return false
  const blank = machine && machine.blank
  const last = shown.length - 1
  const eyes = shown[0]
  if (eyes == null || eyes === '' || (blank && eyes === blank)) return false
  for (let reel = 0; reel < last; reel += 1) if (shown[reel] !== eyes) return false
  return shown[last] !== eyes
}

// ---- what it pays: the whole table, off the live paytable ------------------------
// Every symbol combination and what it pays at the bet on the table, generated from the pay table the
// shelf is playing rather than typed into the cabinet, so the card cannot drift from what the reels
// actually pay. It is drawn over the reels and scrolls inside
// itself: the cabinet is one fixed size and a panel may not push its rows out of it.
function jp2PaysPanel({ machine, paytable, bet, jackpotSymbol, onClose }) {
  const lines = (machine && machine.lines) || []
  const perLine = Math.max(1, Math.floor(Number(bet) || 0) / Math.max(1, lines.length || 1))
  const rows = (paytable || []).filter(row => row && row.symbol)
  const style = {
    position: 'absolute', inset: 10, zIndex: 9, pointerEvents: 'auto', overflow: 'auto',
    padding: '12px 14px', borderRadius: 12, boxSizing: 'border-box',
    background: 'rgba(5,8,15,.97)', border: `1px solid ${JP2_ION}`, boxShadow: '0 0 40px rgba(62,224,197,.35)'
  }
  const head = jsxs('div', {
    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 },
    children: [
      jsx('span', {
        style: { fontFamily: 'Georgia, serif', fontWeight: 900, fontSize: 15, letterSpacing: 1.6, color: JP2_ION },
        children: 'WHAT IT PAYS'
      }, 'title'),
      jsx('button', {
        type: 'button', 'data-jp2-pays-close': '1', 'aria-label': 'Close the pay table', onClick: onClose,
        style: {
          pointerEvents: 'auto', width: 26, height: 24, padding: 0, borderRadius: 7, cursor: 'pointer',
          background: 'rgba(9,14,26,.85)', border: '1px solid rgba(62,224,197,.4)', color: JP2_INK, fontSize: 14, lineHeight: 1
        },
        children: '×'
      }, 'close')
    ]
  })
  const body = rows.map((row, index) => {
    const jackpot = Boolean(jackpotSymbol) && String(row.symbol).split(/\s+/)[0] === jackpotSymbol
    return jsxs('div', {
      key: `row-${index}`,
      'data-jp2-pay-row': jackpot ? 'jackpot' : 'row',
      style: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        padding: '3px 6px', borderRadius: 8,
        background: jackpot ? 'rgba(62,224,197,.14)' : 'transparent',
        border: jackpot ? `1px solid rgba(62,224,197,.45)` : '1px solid transparent'
      },
      children: [
        jsxs('span', {
          style: { display: 'inline-flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' },
          children: [
            jsx('span', { style: { display: 'inline-flex', gap: 2 }, children: jp2Run(row.symbol, 20, machine, jackpot) }, 'run'),
            jackpot ? jsx('b', {
              style: { marginLeft: 6, fontSize: 9, letterSpacing: 1.4, color: JP2_SIGNAL },
              children: 'JACKPOT'
            }, 'tag') : null
          ]
        }, 'symbol'),
        jsx('span', {
          'data-jp2-pay-value': String(row.payout),
          style: {
            fontFamily: 'ui-monospace, monospace', fontWeight: 800, fontSize: 12,
            color: Number(row.payout) > 0 ? (jackpot ? JP2_ION : JP2_INK) : JP2_DIM, whiteSpace: 'nowrap'
          },
          children: Number(row.payout) > 0 ? `${jp2Chips(row.payout)} chips` : 'pays nothing'
        }, 'payout')
      ]
    }, `pay-${index}`)
  })
  const foot = jsxs('div', {
    style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10, lineHeight: 1.45, color: JP2_DIM },
    children: [
      jsx('span', {
        'data-jp2-pays-lines': '1',
        children: `${lines.length} line${lines.length === 1 ? '' : 's'}: ${lines.map(line => line.name).join(', ') || '—'}. `
          + `Each reads from the left, and the bet is split over them — ${jp2Chips(Math.round(perLine))} chips a line at the bet on the table.`
      }, 'lines'),
      jsx('span', {
        'data-jp2-pays-note': '1',
        children: 'Three of a symbol on a line pays the row; the short pays (one or two from the left) and the leading '
          + 'symbols are listed with them. Chips are play money and never become anything else.'
      }, 'note')
    ]
  })
  return jsxs('div', { 'data-jp2-pays': '1', style, children: [head, ...body, foot] }, 'pays')
}

function JackpotMachine(props) {
  const settings = props || {}
  const ctx = settings.ctx
  const mode = settings.mode === 'overlay' ? 'overlay' : 'full'
  // Over the chat the machine is to WATCH: nothing on it takes a click or a key
  // except the sound switch (the X and the look controls live in the layer). The pane and the Games
  // page draw this same machine in 'full' mode and play exactly as before.
  const watch = mode === 'overlay'
  const act = handler => (watch ? undefined : handler)
  const reduced = jp2ReducedMotion()
  const [data, setData] = useState(JP2_LAST)
  const [trouble, setTrouble] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [cashBusy, setCashBusy] = useState(false)
  const [positions, setPositions] = useState([0, 0, 0])
  const [run, setRun] = useState([0, 0, 0])
  const [land, setLand] = useState([false, false, false])
  const [lit, setLit] = useState(0)
  const [shownWins, setShownWins] = useState([])
  const [coins, setCoins] = useState([])
  const [rise, setRise] = useState(null)
  const [banner, setBanner] = useState(null)
  const [flash, setFlash] = useState(false)
  const [near, setNear] = useState(false)
  const [shownChips, setShownChips] = useState(0)
  const [picked, setPicked] = useState('')
  const [autoplayLocal, setAutoplayLocal] = useState(null)
  const [autobetLocal, setAutobetLocal] = useState(null)
  const [soundOn, setSoundOn] = useState(() => (typeof gamesSoundOn === 'function' ? gamesSoundOn() : true))
  const [spinPress, setSpinPress] = useState(false)
  const [lever, setLever] = useState(false)
  const [cashFlash, setCashFlash] = useState('')
  // Whether the whole pay table is open over the reels, and how many points the person chose to turn
  // into chips. `pointsWanted` is null until the shelf's own answer says how many they hold: then it
  // starts at enough for the next spin, which is the amount a person low on chips actually wants.
  const [paysOpen, setPaysOpen] = useState(false)
  const [pointsWanted, setPointsWanted] = useState(null)
  const timers = useRef([])
  const seen = useRef('')
  const primed = useRef(false)
  const counting = useRef(null)
  const settled = useRef(0)
  const holding = useRef(false)
  const root = useRef(null)
  // The element the 'full' cabinet is mounted in, and the scale it takes to fit it.
  const fitBox = useRef(null)
  const [fit, setFit] = useState(1)

  const later = (fn, ms) => {
    const timer = setTimeout(fn, ms)
    timers.current.push(timer)
  }

  // ---- the shelf ----
  // One light poll for the wallet, the session and the latest spin. A failed read keeps the last
  // good picture and says why, and looks again a little later rather than hammering a dead shelf.
  useEffect(() => {
    let alive = true
    let timer = null
    let wait = 1500
    const load = async () => {
      try {
        const next = await jp2Read(ctx)
        if (!alive) return
        JP2_LAST = next
        setData(next)
        setTrouble('')
        wait = 1500
      } catch (err) {
        if (!alive) return
        setTrouble(jp2Reason(err))
        wait = Math.min(6000, Math.round(wait * 1.7))
      }
      if (alive) timer = setTimeout(load, wait)
    }
    load()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [ctx])

  useEffect(() => () => {
    timers.current.forEach(clearTimeout)
    timers.current = []
    if (counting.current) clearInterval(counting.current)
    // A cabinet leaving the screen is not spinning any more, whatever it was doing.
    jp2Spinning(false)
  }, [])

  useEffect(() => {
    jp2Publish({ mode, ready: true })
    return () => { jp2Publish({ ready: false }) }
  }, [mode])

  // This cabinet is on screen for as long as it is mounted, and the shelf spins on the hook path
  // while any surface says so. Without this report the automatic spin was refused on every reply and
  // every tool call while the cabinet was the only machine drawn.
  useEffect(() => {
    jp2Visible(1, ctx)
    return () => { jp2Visible(-1, ctx) }
  }, [ctx])

  // The full view measures the ELEMENT IT IS MOUNTED IN, not the window: the same cabinet is mounted
  // in the Games column, in the ~400 px play-while-you-wait pane and in a test frame, and it is the
  // frame around it that must not be clipped. Only 'full' does this - the over-chat layer owns its own
  // numbers, and two fits fighting each other is exactly the size slider that did nothing.
  useEffect(() => {
    if (mode !== 'full') return undefined
    const node = fitBox.current
    if (!node) return undefined
    const read = () => {
      // offsetWidth/offsetHeight, NOT getBoundingClientRect: a rect includes every ancestor's
      // transform, so inside a caller that already scales the cabinet - the Games page's full view
      // scales its stage - this fit would measure the SCALED box and scale the cabinet a second time.
      // Measured in a real browser: 1.14 x 1.14 = 1.30, and the machine hung 100 px out of
      // its frame. The layout box is what this fit is for and no transform touches it.
      const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null
      const width = node.offsetWidth || Number(rect && rect.width) || 0
      const height = node.offsetHeight || Number(rect && rect.height) || 0
      const scale = jp2FitScale(width, height)
      // Only redraw when the number actually moved: a ResizeObserver tick on every layout pass would
      // otherwise re-render the cabinet through every window drag.
      setFit(previous => (Math.abs(previous - scale) < 0.002 ? previous : scale))
    }
    read()
    let observer = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(read)
      observer.observe(node)
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('resize', read)
    }
    // The frame is not always laid out on the first paint (a pane mid-transition, a web font still
    // settling): measure again shortly, then leave it to the observer.
    const settles = [0, 120, 400, 1200].map(delay => setTimeout(read, delay))
    return () => {
      if (observer) observer.disconnect()
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('resize', read)
      }
      settles.forEach(clearTimeout)
    }
  }, [mode])

  const adopt = next => {
    if (!next || typeof next !== 'object') return
    JP2_LAST = next
    setData(next)
  }

  // ---- what the wallet says ----
  const machines = (data && data.machines) || []
  // A pick is optimistic only while it is in flight: once the shelf reports that machine, the
  // shelf's word governs, and a machine chosen elsewhere (the old table, the overlay) shows here too.
  const serverMachine = (data && data.machine) || ''
  const machineId = (picked && picked !== serverMachine ? picked : '') || serverMachine || (machines[0] && machines[0].id) || ''
  const machine = machines.find(item => item.id === machineId) || machines[0] || null
  const strips = (machine && machine.strips) || []
  const rows = Number(machine && machine.rows) || 3
  const reelCount = Math.max(3, strips.length)
  const chips = Number(data && data.chips) || 0
  const bet = Number(data && data.bet) || 0
  const reward = Number(data && data.reward) || 0
  const points = Number(data && data.bonus) || 0
  // The shelf's own words for the two switches, in one place so the displayed value and the "have we
  // heard back yet" check cannot drift apart.
  const serverAutobet = Boolean(!data || data.autobet !== false)
  const serverAutoplay = Boolean(data && data.autoplay)
  const autobet = autobetLocal == null ? serverAutobet : autobetLocal
  const autoplay = autoplayLocal == null ? serverAutoplay : autoplayLocal
  const feed = (data && data.feed) || []
  const newest = feed[0] || null
  const result = newest && machine && newest.machine === machine.id ? newest : null
  const canSpin = Boolean(ctx) && bet > 0 && chips >= bet
  const stake = bet || Number((data && data.bets && data.bets[0]) || 0) || 25
  // The points-to-chips rate comes off the shelf's own answer rather than a second copy typed into
  // the cabinet: 4 points buy 3 chips there, and whatever it says here is what the arithmetic uses.
  const pointsRate = (data && data.points_rate) || {}
  const pointsPerBlock = Math.max(1, Number(pointsRate.points) || 4)
  const chipsPerBlock = Math.max(0, Number(pointsRate.chips) || 3)
  const tokensPerPoint = Math.max(1, Number(pointsRate.tokens_per_point) || 100000)
  const chipsFor = value => Math.max(0, Math.floor(Math.max(0, Number(value) || 0) / pointsPerBlock)) * chipsPerBlock
  // The most the person may turn in, in whole blocks: the points under one block wait for the next
  // conversion, exactly as the wallet's own cash_points() does it.
  const pointsMax = Math.floor(points / pointsPerBlock) * pointsPerBlock
  const need = Math.max(0, stake - chips)
  const slice = pointsWanted == null
    ? Math.min(pointsMax, Math.ceil(need / Math.max(1, chipsPerBlock)) * pointsPerBlock)
    : Math.min(pointsMax, Math.max(0, Math.floor(pointsWanted / pointsPerBlock) * pointsPerBlock))
  const sliceChips = chipsFor(slice)
  const jackpotSymbol = (machine && machine.jackpot_symbol) || ''

  // Chips follow the shelf unless a win is being counted up on screen.
  useEffect(() => {
    if (counting.current || holding.current) return
    settled.current = chips
    setShownChips(chips)
  }, [chips])

  // A switch is optimistic under the finger. Once the shelf's own answer agrees with it, the shelf is
  // back in charge of what is shown - so a switch flipped on another screen (the old table, the
  // overlay) still moves this one, and a failed write cannot leave the box lying about the wallet.
  useEffect(() => {
    setAutoplayLocal(current => (current != null && current === serverAutoplay ? null : current))
  }, [serverAutoplay])
  useEffect(() => {
    setAutobetLocal(current => (current != null && current === serverAutobet ? null : current))
  }, [serverAutobet])

  const countUp = (from, to) => {
    if (counting.current) clearInterval(counting.current)
    if (reduced || to <= from) {
      setShownChips(to)
      settled.current = to
      holding.current = false
      return
    }
    const startedAt = Date.now()
    counting.current = setInterval(() => {
      const share = Math.min(1, (Date.now() - startedAt) / 900)
      setShownChips(Math.round(from + (to - from) * share))
      if (share >= 1) {
        clearInterval(counting.current)
        counting.current = null
        settled.current = to
        holding.current = false
      }
    }, 40)
  }

  // ---- the spin sequence ----
  // A new result - a manual pull, or one the shelf's own auto-spin recorded - runs the whole
  // mechanical sequence. An old one (a poll, a remount) only lands, so a repaint never re-spins.
  useEffect(() => {
    const stamp = jp2Stamp(result)
    // `primed` is about the mount, not about the result: a machine that opened with no spin in its
    // feed must still run its first pull, and one that opened on the shelf's last result must not
    // animate a spin that happened before it existed.
    const first = !primed.current
    primed.current = true
    if (!stamp || stamp === seen.current) return undefined
    seen.current = stamp
    timers.current.forEach(clearTimeout)
    timers.current = []
    setLit(0)
    setShownWins([])
    setCoins([])
    setRise(null)
    setBanner(null)
    setFlash(false)
    setNear(false)
    setLand([false, false, false])
    const targets = jp2Targets(result, machine)
    const count = targets.length
    const resting = targets.map(() => 0)
    jp2Spinning(false)
    // Nothing to run against yet: land where we are and leave the wallet alone.
    if (!count) {
      setRun(resting)
      return undefined
    }
    const stakes = Number(result && result.bet) || bet || 1
    const payout = Number(result && result.payout) || 0
    const wins = (result && result.wins) || []
    // A first paint (or a reduced-motion viewer) has no run to show: the reels are already on their
    // stops, and the win is lit without any motion.
    if (first) {
      setRun(resting)
      setPositions(targets)
      holding.current = false
      return undefined
    }
    const sizes = targets.map((_, reel) => Math.max(1, ((strips[reel] || []).length) || 1))
    const tease = !reduced && jp2NearMiss(result, machine)
    holding.current = true
    // 1. The kick: the lever drops and the drum is nudged up a fraction of a cell, so the pull is
    //    felt before the run.
    setLever(true)
    later(() => setLever(false), 430)
    jp2Sound('spin')
    setRun(targets.map(() => JP2_KICK_MS))
    setPositions(current => {
      const next = current.slice()
      for (let reel = 0; reel < count; reel += 1) next[reel] = (Number(next[reel]) || 0) - 0.35
      return next
    })
    jp2Spinning(true)
    // 2. The run: each reel starts a beat after the one before it, travels two-plus turns and lands
    //    on its own stop. The last reel crawls when the first two agree - the near miss.
    const landAt = targets.map((target, reel) => {
      const isLast = reel === count - 1
      const duration = tease && isLast ? JP2_NEARMISS_MS : JP2_RUN_MS[Math.min(reel, JP2_RUN_MS.length - 1)]
      const start = JP2_KICK_MS + reel * JP2_STAGGER_MS
      later(() => {
        if (tease && isLast) setNear(true)
        setRun(previous => previous.map((value, index) => (index === reel ? duration : value)))
        setPositions(previous => previous.map((value, index) => (
          index === reel ? target + (2 + reel) * sizes[reel] : value
        )))
        jp2Sound('move')
        // The crawl is audible: a slow tick rather than silence, and never a win sound.
        if (tease && isLast) {
          for (let beat = 1; beat <= 3; beat += 1) later(() => jp2Sound('move'), Math.round((duration * beat) / 4))
        }
      }, start)
      later(() => {
        setRun(previous => previous.map((value, index) => (index === reel ? 0 : value)))
        // The bounce: the animation restarts on every landing because the name is removed between
        // them, which is what makes a second stop feel like a second stop.
        setLand(previous => previous.map((value, index) => (index === reel ? true : value)))
        if (isLast) { jp2Spinning(false); setNear(false) }
      }, start + duration)
      later(() => setLand(previous => previous.map((value, index) => (index === reel ? false : value))), start + duration + 420)
      return start + duration
    })
    const landedAt = landAt.length ? Math.max.apply(null, landAt) : JP2_KICK_MS
    // 3. Quietly home each reel onto its resting copy of the strip: the same picture, no motion.
    later(() => {
      setRun(targets.map(() => 0))
      setPositions(targets)
    }, landedAt + 150)
    // 4. The win: paylines light one by one, then the payout climbs its tier, the coins fall and the
    //    counter runs up to the chips the shelf already knows about.
    if (wins.length) {
      setShownWins(wins)
      wins.forEach((_, index) => later(() => {
        setLit(index + 1)
        jp2Sound('move')
      }, landedAt + 120 + index * JP2_LINE_MS))
      const paidAt = landedAt + 120 + wins.length * JP2_LINE_MS
      later(() => {
        const tier = jp2TierFor(payout)
        const jackpot = tier.name === 'JACKPOT'
        const scale = Math.max(0.5, Math.min(3, payout / Math.max(1, stakes)))
        jp2Sound(jackpot ? 'jackpot' : 'win', { scale })
        if (tier.alarm) jp2Sound('alarm', { times: tier.alarm })
        // The cabinet's own chime, and the coins: both grow with the tier.
        const dings = payout >= 10000 ? 24 : (payout >= 1000 ? 14 : (payout >= 500 ? 9 : (payout >= 100 ? 5 : 3)))
        jp2Sound('payout', { times: dings, rate: payout >= 1000 ? 0.12 : 0.16, scale })
        if (payout > 0) jp2Sound('ching', { times: tier.coins, seconds: tier.seconds * 0.9, scale })
        setBanner({ name: tier.name, payout, tier })
        if (tier.chips >= 500) setFlash(true)
        later(() => setBanner(null), Math.max(2400, Math.min(tier.seconds * 1000, 9000)))
        later(() => setFlash(false), 1800)
        setRise(`+${jp2Chips(payout)}`)
        later(() => setRise(null), 2600)
        if (!reduced) {
          // The shower is a fixed count taken at the moment of the win: recomputing it while the
          // counter runs would restart the animation on every render.
          const howMany = jackpot ? 64 : Math.min(40, 12 + Math.round(payout / 20))
          setCoins(Array.from({ length: howMany }, (_, index) => ({
            key: `${stamp}-${index}`,
            left: 8 + Math.random() * 84,
            dx: (Math.random() - 0.5) * 220,
            up: -(90 + Math.random() * 170),
            delay: Math.random() * 520,
            spin: 900 + Math.random() * 700
          })))
          later(() => setCoins([]), 3400)
        }
        const after = Number(result && result.chips) || settled.current + payout
        countUp(after - payout, after)
      }, paidAt)
    } else {
      later(() => {
        const after = Number(result && result.chips) || settled.current
        countUp(after, after)
      }, landedAt)
    }
    return undefined
  }, [jp2Stamp(result), machineId])

  // ---- the moves ----
  const spinNow = async () => {
    if (busy || watch) return
    if (!canSpin) {
      setTrouble(`Not enough chips: a spin costs ${jp2Chips(stake)}.`)
      return
    }
    setBusy(true)
    setNotice('')
    setTrouble('')
    try {
      const answer = await jp2Post(ctx, '/jackpot/spin')
      adopt(answer)
      const row = answer && (answer.spun || (answer.feed || [])[0])
      // The reels are run by the sequence above, from the result itself: one path for a pull and for
      // the shelf's own auto-spin, so the two can never drift apart.
      if (!row) setTrouble('The shelf did not send a spin result. Try again.')
    } catch (err) {
      setTrouble(`The spin did not go through: ${jp2Reason(err)}.`)
    } finally {
      setBusy(false)
    }
  }

  const setAutoplay = async on => {
    const previous = autoplay
    setAutoplayLocal(Boolean(on))
    setNotice('')
    try {
      const answer = await jp2Post(ctx, '/jackpot/autoplay', { on: Boolean(on) })
      adopt(answer)
      if (answer && typeof answer.autoplay === 'boolean') setAutoplayLocal(answer.autoplay)
      else {
        setAutoplayLocal(previous)
        setNotice('The shelf did not confirm the auto-spin switch. Try again.')
      }
    } catch (err) {
      setAutoplayLocal(previous)
      setNotice(`The shelf did not take that: ${jp2Reason(err)}.`)
    }
  }

  const setAutobet = async on => {
    const previous = autobet
    setAutobetLocal(Boolean(on))
    setNotice('')
    try {
      const answer = await jp2Post(ctx, '/jackpot/autobet', { on: Boolean(on) })
      adopt(answer)
      if (answer && typeof answer.autobet === 'boolean') setAutobetLocal(answer.autobet)
      else {
        setAutobetLocal(previous)
        setNotice('The shelf did not confirm the auto-bet switch. Try again.')
      }
    } catch (err) {
      setAutobetLocal(previous)
      setNotice(`The shelf did not take that: ${jp2Reason(err)}.`)
    }
  }

  const pickMachine = async id => {
    if (watch || !id || id === machineId) return
    setPicked(id)
    setNotice('')
    try {
      const answer = await jp2Post(ctx, '/jackpot/machine', { machine: id })
      adopt(answer)
      // Never leave the picker showing a machine the shelf did not take.
      if (!answer || answer.machine !== id) {
        setPicked('')
        setNotice('The shelf did not switch machine. Try again.')
      }
    } catch (err) {
      setPicked('')
      setNotice(`The shelf did not switch machine: ${jp2Reason(err)}.`)
    }
  }

  const cashIn = async () => {
    if (cashBusy || reward <= 0) return
    setCashBusy(true)
    setNotice('')
    try {
      const answer = await jp2Post(ctx, '/jackpot/cashin')
      adopt(answer)
      const cashed = Number(answer && answer.cashed) || 0
      if (cashed > 0) {
        setCashFlash(`+${jp2Chips(cashed)} chips`)
        later(() => setCashFlash(''), 2400)
        jp2Sound('cash')
      }
    } catch (err) {
      setNotice(`Could not cash in: ${jp2Reason(err)}.`)
    } finally {
      setCashBusy(false)
    }
  }

  // Points into chips: the door the wallet's own cash_points() is behind (/jackpot/points/cash), on
  // the same wallet. The amount is the person's choice - the control below sends the slice they
  // picked - and the rate is the shelf's own (pointsPerBlock points buy chipsPerBlock chips). The
  // dead-table row uses the same door for the one press that unblocks a spin.
  const cashPoints = async requested => {
    const want = Math.floor((Number(requested) || 0) / pointsPerBlock) * pointsPerBlock
    if (cashBusy || want < pointsPerBlock) return
    setCashBusy(true)
    setNotice('')
    try {
      const answer = await jp2Post(ctx, '/jackpot/points/cash', { points: want })
      // The route answers with the whole wallet beside the count it paid, so the chips on screen
      // follow the shelf's own arithmetic rather than this machine's guess at it.
      const cashed = Number(answer && (answer.points_cashed != null ? answer.points_cashed : answer.cashed)) || 0
      adopt(answer)
      if (cashed > 0) {
        setCashFlash(`+${jp2Chips(cashed)} chips`)
        later(() => setCashFlash(''), 2400)
        jp2Sound('cash')
      }
    } catch (err) {
      setNotice(`Could not turn points into chips: ${jp2Reason(err)}.`)
    } finally {
      setCashBusy(false)
    }
  }

  const toggleSound = () => {
    const next = !soundOn
    setSoundOn(next)
    if (typeof gamesSoundSet === 'function') {
      try { gamesSoundSet(next) } catch { /* nothing to save to */ }
    }
    if (next) jp2Sound('move')
  }

  // ---- drawing ----
  const cell = rows === 1 ? 208 : 104
  const windowH = cell * rows
  const reelW = Math.floor(JP2_WINDOW_W / reelCount)
  const windowW = reelW * reelCount
  const running = run.some(ms => Number(ms) > 0)
  const litCells = new Set()
  shownWins.slice(0, lit).forEach(win => ((win && win.rows) || []).forEach((row, reel) => litCells.add(`${row}-${reel}`)))
  const winLines = (machine && machine.lines) || []
  const paytable = (data && data.paytable) || []
  const lightsAlarm = Boolean(flash || (banner && banner.tier && banner.tier.chips >= 1000))
  const litLines = shownWins.slice(0, lit)

  const bulb = (key, delay, size) => jsx('span', {
    key,
    'data-jp2-bulb': key,
    'aria-hidden': true,
    style: {
      width: size, height: size, borderRadius: '50%',
      background: lightsAlarm ? JP2_SIGNAL : JP2_ION,
      boxShadow: lightsAlarm
        ? `0 0 ${size}px rgba(255,93,115,.95), 0 0 ${size * 2}px rgba(255,93,115,.4)`
        : `0 0 ${size}px rgba(62,224,197,.85), 0 0 ${size * 2}px rgba(62,224,197,.32)`,
      animation: reduced ? 'none' : (lightsAlarm
        ? 'jp2-blink 240ms steps(1) infinite'
        : `jp2-chase 1.5s ease-in-out ${delay}s infinite`)
    }
  })

  // Lights chase around the cabinet: top rail, side columns, bottom rail, each offset further along
  // the same 1.5 s beat so the run reads as a circuit rather than four separate rows.
  const railCount = 14
  const railTop = jsx('div', {
    'data-jp2-rail': 'top',
    'aria-hidden': true,
    style: { position: 'absolute', top: 7, left: 18, right: 18, display: 'flex', justifyContent: 'space-between' },
    children: Array.from({ length: railCount }, (_, index) => bulb(`t${index}`, (index / railCount) * 1.5, 7))
  })
  const railBottom = jsx('div', {
    'data-jp2-rail': 'bottom',
    'aria-hidden': true,
    style: { position: 'absolute', bottom: 7, left: 18, right: 18, display: 'flex', justifyContent: 'space-between' },
    children: Array.from({ length: railCount }, (_, index) => bulb(`b${index}`, 0.75 + (index / railCount) * 1.5, 7))
  })
  const sideRail = side => jsx('div', {
    'data-jp2-rail': side,
    'aria-hidden': true,
    style: {
      position: 'absolute', top: 44, bottom: 44, left: side === 'left' ? 7 : undefined, right: side === 'right' ? 7 : undefined,
      display: 'flex', flexDirection: 'column', justifyContent: 'space-between', alignItems: 'center'
    },
    children: Array.from({ length: 9 }, (_, index) => bulb(
      `${side}${index}`,
      (side === 'left' ? 0.35 : 1.1) + (index / 9) * 1.2,
      6
    ))
  })

  const reels = []
  for (let reel = 0; reel < reelCount; reel += 1) {
    const strip = strips[reel] && strips[reel].length ? strips[reel] : []
    const size = Math.max(1, strip.length)
    const cellsOf = []
    if (!strip.length) {
      // No session yet: dim placeholders rather than invented symbols - a machine that shows reels
      // the wallet is not playing would be lying about the game.
      for (let index = 0; index < rows; index += 1) cellsOf.push({ symbol: '·', key: `wait-${index}` })
    } else {
      const copies = JP2_BASE_COPY + (2 + reelCount) + 2
      for (let copy = 0; copy < copies; copy += 1) {
        strip.forEach((symbol, index) => cellsOf.push({ symbol, key: `${copy}-${index}` }))
      }
    }
    const position = strip.length ? (positions[reel] == null ? JP2_BASE_COPY * size : Number(positions[reel])) : 0
    const duration = Number(run[reel]) || 0
    const crawling = teaseOn(near, reel, reelCount)
    reels.push(jsx('div', {
      'data-jp2-reel': reel,
      'data-jp2-running': duration ? '1' : undefined,
      'data-jp2-near': crawling && running ? '1' : undefined,
      'data-jp2-cell': cell,
      style: {
        position: 'relative', width: reelW, height: windowH, overflow: 'hidden',
        background: 'linear-gradient(180deg, rgba(169,155,255,.12), rgba(7,11,20,.96) 42%, rgba(7,11,20,.99))',
        borderLeft: reel ? '1px solid rgba(62,224,197,.16)' : 'none',
        boxShadow: crawling && running ? `inset 0 0 0 1px ${JP2_SIGNAL}, inset 0 0 36px rgba(255,93,115,.34)` : 'none',
        transition: reduced ? 'none' : 'box-shadow 220ms linear'
      },
      children: [
        // Glass: a soft glare over the top of the drum and a scanline that drifts down it.
        jsx('span', {
          'aria-hidden': true,
          style: {
            position: 'absolute', left: 0, right: 0, top: 0, height: '34%', pointerEvents: 'none', zIndex: 2,
            background: 'linear-gradient(180deg, rgba(255,255,255,.12), rgba(255,255,255,0))'
          }
        }, 'glare'),
        jsx('span', {
          'aria-hidden': true,
          style: {
            position: 'absolute', left: 0, right: 0, top: 0, height: '30%', pointerEvents: 'none', zIndex: 2,
            background: 'linear-gradient(180deg, rgba(62,224,197,0), rgba(62,224,197,.10), rgba(62,224,197,0))',
            animation: reduced ? 'none' : 'jp2-scan 5.6s linear infinite'
          }
        }, 'scan'),
        jsx('div', {
          // The landing bounce lives on a wrapper, so the strip inside keeps a plain translate.
          style: {
            position: 'absolute', inset: 0,
            animation: !reduced && land[reel] ? 'jp2-bounce 360ms cubic-bezier(.3,1.6,.5,1)' : 'none'
          },
          children: jsx('div', {
            style: {
              position: 'absolute', left: 0, right: 0, top: 0,
              transform: `translateY(${-position * cell}px)${duration > JP2_KICK_MS && !reduced ? ' scaleY(1.05)' : ''}`,
              transformOrigin: '50% 50%',
              transition: duration && !reduced ? `transform ${duration}ms cubic-bezier(.16,.9,.24,1.04)` : 'none',
              // Motion blur: a fast reel smears, a landed one reads clean.
              filter: duration > JP2_KICK_MS && !reduced ? 'blur(2.6px)' : 'none',
              willChange: 'transform'
            },
            children: cellsOf.map((item, index) => {
              const row = index - Math.round(position)
              const winning = strip.length > 0 && row >= 0 && row < rows && litCells.has(`${row}-${reel}`)
              return jsx('div', {
                style: {
                  height: cell, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: winning ? 'radial-gradient(circle at 50% 50%, rgba(62,224,197,.28), rgba(62,224,197,.06) 70%)' : 'transparent',
                  animation: winning && !reduced ? 'jp2-cellwin 620ms ease-in-out infinite' : 'none'
                },
                children: jp2Symbol(item.symbol, cell * (rows === 1 ? 0.5 : 0.66), machine, winning, reduced)
              }, item.key)
            })
          }, 'strip')
        }, 'bounce')
      ]
    }, `reel-${reel}`))
  }

  // The paylines: drawn from the session's own line shapes, lit one at a time with a glow.
  const winSvg = jsx('svg', {
    'data-jp2-lines': String(lit),
    width: windowW, height: windowH, viewBox: `0 0 ${windowW} ${windowH}`,
    style: { position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex: 3 },
    children: litLines.map((win, index) => {
      const shape = winLines[Number(win && win.line)] || {}
      const map = (win && win.rows) || shape.rows || []
      const colour = JP2_LINE_COLOURS[index % JP2_LINE_COLOURS.length]
      return jsx('polyline', {
        points: map.map((row, reel) => `${reel * reelW + reelW / 2},${row * cell + cell / 2}`).join(' '),
        fill: 'none', stroke: colour, strokeWidth: 3, strokeLinecap: 'round', strokeLinejoin: 'round',
        opacity: 0.75, strokeDasharray: '7 5', mixBlendMode: 'screen',
        style: {
          filter: `drop-shadow(0 0 5px ${colour})`,
          animation: reduced ? 'none' : 'jp2-line 900ms ease-out alternate infinite'
        }
      }, `line-${index}`)
    })
  })

  const bannerEl = banner ? jsx('div', {
    'data-jp2-banner': banner.name,
    'data-jp2-tier': String(banner.tier.chips),
    role: 'status',
    'aria-live': 'assertive',
    style: {
      position: 'absolute', inset: 0, zIndex: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
      pointerEvents: 'none',
      background: 'radial-gradient(circle at 50% 45%, rgba(7,11,20,.72), rgba(7,11,20,.28) 70%)'
    },
    children: jsx('div', {
      style: {
        textAlign: 'center',
        animation: reduced ? 'none' : `jp2-banner ${Math.max(2400, Math.min(banner.tier.seconds * 1000, 9000))}ms ease-out forwards`
      },
      children: [
        jsx('div', {
          style: {
            fontFamily: 'Georgia, serif', fontWeight: 900, letterSpacing: banner.name === 'JACKPOT' ? 8 : 4,
            fontSize: banner.tier.chips >= 10000 ? 56 : (banner.tier.chips >= 500 ? 44 : 34),
            color: banner.name === 'JACKPOT' ? JP2_SIGNAL : JP2_ION,
            textShadow: `0 0 30px rgba(62,224,197,.9), 0 4px 0 rgba(7,11,20,.9)`
          },
          children: banner.name
        }, 'name'),
        jsx('div', {
          style: { marginTop: 6, fontWeight: 900, fontSize: 20, color: JP2_INK, textShadow: '0 2px 10px rgba(0,0,0,.8)' },
          children: `+${jp2Chips(banner.payout)} chips`
        }, 'payout')
      ]
    }, 'banner-body')
  }, 'banner') : null

  const windowBox = jsx('div', {
    'data-jp2-window': '1',
    style: {
      position: 'relative', width: windowW, height: windowH, margin: '0 auto', display: 'flex',
      borderRadius: 12, overflow: 'hidden', background: JP2_NAVY,
      border: `1px solid rgba(62,224,197,${flash ? 0.55 : 0.24})`,
      boxShadow: `inset 0 10px 34px rgba(0,0,0,.78), 0 0 44px rgba(62,224,197,${flash ? 0.4 : 0.12})`,
      transition: reduced ? 'none' : 'box-shadow 240ms linear, border-color 240ms linear'
    },
    children: [
      ...reels,
      winSvg,
      // The glass over the whole window: shade top and bottom so the drum reads as being behind one.
      jsx('span', {
        'aria-hidden': true,
        style: {
          position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 4,
          background: 'linear-gradient(180deg, rgba(0,0,0,.5) 0%, rgba(0,0,0,0) 24%, rgba(255,255,255,.07) 50%, rgba(0,0,0,0) 76%, rgba(0,0,0,.5) 100%)'
        }
      }, 'glass'),
      rise ? jsx('div', {
        'data-jp2-rise': '1',
        style: {
          position: 'absolute', left: '50%', bottom: 18, zIndex: 5, pointerEvents: 'none', whiteSpace: 'nowrap',
          fontWeight: 900, fontSize: 26, color: JP2_COIN, textShadow: `0 2px 8px rgba(0,0,0,.85), 0 0 18px ${JP2_COIN}`,
          animation: reduced ? 'none' : 'jp2-rise 2.4s ease-out forwards'
        },
        children: rise
      }, 'rise') : null,
      bannerEl,
      // What it pays, opened from the header and drawn over the reels: it scrolls inside itself, so a
      // long table never pushes a row of the cabinet out of the cabinet.
      paysOpen && paytable.length ? jp2PaysPanel({
        machine, paytable, bet, jackpotSymbol, onClose: () => setPaysOpen(false)
      }) : null
    ]
  })

  const counter = (label, value, key) => jsx('div', {
    key,
    'data-jp2-counter': label,
    style: {
      flex: '1 1 0', minWidth: 0, padding: '6px 10px', borderRadius: 10,
      background: 'linear-gradient(180deg, rgba(169,155,255,.14), rgba(7,11,20,.9))',
      border: '1px solid rgba(169,155,255,.24)', boxShadow: 'inset 0 0 22px rgba(169,155,255,.08)'
    },
    children: [
      jsx('span', {
        style: { display: 'block', fontSize: 10, letterSpacing: 1.6, textTransform: 'uppercase', color: JP2_DIM },
        children: label
      }, 'label'),
      jsx('span', {
        style: {
          display: 'block', marginTop: 2, fontFamily: 'ui-monospace, monospace', fontSize: 18, fontWeight: 800,
          color: JP2_ION, textShadow: '0 0 14px rgba(62,224,197,.45)'
        },
        children: value
      }, 'value')
    ]
  })

  const toggle = (key, label, checked, onChange, title) => jsx('label', {
    key,
    'data-jp2-toggle': key,
    title,
    style: {
      display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: JP2_INK,
      cursor: watch ? 'default' : 'pointer', pointerEvents: watch ? 'none' : 'auto', whiteSpace: 'nowrap'
    },
    children: [
      jsx('input', {
        type: 'checkbox', checked: Boolean(checked),
        onChange: event => { if (!watch) onChange(event.target.checked) }, disabled: watch, tabIndex: watch ? -1 : undefined,
        style: { accentColor: JP2_ION, cursor: 'pointer' }
      }, 'box'),
      jsx('span', { children: label }, 'text')
    ]
  })

  const spinDisabled = busy || running || !canSpin
  const spinButton = jsx('button', {
    type: 'button',
    'data-jp2-spin': '1',
    disabled: spinDisabled,
    onClick: act(spinNow), tabIndex: watch ? -1 : undefined, 'aria-disabled': watch || undefined,
    onMouseDown: () => setSpinPress(true),
    onMouseUp: () => setSpinPress(false),
    onMouseLeave: () => setSpinPress(false),
    title: canSpin ? 'Spin the reels' : `A spin costs ${jp2Chips(stake)} chips.`,
    'aria-label': `Spin the reels, ${jp2Chips(bet)} chips`,
    style: {
      pointerEvents: 'auto',
      width: 232, height: 54, borderRadius: 16, border: `1px solid rgba(62,224,197,.75)`,
      fontFamily: 'inherit', fontWeight: 900, fontSize: 19, letterSpacing: 3, cursor: spinDisabled ? 'default' : 'pointer',
      color: spinDisabled ? 'rgba(232,244,255,.55)' : '#04211c',
      background: spinDisabled
        ? 'linear-gradient(180deg, rgba(62,224,197,.18), rgba(7,11,20,.9))'
        : 'linear-gradient(180deg, #8df6e4, #3ee0c5 55%, #17a58e)',
      boxShadow: spinDisabled
        ? 'inset 0 0 24px rgba(0,0,0,.5)'
        : `0 ${spinPress ? 2 : 6}px 0 #0d6b5b, 0 0 34px rgba(62,224,197,.35)`,
      transform: spinPress && !spinDisabled ? 'translateY(4px)' : 'none',
      transition: reduced ? 'none' : 'transform 90ms ease-out, box-shadow 90ms ease-out'
    },
    children: `SPIN · ${jp2Chips(bet)}`
  })

  // The lever: it kicks on a spin, it is also a way to spin, and it releases with an overshoot.
  const leverEl = jsx('button', {
    type: 'button',
    'data-jp2-lever': '1',
    'aria-label': 'Pull the lever',
    onClick: act(spinNow), tabIndex: watch ? -1 : undefined, 'aria-disabled': watch || undefined,
    disabled: spinDisabled,
    style: {
      position: 'absolute', right: 34, top: 150, width: 20, height: 300, zIndex: 4, padding: 0,
      border: 'none', background: 'transparent', pointerEvents: 'auto', cursor: spinDisabled ? 'default' : 'pointer'
    },
    children: [
      jsx('span', {
        style: {
          position: 'absolute', left: 7, top: 0, width: 6, height: 210, borderRadius: 3,
          background: 'linear-gradient(180deg, #cfe9f5 0%, #7d93a8 45%, #b9d3e2 55%, #566b7d 100%)',
          transformOrigin: '50% 100%',
          transform: lever ? 'rotateX(150deg) translateY(-6px) scaleY(.28)' : 'none',
          transition: reduced ? 'none' : (lever ? 'transform 170ms ease-in' : 'transform 430ms cubic-bezier(.3,1.6,.5,1)')
        }
      }, 'arm'),
      jsx('span', {
        style: {
          position: 'absolute', left: -3, top: -20, width: 26, height: 26, borderRadius: '50%',
          background: `radial-gradient(circle at 35% 32%, ${JP2_VIOLET}, #6d5ad6 70%)`,
          boxShadow: `0 0 18px rgba(169,155,255,.75), inset 0 2px 4px rgba(255,255,255,.35)`
        }
      }, 'knob'),
      jsx('span', {
        style: {
          position: 'absolute', left: 0, bottom: 0, width: 20, height: 16, borderRadius: 5,
          background: 'linear-gradient(180deg, #cfe9f5, #566b7d)'
        }
      }, 'base')
    ]
  }, 'lever')

  const coinLayer = jsx('div', {
    'data-jp2-coins': String(coins.length),
    'aria-hidden': true,
    style: { position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 7 },
    children: coins.map(coin => jsx('span', {
      style: {
        position: 'absolute', left: `${coin.left}%`, top: 300, width: 16, height: 16, borderRadius: '50%',
        background: `radial-gradient(circle at 35% 30%, #fff6d6, ${JP2_COIN} 45%, #a1741f 100%)`,
        border: '1px solid rgba(126,86,10,.85)', '--jp2-dx': `${coin.dx}px`, '--jp2-up': `${coin.up}px`,
        animation: reduced ? 'none' : `jp2-coin ${coin.spin}ms cubic-bezier(.2,.6,.4,1) ${coin.delay}ms both`
      }
    }, coin.key))
  }, 'coins')

  const flashLayer = flash ? jsx('span', {
    'data-jp2-flash': banner && banner.tier.chips >= 10000 ? 'jackpot' : 'mega',
    'aria-hidden': true,
    style: {
      position: 'absolute', inset: 0, zIndex: 8, pointerEvents: 'none',
      background: 'radial-gradient(circle at 50% 40%, rgba(62,224,197,.5), rgba(169,155,255,.16) 55%, rgba(0,0,0,0) 78%)',
      animation: reduced ? 'none' : `jp2-flash ${banner && banner.tier.chips >= 10000 ? 0.9 : 0.7}s ease-out 2`
    }
  }, 'flash') : null

  // The machine does not quote a win chance and does not quote a return. Both are still drawn by the shelf and still paid by it — the shelf's own tests pin the
  // numbers — the screen simply never prints them. `winText` is a result, not an odds figure, so it
  // stays.
  const winText = result && Number(result.payout) > 0
    ? `Last spin won ${jp2Chips(result.payout)} chips`
    : 'No win on the last spin'

  const cabinet = jsx('div', {
    className: 'jp2-machine',
    ref: root,
    'data-jp2': 'machine',
    'data-jp2-mode': mode,
    'data-jp2-size': `${JP2_W}x${JP2_H}`,
    'data-jp2-spinning': running ? '1' : '0',
    'data-jp2-machine': (machine && machine.id) || '',
    'data-jp2-chips': String(chips),
    role: 'group',
    'aria-label': 'Jackpot slot machine',
    style: {
      position: 'relative', width: JP2_W, height: JP2_H, boxSizing: 'border-box', overflow: 'hidden',
      borderRadius: 22, color: JP2_INK,
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
      background: mode === 'overlay' ? 'rgba(27, 51, 68, .6)' : `radial-gradient(120% 90% at 50% -12%, rgba(169,155,255,.18), rgba(7,11,20,0) 62%),
        radial-gradient(90% 60% at 50% 112%, rgba(62,224,197,.12), rgba(7,11,20,0) 60%),
        linear-gradient(180deg, #0a1020 0%, ${JP2_NAVY} 45%, #05080f 100%)`,
      backdropFilter: mode === 'overlay' ? 'blur(10px)' : undefined,
      textShadow: mode === 'overlay' ? '0 1px 4px rgba(0,0,0,.8)' : undefined,
      border: `1px solid rgba(62,224,197,${flash ? 0.72 : 0.28})`,
      boxShadow: `inset 0 0 0 1px rgba(255,255,255,.05), inset 0 0 90px rgba(169,155,255,.08),
        0 18px 60px rgba(2,4,10,.8), 0 0 ${flash ? 90 : 60}px rgba(62,224,197,${flash ? 0.42 : 0.16})`,
      // In the over-chat layer the cabinet must not swallow the conversation: the frame is inert and
      // only the controls below opt back in.
      pointerEvents: mode === 'overlay' ? 'none' : 'auto',
      transition: reduced ? 'none' : 'box-shadow 260ms linear, border-color 260ms linear'
    },
    children: [
      jsx('style', { children: jp2Style() }, 'style'),
      railTop,
      railBottom,
      sideRail('left'),
      sideRail('right'),
      jsx('div', {
        style: {
          position: 'absolute', inset: 0, boxSizing: 'border-box', padding: '26px 26px 22px',
          display: 'flex', flexDirection: 'column', gap: 10
        },
        children: [
          // Header: the cabinet's own name and the mute.
          jsx('div', {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 40 },
            children: [
              jsx('div', {
                style: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 },
                children: [
                  jsx('span', {
                    style: {
                      fontFamily: 'Georgia, serif', fontWeight: 900, fontSize: 26, letterSpacing: 5,
                      color: JP2_ION, textShadow: `0 0 22px rgba(62,224,197,.75)`
                    },
                    children: 'JACKPOT'
                  }, 'title')
                ]
              }, 'head'),
              jsx('div', {
                style: { display: 'flex', alignItems: 'center', gap: 8 },
                children: [
                  // The session's win chance used to be a chip here. It is gone: the number is not
                  // shown anywhere on either machine. What is here instead is the pay table: every
                  // combination and its payout, opened over the reels. It sits in the header so it
                  // costs the cabinet no height.
                  paytable.length ? jsx('button', {
                    type: 'button',
                    'data-jp2-pays-open': paysOpen ? 'on' : 'off',
                    'aria-expanded': paysOpen,
                    'aria-label': 'What this machine pays',
                    onClick: act(() => setPaysOpen(open => !open)), tabIndex: watch ? -1 : undefined,
                    title: 'What this machine pays: every symbol combination and its payout at the bet on the table, with the jackpot.',
                    style: {
                      pointerEvents: 'auto', padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
                      fontFamily: 'inherit', fontWeight: 800, fontSize: 11, whiteSpace: 'nowrap',
                      background: paysOpen ? 'rgba(62,224,197,.22)' : 'rgba(9,14,26,.8)',
                      border: `1px solid rgba(62,224,197,${paysOpen ? 0.75 : 0.35})`,
                      color: paysOpen ? JP2_ION : JP2_DIM
                    },
                    children: paysOpen ? 'Hide pays' : 'What it pays'
                  }, 'pays-open') : null,
                  jsx('button', {
                    type: 'button',
                    'data-jp2-sound': soundOn ? 'on' : 'off',
                    onClick: toggleSound,
                    title: soundOn ? 'Sound on - click to mute' : 'Sound off - click to switch it on',
                    'aria-label': soundOn ? 'Mute the machine' : 'Unmute the machine',
                    style: {
                      pointerEvents: 'auto', width: 30, height: 26, padding: 0, borderRadius: 8, cursor: 'pointer',
                      background: 'rgba(9,14,26,.8)', border: '1px solid rgba(62,224,197,.35)',
                      color: soundOn ? JP2_ION : JP2_DIM, fontSize: 13, lineHeight: 1
                    },
                    children: soundOn ? '🔊' : '🔇'
                  }, 'sound')
                ]
              }, 'meta')
            ]
          }, 'header'),
          windowBox,
          // Counters: the wallet, the stake, and what the last spin paid.
          jsx('div', {
            style: { display: 'flex', gap: 8 },
            children: [
              counter('Chips', jp2Chips(shownChips), 'chips'),
              counter('Bet', jp2Chips(bet), 'bet'),
              counter('Last win', jp2Chips(Number((result && result.payout) || 0)), 'win')
            ]
          }, 'counters'),
          // The controls: the button, then the switches that are settings rather than moves.
          jsx('div', {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, pointerEvents: 'auto' },
            children: [
              spinButton,
              jsx('div', {
                style: { display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' },
                children: [
                  toggle('autoplay', 'Auto-spin', autoplay, setAutoplay, 'One spin per message you send, while this machine is on screen.'),
                  toggle('autobet', 'Auto-bet', autobet, setAutobet, 'The machine sizes each stake by what the reply cost. Turn it off to play the table bet.')
                ]
              }, 'switches')
            ]
          }, 'controls'),
          // The over-chat switch, in the cabinet's own panel and right below the other two switches.
          // It is the SAME setting as the status bar's and Settings':
          // one press to float the cabinet over the conversation, with how big and how see-through
          // beside it. Guarded by name so a bundle built without the layer part still draws a
          // cabinet (the layer part is where the hooks and the controls live).
          typeof Jackpot2OverChatControls === 'function'
            ? jsx('div', {
              'data-jp2': 'overchat-row',
              style: { display: 'flex', justifyContent: 'center', pointerEvents: 'auto' },
              children: jsx(Jackpot2OverChatControls, { ctx, tone: 'cabinet' })
            }, 'overchat')
            : null,
          // The machine picker: the same session, chosen here.
          machines.length > 1 ? jsx('div', {
            role: 'group',
            'aria-label': 'Pick a machine',
            style: {
              display: 'flex', gap: 6, justifyContent: 'center', pointerEvents: 'auto',
              border: '1px solid rgba(169,155,255,.24)', borderRadius: 10, overflow: 'hidden'
            },
            children: machines.map((item, index) => jsx('button', {
              type: 'button',
              'data-jp2-pick': item.id,
              'aria-pressed': item.id === machineId,
              disabled: busy,
              onClick: act(() => pickMachine(item.id)), tabIndex: watch ? -1 : undefined,
              title: item.blurb || '',
              style: {
                flex: '1 1 0', minWidth: 0, padding: '6px 10px', border: 'none', cursor: 'pointer',
                borderLeft: index ? '1px solid rgba(169,155,255,.24)' : 'none',
                fontFamily: 'inherit', fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                background: item.id === machineId ? 'rgba(62,224,197,.2)' : 'rgba(9,14,26,.72)',
                color: item.id === machineId ? JP2_ION : JP2_DIM
              },
              children: item.title
            }, `pick-${item.id}`))
          }, 'picker') : null,
          // Footer: why the machine cannot spin, what the shelf said, and the points row.
          jsx('div', {
            style: {
              marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center',
              fontSize: 11, color: JP2_DIM, textAlign: 'center', pointerEvents: 'auto'
            },
            children: [
              jsx('span', {
                'data-jp2-live': winText,
                role: 'status',
                'aria-live': 'polite',
                style: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' },
                children: winText
              }, 'live'),
              trouble ? jsx('span', {
                'data-jp2-trouble': '1',
                style: { color: JP2_SIGNAL, overflowWrap: 'anywhere' },
                children: trouble
              }, 'trouble') : null,
              notice ? jsx('span', {
                'data-jp2-notice': '1',
                style: { color: JP2_VIOLET, overflowWrap: 'anywhere' },
                children: notice
              }, 'notice') : null,
              // A table that cannot spin has to say why and offer the way out in one press. A grey
              // SPIN with nothing on screen to explain it is the defect this replaces. Two reasons,
              // both said out loud: no session
              // from the shelf yet, or a wallet under one spin's stake - and that one carries the
              // points-to-chips conversion, four points buying three chips.
              (!trouble && !canSpin) ? (() => {
                if (!(bet > 0)) {
                  return jsx('div', {
                    'data-jp2-nosession': '1',
                    role: 'note',
                    style: jp2NoteStyle(),
                    children: 'Waiting for the shelf to send this session: the stake and the reels arrive with it.'
                  }, 'nosession')
                }
                const want = Math.min(pointsMax, Math.ceil(need / Math.max(1, chipsPerBlock)) * pointsPerBlock)
                const gain = chipsFor(want)
                return jsxs('div', {
                  'data-jp2-broke': '1',
                  role: 'note',
                  style: jp2NoteStyle(),
                  children: [
                    jsx('span', {
                      children: `${jp2Chips(chips)} chips — a spin costs ${jp2Chips(stake)}.`
                    }, 'broke-why'),
                    gain > 0 ? jsx('button', {
                      type: 'button',
                      'data-jp2-broke-cash': '1',
                      disabled: cashBusy,
                      onClick: act(() => cashPoints(want)), tabIndex: watch ? -1 : undefined,
                      title: `Turn ${jp2Chips(want)} points into ${jp2Chips(gain)} chips (${pointsPerBlock} points buy ${chipsPerBlock}). The points you keep still count for the leaderboard.`,
                      style: {
                        pointerEvents: 'auto', padding: '2px 10px', borderRadius: 999,
                        cursor: cashBusy ? 'default' : 'pointer',
                        fontFamily: 'inherit', fontWeight: 800, fontSize: 11,
                        border: '1px solid rgba(62,224,197,.5)',
                        background: cashBusy ? 'rgba(9,14,26,.7)' : 'rgba(62,224,197,.22)',
                        color: cashBusy ? JP2_DIM : JP2_ION
                      },
                      children: `Turn ${jp2Chips(want)} points into ${jp2Chips(gain)} chips`
                    }, 'broke-cash') : jsx('span', {
                      children: reward > 0
                        ? 'Cash your reward chips in below.'
                        : 'Win a game, or chat, to earn points, then turn them into chips here.'
                    }, 'broke-wait')
                  ]
                })
              })() : null,
              // What the automatic spin is and where points come from, in the shelf's own words, said
              // on the cabinet rather than left to be discovered. The whole
              // sentence is the tooltip as well, so a hover repeats it in full.
              jsx('span', {
                'data-jp2-autospin-note': '1',
                title: JP2_AUTOSPIN_NOTE,
                style: { fontSize: 10, lineHeight: 1.35, maxWidth: '100%' },
                children: JP2_AUTOSPIN_NOTE
              }, 'autospin-note'),
              // The cash-in control: HOW MANY points to turn into chips is the person's choice - a
              // slider, a number and Max - at the rate the shelf actually plays (4 points buy 3 chips
              // there; the number is read off its answer, not typed in here). Points are the ranking,
              // so spending them is a choice with a cost, and the line says so plainly.
              jsxs('div', {
                'data-jp2-points-control': '1',
                role: 'group',
                'aria-label': 'Turn points into chips',
                style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flexWrap: 'wrap', maxWidth: '100%' },
                children: [
                  jsx('span', {
                    'data-jp2-points': String(points),
                    title: JP2_POINTS_NOTE,
                    style: { color: JP2_INK, fontWeight: 700 },
                    children: `${jp2Chips(points)} points → ${jp2Chips(sliceChips)} chips`
                  }, 'points'),
                  jsx('input', {
                    type: 'range',
                    'data-jp2-points-range': '1',
                    min: 0,
                    max: Math.max(0, pointsMax),
                    step: pointsPerBlock,
                    value: slice,
                    disabled: watch || pointsMax <= 0 || cashBusy,
                    'aria-label': `How many points to turn into chips, up to ${jp2Chips(pointsMax)}`,
                    title: JP2_POINTS_NOTE,
                    onChange: event => { if (!watch) setPointsWanted(Number(event.target.value)) }, tabIndex: watch ? -1 : undefined,
                    style: {
                      pointerEvents: 'auto', width: 96, margin: 0, accentColor: JP2_ION,
                      cursor: pointsMax <= 0 || cashBusy ? 'default' : 'pointer'
                    }
                  }, 'range'),
                  jsx('input', {
                    type: 'number',
                    'data-jp2-points-number': '1',
                    min: 0,
                    max: Math.max(0, pointsMax),
                    step: pointsPerBlock,
                    value: slice,
                    disabled: watch || pointsMax <= 0 || cashBusy,
                    'aria-label': 'Points to turn into chips',
                    title: JP2_POINTS_NOTE,
                    onChange: event => { if (!watch) setPointsWanted(Number(event.target.value)) }, tabIndex: watch ? -1 : undefined,
                    style: {
                      pointerEvents: 'auto', width: 66, padding: '2px 4px', borderRadius: 6,
                      fontFamily: 'inherit', fontSize: 11, textAlign: 'right',
                      background: 'rgba(9,14,26,.85)', border: '1px solid rgba(62,224,197,.35)', color: JP2_INK
                    }
                  }, 'number'),
                  jsx('button', {
                    type: 'button',
                    'data-jp2-points-max': '1',
                    disabled: pointsMax <= 0 || cashBusy,
                    onClick: act(() => setPointsWanted(pointsMax)), tabIndex: watch ? -1 : undefined,
                    title: `Turn every point you can in (${jp2Chips(pointsMax)} points, in blocks of ${pointsPerBlock}).`,
                    style: {
                      pointerEvents: 'auto', padding: '2px 8px', borderRadius: 999, cursor: pointsMax <= 0 || cashBusy ? 'default' : 'pointer',
                      fontFamily: 'inherit', fontWeight: 800, fontSize: 11,
                      border: '1px solid rgba(169,155,255,.5)',
                      background: pointsMax <= 0 || cashBusy ? 'rgba(9,14,26,.7)' : 'rgba(169,155,255,.2)',
                      color: pointsMax <= 0 || cashBusy ? JP2_DIM : JP2_VIOLET
                    },
                    children: 'Max'
                  }, 'max'),
                  jsx('button', {
                    type: 'button',
                    'data-jp2-points-cash': '1',
                    disabled: sliceChips <= 0 || cashBusy,
                    onClick: act(() => cashPoints(slice)), tabIndex: watch ? -1 : undefined,
                    title: JP2_POINTS_NOTE,
                    style: {
                      pointerEvents: 'auto', padding: '2px 10px', borderRadius: 999, cursor: sliceChips <= 0 || cashBusy ? 'default' : 'pointer',
                      fontFamily: 'inherit', fontWeight: 800, fontSize: 11,
                      border: '1px solid rgba(62,224,197,.5)',
                      background: sliceChips <= 0 || cashBusy ? 'rgba(9,14,26,.7)' : 'rgba(62,224,197,.22)',
                      color: sliceChips <= 0 || cashBusy ? JP2_DIM : JP2_ION
                    },
                    children: `Cash in ${jp2Chips(slice)} points`
                  }, 'cash'),
                  cashFlash ? jsx('span', {
                    'data-jp2-cashed': '1',
                    style: { color: JP2_ION, fontWeight: 800 },
                    children: cashFlash
                  }, 'cashed') : null,
                  // Reward chips: what the older token route minted. Only on screen while there are
                  // any - an empty counter is a question the person has to answer for nothing.
                  reward > 0 ? jsxs('span', {
                    'data-jp2-reward': '1',
                    style: { display: 'inline-flex', alignItems: 'center', gap: 6 },
                    children: [
                      jsx('span', { children: `${jp2Chips(reward)} reward chips` }, 'reward'),
                      jsx('button', {
                        type: 'button',
                        'data-jp2-cashin': '1',
                        disabled: cashBusy,
                        onClick: act(cashIn), tabIndex: watch ? -1 : undefined,
                        title: 'Turn the reward chips you earned from tokens into playing chips',
                        style: {
                          pointerEvents: 'auto', padding: '2px 10px', borderRadius: 999, cursor: cashBusy ? 'default' : 'pointer',
                          fontFamily: 'inherit', fontWeight: 800, fontSize: 11,
                          border: '1px solid rgba(62,224,197,.5)',
                          background: cashBusy ? 'rgba(9,14,26,.7)' : 'rgba(62,224,197,.22)',
                          color: cashBusy ? JP2_DIM : JP2_ION
                        },
                        children: 'Cash in'
                      }, 'cashin')
                    ]
                  }, 'reward-row') : null,
                  jsx('span', {
                    'data-jp2-points-why': '1',
                    style: { fontSize: 10, lineHeight: 1.35, flexBasis: '100%', maxWidth: '100%' },
                    children: JP2_POINTS_NOTE
                  }, 'why')
                ]
              }, 'points-control')
            ]
          }, 'footer')
        ]
      }, 'content'),
      leverEl,
      coinLayer,
      flashLayer
    ]
  })
  // The over-chat layer scales the cabinet itself, so in 'overlay' mode that drawing is the whole
  // answer.
  if (mode !== 'full') return cabinet
  // The full view fits the element it is mounted in. The stage is given exactly the size the machine
  // paints at - a CSS transform does not shrink a layout box, so without this the child kept its full
  // 560x720 and pushed out of a smaller frame - and it is centred in whatever room the frame has.
  // Rounded UP: the stage's layout box must never be a fraction of a pixel smaller than what the
  // cabinet paints, or the frame clips its right and bottom edge by that fraction.
  const stageW = Math.ceil(JP2_W * fit)
  const stageH = Math.ceil(JP2_H * fit)
  return jsx('div', {
    className: 'jp2-fit',
    ref: fitBox,
    'data-jp2': 'fit',
    'data-jp2-fit-size': `${stageW}x${stageH}`,
    style: {
      position: 'relative', width: '100%', height: '100%', minWidth: 0, minHeight: 0,
      boxSizing: 'border-box', overflow: 'hidden',
      display: 'flex', alignItems: 'center', justifyContent: 'center'
    },
    children: jsx('div', {
      'data-jp2-fit-stage': '1',
      style: { width: stageW, height: stageH },
      children: jsx('div', {
        style: { width: JP2_W, height: JP2_H, transform: `scale(${fit})`, transformOrigin: 'top left' },
        children: cabinet
      })
    })
  })
}

// The last reel's rim: which reel is the crawling one, asked in one place so the drawing and the
// sequence cannot disagree.
function teaseOn(near, reel, reelCount) {
  return Boolean(near) && reel === reelCount - 1
}
