// ---- 18-slots.js: the Slots table in Game Center
// The machine itself (reels, lever, paylines, coins) is SlotMachine in 18-slot-machine.js; this
// table feeds it the picture and turns its buttons into moves and settings. Picking a machine,
// auto-spin and the centred overlay are settings, not moves, so they go through the Slots API
// (SM_API.rest, handed over by the status-bar item, which is always mounted).

const SM_API = { rest: null }

// A settings write goes through the caller's own API door first: SM_API is only wired by the
// status-bar item, and when it was not wired the write was dropped while the switch stayed on,
// so auto-spin looked enabled and never fired.
async function slotsSetting(path, body, send) {
  const door = send || (SM_API.rest ? (route, payload) => SM_API.rest(route, { method: 'POST', body: payload }) : null)
  if (!door) return null
  try {
    return await door(path, body)
  } catch {
    return null
  }
}

// What a switch should show after a write: the server's answer when it gave one, and
// otherwise the last value the server reported, never the optimistic guess.
function jpSwitchValue(answer, fallback) {
  return answer && typeof answer.autoplay === 'boolean' ? answer.autoplay : fallback
}

// Keep a local switch value until a write is confirmed and a subsequent picture agrees.
function useJpAutoplay(serverValue) {
  const [value, setValue] = useState(null)
  const request = useRef(0)
  const confirmed = useRef(false)
  useEffect(() => {
    if (value !== null && confirmed.current && serverValue === value) {
      confirmed.current = false
      setValue(null)
    }
  }, [serverValue, value])
  const begin = on => {
    confirmed.current = false
    setValue(Boolean(on))
    return ++request.current
  }
  const finish = (id, answer) => {
    if (id !== request.current) return false
    if (typeof answer === 'boolean') {
      confirmed.current = true
      setValue(answer)
    }
    return true
  }
  return { value: value == null ? Boolean(serverValue) : value, begin, finish }
}

// A feed row only wins when it is newer than the picture already on screen: a slow poll
// must not replace the result a message just produced with an older one.
function smNewerFeed(candidate, current) {
  if (!candidate) return false
  if (!current) return true
  const candidateAt = Number(candidate.at)
  const currentAt = Number(current.at)
  if (Number.isFinite(candidateAt) && Number.isFinite(currentAt)) return candidateAt > currentAt
  return String(candidate.at || '') !== String(current.at || '')
}

