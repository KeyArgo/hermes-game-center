// ---- 45-arena.js: Doctrine Arena arcade renderer and panel
//
// The engine has already run the battle; this file only draws it. Every visual is a pure
// function of the replay clock, so pausing, slow motion and replaying never change a frame.
// Sprites are the embedded CC0 Kenney subset from 46-arena-sprites.js.

const ARENA_COLOURS = ['#7ec8ff', '#ff9f6e', '#9ae66e', '#e579ff']
const ARENA_GLOWS = ['#1b5685', '#8f3f17', '#356e18', '#6c1f82']
// The countdown runs before replay time 0: the tanks hold the first frame while it plays.
const ARENA_INTRO_START = -2.2
const ARENA_INTRO_END = 0.25
// A finished battle is held on the last frame for a moment so the last explosion lands
// before the result card covers the arena.
const ARENA_RESULT_HOLD = 0.4

const arenaClamp = (value, low, high) => Math.max(low, Math.min(high, value))
const arenaWords = (people, seat) =>
  (people[seat] && people[seat].name) ||
  (ARENA_SEATS[seat] && ARENA_SEATS[seat].name) ||
  `Seat ${seat + 1}`

// Degrees, taking the short way round, so a turret never spins backwards through a keyframe.
function arenaLerpAngle(from, to, u) {
  return from + (((((to - from) % 360) + 540) % 360) - 180) * u
}

function arenaStormRadiusAt(t) {
  if (!(t > ARENA_STORM.start)) return null
  const progress = arenaClamp(
    (t - ARENA_STORM.start) / (ARENA_STORM.end - ARENA_STORM.start), 0, 1
  )
  return ARENA_STORM.from + (ARENA_STORM.to - ARENA_STORM.from) * progress
}

// The keyframe at or before t. Frames are a sorted [t, tanks, bullets] list.
function arenaFrameIndex(frames, t) {
  let low = 0
  let high = frames.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if ((frames[mid][0] || 0) <= t) low = mid
    else high = mid - 1
  }
  return low
}

// One tank's pose between two keyframes: [x, y, bodyDeg, turretDeg, hp], or null.
function arenaPose(frames, t, seat) {
  if (!frames.length) return null
  const index = arenaFrameIndex(frames, t)
  const next = Math.min(index + 1, frames.length - 1)
  const a = frames[index] && frames[index][1] && frames[index][1][seat]
  const b = (frames[next] && frames[next][1] && frames[next][1][seat]) || a
  if (!a || !b) return null
  const span = frames[next][0] - frames[index][0]
  const u = span > 0 ? arenaClamp((t - frames[index][0]) / span, 0, 1) : 1
  return [
    a[0] + (b[0] - a[0]) * u,
    a[1] + (b[1] - a[1]) * u,
    arenaLerpAngle(a[2] || 0, b[2] || 0, u),
    arenaLerpAngle(a[3] || 0, b[3] || 0, u),
    (a[4] || 0) + ((b[4] || 0) - (a[4] || 0)) * u
  ]
}

// A tank's full health, from the first keyframe: the armour classes differ (88 to 176).
function arenaStartHp(frames, seat) {
  const first = frames[0] && frames[0][1] && frames[0][1][seat]
  const hp = first && first[4]
  return hp > 0 ? hp : 100
}

function arenaRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r)
    return
  }
  const rad = Math.min(r, w / 2, h / 2)
  ctx.moveTo(x + rad, y)
  ctx.lineTo(x + w - rad, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad)
  ctx.lineTo(x + w, y + h - rad)
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h)
  ctx.lineTo(x + rad, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad)
  ctx.lineTo(x, y + rad)
  ctx.quadraticCurveTo(x, y, x + rad, y)
  ctx.closePath()
}

function arenaImage(uri) {
  if (typeof Image === 'undefined' || !uri) return null
  const image = new Image()
  image.src = uri
  return image
}

// drawImage only when the sprite has decoded and the context has one (the test harness'
// canvas has neither), so a slow sprite shows the floor instead of throwing.
function arenaDrawImage(ctx, image, x, y, w, h) {
  if (image && image.complete && image.naturalWidth && typeof ctx.drawImage === 'function') {
    ctx.drawImage(image, x, y, w, h)
  }
}

function arenaText(ctx, body, x, y, maxWidth) {
  if (typeof ctx.fillText !== 'function') return
  if (maxWidth == null) ctx.fillText(body, x, y)
  else ctx.fillText(body, x, y, maxWidth)
}

// Every effect is keyed off an event and its own index, so a spark pattern is the same on
// every replay and a reduced-motion run draws the same shapes without the motion.
function arenaPreparedEvents(events, frames) {
  const prepared = []
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (!event || typeof event.kind !== 'string') continue
    const seat = event.kind === 'shot' ? event.seat : event.on
    prepared.push({
      event,
      pose: arenaPose(frames, event.t || 0, seat),
      seed: Math.imul(index + 1, 2654435761) >>> 0
    })
  }
  return prepared
}

// Tread stamps, sampled from the keyframes once: [t, x, y, bodyRadians, seat].
function arenaTreadStamps(frames) {
  const stamps = []
  for (let index = 1; index < frames.length; index += 1) {
    const before = (frames[index - 1] && frames[index - 1][1]) || []
    const after = (frames[index] && frames[index][1]) || []
    for (let seat = 0; seat < after.length; seat += 1) {
      const a = before[seat]
      const b = after[seat]
      if (!a || !b || b[4] <= 0) continue
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1.5) continue
      stamps.push([frames[index][0], b[0], b[1], ((b[2] || 0) * Math.PI) / 180, seat])
    }
  }
  return stamps
}

// Tiny, decaying screen shake from recent fire: 1.5 px a shot, 3.5 a hit, 7 a kill.
function arenaShakeAt(prepared, t, reduced) {
  if (reduced) return { x: 0, y: 0 }
  let amplitude = 0
  for (let index = 0; index < prepared.length; index += 1) {
    const event = prepared[index].event
    const age = t - event.t
    const duration = event.kind === 'kill' ? 0.32 : event.kind === 'hit' ? 0.14
      : event.kind === 'shot' ? 0.07 : 0
    if (duration <= 0 || age < 0 || age >= duration) continue
    const start = event.kind === 'kill' ? 7 : event.kind === 'hit' ? 3.5 : 1.5
    const fall = 1 - age / duration
    amplitude += start * fall * fall
  }
  amplitude = Math.min(8, amplitude)
  return { x: Math.sin(t * 115) * amplitude, y: Math.cos(t * 150) * amplitude }
}

