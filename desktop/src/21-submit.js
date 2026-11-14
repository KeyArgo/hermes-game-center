// ---- 21-submit.js: Add your own game, as a form inside Game Center
// docs/SUBMIT-A-GAME.md is the guide; this form is how its first two levels are submitted. Nothing
// is sent from here: a finished form becomes a GitHub issue address, and the one openInBrowser door
// hands it to the person's own browser to review and send.

// GitHub accepts a long address but a browser's does not need to be. Every field below is capped, so
// this is the backstop, never the usual case: the form is a few hundred characters long.
const SUBMIT_URL_CAP = 6000

// The issue forms in .github/ISSUE_TEMPLATE/. Their field ids are the query parameters GitHub
// pre-fills from, which is why the two lists below have to keep matching those files.
const SUBMIT_TEMPLATES = { community: 'submit-community-game.yml', center: 'submit-game-center-game.yml' }
const SUBMIT_FIELDS = {
  community: ['game-title', 'game-link', 'submitter', 'licence', 'summary'],
  center: ['game-title', 'source-repo', 'submitter', 'licence', 'contract']
}

// The Play contract, in the words the guide uses for it.
const PLAY_CONTRACT = [
  { id: 'seats', label: 'Seats', line: 'Two seats, and a bot seat if you want one.' },
  { id: 'turns', label: 'Turns', line: 'One move at a time, in a fixed order.' },
  { id: 'winner', label: 'A clear winner', line: 'The game ends in a win or a draw, and says which.' },
  { id: 'replay', label: 'A replay', line: 'The same moves from a fresh table reach the same result.' },
  { id: 'computer', label: 'A computer opponent', line: "The game's own bot always finds a legal move." },
  { id: 'lobby', label: 'Lobby-ready', line: 'The game can be listed, joined and watched through Game Center.' }
]

// The two choices. Each card says what it takes and, just as plainly, what it does not do.
const SUBMIT_KINDS = [
  {
    id: 'community',
    title: 'Community game',
    lead: 'Anything that runs in a browser.',
    note: "Opens in the player's own browser; never runs inside Hermes. Listed under Community creations."
  },
  {
    id: 'center',
    title: 'Game Center game',
    lead: "Only for games built for Game Center's table.",
    note: 'Only games built for Game Center can be played in Game Center. Anything else can still go in Community.'
  }
]

// Play ships inside this MIT plugin, so an added game's licence has to allow that. Names people
// actually type, matched as whole words: "BSD" and "BSD-3-Clause" both count, "GPL" never does.
const MIT_COMPATIBLE = ['mit', 'isc', 'bsd', 'bsd-2-clause', 'bsd-3-clause', 'apache-2.0', '0bsd', 'unlicense', 'cc0-1.0']

function mitCompatible(licence) {
  const named = String(licence || '').toLowerCase().replace(/[^a-z0-9.-]+/g, ' ').trim().split(' ').filter(Boolean)
  return named.some(word => MIT_COMPATIBLE.includes(word))
}

// An empty form: the one shape every check and the address builder read.
function submitBlank() {
  return { kind: '', title: '', link: '', repo: '', author: '', licence: '', summary: '', checks: {}, checked: false }
}

const submitHttps = value => /^https:\/\/[^\s]+$/i.test(String(value || '').trim())

// Fields are shortened before they are encoded, so a pasted essay cannot stretch the address.
function submitTrim(value, longest) {
  const shown = String(value == null ? '' : value).trim()
  return shown.length > longest ? shown.slice(0, longest).trim() : shown
}

// Everything wrong with a draft, in the order the form asks for it, said plainly.
function submitProblems(draft) {
  const d = draft || {}
  const kind = d.kind === 'center' ? 'center' : d.kind === 'community' ? 'community' : ''
  const problems = []
  if (!kind) problems.push('Choose Community game or Game Center game first.')
  if (!String(d.title || '').trim()) problems.push('Add a title for your game.')
  if (!String(d.author || '').trim()) problems.push('Add your name or handle, so people know who made it.')
  if (!String(d.licence || '').trim()) {
    problems.push(kind === 'center'
      ? 'Say which licence the game is under: it has to be MIT-compatible.'
      : 'Say which licence the game is under. "All rights reserved" is fine for a community game.')
  }
  if (kind === 'community') {
    if (!String(d.link || '').trim()) problems.push('Add the link to the game.')
    else if (!submitHttps(d.link)) problems.push('The link must start with https:// so it opens safely in a browser.')
    if (!String(d.summary || '').trim()) problems.push('Add one line about the game.')
  }
  if (kind === 'center') {
    if (!String(d.repo || '').trim()) problems.push('Add the source repository link for the game.')
    else if (!submitHttps(d.repo)) problems.push('The repository link must start with https://.')
    if (String(d.licence || '').trim() && !mitCompatible(d.licence)) {
      problems.push('Game Center ships under MIT, so the game needs an MIT-compatible licence: MIT, ISC, BSD, Apache-2.0, 0BSD, Unlicense or CC0.')
    }
    const checks = d.checks || {}
    const missing = PLAY_CONTRACT.filter(item => !checks[item.id])
    if (missing.length) {
      problems.push('Tick every item on the Play contract that the game meets: ' + missing.map(item => item.label.toLowerCase()).join(', ') + '.')
    }
    if (!d.checked) problems.push('Run tools/check_game.py on the game, then tick that every line passed.')
  }
  return problems
}

