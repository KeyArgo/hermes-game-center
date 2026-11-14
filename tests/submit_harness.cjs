// Add your own game: the form inside Game Center, and the GitHub issue address it builds.
//
// The bundle is loaded the way the desktop loads it, with react's hooks replaced by the harness's own
// slots, so a press, a typed answer and a tick are the same calls the real page makes. Nothing here
// reaches a network: the browser door is a stub that records the address it was handed.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '../desktop/plugin.js'), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export \{.*\}$/gm, '').replace('export default {', 'const plugin = {')

const sandbox = {
  console, Set, setTimeout, clearTimeout, setInterval, clearInterval,
  PANES_AREA: 'panes', PALETTE_AREA: 'palette', ROUTES_AREA: 'routes',
  SIDEBAR_NAV_AREA: 'nav', STATUSBAR_AREAS: { right: 'right' },
  COMPOSER_AREAS: { top: 'composer.top', bottom: 'composer.bottom', underside: 'composer.underside' }
}
sandbox.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  dispatchEvent: () => true
}
sandbox.document = { addEventListener: () => {}, removeEventListener: () => {}, getElementById: () => null, activeElement: null }
sandbox.host = {
  state: { busy: { get: () => false, subscribe: () => () => {} } },
  onEvent: () => () => {},
  navigate: () => {},
  revealPane: () => {}
}
const evaluate = expression => vm.runInContext(expression, sandbox)

// React's element shape, children in the props or in the third argument.
sandbox.jsx = sandbox.jsxs = (type, props, extra) => {
  const p = props || {}
  if (extra && typeof extra === 'object' && !Array.isArray(extra) && 'children' in extra) {
    return { type, props: { ...p, children: extra.children }, key: extra.key }
  }
  return { type, props: p, key: extra }
}
// One hook slot per call, kept across a re-draw the way React keeps state across a render.
let hooks = []
let cursor = 0
sandbox.useState = initial => {
  const index = cursor++
  if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
  return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value }]
}
sandbox.useRef = initial => {
  const index = cursor++
  if (!(index in hooks)) hooks[index] = { current: initial }
  return hooks[index]
}
sandbox.useCallback = fn => fn
sandbox.useMemo = fn => fn()
sandbox.useEffect = () => {}
sandbox.useLayoutEffect = () => {}
sandbox.useValue = atom => atom.get()
sandbox.Component = class { constructor(props) { this.props = props; this.state = {} } setState(next) { this.state = { ...this.state, ...next } } }

const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...[].concat(tree.props && tree.props.children || []).flatMap(nodes)]
const words = tree => !tree ? '' : typeof tree !== 'object' ? String(tree) : Array.isArray(tree) ? tree.map(words).join(' ') : [].concat(tree.props && tree.props.children || []).map(words).join(' ')
const findButton = (tree, label) => nodes(tree).find(node => node.type === 'button' && words(node) === label)
const byField = (tree, id) => nodes(tree).find(node => node.props && node.props['data-submit-field'] === id)
const byKind = (tree, id) => nodes(tree).find(node => node.props && node.props['data-submit-kind'] === id)
const byTick = (tree, id) => nodes(tree).find(node => node.props && node.props['data-submit-contract'] === id)
const json = value => JSON.parse(JSON.stringify(value))

// The bundle reads its imports and its React hooks off the sandbox as it loads.
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

// The browser door every press goes through: it records the address and says it opened.
const opened = []
const ctx = { os: { openExternal: async url => { opened.push(url); return true } } }
const props = { ctx, onBack: () => {}, submitHref: '', submitLabel: 'Submit your game', onNote: () => {} }
sandbox.submitProps = props
// A re-draw is what React does after a press: the same elements, the state the last press left.
const draw = () => { cursor = 0; return evaluate('SubmitGameForm(submitProps)') }

let tree = draw()

