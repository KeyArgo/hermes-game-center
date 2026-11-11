// ---- 18-slot-machine.js: the mechanical slot machine, shared by the Slots table and the overlay
// Every reel is the machine's real strip of stops. A spin kicks the reels up, runs them
// down at speed, and stops them left to right with a small mechanical overshoot, landing
// exactly on the stops the server picked. Wins light their paylines one by one, coins
// spill from the tray and the chip counter counts up. Nothing here decides an outcome.

const SM_REPEAT = 6
const SM_BASE_COPY = 4
const SM_STOP_MS = [820, 1020, 1220]
const SM_KICK_MS = 140
// Each column starts this long after the one before it, so they run and land one at a time.
const SM_STAGGER_MS = 130
const SM_LINE_MS = 420
const SM_GOLD = '#facc15'
// Casino-style win ladder: what the payout is worth in spectacle. The numbers are the ones the
// owner named (10, 50, 100, 200, 400, 500, 1000, 10000 chips); a payout climbs to the highest tier
// it reaches, and the tier decides how long the machine carries on, how many coins fall and whether
// the alarm goes off. Nothing here changes an outcome - the reels already decided.
const SM_TIERS = [
  { chips: 10, name: 'CHING!', seconds: 2.6, rain: 18, coins: 6, alarm: 0 },
  { chips: 50, name: 'NICE!', seconds: 3.2, rain: 26, coins: 10, alarm: 0 },
  { chips: 100, name: 'BIG WIN!', seconds: 3.8, rain: 34, coins: 14, alarm: 0 },
  { chips: 200, name: 'BIG WIN!', seconds: 4.6, rain: 42, coins: 18, alarm: 0 },
  { chips: 400, name: 'BIG WIN!', seconds: 5.4, rain: 50, coins: 22, alarm: 0 },
  { chips: 500, name: 'HUGE WIN!', seconds: 6.6, rain: 58, coins: 26, alarm: 2 },
  { chips: 1000, name: 'HUGE WIN!', seconds: 8.6, rain: 70, coins: 34, alarm: 4 },
  { chips: 10000, name: 'JACKPOT!', seconds: 18, rain: 120, coins: 60, alarm: 8 }
]

function SM_tierFor(payout) {
  const chips = Math.max(0, Number(payout) || 0)
  let tier = SM_TIERS[0]
  for (const step of SM_TIERS) if (chips >= step.chips) tier = step
  return tier
}
// How big the see-through copy over the chat is, as a fraction of the cabinet's own size. The table
// and the Play page keep their fixed size; only the over-chat copy follows this. It starts at 1.00 -
// the same size the Game Center draws - and the slider only ever makes it SMALLER (owner's ask,
// 2026-11-09: there should be no larger, and the control was reading backwards). So the stored
// number is a multiplier of SM_SCALE_TABLE, never an absolute scale.
const SM_SCALE_KEY = 'gameshelf.slots.scale'
const SM_SCALE_DEFAULT = 1
const SM_SCALE_MIN = 0.1
const SM_SCALE_MAX = 3
const SM_SCALE_STEP = 0.05  // 5% steps: 1.0 is the size it has always been, 3.0 fills the window
const SM_SCALE_STATE = { value: SM_SCALE_DEFAULT, listeners: new Set() }

function SM_clampScale(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return SM_SCALE_DEFAULT
  const snapped = Math.round(number / SM_SCALE_STEP) * SM_SCALE_STEP
  return Math.min(SM_SCALE_MAX, Math.max(SM_SCALE_MIN, Number(snapped.toFixed(2))))
}

function SM_readScale() {
  try {
    const raw = window.localStorage.getItem(SM_SCALE_KEY)
    return raw === null || raw === '' ? SM_SCALE_DEFAULT : SM_clampScale(raw)
  } catch {
    return SM_SCALE_DEFAULT
  }
}

SM_SCALE_STATE.value = SM_readScale()
// The fixed size of the machine where it is actually played: the table, the pane, the Play page.
const SM_SCALE_TABLE = 0.85
// The value SM_px() uses while one machine draws. SlotMachine sets it from its own prop, so two
// copies on screen at once (the table and the see-through one) each draw at their own size.
let SM_SCALE = SM_SCALE_TABLE
const SM_px = value => Math.round(value * SM_SCALE)

function smSetScale(value) {
  const next = SM_clampScale(value)
  SM_SCALE_STATE.value = next
  SM_SCALE = next
  try {
    window.localStorage.setItem(SM_SCALE_KEY, String(next))
  } catch {
    // Storage can be missing or refuse writes; the size still holds for this visit.
  }
  SM_SCALE_STATE.listeners.forEach(listener => listener(next))
  SM_savePrefs()
  return next
}

function useSmScale() {
  const [scale, setScale] = useState(SM_SCALE_STATE.value)
  useEffect(() => {
    const listener = value => setScale(value)
    SM_SCALE_STATE.listeners.add(listener)
    setScale(SM_SCALE_STATE.value)
    return () => { SM_SCALE_STATE.listeners.delete(listener) }
  }, [])
  return [scale, smSetScale]
}
// The "Show over chat" setting is per viewer and shared by every mounted machine.
const SM_OVERCHAT_KEY = 'gameshelf.slots.overchat'
const SM_OVERCHAT = { on: false, listeners: new Set() }

// Every mounted machine listens here so a message being sent can pull its lever before
// the result arrives: the anticipation is the same pull a manual spin does.
const SM_PULL = { listeners: new Set() }

function smPullAll() {
  SM_PULL.listeners.forEach(listener => {
    try {
      listener()
    } catch {
      // One machine failing to draw must not stop the others from pulling.
    }
  })
}

function SM_readOverchat() {
  try {
    return window.localStorage.getItem(SM_OVERCHAT_KEY) === '1'
  } catch {
    return false
  }
}

SM_OVERCHAT.on = SM_readOverchat()

function SM_writeOverchat(on) {
  try {
    window.localStorage.setItem(SM_OVERCHAT_KEY, on ? '1' : '0')
  } catch {
    // Storage can be missing or refuse writes; the setting still works for this visit.
  }
}

function smSetOverchat(value, { save = true } = {}) {
  const on = !!value
  SM_OVERCHAT.on = on
  SM_writeOverchat(on)
  // Stored on the shelf too, not just in this browser: on/off used to live only in localStorage and
  // came back switched off after a plugin reload, which read as the machine having vanished
  // (owner's report, 2026-11-10).
  if (save && typeof SM_savePrefs === 'function') SM_savePrefs()
  SM_OVERCHAT.listeners.forEach(listener => listener(on))
  // Toggling the see-through copy is also the person's manual escape from a celebration that is
  // still raining: every mounted machine drops its coins at once, so a stuck overlay can never
  // survive a click on "Show over chat" (owner's ask, 2026-11-09).
  smClearCelebrations()
}

// One broadcast, heard by every mounted machine. Used when the person toggles the over-chat copy, so
// the rain cannot outlive the click that asked for it, whichever machine started it.
const SM_CELEBRATE = { listeners: new Set() }

function smClearCelebrations() {
  SM_CELEBRATE.listeners.forEach(listener => {
    try {
      listener()
    } catch {
      // One machine failing to clear must not spare the others.
    }
  })
}

function useSmCelebrateCleared(clear) {
  useEffect(() => {
    const listener = () => clear()
    SM_CELEBRATE.listeners.add(listener)
    return () => { SM_CELEBRATE.listeners.delete(listener) }
  }, [clear])
}

function useSmOverchat() {
  const [on, setOn] = useState(SM_OVERCHAT.on)
  useEffect(() => {
    const listener = value => setOn(value)
    SM_OVERCHAT.listeners.add(listener)
    setOn(SM_OVERCHAT.on)
    return () => { SM_OVERCHAT.listeners.delete(listener) }
  }, [])
  return [on, smSetOverchat]
}

// How see-through the over-chat copy is. A viewing preference, not a game rule: it lives in
// this browser, the control sits beside "Show over chat", and every mounted copy of the
// machine follows it the moment it changes. 20% is the owner's default (2026-11-09), five
// points more opaque than the 15% it was.
const SM_ALPHA_KEY = 'gameshelf.slots.overchat_alpha'
const SM_ALPHA_DEFAULT = 0.2
const SM_ALPHA_MIN = 0.05
const SM_ALPHA_MAX = 0.6
const SM_ALPHA_STEP = 0.05
const SM_ALPHA = { value: SM_ALPHA_DEFAULT, listeners: new Set() }

function SM_clampAlpha(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return SM_ALPHA_DEFAULT
  const rounded = Math.round(number / SM_ALPHA_STEP) * SM_ALPHA_STEP
  return Math.min(SM_ALPHA_MAX, Math.max(SM_ALPHA_MIN, Number(rounded.toFixed(2))))
}

function SM_readAlpha() {
  try {
    const raw = window.localStorage.getItem(SM_ALPHA_KEY)
    return raw === null || raw === '' ? SM_ALPHA_DEFAULT : SM_clampAlpha(raw)
  } catch {
    return SM_ALPHA_DEFAULT
  }
}

SM_ALPHA.value = SM_readAlpha()

// The preferences live on the server as well as in this browser: localStorage alone did not
// survive a plugin reload for the owner, so every change is also posted to the shelf, and the
// snapshot's values are adopted on load.
let SM_prefsTimer = null
let SM_prefsTouchedAt = 0
function SM_savePrefs() {
  SM_prefsTouchedAt = Date.now()
  if (SM_prefsTimer) clearTimeout(SM_prefsTimer)
  SM_prefsTimer = setTimeout(() => {
    SM_prefsTimer = null
    if (typeof slotsSetting === 'function') {
      slotsSetting('/jackpot/prefs', { on: SM_OVERCHAT.on, alpha: SM_ALPHA.value, scale: SM_SCALE_STATE.value })
    }
  }, 300)
}

function SM_adoptPrefs(prefs) {
  if (!prefs || typeof prefs !== 'object') return
  // A change the person just made wins over a snapshot taken before it.
  if (Date.now() - SM_prefsTouchedAt < 2000) return
  if (typeof prefs.on === 'boolean' && prefs.on !== SM_OVERCHAT.on) {
    smSetOverchat(prefs.on, { save: false })
  }
  const alpha = Number(prefs.alpha)
  if (Number.isFinite(alpha) && Math.abs(alpha - SM_ALPHA.value) > 0.001) {
    SM_ALPHA.value = SM_clampAlpha(alpha)
    SM_ALPHA.listeners.forEach(listener => listener(SM_ALPHA.value))
  }
  const scale = Number(prefs.scale)
  if (Number.isFinite(scale) && Math.abs(scale - SM_SCALE_STATE.value) > 0.001) {
    SM_SCALE_STATE.value = SM_clampScale(scale)
    SM_SCALE_STATE.listeners.forEach(listener => listener(SM_SCALE_STATE.value))
  }
}

function smSetOverchatAlpha(value) {
  const next = SM_clampAlpha(value)
  SM_ALPHA.value = next
  try {
    window.localStorage.setItem(SM_ALPHA_KEY, String(next))
  } catch {
    // Storage can be missing or refuse writes; the setting still works for this visit.
  }
  SM_ALPHA.listeners.forEach(listener => listener(next))
  SM_savePrefs()
  return next
}

function smNudgeOverchatAlpha(direction) {
  return smSetOverchatAlpha(SM_ALPHA.value + (direction < 0 ? -SM_ALPHA_STEP : SM_ALPHA_STEP))
}

function useSmOverchatAlpha() {
  const [alpha, setAlpha] = useState(SM_ALPHA.value)
  useEffect(() => {
    const listener = value => setAlpha(value)
    SM_ALPHA.listeners.add(listener)
    setAlpha(SM_ALPHA.value)
    return () => { SM_ALPHA.listeners.delete(listener) }
  }, [])
  return [alpha, smSetOverchatAlpha]
}
// Each machine brings its own colours: Classic is warm walnut and brass, Hermes Robots is
// brushed slate blue with mint. The drawing helpers read the machine being rendered.
let SM_LOOK = {}
// The palette last seen for each machine id, and the one most recently drawn. A copy that mounts
// before its snapshot arrives paints the right cabinet instead of a placeholder that then changes.
const SM_THEME_CACHE = {}
let SM_LAST_MACHINE = ''
const smAccent = () => SM_LOOK.accent || SM_GOLD
const smShell = () => SM_LOOK.windowShell || SM_LOOK.bg || '#1c1917'
const smEdge = () => SM_LOOK.windowEdge || SM_LOOK.edge || '#292524'
// The old red cabinet was the fallback for "no machine yet", so the wait pane painted an orange-red
// machine for one frame and then re-painted in the session's colours - the flash the owner reported
// on 2026-11-10 ("you can see the old orange one appear before the teal comes in"). The fallback is
// now the machine's own dark shell, which reads as the frame being built rather than as another
// cabinet, and the last theme seen is remembered per machine so a remount never guesses.
const smBody = () => SM_LOOK.body || SM_LOOK.bg || '#1c1917'
const smTrim = () => SM_LOOK.trim || '#a8a29e'
const smLook = (key, fallback) => SM_LOOK[key] || fallback

const SM_CHROME = 'linear-gradient(180deg, #f1f5f9 0%, #94a3b8 45%, #e2e8f0 55%, #64748b 100%)'