function SlotsTable({ picture, interactive, busy, onMove, onSetting }) {
  const p = picture || {}
  // The game page can be shorter than the cabinet. Fit the whole table inside the
  // visible page; the wait pane keeps its own layout and is deliberately unchanged.
  //
  // Three things this must not do, each because the first attempt did it and a read of the
  // numbers showed the damage:
  //  - force the wrapper to `width: 100%`: the cabinet then reflowed to the page width
  //    (measured: 1183 px design width at 1400, 449 px at 500), so its layout moved with
  //    the window and the fit measured the page instead of the machine;
  //  - let the scale reach 0 when the page has no room: an invisible machine is the very
  //    symptom being fixed, so the height term has a floor and the page scrolls below it —
  //    but the width term still wins when the page is narrower than the floor allows,
  //    because a copy clipped at the sides is worse than a small one;
  //  - keep one measurement while the person switches machines: the effect re-runs on the
  //    machine id, so the new cabinet is measured on its own.
  // Natural size comes from offsetWidth/offsetHeight, which a CSS transform does not change.
  // That is also why the observer cannot see its own scale change, and why there is no
  // measure/render loop. A zoomed or CSS-transformed ancestor is out of scope for this fit.
  const SM_FIT_FLOOR = 0.45   // a short page: keep the copy readable, let the page scroll
  const SM_VISIBLE_MIN = 0.2  // a hard bound: below this the copy is a bug, not a fit
  const slotFrame = useRef(null)
  const slotMachine = useRef(null)
  const [fit, setFit] = useState({ scale: 1, width: 0, height: 0 })
  const machineKey = p.machine || ''
  useEffect(() => {
    const frame = slotFrame.current
    const machine = slotMachine.current
    if (!frame || !machine || typeof frame.closest !== 'function') return undefined
    let page = frame.closest('.games-play-table')
    let viewport = frame.closest('.games-center-layout')
    // The same cabinet is also drawn in the pane beside the chat ("Play while you wait"), which is
    // narrow and has no game-page wrappers. It used to skip the fit entirely and draw at its full
    // 1183 px inside a ~400 px pane, which is the oversized, cut-off machine the owner reported
    // (2026-11-10). Fit the pane when there is no game page.
    if (!page || !viewport) {
      const pane = frame.closest('.games-wait-pane')
      if (pane) { page = pane; viewport = pane }
    }
    if (!page || !viewport) return undefined
    const measure = () => {
      const width = machine.offsetWidth
      const height = machine.offsetHeight
      if (!width || !height) return
      const bounds = viewport.getBoundingClientRect()
      const anchor = frame.getBoundingClientRect().top
      const room = Math.max(0, Math.min(bounds.bottom, Number(window.innerHeight) || 0) - Math.max(anchor, bounds.top) - 8)
      const availableWidth = frame.parentElement ? frame.parentElement.clientWidth : bounds.width
      const widthScale = availableWidth > 0 ? availableWidth / width : 1
      // Floor the height term only: a machine shorter than the floor stays visible and the page
      // scrolls, but a narrow page still wins so nothing is clipped at the sides.
      const scale = Math.max(SM_VISIBLE_MIN, Math.min(1, Math.max(SM_FIT_FLOOR, room / height), widthScale))
      setFit(previous => Math.abs(previous.scale - scale) < 0.001 && previous.width === width && previous.height === height
        ? previous : { scale, width, height })
    }
    measure()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    if (observer) { observer.observe(machine); observer.observe(viewport) }
    window.addEventListener('resize', measure)
    return () => { if (observer) observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [machineKey])
  // Every machine comes from the picture the shelf sent: strips, pays, rows and theme. A
  // client-side stand-in would show reels and odds the session is not actually playing, which
  // is worse than saying the machine is missing.
  const machines = p.machines || []
  // Settings answer at once on screen; the next poll brings the server's word.
  const [pickedMachine, setPickedMachine] = useState('')
  const autoplay = useJpAutoplay(p.autoplay)
  // A switch that silently springs back looks broken. Say why it did.
  const [trouble, setTrouble] = useState('')
  // While this table is open the machine is on screen, so auto-spin may run.
  useEffect(() => {
    jpVisible(1, onSetting)
    return () => jpVisible(-1, onSetting)
  }, [])
  useEffect(() => { setPickedMachine('') }, [p.machine])
  const machineId = pickedMachine || p.machine || (machines[0] && machines[0].id) || ''
  const machine = machines.find(item => item.id === machineId) || machines[0] || null
  // The table can receive the reward fields in its picture; if an older shelf does not send
  // them, read /jackpot through the same door the settings use and poll it lightly.
  const pictureReward = SM_rewardFields(p)
  const [liveReward, setLiveReward] = useState(null)
  const [liveFeed, setLiveFeed] = useState(null)
  // Poll /jackpot whatever the picture carried. The picture used to be enough - and then the
  // points froze the moment the page's own snapshot stopped moving, which is exactly what the owner
  // saw ("I don't see I earned any points anytime recently"). The live read wins over the picture.
  useEffect(() => {
    let alive = true
    let timer = null
    const load = async () => {
      const rest = SM_API.rest
      // The door is wired by the status-bar item, which may mount after this page: returning here
      // and never retrying is what left the card showing the page's stale picture - chips live,
      // points stuck at zero (owner's report, 2026-11-09: "still says I have zero points").
      if (!rest) { if (alive) timer = setTimeout(load, 500); return }
      try {
        const next = await rest('/jackpot')
        if (!alive) return
        const fields = SM_rewardFields(next)
        if (fields) setLiveReward(fields)
      } catch {
        // Keep the last known row and try again on the next light poll.
      }
      if (alive) timer = setTimeout(load, 1500)
    }
    load()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [])
  // Sending a message starts a spin: refresh right after it, the way the status item does,
  // so the result lands without waiting for a slow poll.
  useEffect(() => {
    if (!SDK_HOST || typeof SDK_HOST.onEvent !== 'function') return undefined
    let stop = () => {}
    let timer = null
    const refresh = async () => {
      const rest = SM_API.rest
      if (!rest) return
      try {
        const next = await rest('/jackpot')
        if (next && Array.isArray(next.feed) && next.feed[0]) setLiveFeed(next.feed[0])
        const fields = SM_rewardFields(next)
        if (fields) setLiveReward(fields)
      } catch {
        // The normal poll still catches the result.
      }
    }
    try {
      stop = SDK_HOST.onEvent('message.start', () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(refresh, 400)
      }) || stop
    } catch {
      // An older host has no event stream; the poll still catches the spin.
    }
    return () => {
      try { stop() } catch { /* nothing to unwire */ }
      if (timer) clearTimeout(timer)
    }
  }, [])
  const pictureNewest = (p.feed || [])[0] || null
  const newest = smNewerFeed(liveFeed, pictureNewest) ? liveFeed : pictureNewest
  const result = newest && machine && newest.machine === machine.id ? newest : null
  const reward = liveReward || pictureReward
  // Points into chips at 75%: the same door as the reward chips, kept beside it so the page and the
  // overlay spend points the same way (owner's ask, 2026-11-09).
  const cashPoints = async points => {
    // `points` is how much of the score the person chose to spend; omitting it spends everything,
    // which is what an older desktop did and the server still accepts.
    const answer = await slotsSetting('/jackpot/points/cash', points ? { points } : {}, onSetting)
    if (answer) {
      const fields = SM_rewardFields(answer)
      if (fields) setLiveReward(fields)
    }
    return answer
  }
  // The comeback tap: the machine posts its grade and the shelf decides the stack.
  const bailout = async grade => {
    const answer = await slotsSetting('/jackpot/bailout', { grade }, onSetting)
    if (answer) {
      const fields = SM_rewardFields(answer)
      if (fields) setLiveReward(fields)
    }
    return answer
  }
  // Finding an easter egg: the mark on the cabinet posts the id it was shown; the shelf decides.
  const takeEgg = async id => {
    const answer = await slotsSetting('/eggs/claim', { id }, onSetting)
    if (answer) {
      const fields = SM_rewardFields(answer)
      if (fields) setLiveReward(fields)
    }
    return answer
  }
  const cashin = async () => {
    const answer = await slotsSetting('/jackpot/cashin', {}, onSetting)
    if (answer) {
      const fields = SM_rewardFields(answer)
      if (fields) setLiveReward(fields)
    }
    return answer
  }
  const canSpin = Boolean(interactive) && (p.legal || []).includes('spin')
  return jsx('div', {
    'data-slots': 'table',
    ref: slotFrame,
    style: { display: 'flex', justifyContent: 'center', padding: '8px 0' },
    children: jsx('div', {
      style: {
        width: '100%', height: fit.height ? fit.height * fit.scale : 'auto',
        display: 'flex', justifyContent: 'center', alignItems: 'flex-start'
      },
      children: jsx('div', {
        ref: slotMachine,
        // max-content, not 100%: the natural cabinet width is what the fit has to measure
        // and what must survive at wide window sizes.
        style: { width: 'max-content', maxWidth: '100%', transform: `scale(${fit.scale})`, transformOrigin: 'top center' },
        children: jsx(SlotMachine, {
      machine,
      machines,
      result,
      chips: p.chips,
      trouble: trouble || (!machine
        ? 'The shelf did not send this machine. Restart Hermes so this window and the game center match.'
        : ''),
      autoplay: autoplay.value,
      autobet: p.autobet !== false,
      onAutobet: async on => { await slotsSetting('/jackpot/autobet', { on }, onSetting) },
      bet: Number(p.bet) || 0,
      bets: p.bets || [],
      odds: p.odds || null,
      busy,
      canSpin,
      rewards: reward,
      onCashin: cashin,
      onPoints: cashPoints,
      onBailout: bailout,
      onEgg: takeEgg,
      paytable: p.paytable || [],
      onSpin: () => onMove('spin'),
      onBet: amount => onMove(`bet${amount}`),
      onPickMachine: async id => {
        setPickedMachine(id)
        const answer = await slotsSetting('/jackpot/machine', { machine: id }, onSetting)
        // Never leave a switch showing something the server did not take.
        if (!answer || answer.machine !== id) setPickedMachine('')
      },
      onAutoplay: async on => {
        const id = autoplay.begin(on)
        const answer = await slotsSetting('/jackpot/autoplay', { on }, onSetting)
        const confirmed = answer && typeof answer.autoplay === 'boolean'
          ? jpSwitchValue(answer, p.autoplay) : undefined
        if (!autoplay.finish(id, confirmed)) return
        if (confirmed === undefined) {
          setTrouble('The shelf did not confirm the auto-spin switch. Try again.')
          return
        }
        setTrouble('')
      },
        }, machineId)
      })
    })
  })
}
