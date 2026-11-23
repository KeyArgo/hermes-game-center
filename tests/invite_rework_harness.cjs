// tests/invite_rework_harness.cjs -- an invite reaches the person in the side pane, and the pane
// plays with people through the Hall.
//
//   python3 tools/build_plugin.py && node tests/invite_rework_harness.cjs
//
// Every check boots the built bundle in a fresh context with a virtual clock, so the one shared poll
// can be counted read by read. Components are drawn by a small hook runtime that keeps one set of
// hooks per mounted component, so the pane and both chrome bells can be on screen at once.
//
//   paneReceivesInviteFromColdStart  mount only the pane; an invite delivered through /online/hall
//                                    shows in it, with nothing else mounted.
//   titlebarFallbackWhenStatusHidden the status-bar copy is mounted but not visible; the titlebar
//                                    copy draws the invite.
//   notifyOncePerRequest             with no invite surface visible, one silent notice per request
//                                    id while "Open to invites" is on, and none while one is visible.
//   onePollAndStopsOnDispose         registration starts one /online/hall poll; the pane and both
//                                    bells add none; disposing the plugin stops it.
//   panePeopleUsesHallEndToEnd       the pane's Play with people tab saves games, finds, stops, asks,
//                                    says the decline and the timeout, and an accepted invite opens
//                                    its table in the pane when the seat comes on a later poll. Never
//                                    /online/queue, never the local looking line.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const SOURCE = fs.readFileSync(path.join(ROOT, 'desktop/plugin.js'), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export \{.*\}$/gm, '').replace('export default {', 'const plugin = {')
  + '\n;globalThis.__plugin = plugin\n'

const flush = async () => { for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve)) }

