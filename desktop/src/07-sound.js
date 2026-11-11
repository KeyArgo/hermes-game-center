// ---- 07-sound.js: small synthesised table sounds, and the one switch that turns them off.
// No audio files: an oscillator and a short noise burst cost nothing, cannot 404, and work
// offline. Sound is a garnish, so every call is wrapped: a broken audio stack never breaks
// a game, and the switch is remembered on this machine only.

const SOUND_KEY = 'hermes-games-sound'
// How loud the table is, 0 to 100. Kept beside the on/off switch so a person can keep the sounds but
// take the edge off them (owner's ask, 2026-11-09), and applied to every voice - synth and sample.
const SOUND_VOLUME_KEY = 'hermes-games-sound-volume'
const SOUND_VOLUME_DEFAULT = 35

function gamesVolume() {
  try {
    const raw = window.localStorage.getItem(SOUND_VOLUME_KEY)
    if (raw === null || raw === '') return SOUND_VOLUME_DEFAULT / 100
    const value = Number(raw)
    if (!Number.isFinite(value)) return SOUND_VOLUME_DEFAULT / 100
    return Math.max(0, Math.min(1, value / 100))
  } catch {
    return SOUND_VOLUME_DEFAULT / 100
  }
}

function gamesVolumeSet(percent) {
  const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)))
  try { window.localStorage.setItem(SOUND_VOLUME_KEY, String(value)) } catch { /* nothing to save to */ }
  return value
}

function gamesSoundOn() {
  try {
    return window.localStorage.getItem(SOUND_KEY) !== 'off'
  } catch {
    // Private mode without storage: sound stays on rather than failing closed.
    return true
  }
}

function gamesSoundSet(on) {
  try { window.localStorage.setItem(SOUND_KEY, on ? 'on' : 'off') } catch { /* nothing to save to */ }
}

let soundStack = null
function soundAudio() {
  if (soundStack) return soundStack
  const Ctor = window.AudioContext || window.webkitAudioContext
  soundStack = Ctor ? new Ctor() : null
  return soundStack
}

// One bus for every voice, synth and sample, with a gentle compressor in front of the speakers: a
// jackpot stacks a dozen sounds, and without this the sum is the "loud and computerised" peak the
// owner heard (2026-11-09).
let soundBusNode = null
function soundBus(ctx) {
  if (soundBusNode && soundBusNode.context === ctx) return soundBusNode
  const gain = ctx.createGain()
  gain.gain.value = 0.9
  if (ctx.createDynamicsCompressor) {
    const squash = ctx.createDynamicsCompressor()
    squash.threshold.value = -18
    squash.knee.value = 24
    squash.ratio.value = 3.5
    squash.attack.value = 0.006
    squash.release.value = 0.25
    gain.connect(squash).connect(ctx.destination)
  } else {
    gain.connect(ctx.destination)
  }
  soundBusNode = gain
  return gain
}

function soundTone(ctx, { freq, at, length, type = 'sine', gain = 0.05, to = 0 }) {
  const osc = ctx.createOscillator()
  const amp = ctx.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, at)
  if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + length)
  // A quick attack and a soft tail: no click at either end.
  amp.gain.setValueAtTime(0.0001, at)
  amp.gain.exponentialRampToValueAtTime(gain, at + 0.012)
  amp.gain.exponentialRampToValueAtTime(0.0001, at + length)
  osc.connect(amp).connect(soundBus(ctx))
  osc.start(at)
  osc.stop(at + length + 0.02)
}

function soundNoise(ctx, { at, length, gain = 0.07, low = 400 }) {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * length))
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < frames; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / frames)
  const source = ctx.createBufferSource()
  source.buffer = buffer
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = low
  const amp = ctx.createGain()
  amp.gain.value = gain
  source.connect(filter).connect(amp).connect(soundBus(ctx))
  source.start(at)
}

/**
 * One of the table sounds. Unknown names do nothing, so a caller can pass a result
 * straight through without a lookup table here.
 */