// A fixed scatter of chipped concrete: same marks every replay, so a replay looks identical.
const ARENA_DEBRIS = [
  [96, 372, 3, 1.2], [188, 502, 2, 0.9], [252, 268, 2.5, 1.4], [404, 452, 2, 0.7],
  [516, 214, 3, 1.1], [612, 486, 2, 0.8], [708, 320, 2.5, 1.3], [822, 452, 2, 0.9],
  [120, 218, 2, 0.8], [864, 236, 3, 1.2], [332, 372, 2, 0.6], [556, 356, 2.5, 1.0]
]

function arenaDrawFloor(ctx) {
  ctx.fillStyle = '#12161f'
  ctx.fillRect(0, 0, 960, 600)
  ctx.lineWidth = 1
  for (let x = 0; x <= 960; x += 40) {
    ctx.strokeStyle = x % 160 ? '#1a202c' : '#252f42'
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, 600)
    ctx.stroke()
  }
  for (let y = 0; y <= 600; y += 40) {
    ctx.strokeStyle = y % 160 ? '#1a202c' : '#252f42'
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(960, y)
    ctx.stroke()
  }
  for (let x = 160; x < 960; x += 160) {
    for (let y = 160; y < 600; y += 160) {
      ctx.beginPath()
      ctx.moveTo(x - 3, y)
      ctx.lineTo(x + 3, y)
      ctx.moveTo(x, y - 3)
      ctx.lineTo(x, y + 3)
      ctx.stroke()
    }
  }

  // the hall: a painted centre ring with four ticks, so every fight has a middle
  ctx.strokeStyle = '#243044'
  ctx.lineWidth = 2
  ctx.beginPath()
  if (typeof ctx.arc === 'function') ctx.arc(480, 320, 132, 0, Math.PI * 2)
  ctx.stroke()
  ctx.strokeStyle = '#1e2838'
  ctx.lineWidth = 1
  ctx.beginPath()
  if (typeof ctx.arc === 'function') ctx.arc(480, 320, 118, 0, Math.PI * 2)
  ctx.stroke()
  for (let tick = 0; tick < 4; tick += 1) {
    const angle = (tick * Math.PI) / 2 + Math.PI / 4
    ctx.beginPath()
    ctx.moveTo(480 + 118 * Math.cos(angle), 320 + 118 * Math.sin(angle))
    ctx.lineTo(480 + 146 * Math.cos(angle), 320 + 146 * Math.sin(angle))
    ctx.stroke()
  }

  // corner chevrons: the room reads as a pit with four walls
  ctx.strokeStyle = 'rgba(242,179,61,0.20)'
  ctx.lineWidth = 3
  const corners = [[26, 84, 1, 1], [934, 84, -1, 1], [26, 578, 1, -1], [934, 578, -1, -1]]
  for (let index = 0; index < corners.length; index += 1) {
    const corner = corners[index]
    for (let bar = 0; bar < 3; bar += 1) {
      ctx.beginPath()
      ctx.moveTo(corner[0] + corner[2] * bar * 12, corner[1] + corner[3] * 26)
      ctx.lineTo(corner[0] + corner[2] * 26, corner[1] + corner[3] * 26)
      ctx.lineTo(corner[0] + corner[2] * 26, corner[1] + corner[3] * bar * 12)
      ctx.stroke()
    }
  }

  // rubble: small dark chips with one bright edge, so the floor has texture without noise
  for (let index = 0; index < ARENA_DEBRIS.length; index += 1) {
    const chip = ARENA_DEBRIS[index]
    ctx.fillStyle = '#232c3d'
    ctx.fillRect(chip[0], chip[1], chip[2] * 2, chip[3] * 2)
    ctx.fillStyle = '#3d4b66'
    ctx.fillRect(chip[0], chip[1], chip[2] * 2, 1)
  }
  if (typeof ctx.createRadialGradient !== 'function') return
  const vignette = ctx.createRadialGradient(480, 300, 300, 480, 300, 560)
  vignette.addColorStop(0, 'rgba(7,9,14,0)')
  vignette.addColorStop(1, 'rgba(7,9,14,0.65)')
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, 960, 600)
}