// ---- one fresh plugin, its clock, its timers and its observers --------------------------------
function boot() {
  const clock = { now: Date.UTC(2026, 10, 20, 12, 0, 0) }
  const timers = new Map()
  let nextTimer = 1
  const addTimer = (fn, ms, every) => {
    const id = nextTimer++
    timers.set(id, { at: clock.now + Math.max(0, Number(ms) || 0), fn, every: every ? Math.max(1, Number(ms) || 1) : 0 })
    return id
  }
  const RealDate = Date
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(clock.now) }
    static now() { return clock.now }
  }
  const observers = []
  class FakeIntersectionObserver {
    constructor(callback) { this.callback = callback; this.nodes = new Set(); this.gone = false; observers.push(this) }
    observe(node) { this.nodes.add(node) }
    unobserve(node) { this.nodes.delete(node) }
    disconnect() { this.nodes.clear(); this.gone = true }
    takeRecords() { return [] }
  }
  const windowListeners = {}
  const local = {}
  const session = {}
  const storage = bag => ({
    getItem: key => (key in bag ? bag[key] : null),
    setItem: (key, value) => { bag[key] = String(value) },
    removeItem: key => { delete bag[key] }
  })
  const listen = (type, fn) => { windowListeners[type] = (windowListeners[type] || []).concat(fn) }
  const unlisten = (type, fn) => { windowListeners[type] = (windowListeners[type] || []).filter(item => item !== fn) }
  const navigated = []
  const sandbox = {
    console, Set, Map, Promise, Math, JSON, Object, Array, String, Number, Boolean, Error,
    Date: FakeDate,
    setTimeout: (fn, ms) => addTimer(fn, ms, false),
    clearTimeout: id => { timers.delete(id) },
    setInterval: (fn, ms) => addTimer(fn, ms, true),
    clearInterval: id => { timers.delete(id) },
    IntersectionObserver: FakeIntersectionObserver,
    PANES_AREA: 'panes', PALETTE_AREA: 'palette', ROUTES_AREA: 'routes',
    SIDEBAR_NAV_AREA: 'nav', STATUSBAR_AREAS: { right: 'right' }, TITLEBAR_AREAS: { right: 'titleBar.right' },
    COMPOSER_AREAS: { top: 'composer.top', bottom: 'composer.bottom', underside: 'composer.underside' },
    CustomEvent: class { constructor(type, opts) { this.type = type; Object.assign(this, opts || {}) } }
  }
  sandbox.window = {
    innerWidth: 1440, innerHeight: 900,
    addEventListener: listen, removeEventListener: unlisten,
    dispatchEvent: event => { (windowListeners[event.type] || []).forEach(fn => fn(event)); return true },
    localStorage: storage(local), sessionStorage: storage(session),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  }
  sandbox.document = {
    hidden: false,
    addEventListener: listen, removeEventListener: unlisten,
    getElementById: () => null, activeElement: null
  }
  const chatBusy = { get() { return false }, subscribe() { return () => {} } }
  sandbox.host = {
    state: { busy: chatBusy },
    onEvent: () => () => {},
    revealPane() {},
    navigate(route) { navigated.push(route) }
  }
  sandbox.Component = class { constructor(props) { this.props = props; this.state = {} } setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) } } }

  // ---- the hooks: one set per mounted component ----
  let current = null
  const hookOf = () => {
    if (!current) throw new Error('a hook was called outside a component')
    return current
  }
  sandbox.useState = initial => {
    const inst = hookOf()
    const index = inst.cursor++
    if (!(index in inst.hooks)) inst.hooks[index] = typeof initial === 'function' ? initial() : initial
    return [inst.hooks[index], value => {
      inst.hooks[index] = typeof value === 'function' ? value(inst.hooks[index]) : value
    }]
  }
  sandbox.useRef = initial => {
    const inst = hookOf()
    const index = inst.cursor++
    if (!(index in inst.hooks)) inst.hooks[index] = { current: initial }
    return inst.hooks[index]
  }
  const changed = (before, deps) => !before || !deps || deps.length !== before.length || deps.some((dep, i) => dep !== before[i])
  const effectHook = (fn, deps) => {
    const inst = hookOf()
    const index = inst.cursor++
    const before = inst.hooks[index]
    if (changed(before, deps)) {
      inst.hooks[index] = deps || null
      inst.effects.push(() => {
        if (inst.cleanups[index]) inst.cleanups[index]()
        inst.cleanups[index] = fn()
      })
    }
  }
  sandbox.useEffect = effectHook
  sandbox.useLayoutEffect = effectHook
  sandbox.useCallback = (fn, deps) => {
    const inst = hookOf()
    const index = inst.cursor++
    const before = inst.hooks[index]
    if (!before || changed(before.deps, deps)) inst.hooks[index] = { fn, deps: deps || null }
    return inst.hooks[index].fn
  }
  sandbox.useMemo = (fn, deps) => {
    const inst = hookOf()
    const index = inst.cursor++
    const before = inst.hooks[index]
    if (!before || changed(before.deps, deps)) inst.hooks[index] = { value: fn(), deps: deps || null }
    return inst.hooks[index].value
  }
  sandbox.useValue = atom => atom.get()
  sandbox.jsx = sandbox.jsxs = (type, props, extra) => {
    const p = props || {}
    if (extra && typeof extra === 'object' && !Array.isArray(extra) && 'children' in extra) {
      return { type, props: { ...p, children: extra.children }, key: extra.key }
    }
    return { type, props: p, key: extra }
  }

  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox)
  const evaluate = expression => vm.runInContext(expression, sandbox)

  // Fake elements, one per ref, so an observer watches the same node across draws.
  const fakeNodes = new Map()
  const fakeFor = (ref, props) => {
    if (!fakeNodes.has(ref)) {
      fakeNodes.set(ref, {
        props,
        getBoundingClientRect: () => ({ width: 368, height: 600, top: 0, left: 0, right: 368, bottom: 600 }),
        contains: () => false
      })
    }
    const node = fakeNodes.get(ref)
    node.props = props
    return node
  }

  // A mounted component: its own hooks, its own effects, and the nested components named in
  // `expand` drawn in place (each with hooks of its own).
  const mount = (component, getProps, expand = []) => {
    const inst = { hooks: [], cursor: 0, effects: [], cleanups: [], children: new Map(), refs: new Set(), alive: true }
    const drawInto = (target, fn, props) => {
      const saved = current
      current = target
      target.cursor = 0
      let tree
      try { tree = fn(props) } finally { current = saved }
      return tree
    }
    const walk = (owner, tree, trail) => {
      if (!tree || typeof tree !== 'object') return tree
      if (Array.isArray(tree)) return tree.map((item, index) => walk(owner, item, `${trail}.${index}`))
      if (typeof tree.type === 'function' && expand.includes(tree.type.name)) {
        const key = `${tree.type.name}@${trail}`
        let child = owner.children.get(key)
        if (!child) {
          child = { hooks: [], cursor: 0, effects: [], cleanups: [], children: new Map(), refs: new Set(), alive: true }
          owner.children.set(key, child)
        }
        child.used = true
        const drawn = drawInto(child, tree.type, tree.props)
        return { type: 'expanded', name: tree.type.name, props: { children: walk(child, drawn, `${trail}/c`) } }
      }
      const props = tree.props || {}
      if (props.ref) {
        const node = fakeFor(props.ref, props)
        if (typeof props.ref === 'function') props.ref(node)
        else props.ref.current = node
        owner.refs.add(props.ref)
      }
      if (props.children === undefined) return tree
      return { ...tree, props: { ...props, children: walk(owner, props.children, `${trail}>`) } }
    }
    const runEffects = target => {
      for (const child of target.children.values()) runEffects(child)
      const pending = target.effects
      target.effects = []
      pending.forEach(effect => effect())
    }
    const unmountInst = target => {
      for (const child of target.children.values()) unmountInst(child)
      target.cleanups.forEach(fn => { if (typeof fn === 'function') fn() })
      target.cleanups = []
      for (const ref of target.refs) if (typeof ref === 'function') ref(null)
      target.alive = false
    }
    const api = {
      tree: null,
      draw() {
        for (const child of inst.children.values()) child.used = false
        const raw = drawInto(inst, component, getProps())
        api.tree = walk(inst, raw, 'r')
        for (const [key, child] of inst.children) {
          if (!child.used) { unmountInst(child); inst.children.delete(key) }
        }
        runEffects(inst)
        return api.tree
      },
      async settle() { api.draw(); await flush(); return api.draw() },
      unmount() { unmountInst(inst) }
    }
    return api
  }

  // Run the virtual clock forward, firing every timer that comes due on the way, in order.
  const advance = async ms => {
    const end = clock.now + ms
    for (let guard = 0; guard < 10000; guard += 1) {
      let next = null
      for (const [id, timer] of timers) {
        if (timer.at <= end && (!next || timer.at < next[1].at)) next = [id, timer]
      }
      if (!next) break
      const [id, timer] = next
      clock.now = Math.max(clock.now, timer.at)
      if (timer.every) timer.at += timer.every
      else timers.delete(id)
      timer.fn()
      await flush()
    }
    clock.now = end
    await flush()
  }

  // Tell every observer watching a node whether that node is on screen.
  const showNode = (predicate, visible) => {
    let told = 0
    for (const [, node] of fakeNodes) {
      if (!predicate(node.props || {})) continue
      for (const observer of observers) {
        if (observer.gone || !observer.nodes.has(node)) continue
        const rect = visible ? { width: 20, height: 12 } : { width: 0, height: 0 }
        observer.callback([{ target: node, isIntersecting: visible, intersectionRatio: visible ? 1 : 0, intersectionRect: rect, boundingClientRect: { width: 20, height: 12 } }], observer)
        told += 1
      }
    }
    return told
  }

  return { sandbox, evaluate, plugin: sandbox.__plugin, mount, advance, clock, timers, navigated, showNode, observers }
}