// A coin landing on a tray. Two things make a coin sound like a coin and not like a bell:
// the strike is a burst of broadband noise (metal hitting metal, no pitch of its own), and the
// ring on top of it is very short and very high - a few milliseconds of 4-9 kHz, gone in under a
// tenth of a second. Long sine partials are what produced the "ting tong" the owner heard.
function soundCoin(ctx, { at, freq = 2600, gain = 0.05, length = 0.09 }) {
  const strike = Math.max(1, Math.floor(ctx.sampleRate * 0.006))
  const buffer = ctx.createBuffer(1, strike, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < strike; i += 1) {
    const fade = 1 - i / strike
    data[i] = (Math.random() * 2 - 1) * fade * fade
  }
  const source = ctx.createBufferSource()
  source.buffer = buffer
  const band = ctx.createBiquadFilter()
  band.type = 'bandpass'
  band.frequency.value = Math.min(9000, Math.max(2500, freq * 1.6))
  band.Q.value = 1.1
  const amp = ctx.createGain()
  amp.gain.value = gain * 1.4
  source.connect(band).connect(amp).connect(ctx.destination)
  source.start(at)
  // The tray under the coin: two low-mid partials with a slightly longer decay. Real payouts are
  // recorded with the tray ringing underneath the clinks - without it the coin is thin and papery.
  ;[[0.28, 0.4], [0.52, 0.25]].forEach(([ratio, weight]) => {
    const tray = ctx.createOscillator()
    const trayAmp = ctx.createGain()
    tray.type = 'triangle'
    tray.frequency.setValueAtTime(Math.max(300, freq * ratio), at)
    trayAmp.gain.setValueAtTime(0.0001, at)
    trayAmp.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * weight * 0.6), at + 0.004)
    trayAmp.gain.exponentialRampToValueAtTime(0.0001, at + 0.09)
    tray.connect(trayAmp).connect(ctx.destination)
    tray.start(at)
    tray.stop(at + 0.1)
  })
  // Two high partials, both decaying inside `length`: the metal, not a melody.
  ;[[1, 1], [1.63, 0.55], [2.4, 0.3]].forEach(([ratio, weight]) => {
    const osc = ctx.createOscillator()
    const ring = ctx.createGain()
    const hz = Math.min(12000, freq * ratio)
    osc.type = 'sine'
    osc.frequency.setValueAtTime(hz, at)
    ring.gain.setValueAtTime(0.0001, at)
    ring.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * weight * 0.8), at + 0.002)
    ring.gain.exponentialRampToValueAtTime(0.0001, at + Math.max(0.03, length / ratio))
    osc.connect(ring).connect(ctx.destination)
    osc.start(at)
    osc.stop(at + Math.max(0.03, length / ratio) + 0.01)
  })
}