// The storm is a closing ring of energy: a tinted danger field outside it, a pulsing glow,
// two counter-rotating dashed arcs and eight nodes riding the perimeter.
function arenaDrawStorm(ctx, t, radius, reduced) {
  if (radius === null) return
  ctx.fillStyle = 'rgba(255,56,100,0.10)'
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(960, 0)
  ctx.lineTo(960, 600)
  ctx.lineTo(0, 600)
  ctx.closePath()
  ctx.arc(480, 300, radius, 0, Math.PI * 2, true)
  ctx.fill('evenodd')

  ctx.save()
  ctx.strokeStyle = 'rgba(255,46,99,0.32)'
  ctx.lineWidth = reduced ? 12 : 12 + 3 * Math.sin(t * 6)
  ctx.beginPath()
  ctx.arc(480, 300, radius, 0, Math.PI * 2)
  ctx.stroke()

  if (!reduced && typeof ctx.setLineDash === 'function') {
    ctx.setLineDash([18, 14])
    ctx.lineDashOffset = -t * 50
    ctx.strokeStyle = '#ff2e63'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(480, 300, radius + 2.5, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([10, 20])
    ctx.lineDashOffset = t * 38
    ctx.strokeStyle = '#ff9eb5'
    ctx.beginPath()
    ctx.arc(480, 300, radius - 2.5, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
  }

  ctx.strokeStyle = '#ff9eb5'
  ctx.lineWidth = 2.5
  ctx.beginPath()
  ctx.arc(480, 300, radius, 0, Math.PI * 2)
  ctx.stroke()

  if (!reduced) {
    ctx.fillStyle = '#ffffff'
    for (let node = 0; node < 8; node += 1) {
      const angle = (node * Math.PI) / 4 + t * 0.35
      ctx.save()
      ctx.translate(480 + radius * Math.cos(angle), 300 + radius * Math.sin(angle))
      ctx.rotate(Math.PI / 4)
      ctx.fillRect(-2.5, -2.5, 5, 5)
      ctx.restore()
    }
  }
  ctx.restore()
}

// Tanks are drawn 1.65x their sprite size: at 960x600 the sprites read as toys.
const ARENA_TANK_SCALE = 1.65

// One tank: seat underglow, hull, and a turret drawn on its own pivot. The Kenney art faces
// up while the engine counts from east, hence the 90 degrees.
function arenaDrawTank(ctx, sprites, people, seat, pose, wreck) {
  const info = people[seat] || {}
  const armour = (info.card && info.card.armour) || 'medium'
  const group = sprites.hulls[seat] || sprites.hulls[0]
  const hull = group && (group[armour] || group.medium)
  const barrel = sprites.barrels[seat]
  const size = ARENA_SPRITES.hullSize[armour] || ARENA_SPRITES.hullSize.medium
  const width = size[0] * ARENA_TANK_SCALE
  const height = size[1] * ARENA_TANK_SCALE

  ctx.save()
  ctx.translate(pose[0], pose[1])
  if (wreck) {
    ctx.globalAlpha = 0.48
  } else {
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.arc(2, 3, width * 0.3, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 0.8
    ctx.strokeStyle = ARENA_GLOWS[seat % ARENA_GLOWS.length]
    ctx.lineWidth = 5
    ctx.beginPath()
    ctx.arc(0, 0, width * 0.32, 0, Math.PI * 2)
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  ctx.save()
  ctx.rotate(((pose[2] + 90) * Math.PI) / 180)
  arenaDrawImage(ctx, hull, -width / 2, -height / 2, width, height)
  ctx.restore()

  ctx.save()
  if (wreck) ctx.translate(6, 4)
  ctx.rotate(((pose[3] + 90 + (wreck ? 28 : 0)) * Math.PI) / 180)
  if (barrel) {
    arenaDrawImage(
      ctx, barrel.image, -barrel.w * ARENA_TANK_SCALE / 2,
      -barrel.h * ARENA_TANK_SCALE * ARENA_SPRITES.barrelPivotY,
      barrel.w * ARENA_TANK_SCALE, barrel.h * ARENA_TANK_SCALE
    )
  }
  ctx.restore()
  ctx.restore()
}

// The top bar: four health cards, the clock, the storm state, and the kill feed.
function arenaDrawHud(ctx, view) {
  const { t, frames, people, prepared, pet, radius } = view
  const cards = [12, 216, 548, 752]
  for (let seat = 0; seat < Math.min(4, people.length); seat += 1) {
    const x = cards[seat]
    const pose = arenaPose(frames, t, seat)
    const hp = pose ? Math.max(0, Math.round(pose[4])) : 0
    const startHp = arenaStartHp(frames, seat)
    let kills = 0
    for (let index = 0; index < prepared.length; index += 1) {
      const event = prepared[index].event
      if (event.kind === 'kill' && event.by === seat && event.t <= t) kills += 1
    }

    ctx.fillStyle = 'rgba(13,17,24,0.88)'
    arenaRoundRect(ctx, x, 10, 196, 48, 8)
    ctx.fill()
    ctx.fillStyle = ARENA_COLOURS[seat]
    ctx.fillRect(x, 10, 4, 48)

    const avatar = seat === 0 && pet && pet.image
    if (avatar) arenaDrawImage(ctx, avatar, x + 10, 18, 32, 32)
    const left = x + (avatar ? 48 : 12)

    ctx.textAlign = 'left'
    ctx.font = '700 13px system-ui, sans-serif'
    ctx.fillStyle = '#f0f4f8'
    arenaText(ctx, `${arenaWords(people, seat)}${seat === 0 ? ' (you)' : ''}`, left, 28, avatar ? 100 : 130)

    ctx.textAlign = 'right'
    ctx.fillStyle = ARENA_COLOURS[seat]
    arenaText(ctx, `${kills} kill${kills === 1 ? '' : 's'}`, x + 186, 28)

    const barWidth = avatar ? 100 : 136
    ctx.fillStyle = '#1e2636'
    ctx.fillRect(left, 38, barWidth, 11)
    ctx.fillStyle = hp <= 0 ? '#2b303a' : hp <= startHp * 0.25 ? '#ff3b5c' : ARENA_COLOURS[seat]
    ctx.fillRect(left, 38, barWidth * arenaClamp(hp / startHp, 0, 1), 11)
    ctx.fillStyle = '#f0f4f8'
    ctx.font = '700 12px monospace'
    arenaText(ctx, hp > 0 ? String(hp) : 'KO', x + 188, 48)
  }

  ctx.fillStyle = 'rgba(13,17,24,0.88)'
  arenaRoundRect(ctx, 422, 10, 116, 48, 8)
  ctx.fill()
  ctx.textAlign = 'center'
  ctx.fillStyle = '#f0f4f8'
  ctx.font = '700 16px monospace'
  const clock = `${String(Math.floor(Math.max(0, t) / 60)).padStart(2, '0')}:${Math.max(0, t % 60).toFixed(1).padStart(4, '0')}`
  arenaText(ctx, clock, 480, 28)
  ctx.font = '700 11px system-ui, sans-serif'
  ctx.fillStyle = radius === null ? '#94a3b8' : '#ff9eb5'
  arenaText(ctx, radius === null ? 'STORM INCOMING' : 'STORM', 480, 46)

  let line = 0
  for (let index = prepared.length - 1; index >= 0 && line < 3; index -= 1) {
    const event = prepared[index].event
    if (event.kind !== 'kill' || t - event.t < 0 || t - event.t > 4.5) continue
    const y = 68 + line * 28
    line += 1
    ctx.fillStyle = 'rgba(13,17,24,0.85)'
    arenaRoundRect(ctx, 736, y, 212, 24, 5)
    ctx.fill()
    ctx.fillStyle = event.by == null ? '#ff2e63' : ARENA_COLOURS[event.by % 4]
    ctx.fillRect(736, y, 3, 24)
    ctx.fillStyle = '#f0f4f8'
    ctx.textAlign = 'left'
    ctx.font = '700 12px system-ui, sans-serif'
    const killer = event.by == null ? 'STORM' : arenaWords(people, event.by)
    arenaText(ctx, `${killer} → ${arenaWords(people, event.on)}`, 744, y + 16, 196)
  }
}

// "3 · 2 · 1 · FIGHT!" over the frozen first frame. Reduced motion keeps one plain fade.
function arenaDrawIntro(ctx, t, reduced) {
  if (t >= ARENA_INTRO_END) return
  const marks = [
    { at: ARENA_INTRO_START, span: 0.6, word: '3' },
    { at: -1.6, span: 0.6, word: '2' },
    { at: -1.0, span: 0.6, word: '1' },
    { at: -0.4, span: 0.65, word: 'FIGHT!' }
  ]
  let mark = marks[0]
  for (let index = 0; index < marks.length; index += 1) {
    if (t >= marks[index].at) mark = marks[index]
  }
  const u = arenaClamp((t - mark.at) / mark.span, 0, 1)
  let scale = 1
  let alpha = 1
  if (reduced) {
    alpha = Math.min(1, (u * mark.span) / 0.1, ((1 - u) * mark.span) / 0.1)
  } else if (mark.word === 'FIGHT!') {
    if (u < 0.28) scale = 0.55 + 0.6 * (1 - (1 - u / 0.28) ** 3)
    else if (u < 0.7) scale = 1.15
    else {
      const w = (u - 0.7) / 0.3
      scale = 1.15 + 0.25 * w
      alpha = 1 - w * w
    }
  } else if (u < 0.25) {
    const z = u / 0.25 - 1
    scale = 2.1 - 1.1 * (1 + 2.70158 * z ** 3 + 1.70158 * z ** 2)
    alpha = u / 0.25
  } else if (u > 0.75) {
    const w = (u - 0.75) / 0.25
    scale = 1 - 0.2 * w * w
    alpha = 1 - w * w
  }
  ctx.save()
  ctx.translate(480, 310)
  if (typeof ctx.scale === 'function') ctx.scale(scale, scale)
  ctx.globalAlpha = alpha
  ctx.textAlign = 'center'
  ctx.font = '900 92px system-ui, sans-serif'
  ctx.fillStyle = '#f0f4f8'
  ctx.strokeStyle = 'rgba(7,9,14,0.9)'
  ctx.lineWidth = 6
  if (typeof ctx.strokeText === 'function') ctx.strokeText(mark.word, 0, 0)
  arenaText(ctx, mark.word, 0, 0)
  ctx.restore()
}

function arenaBullets(ctx, frames, t) {
  if (!frames.length) return
  const index = arenaFrameIndex(frames, t)
  const next = Math.min(index + 1, frames.length - 1)
  const before = frames[index][2] || []
  const after = frames[next][2] || []
  const span = frames[next][0] - frames[index][0]
  const u = span > 0 ? arenaClamp((t - frames[index][0]) / span, 0, 1) : 1

  for (let index2 = 0; index2 < before.length; index2 += 1) {
    const bullet = before[index2]
    if (!bullet) continue
    // A bullet vanishes when it hits or leaves; pair it with the nearest same-seat shot in
    // the next frame, or fall back to the shooter's turret angle for the trail direction.
    let match = null
    let best = 64
    for (let other = 0; other < after.length; other += 1) {
      const candidate = after[other]
      if (!candidate || candidate[2] !== bullet[2]) continue
      const distance = Math.hypot(candidate[0] - bullet[0], candidate[1] - bullet[1])
      if (distance < best) {
        best = distance
        match = candidate
      }
    }
    const pose = arenaPose(frames, t, bullet[2])
    const angle = match && best > 0.01
      ? Math.atan2(match[1] - bullet[1], match[0] - bullet[0])
      : ((pose ? pose[3] : 0) * Math.PI) / 180
    const x = bullet[0] + (match ? (match[0] - bullet[0]) * u : 0)
    const y = bullet[1] + (match ? (match[1] - bullet[1]) * u : 0)

    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(angle)
    ctx.fillStyle = '#ffb703'
    ctx.beginPath()
    ctx.moveTo(0, -2)
    ctx.lineTo(-20, 0)
    ctx.lineTo(0, 2)
    ctx.fill()
    ctx.fillStyle = '#fff6d6'
    ctx.fillRect(-3.5, -1.5, 7, 3)
    ctx.restore()
  }
}

// Muzzle flashes, hit sparks, damage popups and explosions, all from the event list.
function arenaDrawEffects(ctx, view) {
  const { t, prepared, compact, reduced, sprites } = view
  for (let index = 0; index < prepared.length; index += 1) {
    const item = prepared[index]
    const event = item.event
    const age = t - event.t
    if (age < 0 || age > 0.75) continue
    const x = event.x != null ? event.x : item.pose && item.pose[0]
    const y = event.y != null ? event.y : item.pose && item.pose[1]
    if (x == null || y == null) continue

    if (event.kind === 'shot' && !compact && age <= 0.09) {
      const u = age / 0.09
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(((item.pose ? item.pose[3] : 0) * Math.PI) / 180)
      ctx.globalAlpha = reduced ? 0.45 * (1 - u) : (1 - u) ** 2
      ctx.fillStyle = '#ff9e00'
      if (reduced) {
        ctx.beginPath()
        ctx.arc(0, 0, 10, 0, Math.PI * 2)
        ctx.fill()
      } else {
        ctx.beginPath()
        ctx.moveTo(0, -7 * (1 - 0.45 * u))
        ctx.lineTo(22 * (1 - 0.35 * u), 0)
        ctx.lineTo(0, 7 * (1 - 0.45 * u))
        ctx.fill()
        ctx.globalAlpha = 1 - u
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, -3 * (1 - u), 13 * (1 - u), 6 * (1 - u))
      }
      ctx.restore()
    }

    if (event.kind === 'hit') {
      if (age <= 0.22) {
        const u = age / 0.22
        const reach = 4 + 24 * (1 - (1 - u) ** 3)
        ctx.save()
        ctx.globalAlpha = 1 - u * u
        ctx.strokeStyle = u < 0.4 ? '#ffe66d' : '#ff595e'
        ctx.lineWidth = 2
        for (let ray = 0; ray < 8; ray += 1) {
          const angle = (ray * Math.PI) / 4 + ((item.seed >>> (ray * 3)) & 7) * 0.06
          ctx.beginPath()
          ctx.moveTo(x + Math.cos(angle) * reach, y + Math.sin(angle) * reach)
          ctx.lineTo(
            x + Math.cos(angle) * (reach + 9 * (1 - u)),
            y + Math.sin(angle) * (reach + 9 * (1 - u))
          )
          ctx.stroke()
        }
        if (age < 0.1) {
          ctx.strokeStyle = '#ffffff'
          ctx.beginPath()
          ctx.arc(x, y, 4 + 14 * (age / 0.1), 0, Math.PI * 2)
          ctx.stroke()
        }
        ctx.restore()
      }
      if (!compact && age <= 0.45) {
        const u = age / 0.45
        ctx.save()
        ctx.globalAlpha = 1 - u ** 3
        ctx.font = '700 12px monospace'
        ctx.fillStyle = '#ffffff'
        ctx.textAlign = 'center'
        arenaText(ctx, `-${event.damage || 0}`, x, y - 10 - 18 * (1 - (1 - u) ** 2))
        ctx.restore()
      }
    }

    if (event.kind === 'kill') {
      ctx.save()
      if (age < 0.26) {
        const u = age / 0.26
        ctx.globalAlpha = 0.9 * (1 - u)
        ctx.strokeStyle = '#ffe66d'
        ctx.lineWidth = 4 * (1 - u)
        ctx.beginPath()
        ctx.arc(x, y, 8 + 46 * (1 - (1 - u) ** 3), 0, Math.PI * 2)
        ctx.stroke()
      }
      if (age < 0.55) {
        const u = age / 0.55
        const size = 42 + 24 * (1 - (1 - u) ** 2)
        const frame = sprites.explosions[
          Math.min(sprites.explosions.length - 1, Math.floor(u * sprites.explosions.length))
        ]
        ctx.globalAlpha = u < 0.7 ? 1 : (1 - u) / 0.3
        arenaDrawImage(ctx, frame, x - size / 2, y - size / 2, size, size)
      }
      if (age >= 0.1) {
        const u = (age - 0.1) / 0.65
        ctx.globalAlpha = 0.65 * (1 - u)
        ctx.fillStyle = '#2b303a'
        for (let puff = 0; puff < 6; puff += 1) {
          const angle = (puff * Math.PI) / 3
          ctx.beginPath()
          ctx.arc(
            x + Math.cos(angle) * (8 + 26 * u),
            y + Math.sin(angle) * (8 + 26 * u),
            7 + 9 * u, 0, Math.PI * 2
          )
          ctx.fill()
        }
      }
      ctx.restore()
    }
  }
}

function ArenaWinnerTank({ sprites, people, seat }) {
  const canvasRef = useRef(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas && canvas.getContext && canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, 110, 110)
    ctx.save()
    ctx.translate(55, 55)
    if (typeof ctx.scale === 'function') ctx.scale(1.7, 1.7)
    arenaDrawTank(ctx, sprites, people, seat, [0, 0, -110, -105, 100], false)
    ctx.restore()
  }, [sprites, seat])
  return jsx('canvas', {
    ref: canvasRef,
    width: 110,
    height: 110,
    role: 'img',
    'aria-label': `${arenaWords(people, seat)} winning tank`,
    style: { display: 'block' }
  })
}

// The stage: one canvas, the replay clock, the effects, and the controls.
// `height < 260` marks the small cover-art and champions-replay uses, which draw the arena
// only: no HUD, no countdown, no result card, no controls and no sound.
function ArenaStage({ picture, height, onAnnouncement }) {
  const canvasRef = useRef(null)
  const clockRef = useRef({ t: 0, last: null, playing: true, speed: 1 })
  const audioRef = useRef({ context: null })
  const petRef = useRef({ image: null })
  const spritesRef = useRef({ sprites: null })
  const [playing, setPlaying] = useState(true)
  const [slow, setSlow] = useState(false)
  const [sound, setSound] = useState(false)
  const [done, setDone] = useState(false)
  const [closed, setClosed] = useState(false)
  const [pet, setPet] = useState(null)
  const [replayKey, setReplayKey] = useState(0)

  const frames = picture && Array.isArray(picture.frames) ? picture.frames : []
  const people = picture && Array.isArray(picture.combatants) ? picture.combatants : []
  const events = picture && Array.isArray(picture.events) ? picture.events : []
  const result = (picture && picture.result) || {}
  const compact = height < 260
  const still = frames.length === 0

  if (!spritesRef.current.sprites) {
    spritesRef.current.sprites = {
      hulls: ARENA_SPRITES.hulls.map(group => ({
        light: arenaImage(group.light),
        medium: arenaImage(group.medium),
        heavy: arenaImage(group.heavy)
      })),
      barrels: ARENA_SPRITES.barrels.map(barrel => ({
        w: barrel.w, h: barrel.h, image: arenaImage(barrel.uri)
      })),
      explosions: ARENA_SPRITES.explosions.map(sprite => arenaImage(sprite.uri))
    }
  }
  const sprites = spritesRef.current.sprites

  // The person's own pet is only ever DISPLAYED, through the gateway: never copied, never
  // bundled. No pet, no request available, or a refusal all leave the layout closed up.
  useEffect(() => {
    let alive = true
    if (compact || !host || typeof host.request !== 'function') return undefined
    Promise.resolve()
      .then(() => host.request('pet.info', {}))
      .then(info => {
        if (!alive || !info || !info.enabled || !info.slug) return null
        return host.request('pet.thumb', { slug: info.slug, url: '' }).then(thumb => ({ info, thumb }))
      })
      .then(answer => {
        if (!alive || !answer || !answer.thumb || !answer.thumb.dataUri) return
        const image = arenaImage(answer.thumb.dataUri)
        if (!image) return
        const show = () => {
          if (!alive) return
          petRef.current.image = image
          setPet({ image, name: answer.info.displayName || 'Your pet' })
          if (canvasRef.current && canvasRef.current._arenaRedraw) canvasRef.current._arenaRedraw()
        }
        image.onload = show
        if (image.complete && image.naturalWidth) show()
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  useEffect(() => () => {
    const context = audioRef.current && audioRef.current.context
    if (context && typeof context.close === 'function') {
      const closing = context.close()
      if (closing && typeof closing.catch === 'function') closing.catch(() => {})
    }
    audioRef.current.context = null
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas && canvas.getContext && canvas.getContext('2d')
    if (!ctx) return undefined
    canvas.width = 960
    canvas.height = 600
    const reduced = typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches
    const lastFrame = frames.length ? frames[frames.length - 1][0] : 0
    const total = Math.max(0, Number(picture && picture.duration) || lastFrame || 0)
    const end = total + ARENA_RESULT_HOLD

    const clock = clockRef.current
    clock.t = compact || still ? 0 : ARENA_INTRO_START
    clock.last = null
    clock.playing = true
    clock.speed = slow ? 0.5 : 1
    setPlaying(true)
    setDone(false)
    setClosed(false)

    const prepared = arenaPreparedEvents(events, frames)
    const stamps = arenaTreadStamps(frames)
    const deaths = []
    for (let index = 0; index < prepared.length; index += 1) {
      const item = prepared[index]
      if (item.event.kind === 'kill' && item.pose) deaths[item.event.on] = item
    }

    // The floor is painted once into an offscreen canvas; every frame is one blit.
    let floor = null
    if (typeof document !== 'undefined' && document.createElement) {
      floor = document.createElement('canvas')
      floor.width = 960
      floor.height = 600
      const floorCtx = floor.getContext && floor.getContext('2d')
      if (floorCtx) arenaDrawFloor(floorCtx)
      else floor = null
    }

    const seats = people.length || (frames[0] && frames[0][1] ? frames[0][1].length : 4)

    const paint = time => {
      const t = Math.max(0, time)
      const radius = arenaStormRadiusAt(t)
      ctx.clearRect(0, 0, 960, 600)
      const shake = arenaShakeAt(prepared, t, reduced)
      ctx.save()
      ctx.translate(shake.x, shake.y)
      if (floor && typeof ctx.drawImage === 'function') ctx.drawImage(floor, 0, 0)
      else arenaDrawFloor(ctx)

      arenaDrawStorm(ctx, t, radius, reduced)

      for (let index = 0; index < stamps.length; index += 1) {
        const stamp = stamps[index]
        const age = t - stamp[0]
        if (age < 0 || age > 4) continue
        ctx.save()
        ctx.translate(stamp[1], stamp[2])
        ctx.rotate(stamp[3])
        ctx.globalAlpha = 0.32 * (age <= 2.5 ? 1 : (4 - age) / 1.5)
        ctx.fillStyle = '#090b10'
        ctx.fillRect(-1.25, -11.5, 2.5, 5)
        ctx.fillRect(-1.25, 6.5, 2.5, 5)
        ctx.restore()
      }

      for (let seat = 0; seat < seats; seat += 1) {
        const death = deaths[seat]
        const wreck = death && t >= death.event.t
        let pose = wreck ? death.pose : arenaPose(frames, t, seat)
        if (!pose && still) {
          const angle = (2 * Math.PI * seat) / (people.length || 4)
          pose = [
            480 + 206 * Math.cos(angle), 300 + 196 * Math.sin(angle),
            (angle * 180) / Math.PI + 180, (angle * 180) / Math.PI + 180, 100
          ]
        }
        if (!pose) continue

        if (wreck) {
          ctx.globalAlpha = 0.6
          ctx.fillStyle = '#090b10'
          ctx.beginPath()
          ctx.arc(pose[0], pose[1], 22, 0, Math.PI * 2)
          ctx.fill()
          ctx.globalAlpha = 1
        }
        arenaDrawTank(ctx, sprites, people, seat, pose, Boolean(wreck))

        if (wreck) {
          // Two slow puffs of smoke, on a fixed cycle, so the wreck always looks the same.
          for (let puff = 0; puff < 2; puff += 1) {
            const u = ((t - death.event.t + puff * 0.7) % 1.4) / 1.4
            ctx.globalAlpha = 0.35 * Math.sin(u * Math.PI)
            ctx.fillStyle = '#2b303a'
            ctx.beginPath()
            ctx.arc(pose[0] + 8 * u, pose[1] - 22 * u, 4 + 8 * u, 0, Math.PI * 2)
            ctx.fill()
          }
          ctx.globalAlpha = 1
        } else if (!compact) {
          const startHp = arenaStartHp(frames, seat)
          ctx.fillStyle = '#1e2636'
          ctx.fillRect(pose[0] - 16, pose[1] - 32, 32, 4)
          ctx.fillStyle = pose[4] <= startHp * 0.25 ? '#ff3b5c' : ARENA_COLOURS[seat % 4]
          ctx.fillRect(pose[0] - 16, pose[1] - 32, 32 * arenaClamp(pose[4] / startHp, 0, 1), 4)
        }
      }

      arenaBullets(ctx, frames, t)
      arenaDrawEffects(ctx, { t, prepared, compact, reduced, sprites })
      ctx.restore()

      if (!compact) {
        arenaDrawHud(ctx, { t, frames, people, prepared, pet: petRef.current, radius })
        arenaDrawIntro(ctx, time, reduced)
      }
    }

    let frame = 0
    let alive = true
    let completed = false
    let announced = -1
    const redraw = () => { if (alive) paint(clock.t) }
    canvas._arenaRedraw = redraw
    for (let seat = 0; seat < sprites.hulls.length; seat += 1) {
      const group = sprites.hulls[seat]
      for (const key of ['light', 'medium', 'heavy']) if (group[key]) group[key].onload = redraw
      if (sprites.barrels[seat] && sprites.barrels[seat].image) {
        sprites.barrels[seat].image.onload = redraw
      }
    }
    for (let index = 0; index < sprites.explosions.length; index += 1) {
      if (sprites.explosions[index]) sprites.explosions[index].onload = redraw
    }
    if (petRef.current.image) petRef.current.image.onload = redraw

    const blip = (kind, context) => {
      try {
        const oscillator = context.createOscillator()
        const gain = context.createGain()
        const duration = kind === 'kill' ? 0.2 : 0.06
        oscillator.frequency.value = kind === 'kill' ? 90 : kind === 'hit' ? 480 : 750
        gain.gain.setValueAtTime(0.08, context.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + duration)
        oscillator.connect(gain)
        gain.connect(context.destination)
        oscillator.start()
        oscillator.stop(context.currentTime + duration)
      } catch (error) { /* a closed or refused audio context never breaks a replay */ }
    }

    const step = now => {
      const previous = clock.t
      if (clock.playing && clock.last !== null) {
        const delta = Math.min(0.1, Math.max(0, (now - clock.last) / 1000))
        clock.t = Math.min(end, clock.t + delta * clock.speed)
      }
      clock.last = now
      paint(clock.t)

      if (!compact && onAnnouncement && clock.t >= 0) {
        for (let index = 0; index < prepared.length; index += 1) {
          const event = prepared[index].event
          if (event.kind !== 'kill' || index === announced) continue
          if (event.t > previous && event.t <= clock.t) {
            announced = index
            onAnnouncement(
              `${event.by == null ? 'The storm takes' : arenaWords(people, event.by) + ' knocks out'} ${arenaWords(people, event.on)}`
            )
          }
        }
      }

      const context = audioRef.current && audioRef.current.context
      if (context && context.createOscillator && clock.playing && clock.t > previous) {
        for (let index = 0; index < prepared.length; index += 1) {
          const event = prepared[index].event
          if (event.t > previous && event.t <= clock.t &&
              (event.kind === 'shot' || event.kind === 'hit' || event.kind === 'kill')) {
            blip(event.kind, context)
          }
        }
      }

      if (!still && clock.t >= end && !completed) {
        completed = true
        clock.playing = false
        setDone(true)
        setPlaying(false)
        if (!compact && onAnnouncement) {
          const winner = Number.isInteger(result.winner) && result.winner >= 0 &&
            result.winner < people.length ? result.winner : -1
          const kills = (result.kills || [])[winner] || 0
          const hp = (result.hp || [])[winner] || 0
          onAnnouncement(winner < 0
            ? 'The battle ended without a winner.'
            : `${arenaWords(people, winner)} wins with ${kills} kill${kills === 1 ? '' : 's'} and ${hp} HP left.`)
        }
      }
      if (!still && !completed) frame = requestAnimationFrame(step)
    }

    paint(clock.t)
    if (!still) frame = requestAnimationFrame(step)
    return () => {
      alive = false
      canvas._arenaRedraw = null
      cancelAnimationFrame(frame)
    }
  }, [picture && picture.battle_id, picture && picture.battle_seq, replayKey, compact])

  const restart = () => {
    setClosed(false)
    setReplayKey(replayKey + 1)
  }
  const togglePlay = () => {
    const clock = clockRef.current
    clock.playing = !clock.playing
    clock.last = null
    setPlaying(clock.playing)
  }
  const toggleSlow = () => {
    const next = !slow
    clockRef.current.speed = next ? 0.5 : 1
    setSlow(next)
  }
  const toggleSound = () => {
    if (sound) {
      const context = audioRef.current.context
      if (context && typeof context.suspend === 'function') context.suspend()
      setSound(false)
      return
    }
    try {
      const Audio = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)
      if (Audio && !audioRef.current.context) audioRef.current.context = new Audio()
      const context = audioRef.current.context
      if (context && typeof context.resume === 'function') context.resume()
    } catch (error) { /* no audio is a quiet replay, not a broken one */ }
    setSound(true)
  }

  const winner = Number.isInteger(result.winner) && result.winner >= 0 && result.winner < people.length
    ? result.winner : -1
  const control = (label, action, options = {}) => jsx('button', {
    type: 'button',
    onClick: action,
    disabled: options.disabled,
    'aria-pressed': options.pressed,
    'aria-label': options.label,
    style: {
      padding: '6px 10px',
      borderRadius: 7,
      border: `1px solid ${stroke}`,
      background: options.pressed ? accent : 'transparent',
      color: options.pressed ? 'var(--ui-text-on-accent, #0b1220)' : text.secondary,
      cursor: options.disabled ? 'default' : 'pointer',
      opacity: options.disabled ? 0.5 : 1,
      fontSize: 12,
      fontWeight: 600
    },
    children: label
  })

  return jsxs('div', { style: { width: '100%', maxWidth: 960, minWidth: 0 } , children: [
    jsxs('div', {
      style: { position: 'relative', width: '100%', aspectRatio: '960 / 600' },
      children: [
        jsx('canvas', {
          ref: canvasRef,
          role: 'img',
          'aria-label': `Doctrine Arena battle, ${people.length || 4} tanks, ${Math.round(Number(picture && picture.duration) || 0)} seconds`,
          style: {
            display: 'block',
            width: '100%',
            height: '100%',
            maxHeight: height || 'none',
            background: '#12161f',
            borderRadius: 12
          }
        }),
        !compact && done && !closed ? jsxs('div', {
          style: {
            position: 'absolute', inset: 0, background: 'rgba(7,9,14,0.74)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 8
          },
          children: jsxs('div', {
            role: 'dialog',
            'aria-label': 'Battle result',
            style: {
              background: '#0d1118',
              border: `2px solid ${winner < 0 ? '#ff2e63' : ARENA_COLOURS[winner % 4]}`,
              borderRadius: 14,
              padding: '14px 16px',
              color: '#f0f4f8',
              width: '62%',
              maxWidth: 560,
              maxHeight: '94%',
              overflow: 'auto',
              textAlign: 'center'
            },
            children: [
              jsx('div', {
                style: { fontSize: 22, fontWeight: 800 },
                children: winner < 0 ? 'Battle finished' : `${arenaWords(people, winner)} wins`
              }),
              jsx('div', {
                style: { fontSize: 12, color: '#94a3b8', marginTop: 2 },
                children: result.reason === 'timeout' ? 'Survived the storm' : 'Last tank standing'
              }),
              jsxs('div', {
                style: {
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                  margin: '8px 0'
                },
                children: winner < 0 ? null : [
                  jsx(ArenaWinnerTank, { sprites, people, seat: winner, key: 'tank' }),
                  winner === 0 && pet ? jsxs('div', {
                    style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
                    children: [
                      jsx('img', {
                        src: pet.image && pet.image.src, alt: pet.name, width: 64, height: 64,
                        style: { imageRendering: 'pixelated' }
                      }),
                      jsx('div', { style: { fontSize: 11, color: '#94a3b8' }, children: pet.name })
                    ]
                  }, 'pet') : null
                ]
              }),
              jsxs('table', {
                style: { width: '100%', fontSize: 12, borderCollapse: 'collapse', marginBottom: 10 },
                children: [
                  jsx('thead', {
                    children: jsxs('tr', {
                      children: ['Tank', 'Kills', 'Damage', 'HP left'].map(heading => jsx('th', {
                        style: { textAlign: 'left', color: '#94a3b8', fontWeight: 600, padding: '2px 4px' },
                        children: heading
                      }, heading))
                    })
                  }),
                  jsx('tbody', {
                    children: people.map((person, seat) => jsxs('tr', {
                      style: { background: seat === winner ? 'rgba(126,200,255,0.12)' : 'transparent' },
                      children: [
                        jsx('td', {
                          style: { padding: '2px 4px', color: ARENA_COLOURS[seat % 4], fontWeight: 700 },
                          children: person.name || arenaWords(people, seat)
                        }),
                        jsx('td', { children: (result.kills || [])[seat] || 0 }),
                        jsx('td', { children: (result.damage || [])[seat] || 0 }),
                        jsx('td', { children: (result.hp || [])[seat] || 0 })
                      ]
                    }, seat))
                  })
                ]
              }),
              jsxs('div', {
                style: { display: 'flex', gap: 8, justifyContent: 'center' },
                children: [
                  control('Watch again', restart, { label: 'Watch the battle again' }),
                  control('Close', () => setClosed(true), { label: 'Close the result' })
                ]
              })
            ]
          })
        }) : null
      ]
    }),
    !compact ? jsxs('div', {
      role: 'toolbar',
      'aria-label': 'Replay controls',
      style: { display: 'flex', gap: 6, flexWrap: 'wrap', paddingTop: 6, alignItems: 'center' },
      children: [
        control(playing ? 'Pause' : 'Play', togglePlay, { disabled: still || done }),
        control(slow ? 'Half speed on' : 'Half speed', toggleSlow, {
          pressed: slow, disabled: still, label: 'Slow motion'
        }),
        control(sound ? 'Sound on' : 'Sound off', toggleSound, {
          pressed: sound, label: 'Sound'
        }),
        control('Replay', restart, { disabled: still, label: 'Watch again' })
      ]
    }) : null,
    !compact && done && winner >= 0
      ? jsx('span', {
          style: { position: 'absolute', width: 1, height: 1, overflow: 'hidden' },
          children: `${arenaWords(people, winner)} wins`
        })
      : null
  ] })
}

// Doctrine Arena has its own screen too: one big arena, two ways to start a fight, and the
// card and seed controls kept out of the way under More options.
function ArenaPanel({ game, view, board, send, ctx, onBack }) {
  const pictured = (board && board.picture) || startingPicture(ARENA_ID)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [seed, setSeed] = useState('')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  const run = async line => {
    if (busy) return
    setBusy(true)
    setFailure('')
    setAnnouncement('Battle starting')
    try {
      const answer = await send(line)
      if (answer && answer.ok === false) throw new Error(answer.text || 'The arena refused that.')
      if (alive.current) setNotice((answer && answer.text) || '')
      return true
    } catch (error) {
      if (alive.current) setFailure(error.message || 'That did not reach the arena.')
      return false
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const cardLine = pictured && pictured.card_line ? String(pictured.card_line) : ''
  const winner = (pictured && pictured.result && pictured.result.winner)
  const combatants = (pictured && pictured.combatants) || []
  // The engine's winner is a zero-based seat index; the picture also carries the name.
  const winnerName = (pictured && pictured.winner) ||
    (Number.isInteger(winner) ? ((combatants[winner] || {}).name || '') : '')
  const result = pictured && pictured.result
  // A battle that has a winner (or a stated reason) is over: the arena says so on the
  // arena itself, not only in the caption.
  const finished = Boolean(pictured && !pictured.preview && result && (Number.isInteger(winner) || Boolean(winnerName)))
  const caption = pictured && pictured.preview
    ? 'Ready to fight'
    : winnerName ? `${winnerName} wins` : 'Battle finished'
  return jsxs('div', {
    className: 'games-play-table',
    style: { display: 'flex', flexDirection: 'column', gap: 10, padding: 14, paddingBottom: 96, minHeight: 0, height: '100%', overflow: 'auto', background: paper },
    children: [
      jsxs('div', {
        style: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
        children: [
          jsxs('div', { style: { display: 'flex', gap: 12, alignItems: 'center', minWidth: 0 }, children: [
            button('Back', () => { alive.current = false; onBack() }),
            jsx(LearnButton, { game, ctx }),
            jsxs('div', { children: [
              jsx('div', { style: { fontWeight: 700, fontSize: 20 }, children: game.title }),
              game.subtitle ? jsx('div', { style: { fontSize: 12, fontStyle: 'italic', color: text.secondary }, children: game.subtitle }) : null,
              jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: 'Your card against a house card. No model is called while the tanks fight.' })
            ] })
          ] }),
          button(busy ? 'Fighting…' : 'Fight', () => run(`${ARENA_ID} play${seed ? ` ${seed}` : ''}`), { primary: true, disabled: busy })
        ]
      }),
      jsxs('div', {
        role: 'status', 'aria-live': 'polite', className: 'games-status',
        style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 14, fontWeight: 650 },
        children: [
          jsx('span', { 'aria-hidden': true, className: 'games-turn-dot', style: { display: 'inline-block', width: 12, height: 12, borderRadius: '50%', background: '#7ec8ff' } }),
          jsx('span', { children: announcement || caption }),
          result && result.reason ? jsx('span', { style: { fontSize: 12, color: text.tertiary, fontWeight: 400 }, children: String(result.reason) }) : null
        ]
      }),
      jsx('div', {
        className: 'games-board-hero',
        // Same rule as the table: the arena keeps its height when More options opens, so the
        // arena never draws over the header above it.
        style: { display: 'flex', flex: '0 0 auto', alignItems: 'center', justifyContent: 'center', position: 'relative' },
        children: [jsx(ArenaStage, { picture: pictured, height: 560, onAnnouncement: setAnnouncement }),
          // The battle's own result card, on the arena, so the end is not a line of text
          // at the top of the screen.
          finished ? jsx('div', {
            className: 'games-result',
            style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12, background: 'rgba(8, 12, 18, .58)', borderRadius: 12 },
            children: jsxs('section', {
              role: 'alert', 'aria-label': 'Battle over', 'aria-live': 'assertive',
              style: { display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', textAlign: 'center', maxWidth: 460, padding: '18px 20px', borderRadius: 16, border: `2px solid ${accent}`, background: card, boxShadow: '0 20px 44px rgba(0, 0, 0, .55)' },
              children: [
                jsx('div', { className: 'games-result-title', style: { fontSize: 28, fontWeight: 800, lineHeight: 1.1 }, children: winnerName ? `${winnerName} wins` : 'The battle is over' }),
                result && result.reason ? jsx('div', { style: { fontSize: 13, color: text.secondary }, children: String(result.reason) }) : null,
                jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }, children: [
                  button('Fight again', () => run(`${ARENA_ID} play${seed ? ` ${seed}` : ''}`), { primary: true, disabled: busy }),
                  button('Back to games', () => { alive.current = false; onBack() })
                ] })
              ]
            })
          }) : null]
      }),
      failure ? jsx('div', { role: 'alert', style: { padding: 12, border: '1px solid #d76b65', borderRadius: 8, fontSize: 13 }, children: failure }) : null,
      jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' }, children: [
        button('Four-way', () => run(`${ARENA_ID} ffa`), { disabled: busy, title: 'Your card against three house cards, on one arena.' })
      ] }),
      jsxs('details', {
        className: 'games-advanced',
        style: { border: `1px solid ${stroke}`, borderRadius: 12, background: card, padding: '8px 12px' },
        children: [
          jsx('summary', { style: { cursor: 'pointer', fontSize: 12, color: text.secondary, fontWeight: 650 }, children: 'More options' }),
          jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 10 }, children: [
            jsx('div', { style: { fontSize: 12, color: text.secondary }, children: cardLine || 'No card set.' }),
            jsx('input', {
              'aria-label': 'Seed', value: seed, placeholder: 'Seed (optional)',
              onChange: event => setSeed(event.target.value.replace(/[^0-9]/g, '').slice(0, 9)),
              style: { width: 120, padding: '7px 9px', border: `1px solid ${stroke}`, borderRadius: 8, color: text.primary, background: 'transparent' }
            }),
            notice ? pre(notice) : null
          ] })
        ]
      })
    ]
  })
}
