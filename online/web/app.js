// Game Center Online. Boards come from the Desktop plugin module so both draw the same way.
import { createElement as h, Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BoardSvg, coverArt } from '/board.js'

const TOKEN_KEY = 'gc.token'
const SKIN_KEY = 'gc.skin'
const AUTOPLAY_MS = 900
const LOBBY_MS = 5000

// A lobby post is a day old at most: the server deletes the rest, and this page never
// draws anything older. Every post that is drawn carries its own date and time.
const POST_MS = 24 * 3600 * 1000

function postStamp(at) {
  const ms = Number(at || 0) * 1000
  if (!ms) return ''
  const when = new Date(ms)
  const pad = number => String(number).padStart(2, '0')
  return `${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`
}

function freshPosts(rows) {
  const now = Date.now()
  return (Array.isArray(rows) ? rows : []).filter(row =>
    row && Number(row.at || 0) > 0 && now - Number(row.at) * 1000 < POST_MS)
}
const ANSWER_MS = 10000

function storedToken() {
  try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' }
}
function storeToken(token) {
  try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY) } catch {}
}
function storedSkin() {
  try { return localStorage.getItem(SKIN_KEY) === 'classic' ? 'classic' : 'signal' } catch { return 'signal' }
}
function applySkin(skin) {
  const next = skin === 'classic' ? 'classic' : 'signal'
  try { document.documentElement.dataset.skin = next } catch {}
  try { localStorage.setItem(SKIN_KEY, next) } catch {}
  return next
}
try { document.documentElement.dataset.skin = storedSkin() } catch {}

async function api(path, { method = 'GET', body, token, staff } = {}) {
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  if (staff) headers['X-Staff-Key'] = staff
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  let data = {}
  try { data = await response.json() } catch {}
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}).`)
    error.status = response.status
    throw error
  }
  return data
}

function go(path) {
  history.pushState(null, '', path)
  dispatchEvent(new PopStateEvent('popstate'))
}

// The board keeps its aspect ratio; on a phone a fixed 520px frame is mostly empty space.
function useBoardHeight() {
  const pick = () => Math.max(240, Math.min(520, Math.round(innerWidth * 0.8)))
  const [height, setHeight] = useState(pick)
  useEffect(() => {
    const resized = () => setHeight(pick())
    addEventListener('resize', resized)
    return () => removeEventListener('resize', resized)
  }, [])
  return height
}

function usePath() {
  const [path, setPath] = useState(location.pathname)
  useEffect(() => {
    const changed = () => setPath(location.pathname)
    addEventListener('popstate', changed)
    return () => removeEventListener('popstate', changed)
  }, [])
  return path
}

function Button({ children, onClick, kind, disabled, title, type = 'button', ...rest }) {
  return h('button', { type, className: `btn${kind ? ' ' + kind : ''}`, onClick, disabled, title, ...rest }, children)
}

function copy(value, done) {
  const finish = ok => done && done(ok)
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(value).then(() => finish(true), () => finish(false))
    return
  }
  let ok = false
  try {
    const area = document.createElement('textarea')
    area.value = value
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    document.body.appendChild(area)
    area.select()
    ok = document.execCommand('copy')
    document.body.removeChild(area)
  } catch { ok = false }
  finish(ok)
}

function LinkBox({ label, value }) {
  const [state, setState] = useState('')
  const input = useRef(null)
  return h('div', { className: 'stack', style: { gap: 4 } },
    h('span', { className: 'muted small' }, label),
    h('div', { className: 'linkbox' },
      h('input', { ref: input, className: 'input', readOnly: true, value, 'aria-label': label, onFocus: event => event.target.select() }),
      h(Button, { onClick: () => { input.current && input.current.select(); copy(value, ok => { setState(ok ? 'copied' : 'manual'); setTimeout(() => setState(''), 2500) }) } }, state === 'copied' ? 'Copied' : state === 'manual' ? 'Select + copy' : 'Copy')))
}

// Sign in ---------------------------------------------------------------------

function NameGate({ onReady }) {
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [needKey, setNeedKey] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async event => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const made = await api('/api/session', { method: 'POST', body: { name, key: key.trim() || undefined } })
      storeToken(made.token)
      onReady(made.token, made.player)
    } catch (failure) {
      if (failure.status === 409 || failure.status === 401) setNeedKey(true)
      setError(failure.message)
    } finally {
      setBusy(false)
    }
  }
  return h('div', { className: 'shell', style: { maxWidth: 460, paddingTop: 48 } },
    h('div', { className: 'card stack' },
      h('h1', { style: { fontSize: 26 } }, 'Game Center'),
      h('p', { className: 'muted', style: { margin: 0 } }, 'Board games with friends, live. Pick a name to start. You get a recovery key for other browsers and devices.'),
      h('form', { className: 'stack', onSubmit: submit },
        h('label', { className: 'sr', htmlFor: 'name' }, 'Your name'),
        h('input', { id: 'name', className: 'input', value: name, maxLength: 20, autoFocus: true, placeholder: 'Your name', onChange: event => setName(event.target.value) }),
        needKey || key ? h('label', { className: 'sr', htmlFor: 'recovery' }, 'Recovery key') : null,
        needKey || key ? h('input', { id: 'recovery', className: 'input', value: key, autoComplete: 'off', spellCheck: false, placeholder: 'Recovery key', onChange: event => setKey(event.target.value) }) : null,
        h('div', { className: 'row' },
          h(Button, { type: 'submit', kind: 'primary', disabled: busy || name.trim().length < 2 }, needKey ? 'Sign in' : 'Continue'),
          needKey ? null : h('button', { type: 'button', className: 'linkish small', onClick: () => setNeedKey(true) }, 'I have a recovery key'))),
      needKey ? h('p', { className: 'muted small', style: { margin: 0 } }, 'That name is taken. Paste the recovery key you saved when you made it. Lost it? The name and record cannot be recovered; pick a new name.') : null,
      error ? h('div', { className: 'alert', role: 'alert' }, error) : null))
}


// Queue ------------------------------------------------------------------------

const QUEUE_KEY = 'gc.queue'

function readQueue() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(QUEUE_KEY) || 'null')
    return raw && raw.game ? raw : null
  } catch { return null }
}

function saveQueue(value) {
  try { value ? sessionStorage.setItem(QUEUE_KEY, JSON.stringify(value)) : sessionStorage.removeItem(QUEUE_KEY) } catch {}
}

function useQueueStatus(token) {
  const [queued, setQueued] = useState(readQueue)
  const [status, setStatus] = useState(null)
  const game = queued ? queued.game : ''
  const level = queued ? queued.level : ''
  const update = useCallback(value => { saveQueue(value); setQueued(value) }, [])
  useEffect(() => {
    if (!token || !game) { setStatus(null); return }
    let alive = true
    const load = async () => {
      try {
        const data = await api('/api/queue', { token })
        if (!alive) return
        setStatus(data)
        if (!data.queued && !data.matched) update(null)
      } catch (failure) {
        if (!alive) return
        if (failure.status === 401) update(null)
      }
    }
    load()
    const timer = setInterval(load, 3000)
    return () => { alive = false; clearInterval(timer) }
  }, [token, game, level, update])
  return [queued, update, status]
}

function MatchBanner({ queued, status, onSwitch }) {
  if (!queued || !status || !status.matched) return null
  const room = status.matched.room
  return h('div', { className: 'note stack', role: 'status' },
    h('b', null, 'A person is waiting to play.'),
    h('div', null, `Your ${room.title} table is ready (${status.matched.side}). Leave any practice game and switch when you are ready.`),
    h('div', null, h(Button, { kind: 'primary', onClick: onSwitch }, 'Switch to the live table')))
}

// Home ------------------------------------------------------------------------

function Home({ token, me, setMe, queue, setQueue, status, staff, setStaff, hall, onSignOut, initialTab }) {
  const fallback = hall.phase === 'fallback'
  const defaultTab = fallback ? 'lobby' : 'hall'
  const [tab, setTab] = useState(initialTab || defaultTab)
  const activeTab = (fallback && tab === 'hall') ? 'lobby' : tab
  const tabs = fallback
    ? [['lobby', 'Lobby'], ['play', 'Tables'], ['arcade', 'Arcade'], ['board', 'Leaderboard'], ['me', 'You']]
    : [['hall', 'Hall'], ['lobby', 'Lobby'], ['play', 'Tables'], ['arcade', 'Arcade'], ['board', 'Leaderboard'], ['me', 'You']]
  // The Admin tab exists only for a browser holding a working staff key.
  if (staff && staff.role) tabs.push(['admin', 'Admin'])
  return h('div', { className: 'shell' },
    h('header', { className: 'top' },
      h('a', { className: 'brand', href: '/', onClick: event => { event.preventDefault(); setTab(defaultTab) } }, 'Game ', h('span', null, 'Center')),
      h('nav', { className: 'tabs', 'aria-label': 'Sections' },
        tabs.map(([id, label]) => h('button', { key: id, className: 'tab', 'aria-current': activeTab === id ? 'page' : undefined, onClick: () => setTab(id) }, label))),
      h('span', { className: 'who' }, 'Playing as ', h('b', null, me.name), h(RoleBadge, { role: staff && staff.role }))),
    queue && status && status.matched ? h(MatchBanner, { queued: queue, status, onSwitch: () => { setQueue(null); api('/api/queue', { method: 'DELETE', token }).catch(() => {}); go(`/t/${status.matched.room.id}`) } }) : null,
    activeTab === 'hall' ? h(HallTab, { token, me, hall }) : null,
    activeTab === 'play' ? h(PlayTab, { token }) : null,
    activeTab === 'lobby' ? h(LobbyTab, { token, queue, setQueue, status, me }) : null,
    activeTab === 'arcade' ? h(ArcadeTab, null) : null,
    activeTab === 'board' ? h(BoardTab, null) : null,
    activeTab === 'me' ? h(MeTab, { token, me, setMe, staff, setStaff, onSignOut }) : null,
    activeTab === 'admin' && staff && staff.role ? h(AdminPanel, { token, staff, me, setStaff }) : null)
}


function PlayTab({ token }) {
  const [games, setGames] = useState([])
  const [botsWelcome, setBotsWelcome] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  useEffect(() => { api('/api/games').then(data => setGames(data.games), failure => setError(failure.message)) }, [])
  const start = async (game, mode, isPublic) => {
    setBusy(`${game}:${mode}:${isPublic}`)
    setError('')
    try {
      const made = await api('/api/rooms', { method: 'POST', token, body: { game, mode, public: isPublic, bots: botsWelcome && mode === 'two' } })
      go(`/t/${made.room.id}`)
    } catch (failure) {
      setError(failure.message)
      setBusy('')
    }
  }
  return h('section', { className: 'stack', 'aria-label': 'Start a table' },
    error ? h('div', { className: 'alert', role: 'alert' }, error) : null,
    h('label', { className: 'row small muted' },
      h('input', { type: 'checkbox', checked: botsWelcome, onChange: event => setBotsWelcome(event.target.checked) }),
      'Registered bots may take the open seat at tables I open (never rated)'),
    h('div', { className: 'grid' }, games.map(game => h('article', { key: game.id, className: 'card stack' },
      h('div', { className: 'cover', 'aria-hidden': true }, coverArt(game.id, 150)),
      h('h2', null, game.title),
      h('p', { className: 'muted', style: { margin: 0 } }, game.blurb || game.help[0] || ''),
      h('div', { className: 'row' },
        h(Button, { kind: 'primary', disabled: Boolean(busy), onClick: () => start(game.id, 'two', false), title: 'A private table. You get an invite link to send a friend.' }, 'Invite a friend'),
        h(Button, { disabled: Boolean(busy), onClick: () => start(game.id, 'two', true), title: 'Listed under Live tables. Anyone can take the open seat.' }, 'Open table')),
      h('div', { className: 'row' },
        h(Button, { disabled: Boolean(busy), onClick: () => start(game.id, 'bot', true), title: 'The computer plays black. Not rated. Hints on your turn.' }, 'Play the computer'),
        h(Button, { disabled: Boolean(busy), onClick: () => start(game.id, 'bots', true), title: 'Two computer players play while you and others watch.' }, 'Watch bots')),
      game.lesson ? h('div', { className: 'row' },
        h(Button, { disabled: Boolean(busy), onClick: () => start(game.id, 'lesson', false), title: 'A few short steps on a real board. Private, not rated.' }, 'Learn to play')) : null))))
}

// Arcade ----------------------------------------------------------------------

function ArcadeTab() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => { api('/api/arcade').then(setData, failure => setError(failure.message)) }, [])
  if (error) return h('div', { className: 'alert', role: 'alert' }, error)
  if (!data) return h('p', { className: 'muted' }, 'Loading the arcade…')
  const featured = data.tiles.filter(tile => tile.featured)
  const rest = data.tiles.filter(tile => !tile.featured)
  return h('section', { className: 'stack', 'aria-label': 'Community arcade' },
    h('p', { className: 'muted', style: { margin: 0 } },
      'Games other people make and host. We only link to them; they open on the creator\'s own site. Most are works in progress and may have bugs.'),
    featured.map(tile => h(ArcadeTile, { key: tile.id, tile, days: data.removal_days, big: true })),
    rest.length ? h('div', { className: 'grid' }, rest.map(tile => h(ArcadeTile, { key: tile.id, tile, days: data.removal_days }))) : null,
    !data.tiles.length ? h('div', { className: 'card' }, h('p', { className: 'muted', style: { margin: 0 } }, 'No arcade games listed right now.')) : null,
    h('details', { className: 'card' },
      h('summary', { className: 'small' }, 'Already hid your game? Get your code again or check it'),
      h(RemoveGame, { tile: null, days: data.removal_days })))
}

function ArcadeTile({ tile, days, big }) {
  const [removing, setRemoving] = useState(false)
  return h('article', { className: big ? 'card stack featured' : 'card stack' },
    big ? h('h3', null, 'Featured · Nous community arcade') : null,
    h('h2', null, tile.title),
    tile.by ? h('p', { className: 'muted', style: { margin: 0 } }, 'by ', tile.by) : null,
    h('p', { className: tile.label === 'prototype' ? 'warn strong' : 'warn' }, tile.warning),
    tile.blurb ? h('p', { style: { margin: 0 } }, tile.blurb) : null,
    tile.facts.length ? h('ul', { className: 'facts' }, tile.facts.map(fact => h('li', { key: fact }, fact))) : null,
    h('div', { className: 'row' },
      h('a', { className: 'btn primary', href: tile.url, target: '_blank', rel: 'noopener noreferrer' }, big ? 'Visit the arcade ↗' : 'Play on the creator\'s site ↗'),
      tile.repo ? h('a', { className: 'small', href: `https://github.com/${tile.repo}/issues`, target: '_blank', rel: 'noopener noreferrer' }, 'Report a bug to the creator') : null,
      h('button', { type: 'button', className: 'linkish small', onClick: () => setRemoving(!removing), 'aria-expanded': removing }, 'Remove my game')),
    removing ? h(RemoveGame, { tile, days }) : null)
}