// The cabinets have their own natural-but-lively palettes. The shelf still sends its old
// theme with each machine, so the desktop palette wins by machine id and the server theme
// is only a fallback for a machine this build has not seen yet.
const SM_THEMES = {
  fruit9: {
    body: 'repeating-linear-gradient(90deg, rgba(0,0,0,0.045) 0px, rgba(0,0,0,0.045) 1px, rgba(255,255,255,0.03) 2px, transparent 3px, transparent 7px), linear-gradient(180deg, #8a5a3b 0%, #6f472d 45%, #5b3a24 100%)',
    edge: '#3d2618',
    trim: '#d9a441',
    trimDark: '#9a6f24',
    window: 'linear-gradient(90deg, #e7dcc6 0%, #fbf5e6 18%, #fffdf7 50%, #fbf5e6 82%, #e7dcc6 100%)',
    windowEdge: '#b08a52',
    windowShadow: 'inset 0 6px 14px rgba(59,38,24,0.45)',
    divider: '#8a6a44',
    marqueeBg: '#1f6f6b',
    marqueeText: '#fbf5e6',
    marqueeShadow: '0 2px 0 #0d3f3d',
    accent: '#ef6f5e',
    markerText: '#fbf5e6',
    markerActiveText: '#2a120d',
    markerBg: 'rgba(38,22,12,0.55)',
    markerActiveBg: '#ef6f5e',
    bulb: '#f3d27a',
    bulbGlow: '#d9a441',
    spinBg: 'radial-gradient(circle at 50% 30%, #f79a8b, #ef6f5e 60%, #c94f40)',
    spinText: '#fff8e7',
    spinRim: '#d9a441',
    spinShadow: '0 4px 0 #8f3a2e',
    counterBg: '#2a1a12',
    counterText: '#fbf5e6',
    counterBorder: '#d9a441',
    label: '#f3d27a',
    control: '#fbf5e6',
    controlBg: 'rgba(38,22,12,0.55)',
    betText: '#fbf5e6',
    betBg: 'rgba(38,22,12,0.55)',
    betSelectedBg: '#ef6f5e',
    betSelectedText: '#2a120d',
    footer: '#f6e7cf',
    rise: '#fbf5e6',
    lever: SM_CHROME,
    leverKnob: 'radial-gradient(circle at 35% 35%, #fca5a5, #b91c1c 70%)',
    glow: 'rgba(217,164,65,0.9)'
  },
  robot3: {
    body: 'linear-gradient(180deg, #3b5266 0%, #304457 45%, #263848 100%)',
    edge: '#16242e',
    trim: '#5eead4',
    trimDark: '#2c8f80',
    window: 'linear-gradient(90deg, #dbe7e5 0%, #eef5f4 18%, #f7fbfa 50%, #eef5f4 82%, #dbe7e5 100%)',
    windowEdge: '#7fb8ae',
    windowShadow: 'inset 0 6px 14px rgba(22,36,46,0.45)',
    divider: '#5d8b87',
    marqueeBg: '#16242e',
    marqueeText: '#5eead4',
    marqueeShadow: '0 2px 0 #0b151c',
    accent: '#5eead4',
    markerText: '#d7fffa',
    markerActiveText: '#062e2b',
    markerBg: 'rgba(12,28,36,0.65)',
    markerActiveBg: '#5eead4',
    bulb: '#fbbf24',
    bulbGlow: '#f59e0b',
    spinBg: 'radial-gradient(circle at 50% 30%, #9ff7e7, #5eead4 60%, #2bb8a2)',
    spinText: '#062e2b',
    spinRim: '#5eead4',
    spinShadow: '0 4px 0 #176b5f',
    counterBg: '#101f29',
    counterText: '#e6fffb',
    counterBorder: '#5eead4',
    label: '#5eead4',
    control: '#e6fffb',
    controlBg: 'rgba(10,24,32,0.65)',
    betText: '#d7fffa',
    betBg: 'rgba(10,24,32,0.65)',
    betSelectedBg: '#5eead4',
    betSelectedText: '#062e2b',
    footer: '#c9dbe6',
    rise: '#e6fffb',
    lever: SM_CHROME,
    leverKnob: 'radial-gradient(circle at 35% 35%, #99f6e4, #0f766e 70%)',
    glow: 'rgba(94,234,212,0.9)'
  }
}

// Points per mark on the score bar. 500 is about twenty minutes of steady chatting at the
// shipped 10-points-per-million rate, so the bar moves visibly without crawling.
const POINT_STEP = 500

const SM_STYLE = `
@keyframes sm-chase { 0%, 100% { opacity: .25 } 50% { opacity: 1 } }
@keyframes sm-blink { 0%, 49% { opacity: 1 } 50%, 100% { opacity: .15 } }
@keyframes sm-pulse { 0%, 100% { transform: scale(1) } 50% { transform: scale(1.12) } }
@keyframes sm-rise { 0% { transform: translate(-50%, 0); opacity: 0 } 15% { opacity: 1 } 100% { transform: translate(-50%, -70px); opacity: 0 } }
@keyframes sm-coin { 0% { transform: translate(0, 0) rotateY(0deg); opacity: 1 }
  45% { transform: translate(var(--sm-dx), var(--sm-up)) rotateY(540deg); opacity: 1 }
  100% { transform: translate(calc(var(--sm-dx) * 1.5), 40px) rotateY(1080deg); opacity: 0 } }
@keyframes sm-flash { 0%, 100% { box-shadow: 0 0 0 rgba(250,204,21,0) } 50% { box-shadow: 0 0 60px rgba(250,204,21,.95) } }
@keyframes sm-screenflash { 0%, 100% { opacity: 0 } 12% { opacity: .85 } 24% { opacity: .15 } 36% { opacity: .75 } 50% { opacity: .1 } 62% { opacity: .6 } 76% { opacity: .08 } }
@keyframes sm-celebrate { 0% { transform: translate(-50%,-50%) scale(.4); opacity: 0 } 18% { transform: translate(-50%,-50%) scale(1.12); opacity: 1 } 30% { transform: translate(-50%,-50%) scale(1) } 85% { opacity: 1 } 100% { opacity: 0 } }
@keyframes sm-egg-pop { 0% { transform: translate(-50%, -50%) scale(.55); opacity: 0 }
  14% { transform: translate(-50%, -50%) scale(1.08); opacity: 1 }
  26% { transform: translate(-50%, -50%) scale(1) }
  82% { opacity: 1 }
  100% { transform: translate(-50%, -62%) scale(1.02); opacity: 0 } }
@keyframes sm-egg-spark { 0% { transform: translate(0,0) scale(.6); opacity: 0 }
  20% { opacity: 1 }
  100% { transform: translate(var(--sm-ex), var(--sm-ey)) scale(.2); opacity: 0 } }
@keyframes sm-sweep { from { left: 0 } to { left: calc(100% - 10px) } }
@keyframes sm-rain { 0% { transform: translateY(-12vh) rotate(0deg); opacity: 1 } 100% { transform: translateY(108vh) rotate(720deg); opacity: .9 } }
@media (prefers-reduced-motion: reduce) { .sm-machine * { animation: none !important; transition: none !important; } }
`

function SM_reducedMotion() {
  try {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  } catch {
    return false
  }
}

function SM_chips(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number).toLocaleString() : '0'
}

// Token totals read at a glance: 3.4M, 12.3K, or a plain count.
function SM_tokens(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return '0'
  if (number >= 1000000) return `${(number / 1000000).toFixed(1).replace(/\.0$/, '')}M`
  if (number >= 1000) return `${(number / 1000).toFixed(1).replace(/\.0$/, '')}K`
  return String(Math.round(number))
}

// The reward fields are optional: an older shelf sends none, and then no row is drawn.
function SM_rewardFields(source) {
  if (!source || typeof source.reward !== 'number') return null
  const rate = source.reward_rate && typeof source.reward_rate === 'object' ? source.reward_rate : {}
  const perTokens = Number(rate.per_tokens) || 1000000
  const perPoints = Number(rate.points) || 10
  // One point costs `perTokens / perPoints` tokens - 100,000 with the shipped 10-per-1M rate. The
  // leftover under `tokens` is what has been spent since the last whole point, so the person can see
  // how close the next one is instead of watching a number that only moves every so often.
  const perPoint = perTokens > 0 && perPoints > 0 ? perTokens / perPoints : 100000
  const leftover = Math.max(0, Number(source.tokens) || 0)
  return {
    reward: Math.max(0, Math.round(source.reward)),
    tokens: Math.max(0, Math.min(99999, leftover)),
    tokens_total: Math.max(0, Math.round(Number(source.tokens_total) || 0)),
    // The wallet's `bonus` is every point the person holds, from chat use and from games won. It was
    // read here as "points from tokens", which made the old line claim a split it never had.
    // `points` is accepted as a second name for the wallet's `bonus`: an older shelf sent one or the
    // other, and a missing key must never read as "no points" on a wallet that has them.
    points: Math.max(0, Math.round(Number(source.bonus != null ? source.bonus : source.points) || 0)),
    points_from_tokens: Math.max(0, Math.round(Number(source.bonus) || 0)),
    per_point: Math.max(1, Math.round(perPoint)),
    // Points cash into chips at 75%, whole blocks only: 4 points buy 3 chips, the rest stays on the
    // account. Computed here so the button's promise and the server's arithmetic are the same sum.
    points_chips: Math.floor(Math.max(0, Math.round(Number(source.bonus) || 0)) / 4) * 3,
    points_cost: Math.floor(Math.max(0, Math.round(Number(source.bonus) || 0)) / 4) * 4,
    next_point: Math.max(0, Math.round(perPoint - leftover)),
    reward_rate: {
      points: perPoints,
      per_tokens: perTokens
    }
  }
}

// The internal blank stop never reaches the screen: the machine's blank face does.
function SM_face(symbol) {
  if (SM_LOOK.blank && symbol === SM_LOOK.blank) return SM_LOOK.blank_face || ''
  return symbol
}

// One symbol as it is painted on the reel: BAR on a black plate, 7 in red with a gold edge.
// Picture symbols (the Nous stamp and the Hermes wing) are drawn from SM_ART; a winning
// Nous stamp gets a quiet gold ring because it is the Classic machine's jackpot.
function SM_symbol(symbol, size, glowing) {
  symbol = SM_face(symbol)
  if (typeof SM_ART !== 'undefined' && SM_ART && Object.prototype.hasOwnProperty.call(SM_ART, symbol)) {
    // The picture sits on a pale plate. The Nous mark and the wing are dark artwork, and on the
    // machine's dark drum they read as a smudge; a light disc behind them makes the drawn line the
    // thing the eye lands on (owner's ask, 2026-11-09: "hard to see the nous line here, maybe put on
    // white background for the circle part").
    return jsx('span', {
      'data-sm-plate': symbol,
      style: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: size * 0.92, height: size * 0.92, borderRadius: '50%', pointerEvents: 'none',
        background: 'radial-gradient(circle at 38% 32%, #ffffff 0%, #f5f5f4 55%, #d6d3d1 100%)',
        boxShadow: glowing
          ? `0 0 0 ${SM_px(2)}px #f3d27a, 0 0 ${SM_px(12)}px rgba(217,164,65,0.9)`
          : `inset 0 0 0 ${SM_px(1)}px rgba(0,0,0,0.2), 0 ${SM_px(1)}px ${SM_px(3)}px rgba(0,0,0,0.45)`
      },
      children: jsx('img', {
        src: SM_ART[symbol],
        alt: symbol === 'NOUS' ? 'Nous Research'
          : symbol === 'CADUCEUS' ? 'Caduceus' : 'Hermes wing',
        draggable: false,
        style: { width: size * 0.7, height: size * 0.7, objectFit: 'contain', pointerEvents: 'none' }
      })
    })
  }
  if (symbol === 'BAR') {
    return jsx('span', {
      style: {
        display: 'inline-block', padding: `${Math.round(size * 0.06)}px ${Math.round(size * 0.12)}px`,
        background: '#111827', color: '#f8fafc', borderRadius: SM_px(4), border: `${SM_px(2)}px solid #e5e7eb`,
        fontWeight: 900, fontSize: Math.round(size * 0.3), letterSpacing: SM_px(1), fontFamily: 'Georgia, serif'
      },
      children: 'BAR'
    })
  }
  if (symbol === '7') {
    return jsx('span', {
      style: {
        color: '#dc2626', fontWeight: 900, fontSize: Math.round(size * 0.72), lineHeight: 1,
        fontFamily: 'Georgia, serif', WebkitTextStroke: `${SM_px(2)}px ${SM_GOLD}`, textShadow: `0 ${SM_px(2)}px 0 #7f1d1d`
      },
      children: '7'
    })
  }
  return jsx('span', { style: { fontSize: Math.round(size * 0.56), lineHeight: 1 }, children: symbol })
}

// A paytable row is written as symbols separated by spaces ("NOUS NOUS NOUS", "🍒 🍒 –"). Draw each
// token with its picture: the plain string used to reach the screen as the literal word NOUS three
// times, while the reels themselves showed the Nous mark (owner's report, 2026-11-09: "replace nous
// nous nous and wing wing wing and bar bar bar with the images").
function SM_symbolRun(text, size) {
  const tokens = String(text || '').trim().split(/\s+/).filter(Boolean)
  return jsx('span', {
    style: { display: 'inline-flex', alignItems: 'center', gap: SM_px(1) },
    children: tokens.map((token, index) => (
      token === '–'
        ? jsx('span', { style: { opacity: 0.45, fontSize: Math.round(size * 0.5) }, children: '–' }, `dash-${index}`)
        : jsx('span', { style: { display: 'inline-flex', alignItems: 'center' }, children: SM_symbol(token, size) }, `tok-${index}`)
    ))
  })
}