// ---- a lobby, a shelf and a Hermes, as the plugin's own ctx sees them ---------------------------
function makeWorld(env, overrides = {}) {
  const nowSeconds = () => env.clock.now / 1000
  const hall = {
    state: 'live',
    you: { id: 'me', name: 'Ada', invisible: false, looking: [] },
    prefs: { open: true, games: {}, until: {} },
    roster: [],
    requests: [],
    seated: null,
    ...(overrides.hall || {})
  }
  const view = {
    player: { id: 'me', name: 'Ada', named: true }, viewer_id: 'me', allow_ai: true,
    play: [{ id: 'connect4', title: 'Connect Four', kind: 'table', installed: true, bots: true }],
    lobby: { lines: [], looking: [] },
    online: { on: true, url: 'https://games.hermesnet.xyz', linked: true, name: 'Ada', offline: false }
  }
  const asked = []
  const notified = []
  const registered = []
  const disposers = []
  const ctx = {
    storage: { get: (key, fallback) => fallback, set() {}, remove() {} },
    os: { notify: payload => { notified.push(payload); return true }, openExternal: () => true },
    registerMany(items) {
      registered.push(...items)
      return () => { items.forEach(item => { item.gone = true }) }
    },
    register(item) { registered.push(item); return () => { item.gone = true } },
    onDispose(fn) { disposers.push(fn) },
    rest: async (route, options) => {
      const body = (options && options.body) || null
      asked.push([route, body ? JSON.parse(JSON.stringify(body)) : null])
      if (route === '/online/hall') return JSON.parse(JSON.stringify(hall))
      if (route === '/view') return JSON.parse(JSON.stringify(view))
      if (route.startsWith('/board')) return { text: '', picture: null }
      if (route === '/online/hall/prefs') {
        if (typeof body.open === 'boolean') hall.prefs.open = body.open
        if (body.games) {
          hall.prefs.games = { ...hall.prefs.games, ...body.games }
          if (Object.values(body.games).some(Boolean)) hall.prefs.open = true
        }
        return { ok: true, text: '', prefs: JSON.parse(JSON.stringify(hall.prefs)) }
      }
      if (route === '/online/hall/looking') {
        hall.you.looking = body && Array.isArray(body.games) ? body.games.slice() : []
        return { ok: true, text: '', looking: hall.you.looking.slice() }
      }
      if (route === '/online/hall/request') {
        const id = `out-${asked.length}`
        hall.requests.push({
          id, state: 'pending', offer: false, game: body.game,
          from: { id: 'me', name: 'Ada' }, to: { id: body.to, name: (hall.roster.find(row => row.id === body.to) || {}).name || '' },
          created: nowSeconds(), expires: nowSeconds() + 60
        })
        return { ok: true, text: 'Asked.' }
      }
      if (route === '/online/hall/cancel') {
        const row = hall.requests.find(item => item.id === body.id)
        if (row) row.state = 'cancelled'
        return { ok: true, text: 'Cancelled.' }
      }
      if (route === '/online/hall/respond') {
        const row = hall.requests.find(item => item.id === body.id)
        if (row) row.state = body.accept ? 'accepted' : 'declined'
        return { ok: true, text: body.accept ? 'You are seated.' : 'Declined.' }
      }
      if (route === '/online/hall/retry') return { ok: true, state: hall.state }
      if (route === '/online/table/open') return { ok: true, text: 'Table opened.' }
      return { ok: true, text: '' }
    }
  }
  return { hall, view, ctx, asked, notified, registered, disposers, nowSeconds }
}