function RemoveGame({ tile, days }) {
  const [typed, setTyped] = useState('')
  const [ticket, setTicket] = useState(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  if (tile && !tile.repo) return h('p', { className: 'muted small' }, 'This one has no GitHub repo to check. Contact the Game Center admins to remove it.')
  const ask = async event => {
    event.preventDefault()
    setBusy(true); setNote('')
    try { setTicket(await api('/api/arcade/remove', { method: 'POST', body: tile ? { id: tile.id, repo: typed } : { repo: typed } })) } catch (failure) { setNote(failure.message) }
    setBusy(false)
  }
  const check = async () => {
    setBusy(true); setNote('')
    try { const answer = await api('/api/arcade/check', { method: 'POST', body: { id: ticket.id } }); setNote(answer.text); if (answer.proven) setTicket({ ...ticket, proven: true }) } catch (failure) { setNote(failure.message) }
    setBusy(false)
  }
  if (!ticket) return h('form', { className: 'stack remove', onSubmit: ask },
    h('p', { className: 'small', style: { margin: 0 } }, tile ? 'Is this your game and you don\'t want it here? Type its GitHub repo name to confirm. It is hidden right away.' : 'Type the GitHub repo name you used. You get the same code back.'),
    h('input', { className: 'input', value: typed, onChange: event => setTyped(event.target.value), placeholder: 'owner/name', 'aria-label': 'Repo name', autoComplete: 'off', spellCheck: false }),
    h('div', null, h(Button, { kind: tile ? 'danger' : undefined, type: 'submit', disabled: busy || !typed.trim() }, tile ? 'Hide it' : 'Show my code')),
    note ? h('p', { className: 'alert small', role: 'alert' }, note) : null)
  return h('div', { className: 'stack remove' },
    ticket.proven
      ? h('p', { className: 'small', style: { margin: 0 } }, 'Ownership confirmed. It stays off the shelf.')
      : h('div', { className: 'stack' },
        h('p', { className: 'small', style: { margin: 0 } }, `Hidden. To keep it off for good, prove the repo is yours: add this code to a file named HERMES-REMOVE.txt (or to the README) in ${ticket.repo}, then press Check. Without proof it comes back after ${days} days.`),
        h(LinkBox, { label: 'Your code', value: ticket.code }),
        h('div', null, h(Button, { disabled: busy, onClick: check }, 'Check'))),
    note ? h('p', { className: 'muted small', role: 'status', style: { margin: 0 } }, note) : null)
}

function seatText(seat) {
  if (seat.kind === 'local') return 'Computer'
  return seat.open ? 'open seat' : seat.name + (seat.bot ? ' (bot)' : '')
}

function ratingText(item) {
  const value = item.provisional ? `~${item.rating}` : `${item.rating}`
  return item.provisional ? `${value} provisional` : value
}

const LEVEL_OPTIONS = [['beginner', 'Beginner'], ['intermediate', 'Intermediate'], ['advanced', 'Advanced'], ['expert', 'Expert']]

function LobbyTab({ token, queue, setQueue, status, me }) {
  const [lobby, setLobby] = useState(null)
  const [games, setGames] = useState([])
  const [lobbyError, setLobbyError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [levels, setLevels] = useState({})
  const [selected, setSelected] = useState(queue ? queue.game : '')
  useEffect(() => {
    let alive = true
    api('/api/games').then(data => {
      if (alive) { setGames(data.games || []); setSelected(old => old || (data.games[0] && data.games[0].id) || '') }
    }, failure => { if (alive) setError(failure.message) })
    const load = () => api('/api/lobby').then(data => {
      if (alive) { setLobby(data); setLobbyError(''); setSelected(old => old || (data.games[0] && data.games[0].id) || '') }
    }, failure => { if (alive) setLobbyError(failure.message) })
    load()
    const timer = setInterval(load, LOBBY_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  const levelOf = id => levels[id] || 'intermediate'
  const find = async game => {
    setBusy('find'); setError('')
    try {
      const answer = await api('/api/queue', { method: 'POST', token, body: { game, level: levelOf(game) } })
      if (answer.matched) { setQueue(null); go('/t/' + answer.matched.room.id); return }
      setQueue({ game, level: levelOf(game) })
    } catch (failure) { setError(failure.message) }
    setBusy('')
  }
  const practice = async game => {
    setBusy('practice'); setError('')
    try {
      const made = await api('/api/rooms', { method: 'POST', token, body: { game, mode: 'bot', public: true, level: levelOf(game) } })
      const answer = await api('/api/queue', { method: 'POST', token, body: { game, level: levelOf(game), practice_room: made.room.id } })
      if (answer.matched) { setQueue(null); go('/t/' + answer.matched.room.id); return }
      setQueue({ game, level: levelOf(game) })
      go('/t/' + made.room.id)
    } catch (failure) { setError(failure.message) }
    setBusy('')
  }
  const cancel = async () => {
    setBusy('cancel'); setError('')
    try { await api('/api/queue', { method: 'DELETE', token }); setQueue(null) } catch (failure) { setError(failure.message) }
    setBusy('')
  }
  const cards = !lobbyError && lobby && lobby.games ? lobby.games : games
  const presence = (lobby && lobby.presence) || {}
  const ladder = (lobby && lobby.ladder && lobby.ladder[selected]) || []
  const titleOf = id => (games.find(game => game.id === id) || cards.find(game => game.id === id) || {}).title || id
  const waitingTotal = cards.reduce((sum, game) => sum + (game.waiting || 0) + (game.bots_waiting || 0), 0)
  const here = (presence.humans || []).length
  return h('div', { className: 'lobby' },
    h('main', { className: 'stack', 'aria-label': 'Game lobby' },
      h('div', { className: 'lobby-head' },
        h('div', { className: 'stack', style: { gap: 4 } },
          h('h3', null, 'Tonight at the club'),
          h('h1', null, selected ? titleOf(selected) : 'Choose a table'),
          h('div', { className: 'now' },
            h('em', null, String(waitingTotal)), ' waiting',
            h('span', null, '·'),
            h('em', null, String(here)), ' here')),
        h('div', { className: 'actions' },
          h(Button, { kind: 'primary', className: queue ? 'searching' : undefined, disabled: Boolean(busy || queue || !selected), onClick: () => find(selected) }, queue ? 'searching…' : 'Find a match'),
          h(Button, { disabled: Boolean(busy || !selected || (queue && queue.game !== selected)), onClick: () => practice(selected) }, 'Play the computer'))),
      queue && !(status && status.matched) ? h('div', { className: 'note row', role: 'status' },
        h('span', null, 'Looking for a ' + titleOf(queue.game) + ' opponent.'),
        h(Button, { disabled: Boolean(busy), onClick: cancel }, 'Stop looking')) : null,
      lobbyError ? h('div', { className: 'alert', role: 'alert' }, lobbyError) : null,
      lobbyError ? h('p', { className: 'muted', style: { margin: 0 } }, 'The lobby could not be reached.') : null,
      error ? h('div', { className: 'alert', role: 'alert' }, error) : null,
      h('div', { className: 'tiles' }, cards.map(game => {
        const details = games.find(item => item.id === game.id) || game
        const waiting = (game.waiting || 0) + (game.bots_waiting || 0)
        return h('article', { key: game.id, className: 'tile' + (selected === game.id ? ' on' : '') },
          h('button', { type: 'button', className: 'tile-art', 'aria-label': 'Choose ' + game.title, onClick: () => setSelected(game.id) },
            coverArt(game.id, 150)),
          h('div', { className: 'tile-body' },
            h('div', { className: 'tile-name' },
              h('b', null, game.title),
              waiting ? h('span', { className: 'badge live' }, waiting + ' waiting') : null),
            h('span', { className: 'tile-blurb' }, details.blurb || ''),
            h('div', { className: 'levels', role: 'group', 'aria-label': game.title + ' level' },
              LEVEL_OPTIONS.map(option => h('button', {
                key: option[0], type: 'button', className: 'level',
                'aria-pressed': levelOf(game.id) === option[0] ? 'true' : undefined,
                onClick: () => { setLevels({ ...levels, [game.id]: option[0] }); setSelected(game.id) }
              }, option[1])))
          ))
      })),
      h('section', { className: 'shelf', 'aria-label': "Who's online" },
        h('div', { className: 'shelf-head' },
          h('h2', null, "Who's online"),
          h('span', { className: 'count' }, String((presence.humans || []).length) + ' people · ' + String((presence.bots || []).length) + ' bots')),
        [['humans', 'People'], ['bots', 'Bots']].map(([kind, label]) => h('div', { key: kind, className: 'stack', style: { gap: 6 } },
          h('h3', null, label),
          (presence[kind] || []).length ? presence[kind].map(person => h('div', { key: person.id, className: 'person' },
            h('span', { className: 'row' }, h('span', { className: 'monogram', title: 'Pets show in the Hermes desktop app' }, (person.name || '?').charAt(0).toUpperCase()),
              h('span', { className: 'who-name' }, person.name, kind === 'bots' ? h('span', { className: 'badge' }, 'Bot') : null)),
            h('span', { className: 'muted' }, titleOf(person.game) + ' · ' + ratingText(person)))) : h('span', { className: 'muted' }, 'Nobody here yet.')))),
      h('section', { className: 'shelf', 'aria-label': 'Bot ladder' },
        h('div', { className: 'shelf-head' },
          h('h2', null, 'Ladder'),
          h('span', { className: 'count' }, (selected ? titleOf(selected) + ' · ' : '') + String(ladder.length) + ' rated bots')),
        ladder.length ? h('table', { className: 'lb' },
          h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Bot'), h('th', { className: 'num' }, 'Rating'), h('th', { className: 'num' }, 'W/L/D'))),
          h('tbody', null, ladder.map((row, index) => h('tr', { key: row.id }, h('td', null, index + 1),
            h('td', null, h('a', { href: '/b/' + encodeURIComponent(row.id), onClick: event => { event.preventDefault(); go('/b/' + encodeURIComponent(row.id)) } }, row.name)),
            h('td', { className: 'num' }, ratingText(row)), h('td', { className: 'num' }, row.wins + '/' + row.losses + '/' + row.draws))))) : h('p', { className: 'muted', style: { margin: 0 } }, 'No rated bot games yet.'))),
    h(LobbyChat, { token, me }))
}

function LobbyChat({ token, me }) {
  const [tab, setTab] = useState('lobby')
  const [messages, setMessages] = useState([])
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reporting, setReporting] = useState(null)
  const [thanks, setThanks] = useState('')
  const log = useRef(null)
  useEffect(() => {
    let alive = true
    // The token matters: the server hides the chat of anyone this player blocked,
    // and an anonymous poll would keep showing it.
    const load = () => api('/api/lobby/chat', { token }).then(data => { if (alive) { setMessages(data.messages || []); setPollError('') } }, failure => { if (alive) setPollError(failure.message) })
    load()
    const timer = setInterval(load, LOBBY_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [token])
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight }, [messages.length, tab])
  // Nothing older than the day the lobby keeps, and a post this page cannot date is not
  // shown either: a line without a date and time would break the one rule the rail has.
  const posts = freshPosts(messages)
  const submit = async event => {
    event.preventDefault()
    if (!text.trim() || busy) return
    setBusy(true); setError('')
    try {
      const data = await api('/api/lobby/chat', { method: 'POST', token, body: { text } })
      setMessages(old => [...old.filter(message => message.id !== data.message.id), data.message].slice(-50))
      setText('')
    } catch (failure) { setError(failure.message) }
    setBusy(false)
  }
  return h('aside', { className: 'chat', 'aria-label': 'Lobby chat' },
    h('div', { className: 'shelf-head' },
      h('h2', null, 'The rail'),
      h('span', { className: 'count' }, 'everyone here reads this')),
    h('nav', { className: 'tabs', 'aria-label': 'Chat channels' },
      [['lobby', 'Lobby'], ['game', 'Game']].map(([id, label]) => h('button', { key: id, type: 'button', className: 'tab', 'aria-current': tab === id ? 'page' : undefined, onClick: () => setTab(id) }, label))),
    tab === 'game' ? h('p', { className: 'muted' }, 'You are not at a table yet. Open a table to chat.') : h(Fragment, null,
      h('div', { className: 'log', ref: log, role: 'log', 'aria-live': 'polite' }, posts.length ? posts.map(message => h(MessageLine, {
        key: message.id, message, showStamp: true,
        onReport: me && message.name !== me.name && !message.removed ? setReporting : null
      })) : h('span', { className: 'muted small' }, 'Say hi.')),
      reporting ? h(ReportSheet, { message: reporting, token, roomId: '', onClose: () => setReporting(null), onDone: () => { setReporting(null); setThanks('Reported. A moderator will look at it.') } }) : null,
      thanks ? h('div', { className: 'muted small', role: 'status' }, thanks) : null,
      h('form', { className: 'row', onSubmit: submit }, h('input', { className: 'input', value: text, maxLength: 300, placeholder: 'Message', 'aria-label': 'Lobby chat message', onChange: event => setText(event.target.value) }), h(Button, { type: 'submit', disabled: busy || !text.trim() }, 'Send')),
      error || pollError ? h('div', { className: 'alert', role: 'alert' }, error || pollError) : null))
}

function BoardTab() {
  const [games, setGames] = useState([])
  const [game, setGame] = useState('connect4')
  const [pool, setPool] = useState('humans')
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => { api('/api/games').then(data => setGames(data.games), () => {}) }, [])
  useEffect(() => {
    setRows(null)
    api(`/api/leaderboard?game=${encodeURIComponent(game)}&pool=${pool}`).then(data => { setRows(data.rows); setError('') }, failure => setError(failure.message))
  }, [game, pool])
  return h('section', { className: 'card stack', 'aria-label': 'Leaderboard' },
    h('div', { className: 'row', style: { justifyContent: 'space-between' } },
      h('h2', null, pool === 'bots' ? 'Bot ladder' : 'Leaderboard'),
      h('div', { className: 'row' },
        h('select', { className: 'input', style: { flex: '0 0 auto' }, 'aria-label': 'Pool', value: pool, onChange: event => setPool(event.target.value) },
          h('option', { value: 'humans' }, 'People'), h('option', { value: 'bots' }, 'Bots')),
        h('select', { className: 'input', style: { flex: '0 0 auto' }, 'aria-label': 'Game', value: game, onChange: event => setGame(event.target.value) },
          games.map(item => h('option', { key: item.id, value: item.id }, item.title))))),
    h('p', { className: 'muted', style: { margin: 0 } }, pool === 'bots'
      ? 'Rated bot-versus-bot games only, across different owners, with a separate rating from people. Bots keep their identity when renamed. Same pair: three rated games a day.'
      : 'Ratings count finished games between two people. Bot games are not rated. Players appear here only if they choose to (You → Show me on the leaderboard).'),
    error ? h('div', { className: 'alert', role: 'alert' }, error) : null,
    rows === null ? h('p', { className: 'muted' }, 'Loading…') : !rows.length ? h('p', { className: 'muted' }, pool === 'bots' ? 'No rated bot games yet.' : 'Nobody on this board yet.') :
      h('table', { className: 'lb' },
        h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, pool === 'bots' ? 'Bot' : 'Player'), h('th', { className: 'num' }, 'Rating'), h('th', { className: 'num' }, 'W'), h('th', { className: 'num' }, 'L'), h('th', { className: 'num' }, 'D'))),
        h('tbody', null, rows.map((row, index) => h('tr', { key: row.id || index },
          h('td', null, index + 1),
          h('td', null, pool === 'bots' && row.id
            ? h('a', { href: `/b/${encodeURIComponent(row.id)}`, onClick: event => { event.preventDefault(); go(`/b/${encodeURIComponent(row.id)}`) } }, row.name)
            : row.name),
          h('td', { className: 'num' }, row.rating),
          h('td', { className: 'num' }, row.wins), h('td', { className: 'num' }, row.losses), h('td', { className: 'num' }, row.draws))))))
}

