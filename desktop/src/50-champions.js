// ---- 50-champions.js: champions and tournaments
// A champion's body is the person's own Hermes pet (drawn by PetSprite); there is
// no avatar picker and no chess glyph anywhere on this screen. The server still
// carries an `avatar` field on old files, so it is kept and sent unchanged, but it
// is never shown and never chosen.
const EMPTY_CHAMPION = { id: '', name: '', motto: '', avatar: 'knight', color: 'amber', brief: '', model: '', provider: '', created_at: 0 }


function ChampionsPage({ ctx, view }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [form, setForm] = useState(EMPTY_CHAMPION)
  const [division, setDivision] = useState('prompt')
  const [picked, setPicked] = useState([])
  const [bots, setBots] = useState([])
  const [games, setGames] = useState([])
  const [seed, setSeed] = useState('1')
  const [capGames, setCapGames] = useState('40')
  const [capCalls, setCapCalls] = useState('240')
  const [run, setRun] = useState(null)
  const [watching, setWatching] = useState(null)
  const [auto, setAuto] = useState(false)
  const [pasted, setPasted] = useState('')
  const [editing, setEditing] = useState('')
  const [spar, setSpar] = useState(null)
  const [routes, setRoutes] = useState([])
  const [showShare, setShowShare] = useState('')
  const alive = useRef(true)
  const pollGen = useRef(0)

  const refresh = useCallback(async () => {
    const gen = ++pollGen.current
    try {
      const next = await ctx.rest('/champions')
      if (!alive.current || gen !== pollGen.current) return null
      if (next && next.ok === false) { setError(next.text || 'Game Center could not read the champions.'); return null }
      setData(next)
      return next
    } catch (failure) {
      if (alive.current) setError(failure.message || 'Champions are waiting on the Hermes gateway. Stay on this page; it retries.')
      return null
    }
  }, [ctx])

  useEffect(() => {
    alive.current = true
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => { alive.current = false; clearInterval(timer) }
  }, [refresh])

  // The model routes this Hermes may hand a champion. Read once: the list only changes
  // when a person edits their config. A host without the route simply offers one chip.
  useEffect(() => {
    let live = true
    const load = async () => {
      try {
        const answer = await ctx.rest('/models')
        if (live && answer && answer.ok && Array.isArray(answer.routes)) setRoutes(answer.routes)
      } catch (failure) {
        if (live) setRoutes([])
      }
    }
    load()
    return () => { live = false }
  }, [ctx])

  useEffect(() => {
    if (!run || run.status !== 'running' || !run.id) return undefined
    let live = true
    const timer = setInterval(async () => {
      try {
        const next = await ctx.rest(`/tournament/status?id=${encodeURIComponent(run.id)}`)
        if (!live || !alive.current) return
        if (next && next.ok !== false) {
          setRun(next)
          if (next.status !== 'running') refresh()
        }
      } catch (failure) {
        if (live && alive.current) setError(failure.message || 'Could not read the tournament.')
      }
    }, 1500)
    return () => { live = false; clearInterval(timer) }
  }, [run && run.id, run && run.status, ctx, refresh])

  useEffect(() => {
    if (!watching || !auto) return undefined
    const frames = watching.frames || []
    if (watching.index >= frames.length - 1) return undefined
    const timer = setTimeout(() => {
      setWatching(current => current ? { ...current, index: Math.min(current.index + 1, frames.length - 1) } : current)
    }, 1100)
    return () => clearTimeout(timer)
  }, [watching, auto])

  const act = async (path, body) => {
    try {
      const answer = await ctx.rest(path, { method: 'POST', body })
      if (alive.current) {
        if (answer && answer.ok === false) { setError(answer.text || 'That did not work.'); setNotice('') }
        else { setError(''); setNotice((answer && answer.text) || '') }
      }
      await refresh()
      return answer
    } catch (failure) {
      if (alive.current) setError(failure.message || 'That did not reach the Game Center.')
      return { ok: false }
    }
  }

  if (!data) {
    return jsx('div', { style: { padding: 18, color: text.secondary }, children: error || 'Loading champions…' })
  }

  // The body of every champion on this screen is this Hermes's own pet.
  const pet = data.pet || null

  const save = () => {
    const champion = {
      ...(form.id ? { id: form.id } : {}),
      name: form.name, motto: form.motto, avatar: form.avatar, color: form.color,
      brief: form.brief,
      brain: { kind: 'model', model: form.model.trim(), provider: form.provider.trim() }
    }
    if (form.created_at) champion.created_at = form.created_at
    return act('/champions/save', { champion }).then(answer => {
      if (answer && answer.ok) setForm(EMPTY_CHAMPION)
    })
  }
  const remove = champion => {
    const okay = typeof window === 'undefined' || !window.confirm
      ? true
      : window.confirm(`Delete "${champion.name}"? Its record and rating stay until a tournament removes it.`)
    if (okay) act('/champions/delete', { id: champion.id })
  }
  const exportChampion = async champion => {
    const answer = await act('/champions/export', { id: champion.id })
    if (answer && answer.ok) {
      if (!saveFile(answer.filename || `${champion.id}.champion.json`, answer.text)) {
        setShowShare(answer.text); setNotice('Copy this file text to share the champion.')
      } else setNotice(`Saved ${answer.filename}.`)
    }
  }
  const importChampion = async text => {
    if (!String(text || '').trim()) { setError('Paste a champion file first.'); return }
    const answer = await act('/champions/import', { text })
    if (answer && answer.ok) { setPasted(''); setNotice(`Imported ${answer.champion.name}.`) }
  }
  const pickImport = () => {
    if (typeof document === 'undefined') return
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.onchange = () => {
      const file = input.files && input.files[0]
      if (!file || typeof FileReader === 'undefined') return
      const reader = new FileReader()
      reader.onload = () => importChampion(String(reader.result || ''))
      reader.onerror = () => setError('That file could not be read.')
      reader.readAsText(file)
    }
    input.click()
  }
  const toggle = (list, setList, value) => {
    setList(list.includes(value) ? list.filter(item => item !== value) : [...list, value])
  }

  const champions = data.champions || []
  const boards = Object.fromEntries((data.leaderboard || []).map(row => [row.id, row]))
  const count = picked.length + bots.length
  const pairs = count * (count - 1) / 2
  const estimateGames = pairs * 2 * games.length
  const estimateCalls = picked.length ? estimateGames * 24 : 0
  const estimateMinutes = Math.max(1, Math.round(estimateGames * 0.6))
  const divisionInfo = (data.divisions || []).find(item => item.id === division) || {}
  const canStart = count >= 2 && games.length > 0 && !(division === 'prompt' && (bots.length > 0 || picked.length < 2))
    && estimateGames <= Number(data.caps.games) && estimateCalls <= Number(data.caps.calls)
  const gameTitle = id => ((data.games || []).find(item => item.id === id) || {}).title || id
  const nameOf = id => (run && run.names && run.names[id]) || ((data.champions || []).find(item => item.id === id) || {}).name || (id.startsWith("bot-") ? "Computer (" + id.slice(4).replace(/^./, c => c.toUpperCase()) + ")" : id)

  const start = async () => {
    const answer = await act('/tournament/start', {
      champions: picked, bots, games, division,
      seed: Number(seed) || 0,
      cap_games: Number(capGames) || undefined,
      cap_calls: Number(capCalls) || undefined
    })
    if (answer && answer.ok && answer.id) {
      setRun({ id: answer.id, status: 'running', played: 0, total: answer.estimate.games, results: [], names: {}, estimate: answer.estimate })
    }
  }
  const openSaved = async id => {
    try {
      const status = await ctx.rest(`/tournament/status?id=${encodeURIComponent(id)}`)
      if (status && status.ok !== false) { setRun(status); setError('') }
      else setError((status && status.text) || 'That tournament could not be opened.')
    } catch (failure) {
      setError(failure.message || 'That tournament could not be opened.')
    }
  }
  const importTournament = async text => {
    if (!String(text || '').trim()) { setError('That file was empty.'); return }
    const answer = await act('/tournament/import', { text })
    if (answer && answer.ok) openSaved(answer.id)
  }
  const pickTournamentFile = () => {
    if (typeof document === 'undefined') return
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.onchange = () => {
      const file = input.files && input.files[0]
      if (!file || typeof FileReader === 'undefined') return
      const reader = new FileReader()
      reader.onload = () => importTournament(String(reader.result || ''))
      reader.onerror = () => setError('That file could not be read.')
      reader.readAsText(file)
    }
    input.click()
  }
  const watch = async index => {
    if (!run) return
    try {
      const replay = await ctx.rest(`/tournament/replay?id=${encodeURIComponent(run.id)}&index=${index}`)
      if (replay && replay.ok !== false) { setWatching({ ...replay, index: 0 }); setAuto(false); setError('') }
      else setError((replay && replay.text) || 'That game could not be replayed.')
    } catch (failure) {
      setError(failure.message || 'That game could not be replayed.')
    }
  }

  const creator = jsxs('div', {
    style: { borderRadius: 14, padding: 16, background: card, display: 'flex', flexDirection: 'column', gap: 12 },
    children: [
      jsx('div', { style: { fontFamily: DISPLAY_FONT, fontSize: 20, lineHeight: 1.2, letterSpacing: '-.012em', fontWeight: 600 }, children: form.id ? `Edit ${form.name || 'champion'}` : 'Create a champion' }),
      jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: 'A name, a motto and a short personality and strategy brief. The brief is what plays: the rules are still the game\'s own.' }),
      jsxs('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }, children: [
        jsx(PetSprite, { ctx, pet, state: 'idle', size: 46 }),
        jsxs('div', { style: { minWidth: 0, flex: 1 }, children: [
          jsx('div', { style: { fontSize: 12, color: text.secondary }, children: 'Its body is your Hermes pet.' }),
          jsx('div', { style: { fontSize: 12, color: text.tertiary, lineHeight: 1.45 }, children: pet && pet.enabled
            ? `${pet.displayName || pet.slug} takes this seat: it idles, waves, runs, jumps, fails, reviews and waits while it plays.`
            : 'No pet is installed yet, so a small placeholder figure stands in. Choose or hatch one in Hermes Settings → Appearance → Pet.' })
        ] })
      ] }),
      jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' }, children: [
        field(form.name, value => setForm(current => ({ ...current, name: value })), `Name (max ${data.limits.name})`),
        field(form.motto, value => setForm(current => ({ ...current, motto: value })), `Motto (max ${data.limits.motto})`)
      ] }),
      jsxs('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }, children: [
        jsx('div', { style: { fontSize: 12, color: text.tertiary, width: 54 }, children: 'Colour' }),
        ...(data.colors || []).map(item => jsx('button', {
          type: 'button',
          key: item.id,
          title: item.id,
          'aria-label': `${item.id} colour`,
          'aria-pressed': form.color === item.id,
          onClick: () => setForm(current => ({ ...current, color: item.id })),
          style: {
            width: 26, height: 26, borderRadius: 6, cursor: 'pointer', padding: 0,
            border: `2px solid ${form.color === item.id ? text.primary : 'transparent'}`,
            background: item.hex
          }
        }))
      ] }),
      jsxs('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 }, children: [
        jsx('span', { style: { fontSize: 12, color: text.tertiary }, children: `Personality and strategy brief (max ${data.limits.brief} characters)` }),
        jsx('textarea', {
          value: form.brief,
          rows: 5,
          maxLength: data.limits.brief,
          placeholder: 'How does this champion think? Patient and positional, or a reckless attacker? What does it do when it is behind?',
          onChange: event => setForm(current => ({ ...current, brief: event.target.value })),
          style: {
            width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8,
            border: `1px solid ${stroke}`, background: 'transparent', color: 'inherit',
            fontSize: 12, fontFamily: 'inherit', resize: 'vertical'
          }
        }),
        jsx('span', { style: { fontSize: 12, color: text.tertiary }, children: `${form.brief.length} / ${data.limits.brief}` })
      ] }),
      jsxs('div', { style: { border: `1px solid ${stroke}`, borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }, children: [
        jsx('div', { style: { fontSize: 12, color: text.secondary }, children: `Model route: ${data.brain && data.brain.model ? `this Hermes's own (${data.brain.model})` : "this Hermes's own"}. Pick a different route for this champion, or leave it on this Hermes. Game Center never stores a key.` }),
        // One shared ModelPicker, the same component every other seat uses: a search box,
        // results grouped by provider, recent picks at the top and the current route marked.
        jsx(ModelPicker, {
          routes,
          current: form.model ? `${form.model}|${form.provider}` : '',
          ctx,
          hint: 'Type to filter by provider or model. Up and down move, Enter picks.',
          onPick: route => setForm(current => ({ ...current, model: (route && route.model) || '', provider: (route && route.provider) || '' }))
        }),
        jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: data.model_ready ? 'A model is ready.' : 'No model is configured: you can still create champions and spar with the computer, but champion tournaments wait for a model.' })
      ] }),
      jsxs('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' }, children: [
        button(form.id ? 'Save changes' : 'Create champion', save, { primary: true, disabled: !form.name.trim() || !form.brief.trim() }),
        form.id ? button('Cancel edit', () => setForm(EMPTY_CHAMPION)) : null,
        button('Import a file', pickImport),
        showShare ? button('Hide shared text', () => setShowShare('')) : null
      ] }),
      showShare ? jsx('textarea', {
        value: showShare, readOnly: true, rows: 6,
        onFocus: event => event.target.select(),
        style: { width: '100%', boxSizing: 'border-box', padding: 8, borderRadius: 8, border: `1px solid ${stroke}`, background: fill, color: 'inherit', fontSize: 12, fontFamily: 'var(--font-mono, ui-monospace, monospace)' }
      }) : null,
      jsxs('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' }, children: [
        jsx('textarea', {
          value: pasted, rows: 2, placeholder: 'Or paste a shared champion file here',
          onChange: event => setPasted(event.target.value),
          style: { flex: 1, minWidth: 160, padding: 8, borderRadius: 8, border: `1px solid ${stroke}`, background: 'transparent', color: 'inherit', fontSize: 12, fontFamily: 'inherit' }
        }),
        button('Import pasted', () => importChampion(pasted), { disabled: !pasted.trim() })
      ] })
    ]
  })

  // The Bot Passport grid: the pet's body, the playbook it plays, and the record it earned.
  const badgesFor = id => {
    const row = (data.leaderboard || []).find(item => item.id === id)
    return (row && row.badges) || []
  }
  const cards = champions.length
    ? jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }, children: champions.map(champion => {
        const record = (data.ratings || {})[champion.id] || {}
        return jsx(PassportCard, {
          key: champion.id,
          ctx,
          champion: { ...champion, record },
          badges: badgesFor(champion.id),
          avatars: data.avatars,
          colors: data.colors,
          pet,
          onOpenPlaybook: () => { setEditing(champion.id); setNotice(''); setError('') },
          actions: [
            button(picked.includes(champion.id) ? 'In tournament' : 'Add to tournament', () => toggle(picked, setPicked, champion.id), { disabled: champions.length < 2 }),
            button('Export', () => exportChampion(champion)),
            button('Edit', () => {
              setForm({
                ...EMPTY_CHAMPION,
                ...champion,
                model: (champion.model && champion.model.model) || '',
                provider: (champion.model && champion.model.provider) || ''
              })
              setShowShare('')
            }),
            button('Delete', () => remove(champion))
          ]
        })
      }) })
    : jsx('div', { style: { fontSize: 13, color: text.tertiary, borderRadius: 12, padding: 18, background: card }, children: 'No champions yet. Create one above, then write its playbook: the written brain is the whole game.' })

  // Labs: the experimental corner. A house boss is the person's own model in a
  // champion's seat, named after the model it runs. Nothing is stored, and the
  // whole section is absent until that model is ready. It uses the shared Labs
  // badge so this shelf never grows a second badge style.
  const houseBosses = data.house_bosses || []
  const labs = houseBosses.length
    ? jsxs('section', {
        'aria-label': 'Labs',
        style: { borderRadius: 14, padding: 16, background: card, display: 'flex', flexDirection: 'column', gap: 10 },
        children: [
          jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, children: [
            jsx('div', { style: { fontFamily: DISPLAY_FONT, fontSize: 18, letterSpacing: '-.01em', fontWeight: 600 }, children: 'Labs' }),
            labsBadge()
          ] }),
          jsx('div', { style: { fontSize: 12, color: text.secondary }, children: 'Experimental, and not part of the main shelf. A house boss is a built-in champion named after the open model it runs: it takes a seat through your own provider, so it costs the same model calls as any champion.' }),
          jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }, children: houseBosses.map(boss => {
            const row = boards[boss.id] || {}
            return jsxs('div', {
              key: boss.id,
              style: { borderRadius: 12, padding: 14, background: paper, display: 'flex', flexDirection: 'column', gap: 8 },
              children: [
                jsxs('div', { style: { display: 'flex', gap: 12, alignItems: 'center' }, children: [
                  jsx(PetSprite, { ctx, pet, state: 'idle', size: 48 }),
                  jsxs('div', { style: { minWidth: 0 }, children: [
                    jsx('div', { style: { fontFamily: DISPLAY_FONT, fontSize: 17, letterSpacing: '-.01em', fontWeight: 600 }, children: boss.name }),
                    jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: boss.motto || 'No motto' })
                  ] })
                ] }),
                jsx('div', { style: { fontSize: 12, color: text.secondary }, children: boss.runs || '' }),
                jsx('div', { style: { fontSize: 12, color: text.tertiary, maxHeight: 72, overflow: 'hidden' }, children: boss.brief || '' }),
                jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: text.tertiary }, children: [
                  row.rating ? jsx('span', { children: `Elo ${Math.round(row.rating)}` }) : null,
                  row.title ? jsx('span', { children: row.title }) : null,
                  jsx('span', { children: boss.note || 'Hidden until a model is ready.' })
                ] }),
                jsx('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'auto' }, children: [
                  button(picked.includes(boss.id) ? 'In tournament' : 'Add to tournament', () => toggle(picked, setPicked, boss.id), { disabled: picked.length >= 8 && !picked.includes(boss.id) })
                ] })
              ]
            })
          }) })
        ]
      })
    : null

  const tournament = jsxs('div', {
    style: { borderRadius: 14, padding: 16, background: card, display: 'flex', flexDirection: 'column', gap: 10 },
    children: [
      jsx('div', { style: { fontFamily: DISPLAY_FONT, fontSize: 18, letterSpacing: '-.01em', fontWeight: 600 }, children: 'Tournament' }),
      jsxs('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' }, children: (data.divisions || []).map(item => button(
        item.label, () => { setDivision(item.id); if (item.id === 'prompt') setBots([]) },
        { primary: division === item.id }
      )) }),
      jsx('div', { style: { fontSize: 12, color: text.secondary }, children: divisionInfo.note || '' }),
      jsxs('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap' }, children: [
        jsxs('div', { style: { flex: 1, minWidth: 220 }, children: [
          jsx('div', { style: { fontSize: 12, color: text.tertiary, marginBottom: 4 }, children: `Champions (${picked.length} picked)` }),
          champions.length
            ? jsxs('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' }, children: champions.map(champion => button(
                champion.name, () => toggle(picked, setPicked, champion.id), { primary: picked.includes(champion.id) }
              )) })
            : jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: 'Create two champions to hold a Prompt Division.' })
        ] }),
        jsxs('div', { style: { flex: 1, minWidth: 200 }, children: [
          jsx('div', { style: { fontSize: 12, color: text.tertiary, marginBottom: 4 }, children: 'Sparring partners (built-in computer)' }),
          jsxs('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' }, children: (data.bots || []).map(bot => button(
            bot.name, () => toggle(bots, setBots, bot.level),
            { primary: bots.includes(bot.level), disabled: division === 'prompt' }
          )) })
        ] })
      ] }),
      jsxs('div', { children: [
        jsx('div', { style: { fontSize: 12, color: text.tertiary, marginBottom: 4 }, children: 'Games' }),
        jsxs('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' }, children: (data.games || []).map(game => button(
          game.title, () => toggle(games, setGames, game.id), { primary: games.includes(game.id) }
        )) })
      ] }),
      jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }, children: [
        jsxs('label', { style: { display: 'flex', gap: 4, alignItems: 'center', fontSize: 12, color: text.secondary }, children: [
          'Seed', field(seed, setSeed, '1')
        ] }),
        jsxs('label', { style: { display: 'flex', gap: 4, alignItems: 'center', fontSize: 12, color: text.secondary }, children: [
          'Max games', field(capGames, setCapGames, '40')
        ] }),
        jsxs('label', { style: { display: 'flex', gap: 4, alignItems: 'center', fontSize: 12, color: text.secondary }, children: [
          'Max model calls', field(capCalls, setCapCalls, '240')
        ] })
      ] }),
      jsx('div', { role: 'status', 'aria-live': 'polite', style: { fontSize: 12, color: text.secondary }, children: count < 2
        ? 'Pick at least two entrants.'
        : `${count} entrants · ${estimateGames} games (both colours) · about ${estimateCalls} model calls · roughly ${estimateMinutes} min. Limits: ${data.caps.games} games, ${data.caps.calls} calls.` }),
      jsxs('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' }, children: [
        button('Start tournament', start, { primary: true, disabled: !canStart }),
        run && run.status === 'running' ? button('Stop', () => act('/tournament/stop', { id: run.id })) : null,
        run ? button('Export result file', async () => {
          const answer = await act('/tournament/export', { id: run.id })
          if (answer && answer.ok) {
            if (!saveFile(answer.filename || `${run.id}.tournament.json`, answer.text)) { setShowShare(answer.text); setNotice('Copy this text to share the result.') }
            else setNotice(`Saved ${answer.filename}.`)
          }
        }) : null
      ] })
    ]
  })

  const progress = run ? jsxs('div', {
    style: { borderRadius: 14, padding: 16, background: card, display: 'flex', flexDirection: 'column', gap: 8 },
    children: [
      jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 }, children: [
        jsx('div', { style: { fontWeight: 700 }, children: run.status === 'running' ? 'Running' : run.status === 'done' ? 'Finished' : run.status === 'stopped' ? 'Stopped' : run.status === 'capped' ? 'Stopped at the model call limit' : 'Could not finish' }),
        jsx('div', { style: { fontSize: 12, color: text.secondary }, children: `${run.played || 0} / ${run.total || 0} games` })
      ] }),
      jsx('div', { style: { height: 6, borderRadius: 3, background: fill, overflow: 'hidden' }, children: jsx('div', {
        style: { height: '100%', width: `${run.total ? Math.round(100 * (run.played || 0) / run.total) : 0}%`, background: accent }
      }) }),
      run.current && run.current.game ? jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: `Now: ${nameOf(run.current.white)} vs ${nameOf(run.current.black)} · ${gameTitle(run.current.game)}` }) : null,
      run.error ? jsx('div', { role: 'alert', style: { fontSize: 12, color: text.primary }, children: run.error }) : null,
      (run.results || []).length ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflow: 'auto' }, children: run.results.map((result, index) => jsxs('div', {
        key: index,
        style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: text.secondary },
        children: [
        jsx('span', { style: { flex: 1, minWidth: 0 }, children: `${nameOf(result.white)} vs ${nameOf(result.black)} · ${gameTitle(result.game)} · ${result.winner ? `${nameOf(result[result.winner])} won` : 'draw'}` }),
        button('Watch', () => watch(index))
      ] })) }) : null
    ]
  }) : null

  const replay = watching ? jsxs('div', {
    style: { borderRadius: 14, padding: 16, background: card, display: 'flex', flexDirection: 'column', gap: 8 },
    children: [
      jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }, children: [
        jsx('div', { style: { fontWeight: 700 }, children: `Replay · ${watching.title || watching.game}` }),
        button('Close', () => { setWatching(null); setAuto(false) })
      ] }),
      jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: `${watching.names.white} vs ${watching.names.black} · move ${watching.index} of ${(watching.frames || []).length - 1}` }),
      (() => {
        const frame = (watching.frames || [])[watching.index]
        if (!frame) return jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: 'No frames.' })
        return frame.view === 'arena'
          ? jsx(ArenaStage, { picture: frame, height: 340 })
          : jsx(BoardSvg, { picture: frame, height: 340, interactive: false })
      })(),
      jsxs('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }, children: [
        button('First', () => setWatching(current => current ? { ...current, index: 0 } : current)),
        button('Back', () => setWatching(current => current ? { ...current, index: Math.max(0, current.index - 1) } : current)),
        button('Next', () => setWatching(current => current ? { ...current, index: Math.min((current.frames || []).length - 1, current.index + 1) } : current)),
        button('Last', () => setWatching(current => current ? { ...current, index: (current.frames || []).length - 1 } : current)),
        button(auto ? 'Pause' : 'Play', () => setAuto(value => !value)),
        jsx('input', {
          type: 'range', min: 0, max: Math.max(0, (watching.frames || []).length - 1), value: watching.index,
          'aria-label': 'Replay move',
          onChange: event => setWatching(current => current ? { ...current, index: Number(event.target.value) } : current),
          style: { flex: 1, minWidth: 120 }
        })
      ] }),
      watching.result ? jsx('div', { style: { fontSize: 12, color: text.secondary }, children: watching.result.winner ? `${watching.names[watching.result.winner]} won (${watching.result.status}).` : `The game was ${watching.result.status}.` }) : null
    ]
  }) : null

  const leader = (data.leaderboard || []).length ? jsxs('div', {
    style: { borderRadius: 14, padding: 16, background: card, display: 'flex', flexDirection: 'column', gap: 6 },
    children: [
      jsx('div', { style: { fontFamily: DISPLAY_FONT, fontSize: 18, letterSpacing: '-.01em', fontWeight: 600 }, children: 'Leaderboard' }),
      jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: 'Elo, per game and overall. Only champions and the built-in computer are rated here; people are never rated.' }),
      ...(data.leaderboard || []).map((row, place) => jsxs('div', {
        key: row.id,
        style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, padding: '4px 0', borderTop: place ? `1px solid ${stroke}` : 'none' },
        children: [
        jsx('span', { style: { width: 22, color: text.tertiary }, children: String(place + 1) }),
        jsxs('span', { style: { flex: 1, minWidth: 0, fontWeight: place === 0 ? 700 : 400 }, children: [
          row.name,
          row.title ? jsx('span', { style: { fontSize: 12, color: text.tertiary, fontWeight: 400 }, children: ` · ${row.title}` }) : null
        ] }),
        jsx('span', { style: { ...TABULAR, color: text.secondary }, children: `W${row.wins} L${row.losses} D${row.draws}` }),
        jsx('span', { style: { ...TABULAR, width: 52, textAlign: 'right', color: text.secondary }, children: Math.round(row.rating) })
      ] }))
    ]
  }) : null

  const saved = (data.tournaments || []).length ? jsxs('div', {
    style: { borderRadius: 14, padding: 16, background: card, display: 'flex', flexDirection: 'column', gap: 6 },
    children: [
      jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }, children: [
        jsx('div', { style: { fontFamily: DISPLAY_FONT, fontSize: 18, letterSpacing: '-.01em', fontWeight: 600 }, children: 'Past tournaments' }),
        button('Import a tournament file', pickTournamentFile)
      ] }),
      ...(data.tournaments || []).map(item => jsxs('div', {
        key: item.id, style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: text.secondary },
        children: [
        jsx('span', { style: { flex: 1, minWidth: 0 }, children: `${item.id} · ${item.status} · ${item.played}/${item.total} games` }),
        button('Open', () => openSaved(item.id))
      ] }))
    ]
  }) : null

  const edited = editing ? champions.find(item => item.id === editing) : null
  const openGallery = () => {
    try {
      if (host && typeof host.navigate === 'function') {
        host.navigate('/settings')
        if (alive.current) setNotice('Hermes Settings → Appearance → Pet is where the pet gallery lives. Choose or hatch a pet there.')
        return
      }
    } catch (failure) {
      // A host without navigation still gets the plain instruction below.
    }
    if (alive.current) setNotice('Open Hermes Settings → Appearance → Pet to choose or hatch a pet.')
  }
  const petLine = pet && pet.enabled
    ? jsxs('div', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: text.tertiary, flexWrap: 'wrap' }, children: [
      jsxs('span', { children: [
        'Champion bodies are your Hermes pet: ',
        jsx('strong', { style: { color: text.secondary }, children: pet.displayName || pet.slug }),
        '. It idles, waves, runs, jumps, fails, reviews and waits while it plays.'
      ] }),
      textLink('Choose or hatch a pet', openGallery)
    ] })
    : jsxs('div', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: text.tertiary, flexWrap: 'wrap' }, children: [
      jsx('span', { children: 'No Hermes pet yet, so champions wear a small placeholder figure.' }),
      button('Open pet gallery', openGallery)
    ] })

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 14, padding: 18, minWidth: 0, overflow: 'auto', background: paper },
    children: [
      jsxs('div', { style: { paddingBottom: 10, borderBottom: `1px solid ${stroke}` }, children: [
        jsx('div', { style: { fontFamily: DISPLAY_FONT, fontSize: 28, lineHeight: 1.15, letterSpacing: '-.02em', fontWeight: 600 }, children: 'Champions' }),
        jsx('div', { style: { fontSize: 12, color: text.tertiary, marginTop: 4, maxWidth: 620, lineHeight: 1.5 }, children: 'A champion is a pet\'s body and a written playbook: the questions it asks itself, its tactics, what it notes about a rival, and how it talks. Same model, better brain wins.' }),
        jsx('div', { style: { marginTop: 8 }, children: petLine })
      ] }),
      error ? jsx('div', { role: 'alert', style: { fontSize: 12, color: text.primary, border: `1px solid ${accent}`, borderRadius: 8, padding: '8px 10px' }, children: error }) : null,
      notice ? jsx('div', { role: 'status', style: { fontSize: 12, color: text.secondary }, children: notice }) : null,
      editing && edited ? jsx(PlaybookEditor, {
        key: edited.id,
        ctx,
        champion: edited,
        limits: data.playbook_limits,
        pet,
        onClose: () => setEditing(''),
        onChanged: refresh
      }) : null,
      !editing ? creator : null,
      !editing ? cards : null,
      !editing ? labs : null,
      !editing ? tournament : null,
      !editing ? progress : null,
      !editing ? replay : null,
      !editing ? leader : null,
      !editing ? saved : null
    ]
  })
}