const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...[].concat(tree.props && tree.props.children || []).flatMap(nodes)]
const words = tree => !tree ? '' : typeof tree !== 'object' ? String(tree) : Array.isArray(tree) ? tree.map(words).join(' ') : [].concat(tree.props && tree.props.children || []).map(words).join(' ')
const squash = value => String(value).replace(/\s+/g, ' ').trim()
const findButton = (tree, label) => nodes(tree).find(node => node.type === 'button' && squash(words(node)) === label)
const findButtonLike = (tree, pattern) => nodes(tree).find(node => node.type === 'button' && pattern.test(squash(words(node))))
const hallReads = world => world.asked.filter(item => item[0] === '/online/hall').length
const inviteFrom = (world, extra = {}) => ({
  id: 'q1', state: 'pending', offer: false, game: 'chessboard',
  from: { id: 'bea', name: 'Bea' }, to: { id: 'me', name: 'Ada' },
  created: world.nowSeconds(), expires: world.nowSeconds() + 90, ...extra
})
const register = (env, world) => {
  env.plugin.register(world.ctx)
}
const bellProps = (world, where) => () => ({ ctx: world.ctx, where })

// ---- the checks ------------------------------------------------------------------------------
const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('paneReceivesInviteFromColdStart', async () => {
  const env = boot()
  const world = makeWorld(env)
  register(env, world)
  // Only the pane: no Games page, no status bar, no titlebar.
  const pane = env.mount(env.sandbox.WaitPane, () => ({ ctx: world.ctx }), ['PanePeople'])
  await pane.settle()
  assert.equal(nodes(pane.tree).some(node => node.props && node.props['data-pane-invite']), false, 'nothing is asked yet')
  world.hall.requests = [inviteFrom(world)]
  await env.advance(9000)
  const tree = pane.draw()
  const line = nodes(tree).find(node => node.props && node.props['data-pane-invite'])
  assert.ok(line, 'the invite delivered through /online/hall is in the pane')
  assert.match(squash(words(line)), /Bea asks to play Chess/, 'naming the person and the game: ' + squash(words(line)))
  assert.ok(findButton(line, 'Accept') && findButton(line, 'Decline'), 'with Accept and Decline on the line')
  // The line sits above the pane's scrolling body, on every tab.
  const kids = [].concat(tree.props.children).filter(Boolean)
  const lineAt = kids.findIndex(node => node.props && node.props['data-pane-invite'])
  const scrollAt = kids.findIndex(node => node.props && node.props['data-pane-scroll'])
  assert.ok(lineAt >= 0 && scrollAt > lineAt, 'the invite line is above the scroll area, not inside it')
  assert.notEqual(kids[lineAt].props.style && kids[lineAt].props.style.overflow, 'auto')
  findButton(tree, 'Play with people').props.onClick()
  const people = pane.draw()
  const kidsPeople = [].concat(people.props.children).filter(Boolean)
  assert.ok(kidsPeople.findIndex(node => node.props && node.props['data-pane-invite']) >= 0, 'and it stays on the Play with people tab')
  // The minimized strip: the invite takes the whole row, and one press opens the answers.
  env.evaluate('minimizeWaitPane()')
  const strip = pane.draw()
  const row = nodes(strip).find(node => node.props && node.props['data-pane-invite-strip'])
  assert.ok(row, 'the strip carries the invite')
  assert.equal(nodes(strip).filter(node => node.type === 'button').length, 1, 'as the one control in the row')
  assert.match(squash(words(row)), /Bea asks to play Chess/)
  row.props.onClick()
  const opened = pane.draw()
  assert.ok(findButton(opened, 'Accept'), 'one press opens the answers')
  pane.unmount()
})