function MeTab({ token, me, setMe, staff, setStaff, onSignOut }) {
  const [name, setName] = useState(me.name)
  const [skin, setSkin] = useState(storedSkin)
  const [stats, setStats] = useState(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { api('/api/me', { token }).then(data => setStats(data.stats), () => {}) }, [token])
  const save = async body => {
    setError('')
    setNotice('')
    try {
      const data = await api('/api/me', { method: 'POST', token, body })
      setMe(data.player)
      setNotice('Saved.')
    } catch (failure) {
      setError(failure.message)
    }
  }
  return h('section', { className: 'stack', style: { maxWidth: 640 } },
    h('div', { className: 'card stack' },
      h('h2', null, 'Your name'),
      h('form', { className: 'row', onSubmit: event => { event.preventDefault(); save({ name }) } },
        h('input', { className: 'input', value: name, maxLength: 20, 'aria-label': 'Your name', onChange: event => setName(event.target.value) }),
        h(Button, { type: 'submit', disabled: name.trim() === me.name }, 'Rename')),
      h('p', { className: 'muted small', style: { margin: 0 } }, me.renamed
        ? `Names stick: you can rename again ${new Date((me.renamed + 30 * 86400) * 1000).toLocaleDateString()}. Your old name stays held for you for 30 days.`
        : 'Names stick: after a rename you keep the new name for 30 days. No rude names.'),
      h('label', { className: 'row' },
        h('input', { type: 'checkbox', checked: Boolean(me.public), onChange: event => save({ public: event.target.checked }) }),
        'Show me on the public leaderboard'),
      notice ? h('div', { className: 'muted', role: 'status' }, notice) : null,
      error ? h('div', { className: 'alert', role: 'alert' }, error) : null),
    h('div', { className: 'card stack' },
      h('h2', null, 'Your record'),
      !stats ? h('p', { className: 'muted' }, 'Loading…') : !stats.rated.length && !stats.bots.length ? h('p', { className: 'muted' }, 'No finished games yet.') :
        h(Fragment, null,
          stats.rated.map(row => h('div', { key: 'r' + row.game }, `${row.game}: rating ${row.rating} · ${row.wins}W ${row.losses}L ${row.draws}D`)),
          stats.bots.map(row => h('div', { key: 'b' + row.game, className: 'muted' }, `${row.game} vs bot: ${row.wins}W ${row.losses}L ${row.draws}D`)))),
    h(BotsCard, { token }),
    h(BlockedCard, { token }),
    h(StaffKeyCard, { token, staff, onStaff: setStaff }),
    h('div', { className: 'card stack' },
      h('h2', null, 'Recovery key'),
      h('p', { className: 'muted', style: { margin: 0 } }, 'Your name plus this key is your account. Copy it somewhere safe and keep it private. Anyone with it can play as you; nobody can read it back to you if you lose it.'),
      h(LinkBox, { label: 'Copy recovery key', value: token }),
      h('p', { className: 'muted small', style: { margin: 0 } }, 'Use it to sign in on another browser or device, or to call the API from your Hermes agent.')),
    h('div', { className: 'card stack' },
      h('h2', null, 'Look'),
      h('label', { className: 'row' },
        h('input', { type: 'checkbox', checked: skin === 'classic', onChange: event => setSkin(applySkin(event.target.checked ? 'classic' : 'signal')) }),
        'Classic look'),
      h('p', { className: 'muted small', style: { margin: 0 } }, 'Off is Signal Hall, a night-hall skin. On keeps the old lamp-lit room.')),
    h('div', { className: 'card stack' },
      h('h2', null, 'This browser'),
      h('p', { className: 'muted', style: { margin: 0 } }, 'Signing out forgets the key here. Your name, rating and bots stay with the account; sign back in with the recovery key.'),
      h('div', null, h(Button, { kind: 'danger', onClick: () => { storeToken(''); if (onSignOut) onSignOut(); location.href = '/' } }, 'Sign out'))))
}

function BotsCard({ token }) {
  const [data, setData] = useState(null)
  const [name, setName] = useState('')
  const [made, setMade] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = () => api('/api/bots', { token }).then(setData, failure => setError(failure.message))
  useEffect(() => { load() }, [token])
  const create = async event => {
    event.preventDefault()
    setBusy(true); setError('')
    try { setMade(await api('/api/bots', { method: 'POST', token, body: { name } })); setName(''); load() } catch (failure) { setError(failure.message) }
    setBusy(false)
  }
  const remove = async bot => {
    setBusy(true); setError('')
    try { await api(`/api/bots/${encodeURIComponent(bot.id)}`, { method: 'DELETE', token }); if (made && made.bot.id === bot.id) setMade(null); load() } catch (failure) { setError(failure.message) }
    setBusy(false)
  }
  const bots = (data && data.bots) || []
  return h('div', { className: 'card stack' },
    h('h2', null, 'Your bots'),
    h('p', { className: 'muted', style: { margin: 0 } },
      'A bot is a program (your Hermes agent, or code you wrote) that plays under its own name with a bot badge. It sits only at tables whose host invites it or welcomes bots. Bot games are never rated, and bots cannot chat.'),
    bots.map(bot => h('div', { key: bot.id, className: 'row', style: { justifyContent: 'space-between' } },
      h('span', null, bot.name, h('span', { className: 'badge bot' }, 'BOT'),
        h('a', { className: 'small', style: { marginLeft: 8 }, href: `/b/${encodeURIComponent(bot.id)}`, onClick: event => { event.preventDefault(); go(`/b/${encodeURIComponent(bot.id)}`) } }, 'Ladder record')),
      h(Button, { kind: 'danger', disabled: busy, onClick: () => remove(bot) }, 'Switch off'))),
    made ? h('div', { className: 'stack remove' },
      h('p', { className: 'small', style: { margin: 0 } }, `${made.bot.name} is ready. Copy its key now: it is shown only once. Anyone with the key plays as this bot.`),
      h(LinkBox, { label: 'Secret key', value: made.key }),
      h('p', { className: 'muted small', style: { margin: 0 } }, 'Run the starter bot: python starter_bot.py --key KEY --table "INVITE LINK". Get it from the plugin folder online/examples/.')) : null,
    data && bots.length < data.limit ? h('form', { className: 'row', onSubmit: create },
      h('input', { className: 'input', value: name, maxLength: 20, placeholder: 'Bot name', 'aria-label': 'Bot name', onChange: event => setName(event.target.value) }),
      h(Button, { type: 'submit', disabled: busy || !name.trim() }, 'Make a bot')) : null,
    data && bots.length >= data.limit ? h('p', { className: 'muted small', style: { margin: 0 } }, `You have the most bots allowed (${data.limit}).`) : null,
    error ? h('div', { className: 'alert', role: 'alert' }, error) : null)
}

// Hall (lobby socket + play requests) ----------------------------------------

const LOBBY_PING_MS = 20000
const LOBBY_BACKOFF_S = [1, 2, 4, 8, 15]
const REQUESTABLE_GAMES = [
  ['connect4', 'Connect Four'],
  ['reversi', 'Reversi'],
  ['checkers', 'Checkers'],
  ['gomoku', 'Gomoku'],
  ['chessboard', 'Chess'],
  ['go', 'Go'],
  ['hex', 'Hex'],
  ['breakthrough', 'Breakthrough'],
  ['seabattle', 'Sea Battle'],
]
const REQUESTABLE_IDS = REQUESTABLE_GAMES.map(item => item[0])
const REQUESTABLE_SET = new Set(REQUESTABLE_IDS)
const GAME_TITLES = Object.fromEntries(REQUESTABLE_GAMES)
const STATUS_LABEL = { online: 'Online', away: 'Away', playing: 'Playing' }

function defaultPrefs() {
  const games = {}
  for (const id of REQUESTABLE_IDS) games[id] = false
  return { open: false, games }
}

function normalizePrefs(raw) {
  const base = defaultPrefs()
  if (!raw || typeof raw !== 'object') return base
  const open = Boolean(raw.open)
  const src = (raw.games && typeof raw.games === 'object') ? raw.games : {}
  for (const id of REQUESTABLE_IDS) {
    if (id in src) base.games[id] = Boolean(src[id])
  }
  if (open && !REQUESTABLE_IDS.some(id => base.games[id])) {
    for (const id of REQUESTABLE_IDS) base.games[id] = true
  }
  base.open = open
  return base
}

function sortRoster(rows) {
  return [...rows].sort((a, b) => {
    const an = String((a && a.name) || '')
    const bn = String((b && b.name) || '')
    const cmp = an.toLowerCase().localeCompare(bn.toLowerCase())
    if (cmp !== 0) return cmp
    if (an !== bn) return an.localeCompare(bn)
    return String((a && a.id) || '').localeCompare(String((b && b.id) || ''))
  })
}