// How many copies of a strip to draw. The reels travel (2 + reel) extra turns down the strip,
// so the last reel lands close to the end of the drawn repeats: with only SM_REPEAT + 2 copies
// its window ran past the last drawn cell and showed an empty column for the rest of the spin.
function SM_copiesFor(reelCount) {
  return SM_BASE_COPY + (2 + Math.max(1, reelCount)) + 2
}

// Where a reel's window top sits for a stop: the stop is the middle row on a three-row machine.
function SM_topIndex(stop, rows, size) {
  const offset = rows === 3 ? 1 : 0
  return (((stop - offset) % size) + size) % size
}

// A result's stop for each reel. Fruit Classic sends stops; a one-row machine sends its symbols,
// so find a stop showing that symbol.
function SM_stopsFor(result, machine) {
  const strips = (machine && machine.strips) || []
  if (result && Array.isArray(result.stops) && result.stops.length === strips.length) return result.stops.map(Number)
  const shown = (result && result.reels) || []
  return strips.map((strip, reel) => {
    const at = strip.indexOf(shown[reel])
    return at < 0 ? 0 : at
  })
}

function SM_stamp(result) {
  if (!result) return ''
  return `${result.at || ''}|${(result.stops || []).join(',')}|${JSON.stringify(result.grid || result.reels || [])}`
}