check('titlebarFallbackWhenStatusHidden', async () => {
  const env = boot()
  const world = makeWorld(env)
  register(env, world)
  const status = env.mount(env.sandbox.InviteBell, bellProps(world, 'statusbar'))
  const title = env.mount(env.sandbox.InviteBell, bellProps(world, 'titlebar'))
  world.hall.requests = [inviteFrom(world)]
  await status.settle()
  await title.settle()
  await env.advance(9000)
  const drawn = tree => nodes(tree).find(node => node.props && node.props['data-invite-bell'])
  assert.ok(drawn(status.draw()), 'a visible status bar draws the invite')
  assert.equal(drawn(title.draw()), undefined, 'and the titlebar does not draw it twice')
  // The status bar's own element goes out of sight (Simple mode, a clipped bar). Only the plugin's
  // own element is observed.
  const told = env.showNode(props => props['data-invite-surface'] === 'statusbar', false)
  assert.ok(told > 0, 'the status-bar copy observes its own element')
  assert.equal(drawn(status.draw()), undefined, 'the hidden status-bar copy stands down')
  const fallback = drawn(title.draw())
  assert.ok(fallback, 'and the titlebar copy draws the invite')
  assert.equal(fallback.props['data-invite-bell'], 'titlebar')
  env.showNode(props => props['data-invite-surface'] === 'statusbar', true)
  assert.ok(drawn(status.draw()), 'back in sight, the status bar draws again')
  assert.equal(drawn(title.draw()), undefined, 'and the titlebar steps back')
  status.unmount()
  title.unmount()
})