function useLobby(token) {
  const [state, setState] = useState(() => ({
    phase: token ? 'connecting' : 'idle',
    you: null,
    prefs: defaultPrefs(),
    invisible: false,
    roster: [],
    more: 0,
    requests: [],
    rev: 0,
    error: '',
    notice: '',
  }))
  const ws = useRef(null)
  const waiters = useRef(new Map())
  const opRef = useRef(0)

  const close = useCallback(() => {
    for (const waiter of waiters.current.values()) {
      waiter({ ok: false, text: 'Signed out.' })
    }
    waiters.current.clear()
    if (ws.current) {
      ws.current.close()
      ws.current = null
    }
  }, [])

  useEffect(() => {
    if (!token) {
      close()
      setState({
        phase: 'idle',
        you: null,
        invisible: false,
        prefs: defaultPrefs(),
        roster: [],
        more: 0,
        requests: [],
        rev: 0,
        error: '',
        notice: '',
      })
      return
    }
    let alive = true
    let retry = 0
    let everHello = false
    let reconnectTimer = null
    let pingTimer = null
    setState(old => ({ ...old, phase: 'connecting', error: '' }))

    const open = () => {
      if (!alive) return
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/lobby/socket`)
      ws.current = socket
      socket.onopen = () => {
        if (!alive) { socket.close(); return }
        socket.send(JSON.stringify({ t: 'auth', token, client: 'web' }))
        clearInterval(pingTimer)
        pingTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ t: 'ping' }))
          }
        }, LOBBY_PING_MS)
      }
      socket.onmessage = event => {
        let message
        try { message = JSON.parse(event.data) } catch { return }
        if (!alive || !message || typeof message !== 'object') return
        if (message.t === 'hello') {
          everHello = true
          retry = 0
          setState({
            phase: 'live',
            you: message.you || null,
            invisible: Boolean(message.you && message.you.invisible),
            prefs: normalizePrefs(message.prefs),
            roster: sortRoster(Array.isArray(message.roster) ? message.roster : []),
            more: Number(message.more || 0),
            requests: Array.isArray(message.requests) ? message.requests : [],
            rev: Number(message.rev || 0),
            error: '',
            notice: '',
          })
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ t: 'away', on: true }))
          }
        } else if (message.t === 'presence') {
          if (message.row && message.row.id) {
            setState(old => ({
              ...old,
              roster: sortRoster([...old.roster.filter(item => item.id !== message.row.id), message.row]),
              rev: message.rev !== undefined ? Number(message.rev) : old.rev,
            }))
          }
        } else if (message.t === 'gone') {
          if (message.id) {
            setState(old => ({
              ...old,
              roster: old.roster.filter(item => item.id !== message.id),
              rev: message.rev !== undefined ? Number(message.rev) : old.rev,
            }))
          }
        } else if (message.t === 'request') {
          if (message.request && message.request.id) {
            const req = message.request
            setState(old => ({
              ...old,
              requests: [req, ...old.requests.filter(item => item.id !== req.id)],
            }))
          }
        } else if (message.t === 'request_update') {
          if (message.request && message.request.id) {
            const req = message.request
            setState(old => {
              const exists = old.requests.some(item => item.id === req.id)
              const requests = exists
                ? old.requests.map(item => item.id === req.id ? req : item)
                : [req, ...old.requests]
              let notice = old.notice
              const myId = old.you && old.you.id
              if (myId && req.from && req.from.id === myId && req.to && req.to.name) {
                const gameTitle = GAME_TITLES[req.game] || req.game
                if (req.state === 'declined') notice = `${req.to.name} declined your ${gameTitle} request.`
                else if (req.state === 'expired') notice = `Your ${gameTitle} request to ${req.to.name} expired.`
                else if (req.state === 'unavailable') notice = `${req.to.name} is no longer available.`
              }
              return { ...old, requests, notice }
            })
          }
        } else if (message.t === 'seated') {
          if (message.room_id) {
            setState(old => ({
              ...old,
              requests: message.request_id
                ? old.requests.filter(item => item.id !== message.request_id)
                : old.requests,
            }))
            go(`/t/${message.room_id}`)
          }
        } else if (message.t === 'ack') {
          const waiter = waiters.current.get(message.op)
          if (waiter) {
            waiters.current.delete(message.op)
            waiter(message)
          }
        } else if (message.t === 'error') {
          if (message.code === 'auth') {
            alive = false
            setState(old => ({ ...old, phase: 'fallback', error: message.text || '' }))
            socket.close()
          } else {
            setState(old => ({ ...old, error: message.text || '' }))
          }
        }
      }
      socket.onclose = () => {
        clearInterval(pingTimer)
        for (const waiter of waiters.current.values()) {
          waiter({ ok: false, text: 'Connection lost. Reconnecting…' })
        }
        waiters.current.clear()
        if (!alive) return
        if (!everHello) {
          setState(old => ({ ...old, phase: 'fallback' }))
        } else {
          setState(old => ({ ...old, phase: 'reconnecting' }))
        }
        const baseSec = LOBBY_BACKOFF_S[Math.min(retry, LOBBY_BACKOFF_S.length - 1)]
        retry += 1
        const jitterMs = Math.floor(Math.random() * 400)
        reconnectTimer = setTimeout(open, baseSec * 1000 + jitterMs)
      }
    }

    const onVisibility = () => {
      const socket = ws.current
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: 'away', on: document.visibilityState === 'hidden' }))
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    open()

    return () => {
      alive = false
      clearTimeout(reconnectTimer)
      clearInterval(pingTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      close()
    }
  }, [token, close])

  const send = useCallback(frame => new Promise(resolve => {
    const socket = ws.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      resolve({ ok: false, text: 'Not connected to the hall yet.' })
      return
    }
    opRef.current += 1
    const op = String(opRef.current)
    const timer = setTimeout(() => {
      if (!waiters.current.has(op)) return
      waiters.current.delete(op)
      resolve({ ok: false, text: 'No answer from the hall. Reconnecting…' })
      if (ws.current === socket) socket.close()
    }, ANSWER_MS)
    waiters.current.set(op, answer => {
      clearTimeout(timer)
      resolve(answer)
    })
    socket.send(JSON.stringify({ ...frame, op }))
  }), [])

  const setOpen = useCallback(async nextOpen => {
    let snapshot
    setState(old => {
      snapshot = old.prefs
      const games = { ...old.prefs.games }
      if (nextOpen && !REQUESTABLE_IDS.some(id => games[id])) {
        for (const id of REQUESTABLE_IDS) games[id] = true
      }
      return { ...old, prefs: { open: Boolean(nextOpen), games }, error: '' }
    })
    const answer = await send({ t: 'prefs', open: Boolean(nextOpen) })
    if (!answer.ok && snapshot) {
      setState(old => ({ ...old, prefs: snapshot, error: answer.text || 'Could not save preferences.' }))
    }
    return answer
  }, [send])

  // Appearing offline: it is saved on the account, so it holds across a reload, and the
  // server keeps you out of everyone else's list and refuses requests either way.
  const setInvisible = useCallback(async next => {
    let was = false
    setState(old => { was = Boolean(old.invisible); return { ...old, invisible: Boolean(next), error: '', notice: '' } })
    const answer = await send({ t: 'prefs', invisible: Boolean(next) })
    if (!answer.ok) setState(old => ({ ...old, invisible: was, error: answer.text || 'Could not save preferences.' }))
    return answer
  }, [send])

  const toggleGame = useCallback(async gameId => {
    let snapshot
    let nextVal = false
    setState(old => {
      snapshot = old.prefs
      nextVal = !old.prefs.games[gameId]
      const games = { ...old.prefs.games, [gameId]: nextVal }
      return { ...old, prefs: { ...old.prefs, games }, error: '' }
    })
    const answer = await send({ t: 'prefs', games: { [gameId]: nextVal } })
    if (!answer.ok && snapshot) {
      setState(old => ({ ...old, prefs: snapshot, error: answer.text || 'Could not save preferences.' }))
    }
    return answer
  }, [send])

  const ask = useCallback(async (toId, gameId) => {
    setState(old => ({ ...old, error: '', notice: '' }))
    const answer = await send({ t: 'request', to: toId, game: gameId })
    if (!answer.ok) {
      setState(old => ({ ...old, error: answer.text || 'Could not send request.' }))
    }
    return answer
  }, [send])

  const respond = useCallback(async (requestId, accept) => {
    setState(old => ({ ...old, error: '', notice: '' }))
    const answer = await send({ t: 'respond', id: requestId, accept: Boolean(accept) })
    if (!answer.ok) {
      setState(old => ({ ...old, error: answer.text || 'Could not respond to request.' }))
    } else if (!accept) {
      setState(old => ({
        ...old,
        requests: old.requests.map(item => item.id === requestId ? { ...item, state: 'declined' } : item),
      }))
    }
    return answer
  }, [send])

  const cancel = useCallback(async requestId => {
    setState(old => ({ ...old, error: '', notice: '' }))
    const answer = await send({ t: 'cancel', id: requestId })
    if (!answer.ok) {
      setState(old => ({ ...old, error: answer.text || 'Could not cancel request.' }))
    } else {
      setState(old => ({
        ...old,
        requests: old.requests.map(item => item.id === requestId ? { ...item, state: 'cancelled' } : item),
      }))
    }
    return answer
  }, [send])

  return { ...state, send, setOpen, setInvisible, toggleGame, ask, respond, cancel, close }
}

function countdownSeconds(req, nowSec) {
  if (typeof req.expires === 'number' && req.expires > 0) {
    return Math.max(0, Math.min(90, Math.ceil(req.expires - nowSec)))
  }
  if (typeof req.created === 'number' && req.created > 0) {
    return Math.max(0, Math.min(90, Math.ceil(req.created + 90 - nowSec)))
  }
  return 90
}

function HallTab({ token, me, hall }) {
  const [askingId, setAskingId] = useState('')
  const [busyId, setBusyId] = useState('')
  const [nowSec, setNowSec] = useState(() => Date.now() / 1000)

  const myId = (hall.you && hall.you.id) || (me && me.id) || ''
  const myName = (hall.you && hall.you.name) || (me && me.name) || ''
  const prefs = hall.prefs || defaultPrefs()
  const pendingRequests = (hall.requests || []).filter(item => item && item.state === 'pending')
  // A match offer is not an ask: neither person sent it, so either may join it.
  const offers = pendingRequests.filter(item => item.offer)
  const incoming = pendingRequests.filter(item => !item.offer && item.to && item.to.id === myId)
  const outgoing = pendingRequests.filter(item => !item.offer && item.from && item.from.id === myId)

  useEffect(() => {
    if (!pendingRequests.length) return
    setNowSec(Date.now() / 1000)
    const timer = setInterval(() => setNowSec(Date.now() / 1000), 1000)
    return () => clearInterval(timer)
  }, [pendingRequests.length])

  const anyMyGame = REQUESTABLE_IDS.some(id => Boolean(prefs.games && prefs.games[id]))
  const myAccepted = new Set(
    (prefs.open || anyMyGame)
      ? REQUESTABLE_IDS.filter(id => Boolean(prefs.games && prefs.games[id]))
      : REQUESTABLE_IDS
  )
  const titleOf = id => GAME_TITLES[id] || id

  const myRosterRow = (hall.roster || []).find(row => row.id === myId)
  const myStatus = (myRosterRow && myRosterRow.status) || 'online'
  const onlineCount = (hall.roster || []).filter(row => row.status === 'online').length
  const playingCount = (hall.roster || []).filter(row => row.status === 'playing').length

  const hasPendingPair = otherId => pendingRequests.some(
    req => (req.from && req.from.id === otherId) || (req.to && req.to.id === otherId)
  )

  const onAskGame = async (targetId, gameId) => {
    setBusyId(`ask:${targetId}:${gameId}`)
    const answer = await hall.ask(targetId, gameId)
    setBusyId('')
    if (answer && answer.ok) setAskingId('')
  }

  const onRespond = async (reqId, accept) => {
    setBusyId(`respond:${reqId}`)
    await hall.respond(reqId, accept)
    setBusyId('')
  }

  const onCancel = async reqId => {
    setBusyId(`cancel:${reqId}`)
    await hall.cancel(reqId)
    setBusyId('')
  }

  return h('div', { className: 'hall' },
    h('main', { className: 'stack', 'aria-label': 'The Hall' },
      h('div', { className: 'hall-head' },
        h('div', { className: 'stack', style: { gap: 4 } },
          h('h3', null, 'Players online'),
          h('h1', null, 'The Hall'),
          h('div', { className: 'counts' },
            h('em', null, String(onlineCount)), ' online',
            h('span', null, '·'),
            h('em', null, String(playingCount)), ' playing',
            hall.more > 0 ? h(Fragment, null, h('span', null, '·'), `+${hall.more} more`) : null)),
        hall.phase === 'reconnecting' ? h('span', { className: 'badge' }, 'Reconnecting…') : null),

      hall.error ? h('div', { className: 'alert', role: 'alert' }, hall.error) : null,
      hall.notice ? h('div', { className: 'note', role: 'status' }, hall.notice) : null,

      offers.length ? h('section', { className: 'hall-requests', 'aria-label': 'Match offers' },
        offers.map(req => {
          const left = countdownSeconds(req, nowSec)
          const other = (req.from && req.from.id === myId ? req.to : req.from) || {}
          const otherName = other.name || 'Someone'
          return h('article', { key: req.id, className: 'hall-request incoming offer', role: 'status' },
            h('div', { className: 'hall-request-body' },
              h('div', null, h('b', null, otherName), ' wants to play ', h('b', null, titleOf(req.game)),
                ' — you are both looking for it'),
              h('div', { className: 'hall-request-meta' },
                h('span', null, 'Find match · private unrated table · right away'),
                h('span', { className: 'hall-countdown', 'aria-label': `${left} seconds left` }, `${left}s`))),
            h('div', { className: 'row' },
              h(Button, { kind: 'primary', disabled: Boolean(busyId), onClick: () => onRespond(req.id, true) }, 'Join'),
              h(Button, { disabled: Boolean(busyId), onClick: () => onRespond(req.id, false) }, 'Not now')))
        }),
        h('p', { className: 'muted small', style: { margin: 0 } },
          'Find match is on for you too — press Join to sit down together. Nothing here is sent to your Hermes model.')) : null,

      (incoming.length || outgoing.length) ? h('section', { className: 'hall-requests', 'aria-label': 'Game requests' },
        incoming.map(req => {
          const left = countdownSeconds(req, nowSec)
          const fromName = (req.from && req.from.name) || 'Someone'
          return h('article', { key: req.id, className: 'hall-request incoming', role: 'status' },
            h('div', { className: 'hall-request-body' },
              h('div', null, h('b', null, fromName), ' wants to play ', h('b', null, titleOf(req.game))),
              h('div', { className: 'hall-request-meta' },
                h('span', null, 'Private unrated table · seats right away'),
                h('span', { className: 'hall-countdown', 'aria-label': `${left} seconds left` }, `${left}s`))),
            h('div', { className: 'row' },
              h(Button, { kind: 'primary', disabled: Boolean(busyId), onClick: () => onRespond(req.id, true) }, 'Accept'),
              h(Button, { kind: 'danger', disabled: Boolean(busyId), onClick: () => onRespond(req.id, false) }, 'Decline')))
        }),
        outgoing.map(req => {
          const left = countdownSeconds(req, nowSec)
          const toName = (req.to && req.to.name) || 'opponent'
          return h('article', { key: req.id, className: 'hall-request outgoing', role: 'status' },
            h('div', { className: 'hall-request-body' },
              h('div', null, 'Asked ', h('b', null, toName), ' to play ', h('b', null, titleOf(req.game))),
              h('div', { className: 'hall-request-meta' },
                h('span', null, 'Waiting for an answer'),
                h('span', { className: 'hall-countdown', 'aria-label': `${left} seconds left` }, `${left}s`))),
            h('div', { className: 'row' },
              h(Button, { disabled: Boolean(busyId), onClick: () => onCancel(req.id) }, 'Cancel')))
        })) : null,

      h('section', { className: `hall-you${prefs.open ? '' : ' closed'}`, 'aria-label': 'Your game request settings' },
        h('div', { className: 'hall-you-head' },
          h('div', { className: 'hall-you-who' },
            h('span', { className: `status-dot ${hall.invisible ? 'away' : myStatus}`, title: STATUS_LABEL[myStatus] || myStatus, 'aria-hidden': 'true' }),
            h('span', null, myName),
            h('span', { className: 'badge' }, hall.invisible ? 'Appearing offline' : 'You')),
          h('div', { className: 'row' },
            h('label', { className: 'hall-switch', title: 'When this is on you are in nobody else\u2019s list, and nobody can ask you to a game.' },
              h('input', {
                type: 'checkbox',
                role: 'switch',
                checked: Boolean(hall.invisible),
                onChange: event => hall.setInvisible(event.target.checked),
              }),
              'Appear offline'),
            h('label', { className: 'hall-switch', title: 'When this is on, other people in the Hall can ask you for the games highlighted below.' },
              h('input', {
                type: 'checkbox',
                role: 'switch',
                checked: Boolean(prefs.open),
                onChange: event => hall.setOpen(event.target.checked),
              }),
              'Take game requests'))),
        h('p', { className: 'muted small' }, hall.invisible
          ? 'You are appearing offline: you are not in anyone else\u2019s list, and requests to you are refused. Turn it off to be listed again.'
          : 'You are listed in the Hall for everyone who is online. Turn on "Appear offline" to be hidden.'),
        h('p', { className: 'muted small' }, prefs.open
          ? 'People in the Hall can ask you to play the games highlighted below.'
          : 'Turn on "Take game requests" when you want others in the Hall to ask you for a game.'),
        h('div', { className: 'hall-toggles', role: 'group', 'aria-label': 'Games you accept' },
          REQUESTABLE_GAMES.map(([id, title]) => {
            const on = Boolean(prefs.games && prefs.games[id])
            return h('button', {
              key: id,
              type: 'button',
              className: 'hall-toggle',
              'aria-pressed': on ? 'true' : 'false',
              onClick: () => hall.toggleGame(id),
            }, title)
          }))),

      h('section', { className: 'shelf', 'aria-label': 'Hall roster' },
        h('div', { className: 'shelf-head' },
          h('h2', null, 'Who is here'),
          h('span', { className: 'count' },
            `${(hall.roster || []).length} in the hall` + (hall.more > 0 ? ` · +${hall.more} more` : ''))),
        !(hall.roster || []).length
          ? h('p', { className: 'muted', style: { paddingTop: 12 } }, hall.phase === 'connecting' ? 'Joining the hall…' : 'Nobody else is in the hall right now.')
          : h('div', { className: 'hall-roster', role: 'list' },
            (hall.roster || []).map(row => {
              const isMe = row.id === myId
              const status = row.status || 'online'
              const accepted = Array.isArray(row.games) ? row.games.filter(id => REQUESTABLE_SET.has(id)) : []
              const shared = accepted.filter(id => myAccepted.has(id))
              const pendingPair = !isMe && hasPendingPair(row.id)
              const canAsk = !isMe && status === 'online' && shared.length > 0 && !pendingPair
              const askOpen = askingId === row.id && canAsk
              const askTitle = isMe
                ? undefined
                : pendingPair
                  ? 'Request already pending'
                  : status !== 'online'
                    ? `${row.name} is ${status}`
                    : !accepted.length
                      ? `${row.name} is not taking requests`
                      : !shared.length
                        ? 'No games in common — enable one of their games on your card'
                        : `Ask ${row.name} for a game`
              return h('div', { key: row.id, className: 'hall-row', role: 'listitem' },
                h('div', { className: 'hall-row-main' },
                  h('div', { className: 'hall-person' },
                    h('span', {
                      className: `status-dot ${status}`,
                      title: STATUS_LABEL[status] || status,
                      'aria-label': STATUS_LABEL[status] || status,
                    }),
                    h('span', { className: 'hall-person-name' }, row.name, isMe ? ' (you)' : ''),
                    h('span', { className: 'hall-person-status' }, STATUS_LABEL[status] || status)),
                  h('div', { className: 'hall-chips', 'aria-label': `${row.name}'s games` },
                    accepted.length
                      ? accepted.map(gameId => h('span', {
                        key: gameId,
                        className: `hall-chip${myAccepted.has(gameId) ? ' shared' : ''}`,
                      }, titleOf(gameId)))
                      : h('span', { className: 'muted small' }, 'Not taking requests')),
                  !isMe ? h(Button, {
                    disabled: !canAsk || Boolean(busyId),
                    title: askTitle,
                    'aria-expanded': askOpen ? 'true' : 'false',
                    onClick: () => setAskingId(askOpen ? '' : row.id),
                  }, 'Ask') : null),
                askOpen ? h('div', { className: 'hall-picker', role: 'group', 'aria-label': `Ask ${row.name} to play` },
                  h('span', { className: 'small muted' }, `Ask ${row.name} to play:`),
                  h('div', { className: 'hall-picker-games' },
                    shared.map(gameId => h(Button, {
                      key: gameId,
                      kind: 'primary',
                      disabled: Boolean(busyId),
                      onClick: () => onAskGame(row.id, gameId),
                    }, titleOf(gameId))),
                    h(Button, {
                      kind: 'ghost',
                      disabled: Boolean(busyId),
                      onClick: () => setAskingId(''),
                    }, 'Cancel'))) : null)
            })))),
    h(LobbyChat, { token, me }))
}