// The Play contract as the person ticked it, one line per item, for the issue form's contract box.
function submitContract(draft) {
  const d = draft || {}
  const checks = d.checks || {}
  const lines = PLAY_CONTRACT.filter(item => checks[item.id]).map(item => '- ' + item.label)
  if (d.checked) lines.push('- tools/check_game.py: every line passed')
  return lines.join('\n')
}

// The address the person's browser opens: a new issue of the right form, every answer taken across
// as a named field. Nothing here reaches the network; only the browser's own request does.
function submitIssueUrl(draft) {
  const d = draft || {}
  const kind = d.kind === 'center' ? 'center' : 'community'
  const answers = {
    'game-title': submitTrim(d.title, 120),
    'game-link': submitTrim(d.link, 400),
    'source-repo': submitTrim(d.repo, 400),
    submitter: submitTrim(d.author, 80),
    licence: submitTrim(d.licence, 80),
    summary: submitTrim(d.summary, 500),
    contract: submitTrim(submitContract(d), 900)
  }
  const build = () => {
    const pairs = [
      ['template', SUBMIT_TEMPLATES[kind]],
      ['title', `${kind === 'center' ? 'Game Center' : 'Community'} game: ${answers['game-title']}`]
    ]
    SUBMIT_FIELDS[kind].forEach(name => pairs.push([name, answers[name]]))
    return GAMES_REPO + '/issues/new?' + pairs.map(pair => pair[0] + '=' + encodeURIComponent(pair[1])).join('&')
  }
  let url = build()
  // The free-text box is the only one that can grow without limit; halving it is enough to fit.
  const longest = kind === 'center' ? 'contract' : 'summary'
  while (url.length > SUBMIT_URL_CAP && answers[longest]) {
    answers[longest] = answers[longest].slice(0, Math.floor(answers[longest].length / 2)).trim()
    url = build()
  }
  return url
}

// A labelled box. The `data-submit-field` handle is the issue form's field id, so a test can read
// the same name GitHub will read.
function submitBox(id, label, value, onChange, placeholder) {
  return jsxs('label', {
    style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: text.secondary, minWidth: 0 },
    children: [
      jsx('span', { children: label }),
      jsx('input', {
        'data-submit-field': id,
        value,
        placeholder: placeholder || '',
        'aria-label': label,
        onChange: event => onChange(event.target.value),
        style: {
          padding: '7px 10px',
          borderRadius: 8,
          border: `1px solid ${stroke}`,
          background: 'transparent',
          color: 'inherit',
          fontSize: 12,
          width: '100%',
          boxSizing: 'border-box',
          minWidth: 0
        }
      })
    ]
  })
}

// One tickable line of the checklist. The label wraps the box, so the words are the target too.
function submitTick(id, label, line, ticked, onToggle) {
  return jsxs('label', {
    'data-submit-contract': id,
    style: { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, color: text.secondary, lineHeight: 1.4, minWidth: 0 },
    children: [
      jsx('input', {
        type: 'checkbox',
        checked: !!ticked,
        'aria-label': label,
        onChange: event => onToggle(!!event.target.checked),
        style: { marginTop: 2 }
      }),
      jsxs('span', { style: { minWidth: 0 }, children: [
        jsx('b', { style: { color: text.primary, fontWeight: 600 }, children: label }),
        jsx('span', { children: ' — ' + line })
      ] })
    ]
  })
}