check('notifyOncePerRequest', async () => {
  const env = boot()
  const world = makeWorld(env)
  register(env, world)
  // Nothing on screen carries an invite: no pane, no bells. Per-game alerts are off (the default).
  world.hall.requests = [inviteFrom(world)]
  await env.advance(12000)
  assert.equal(world.notified.length, 1, 'one notice for the request: ' + world.notified.length)
  assert.equal(world.notified[0].silent, true, 'a silent one')
  assert.match(String(world.notified[0].body), /Bea/, 'naming who asks')
  await env.advance(20000)
  assert.equal(world.notified.length, 1, 'the same request never rings twice')
  world.hall.requests = [inviteFrom(world, { id: 'q2' })]
  await env.advance(12000)
  assert.equal(world.notified.length, 2, 'a new request id is a new notice')
  world.hall.requests = [inviteFrom(world)]
  await env.advance(12000)
  assert.equal(world.notified.length, 2, 'a previously notified id stays quiet after a different id')
  // "Open to invites" off: no notice.
  world.hall.prefs.open = false
  world.hall.requests = [inviteFrom(world, { id: 'q3' })]
  await env.advance(12000)
  assert.equal(world.notified.length, 2, 'no notice while Open to invites is off')
  // A visible status bar carries it: no notice.
  world.hall.prefs.open = true
  const status = env.mount(env.sandbox.InviteBell, bellProps(world, 'statusbar'))
  await status.settle()
  env.showNode(props => props['data-invite-surface'] === 'statusbar', true)
  world.hall.requests = [inviteFrom(world, { id: 'q4' })]
  await env.advance(12000)
  status.draw()
  assert.equal(world.notified.length, 2, 'no notice while a surface shows the invite')
  status.unmount()
})

check('onePollAndStopsOnDispose', async () => {
  const env = boot()
  const world = makeWorld(env)
  register(env, world)
  // Registration alone reads the Hall: nothing needs to be mounted.
  await env.advance(1)
  const first = hallReads(world)
  assert.ok(first >= 1, 'registration starts the poll')
  await env.advance(80000)
  const alone = hallReads(world) - first
  assert.ok(alone >= 9 && alone <= 11, `one idle poll, every 8 s: ${alone} reads in 80 s`)
  const pane = env.mount(env.sandbox.WaitPane, () => ({ ctx: world.ctx }), ['PanePeople'])
  const status = env.mount(env.sandbox.InviteBell, bellProps(world, 'statusbar'))
  const title = env.mount(env.sandbox.InviteBell, bellProps(world, 'titlebar'))
  await pane.settle(); await status.settle(); await title.settle()
  const mounted = hallReads(world)
  await env.advance(80000)
  pane.draw(); status.draw(); title.draw()
  const together = hallReads(world) - mounted
  assert.ok(together >= 9 && together <= 11, `still one poll with the pane and both bells mounted: ${together} reads in 80 s`)
  status.unmount(); title.unmount()
  const unmounted = hallReads(world)
  await env.advance(40000)
  assert.ok(hallReads(world) - unmounted >= 4, 'unmounting the bells does not stop the poll')
  const card = env.mount(env.sandbox.PlayWithPeople, () => ({ ctx: world.ctx, view: world.view }))
  const hall = env.mount(env.sandbox.LobbyHall, () => ({ ctx: world.ctx, view: world.view }))
  await card.settle()
  await hall.settle()
  const fullPage = hallReads(world)
  await env.advance(30000)
  assert.equal(hallReads(world) - fullPage, 10, 'both Games views share one 3 s poll with the pane')
  card.unmount()
  hall.unmount()
  pane.unmount()
  assert.ok(world.disposers.length >= 1, 'registration hands the host a disposer')
  world.disposers.forEach(fn => fn())
  const disposed = hallReads(world)
  await env.advance(80000)
  assert.equal(hallReads(world), disposed, 'disposing the plugin stops the poll')
})