// Room ------------------------------------------------------------------------

const HOW_TO_MOVE = {
  connect4: 'click a column',
  reversi: 'click a blue dot',
  checkers: 'click a piece, then where it goes',
  chess: 'click a piece, then where it goes',
  gomoku: 'click an empty point',
  go: 'click an empty point',
  hex: 'click an empty cell',
  kalah: 'click one of your pits (bottom row)',
}

function useRoom(roomId, token, invite) {
  const [state, setState] = useState({ phase: 'connecting', picture: null, room: null, people: [], chat: [], matches: [], invites: {}, me: null, closed: '', error: '', inviteError: '' })
  const ws = useRef(null)
  const waiters = useRef(new Map())
  const ref = useRef(0)
  const inviteRef = useRef(invite)
  useEffect(() => {
    let alive = true
    let retry = 0
    let timer
    const open = () => {
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${encodeURIComponent(roomId)}`)
      ws.current = socket
      socket.onopen = () => {
        retry = 0
        const hello = { t: 'auth', token }
        // Keep the code for reconnects: the server ignores it once this player is seated.
        if (inviteRef.current) hello.invite = inviteRef.current
        socket.send(JSON.stringify(hello))
      }
      socket.onmessage = event => {
        let message
        try { message = JSON.parse(event.data) } catch { return }
        if (!alive) return
        if (message.t === 'hello') setState(old => ({ ...old, phase: 'live', me: message.me, room: message.room, chat: message.chat, error: '' }))
        else if (message.t === 'state') setState(old => ({ ...old, picture: message.picture, room: message.room, matches: message.matches }))
        else if (message.t === 'presence') setState(old => ({ ...old, people: message.people }))
        else if (message.t === 'chat') setState(old => ({ ...old, chat: [...old.chat, message.message].slice(-200) }))
        else if (message.t === 'invites') setState(old => ({ ...old, invites: message.invites }))
        else if (message.t === 'closed') { setState(old => ({ ...old, phase: 'closed', closed: message.text })); alive = false }
        else if (message.t === 'error') { setState(old => ({ ...old, phase: message.code === 'auth' ? 'auth' : old.phase, error: message.text })); if (message.code === 'auth') alive = false }
        else if (message.t === 'result') {
          if (message.ref === 'invite' && !message.ok) setState(old => ({ ...old, inviteError: message.text }))
          const waiter = waiters.current.get(message.ref)
          if (waiter) { waiters.current.delete(message.ref); waiter(message) }
        }
      }
      socket.onclose = () => {
        for (const waiter of waiters.current.values()) waiter({ ok: false, text: 'Connection lost. Reconnecting…' })
        waiters.current.clear()
        if (!alive) return
        setState(old => ({ ...old, phase: 'reconnecting' }))
        retry = Math.min(retry + 1, 6)
        timer = setTimeout(open, 500 * 2 ** retry)
      }
    }
    open()
    return () => { alive = false; clearTimeout(timer); if (ws.current) ws.current.close() }
  }, [roomId, token])
  const send = useCallback(message => new Promise(resolve => {
    const socket = ws.current
    if (!socket || socket.readyState !== WebSocket.OPEN) { resolve({ ok: false, text: 'Not connected yet. Try again in a moment.' }); return }
    ref.current += 1
    const id = ref.current
    // A connection can look open and still be dead (server restart, laptop sleep).
    // No answer in time: give up on this request and reconnect.
    const timer = setTimeout(() => {
      if (!waiters.current.has(id)) return
      waiters.current.delete(id)
      resolve({ ok: false, text: 'No answer from the table. Reconnecting…' })
      if (ws.current === socket) socket.close()
    }, ANSWER_MS)
    waiters.current.set(id, answer => { clearTimeout(timer); resolve(answer) })
    socket.send(JSON.stringify({ ...message, ref: id }))
  }), [])
  return [state, send]
}

function readInvite() {
  const match = /(?:^|[#&])invite=([A-Za-z0-9_-]{8,64})/.exec(location.hash)
  if (match) history.replaceState(null, '', location.pathname)
  return match ? match[1] : ''
}

function Room({ roomId, token, me, queue, setQueue, status }) {
  const [invite] = useState(readInvite)
  const [state, send] = useRoom(roomId, token, invite)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  const [confirm, setConfirm] = useState(null)
  const [autoplay, setAutoplay] = useState(false)
  const [pick, setPick] = useState('')
  const [resultHidden, setResultHidden] = useState(false)
  const boardHeight = useBoardHeight()
  const pending = useRef(false)

  const act = useCallback(async message => {
    if (pending.current) return false
    pending.current = true
    setBusy(true)
    setFailure('')
    try {
      const answer = await send(message)
      if (!answer.ok) { setFailure(answer.text || 'The table refused that.'); return false }
      setNotice(lastLine(answer.text))
      return true
    } finally {
      pending.current = false
      setBusy(false)
    }
  }, [send])
  const cmd = (action, args = []) => act({ t: 'cmd', action, args })

  const picture = state.picture
  const room = state.room
  const perms = (picture && picture.permissions) || {}
  const seats = (picture && picture.seats) || []
  const myId = me.id
  const isHost = Boolean(room && room.host_id === myId)
  const mine = seats.filter(seat => seat.kind === 'human' && seat.id === myId)
  const active = picture && picture.status === 'active'
  const over = picture && ['win', 'draw', 'resigned'].includes(picture.status)
  const bothBots = seats.length === 2 && seats.every(seat => seat.kind === 'local')
  const drawOffer = picture && picture.draw_offer
  const offeredByMe = mine.some(seat => seat.side === drawOffer)
  const rematchBy = (picture && picture.rematch && picture.rematch.requested_by) || []
  const askedRematch = rematchBy.includes(myId)

  useEffect(() => { setPick('') }, [picture && picture.plies, picture && picture.status])
  useEffect(() => { setResultHidden(false) }, [picture && picture.status])
  useEffect(() => { if (!active || !bothBots || !perms.can_step) setAutoplay(false) }, [active, bothBots, perms.can_step])
  useEffect(() => {
    if (!autoplay) return
    let stopped = false
    let timer
    const tick = async () => {
      if (stopped) return
      const ok = await act({ t: 'cmd', action: 'step' })
      if (!stopped && ok) timer = setTimeout(tick, AUTOPLAY_MS)
      else if (!ok) setAutoplay(false)
    }
    timer = setTimeout(tick, AUTOPLAY_MS)
    return () => { stopped = true; clearTimeout(timer) }
  }, [autoplay, act])

  if (state.phase === 'closed') return h(Shell, null, h('div', { className: 'card stack' }, h('h2', null, 'Table closed'), h('p', { className: 'muted' }, state.closed), h('div', null, h(Button, { onClick: () => go('/') }, 'Back to Game Center'))))
  if (state.phase === 'auth') return h(Shell, null, h('div', { className: 'alert' }, 'Your sign-in was not recognised. ', h('a', { href: '/', onClick: () => storeToken('') }, 'Pick a name again'), '.'))
  if (!picture || !room) return h(Shell, null, h('p', { className: 'muted' }, state.phase === 'reconnecting' ? 'Reconnecting…' : 'Joining the table…'))

  const ask = (label, message, run) => setConfirm({ label, message, run })
  const watchLink = `${location.origin}/t/${room.id}`
  const openSeats = seats.filter(seat => seat.open)
  const opponentAway = Object.entries(picture.absent || {}).filter(([side]) => !mine.some(seat => seat.side === side))
  const lesson = picture.lesson
  const nameOf = side => {
    const seat = seats.find(item => item.side === side)
    if (!seat) return side
    if (seat.kind === 'local') return 'Computer'
    return seat.open ? 'Open seat' : seat.name
  }
  const caption = active ? (perms.can_move ? `Your turn: ${HOW_TO_MOVE[picture.view] || 'make a move'}` : `${nameOf(picture.turn)} to move`)
    : picture.status === 'lesson_done' ? 'Step done'
    : picture.winner ? `${nameOf(picture.winner)} wins` + (picture.result_reason && picture.result_reason !== 'rules' ? ` by ${picture.result_reason}` : '')
      : picture.status === 'draw' ? 'Draw' : picture.status

  return h(Shell, null,
    queue && status && status.matched ? h(MatchBanner, { queued: queue, status, onSwitch: () => { setQueue(null); api('/api/queue', { method: 'DELETE', token }).catch(() => {}); go(`/t/${status.matched.room.id}`) } }) : null,
    h('div', { className: 'room' },
      h('main', { className: 'stack' },
        state.inviteError ? h('div', { className: 'alert', role: 'alert' }, state.inviteError) : null,
        h('div', { className: 'room-head' },
          h('div', { className: 'stack', style: { gap: 4 } },
            h('h3', null, active ? 'In play' : over ? 'Finished' : 'At the table'),
            h('h1', null, picture.title)),
          h('div', { className: 'meta' },
            state.phase !== 'live' ? h('span', { className: 'badge' }, 'Reconnecting…') : null,
            h('span', { className: 'badge' }, room.public ? 'Public table' : 'Private table'),
            h('span', { className: 'badge' }, `White ${picture.score.white} · Black ${picture.score.black} · Draws ${picture.score.draws}`))),
        h('div', { className: 'seats' }, seats.map(seat => h('section', { key: seat.side, className: `seat${active && picture.turn === seat.side ? ' turn' : ''}`, 'aria-label': `${seat.side} seat` },
          h('h2', { className: 'seat-side' }, seat.side),
          h('div', { className: 'name' }, seat.open ? 'Open seat' : seat.kind === 'local' ? 'Built-in player' : seat.name + (seat.id === myId ? ' (you)' : ''),
            h('span', { className: 'badge' }, seat.open ? 'Open' : seat.kind === 'local' ? 'Computer' : seat.bot ? 'Bot' : 'Human')),
          h('div', { className: 'muted small' }, seat.kind === 'local' ? 'Unrated' : seat.bot ? 'Registered bot · unrated' : seat.open ? (room.public ? 'Anyone can sit' : 'Invite only') : (picture.absent || {})[seat.side] !== undefined ? `Away ${picture.absent[seat.side]}s` : ''),
          seat.open && perms.can_join && (room.public || isHost) ? h(Button, { kind: 'primary', disabled: busy, onClick: () => cmd('sit', [seat.side]), style: { marginTop: 6 } }, 'Sit here') : null))),
        opponentAway.length && active ? h('div', { className: 'note', role: 'status' },
          perms.can_claim ? 'Your opponent has been gone over two minutes. You can wait, or claim the win.' : `Your opponent lost connection ${opponentAway[0][1]}s ago. If they are gone two minutes you can claim the win.`,
          perms.can_claim ? h('div', { style: { marginTop: 8 } }, h(Button, { kind: 'primary', disabled: busy, onClick: () => act({ t: 'claim' }) }, 'Claim the win')) : null) : null,
        lesson ? h('section', { className: 'note lesson stack', 'aria-label': 'Lesson' },
          h('b', null, `Lesson · step ${lesson.step} of ${lesson.of}`),
          h('div', null, lesson.say),
          lesson.note ? h('div', { className: 'muted', role: 'status' }, lesson.note) : null,
          isHost ? h('div', { className: 'row' },
            picture.status === 'lesson_done' && lesson.step < lesson.of ? h(Button, { kind: 'primary', disabled: busy, onClick: () => cmd('lesson', ['next']) }, 'Next step') : null,
            picture.status === 'lesson_done' && lesson.step >= lesson.of ? h(Button, { kind: 'primary', disabled: busy, onClick: () => cmd('new', ['bot']) }, 'Play the computer') : null,
            h(Button, { disabled: busy, onClick: () => cmd('lesson', [String(lesson.step)]) }, 'Start this step again')) : null) : null,
        h('div', { className: 'board' }, h(BoardSvg, {
          picture, height: boardHeight,
          interactive: Boolean(perms.can_move && !busy && !confirm),
          onMove: token => { if (perms.can_move && !confirm) cmd('move', [String(token)]) }
        }),
        over && !resultHidden ? h('div', { className: 'result', role: 'status' },
          h('h3', null, picture.status === 'draw' ? 'Drawn' : 'Result'),
          h('h2', null, caption),
          h('p', { className: 'why' }, picture.status === 'draw' ? 'Nobody wins this one.' : picture.result_reason && picture.result_reason !== 'rules' ? 'Won by ' + String(picture.result_reason).replace(/_/g, ' ') + '.' : 'Settled by the rules of the game.'),
          h('div', { className: 'row', style: { justifyContent: 'center' } },
            (mine.length || isHost) ? h(Button, { kind: 'primary', disabled: busy || !perms.can_rematch || askedRematch, onClick: () => cmd('rematch') }, askedRematch ? 'Rematch requested' : rematchBy.length ? 'Accept rematch' : 'Rematch') : null,
            h(Button, { onClick: () => setResultHidden(true) }, 'Look at the board'))) : null),
        (over && !resultHidden) ? null : h('div', { role: 'status', 'aria-live': 'polite', className: 'row', style: { justifyContent: 'space-between' } },
          h('b', null, caption),
          h('span', { className: 'muted small' }, busy ? 'Sending…' : notice)),
        failure ? h('div', { className: 'alert', role: 'alert' }, failure) : null,
        active && notice.startsWith('Hint:') ? h('div', { className: 'note', role: 'status' }, '💡 ', notice) : null,
        perms.can_move ? h('div', { className: 'stack', style: { gap: 8 } },
          h('div', { className: 'row', style: { justifyContent: 'space-between' } },
            h('h3', null, 'Moves from here'),
            h('span', { className: 'muted' }, pick ? 'Playing ' + pick : 'Click a move, or a piece on the board')),
          h('div', { className: 'legal', role: 'group', 'aria-label': 'Legal moves' },
            (picture.legal || []).length
              ? (picture.legal || []).map(token => h('button', {
                key: token, type: 'button', 'aria-pressed': pick === token ? 'true' : undefined,
                onClick: () => setPick(token)
              }, token))
              : h('span', { className: 'muted' }, 'No written moves left — use the board.')),
          h('div', { className: 'row' },
            h(Button, { kind: 'primary', disabled: !pick || busy, onClick: () => cmd('move', [pick]) }, 'Play move'),
            perms.can_hint ? h(Button, { disabled: busy, onClick: () => cmd('hint'), title: 'The computer suggests a move. Only in games against the computer.' }, 'Hint') : null)) : null,
        confirm ? h('div', { className: 'dialog stack', role: 'alertdialog', 'aria-label': `Confirm ${confirm.label}`, onKeyDown: event => { if (event.key === 'Escape') setConfirm(null) } },
          h('div', null, confirm.message),
          h('div', { className: 'row' },
            h(Button, { autoFocus: true, onClick: () => setConfirm(null) }, 'Cancel'),
            h(Button, { kind: 'primary', onClick: () => { const run = confirm.run; setConfirm(null); run() } }, `Confirm ${confirm.label}`))) : null,
        h('div', { className: 'row' },
          perms.can_join && room.public && !mine.length ? h(Button, { kind: 'primary', disabled: busy, onClick: () => cmd('join') }, 'Join the game') : null,
          active && mine.length ? h(Button, { disabled: busy || !perms.can_resign, onClick: () => ask('resign', 'Resigning ends the match and gives your opponent the win.', () => cmd('resign')) }, 'Resign') : null,
          active && mine.length ? h(Button, { disabled: busy || !perms.can_draw || offeredByMe, onClick: () => ask(drawOffer && !offeredByMe ? 'draw' : 'offer', drawOffer && !offeredByMe ? 'Accepting ends the match as a draw.' : 'Offer a draw. Play goes on until your opponent accepts.', () => cmd('draw', drawOffer && !offeredByMe ? ['accept'] : [])) }, drawOffer && !offeredByMe ? 'Accept draw' : offeredByMe ? 'Draw offered' : 'Offer draw') : null,
          over && (mine.length || isHost) ? h(Button, { kind: 'primary', disabled: busy || !perms.can_rematch || askedRematch, onClick: () => cmd('rematch') }, askedRematch ? 'Rematch requested' : rematchBy.length ? 'Accept rematch' : 'Rematch') : null,
          mine.length ? h(Button, { disabled: busy, onClick: () => ask('leave', active && picture.plies ? 'Leaving during a match counts as resigning.' : 'Your seat opens for someone else.', () => cmd('leave')) }, 'Leave seat') : null,
          bothBots && active && perms.can_step ? h(Button, { kind: 'primary', onClick: () => setAutoplay(!autoplay) }, autoplay ? 'Stop' : 'Play bots') : null,
          bothBots && active && perms.can_step && !autoplay ? h(Button, { disabled: busy, onClick: () => cmd('step') }, 'Next move') : null),
        h('section', { className: 'card stack', 'aria-label': 'Move history' },
          h('h3', null, `Moves · ${picture.plies}`),
          picture.moves.length ? h('ol', { className: 'moves' }, picture.moves.map((move, index) => h('li', { key: index }, move))) : h('span', { className: 'muted small' }, 'No moves yet.')),
        state.matches.length ? h('section', { className: 'card stack', 'aria-label': 'Finished matches' },
          h('h3', null, 'Finished here'),
          state.matches.map(match => h('div', { key: match.match_no, className: 'small' },
            `#${match.match_no} ${match.white_kind === 'local' ? 'Computer' : match.white_name} vs ${match.black_kind === 'local' ? 'Computer' : match.black_name} — ${match.winner ? (match.winner === 'white' ? 'White' : 'Black') + ' won' : 'draw'} (${match.reason}${match.rated ? ', rated' : ''})`))) : null),
      h('aside', { className: 'stack' },
        h('section', { className: 'card stack', 'aria-label': 'Share' },
          h('h3', null, 'Share'),
          h(LinkBox, { label: 'Watch link: anyone with it can watch', value: watchLink }),
          isHost ? openSeats.map(seat => state.invites[seat.side]
            ? h(LinkBox, { key: seat.side, label: `Invite for the ${seat.side} seat: works once`, value: `${watchLink}#invite=${state.invites[seat.side]}` })
            : h(Button, { key: seat.side, onClick: () => act({ t: 'invite', side: seat.side }) }, `Make invite for ${seat.side}`)) : null,
          isHost ? h(HostTools, { active, picture, busy, ask, act, cmd }) : null),
        h(People, { people: state.people, myId, isHost, act }),
        h(Chat, { chat: state.chat, send, myId, token, roomId: room.id, muted: state.people.some(person => person.id === myId && person.muted) }))))
}

function HostTools({ active, picture, busy, ask, act, cmd }) {
  // The referee refuses to replace a match in progress; say so instead of offering it.
  const locked = Boolean(active && picture.plies)
  const title = locked ? 'Finish or resign the current match first.' : undefined
  return h('div', { className: 'stack', style: { gap: 6 } },
    h('h3', null, 'Host'),
    h('div', { className: 'row' },
      h(Button, { disabled: busy || locked, title, onClick: () => cmd('new', ['two']) }, 'New: two people'),
      h(Button, { disabled: busy || locked, title, onClick: () => cmd('new', ['bot']) }, 'New: vs bot'),
      h(Button, { disabled: busy || locked, title, onClick: () => cmd('new', ['bots']) }, 'New: bots')),
    h('div', null, h(Button, { kind: 'danger', disabled: busy, onClick: () => ask('close', active && picture.plies ? 'Closing during your match counts as resigning. Everyone here is sent back to the lobby.' : 'Everyone here is sent back to the lobby.', () => act({ t: 'close' })) }, 'Close table')))
}

function People({ people, myId, isHost, act }) {
  return h('section', { className: 'card stack', 'aria-label': 'People here' },
    h('h3', null, `Here now · ${people.length}`),
    h('div', { className: 'people' }, people.map(person => h('div', { key: person.id, className: 'person' },
      h('span', null, person.name, person.id === myId ? ' (you)' : '', person.bot ? h('span', { className: 'badge bot' }, 'bot') : null, h('span', { className: 'muted small' }, ` · ${person.host ? 'host' : person.role}${person.muted ? ' · muted' : ''}`)),
      isHost && person.id !== myId ? h('span', { className: 'row', style: { gap: 4 } },
        h(Button, { onClick: () => act({ t: person.muted ? 'unmute' : 'mute', player_id: person.id }) }, person.muted ? 'Unmute' : 'Mute'),
        h(Button, { kind: 'danger', onClick: () => act({ t: 'remove', player_id: person.id }) }, 'Remove')) : null))))
}

function Chat({ chat, send, myId, token, roomId, muted }) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [reporting, setReporting] = useState(null)
  const [thanks, setThanks] = useState('')
  const log = useRef(null)
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight }, [chat.length])
  const submit = async event => {
    event.preventDefault()
    if (!text.trim()) return
    const answer = await send({ t: 'chat', text })
    if (answer.ok) { setText(''); setError('') } else setError(answer.text)
  }
  return h('section', { className: 'card chat', 'aria-label': 'Table chat' },
    h('h3', null, 'Chat'),
    h('div', { className: 'log', ref: log, role: 'log', 'aria-live': 'polite' },
      chat.length ? chat.map(message => h(MessageLine, {
        key: message.id, message, showRole: true,
        onReport: message.player_id !== myId && !message.removed ? setReporting : null
      })) : h('span', { className: 'muted small' }, 'Say hi. Players and watchers share this chat.')),
    reporting ? h(ReportSheet, { message: reporting, token, roomId, onClose: () => setReporting(null), onDone: () => { setReporting(null); setThanks('Reported. A moderator will look at it.') } }) : null,
    thanks ? h('div', { className: 'muted small', role: 'status' }, thanks) : null,
    muted ? h('div', { className: 'muted small' }, 'The host muted you. You can still watch.') : h('form', { className: 'row', onSubmit: submit },
      h('input', { className: 'input', value: text, maxLength: 300, placeholder: 'Message', 'aria-label': 'Chat message', onChange: event => setText(event.target.value) }),
      h(Button, { type: 'submit', disabled: !text.trim() }, 'Send')),
    error ? h('div', { className: 'alert', role: 'alert' }, error) : null)
}