function gamesSound(kind, options) {
  if (!gamesSoundOn()) return
  try {
    const ctx = soundAudio()
    if (!ctx) return
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume()
    const t = ctx.currentTime + 0.01
    // A bigger win plays the same shape louder and higher, so the sound grows with the payout.
    // The master volume rides on the same scale, so one number tunes every voice at once - the
    // samples multiply it themselves, and the synth voices inherit it here.
    const volume = gamesVolume()
    if (volume <= 0) return
    const scale = Math.max(0.2, Math.min(3, Number((options && options.scale) || 1))) * volume
    switch (kind) {
      case 'deal':
        soundNoise(ctx, { at: t, length: 0.06, gain: 0.045, low: 2600 })
        break
      case 'spin':
        smSfxOr('wheel', { rate: 1, gain: 0.22, delay: 0 }, () => {
          for (let i = 0; i < 5; i += 1) soundNoise(ctx, { at: t + i * 0.055, length: 0.05, gain: 0.035, low: 3200 })
        })
        break
      case 'win':
        soundTone(ctx, { freq: 660 * Math.min(1.6, scale), at: t, length: 0.12, type: 'triangle', gain: 0.06 * scale })
        soundTone(ctx, { freq: 880 * Math.min(1.6, scale), at: t + 0.1, length: 0.16, type: 'triangle', gain: 0.055 * scale })
        if (scale >= 2) {
          soundTone(ctx, { freq: 1174, at: t + 0.22, length: 0.2, type: 'triangle', gain: 0.05 * scale })
        }
        break
      case 'cash': {
        // A win paying into the tray: the recorded coin spill, or the synth scatter when the clip
        // cannot be decoded.
        smSfxOr('coinwin', { rate: 0.96, gain: 0.3, delay: 0 }, () => {
          const coins = Math.max(4, Math.round(7 * Math.min(2.2, scale)))
          for (let i = 0; i < coins; i += 1) {
            soundCoin(ctx, {
              at: t + i * (0.05 + Math.random() * 0.05),
              freq: 2100 + Math.random() * 1500,
              gain: 0.045 * Math.min(1.8, scale),
              length: 0.13 + Math.random() * 0.09
            })
          }
        })
        break
      }
      case 'ching': {
        // The sound of coins landing again and again: the person asked for ching-ching-ching for the
        // length of the celebration, and for it to be coins, not beeps.
        const count = Math.max(4, Math.min(400, Math.round(Number((options && options.times) || 10))))
        const span = Math.max(0.2, Math.min(20, Number((options && options.seconds) || 2)))
        const step = span / count
        // The recorded clip first: a real coin on a real tray. The synth underneath only fires if the
        // sample cannot be decoded.
        for (let i = 0; i < count; i += 1) {
          const beats = Math.random() < 0.35 ? 2 : 1
          for (let k = 0; k < beats; k += 1) {
            smSfxOr('coin', {
              rate: 0.85 + Math.random() * 0.5,
              gain: 0.3 * Math.min(1.4, scale),
              delay: i * step + Math.random() * step * 0.7
            }, () => soundCoin(ctx, { at: t + i * step, freq: 3200 + Math.random() * 3800, gain: 0.03, length: 0.06 }))
          }
        }
        for (let i = 0; i < count; i += 1) {
          // Two or three coins land together at each beat, each slightly late and slightly off
          // pitch, so the cascade is a scatter of metal rather than a rhythm.
          const together = 1 + Math.floor(Math.random() * 2)
          for (let k = 0; k < together; k += 1) {
            soundCoin(ctx, {
              at: t + i * step + Math.random() * step * 0.8,
              freq: 3200 + Math.random() * 3800,
              gain: 0.03 * Math.min(1.8, scale),
              length: 0.04 + Math.random() * 0.05
            })
          }
        }
        break
      }
      case 'payout': {
        // The cabinet's own win sound, recorded: the "ding ding ding" is a payout-award clip, and a
        // long run layers the win-alert clip over it so the tune grows with the win.
        const hits = Math.max(2, Math.min(24, Math.round(Number((options && options.times) || 4))))
        const rate = Math.max(0.09, Math.min(0.26, Number((options && options.rate) || 0.16)))
        const clips = ['ding', 'winalert', 'payout', 'win']
        for (let i = 0; i < hits; i += 1) {
          const name = i === 0 ? 'winalert' : clips[i % clips.length]
          smSfxOr(name, {
            rate: 0.98 + (i % 3) * 0.03,
            gain: 0.28 * Math.min(1.4, scale),
            delay: i * rate
          }, () => {
            soundTone(ctx, { freq: 1568, at: t + i * rate, length: 0.22, type: 'sine', gain: 0.03 * Math.min(1.6, scale) })
            soundTone(ctx, { freq: 2093, at: t + i * rate, length: 0.12, type: 'sine', gain: 0.012 * Math.min(1.6, scale) })
          })
        }
        break
      }
      case 'alarm': {
        smSfxOr('siren', { rate: 0.92, gain: 0.24, delay: 0 }, () => {
          const turns = Math.max(2, Math.min(8, Math.round(Number((options && options.times) || 4))))
          for (let i = 0; i < turns; i += 1) {
            soundTone(ctx, { freq: i % 2 ? 620 : 830, at: t + i * 0.26, length: 0.22, type: 'sine', gain: 0.02 })
          }
        })
        break
      }
      case 'alarm_fallback': {
        // The jackpot alarm: two tones alternating, like a machine that has decided something
        // enormous just happened. Short, then the coins take over.
        const turns = Math.max(2, Math.min(8, Math.round(Number((options && options.times) || 4))))
        for (let i = 0; i < turns; i += 1) {
          soundTone(ctx, { freq: i % 2 ? 620 : 830, at: t + i * 0.26, length: 0.22, type: 'sine', gain: 0.02 })
        }
        break
      }
      case 'jackpot':
        ;[523, 659, 784, 1047].forEach((freq, index) => soundTone(ctx, { freq, at: t + index * 0.1, length: 0.22, type: 'square', gain: 0.05 }))
        break
      case 'push':
        soundTone(ctx, { freq: 440, at: t, length: 0.14, type: 'sine', gain: 0.045 })
        break
      case 'lose':
        soundTone(ctx, { freq: 320, at: t, length: 0.2, type: 'sine', gain: 0.05, to: 190 })
        break
      // Your hit: a bright, short crack. Their hit: the same shape, lower and heavier, so the
      // two are never confused — landing on them should sound like winning, taking one like losing.
      case 'hitlight':
        soundNoise(ctx, { at: t, length: 0.1, gain: 0.06, low: 2600 })
        soundTone(ctx, { freq: 440, at: t, length: 0.12, type: 'triangle', gain: 0.035, to: 300 })
        break
      case 'hit':
        soundNoise(ctx, { at: t, length: 0.2, gain: 0.11, low: 900 })
        soundTone(ctx, { freq: 150, at: t, length: 0.24, type: 'triangle', gain: 0.035, to: 70 })
        break
      case 'sunk':
        soundNoise(ctx, { at: t, length: 0.5, gain: 0.12, low: 700 })
        soundTone(ctx, { freq: 150, at: t, length: 0.55, type: 'triangle', gain: 0.04, to: 45 })
        break
      case 'miss':
        soundNoise(ctx, { at: t, length: 0.1, gain: 0.03, low: 5000 })
        break
      case 'move':
        soundTone(ctx, { freq: 520, at: t, length: 0.05, type: 'triangle', gain: 0.03 })
        break
      default:
        break
    }
  } catch {
    // Sound must never be the reason a table fails to draw.
  }
}