// `odds` still arrives and is still the shelf's own draw for this session — it is kept in the
// signature because the table is what the session belongs to, and the machine no longer prints any
// of its numbers (owner's release rule, 2026-11-11). Nothing here may start showing them again.
function SlotMachine({
  machine, machines, result, chips, bet, bets, odds, autoplay, autobet, busy, canSpin, trouble,
  onSpin, onBet, onPickMachine, onAutoplay, onAutobet, compact, paytable, bare, chat, onClose, onShow, cabinetRef,
  rewards, onCashin, onPoints, onBailout, onEgg, scaleOverride
}) {
  // How the automatic bet is sized, said once, so the tooltip and the note cannot drift from
// shelf/autobet.py (owner's ask, 2026-11-09).
const AUTOBET_RULES = 'Turn starting or a tool running: 1x. A reply under 20k tokens: 2x. Then 3x at 40k, 4x at 80k, 6x at 160k, 8x at 320k and above - 1x is 25 chips, the smallest bet on the table. Never more than the cap, and the odds are identical at every bet: a bigger bet is a bigger swing, not a better chance.'
// The see-through copy passes its own size; every other copy draws at the fixed table size.
  // scaleOverride is a fraction of the cabinet size: 1 means "the same as the table", 0.6 means
  // 60% of it. Multiplying here keeps the table and the copy on one geometry.
  SM_SCALE = Number.isFinite(scaleOverride) ? SM_SCALE_TABLE * scaleOverride : SM_SCALE_TABLE
  const info = machine || { id: '', title: 'Slots', rows: 3, reels: 3, strips: [[], [], []], lines: [] }
  const strips = info.strips && info.strips.length ? info.strips : [[], [], []]
  const rows = Number(info.rows) || 3
  // A one-row machine would otherwise be a thin strip: give its single window real presence.
  // Bigger wheels than the first cabinet: the reels are the machine, so they take the room
  // (owner's ask, 2026-11-09: "make the wheels bigger and centered").
  const cell = rows === 1 ? (compact ? SM_px(62) : SM_px(94)) : (compact ? SM_px(48) : SM_px(70))
  const reelWidth = Math.round(cell * 1.3)
  const still = SM_reducedMotion()
  // The auto-bet switch is optimistic: it flips under the finger, and the shelf's answer settles
  // it. The first version read straight from the polled payload, so it never moved - the report
  // was "auto bet sizes itself check won't turn off stays on" (2026-11-09).
  const autobetOn = autobet !== false
  const [autobetShown, setAutobetShown] = useState(autobetOn)
  const [autobetHelp, setAutobetHelp] = useState(false)
  useEffect(() => { setAutobetShown(autobetOn) }, [autobetOn])
  const flipAutobet = on => {
    setAutobetShown(Boolean(on))
    if (onAutobet) onAutobet(Boolean(on))
  }
  const [overchat, setOverchat] = useSmOverchat()
  const [alpha] = useSmOverchatAlpha()
  const [scale, setScale] = useSmScale()
  // The shelf is the memory: a reload reads back the opacity and size it was left at.
  useEffect(() => { SM_adoptPrefs(rewards && rewards.overchat) }, [rewards && rewards.overchat && rewards.overchat.alpha, rewards && rewards.overchat && rewards.overchat.scale])

  // Reel positions are the index of the top visible cell inside the repeated strip.
  const homes = strips.map(strip => SM_BASE_COPY * Math.max(strip.length, 1))
  const [positions, setPositions] = useState(homes)
  const [moving, setMoving] = useState(strips.map(() => 0))
  const [lever, setLever] = useState(false)
  const [lit, setLit] = useState(0)
  const [shownWins, setShownWins] = useState([])
  const [coins, setCoins] = useState([])
  const [rise, setRise] = useState(null)
  const [jackpot, setJackpot] = useState(false)
  const [cashBusy, setCashBusy] = useState(false)
  // Points are the high score, so cashing them in is a slice the person picks rather than an all-in
  // button: half by default, a quarter for a top-up, all of it only when they say so (owner's ask,
  // 2026-11-09: "add the ability to pick how many points to convert to cash as their points is their
  // high score so not ideal, its a penalty to keep playing").
  const [cashShare, setCashShare] = useState(0.5)
  // The comeback tap: three quick skill shots when the wallet cannot cover a bet. Deliberately a
  // little arcade rather than a button that hands out chips - a graded shot, a streak that grows
  // with coming back on another day, and ten premium spins afterwards (owner's ask, 2026-11-09:
  // "come up with a gamification for making quick chips ... really gamify this so its addictive").
  const [lodder, setLodder] = useState(null)      // { t0, marks: [] }
  const [bailoutResult, setBailoutResult] = useState(null)
  const [bailoutBusy, setBailoutBusy] = useState(false)
  // What the last egg paid, so the find can be celebrated properly rather than with a small flash.
  const [eggHit, setEggHit] = useState(null)
  const [cashFlash, setCashFlash] = useState('')
  // Which machine is on screen decides the cabinet's colours and its blank face. The
  // desktop palette is used first; an unknown machine falls back to the shelf's theme.
  const machineTheme = (machine && (SM_THEMES[machine.id] || machine.theme)) || SM_THEME_CACHE[SM_LAST_MACHINE] || {}
  SM_LOOK = {
    ...machineTheme,
    blank: (machine && machine.blank) || '',
    blank_face: (machine && machine.blank_face) || ''
  }
  if (machine && machine.id && machineTheme && Object.keys(machineTheme).length) {
    SM_THEME_CACHE[machine.id] = machineTheme
    SM_LAST_MACHINE = machine.id
  }
  const [celebrate, setCelebrate] = useState(null)
  const [shownChips, setShownChips] = useState(Number(chips) || 0)
  const [payOpen, setPayOpen] = useState(false)
  const [payHover, setPayHover] = useState(false)
  const seen = useRef('')
  const timers = useRef([])
  // The celebration is bounded in time, and the bound is a deadline on the overlay itself rather
  // than a timer in `timers` (a new spin wipes that array, which is how the rain once became
  // permanent). Owner's rule, 2026-11-09: "they never end, but shouldn't last for more than 10
  // seconds unless jackpot which maybe can last 5 minutes". The effect below enforces it even if
  // every other path fails, and the ✕ on the overlay ends it early.
  const counting = useRef(null)
  const settledChips = useRef(Number(chips) || 0)
  // While reels run, the chip total on screen waits for them: the server already knows the win.
  const holding = useRef(false)

  const later = (fn, ms) => {
    const timer = setTimeout(fn, ms)
    timers.current.push(timer)
  }
  useEffect(() => () => {
    timers.current.forEach(clearTimeout)
    if (counting.current) clearInterval(counting.current)
  }, [])

  // The person's manual escape: toggling "Show over chat" clears any celebration this machine is
  // still drawing, so a stuck rain ends on a click instead of a reload (owner's ask, 2026-11-09).
  const clearShow = useCallback(() => {
    setCelebrate(null)
    setCoins([])
    setRise(null)
  }, [])
  useSmCelebrateCleared(clearShow)

  // The celebration's only exit. Keyed on the overlay itself, so it is re-armed by a new win and
  // cancelled by a new result; nothing else in the machine can wipe it. `until` is set when the win
  // is shown: 10 s of rain for a normal win, up to 5 minutes for a jackpot.
  useEffect(() => {
    if (!celebrate) return undefined
    const left = Math.max(0, Number(celebrate.until) - Date.now())
    const timer = setTimeout(() => setCelebrate(null), left)
    return () => clearTimeout(timer)
  }, [celebrate])

  // A message being sent pulls every mounted machine's lever at once, so the person sees
  // the anticipation before the result arrives. The real result still runs its own sequence.
  useEffect(() => {
    const listener = () => {
      setLever(true)
      later(() => setLever(false), 380)
      setMoving(strips.map(() => SM_KICK_MS))
      setPositions(current => current.map(position => position - 0.3))
    }
    SM_PULL.listeners.add(listener)
    return () => { SM_PULL.listeners.delete(listener) }
  }, [info.id])

  // Chips follow the server unless a win is being counted up.
  useEffect(() => {
    if (counting.current || holding.current) return
    settledChips.current = Number(chips) || 0
    setShownChips(Number(chips) || 0)
  }, [chips])

  const countUp = (from, to) => {
    if (counting.current) clearInterval(counting.current)
    if (still || to <= from) {
      setShownChips(to)
      settledChips.current = to
      holding.current = false
      return
    }
    const started = Date.now()
    counting.current = setInterval(() => {
      const share = Math.min(1, (Date.now() - started) / 1000)
      setShownChips(Math.round(from + (to - from) * share))
      if (share >= 1) {
        clearInterval(counting.current)
        counting.current = null
        settledChips.current = to
        holding.current = false
      }
    }, 40)
  }

  // A new result runs the whole mechanical sequence; an old one (a poll, a remount) only lands.
  useEffect(() => {
    const stamp = SM_stamp(result)
    if (!stamp || stamp === seen.current) return
    const first = !seen.current
    seen.current = stamp
    const stops = SM_stopsFor(result, info)
    const targets = stops.map((stop, reel) => {
      const size = Math.max(strips[reel].length, 1)
      return SM_BASE_COPY * size + SM_topIndex(stop, rows, size)
    })
    const wins = (result && result.wins) || []
    timers.current.forEach(clearTimeout)
    timers.current = []
    // A new result supersedes whatever was still celebrating. Clearing the overlay is enough: its
    // deadline timer lives in the effect above and React cancels it when the state changes.
    setCelebrate(null)
    setLit(0)
    setShownWins([])
    setCoins([])
    setRise(null)
    setJackpot(false)
    gamesSound('spin')
    if (first || still || (result && result.machine && result.machine !== info.id)) {
      setMoving(strips.map(() => 0))
      setPositions(targets)
      return
    }
    holding.current = true
    // 1. The lever drops and the reels kick up a little: the anticipation before the run.
    setLever(true)
    later(() => setLever(false), 380)
    setMoving(strips.map(() => SM_KICK_MS))
    setPositions(current => current.map(position => position - 0.3))
    // 2. The run: each column kicks off a beat after the one before it, travels two-plus
    //    turns and lands on its own stop, so the reels are seen stopping one at a time.
    const landAt = strips.map((strip, reel) => {
      const size = Math.max(strip.length, 1)
      const duration = SM_STOP_MS[Math.min(reel, SM_STOP_MS.length - 1)]
      const start = SM_KICK_MS + reel * SM_STAGGER_MS
      later(() => {
        setMoving(previous => previous.map((value, index) => (index === reel ? duration : value)))
        setPositions(previous => previous.map((value, index) => (index === reel ? targets[reel] + (2 + reel) * size : value)))
        later(() => gamesSound('move'), duration)
      }, start)
      return start + duration
    })
    const landed = landAt.length ? Math.max(...landAt) : SM_KICK_MS
    // 3. Quietly move each reel back to the home copy of its strip: same picture, no motion.
    //    A short hold first, so the last stop is readable before it settles.
    later(() => {
      setMoving(strips.map(() => 0))
      setPositions(targets)
    }, landed + 160)
    // 4. Wins: paylines light one by one, then the payout rises and the coins fall.
    const payout = Number((result && result.payout) || 0)
    if (wins.length) {
      setShownWins(wins)
      wins.forEach((_, index) => later(() => setLit(index + 1), landed + 120 + index * SM_LINE_MS))
      const paid = landed + 120 + wins.length * SM_LINE_MS
      later(() => {
        const big = Boolean(result && result.jackpot)
        setJackpot(big)
        // Sound and spectacle grow with the win, tier by tier: the chime for a small one, coins for
        // anything real, and for a jackpot an alarm and twenty seconds of ching-ching (owner's ask,
        // 2026-11-09).
        const wager = Math.max(1, Number(bet) || 25)
        const scale = Math.max(0.5, Math.min(3, payout / wager))
        const tier = SM_tierFor(payout)
        gamesSound(big ? 'jackpot' : 'win', { scale })
        if (tier.alarm) gamesSound('alarm', { times: tier.alarm })
        // The machine's own payout chime: a few dings for a small win, a long run for a jackpot.
        const dings = payout >= 10000 ? 24 : (payout >= 1000 ? 14 : (payout >= 500 ? 9 : (payout >= 100 ? 5 : 3)))
        gamesSound('payout', { times: dings, rate: payout >= 1000 ? 0.12 : 0.16, scale })
        if (payout > 0) gamesSound('ching', { times: tier.coins, seconds: tier.seconds * 0.9, scale })
        const show = big || payout >= wager * 4 || payout >= 100
        if (show) {
          // How long the coins may fall. A normal win never outlasts 10 s; the jackpot is allowed up
          // to five minutes, and the ✕ on the overlay ends either at once (owner's rule, 2026-11-09).
          const hold = big ? Math.min(300, Math.max(20, tier.seconds)) : Math.min(10, tier.seconds)
          setCelebrate({ payout, big, tier, until: Date.now() + hold * 1000, rainSeconds: hold })
        }
        setRise(`+${SM_chips(payout)}`)
        const count = big ? 60 : Math.min(30, 10 + Math.round(payout / 20))
        setCoins(Array.from({ length: count }, (_, index) => ({
          key: `${stamp}-${index}`,
          left: 30 + Math.random() * 40,
          dx: (Math.random() - 0.5) * 260,
          up: -(80 + Math.random() * 160),
          delay: Math.random() * 500,
          spin: 900 + Math.random() * 700
        })))
        const after = Number(result.chips || 0) || settledChips.current + payout
        countUp(after - payout, after)
      }, paid)
      later(() => { setCoins([]); setRise(null) }, paid + 2600)
      if (result && result.jackpot) later(() => setJackpot(false), paid + 5200)
    } else {
      later(() => countUp(Number((result && result.chips) || settledChips.current), Number((result && result.chips) || settledChips.current)), landed)
    }
  }, [SM_stamp(result), info.id])

  // ---- drawing ----
  const windowW = reelWidth * strips.length
  const windowH = cell * rows
  // The cabinet is as wide as its reels, the shape 9433891 drew (measured then: 284 px of cabinet
  // around 235 px of reels; the reels filled 71% of it). Everything the machine prints - the pay
  // strip on the glass and the points card - wraps inside that width instead of stretching the
  // cabinet: the points card's sentences had grown it to 852 px against 274 px of reels, which is
  // the elongated cabinet with the reels small at the left (owner's report, 2026-11-10). Measured
  // here: the deck is the window plus its own border, the line markers and the row's gaps.
  const deckW = windowW + 2 * (SM_px(4) * 2 + SM_px(16))
  const winCells = new Set()
  shownWins.slice(0, lit).forEach(win => (win.rows || []).forEach((row, reel) => winCells.add(`${row}-${reel}`)))
  const rewardInfo = SM_rewardFields(rewards)
  const cashIn = async () => {
    if (!rewardInfo || rewardInfo.reward <= 0 || cashBusy || typeof onCashin !== 'function') return
    setCashBusy(true)
    try {
      const answer = await onCashin()
      const cashed = Number(answer && answer.cashed)
      if (Number.isFinite(cashed) && cashed > 0) {
        setCashFlash(`+${SM_chips(cashed)} chips`)
        setRise(`+${SM_chips(cashed)} chips`)
        later(() => setCashFlash(''), 2200)
        later(() => setRise(null), 2200)
      }
    } catch {
      // The parent says why on its own note; the row simply stays put.
    } finally {
      setCashBusy(false)
    }
  }

  // How many points the chosen slice spends, in whole blocks of four, and what it buys.
  const cashWant = Math.floor((Number(rewardInfo && rewardInfo.points) || 0) * cashShare / 4) * 4
  const cashGain = Math.floor(cashWant / 4) * 3
  // One function, an explicit number of points: the share buttons above use the chosen slice, and the
  // "not enough chips" row asks for exactly one spin's worth (found 2026-11-10: at 20 chips against a
  // 25 bet the table greyed SPIN and every rung with nothing on screen saying why).
  const cashPointsFor = async want => {
    if (!rewardInfo || want < 4 || cashBusy || typeof onPoints !== 'function') return
    setCashBusy(true)
    try {
      const answer = await onPoints(want)
      const cashed = Number(answer && (answer.points_cashed != null ? answer.points_cashed : answer.cashed))
      if (Number.isFinite(cashed) && cashed > 0) {
        setCashFlash(`+${SM_chips(cashed)} chips`)
        setRise(`+${SM_chips(cashed)} chips`)
        later(() => setCashFlash(''), 2200)
        later(() => setRise(null), 2200)
      }
    } catch {
      // The parent says why on its own note; the row simply stays put.
    } finally {
      setCashBusy(false)
    }
  }
  const cashPoints = () => cashPointsFor(cashWant)

  // An easter egg, when one is out and this person has not found it. It is deliberately quiet -
  // a small mark on the cabinet that brightens under the cursor - because a find should feel like
  // noticing something, not like a button the game pushed at you (owner's ask, 2026-11-09).
  const eggNow = (rewards && rewards.egg) || null
  const takeEgg = async () => {
    if (!eggNow || typeof onEgg !== 'function' || cashBusy) return
    setCashBusy(true)
    try {
      const answer = await onEgg(eggNow.id)
      const points = Number(answer && answer.points) || 0
      if (answer && answer.claimed && points > 0) {
        // A find is worth seeing: a short full-screen reveal with a burst, then it gets out of the
        // way by itself (owner's ask, 2026-11-09: "when user finds an easter egg it should tell them
        // and show an animation").
        setEggHit({ points, id: eggNow.id })
        later(() => setEggHit(null), 5200)
        setCashFlash(`+${SM_chips(points)} points`)
        setRise(`+${SM_chips(points)} points`)
        later(() => setCashFlash(''), 2600)
        later(() => setRise(null), 2600)
      }
    } catch {
      // A refused claim says nothing: the egg is either gone or already found.
    } finally {
      setCashBusy(false)
    }
  }

  // The comeback tap. Three shots, each measured against a 1.1 s sweep that matches the marker's
  // CSS animation exactly (a sawtooth, not an easing curve), so what the eye sees is what the
  // grade is computed from. Close enough counts, and coming back another day multiplies the stack.
  const BO_PERIOD = 1100
  const boTap = () => {
    if (!lodder) return
    const phase = ((Date.now() - lodder.t0) % BO_PERIOD) / BO_PERIOD
    const marks = [...lodder.marks, phase]
    if (marks.length < 3) {
      setLodder({ ...lodder, marks })
      return
    }
    const off = marks.map(point => Math.abs(point - 0.5))
    const grade = off.every(d => d <= 0.06) ? 'perfect' : (off.every(d => d <= 0.18) ? 'good' : 'miss')
    setLodder(null)
    setBailoutBusy(true)
    Promise.resolve(typeof onBailout === 'function' ? onBailout(grade) : null)
      .then(answer => {
        const result = (answer && answer.bailout_result) || {}
        setBailoutResult({ grade, given: Number(result.given) || 0, came: Number(result.comeback) || 0 })
      })
      .catch(() => setBailoutResult({ grade, given: 0, came: 0 }))
      .finally(() => setBailoutBusy(false))
  }

  const reelColumns = strips.map((strip, reel) => {
    const size = Math.max(strip.length, 1)
    const copies = SM_copiesFor(strips.length)
    const cells = []
    for (let copy = 0; copy < copies; copy += 1) {
      strip.forEach((symbol, index) => cells.push({ symbol, key: `${copy}-${index}` }))
    }
    const position = positions[reel] == null ? SM_BASE_COPY * size : positions[reel]
    const duration = moving[reel] || 0
    return jsx('div', {
      'data-sm-reel': reel,
      style: {
        position: 'relative', width: reelWidth, height: windowH, overflow: 'hidden',
        background: smLook('window', 'linear-gradient(90deg, #d6d3d1 0%, #fafaf9 18%, #ffffff 50%, #fafaf9 82%, #d6d3d1 100%)'),
        borderLeft: reel ? `${SM_px(2)}px solid ${smLook('divider', '#44403c')}` : 'none'
      },
      children: jsx('div', {
        style: {
          position: 'absolute', left: 0, right: 0, top: 0,
          transform: `translateY(${-position * cell}px)`,
          transition: duration ? `transform ${duration}ms cubic-bezier(0.18, 0.72, 0.28, 1.06)` : 'none',
          // Only a reel that is actually in flight is blurred, so a landed column reads clearly.
          filter: duration > SM_KICK_MS ? 'blur(1.2px)' : 'none',
          willChange: 'transform'
        },
        children: cells.map((item, index) => {
          const row = index - Math.round(position)
          const winning = row >= 0 && row < rows && winCells.has(`${row}-${reel}`)
          return jsx('div', {
            style: {
              height: cell, display: 'flex', alignItems: 'center', justifyContent: 'center',
              animation: winning ? 'sm-pulse 520ms ease-in-out infinite' : 'none',
              background: winning ? 'rgba(250,204,21,0.35)' : 'transparent'
            },
            children: SM_symbol(item.symbol, cell, winning && item.symbol === 'NOUS')
          }, item.key)
        })
      })
    }, `reel-${reel}`)
  })

  const lines = (info.lines || []).map((line, index) => ({ ...line, index }))
  const paylineSvg = jsx('svg', {
    width: windowW, height: windowH, viewBox: `0 0 ${windowW} ${windowH}`,
    style: { position: 'absolute', left: 0, top: 0, pointerEvents: 'none' },
    children: shownWins.slice(0, lit).map((win, index) => jsx('polyline', {
      points: (win.rows || []).map((row, reel) => `${reel * reelWidth + reelWidth / 2},${row * cell + cell / 2}`).join(' '),
      fill: 'none', stroke: smAccent(), strokeWidth: SM_px(2.5), strokeLinecap: 'round', strokeLinejoin: 'round',
      // Light enough that the symbol underneath stays the thing you see: a thick glowing stroke lay
      // across the reels hid the Nous mark and the wing, which are the jackpot faces
      // (owner's report, 2026-11-09: "put paylines on lighter background hard to see nous images").
      opacity: 0.6, strokeDasharray: `${SM_px(6)} ${SM_px(4)}`, mixBlendMode: 'screen',
      style: { filter: `drop-shadow(0 0 ${SM_px(2)}px ${smLook('glow', 'rgba(250,204,21,0.55)')})` }
    }, `line-${index}`))
  })

  const markers = side => jsx('div', {
    style: { display: 'flex', flexDirection: 'column', justifyContent: 'space-around', height: windowH, width: SM_px(16) },
    children: lines.map(line => jsx('span', {
      title: line.name,
      style: {
        fontSize: SM_px(9), fontWeight: 800, textAlign: 'center', borderRadius: SM_px(3),
        color: shownWins.slice(0, lit).some(win => win.line === line.index)
          ? smLook('markerActiveText', '#111') : smLook('markerText', '#fde68a'),
        background: shownWins.slice(0, lit).some(win => win.line === line.index)
          ? smLook('markerActiveBg', smAccent()) : smLook('markerBg', 'rgba(0,0,0,0.35)')
      },
      children: String(line.index + 1)
    }, `${side}-${line.index}`))
  })

  const bulbs = jsx('div', {
    style: { display: 'flex', justifyContent: 'space-between', padding: `0 ${SM_px(6)}px` },
    children: Array.from({ length: compact ? 10 : 14 }, (_, index) => jsx('span', {
      style: {
        width: SM_px(7), height: SM_px(7), borderRadius: '50%', background: smLook('bulb', '#fde68a'), boxShadow: `0 0 ${SM_px(6)}px ${smLook('bulbGlow', '#fbbf24')}`,
        animation: jackpot ? 'sm-blink 220ms steps(1) infinite' : `sm-chase 1.2s ease-in-out ${index * 0.1}s infinite`
      }
    }, `bulb-${index}`))
  })

  const leverEl = jsxs('div', {
    'data-sm-lever': '1',
    'aria-hidden': true,
    style: { position: 'absolute', right: -SM_px(22), top: compact ? SM_px(40) : SM_px(54), width: SM_px(18), height: windowH + SM_px(10) },
    children: [
      jsx('div', {
        style: {
          position: 'absolute', left: SM_px(6), top: 0, width: SM_px(6), height: (windowH + SM_px(10)) * 0.7,
          background: smLook('lever', SM_CHROME), borderRadius: SM_px(3), transformOrigin: '50% 100%',
          transform: lever ? `rotateX(160deg) translateY(-${SM_px(6)}px) scaleY(0.25)` : 'none',
          transition: lever ? 'transform 160ms ease-in' : 'transform 420ms cubic-bezier(0.3, 1.6, 0.5, 1)'
        },
        children: jsx('div', {
          style: { position: 'absolute', left: -SM_px(6), top: -SM_px(14), width: SM_px(18), height: SM_px(18), borderRadius: '50%', background: smLook('leverKnob', 'radial-gradient(circle at 35% 35%, #fca5a5, #b91c1c 70%)') }
        })
      }),
      jsx('div', { style: { position: 'absolute', left: SM_px(2), bottom: 0, width: SM_px(14), height: SM_px(14), borderRadius: SM_px(4), background: smLook('lever', SM_CHROME) } })
    ]
  })

  const coinLayer = jsx('div', {
    'aria-hidden': true,
    style: { position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' },
    children: coins.map(coin => jsx('span', {
      style: {
        position: 'absolute', left: `${coin.left}%`, bottom: SM_px(18), width: SM_px(16), height: SM_px(16), borderRadius: '50%',
        background: 'radial-gradient(circle at 35% 30%, #fef9c3, #facc15 45%, #a16207 100%)',
        border: `${SM_px(1)}px solid #854d0e`, '--sm-dx': `${coin.dx}px`, '--sm-up': `${coin.up}px`,
        animation: `sm-coin ${coin.spin}ms cubic-bezier(0.2, 0.6, 0.4, 1) ${coin.delay}ms both`
      }
    }, coin.key))
  })

  const closeButton = jsx('button', {
    type: 'button',
    'aria-label': 'Close',
    onClick: () => onClose && onClose(),
    style: {
      position: 'absolute', top: -SM_px(10), right: -SM_px(10), width: SM_px(24), height: SM_px(24), padding: 0,
      borderRadius: '50%', border: 'none', background: 'rgba(15,10,30,0.92)', color: '#f8fafc',
      fontSize: SM_px(16), lineHeight: `${SM_px(24)}px`, textAlign: 'center', cursor: 'pointer', pointerEvents: 'auto'
    },
    children: '×'
  })

  const showToggle = jsxs('label', {
    title: 'Show the slot machine in the middle of my screen',
    style: {
      position: 'absolute', bottom: SM_px(6), right: SM_px(8), display: 'flex', alignItems: 'center', gap: SM_px(4),
      fontSize: SM_px(11), color: smLook('control', '#fde68a'), cursor: 'pointer', pointerEvents: 'auto'
    },
    children: [
      jsx('input', {
        type: 'checkbox',
        checked: true,
        onChange: event => { if (!event.target.checked) onShow && onShow(false) }
      }),
      jsx('span', { children: 'Show' })
    ]
  })

  const checkbox = (label, checked, onChange, title) => jsxs('label', {
    title,
    style: { display: 'flex', alignItems: 'center', gap: SM_px(6), fontSize: SM_px(12), color: smLook('control', '#fde68a'), cursor: 'pointer', pointerEvents: 'auto' },
    children: [
      jsx('input', { type: 'checkbox', checked: Boolean(checked), onChange: event => onChange && onChange(event.target.checked) }),
      jsx('span', { children: label })
    ]
  })

  const counter = (label, value) => jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: SM_px(64) },
    children: [
      jsx('span', { style: { fontSize: SM_px(10), letterSpacing: SM_px(1), textTransform: 'uppercase', color: smLook('label', '#fcd34d') }, children: label }),
      jsx('span', { style: { fontFamily: 'ui-monospace, monospace', fontSize: compact ? SM_px(15) : SM_px(18), fontWeight: 800, color: smLook('counterText', '#fef3c7'), background: smLook('counterBg', '#1c1917'), padding: `${SM_px(1)}px ${SM_px(8)}px`, borderRadius: SM_px(4), border: `${SM_px(1)}px solid ${smLook('counterBorder', '#78350f')}` }, children: value })
    ]
  })

  // How the win's coin rain is timed. It runs for the celebration's own length and then stops, so the
  // shower is sized by the win (up to 10 s normally, up to 5 minutes for a jackpot) instead of raining
  // for ever. The count is fixed at the moment of the win: recomputing it while the overlay counts
  // chips would restart the animation on every render.
  // The score bar's step: every POINT_STEP points is one mark on the ranking, so the bar shows how
  // far the person has come since the last mark and how far the next one is. Points never drop
  // except by spending them, so the bar only ever moves forward.
  const pointProgress = (() => {
    const points = Math.max(0, Number(rewardInfo && rewardInfo.points) || 0)
    const left = POINT_STEP - (points % POINT_STEP || 0)
    const next = points + left
    const pct = Math.max(0, Math.min(100, Math.round(100 * (points % POINT_STEP) / POINT_STEP)))
    return { points, left, next, now: points % POINT_STEP, pct }
  })()

  const rainDur = celebrate && celebrate.tier.chips >= 1000 ? 2.4 : 1.8
  const rainRuns = celebrate ? Math.max(1, Math.ceil((Number(celebrate.rainSeconds) || 0) / rainDur)) : 0

  return jsxs('div', {
    className: 'sm-machine',
    ref: cabinetRef,
    'data-slot-machine': info.id,
    'data-sm-cells': strips.length * rows,
    style: {
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: SM_px(8),
      position: 'relative', maxWidth: '100%', boxSizing: 'border-box'
    },
    children: [
      jsx('style', { children: SM_STYLE }),
      // A found egg says so, loudly and briefly: a burst of sparks, the points, and a line telling the
      // person there are more. Drawn as a fixed layer with pointer-events off, so it can never block
      // a click and can never leave the machine in a state a reload has to fix (owner's ask,
      // 2026-11-09: "when user finds an easter egg it should tell them and show an animation").
      eggHit ? jsxs('div', {
        'data-sm-eggs-found': '1',
        role: 'status',
        'aria-live': 'polite',
        style: { position: 'fixed', inset: 0, zIndex: 81, pointerEvents: 'none', overflow: 'hidden' }
      }, { children: [
        ...Array.from({ length: 14 }, (_, index) => {
          const angle = (index / 14) * Math.PI * 2
          const reach = 90 + (index % 3) * 46
          return jsx('span', {
            'aria-hidden': true,
            style: {
              position: 'absolute', left: '50%', top: '42%', width: SM_px(8), height: SM_px(8),
              borderRadius: '50%', background: index % 3 === 0 ? smAccent() : SM_GOLD,
              '--sm-ex': `${Math.round(Math.cos(angle) * reach)}px`,
              '--sm-ey': `${Math.round(Math.sin(angle) * reach)}px`,
              animation: `sm-egg-spark 1.5s ease-out ${index * 40}ms forwards`
            }
          }, `eggspark-${index}`)
        }),
        jsxs('div', {
          style: {
            position: 'absolute', left: '50%', top: '42%', textAlign: 'center',
            animation: 'sm-egg-pop 5.2s ease-out forwards'
          },
          children: [
            jsx('div', {
              style: {
                fontFamily: 'Georgia, serif', fontWeight: 900, letterSpacing: SM_px(3),
                color: SM_GOLD, fontSize: 'clamp(26px, 6vw, 64px)',
                textShadow: `0 0 ${SM_px(30)}px rgba(250,204,21,0.9), 0 ${SM_px(4)}px 0 #7f1d1d`
              },
              children: 'EASTER EGG!'
            }),
            jsx('div', {
              style: { marginTop: SM_px(6), fontWeight: 900, fontSize: 'clamp(16px, 3vw, 30px)', color: '#fff', textShadow: `0 ${SM_px(2)}px ${SM_px(8)}px #000` },
              children: `+${SM_chips(eggHit.points)} points`
            }),
            jsx('div', {
              style: { marginTop: SM_px(4), fontSize: SM_px(12), color: smLook('counterText', '#fef3c7'), opacity: 0.85 },
              children: 'Added to your score — there are more hiding.'
            })
          ]
        })
      ] }) : null,
      // The jackpot alarm's light: the whole screen blinks gold for a second or two. It is fixed,
      // pointer-transparent and takes no focus, so the person can keep typing while it flashes.
      celebrate && celebrate.tier.chips >= 1000 ? jsx('div', {
        'data-sm-flash': celebrate.tier.chips >= 10000 ? 'jackpot' : 'huge',
        'aria-hidden': true,
        style: {
          position: 'fixed', inset: 0, zIndex: 79, pointerEvents: 'none',
          background: 'radial-gradient(circle at 50% 40%, rgba(250,204,21,0.55), rgba(250,204,21,0.12) 55%, rgba(0,0,0,0) 75%)',
          animation: `sm-screenflash ${celebrate.tier.chips >= 10000 ? 0.9 : 0.7}s ease-out ${celebrate.tier.chips >= 10000 ? 4 : 2}`
        }
      }, 'flash') : null,
      // A win big enough to matter takes the whole screen: huge letters and a rain of coins.
      celebrate ? jsxs('div', {
        'data-sm-celebrate': celebrate.big ? 'jackpot' : 'win',
        'data-sm-tier': String(celebrate.tier.chips),
        role: 'status',
        'aria-live': 'assertive',
        style: { position: 'fixed', inset: 0, zIndex: 80, pointerEvents: 'none', overflow: 'hidden' },
        children: [
          ...Array.from({ length: celebrate.tier.rain }, (_, index) => jsx('span', {
            'aria-hidden': true,
            style: {
              position: 'absolute', left: `${(index * 37) % 100}%`, top: 0,
              fontSize: celebrate.tier.chips >= 1000 ? 30 : (celebrate.tier.chips >= 200 ? 26 : 22),
              animation: `sm-rain ${rainDur}s linear ${(index % 17) * 0.09}s ${rainRuns} both`
            },
            children: index % 7 === 0 ? '💰' : '🪙'
          }, `rain-${index}`)),
          jsxs('div', {
            style: {
              position: 'absolute', left: '50%', top: '38%', textAlign: 'center',
              transform: 'translate(-50%, -50%)',
              animation: `sm-celebrate ${Math.max(2.9, Math.min(celebrate.tier.seconds, 19))}s ease-out forwards`
            },
            children: [
              jsx('div', {
                style: {
                  fontFamily: 'Georgia, serif', fontWeight: 900, color: SM_GOLD,
                  fontSize: celebrate.tier.chips >= 1000 ? 'clamp(48px, 13vw, 180px)' : 'clamp(30px, 8vw, 96px)',
                  letterSpacing: celebrate.tier.chips >= 1000 ? 6 : 3,
                  textShadow: '0 0 40px rgba(250,204,21,0.95), 0 8px 0 #7f1d1d'
                },
                children: celebrate.tier.name
              }),
              jsx('div', {
                style: { marginTop: SM_px(8), fontSize: 'clamp(16px, 3vw, 34px)', fontWeight: 900, color: '#fff', textShadow: `0 ${SM_px(2)}px ${SM_px(10)}px #000` },
                children: `+${SM_chips(celebrate.payout)} chips`
              })
            ]
          }),
          // The way out at any moment: a jackpot is allowed five minutes of rain, and the person
          // should never have to sit through it (owner's rule, 2026-11-09).
          jsx('button', {
            type: 'button',
            'data-sm-stop': '1',
            title: 'Stop the coins',
            onClick: () => setCelebrate(null),
            style: {
              position: 'absolute', top: SM_px(16), right: SM_px(16), pointerEvents: 'auto', cursor: 'pointer',
              width: SM_px(34), height: SM_px(34), borderRadius: '50%', fontWeight: 800, fontSize: SM_px(18),
              lineHeight: 1, color: '#fff', background: 'rgba(0,0,0,0.4)',
              border: `${SM_px(1)}px solid rgba(255,255,255,0.6)`
            },
            children: '×'
          })
        ]
      }) : null,
      (!bare || chat) && (machines || []).length > 1 ? jsx('div', {
        role: 'group',
        'aria-label': 'Pick a machine',
        style: {
          display: 'flex', flexWrap: 'nowrap', justifyContent: 'center', pointerEvents: 'auto',
          maxWidth: '100%', boxSizing: 'border-box', border: `1px solid ${smLook('edge', '#57534e')}`, borderRadius: SM_px(8),
          overflow: 'hidden'
        },
        children: machines.map((item, index) => jsx('button', {
          type: 'button',
          'data-sm-pick': item.id,
          'aria-pressed': item.id === info.id,
          disabled: busy,
          onClick: () => onPickMachine && onPickMachine(item.id),
          title: item.blurb || '',
          style: {
            flex: '1 1 0', minWidth: 0, padding: `${SM_px(4)}px ${SM_px(10)}px`,
            borderRadius: 0, fontSize: SM_px(12), fontWeight: 700, cursor: 'pointer',
            border: 'none', borderLeft: index ? `1px solid ${smLook('edge', '#57534e')}` : 'none',
            background: item.id === info.id ? smLook('trim', SM_GOLD) : smLook('controlBg', 'rgba(0,0,0,0.4)'),
            color: item.id === info.id ? smLook('markerActiveText', '#111') : smLook('control', '#e7e5e4'),
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
          },
          // Each machine draws its own chance when the plugin loads, so the picker still says what
          // this session holds — in a WORD, never in a percentage (owner's release rule,
          // 2026-11-11: the mechanics stay, the numbers go). Picking another machine is a real
          // choice, not a skin (owner's ask, 2026-11-09).
          children: jsxs('span', { style: { display: 'inline-flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.15 } }, { children: [
            jsx('span', { children: item.title }, 'name'),
            jsx('span', {
              'data-sm-mood': item.id,
              style: { fontSize: SM_px(9), fontWeight: 600, opacity: 0.85 },
              children: (() => {
                const session = item.session || {}
                return session.mood === 'bonus' ? 'bonus' : session.mood === 'cold' ? 'cold' : ''
              })()
            }, 'mood')
          ]})
        }, item.id))
      }) : null,
      jsxs('div', {
        style: {
          position: 'relative', padding: compact ? `${SM_px(10)}px ${SM_px(14)}px ${SM_px(12)}px` : `${SM_px(14)}px ${SM_px(20)}px ${SM_px(16)}px`, borderRadius: SM_px(18),
          background: smBody(),
          border: `${SM_px(4)}px solid ${smTrim()}`, boxShadow: `inset 0 ${SM_px(2)}px 0 rgba(255,255,255,0.25), 0 ${SM_px(10)}px ${SM_px(30)}px rgba(0,0,0,0.5)`,
          animation: jackpot ? 'sm-flash 600ms ease-in-out infinite' : 'none',
          // Equal margins either side: the lever hangs into the right one, so the cabinet itself
          // sits dead centre instead of being pushed left by the space reserved for the lever.
          marginLeft: SM_px(24), marginRight: SM_px(24),
          maxWidth: '100%', boxSizing: 'border-box'
        },
        children: [
          bulbs,
          eggNow ? (() => {
            // Some eggs are a picture with a word on it rather than a sparkle: the image and the word
            // come from the catalogue, so a new one is a row in shelf/eggs.py and nothing here.
            // The word is printed at full size on a pale plaque - readable from the cabinet, which is
            // the point of this one (owner's ask, 2026-11-09: "make the words clear on it about
            // rebellion").
            // A picture egg is drawn as the artwork itself, nothing printed over it: the Nous stamp
            // already carries its slogan, so adding a caption would only clutter it (owner's ask,
            // 2026-11-09: "just the nous image we use in the slots, no need to add anything it already
            // mentions the slogan on it"). An egg that does want a word still gets one.
            const art = eggNow.art && typeof SM_ART !== 'undefined' && SM_ART && SM_ART[eggNow.art]
            const word = eggNow.word || ''
            return jsxs('button', {
              type: 'button',
              'data-sm-egg': eggNow.id,
              title: eggNow.hint,
              'aria-label': `${word ? word + ': ' : ''}an easter egg — ${eggNow.hint}`,
              onClick: takeEgg,
              style: art
                ? {
                    position: 'absolute', top: SM_px(5), left: SM_px(7), display: 'inline-flex',
                    alignItems: 'center', gap: SM_px(5), padding: word ? `${SM_px(3)}px ${SM_px(9)}px ${SM_px(3)}px ${SM_px(4)}px` : 0,
                    width: word ? 'auto' : SM_px(30), height: SM_px(30), justifyContent: 'center',
                    borderRadius: SM_px(999), cursor: 'pointer', pointerEvents: 'auto',
                    background: 'radial-gradient(circle at 38% 32%, #ffffff 0%, #f5f5f4 60%, #d6d3d1 100%)',
                    border: `${SM_px(1)}px solid rgba(0,0,0,0.3)`,
                    boxShadow: `0 ${SM_px(2)}px ${SM_px(8)}px rgba(0,0,0,0.55), inset 0 0 0 ${SM_px(1)}px rgba(255,255,255,0.7)`,
                    opacity: 0.92, transition: 'opacity 160ms linear, transform 160ms linear'
                  }
                : {
                    position: 'absolute', top: SM_px(6), left: SM_px(8), padding: 0, width: SM_px(18), height: SM_px(18),
                    borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer',
                    color: smLook('control', '#fde68a'), opacity: 0.35, fontSize: SM_px(13), lineHeight: 1,
                    pointerEvents: 'auto', transition: 'opacity 160ms linear, transform 160ms linear'
                  },
              onMouseEnter: event => { event.currentTarget.style.opacity = '1'; event.currentTarget.style.transform = 'scale(1.08)' },
              onMouseLeave: event => { event.currentTarget.style.opacity = art ? '0.92' : '0.35'; event.currentTarget.style.transform = 'none' },
              children: art
                ? [
                    jsx('img', {
                      src: art, alt: '', draggable: false,
                      style: { width: SM_px(word ? 22 : 24), height: SM_px(word ? 22 : 24), objectFit: 'contain', borderRadius: '50%', pointerEvents: 'none' }
                    }, 'mark'),
                    word ? jsx('span', {
                      'data-sm-egg-word': '1',
                      style: {
                        fontWeight: 900, textTransform: 'uppercase', color: '#7f1d1d',
                        fontSize: SM_px(10), letterSpacing: SM_px(1.4), lineHeight: 1,
                        whiteSpace: 'nowrap', textShadow: '0 1px 0 rgba(255,255,255,0.9)'
                      },
                      children: word
                    }, 'word') : null
                  ]
                : '✦'
            }, 'egg-any')
          })() : null,
          jsx('div', {
            style: {
              textAlign: 'center', margin: `${SM_px(4)}px 0 ${SM_px(8)}px`, padding: `${SM_px(2)}px ${SM_px(10)}px`,
              borderRadius: SM_px(6), background: smLook('marqueeBg', 'transparent'),
              fontFamily: 'Georgia, serif', fontWeight: 900,
              fontSize: compact ? SM_px(16) : SM_px(22), letterSpacing: SM_px(2),
              color: smLook('marqueeText', smAccent()), textShadow: smLook('marqueeShadow', `0 0 ${SM_px(8)}px rgba(250,204,21,0.8), 0 ${SM_px(2)}px 0 #451a03`),
              animation: jackpot ? 'sm-blink 300ms steps(1) infinite' : 'none'
            },
            // The cabinet carries no name: the machine is just the machine. The name lives
            // where it is chosen, and a jackpot is the only word it ever says.
            children: jackpot ? 'JACKPOT!' : '\u00a0'
          }),
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: SM_px(4) },
            children: [
              markers('left'),
              jsxs('div', {
                style: { position: 'relative', display: 'flex', border: `${SM_px(4)}px solid ${smEdge()}`, borderRadius: SM_px(6), background: smShell(), boxShadow: smLook('windowShadow', `inset 0 ${SM_px(6)}px ${SM_px(12)}px rgba(0,0,0,0.6)`) },
                children: [
                  ...reelColumns,
                  paylineSvg,
                  // Glass: a soft glare and shade top and bottom, so the reels read as a drum behind a window.
                  jsx('div', {
                    'aria-hidden': true,
                    style: { position: 'absolute', inset: 0, pointerEvents: 'none', background: 'linear-gradient(180deg, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0) 22%, rgba(255,255,255,0.14) 48%, rgba(0,0,0,0) 78%, rgba(0,0,0,0.45) 100%)' }
                  }),
                  rise ? jsx('div', {
                    style: {
                      position: 'absolute', left: '50%', top: '40%', fontWeight: 900, fontSize: compact ? SM_px(22) : SM_px(30),
                      color: smLook('rise', smAccent()), textShadow: `0 ${SM_px(2)}px ${SM_px(6)}px #000`, animation: 'sm-rise 2.2s ease-out forwards', pointerEvents: 'none', whiteSpace: 'nowrap'
                    },
                    children: rise
                  }) : null
                ]
              }),
              markers('right')
            ]
          }),
          // The glass: what the machine pays, printed on the cabinet the way a real one does, so
          // the scoring is decoration rather than something to go looking for (owner's ask,
          // 2026-11-09: "similar decoration you see on slot machines showing how their points are
          // scored"). The full table is still behind the Scoring button; this is the headline.
          (paytable || []).length ? jsxs('div', {
            // Shown in the see-through copy too: the person asked for the same paylines and the same
            // points on the over-chat machine, not a stripped one (owner's ask, 2026-11-09).
            'data-sm-glass': '1',
            role: 'note',
            'aria-label': 'What this machine pays, in chips per line, across five lines',
            style: {
              display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center',
              gap: `${SM_px(2)}px ${SM_px(8)}px`, marginTop: SM_px(8),
              padding: `${SM_px(4)}px ${SM_px(8)}px`, borderRadius: SM_px(8),
              // Never wider than the reels it sits under: this strip is printed on the cabinet, and
              // a printed line does not decide how wide the cabinet is (see deckW).
              maxWidth: deckW, boxSizing: 'border-box',
              background: smLook('glassBg', 'rgba(0,0,0,0.42)'),
              border: `${SM_px(1)}px solid ${smLook('edge', '#57534e')}`,
              boxShadow: `inset 0 ${SM_px(1)}px 0 rgba(255,255,255,0.18)`,
              color: smLook('glassText', '#fde68a'), fontSize: SM_px(10), lineHeight: 1.3
            },
            children: (() => {
              // The three biggest pays, then the smallest one that still pays something: enough to
              // read at a glance, short enough to stay a strip rather than a table.
              const paid = paytable.filter(row => Number(row.payout) > 0)
              const top = paid.slice(0, 3)
              const last = paid[paid.length - 1]
              const shown = top.length && last && !top.includes(last) ? [...top, last] : top
              return [
                jsx('span', {
                  'data-sm-glass-lines': '1',
                  style: { fontWeight: 800, letterSpacing: SM_px(0.4), textTransform: 'uppercase', opacity: 0.85 },
                  children: 'per line · 5 lines'
                }, 'lines'),
                ...shown.map((row, index) => jsxs('span', {
                style: { display: 'inline-flex', alignItems: 'center', gap: SM_px(3), whiteSpace: 'nowrap' },
                children: [
                  jsx('span', { style: { display: 'inline-flex' }, children: SM_symbolRun(row.symbol, SM_px(16)) }, 'sym'),
                  jsx('b', {
                    style: {
                      color: index === 0 ? smAccent() : smLook('glassPay', '#fff'),
                      fontFamily: 'ui-monospace, monospace'
                    },
                    children: SM_chips(Number(row.payout) || 0)
                  }, 'pay')
                ]
              }, `glass-${index}`))
              ]
            })()
          }) : null,
          leverEl,
          jsxs('div', {
            style: { display: 'flex', justifyContent: 'space-around', alignItems: 'flex-end', marginTop: SM_px(10), gap: SM_px(6) },
            children: [
              counter('Chips', SM_chips(shownChips)),
              counter('Bet', SM_chips(bet || 0)),
              counter('Last win', SM_chips(Number((result && result.payout) || 0)))
            ]
          }),
          rewardInfo ? jsxs('div', {
            'data-sm-rewards': '1',
            'data-sm-points': String(rewardInfo.points),
            title: `You earn 10 points for every 1,000,000 tokens your chats use, in and out, and 100 more for every game you win. Four points turn into three chips.`,
            style: {
              // A loyalty card rather than a line of small print: the balance is the headline, what it
              // is worth sits beside it, and the earning rule is a footnote under a progress bar
              // (owner's ask, 2026-11-09: "make the point advertising more clear and look nicer").
              display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center',
              gap: `${SM_px(4)}px ${SM_px(8)}px`, marginTop: SM_px(8),
              padding: `${SM_px(6)}px ${SM_px(10)}px`, borderRadius: SM_px(10),
              background: `linear-gradient(180deg, ${smLook('cardTop', 'rgba(250,204,21,0.14)')}, ${smLook('cardBottom', 'rgba(0,0,0,0.45)')})`,
              color: smLook('counterText', '#fef3c7'),
              border: `${SM_px(1)}px solid ${smLook('cardEdge', 'rgba(250,204,21,0.45)')}`,
              boxShadow: `inset 0 ${SM_px(1)}px 0 rgba(255,255,255,0.16)`,
              fontSize: SM_px(10), lineHeight: 1.35, textAlign: 'center', pointerEvents: 'auto',
              // The card is mounted ON the cabinet: it wraps inside the width of the reels rather
              // than setting the cabinet's width from the length of its own sentences (see deckW).
              maxWidth: deckW, boxSizing: 'border-box'
            },
            children: [
              jsxs('span', {
                style: { display: 'inline-flex', alignItems: 'baseline', gap: SM_px(6), width: '100%', justifyContent: 'center' },
                children: [
                  jsx('span', {
                    'data-sm-points-line': '1',
                    style: {
                      fontFamily: 'ui-monospace, monospace', fontWeight: 900,
                      fontSize: SM_px(compact ? 20 : 26), color: smLook('pointsBig', '#fde68a'),
                      textShadow: `0 ${SM_px(2)}px 0 rgba(0,0,0,0.55)`
                    },
                    children: SM_chips(rewardInfo.points)
                  }, 'balance'),
                  jsx('span', {
                    style: { fontWeight: 800, letterSpacing: SM_px(1), textTransform: 'uppercase', opacity: 0.9 },
                    children: 'points'
                  }, 'word'),
                  jsx('span', {
                    'data-sm-points-worth': '1',
                    style: { color: smLook('pointsWorth', '#fca5a5'), fontWeight: 700 },
                    children: rewardInfo.points_chips > 0
                      ? `= ${SM_chips(rewardInfo.points_chips)} chips`
                      : '· 4 points = 3 chips'
                  }, 'worth')
                ]
              }, 'headline'),
              jsx('span', {
                'data-sm-tokens-line': '1',
                style: { width: '100%', opacity: 0.9 },
                children: `10 points for every 1M tokens in + out · ${SM_chips(rewardInfo.tokens_total)} used`
              }, 'rule'),
              jsxs('span', {
                style: { display: 'inline-flex', alignItems: 'center', gap: SM_px(6), width: '100%', justifyContent: 'center' },
                children: [
                  jsx('span', {
                    'data-sm-point-progress': '1',
                    role: 'progressbar',
                    'aria-valuemin': 0,
                    'aria-valuemax': POINT_STEP,
                    'aria-valuenow': pointProgress.now,
                    'data-sm-point-pct': String(pointProgress.pct),
                    // The bar tracks the leaderboard score, not the token remainder: the remainder
                    // fills and empties every few seconds while Hermes talks, so a bar tied to it
                    // flickered from empty to full and read as broken (owner's report, 2026-11-09:
                    // "watch the bar graph on the slots it seems not to be working"). Points only go
                    // up until they are spent, so this one moves in one direction and means something.
                    title: `${SM_chips(rewardInfo.points)} points · ${SM_chips(pointProgress.left)} to ${SM_chips(pointProgress.next)}`,
                    style: {
                      width: SM_px(compact ? 96 : 130), height: SM_px(5), borderRadius: SM_px(999),
                      background: 'rgba(255,255,255,0.18)', overflow: 'hidden', display: 'inline-block'
                    },
                    children: jsx('span', {
                      style: {
                        display: 'block', height: '100%', borderRadius: SM_px(999),
                        width: `${pointProgress.pct}%`,
                        background: smAccent(), transition: 'width 240ms linear'
                      }
                    })
                  }, 'bar'),
                  jsx('span', {
                    style: { opacity: 0.85 },
                    // Plain English, because "500 to 500 points" is what the first version printed at
                    // a zero balance and it means nothing (owner's question, 2026-11-09).
                    children: pointProgress.points === 0
                      ? `first mark at ${SM_chips(pointProgress.next)} points`
                      : (pointProgress.left === POINT_STEP
                        ? `next mark at ${SM_chips(pointProgress.next)} points`
                        : `${SM_chips(pointProgress.left)} more to ${SM_chips(pointProgress.next)} points`)
                  }, 'next')
                ]
              }, 'progress'),
              rewardInfo.reward > 0 ? jsx('span', {
                style: { opacity: 0.75 },
                children: `${SM_chips(rewardInfo.reward)} old reward chips`
              }) : null,
          rewardInfo.reward > 0 ? jsx('span', {
                style: { opacity: 0.75 },
                children: `· ${SM_chips(rewardInfo.reward)} old reward chips`
              }) : null,
              jsx('button', {
                type: 'button',
                'data-sm-cashin': '1',
                disabled: rewardInfo.reward <= 0 || cashBusy,
                onClick: cashIn,
                style: {
                  padding: `${SM_px(1)}px ${SM_px(8)}px`, borderRadius: SM_px(999), fontWeight: 800,
                  fontSize: SM_px(10), cursor: rewardInfo.reward <= 0 || cashBusy ? 'default' : 'pointer',
                  border: `${SM_px(1)}px solid ${smLook('spinRim', '#d9a441')}`,
                  background: rewardInfo.reward <= 0 || cashBusy ? '#d6d3d1' : smLook('cashBg', smLook('betSelectedBg', '#ef6f5e')),
                  color: rewardInfo.reward <= 0 || cashBusy ? '#44403c' : smLook('cashText', smLook('betSelectedText', '#2a120d'))
                },
                children: 'Cash in'
              }),
              // The way back from a bad run: points never depend on the cards or the reels, so a
              // losing streak cannot lock the person out of the machines (owner's ask, 2026-11-09).
              // How much of the score to spend is the person's call.
              jsxs('span', {
                'data-sm-cash-share': '1',
                style: { display: 'inline-flex', alignItems: 'center', gap: SM_px(3) },
                children: [
                  jsx('span', { style: { opacity: 0.7, fontSize: SM_px(9) }, children: 'spend' }, 'label'),
                  ...[0.25, 0.5, 1].map(share => jsx('button', {
                    type: 'button',
                    'data-sm-cash-part': String(share),
                    onClick: () => setCashShare(share),
                    title: share === 1
                      ? 'Spend the whole score'
                      : `Spend ${share === 0.25 ? 'a quarter' : 'half'} of the score, keeping the rest for the leaderboard`,
                    style: {
                      padding: `${SM_px(0.5)}px ${SM_px(5)}px`, borderRadius: SM_px(999), cursor: 'pointer',
                      fontSize: SM_px(9), fontWeight: 800,
                      border: `${SM_px(1)}px solid ${smLook('spinRim', '#d9a441')}`,
                      background: cashShare === share ? smLook('betSelectedBg', '#ef6f5e') : 'transparent',
                      color: cashShare === share ? smLook('betSelectedText', '#2a120d') : smLook('label', '#fcd34d')
                    },
                    children: share === 1 ? 'all' : share === 0.5 ? 'half' : '¼'
                  }, `share-${share}`))
                ]
              }),
              jsx('button', {
                type: 'button',
                'data-sm-points-cash': '1',
                disabled: cashWant < 4 || cashBusy,
                onClick: cashPoints,
                title: cashWant >= 4
                  ? `Turn ${SM_chips(cashWant)} points into ${SM_chips(cashGain)} chips (four points buy three chips). The points you keep still count for the leaderboard.`
                  : 'You need 4 points to turn them into chips. Points come from chat use and from games you win.',
                style: {
                  padding: `${SM_px(1)}px ${SM_px(8)}px`, borderRadius: SM_px(999), fontWeight: 800,
                  fontSize: SM_px(10), cursor: cashWant < 4 || cashBusy ? 'default' : 'pointer',
                  border: `${SM_px(1)}px solid ${smLook('spinRim', '#d9a441')}`,
                  background: cashWant < 4 || cashBusy ? '#d6d3d1' : smLook('cashBg', smLook('betSelectedBg', '#ef6f5e')),
                  color: cashWant < 4 || cashBusy ? '#44403c' : smLook('cashText', smLook('betSelectedText', '#2a120d'))
                },
                children: cashWant >= 4
                  ? `${SM_chips(cashWant)} pts → ${SM_chips(cashGain)} chips`
                  : 'Points → chips'
              }),
              cashFlash ? jsx('span', {
                'data-sm-cashed': '1',
                style: { color: smLook('label', '#fcd34d'), fontWeight: 800 },
                children: cashFlash
              }) : null
            ]
          }) : null,
          // The comeback ladder: when the wallet cannot cover a bet, the machine offers a skill
          // shot instead of a dead table. Three taps on a sweeping bar, graded, and the grade picks
          // the stack; a streak that grows on returning another day, and ten premium spins after.
          (() => {
            const bo = rewards && rewards.bailout
            if (!bo) return null
            const broke = Number(chips) < Number(bo.broke_below || 25)
            if (!broke) return null
            const nowSec = Math.floor(Date.now() / 1000)
            const waitLeft = Math.max(0, (Number(bo.at || 0) + Number(bo.cooldown || 0)) - nowSec)
            const marks = lodder ? lodder.marks : []
            const styles = {
              card: {
                width: '100%', marginTop: SM_px(8), padding: `${SM_px(8)}px ${SM_px(10)}px`,
                borderRadius: SM_px(10), textAlign: 'center', pointerEvents: 'auto',
                background: `linear-gradient(180deg, ${smLook('cardTop', 'rgba(250,204,21,0.16)')}, rgba(0,0,0,0.5))`,
                border: `${SM_px(1)}px solid ${smLook('cardEdge', 'rgba(250,204,21,0.5)')}`,
                color: smLook('counterText', '#fef3c7'), fontSize: SM_px(10), lineHeight: 1.4
              },
              button: {
                marginTop: SM_px(6), padding: `${SM_px(4)}px ${SM_px(12)}px`, borderRadius: SM_px(999),
                fontWeight: 900, fontSize: SM_px(11), cursor: 'pointer',
                border: `${SM_px(1)}px solid ${smLook('spinRim', '#d9a441')}`,
                background: smLook('cashBg', '#ef6f5e'), color: smLook('cashText', '#2a120d')
              }
            }
            if (bailoutResult) {
              const won = Number(bailoutResult.given) || 0
              return jsxs('div', { 'data-sm-bailout': 'result', style: styles.card }, { children: [
                jsx('div', {
                  style: { fontWeight: 900, fontSize: SM_px(12) },
                  children: won > 0 ? `The house slides you ${SM_chips(won)} chips` : 'The tray is empty for now'
                }),
                jsx('div', {
                  style: { opacity: 0.85 },
                  children: won > 0
                    ? `${bailoutResult.grade === 'perfect' ? 'Perfect shot.' : bailoutResult.grade === 'good' ? 'Good shot.' : 'Sloppy, but it counts.'} +1/5 on every win for ${SM_chips(bailoutResult.came || 10)} spins.`
                    : 'Come back when the tray cools.'
                }),
                jsx('button', {
                  type: 'button', onClick: () => setBailoutResult(null),
                  style: { ...styles.button, background: 'transparent', color: smLook('control', '#fde68a') },
                  children: 'Close'
                })
              ] })
            }
            if (lodder) {
              const phase = marks.length ? marks[marks.length - 1] : 0
              return jsxs('div', { 'data-sm-bailout': 'playing', style: styles.card }, { children: [
                jsx('div', { style: { fontWeight: 900 }, children: `Shot ${marks.length + 1} of 3 — stop it in the middle` }),
                jsx('div', {
                  style: {
                    position: 'relative', height: SM_px(10), margin: `${SM_px(6)}px 0`, borderRadius: SM_px(999),
                    background: 'rgba(255,255,255,0.16)', overflow: 'hidden'
                  },
                  children: [
                    jsx('span', {
                      'aria-hidden': true,
                      style: { position: 'absolute', left: '42%', width: '16%', height: '100%', background: 'rgba(250,204,21,0.35)' }
                    }, 'band'),
                    jsx('span', {
                      'aria-hidden': true,
                      style: {
                        position: 'absolute', top: 0, width: SM_px(10), height: '100%', borderRadius: SM_px(999),
                        background: smAccent(), animation: 'sm-sweep 1100ms linear infinite'
                      }
                    }, 'marker')
                  ]
                }),
                jsx('button', {
                  type: 'button', 'data-sm-bailout-tap': '1', onClick: boTap, disabled: bailoutBusy,
                  style: { ...styles.button, width: '100%' },
                  children: bailoutBusy ? 'Counting…' : 'TAP'
                })
              ] })
            }
            if (waitLeft > 0) {
              const mins = Math.ceil(waitLeft / 60)
              return jsxs('div', { 'data-sm-bailout': 'cooling', style: styles.card }, { children: [
                jsx('div', { style: { fontWeight: 900 }, children: 'The tray is cooling' }),
                jsx('div', { style: { opacity: 0.85 }, children: `${mins} min more · streak ${SM_chips(bo.streak || 0)} · bigger stacks the more days you come back` })
              ] })
            }
            return jsxs('div', { 'data-sm-bailout': 'ready', style: styles.card }, { children: [
              jsx('div', { style: { fontWeight: 900, fontSize: SM_px(12) }, children: 'Out of chips — shake the tray' }),
              jsx('div', { style: { opacity: 0.85 }, children: 'Three taps, timed. Perfect pays 4,000, good 2,500, otherwise 1,500 — and ten wins after pay a fifth more.' }),
              jsx('button', {
                type: 'button', 'data-sm-bailout-start': '1',
                onClick: () => { setBailoutResult(null); setLodder({ t0: Date.now(), marks: [] }) },
                style: styles.button, children: 'Try the tap'
              })
            ] })
          })(),
          // The coin tray.
          jsx('div', { style: { margin: `${SM_px(10)}px auto 0`, width: '60%', height: SM_px(12), borderRadius: `0 0 ${SM_px(10)}px ${SM_px(10)}px`, background: smLook('lever', SM_CHROME) } }),
          coinLayer,
          (bare || chat) ? closeButton : null,
          (bare || chat) ? showToggle : null
        ]
      }),
      (!bare || chat) ? jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: SM_px(12), flexWrap: 'wrap', justifyContent: 'center', pointerEvents: 'auto' },
        children: [
          jsx('button', {
            type: 'button',
            'data-sm-spin': '1',
            disabled: Boolean(busy) || !canSpin,
            onClick: () => onSpin && onSpin(),
            style: {
              padding: compact ? `${SM_px(8)}px ${SM_px(22)}px` : `${SM_px(10)}px ${SM_px(30)}px`, borderRadius: SM_px(999), border: `${SM_px(3)}px solid ${smLook('spinRim', '#d9a441')}`, fontWeight: 900,
              fontSize: compact ? SM_px(15) : SM_px(18), letterSpacing: SM_px(2), cursor: busy || !canSpin ? 'default' : 'pointer',
              color: busy || !canSpin ? '#44403c' : smLook('spinText', '#fff8e7'),
              background: busy || !canSpin ? '#d6d3d1' : smLook('spinBg', 'radial-gradient(circle at 50% 30%, #fef08a, #facc15 60%, #ca8a04)'),
              boxShadow: busy || !canSpin ? 'none' : `0 ${SM_px(4)}px 0 ${smLook('spinShadow', '#8f3a2e')}`
            },
            children: `SPIN · ${bet || ''}`.trim()
          }),
          checkbox('Auto-spin on every message', autoplay, onAutoplay, 'One spin per message you send, and only while this machine is on screen.'),
          checkbox('Auto-bet sizes itself', autobetShown, flipAutobet, 'Turn starting or a tool running: 1x. A reply under 20k tokens: 2x. Then 3x at 40k, 4x at 80k, 6x at 160k, 8x at 320k and above - 1x is 25 chips, the smallest bet on the table. Never more than the cap, and the odds are identical at every bet: a bigger bet is a bigger swing, not a better chance.'),
          jsx('button', {
            type: 'button',
            'data-autobet-help': '1',
            title: AUTOBET_RULES,
            onClick: () => setAutobetHelp(open => !open),
            'aria-expanded': autobetHelp ? 'true' : 'false',
            style: { alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 11, color: text.tertiary, textDecoration: 'underline dotted' },
            children: autobetHelp ? 'Hide how the automatic bet is sized' : 'How is the automatic bet sized?'
          }),
          autobetHelp ? jsx('div', {
            'data-autobet-rules': '1',
            role: 'note',
            style: { fontSize: 11, lineHeight: 1.45, color: text.tertiary, maxWidth: 420, padding: '4px 0 0 2px' },
            children: AUTOBET_RULES
          }) : null,
          checkbox('Show over chat', overchat, value => setOverchat(value), 'Show a see-through copy of this machine over the chat, where you can watch it without leaving the conversation.'),
          overchat ? jsxs('div', {
            'data-sm-alpha': '1',
            style: {
              display: 'inline-flex', alignItems: 'center', gap: SM_px(6), justifyContent: 'center',
              fontSize: SM_px(11), color: smLook('footer', compact ? '#e7e5e4' : text.tertiary)
            },
            children: [
              jsx('span', { children: 'Over-chat opacity' }),
              jsx('button', {
                type: 'button', 'data-sm-alpha-down': '1', title: 'Fainter', onClick: () => smNudgeOverchatAlpha(-1),
                style: { cursor: 'pointer', borderRadius: SM_px(6), border: `1px solid ${smEdge()}`, background: 'transparent', color: 'inherit', fontSize: SM_px(12), lineHeight: 1, padding: `${SM_px(2)}px ${SM_px(7)}px` },
                children: '−'
              }),
              jsx('span', { 'data-sm-alpha-value': '1', style: { minWidth: SM_px(34), textAlign: 'center', fontWeight: 700 }, children: `${Math.round(alpha * 100)}%` }),
              jsx('button', {
                type: 'button', 'data-sm-alpha-up': '1', title: 'More solid', onClick: () => smNudgeOverchatAlpha(1),
                style: { cursor: 'pointer', borderRadius: SM_px(6), border: `1px solid ${smEdge()}`, background: 'transparent', color: 'inherit', fontSize: SM_px(12), lineHeight: 1, padding: `${SM_px(2)}px ${SM_px(7)}px` },
                children: '+'
              })
            ]
          }) : null,
          // The owner asked for the cabinet 20% smaller, with a slider instead of another fixed
          // number, so the size is theirs to set: 40% to 110%, kept in this browser.
          jsxs('div', {
            'data-sm-scale': '1',
            style: {
              display: 'inline-flex', alignItems: 'center', gap: SM_px(8), justifyContent: 'center',
              fontSize: SM_px(11), color: smLook('footer', compact ? '#e7e5e4' : text.tertiary), width: '100%'
            },
            children: [
              jsx('span', { children: 'Over-chat size' }),
              jsx('input', {
                type: 'range', 'data-sm-scale-range': '1', min: SM_SCALE_MIN, max: SM_SCALE_MAX, step: SM_SCALE_STEP,
                value: scale, title: 'Drag left to make the see-through machine smaller. It never grows past the Game Center size.',
                'aria-label': `Over-chat machine size, ${Math.round(scale * 100)} percent`,
                onChange: event => setScale(Number(event.target.value)),
                style: { accentColor: smAccent(), width: SM_px(120), cursor: 'pointer' }
              }),
              jsx('span', { 'data-sm-scale-value': '1', style: { minWidth: SM_px(34), textAlign: 'right', fontWeight: 700 }, children: `${Math.round(scale * 100)}%` }),
              jsx('button', {
                type: 'button', 'data-sm-scale-reset': '1', title: 'Back to the default size',
                onClick: () => setScale(SM_SCALE_DEFAULT),
                style: { cursor: 'pointer', borderRadius: SM_px(6), border: `1px solid ${smEdge()}`, background: 'transparent', color: 'inherit', fontSize: SM_px(10), lineHeight: 1, padding: `${SM_px(2)}px ${SM_px(6)}px` },
                children: 'Reset'
              })
            ]
          })
        ]
      }) : null,
      trouble ? jsx('div', {
        role: 'alert',
        'data-slots': 'trouble',
        style: { fontSize: SM_px(11), color: '#fca5a5', textAlign: 'center', maxWidth: '100%', marginTop: SM_px(6), overflowWrap: 'anywhere' },
        children: trouble
      }) : null,
      // A table that cannot spin has to say why and offer the way out. The wallet below the smallest
      // bet used to leave SPIN and every rung greyed with nothing on screen to explain it (owner's
      // report, 2026-11-10: "spin nor x1, x2 etc allow you to do anything"). Points convert at four
      // to three chips, so this asks for just enough to cover one spin.
      (!bare || chat) ? (() => {
        const stake = Number(bet) || Number((bets || [])[0]) || 25
        if (Number(chips) >= stake) return null
        const pointsNow = Number(rewardInfo && rewardInfo.points) || 0
        const need = Math.max(0, stake - Number(chips))
        const want = Math.min(Math.floor(pointsNow / 4) * 4, Math.ceil(need / 3) * 4)
        const gain = Math.floor(want / 4) * 3
        return jsxs('div', {
          'data-sm-broke': '1',
          role: 'note',
          style: {
            display: 'flex', gap: SM_px(8), alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap',
            marginTop: SM_px(6), fontSize: SM_px(11), pointerEvents: 'auto',
            color: smLook('footer', compact ? '#e7e5e4' : text.tertiary)
          },
          children: [
            jsx('span', { children: `${SM_chips(Number(chips))} chips — a spin costs ${SM_chips(stake)}.` }, 'broke-chips'),
            gain > 0 ? jsx('button', {
              type: 'button',
              'data-sm-broke-cash': '1',
              disabled: cashBusy,
              title: `Turn ${SM_chips(want)} points into ${SM_chips(gain)} chips (four points buy three). The points you keep still count for the leaderboard.`,
              onClick: () => cashPointsFor(want),
              style: {
                padding: `${SM_px(2)}px ${SM_px(9)}px`, borderRadius: SM_px(999), fontWeight: 800, fontSize: SM_px(11),
                cursor: cashBusy ? 'default' : 'pointer',
                border: `${SM_px(1)}px solid ${smLook('spinRim', '#d9a441')}`,
                background: cashBusy ? '#d6d3d1' : smLook('cashBg', smLook('betSelectedBg', '#ef6f5e')),
                color: cashBusy ? '#44403c' : smLook('cashText', smLook('betSelectedText', '#2a120d'))
              },
              children: `Turn ${SM_chips(want)} points into ${SM_chips(gain)} chips`
            }, 'broke-cash') : jsx('span', {
              children: 'Chat or win a game to earn points, then turn them into chips here.'
            }, 'broke-wait')
          ]
        })
      })() : null,
      (!bare || chat) && (bets || []).length ? jsxs('div', {
        style: { display: 'flex', gap: SM_px(6), flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', pointerEvents: 'auto', maxWidth: '100%' },
        children: [
          jsx('span', { style: { fontSize: SM_px(11), color: smLook('footer', compact ? '#e7e5e4' : text.tertiary) }, children: 'Bet' }, 'bet-label'),
          ...bets.map((amount, index) => jsx('button', {
            type: 'button',
            'data-sm-bet': amount,
            'aria-pressed': Number(bet) === amount,
            // With auto-bet on the multiplier is not the person's to pick: the machine sizes every
            // spin itself, so the ladder is greyed out rather than offered and silently ignored
            // (owner's ask, 2026-11-09).
            'data-sm-bet-locked': autobetShown ? '1' : undefined,
            disabled: Boolean(busy) || Number(chips) < amount || autobetShown,
            onClick: () => onBet && onBet(amount),
            title: autobetShown
              ? 'Auto-bet is on: the machine sizes the bet itself. Turn "Auto-bet sizes itself" off to pick a multiplier.'
              : `Bet ${amount} chips: ${amount} a spin, split over the machine's lines.`,
            style: {
              minWidth: SM_px(34), padding: `${SM_px(3)}px ${SM_px(8)}px`, borderRadius: SM_px(8),
              cursor: autobetShown ? 'not-allowed' : 'pointer', fontSize: SM_px(12), fontWeight: 800,
              border: `${SM_px(1)}px solid ${Number(bet) === amount ? smLook('trim', SM_GOLD) : smLook('edge', '#57534e')}`,
              background: Number(bet) === amount ? smLook('betSelectedBg', SM_GOLD) : smLook('betBg', 'rgba(0,0,0,0.4)'),
              color: Number(bet) === amount ? smLook('betSelectedText', '#111') : smLook('betText', '#e7e5e4'),
              opacity: autobetShown ? 0.35 : (Number(chips) < amount ? 0.45 : 1)
            },
            children: `×${index + 1}`
          }, `bet-${amount}`))
        ]
      }) : null,
      // With auto-bet on, the whole ladder is greyed: say so in the open rather than only on hover,
      // because a locked ladder with no visible reason reads as a broken machine (2026-11-10).
      (!bare || chat) && autobetShown ? jsx('div', {
        'data-sm-bet-hint': '1',
        style: {
          fontSize: SM_px(10), textAlign: 'center', maxWidth: '100%', overflowWrap: 'anywhere',
          color: smLook('footer', compact ? '#a8a29e' : text.tertiary), marginTop: SM_px(2)
        },
        children: 'Auto-bet sizes every stake, so the bet ladder is locked. Untick “Auto-bet sizes itself” to pick a multiplier.'
      }) : null,
      // The odds window. The mechanics are untouched — the session's chance and return are still
      // drawn by the shelf and still paid — but no percentage is printed here or anywhere else on
      // either machine (owner's release rule, 2026-11-11: "keep the mechanics; just do not show the
      // numbers"). What is left is the one sentence a player has to know before spending.
      (!bare || chat) ? jsx('div', {
        'data-sm-odds': '1',
        style: { fontSize: SM_px(11), color: smLook('footer', compact ? '#e7e5e4' : text.tertiary), textAlign: 'center', maxWidth: '100%', overflowWrap: 'anywhere' },
        children: 'Every spin costs the bet. Chips are play money and never become anything else.'
      }) : null,
      (!bare || chat) && (paytable || []).length ? jsxs('div', {
        style: { fontSize: SM_px(12), pointerEvents: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: SM_px(4), maxWidth: '100%' },
        children: [
          jsx('button', {
            type: 'button',
            'aria-expanded': payOpen || payHover,
            'aria-describedby': 'sm-pays-card',
            // Hover to peek, click to pin: the scoring shows itself without a modal.
            onMouseEnter: () => setPayHover(true),
            onMouseLeave: () => setPayHover(false),
            onFocus: () => setPayHover(true),
            onBlur: () => setPayHover(false),
            onClick: () => setPayOpen(open => !open),
            title: 'Scoring: what each line pays, in chips per line. Hover to peek, click to keep it open.',
            style: {
              border: `${SM_px(1)}px solid ${compact ? smLook('trim', '#facc15') : stroke}`,
              background: compact ? smLook('controlBg', 'rgba(0,0,0,0.35)') : 'transparent',
              color: compact ? smLook('control', '#fde68a') : text.secondary, cursor: 'pointer', fontSize: SM_px(11), fontWeight: 700,
              letterSpacing: 0.4, borderRadius: SM_px(999), padding: `${SM_px(3)}px ${SM_px(10)}px`
            },
            children: payOpen ? 'Hide scoring' : 'Scoring'
          }),
          payOpen || payHover ? jsxs('div', {
            id: 'sm-pays-card',
            role: 'tooltip',
            style: {
              display: 'grid', gridTemplateColumns: 'auto auto', gap: `${SM_px(2)}px ${SM_px(14)}px`, marginTop: SM_px(2),
              padding: `${SM_px(6)}px ${SM_px(10)}px`, borderRadius: SM_px(8), background: 'rgba(8,8,14,0.92)',
              border: `${SM_px(1)}px solid ${compact ? smLook('trim', '#facc15') : stroke}`,
              color: compact ? smLook('counterText', '#fef3c7') : text.primary,
              maxWidth: SM_px(320)
            },
            children: [
              jsx('span', { style: { gridColumn: '1 / span 2', fontSize: SM_px(10), letterSpacing: SM_px(1), textTransform: 'uppercase', color: compact ? smLook('label', '#fcd34d') : text.tertiary }, children: 'Pays per line, in chips' }),
              ...paytable.flatMap((row, index) => [
                jsx('span', { style: { display: 'inline-flex', alignItems: 'center' }, children: SM_symbolRun(row.symbol, SM_px(22)) }, `s${index}`),
                jsx('span', { style: { textAlign: 'right', fontWeight: 700 }, children: SM_chips(row.payout) }, `p${index}`)
              ]),
              jsx('span', {
                'data-sm-lines': '1',
                style: { gridColumn: '1 / span 2', marginTop: SM_px(4), fontSize: SM_px(10), lineHeight: 1.5, color: compact ? smLook('control', '#fde68a') : text.secondary },
                children: 'Five lines: ─ middle, ─ top, ─ bottom, ╲ down-diagonal, ╱ up-diagonal. Every line reads left to right, diagonals included.'
              }),
              jsx('span', {
                style: { gridColumn: '1 / span 2', fontSize: SM_px(10), color: compact ? smLook('label', '#fcd34d') : text.tertiary },
                children: 'Three of a symbol pays the table; cherries also pay one or two, on any line - so a diagonal of two cherries and something else still pays.'
              })
            ]
          }) : null
        ]
      }) : null
    ]
  })
}