function Shell({ children }) {
  return h('div', { className: 'shell' },
    h('header', { className: 'top' },
      h('a', { className: 'brand', href: '/', onClick: event => { event.preventDefault(); go('/') } }, 'Game ', h('span', null, 'Center'))),
    children)
}

function lastLine(text) {
  const lines = String(text || '').split('\n').filter(Boolean)
  const played = lines.filter(line => /^(Played|Local played)/.test(line))
  return played.length ? played.join(' ') : lines.length <= 2 ? lines.join(' ') : ''
}

// Bot career ------------------------------------------------------------------

function BotCareer({ botId }) {
  const [career, setCareer] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    api(`/api/bots/${encodeURIComponent(botId)}`).then(data => setCareer(data.career), failure => setError(failure.message))
  }, [botId])
  if (error) return h(Shell, null, h('div', { className: 'alert', role: 'alert' }, error), h(Button, { onClick: () => go('/') }, 'Back'))
  if (!career) return h(Shell, null, h('p', { className: 'muted' }, 'Loading the bot record…'))
  const bot = career.bot
  return h(Shell, null,
    h('section', { className: 'stack' },
      h('div', { className: 'row', style: { justifyContent: 'space-between' } },
        h('h1', { style: { fontSize: 22 } }, bot.name, h('span', { className: 'badge bot' }, 'BOT')),
        h(Button, { onClick: () => go('/') }, 'Back to the lobby')),
      h('p', { className: 'muted', style: { margin: 0 } }, bot.provisional
        ? 'Provisional ladder record: fewer than ten rated bot games at some game.'
        : 'Rated bot-versus-bot record, kept separate from people. Same pair: three rated games a day.'),
      h('div', { className: 'card stack' },
        h('h2', null, 'Per game'),
        !career.games.length ? h('p', { className: 'muted', style: { margin: 0 } }, 'No rated bot games yet.') :
          h('table', { className: 'lb' },
            h('thead', null, h('tr', null, h('th', null, 'Game'), h('th', { className: 'num' }, 'Rating'), h('th', { className: 'num' }, 'W'), h('th', { className: 'num' }, 'L'), h('th', { className: 'num' }, 'D'))),
            h('tbody', null, career.games.map(row => h('tr', { key: row.game },
              h('td', null, row.game), h('td', { className: 'num' }, row.provisional ? `~${row.rating}` : row.rating),
              h('td', { className: 'num' }, row.wins), h('td', { className: 'num' }, row.losses), h('td', { className: 'num' }, row.draws)))))),
      h('div', { className: 'card stack' },
        h('h2', null, 'Rating history'),
        !career.history.length ? h('p', { className: 'muted', style: { margin: 0 } }, 'Nothing yet.') :
          h('div', { className: 'moves' }, career.history.map((row, index) => h('span', { key: index }, `${row.game} ${row.rating}`)))),
      h('div', { className: 'card stack' },
        h('h2', null, 'Recent opponents'),
        !career.opponents.length ? h('p', { className: 'muted', style: { margin: 0 } }, 'Nobody yet.') :
          career.opponents.map((row, index) => h('div', { key: index, className: 'person' },
            h('span', null, row.name, ' · ', row.game),
            h('span', { className: 'muted small' }, `${row.result}${row.rated ? ' · rated' : ' · practice'}`))))))
}