// The switch, in Settings: one row, remembered on this machine.
function SoundSetting() {
  const [on, setOn] = useState(gamesSoundOn())
  const [volume, setVolume] = useState(() => Math.round(gamesVolume() * 100))
  const row = toggleRow({
    title: 'Table sounds',
    note: 'Recorded slot sounds, deals, hits and wins. Off means silence; the slider sets how loud.',
    name: 'sound',
    on,
    onToggle: () => {
      const next = !on
      gamesSoundSet(next)
      setOn(next)
      if (next) gamesSound('win')
    }
  })
  // One more row, only useful while sounds are on: the volume, remembered on this machine.
  return jsxs('div', {
    children: [
      row,
      jsxs('div', {
        'data-sound-volume': '1',
        style: {
          display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0',
          opacity: on ? 1 : 0.45, borderBottom: `1px solid ${stroke}`
        },
        children: [
          jsx('span', { style: { fontSize: 13, color: text.primary, minWidth: 90 }, children: 'Volume' }),
          jsx('input', {
            type: 'range', min: 0, max: 100, step: 5, value: volume,
            'aria-label': `Table sound volume, ${volume} percent`,
            disabled: !on,
            onChange: event => {
              const next = gamesVolumeSet(event.target.value)
              setVolume(next)
            },
            style: { flex: '1 1 auto', accentColor: accent, cursor: on ? 'pointer' : 'default' }
          }),
          jsx('span', { style: { minWidth: 42, textAlign: 'right', fontSize: 12, color: text.secondary }, children: `${volume}%` })
        ]
      })
    ]
  })
}
