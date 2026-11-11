// ---- 50-model-picker.js: one searchable model picker for every seat that takes a model
//
// The page already reads its model list from GET /models: {routes: [{id, label, model,
// provider, where}], current}. Every place that asks a person to put a Hermes model in a
// seat uses this one component, so the search, the grouping and the keyboard behave the
// same in all of them. It never invents a backend: it only reads the routes the page
// already loaded and reports the chosen route back.
const MODEL_RECENT_KEY = 'gameshelf-model-recent'
const MODEL_RECENT_LIMIT = 4
const MODEL_CHAT_ID = ''

function modelPickerRoutes(routes) {
  return (Array.isArray(routes) ? routes : [])
    .filter(item => item && typeof item === 'object' && item.model && item.provider)
}

function modelPickerRecent(ctx) {
  try {
    const raw = ctx && ctx.storage && typeof ctx.storage.get === 'function'
      ? ctx.storage.get(MODEL_RECENT_KEY, [])
      : []
    if (!Array.isArray(raw)) return []
    return raw.filter(item => typeof item === 'string' && item).slice(0, MODEL_RECENT_LIMIT)
  } catch (error) {
    return []
  }
}

function modelPickerRemember(ctx, id) {
  if (!id) return
  try {
    if (!ctx || !ctx.storage || typeof ctx.storage.set !== 'function') return
    const next = [id].concat(modelPickerRecent(ctx).filter(item => item !== id)).slice(0, MODEL_RECENT_LIMIT)
    ctx.storage.set(MODEL_RECENT_KEY, next)
  } catch (error) {
    // An older host without storage: the picker still works, it just forgets.
  }
}

function modelPickerKey(item) {
  if (!item || !item.model) return MODEL_CHAT_ID
  return String(item.id || `${item.model}|${item.provider}`)
}

// A searchable, grouped, keyboard-driven model list. "Use my chat model" is always the
// first entry: it leaves the seat on this Hermes's own model, exactly as an empty model
// does today. Recent picks sit above the provider groups so the model a person used last
// is one press away. The current route is marked, never merely guessed from its label.
function ModelPicker({ routes, current, onPick, ctx, hint = '' }) {
  const list = modelPickerRoutes(routes)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [recent, setRecent] = useState(() => modelPickerRecent(ctx))
  const needle = String(query || '').trim().toLowerCase()
  const matches = item => {
    if (!needle) return true
    return [item.model, item.provider, item.label, item.where]
      .filter(Boolean).join(' ').toLowerCase().includes(needle)
  }
  const currentId = String(current || '')
  const recentItems = recent
    .map(id => list.find(item => modelPickerKey(item) === id))
    .filter(Boolean)
    .filter(matches)
  const groups = new Map()
  list.filter(matches).forEach(item => {
    const provider = String(item.provider || 'Other')
    if (!groups.has(provider)) groups.set(provider, [])
    groups.get(provider).push(item)
  })
  const chat = { id: MODEL_CHAT_ID, label: 'Use my chat model', model: '', provider: '', kind: 'chat' }
  const entries = [
    chat,
    ...recentItems.map(item => ({ ...item, kind: 'recent' })),
    ...[...groups.keys()].sort().flatMap(provider => groups.get(provider).map(item => ({ ...item, kind: 'model' })))
  ]
  const chosen = entries[Math.min(active, entries.length - 1)] || chat
  const pick = item => {
    const next = item && item.model ? item : chat
    if (next.id) {
      modelPickerRemember(ctx, next.id)
      setRecent(modelPickerRecent(ctx))
    }
    if (typeof onPick === 'function') onPick(next)
  }
  const move = step => {
    const size = entries.length
    setActive(at => (size ? (Math.min(Math.max(at + step, 0), size - 1)) : 0))
  }
  const keyDown = event => {
    if (!event) return
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
    else if (event.key === 'Enter') { event.preventDefault(); pick(chosen) }
  }
  const isCurrent = item => {
    const key = modelPickerKey(item)
    if (!currentId) return key === MODEL_CHAT_ID
    return key === currentId
  }
  const row = item => {
    const key = modelPickerKey(item)
    const current = isCurrent(item)
    return jsx('button', {
      type: 'button',
      key: `${item.kind || 'model'}:${key || 'chat'}`,
      'data-model-id': key,
      'data-model-current': current ? '1' : undefined,
      'aria-current': current ? 'true' : undefined,
      'aria-label': `${item.label || item.model}${item.provider ? ` · ${item.provider}` : ''}${current ? ' · current' : ''}`,
      title: item.model ? `${item.model} · ${item.provider}${item.where ? ` · ${item.where}` : ''}` : 'This Hermes’s own chat model',
      onClick: () => pick(item),
      style: {
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8,
        width: '100%', textAlign: 'left', padding: '7px 9px', borderRadius: 7, cursor: 'pointer',
        border: `1px solid ${current ? accent : stroke}`,
        background: current ? fill : 'transparent',
        color: current ? text.primary : text.secondary,
        fontSize: 12, fontWeight: current ? 650 : 500
      },
      children: [
        jsx('span', { children: item.label || item.model }),
        jsx('span', {
          style: { fontSize: 11, color: text.tertiary, whiteSpace: 'nowrap' },
          children: [item.provider, item.where, current ? 'current' : ''].filter(Boolean).join(' · ')
        })
      ]
    }, `${item.kind || 'model'}:${key || 'chat'}`)
  }
  const group = (title, items, key) => items.length
    ? jsxs('div', {
        key,
        style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
        children: [
          jsx('div', { style: { fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: text.tertiary }, children: title }),
          ...items.map(row)
        ]
      })
    : null
  return jsxs('div', {
    'data-model-picker': '1',
    style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
    children: [
      jsx('input', {
        type: 'search',
        value: query,
        'aria-label': 'Search models',
        placeholder: 'Search by provider or model',
        onChange: event => { setQuery(event.target.value); setActive(0) },
        onKeyDown: keyDown,
        style: {
          width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 8,
          border: `1px solid ${stroke}`, background: 'transparent', color: 'inherit', fontSize: 12
        }
      }),
      hint ? jsx('div', { style: { fontSize: 11, color: text.tertiary }, children: hint }) : null,
      jsxs('div', {
        role: 'listbox',
        'aria-label': 'Models',
        style: { display: 'flex', flexDirection: 'column', gap: 7, maxHeight: 260, overflow: 'auto', minWidth: 0 },
        children: [
          group('Chat model', [chat], 'chat'),
          recentItems.length ? group('Recent', recentItems.map(item => ({ ...item, kind: 'recent' })), 'recent') : null,
          ...[...groups.keys()].sort().map(provider => group(provider, groups.get(provider).map(item => ({ ...item, kind: 'model' })), provider)),
          entries.length ? null : jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: 'No models match that search.' })
        ]
      })
    ]
  })
}