// Staff and moderation ---------------------------------------------------------
// A staff key is a second credential kept in this browser only. The server
// re-checks it against the signed-in account on every call, so hiding a button
// here is a courtesy, never the control.

const STAFF_STORE = 'gc.staff'
function storedStaff() {
  try { return localStorage.getItem(STAFF_STORE) || '' } catch { return '' }
}
function storeStaff(key) {
  try { key ? localStorage.setItem(STAFF_STORE, key) : localStorage.removeItem(STAFF_STORE) } catch {}
}

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', moderator: 'Moderator' }

function useStaff(token) {
  const [staff, setStaff] = useState({ role: '', name: '', powers: [] })
  const [checked, setChecked] = useState(false)
  useEffect(() => {
    const key = storedStaff()
    if (!token || !key) { setStaff({ role: '', name: '', powers: [] }); setChecked(true); return }
    let alive = true
    api('/api/admin/me', { token, staff: key }).then(data => {
      if (alive) { setStaff({ role: data.role || '', name: data.name || '', powers: data.powers || [] }); setChecked(true) }
    }, failure => {
      if (!alive) return
      setStaff({ role: '', name: '', powers: [] })
      setChecked(true)
      if (failure.status === 401) storeStaff('')
    })
    return () => { alive = false }
  }, [token])
  return [staff, setStaff, checked]
}

function RoleBadge({ role }) {
  if (!role) return null
  return h('span', { className: `badge staff ${role}` }, ROLE_LABEL[role] || role)
}

function when(seconds) {
  if (!seconds) return ''
  const date = new Date(seconds * 1000)
  const today = new Date()
  const same = date.toDateString() === today.toDateString()
  return same ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString()
}

function untilText(until) {
  if (!until) return 'permanently'
  return 'until ' + new Date(until * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Reports: a player flags a message, a name or a bot. No staff key needed.
const REPORT_REASONS = ['Spam', 'Abuse or threats', 'Impersonation', 'Something else']

function ReportSheet({ message, token, roomId, onClose, onDone }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const send = async reason => {
    setBusy(true); setError('')
    try {
      await api('/api/reports', { method: 'POST', token, body: {
        kind: 'message', target_id: message.player_id, target_name: message.name,
        message_id: message.id, room_id: roomId || '', reason
      } })
      onDone && onDone()
    } catch (failure) { setError(failure.message) }
    setBusy(false)
  }
  return h('div', { className: 'sheet stack', role: 'group', 'aria-label': 'Report a message' },
    h('b', null, `Report ${message.name}`),
    h('div', { className: 'muted small' }, 'A moderator sees the message and decides. You are not shown to them as the reporter in chat.'),
    h('div', { className: 'row' }, REPORT_REASONS.map(reason => h(Button, { key: reason, disabled: busy, onClick: () => send(reason) }, reason))),
    error ? h('div', { className: 'alert', role: 'alert' }, error) : null,
    h('button', { type: 'button', className: 'linkish small', onClick: onClose }, 'Cancel'))
}

function MessageLine({ message, onReport, showRole, showStamp }) {
  if (message.removed) {
    return h('div', { className: 'msg removed' },
      h('b', null, message.name), ': ', h('i', null, message.text || 'removed by a moderator'))
  }
  return h('div', { className: 'msg' },
    h('b', null, message.name),
    message.bot ? h('span', { className: 'badge bot' }, 'BOT') : null,
    message.staff ? h('span', { className: `badge staff ${message.staff}` }, ROLE_LABEL[message.staff] || message.staff) : null,
    showRole ? h('span', { className: 'role' }, message.role === 'player' ? 'player' : message.role === 'host' ? 'host' : 'watching') : null,
    ': ', message.text,
    showStamp ? h('span', { className: 'at', title: 'When this was posted' }, postStamp(message.at)) : null,
    onReport ? h('button', { type: 'button', className: 'linkish small flag', onClick: () => onReport(message), title: 'Report this message to a moderator', 'aria-label': `Report a message by ${message.name}` }, '⚑') : null)
}

// Admin ------------------------------------------------------------------------

function canDo(role, what) {
  const rank = { owner: 3, admin: 2, moderator: 1 }[role] || 0
  if (what === 'permanent' || what === 'rename' || what === 'bots' || what === 'table' || what === 'team') return rank >= 2
  if (what === 'appoint-admin') return rank >= 3
  return rank >= 1
}

function AdminPanel({ token, staff, me }) {
  const [where, setWhere] = useState('reports')
  const [reason, setReason] = useState('')
  const [flash, setFlash] = useState('')
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(0)
  const [issued, setIssued] = useState(null)
  const run = useCallback(async payload => {
    setBusy(true); setFlash('')
    try {
      const answer = await api('/api/admin/action', { method: 'POST', token, staff: storedStaff(), body: { ...payload, reason } })
      setFlash(answer.text || (answer.ok ? 'Done.' : 'That was refused.'))
      if (answer.ok && answer.staff_key) setIssued({ name: answer.staff_name || payload.name || '', role: answer.staff_role || payload.role || '', key: answer.staff_key })
      if (answer.ok) { setVersion(value => value + 1); setReason('') }
      return answer
    } catch (failure) {
      setFlash(failure.message)
      return null
    } finally { setBusy(false) }
  }, [reason, token])
  const places = [['reports', 'Reports'], ['lookup', 'Look up'], ['audit', 'Audit log'], ['team', 'Team']]
  return h('section', { className: 'stack admin', 'aria-label': 'Admin and moderation' },
    h('div', { className: 'row', style: { justifyContent: 'space-between' } },
      h('div', { className: 'row' }, h('h1', { style: { fontSize: 22 } }, 'Admin'), h(RoleBadge, { role: staff.role })),
      h('span', { className: 'badge' }, 'Labs · experiment')),
    h('div', { className: 'row' },
      h('label', { className: 'row small muted', style: { flex: 1 } },
        'Reason (kept in the audit log)',
        h('input', { className: 'input', value: reason, maxLength: 200, placeholder: 'e.g. spam in lobby chat', 'aria-label': 'Reason for this action', onChange: event => setReason(event.target.value) }))),
    h('nav', { className: 'tabs', 'aria-label': 'Admin sections' },
      places.map(([id, label]) => h('button', { key: id, className: 'tab', 'aria-current': where === id ? 'page' : undefined, onClick: () => setWhere(id) }, label))),
    flash ? h('div', { className: 'note', role: 'status' }, flash) : null,
    issued ? h('div', { className: 'card stack', role: 'status' },
      h('b', null, `${issued.name} is ${ROLE_LABEL[issued.role] || issued.role}. Give them this staff key out of band:`),
      h(LinkBox, { label: 'Staff key (shown once)', value: issued.key }),
      h('p', { className: 'muted small', style: { margin: 0 } }, 'They sign in as their own name, then paste it on the You tab. The key is not kept anywhere you can read it back.'),
      h('button', { type: 'button', className: 'linkish small', onClick: () => setIssued(null) }, 'I have copied it')) : null,
    where === 'reports' ? h(ReportsPanel, { token, version, run, busy }) : null,
    where === 'lookup' ? h(LookupPanel, { token, version, run, busy, role: staff.role, me }) : null,
    where === 'audit' ? h(AuditPanel, { token, version, run, busy, role: staff.role }) : null,
    where === 'team' ? h(TeamPanel, { token, version, run, busy, role: staff.role }) : null)
}

function ReportsPanel({ token, version, run, busy }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [state, setState] = useState('open')
  useEffect(() => {
    let alive = true
    api(`/api/admin/reports?state=${state}`, { token, staff: storedStaff() }).then(data => {
      if (alive) { setRows(data.reports || []); setError('') }
    }, failure => { if (alive) setError(failure.message) })
    return () => { alive = false }
  }, [token, version, state])
  if (error) return h('div', { className: 'alert', role: 'alert' }, error)
  if (!rows) return h('p', { className: 'muted' }, 'Loading reports…')
  return h('div', { className: 'stack' },
    h('div', { className: 'row' },
      h(Button, { kind: state === 'open' ? 'primary' : undefined, onClick: () => setState('open') }, 'Open'),
      h(Button, { kind: state === 'closed' ? 'primary' : undefined, onClick: () => setState('closed') }, 'Handled'),
      h(Button, { kind: state === 'all' ? 'primary' : undefined, onClick: () => setState('all') }, 'All')),
    !rows.length ? h('p', { className: 'muted' }, state === 'open' ? 'Nothing to look at. Nice.' : 'Nothing here.') :
      rows.map(row => h('article', { key: row.id, className: 'card stack report' },
        h('div', { className: 'row', style: { justifyContent: 'space-between' } },
          h('b', null, `${row.kind === 'message' ? 'Message' : row.kind === 'bot' ? 'Bot' : 'Name'} · ${row.target_name || 'unknown'}`),
          h('span', { className: 'muted small' }, `${row.state} · ${when(row.at)}`)),
        row.text ? h('q', { className: 'quote' }, row.text) : null,
        h('div', { className: 'muted small' }, `Reported by ${row.reporter_name}${row.reason ? ' · ' + row.reason : ''}${row.room_id ? ' · ' + (row.room_id === '__lobby__' ? 'the lobby' : 'table ' + row.room_id) : ''}`),
        h('div', { className: 'row' },
          row.kind === 'message' && row.state === 'open' ? h(Button, { kind: 'danger', disabled: busy, onClick: () => run({ action: 'delete-message', message_id: row.message_id, room_id: row.room_id, target_id: row.target_id }) }, 'Delete message') : null,
          row.state === 'open' ? h(Button, { disabled: busy, onClick: () => run({ action: 'silence', target_id: row.target_id, minutes: 60 }) }, 'Silence 1h') : null,
          row.state === 'open' ? h(Button, { disabled: busy, onClick: () => run({ action: 'suspend', target_id: row.target_id, minutes: 10080 }) }, 'Suspend 7 days') : null,
          row.state === 'open' ? h(Button, { disabled: busy, onClick: () => run({ action: 'close-report', report_id: row.id, resolution: 'Nothing wrong.' }) }, 'Nothing wrong') : null))))
}

function LookupPanel({ token, version, run, busy, role, me }) {
  const [query, setQuery] = useState('')
  const [found, setFound] = useState(null)
  const [error, setError] = useState('')
  const [newName, setNewName] = useState('')
  const search = async event => {
    event.preventDefault()
    if (!query.trim()) return
    setError('')
    try {
      const data = await api('/api/admin/user?name=' + encodeURIComponent(query.trim()), { token, staff: storedStaff() })
      setFound(data.player)
    } catch (failure) { setError(failure.message); setFound(null) }
  }
  useEffect(() => { if (found && query.trim()) search(new Event('submit')) }, [version])
  const target = found ? found.id : ''
  return h('div', { className: 'stack' },
    h('form', { className: 'row', onSubmit: search },
      h('input', { className: 'input', value: query, placeholder: 'Name, exactly as they play', 'aria-label': 'Name to look up', onChange: event => setQuery(event.target.value) }),
      h(Button, { type: 'submit', kind: 'primary', disabled: !query.trim() }, 'Look up')),
    error ? h('div', { className: 'alert', role: 'alert' }, error) : null,
    !found ? h('p', { className: 'muted' }, 'Search a person or a bot to see their record, reports and past actions.') :
      h('article', { className: 'card stack' },
        h('div', { className: 'row', style: { justifyContent: 'space-between' } },
          h('div', { className: 'row' }, h('h2', null, found.name), found.bot ? h('span', { className: 'badge bot' }, 'BOT') : null, h(RoleBadge, { role: found.staff_role })),
          h('span', { className: 'muted small' }, `joined ${when(found.joined)}`)),
        found.owner ? h('div', { className: 'muted small' }, `Owner: ${found.owner}`) : null,
        h('div', { className: 'row small' },
          h('span', { className: 'badge' }, `${found.games} games`),
          h('span', { className: 'badge' }, `${found.wins}W ${found.losses}L ${found.draws}D`),
          h('span', { className: 'badge' }, `${found.reports_against} reports (${found.open_reports} open)`),
          found.silenced_until !== 0 ? h('span', { className: 'badge warn' }, 'silenced ' + untilText(found.silenced_until)) : null,
          found.suspended_until !== 0 ? h('span', { className: 'badge warn' }, 'suspended ' + untilText(found.suspended_until)) : null),
        h('h3', null, 'Silence (they can still play)'),
        h('div', { className: 'row' },
          [['10 min', 10], ['1 hour', 60], ['24 hours', 1440]].map(([label, minutes]) => h(Button, { key: label, disabled: busy || !target, onClick: () => run({ action: 'silence', target_id: target, minutes }) }, label)),
          canDo(role, 'permanent') ? h(Button, { kind: 'danger', disabled: busy || !target, onClick: () => run({ action: 'silence', target_id: target, minutes: 0 }) }, 'Forever') : null,
          h(Button, { disabled: busy || !target, onClick: () => run({ action: 'unsilence', target_id: target }) }, 'Lift silence')),
        h('h3', null, 'Suspend or ban (blocks sign-in, queue and the ladder)'),
        h('div', { className: 'row' },
          [['1 hour', 60], ['1 day', 1440], ['7 days', 10080]].map(([label, minutes]) => h(Button, { key: label, disabled: busy || !target, onClick: () => run({ action: 'suspend', target_id: target, minutes }) }, label)),
          canDo(role, 'permanent') ? h(Button, { kind: 'danger', disabled: busy || !target, onClick: () => run({ action: 'suspend', target_id: target, minutes: 0 }) }, 'Permanent ban') : null,
          h(Button, { disabled: busy || !target, onClick: () => run({ action: 'unsuspend', target_id: target }) }, 'Lift suspension')),
        canDo(role, 'permanent') ? h('label', { className: 'row small muted' },
          h('input', { type: 'checkbox', checked: Boolean(found.address_block), onChange: event => setFound({ ...found, address_block: event.target.checked }) }),
          'Also block new sign-ups from their address (hashed) on a permanent ban') : null,
        canDo(role, 'rename') ? h('form', { className: 'row', onSubmit: event => { event.preventDefault(); if (newName.trim()) run({ action: 'force-rename', target_id: target, name: newName.trim() }) } },
          h('input', { className: 'input', value: newName, maxLength: 20, placeholder: 'New name', 'aria-label': 'New name', onChange: event => setNewName(event.target.value) }),
          h(Button, { type: 'submit', disabled: busy || !newName.trim() }, 'Force rename')) : null,
        canDo(role, 'bots') && found.bot ? h('div', { className: 'row' },
          h(Button, { kind: 'danger', disabled: busy, onClick: () => run({ action: 'bot-remove', target_id: target }) }, 'Remove bot from the ladder'),
          h(Button, { disabled: busy, onClick: () => run({ action: 'bot-reset', target_id: target }) }, 'Reset its record')) : null,
        canDo(role, 'team') ? h('div', { className: 'row' },
          h(Button, { disabled: busy, onClick: () => run({ action: 'appoint', target_id: target, role: 'moderator' }) }, 'Make moderator'),
          canDo(role, 'appoint-admin') ? h(Button, { disabled: busy, onClick: () => run({ action: 'appoint', target_id: target, role: 'admin' }) }, 'Make admin') : null,
          found.staff_role && found.staff_role !== 'owner' ? h(Button, { kind: 'danger', disabled: busy, onClick: () => run({ action: 'revoke', target_id: target }) }, 'Remove role') : null) : null,
        found.actions && found.actions.length ? h('div', { className: 'stack' },
          h('h3', null, 'Past actions'),
          found.actions.slice(0, 8).map(row => h('div', { key: row.id, className: 'small muted' },
            `${when(row.at)} · ${row.actor_name} (${row.actor_role}) · ${row.action}${row.reason ? ' · ' + row.reason : ''}${row.undone ? ' · undone' : ''}`))) : null))
}

function AuditPanel({ token, version, run, busy, role }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    api('/api/admin/audit?limit=100', { token, staff: storedStaff() }).then(data => {
      if (alive) { setRows(data.entries || []); setError('') }
    }, failure => { if (alive) setError(failure.message) })
    return () => { alive = false }
  }, [token, version])
  if (error) return h('div', { className: 'alert', role: 'alert' }, error)
  if (!rows) return h('p', { className: 'muted' }, 'Loading the audit log…')
  if (!rows.length) return h('p', { className: 'muted' }, 'No staff actions yet.')
  return h('table', { className: 'lb audit' },
    h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Who'), h('th', null, 'Action'), h('th', null, 'Target'), h('th', null, 'Reason'), h('th', null, ''))),
    h('tbody', null, rows.map(row => h('tr', { key: row.id, className: row.undone ? 'undone' : undefined },
      h('td', null, when(row.at)),
      h('td', null, `${row.actor_name} (${row.actor_role})`),
      h('td', null, row.action, row.undo_of ? h('span', { className: 'muted small' }, ' · undo') : null),
      h('td', null, row.target_name || '—'),
      h('td', { className: 'muted' }, row.reason || '—'),
      h('td', { className: 'num' }, !row.undone && !row.undo_of && canDo(role, 'permanent') ? h('button', { type: 'button', className: 'linkish small', disabled: busy, onClick: () => run({ action: 'undo', audit_id: row.id }) }, 'Undo') : null)))))
}