check('panePeopleUsesHallEndToEnd', async () => {
  const env = boot()
  const world = makeWorld(env, { hall: { prefs: { open: true, games: {}, until: {} } } })
  register(env, world)
  const pane = env.mount(env.sandbox.WaitPane, () => ({ ctx: world.ctx }), ['PanePeople'])
  await pane.settle()
  await env.advance(1000)
  let tree = pane.draw()
  const tab = findButton(tree, 'Play with people')
  assert.ok(tab, 'the pane header has a Play with people tab')
  assert.equal(findButton(tree, 'Lobby'), undefined, 'in place of Lobby')
  tab.props.onClick()
  await env.advance(3500)
  tree = pane.draw()
  const text = () => squash(words(pane.tree))
  // Nobody here, nothing chosen.
  assert.match(text(), /Open to invites/, 'the Open to invites switch')
  assert.match(text(), /Nobody else online\./, 'and the empty list says so')
  assert.equal(findButton(tree, 'Find a match'), undefined, 'no Find a match with no games chosen')
  assert.ok(findButton(tree, 'Choose games'), 'it asks for games instead')
  // Edit: one picker, the Hall's prefs.
  findButton(tree, 'Edit').props.onClick()
  tree = pane.draw()
  const pick = id => nodes(pane.tree).find(node => node.props && node.props['data-pane-game-pick'] === id)
  assert.ok(pick('chessboard') && pick('reversi'), 'the picker lists the lobby games')
  await pick('chessboard').props.onClick(); await flush(); pane.draw()
  await pick('reversi').props.onClick(); await flush(); pane.draw()
  const prefsPosts = world.asked.filter(item => item[0] === '/online/hall/prefs').map(item => item[1])
  assert.deepEqual(prefsPosts, [{ games: { chessboard: true } }, { games: { reversi: true } }], 'each pick is the Hall\'s own prefs write')
  findButton(pane.tree, 'Done').props.onClick()
  tree = pane.draw()
  assert.match(text(), /Games: Reversi, Chess|Games: Chess, Reversi/, 'the games line names them: ' + text())
  // Find, then Stop, through the Hall's looking door.
  await findButton(tree, 'Find a match').props.onClick(); await flush()
  tree = pane.draw()
  const looked = world.asked.filter(item => item[0] === '/online/hall/looking').map(item => item[1])
  assert.equal(looked.length, 1, 'Find a match posts once')
  assert.deepEqual(looked[0].games.slice().sort(), ['chessboard', 'reversi'], 'for the chosen games')
  assert.match(text(), /Looking for (Reversi, Chess|Chess, Reversi)/, 'while active it says what it looks for: ' + text())
  await findButton(tree, 'Stop').props.onClick(); await flush()
  tree = pane.draw()
  assert.deepEqual(world.asked.filter(item => item[0] === '/online/hall/looking').pop()[1], { on: false }, 'Stop ends the search')
  assert.ok(findButton(tree, 'Find a match'), 'and Find a match is back')
  // Bea arrives; she takes both games, so Ask carries a game choice.
  world.hall.roster = [
    { id: 'me', name: 'Ada', status: 'online', games: ['chessboard', 'reversi'] },
    { id: 'bea', name: 'Bea', status: 'online', games: ['chessboard', 'reversi', 'go'] },
    { id: 'cy', name: 'Cy', status: 'online', games: ['reversi'] }
  ]
  await env.advance(3500)
  tree = pane.draw()
  assert.doesNotMatch(text(), /Nobody else online/, 'the list has people now')
  const beaRow = nodes(tree).find(node => node.props && node.props['data-pane-person'] === 'bea')
  const cyRow = nodes(tree).find(node => node.props && node.props['data-pane-person'] === 'cy')
  assert.ok(beaRow && cyRow, 'Here now lists each person')
  assert.ok(nodes(beaRow).find(node => node.type === 'select'), 'a game select where more than one game overlaps')
  assert.equal(nodes(cyRow).find(node => node.type === 'select'), undefined, 'and none where one does')
  const select = nodes(beaRow).find(node => node.type === 'select')
  select.props.onChange({ target: { value: 'chessboard' } })
  await nodes(beaRow).find(node => node.type === 'button' && /^Ask/.test(squash(words(node)))).props.onClick(); await flush()
  assert.deepEqual(world.asked.filter(item => item[0] === '/online/hall/request').pop()[1], { to: 'bea', game: 'chessboard' }, 'Ask is the Hall\'s request, for the chosen game')
  await env.advance(3500)
  tree = pane.draw()
  assert.match(text(), /Asking Bea to play Chess · \d+s/, 'you asked: who, what and the seconds: ' + text())
  assert.ok(findButton(tree, 'Cancel'), 'with Cancel')
  // Declined: said once, and an active search carries on.
  await findButton(pane.tree, 'Find a match').props.onClick(); await flush()
  world.hall.requests.forEach(row => { if (row.from.id === 'me') row.state = 'declined' })
  await env.advance(3500)
  tree = pane.draw()
  assert.match(text(), /Bea passed on Chess\./, 'a decline is said plainly: ' + text())
  assert.match(text(), /Looking for/, 'and the search continues')
  assert.notDeepEqual(world.asked.filter(item => item[0] === '/online/hall/looking').pop()[1], { on: false }, 'nothing stopped it')
  await findButton(pane.tree, 'Stop').props.onClick(); await flush()
  // Timed out.
  await nodes(pane.draw()).find(node => node.props && node.props['data-pane-person'] === 'cy')
  const cyAsk = nodes(nodes(pane.tree).find(node => node.props && node.props['data-pane-person'] === 'cy')).find(node => node.type === 'button' && /^Ask/.test(squash(words(node))))
  await cyAsk.props.onClick(); await flush()
  await env.advance(3500)
  pane.draw()
  assert.match(text(), /Asking Cy to play Reversi/, text())
  world.hall.requests.forEach(row => { if (row.from.id === 'me' && row.state === 'pending') row.state = 'expired' })
  await env.advance(3500)
  pane.draw()
  assert.match(text(), /Cy didn't answer\./, 'a timeout is said plainly: ' + text())
  // Bea asks; Accept opens the table here, and the seat comes on a later poll.
  world.hall.requests.push(inviteFrom(world, { id: 'q5' }))
  await env.advance(3500)
  tree = pane.draw()
  const line = nodes(tree).find(node => node.props && node.props['data-pane-invite'])
  assert.ok(line, 'the invite line is up')
  await findButton(line, 'Accept').props.onClick(); await flush()
  assert.deepEqual(world.asked.filter(item => item[0] === '/online/hall/respond').pop()[1], { id: 'q5', accept: true })
  pane.draw()
  assert.equal(world.asked.filter(item => item[0] === '/online/table/open').length, 0, 'no seat yet, so no table yet')
  world.hall.seated = { room_id: 'room-5', game: 'chessboard', request_id: 'q5' }
  await env.advance(3500)
  pane.draw(); await flush()
  tree = pane.draw()
  assert.deepEqual(world.asked.filter(item => item[0] === '/online/table/open').pop()[1], { room_id: 'room-5' }, 'the seat from the later poll is opened')
  const table = nodes(tree).find(node => node.type && node.type.name === 'OnlineTable')
  assert.ok(table, 'and its table is drawn in the pane')
  assert.equal(table.props.roomId, 'room-5')
  assert.equal(table.props.game.title, 'Chess', 'the seat names the game, even with Connect Four selected locally')
  assert.deepEqual(env.navigated, [], 'the person never leaves for the Games page')
  // Never the old doors.
  assert.equal(world.asked.filter(item => String(item[0]).startsWith('/online/queue')).length, 0, 'never /online/queue')
  const lines = world.asked.filter(item => item[0] === '/command').map(item => String((item[1] || {}).line || ''))
  assert.equal(lines.filter(line => /^looking\b/.test(line)).length, 0, 'never the local looking line: ' + lines.join(' | '))
  pane.unmount()
})

;(async () => {
  const only = process.argv.slice(2)
  let failed = 0
  for (const { name, fn } of checks) {
    if (only.length && !only.includes(name)) continue
    try {
      await fn()
      console.log(`PASS ${name}`)
    } catch (error) {
      failed += 1
      console.log(`FAIL ${name}: ${(error && error.message) || error}`)
      if (process.env.INVITE_HARNESS_STACK) console.log(error && error.stack)
    }
  }
  if (failed) process.exitCode = 1
})()