// The form. Two cards first, then only the fields that choice needs: a community game never asks for
// the Play contract, and a Game Center game never pretends a link is enough.
function SubmitGameForm({ ctx, onBack, submitHref, submitLabel, onNote }) {
  const [draft, setDraft] = useState(submitBlank())
  const [problems, setProblems] = useState([])
  const [note, setNote] = useState('')
  const set = (name, value) => setDraft(previous => ({ ...previous, [name]: value }))
  const setCheck = (id, ticked) => setDraft(previous => ({ ...previous, checks: { ...previous.checks, [id]: ticked } }))
  const choose = kind => setDraft(previous => ({ ...previous, kind }))
  // One press: the same answers, the level that takes anything.
  const asCommunity = () => setDraft(previous => ({ ...previous, kind: 'community', repo: '', checks: {}, checked: false }))
  const send = () => {
    const found = submitProblems(draft)
    setProblems(found)
    if (found.length) return
    openInBrowser(ctx, submitIssueUrl(draft), message => {
      // The address is long and the person is about to see the issue itself: say what happened.
      const said = /^Opened /.test(String(message || ''))
        ? 'Opened the GitHub issue in your browser. Review it there, then press Submit.'
        : String(message || '')
      setNote(said)
      if (typeof onNote === 'function') onNote(said)
    })
  }
  const kind = draft.kind
  const cards = SUBMIT_KINDS.map(choice => jsxs('button', {
    type: 'button',
    'data-submit-kind': choice.id,
    'aria-pressed': kind === choice.id,
    onClick: () => choose(choice.id),
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      textAlign: 'left',
      cursor: 'pointer',
      borderRadius: 14,
      padding: 16,
      background: card,
      color: 'inherit',
      border: `1px solid ${kind === choice.id ? accent : stroke}`,
      minWidth: 0
    },
    children: [
      jsx('div', { style: { fontFamily: DISPLAY_FONT, fontSize: 19, lineHeight: 1.2, fontWeight: 600, color: text.primary }, children: choice.title }),
      jsx('div', { style: { fontSize: 12, color: text.secondary }, children: choice.lead }),
      jsx('div', { style: { fontSize: 11, color: text.tertiary, lineHeight: 1.45 }, children: choice.note })
    ]
  }))

  const communityFields = jsxs('div', {
    'data-submit-panel': 'community',
    style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 12, minWidth: 0 },
    children: [
      submitBox('game-title', 'Title', draft.title, value => set('title', value), 'Sea Battle'),
      submitBox('game-link', 'Link to the game (https://)', draft.link, value => set('link', value), 'https://example.org/my-game'),
      submitBox('submitter', 'Your name or handle', draft.author, value => set('author', value), 'Ada'),
      submitBox('licence', 'Licence', draft.licence, value => set('licence', value), 'MIT, or "All rights reserved"'),
      submitBox('summary', 'One line about the game', draft.summary, value => set('summary', value), 'Two fleets, one grid, ten minutes.')
    ]
  })

  const centerFields = jsxs('div', {
    'data-submit-panel': 'center',
    style: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 },
    children: [
      jsxs('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 12, minWidth: 0 },
        children: [
          submitBox('game-title', 'Title', draft.title, value => set('title', value), 'Nine Men'),
          submitBox('source-repo', 'Source repository (https://)', draft.repo, value => set('repo', value), 'https://github.com/you/nine-men'),
          submitBox('submitter', 'Your name or handle', draft.author, value => set('author', value), 'Ada'),
          submitBox('licence', 'Licence (must be MIT-compatible)', draft.licence, value => set('licence', value), 'MIT')
        ]
      }),
      jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }, children: [
        jsx('div', { style: { fontSize: 12, color: text.secondary }, children: 'The Play contract — tick each one the game meets:' }),
        PLAY_CONTRACT.map(item => submitTick(item.id, item.label, item.line, draft.checks[item.id], ticked => setCheck(item.id, ticked)))
      ] }),
      submitTick('check-game', 'I ran tools/check_game.py and every line passed',
        'the checker that ships here, run on the game\'s own folder.',
        draft.checked, ticked => set('checked', ticked)),
      jsx('div', {
        style: { fontSize: 11, color: text.tertiary, lineHeight: 1.45 },
        children: 'A person plays it before it joins Play, and Play games are merged into this plugin under its MIT licence.'
      })
    ]
  })

  const actions = jsxs('div', {
    style: { display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', minWidth: 0 },
    children: [
      button('Open the GitHub issue', send, {
        primary: true,
        disabled: !kind,
        title: 'Turn this form into a GitHub issue and open it in your browser to review and send'
      }),
      kind === 'center' ? textLink('Submit as a community game instead', asCommunity) : null,
      submitHref ? textLink(submitLabel || 'Open the submission page', () => openInBrowser(ctx, submitHref, onNote)) : null
    ]
  })

  return jsxs('div', {
    'data-submit-form': '1',
    style: { display: 'flex', flexDirection: 'column', gap: 14, padding: 18, minWidth: 0 },
    children: [
      jsxs('div', {
        style: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'end', flexWrap: 'wrap' },
        children: [
          jsxs('div', { style: { minWidth: 0 }, children: [
            jsx('div', { style: { fontFamily: DISPLAY_FONT, fontSize: 26, lineHeight: 1.15, letterSpacing: '-.02em', fontWeight: 600 }, children: 'Add your own game' }),
            jsx('div', { style: { fontSize: 12, color: text.tertiary, marginTop: 4 }, children: 'Two places a game can go. Pick the one that matches what you built.' })
          ] }),
          button('Back to Game Center', onBack)
        ]
      }),
      jsx('div', {
        style: { fontSize: 12, color: text.secondary, lineHeight: 1.5 },
        children: 'This opens a GitHub issue in your browser for you to review and send. Nothing is sent from here.'
      }),
      jsx('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: 12, minWidth: 0 },
        children: cards
      }),
      kind === 'community' ? communityFields : null,
      kind === 'center' ? centerFields : null,
      actions,
      problems.length
        ? jsx('div', {
            role: 'alert',
            'data-submit-problems': '1',
            style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 12px', borderRadius: 8, border: `1px solid ${accent}`, background: card, fontSize: 12, color: text.primary, lineHeight: 1.45 },
            children: problems.map((line, index) => jsx('div', { children: line }, index))
          })
        : null,
      note
        ? jsx('div', { role: 'status', 'aria-live': 'polite', style: { fontSize: 12, color: text.secondary }, children: note })
        : null
    ]
  })
}