function TeamPanel({ token, version, run, busy, role }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  useEffect(() => {
    let alive = true
    api('/api/admin/overview', { token, staff: storedStaff() }).then(body => {
      if (alive) { setData(body); setError('') }
    }, failure => { if (alive) setError(failure.message) })
    return () => { alive = false }
  }, [token, version])
  if (error) return h('div', { className: 'alert', role: 'alert' }, error)
  if (!data) return h('p', { className: 'muted' }, 'Loading the team…')
  const appoint = async wanted => {
    if (!name.trim()) return
    await run({ action: 'appoint', target: name.trim(), role: wanted })
    setName('')
  }
  return h('div', { className: 'stack' },
    h('div', { className: 'row' },
      h('span', { className: 'badge' }, `${data.players} people`),
      h('span', { className: 'badge' }, `${data.reports_open} open reports`),
      h('span', { className: 'badge' }, `${data.suspended} suspended`),
      h('span', { className: 'badge' }, `${data.silenced} silenced`)),
    h('div', { className: 'card stack' },
      h('h2', null, 'Staff'),
      (data.staff || []).map(row => h('div', { key: row.name, className: 'person' },
        h('span', { className: 'row' }, h('b', null, row.name), h(RoleBadge, { role: row.role })))),
      !data.staff.length ? h('p', { className: 'muted' }, 'No staff yet. The owner is made on the server with python -m online.admin grant-owner.') : null),
    !canDo(role, 'team') ? h('p', { className: 'muted' }, 'Only an owner or an admin appoints moderators. Only the owner appoints admins.') :
      h('div', { className: 'card stack' },
        h('h2', null, 'Appoint by name'),
        h('div', { className: 'row' },
          h('input', { className: 'input', value: name, placeholder: 'Name on the lobby', 'aria-label': 'Name to appoint', onChange: event => setName(event.target.value) }),
          h(Button, { disabled: busy || !name.trim(), onClick: () => appoint('moderator') }, 'Make moderator'),
          canDo(role, 'appoint-admin') ? h(Button, { disabled: busy || !name.trim(), onClick: () => appoint('admin') }, 'Make admin') : null),
        h('p', { className: 'muted small' }, 'The person is signed in as that name. They sign in normally, then paste the staff key you give them on the You tab. The key is shown once, and never in chat.')))
}

function StaffKeyCard({ token, staff, onStaff }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const save = async event => {
    event.preventDefault()
    setBusy(true); setNote(''); setError('')
    try {
      const answer = await api('/api/admin/me', { token, staff: key.trim() })
      storeStaff(key.trim())
      onStaff({ role: answer.role || '', name: answer.name || '', powers: answer.powers || [] })
      setKey('')
      setNote(`Staff key saved. You are ${ROLE_LABEL[answer.role] || answer.role}.`)
    } catch (failure) { setError(failure.message) }
    setBusy(false)
  }
  const forget = () => { storeStaff(''); onStaff({ role: '', name: '', powers: [] }); setNote('Staff key forgotten on this browser.') }
  return h('div', { className: 'card stack' },
    h('h2', null, 'Staff key'),
    staff.role
      ? h(Fragment, null,
        h('p', { className: 'muted', style: { margin: 0 } }, 'This browser can moderate. The key stays here; the role stays with your account.'),
        h('div', { className: 'row' }, h(RoleBadge, { role: staff.role }), h(Button, { kind: 'danger', onClick: forget }, 'Forget the key here')))
      : h('p', { className: 'muted', style: { margin: 0 } }, 'Staff only. If an owner or admin gave you a staff key, paste it here. It is checked against your signed-in name.'),
    h('form', { className: 'row', onSubmit: save },
      h('input', { className: 'input', value: key, type: 'password', autoComplete: 'off', spellCheck: false, placeholder: 'Staff key', 'aria-label': 'Staff key', onChange: event => setKey(event.target.value) }),
      h(Button, { type: 'submit', disabled: busy || !key.trim() }, 'Use it')),
    note ? h('div', { className: 'muted small', role: 'status' }, note) : null,
    error ? h('div', { className: 'alert', role: 'alert' }, error) : null)
}

function BlockedCard({ token }) {
  const [data, setData] = useState(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const load = () => api('/api/blocks', { token }).then(setData, failure => setError(failure.message))
  useEffect(() => { load() }, [token])
  const add = async event => {
    event.preventDefault()
    if (!name.trim()) return
    try { await api('/api/blocks', { method: 'POST', token, body: { name: name.trim() } }); setName(''); setError(''); load() } catch (failure) { setError(failure.message) }
  }
  const remove = async row => {
    try { await api(`/api/blocks/${encodeURIComponent(row.id)}`, { method: 'DELETE', token }); load() } catch (failure) { setError(failure.message) }
  }
  const blocked = (data && data.blocked) || []
  return h('div', { className: 'card stack' },
    h('h2', null, 'Blocked people'),
    h('p', { className: 'muted', style: { margin: 0 } }, 'Their chat and invites are hidden from you. They can still play; you are not told when they are around.'),
    blocked.map(row => h('div', { key: row.id, className: 'person' },
      h('span', null, row.name), h(Button, { onClick: () => remove(row) }, 'Unblock'))),
    !blocked.length ? h('p', { className: 'muted', style: { margin: 0 } }, 'Nobody blocked.') : null,
    h('form', { className: 'row', onSubmit: add },
      h('input', { className: 'input', value: name, placeholder: 'Name to block', 'aria-label': 'Name to block', onChange: event => setEventName(event) }),
      h(Button, { type: 'submit', disabled: !name.trim() }, 'Block')),
    error ? h('div', { className: 'alert', role: 'alert' }, error) : null)
  function setEventName(event) { setName(event.target.value) }
}

// App -------------------------------------------------------------------------

function App() {
  const path = usePath()
  const [token, setToken] = useState(storedToken)
  const [me, setMe] = useState(null)
  const [error, setError] = useState('')
  const [queue, setQueue, status] = useQueueStatus(token)
  const [staff, setStaff] = useStaff(token)
  const hall = useLobby(token)
  const hallClose = hall.close
  const signOut = useCallback(() => {
    hallClose()
    storeToken('')
    setToken('')
    setMe(null)
  }, [hallClose])
  useEffect(() => {
    if (!token) return
    api('/api/me', { token }).then(data => setMe(data.player), failure => {
      if (failure.status === 401) { signOut() } else setError(failure.message)
    })
  }, [token, signOut])
  if (!token) return h(NameGate, { onReady: (made, player) => { setToken(made); setMe(player) } })
  if (error) return h('div', { className: 'shell' }, h('div', { className: 'alert' }, error))
  if (!me) return h('p', { className: 'boot' }, 'Loading Game Center…')
  const room = /^\/t\/([A-Za-z0-9]{6,32})$/.exec(path)
  if (room) return h(Room, { key: room[1], roomId: room[1], token, me, queue, setQueue, status })
  const career = /^\/b\/(.+)$/.exec(path)
  if (career) return h(BotCareer, { key: career[1], botId: decodeURIComponent(career[1]) })
  return h(Home, { token, me, setMe, queue, setQueue, status, staff, setStaff, hall, onSignOut: signOut, initialTab: path === '/admin' ? 'admin' : 'hall' })
}

createRoot(document.getElementById('root')).render(h(App))