async function main() {

  // ---- 1. Two choices first, each saying what it is and what it is not.
  const cards = [byKind(tree, 'community'), byKind(tree, 'center')]
  assert.ok(cards[0] && cards[1], 'the form opens with the two cards')
  assert.equal(cards[0].props['aria-pressed'], false, 'neither is chosen yet')
  assert.ok(words(cards[0]).includes('Community game'), 'the first card is named: ' + words(cards[0]))
  assert.ok(words(cards[0]).includes('Anything that runs in a browser.'), 'and says what it takes')
  assert.ok(words(cards[0]).includes("Opens in the player's own browser; never runs inside Hermes. Listed under Community creations."),
    'and says plainly that it never runs inside Hermes: ' + words(cards[0]))
  assert.ok(words(cards[1]).includes('Game Center game'), 'the second card is named')
  assert.ok(words(cards[1]).includes("Only for games built for Game Center's table."), 'and says what it takes')
  assert.ok(words(cards[1]).includes('Only games built for Game Center can be played in Game Center. Anything else can still go in Community.'),
    'and offers Community for everything else: ' + words(cards[1]))
  assert.ok(words(tree).includes('This opens a GitHub issue in your browser for you to review and send.'), 'the form says who sends it')
  assert.ok(words(tree).includes('Nothing is sent from here.'), 'and that the plugin sends nothing')
  assert.equal(findButton(tree, 'Open the GitHub issue').props.disabled, true, 'the send button waits for a choice')
  assert.equal(byField(tree, 'game-link'), undefined, 'no fields before a choice is made')
  resetState()

  // ---- 2. Validation: https only, and nothing blank.
  const problemsFor = draft => json(evaluate(`submitProblems(${JSON.stringify(draft)})`))
  const community = { kind: 'community', title: 'Sky Hooks', link: 'https://example.org/sky', author: 'Ada', licence: 'MIT', summary: 'Ten minutes.' }
  assert.deepEqual(problemsFor({ ...community }), [], 'a complete community draft has nothing wrong with it')
  let said = problemsFor({ ...community, link: 'http://example.org/sky' })
  assert.ok(said.some(line => line.includes('https://')), 'a plain http link is refused: ' + said.join(' | '))
  said = problemsFor({ kind: 'community', title: ' ', link: '', author: '', licence: '', summary: '' })
  assert.equal(said.length, 5, 'every blank is named: ' + said.join(' | '))
  assert.ok(said.includes('Choose Community game or Game Center game first.') === false, 'a chosen kind is not complained about')
  assert.deepEqual(problemsFor({}), ['Choose Community game or Game Center game first.',
    'Add a title for your game.',
    'Add your name or handle, so people know who made it.',
    'Say which licence the game is under. "All rights reserved" is fine for a community game.'], 'an empty form says what is missing, in order')
  const center = { kind: 'center', title: 'Nine Men', repo: 'https://github.com/ada/nine-men', author: 'Ada', licence: 'MIT', checks: {}, checked: false }
  said = problemsFor(center)
  assert.ok(said.some(line => line.includes('Play contract')), 'unticked boxes are named: ' + said.join(' | '))
  assert.ok(said.some(line => line.includes('check_game.py')), 'and so is the checker')
  assert.deepEqual(problemsFor({ ...center, checks: { seats: true, turns: true, winner: true, replay: true, computer: true, lobby: true }, checked: true }), [],
    'a complete Game Center draft has nothing wrong with it')
  assert.ok(problemsFor({ ...center, licence: 'GPL-3.0' }).some(line => line.includes('MIT-compatible')), 'a copyleft licence is refused')
  assert.ok(problemsFor({ ...center, licence: 'Apache-2.0' }).every(line => !line.includes('MIT-compatible')), 'a permissive one is not')
  assert.ok(problemsFor({ ...center, repo: 'http://github.com/ada/nine-men' }).some(line => line.includes('https://')), 'the repository has to be https too')

  // ---- 2b. A plain http link is refused in the form itself, and nothing opens.
  tree = draw()
  byKind(tree, 'community').props.onClick()
  tree = draw()
  const typeCommunity = (id, value) => { byField(tree, id).props.onChange({ target: { value } }); tree = draw() }
  typeCommunity('game-title', 'Sky Hooks')
  typeCommunity('game-link', 'http://example.org/sky')
  typeCommunity('submitter', 'Ada')
  typeCommunity('licence', 'MIT')
  typeCommunity('summary', 'Ten minutes.')
  findButton(tree, 'Open the GitHub issue').props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  tree = draw()
  assert.equal(opened.length, 0, 'a plain http link opens nothing')
  assert.ok(words(tree).includes('The link must start with https://'), 'the form says why: ' + words(tree))
  resetState()

  // ---- 3. Game Center is blocked until every box is ticked, and one press sends it once ticked.
  const everyTick = { seats: true, turns: true, winner: true, replay: true, computer: true, lobby: true }
  tree = draw()
  byKind(tree, 'center').props.onClick()
  tree = draw()
  assert.equal(byKind(tree, 'center').props['aria-pressed'], true, 'the second card is chosen')
  assert.ok(words(tree).includes('The Play contract'), 'the contract is shown as a checklist')
  for (const id of Object.keys(everyTick)) assert.ok(byTick(tree, id), `the checklist carries ${id}`)
  const type = (id, value) => { byField(tree, id).props.onChange({ target: { value } }); tree = draw() }
  type('game-title', 'Nine Men')
  type('source-repo', 'https://github.com/ada/nine-men')
  type('submitter', 'Ada')
  type('licence', 'MIT')
  for (const id of ['seats', 'turns', 'winner', 'replay', 'computer']) {
    nodes(byTick(tree, id)).find(node => node.type === 'input').props.onChange({ target: { checked: true } })
    tree = draw()
  }
  findButton(tree, 'Open the GitHub issue').props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  tree = draw()
  assert.equal(opened.length, 0, 'nothing opens while an item is unticked')
  assert.ok(nodes(tree).some(node => node.props && node.props['data-submit-problems']), 'the form says what is missing')
  assert.ok(words(tree).includes('lobby-ready'), 'and names the unticked line: ' + words(tree))
  nodes(byTick(tree, 'lobby')).find(node => node.type === 'input').props.onChange({ target: { checked: true } })
  tree = draw()
  findButton(tree, 'Open the GitHub issue').props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  tree = draw()
  assert.equal(opened.length, 0, 'the checker line is still unticked, so still nothing opens')
  assert.ok(words(tree).includes('tools/check_game.py'), 'and the form says to run it: ' + words(tree))
  nodes(byTick(tree, 'check-game')).find(node => node.type === 'input').props.onChange({ target: { checked: true } })
  tree = draw()
  findButton(tree, 'Open the GitHub issue').props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(opened.length, 1, 'every box ticked, so the issue opens')
  assert.ok(String(opened[0]).startsWith('https://github.com/KeyArgo/hermes-game-center/issues/new?'), 'as a new issue on the repository')
  assert.ok(String(opened[0]).includes('template=submit-game-center-game.yml'), 'of the Game Center form')
  tree = draw()
  assert.ok(words(tree).includes('Opened the GitHub issue in your browser. Review it there, then press Submit.'), 'and the form says what happened')
  resetState()

  // ---- 4. Submit as a community game instead: one press, the same answers, no contract asked for.
  tree = draw()
  byKind(tree, 'center').props.onClick()
  tree = draw()
  const type2 = (id, value) => { byField(tree, id).props.onChange({ target: { value } }); tree = draw() }
  type2('game-title', 'Sky Hooks')
  type2('submitter', 'Ada')
  type2('licence', 'MIT')
  findButton(tree, 'Submit as a community game instead').props.onClick()
  tree = draw()
  assert.equal(byKind(tree, 'community').props['aria-pressed'], true, 'the community card is chosen')
  assert.equal(byField(tree, 'game-title').props.value, 'Sky Hooks', 'the title is kept')
  assert.equal(byField(tree, 'submitter').props.value, 'Ada', 'so is the name')
  assert.equal(byTick(tree, 'seats'), undefined, 'and the contract is gone, because a community game never needs it')
  assert.ok(byField(tree, 'game-link'), 'the link box takes its place')
  resetState()

  // ---- 5. The address: the right form, every answer named, encoded, and short enough for any URL.
  const url = draft => json(evaluate(`submitIssueUrl(${JSON.stringify(draft)})`))
  const query = address => new URL(address).searchParams
  const communityUrl = url({ ...community, title: 'Sky & Hooks / café', link: 'https://example.org/sky?a=1&b=2', summary: 'Two fleets & one grid.' })
  assert.ok(communityUrl.startsWith('https://github.com/KeyArgo/hermes-game-center/issues/new?'), 'a new issue on the repository')
  const asked = query(communityUrl)
  assert.equal(asked.get('template'), 'submit-community-game.yml', 'the community form')
  assert.equal(asked.get('game-title'), 'Sky & Hooks / café', 'the title arrives whole, ampersand and all')
  assert.equal(asked.get('game-link'), 'https://example.org/sky?a=1&b=2', 'so does a link with its own query')
  assert.equal(asked.get('submitter'), 'Ada', 'the name')
  assert.equal(asked.get('licence'), 'MIT', 'the licence')
  assert.equal(asked.get('summary'), 'Two fleets & one grid.', 'and the line about the game')
  assert.equal(asked.get('title'), 'Community game: Sky & Hooks / café', 'the issue is titled after the game')
  assert.equal(communityUrl.split('?')[1].split('&').filter(pair => pair.startsWith('game-title=')).length, 1, 'each answer is one parameter')
  for (const name of json(evaluate('SUBMIT_FIELDS.community'))) assert.ok(asked.get(name) !== null, `the community form is sent ${name}`)
  const centerUrl = url({ ...center, title: 'Nine Men', checks: everyTick, checked: true })
  assert.equal(query(centerUrl).get('template'), 'submit-game-center-game.yml', 'the Game Center form')
  assert.ok(query(centerUrl).get('contract').includes('- Seats'), 'the ticked contract travels: ' + query(centerUrl).get('contract'))
  assert.ok(query(centerUrl).get('contract').includes('tools/check_game.py: every line passed'), 'with the checker line')
  assert.equal(query(centerUrl).get('title'), 'Game Center game: Nine Men', 'titled after the game')
  for (const name of json(evaluate('SUBMIT_FIELDS.center'))) assert.ok(query(centerUrl).get(name) !== null, `the Game Center form is sent ${name}`)
  // A pasted essay cannot make an address a browser will choke on.
  const huge = url({ ...community, summary: '%'.repeat(20000) })
  assert.ok(huge.length <= 6000, 'the address stays under 6000 characters, got ' + huge.length)
  assert.equal(query(huge).get('template'), 'submit-community-game.yml', 'and still names the right form')
  assert.ok(query(huge).get('summary').length > 0, 'with as much of the answer as fits')
  // The worst case is not one long box but every box full of the widest characters a URL escapes:
  // three bytes apiece is nine characters each once percent-encoded. Emptying the free-text box is
  // not enough there, so the cap holds only if the other answers shrink too.
  const widest = euro => '€'.repeat(euro)
  const worst = url({
    ...community,
    title: widest(200),
    link: 'https://example.org/' + widest(500),
    author: widest(200),
    licence: widest(200),
    summary: widest(2000)
  })
  assert.ok(worst.length <= 6000, 'an all-escape draft stays under 6000 characters, got ' + worst.length)
  assert.equal(query(worst).get('template'), 'submit-community-game.yml', 'and still names the right form')
  assert.ok(query(worst).get('game-title').length > 0, 'keeping as much of the title as fits')
  assert.ok(!/[\uD800-\uDFFF]/.test(decodeURIComponent(worst.split('?')[1])), 'every escape is whole: no half a character')
  // The other form, where the free-text box is the short one: the repository link carries the weight.
  const worstCenter = url({
    ...center,
    title: widest(200),
    repo: 'https://example.org/' + widest(500),
    author: widest(200),
    checks: everyTick,
    checked: true
  })
  assert.ok(worstCenter.length <= 6000, 'an all-escape Game Center draft stays under 6000, got ' + worstCenter.length)
  assert.equal(query(worstCenter).get('template'), 'submit-game-center-game.yml', 'and still names the right form')
}

main().then(() => {
  console.log('submit fields: ' + JSON.stringify(json(evaluate('SUBMIT_FIELDS'))))
  console.log('submit form: passed')
}).catch(error => { console.error(error); process.exitCode = 1 })

function resetState() {
  hooks = []
  cursor = 0
  sandbox.submitProps = props
}
