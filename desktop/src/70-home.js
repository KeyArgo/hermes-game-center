// ---- 70-home.js: the Games page: Play, Experimental Games, the lobby and the tabs
function GameCenterPage({ ctx, onArea }) {
  const [skin, setSkin] = useSkin(ctx)
  const [view, setView] = useState(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState('')
  const [playing, setPlaying] = useState('')
  // Mafia Town: the Labs skin for the mafia table. The card turns it on; opening the
  // game anywhere else puts the classic table back.
  const [town, setTown] = useState(false)
  const [board, setBoard] = useState({ text: '', picture: null })
  const [reply, setReply] = useState('')
  const [move, setMove] = useState('')
  const [chat, setChat] = useState('')
  const [name, setName] = useState('')
  const [hostAddr, setHostAddr] = useState('')
  const [query, setQuery] = useState('')
  const [area, setArea] = useState('games')
  // The route draws Close Game Center itself off the Games screen; it needs to know which screen.
  useEffect(() => { if (typeof onArea === 'function') onArea(area) }, [area])
  // The lobby's short How to play card, opened from the header like the other
  // surfaces' how-to cards.
  const [lobbyHowto, setLobbyHowto] = useState(false)
  // The welcome is shown until it is answered or skipped in this visit. The saved
  // answer lives in /setup, so it is never asked again after that.
  const [welcomeClosed, setWelcomeClosed] = useState(false)
  const selectionGen = useRef(0)
  // Whether the side pane is on the screen, so the header's one button says what its next
  // press does. One read, shared with the status-bar item.
  const paneOn = usePaneOnScreen()

  // Full screen and the pane are one at a time. Arriving here closes the pane and
  // opens the game it was showing, so the handoff lands on the same board.
  useEffect(() => {
    leavePaneForPage()
    if (PAGE_HANDOFF.game) {
      setSelected(PAGE_HANDOFF.game)
      PAGE_HANDOFF.game = ''
    }
  }, [])

  const refresh = useCallback(async () => {
    const genAtStart = selectionGen.current
    try {
      const next = await ctx.rest('/view')
      // A refresh whose /view was already in flight when the person switched
      // games is stale: drop it before it paints anything, so game A's board
      // can never land under game B.
      if (selectionGen.current !== genAtStart) return { ok: true, picture: null }
      setView(next)
      setError('')
      const listed = next.store || (next.games || []).concat(next.more || [])
      const current = selected || (listed[0] && listed[0].id) || ''
      if (current && current !== selected) {
        selectionGen.current++
        setSelected(current)
      }
      const myGen = selectionGen.current
      const card = listed.find(item => item.id === current)
      if (current && card) {
        try {
          const shown = card.installed
            ? await ctx.rest(`/board?game=${encodeURIComponent(current)}`)
            : { text: '', picture: startingPicture(current) }
          // Drop this board if the person selected a different game while it was
          // in flight (selectionGen changes only on pick/open, never per poll),
          // so game A's board never paints under game B and a slow /view+/board
          // cannot starve the next poll out of a render.
          if (selectionGen.current !== myGen) return { ok: true, picture: null }
          const picture = shown.picture || (!shown.text ? startingPicture(current) : null)
          setBoard({ text: shown.text || '', picture, error: '' })
          return { ok: true, picture }
        } catch (failure) {
          if (selectionGen.current !== myGen) return { ok: true, picture: null }
          // While the gateway restarts, keep the last real board of this game on
          // screen; swapping in the blank starting board looks like a lost game.
          // Say so out loud, with a way back, instead of retrying behind a blank board.
          const said = String((failure && failure.message) || 'the game did not answer').slice(0, 140)
          setBoard(prev => (prev.picture && prev.picture.game === current && !prev.picture.preview
            ? { ...prev, error: said }
            : { text: '', picture: startingPicture(current), error: said }))
          return { ok: false, text: failure.message || 'Could not refresh the board.' }
        }
      } else {
        if (selectionGen.current !== myGen) return { ok: true, picture: null }
        setBoard({ text: '', picture: null })
        return { ok: true, picture: null }
      }
    } catch (failure) {
      const detail = failure && (failure.message || failure.status || failure.error)
      setError(
        'Game Center is waiting on the Hermes gateway. hermes-gameshelf is already enabled. Stay on this page — it retries every few seconds. If this lasts more than a minute, command palette → Reload desktop plugins.'
        + (detail ? ` (${String(detail).slice(0, 120)})` : '')
      )
      return { ok: false, text: detail ? String(detail) : 'Could not refresh the table.' }
    }
  }, [ctx, selected])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const send = useCallback(
    async line => {
      try {
        const answer = await ctx.rest('/command', { method: 'POST', body: { line } })
        setReply(answer.text || '')
        // Paint the board the command itself returned, so a move shows the moment the server answers
        // instead of after a second round trip.
        if (answer && answer.picture) setBoard({ text: answer.text || '', picture: answer.picture, error: '' })
        const refreshed = await refresh()
        return { ...answer, ...refreshed, ok: answer.ok !== false && refreshed.ok, text: refreshed.ok ? answer.text || '' : refreshed.text }
      } catch (failure) {
        const message = failure.message || 'That did not reach the Game Center.'
        setReply(message)
        return { ok: false, text: message }
      }
    },
    [ctx, refresh]
  )

  const playMove = useCallback(
    async (gameId, token) => {
      const pictured = board && board.picture
      const needsNew = !pictured || pictured.preview || pictured.status === 'idle' || pictured.status === 'abandoned'
      try {
        if (needsNew) {
          const started = await ctx.rest('/command', { method: 'POST', body: { line: `${gameId} new` } })
          setReply(started.text || '')
        }
        const answer = await ctx.rest('/command', { method: 'POST', body: { line: `${gameId} move ${token}` } })
        setReply(answer.text || '')
        if (answer && answer.picture) setBoard({ text: answer.text || '', picture: answer.picture, error: '' })
        const refreshed = await refresh()
        return { ...answer, ...refreshed, ok: answer.ok !== false && refreshed.ok, text: refreshed.ok ? answer.text || '' : refreshed.text }
      } catch (failure) {
        const message = failure.message || 'That did not reach the Game Center.'
        setReply(message)
        return { ok: false, text: message }
      }
    },
    [ctx, board, refresh]
  )

  if (error) {
    return skinShell(skin, jsx('div', { style: { padding: 16, color: text.secondary }, children: error }))
  }
  if (!view) {
    return skinShell(skin, jsx('div', { style: { padding: 16, color: text.tertiary }, children: 'Loading Game Center…' }))
  }

  const catalog = view.store || (view.games || []).concat(view.more || [])
  const needle = query.trim().toLowerCase()
  const matches = item => !needle || `${item.title} ${item.id} ${item.summary || ''} ${item.plugin || ''}`.toLowerCase().includes(needle)
  // Play is the curated list that ships with the plugin. Experimental Games is everything else the
  // person has installed, so nothing there can be mistaken for a match-ready table.
  // An experiment is never drawn among the Play tiles: the Labs shelf is where it belongs.
  const playList = (view.play || []).filter(matches).filter(item => !item.labs)
  const yourList = (view.your_games || []).filter(matches)
  // Suggestions are catalog pages, not games on this computer, so a search for a game never
  // surfaces them and they never pretend to be installed.
  const suggestions = view.your_suggestions || []
  const makers = view.makers || { note: '', notice: '', items: [] }
  const labsPlay = (view.labs_games || []).filter(matches)
  const playProblems = view.play_problems || []
  const community = view.community || { notice: '', games: [], problems: [] }
  const submit = submitTarget(view.submit)
  const game = catalog.find(item => item.id === selected) || (view.play || [])[0] || catalog[0]
  const lobby = view.lobby || { lines: [], looking: [] }
  const setup = view.setup || {}
  const alerts = view.alerts || { rows: [], count: 0 }
  const online = onlineView(view)
  const current = selected || ((view.play || [])[0] || {}).id || ''
  const waitingCount = id => online.on ? (online.looking[id] || 0) : (lobby.looking || []).filter(row => row.game === id).length

  // First run: one short panel before the games, and never again once answered.
  if (setup.welcome_needed && !welcomeClosed) {
    return skinShell(skin, jsx(WelcomePanel, {
      view,
      ctx,
      onDone: async () => {
        setWelcomeClosed(true)
        setArea('games')
        await refresh()
      }
    }))
  }

  // A card opens its own game screen. Only Play cards and our own launch panels reach here,
  // so a game another plugin brings can never end up at Game Center's table.
  const openTable = id => {
    selectionGen.current++
    setSelected(id)
    setReply('')
    setBoard({ text: '', picture: null })
    setTown(false)
    setPlaying(id)
  }

  // The Jackpot cabinets (JACKPOT v2, 19-jackpot2-layer.js) are not a server game: they are their
  // own screen with the same wallet, so they open straight into Game Center's left column.
  const openJackpot = () => {
    setPlaying(JP2L_ID)
    setReply('')
    setBoard({ text: '', picture: null })
  }

  // Join opens that game's table, which is where seats are taken. It never claims to
  // connect to anyone: this build has no network, and the wording says so.
  const joinAlert = row => {
    const inPlay = (view.play || []).some(item => item.id === row.game)
    if (inPlay) openTable(row.game)
    else if (row && row.game) setReply(`${row.title || row.game} is not at a table here. /games looking ${row.game} in the chat.`)
  }

  // Dismiss hides one row for a while, quietly: no dialog, no sound, no focus change.
  const dismissAlert = async row => {
    if (!row || !row.key) return
    try {
      await ctx.rest('/alerts/dismiss', { method: 'POST', body: { key: row.key } })
    } catch { /* the next refresh reads the truth either way */ }
    await refresh()
  }

  // Experimental games open their own screen, or nothing at all. A card that cannot open says so on
  // itself, and the rest of the page keeps working.
  const openYourGame = async card => {
    if (card.error) return String(card.error)
    if (card.opens === 'screen' && card.desktop_route) {
      try {
        if (!host || typeof host.navigate !== 'function') return 'Game Center cannot open another plugin’s screen here.'
        host.navigate(card.desktop_route)
        return ''
      } catch {
        return `Could not open ${card.title}. Its own screen is not available here.`
      }
    }
    if (card.opens === 'panel' && card.builtin) {
      openTable(card.id)
      return ''
    }
    return `This game has no screen of its own. In chat, /games install ${card.id} adds it, then /games ${card.id} plays it.`
  }

  // Submit your game: the configured page, or the guide when that page is not set.
  const openSubmit = async () => {
    if (!submit.href) return
    try {
      const opened = ctx && ctx.os && typeof ctx.os.openExternal === 'function'
        ? await ctx.os.openExternal(submit.href)
        : false
      if (!opened) setReply(`Could not open ${submit.href} in your browser.`)
    } catch {
      setReply(`Could not open ${submit.href} in your browser.`)
    }
  }

  const staffRole = (view.online && view.online.staff && view.online.staff.role) || ''
  const tabs = jsxs('div', {
    style: { display: 'flex', gap: 6, padding: area === 'champions' ? '12px 18px 0' : '0', background: paper },
    children: [
      button('Games', () => setArea('games'), { primary: area === 'games' }),
      button('Champions', () => setArea('champions'), { primary: area === 'champions' }),
      // The Admin tab appears only for a staff key that works with this account.
      staffRole ? button('Admin', () => setArea('admin'), { primary: area === 'admin' }) : null,
      // The way out, top right of the Games screen, level with the tabs.
      // Other screens get the same button floated top right by GameCenterRoute (80-plugin.js).
      area === 'games' ? jsx('span', { 'data-gc-close-header': '1', style: { marginLeft: 'auto' }, children: closeGameCenterButton(ctx) }) : null
    ]
  })

  if (area === 'admin') {
    return skinShell(skin, jsxs('div', {
      style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: paper },
      children: [jsx('div', { style: { padding: '12px 18px 0' }, children: tabs }), jsx(AdminPage, { ctx, view, onBack: () => setArea('games') })]
    }))
  }

  if (area === 'champions') {
    // Champions is not ready to run matches, so the tab says so plainly instead of opening a
    // page whose buttons would answer with an error. The page stays in the bundle, unreferenced,
    // so bringing it back is one line.
    return skinShell(skin, jsxs('div', {
      style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: paper },
      children: [tabs, jsxs('div', {
        'data-champions-coming-soon': '1',
        style: { padding: '18px 18px 24px', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' },
        children: [
          comingSoon('Champions', 'Build a champion, run it against the other seats and keep its record. Not switched on yet: the matches it needs do not run in this version.'),
          jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: 'Play and Experimental are unaffected.' })
        ]
      })]
    }))
  }

  // Settings: the name, the per-game switches, the pause and the AI choice. It is a
  // side link, not a section of the home page, so nothing there shifts around.
  if (area === 'settings') {
    return jsxs('div', {
      className: 'games-center-shell',
      'data-skin': skin,
      style: { display: 'flex', flexDirection: 'column', gap: 0, height: '100%', minHeight: 0, background: paper },
      children: [
        jsx('style', { children: SKIN_CSS }),
        jsx('div', { style: { padding: '12px 18px 0' }, children: tabs }),
        jsx(SettingsPanel, {
          view,
          ctx,
          skin,
          onSkin: setSkin,
          onBack: next => setArea(next === 'community' ? 'community' : 'games'),
          onCommunity: () => setArea('community'),
          onSaved: refresh,
          onReopen: async () => {
            setWelcomeClosed(false)
            setArea('games')
            // Bring the saved answer in now, so the welcome is what is on screen next
            // rather than a games page that a poll would replace a moment later.
            await refresh()
          }
        })
      ]
    })
  }

  // Community creations is a side link, never part of the Play page: link-out cards only,
  // the same labels and the same disclosure as before.
  if (area === 'community') {
    return jsxs('div', {
      className: 'games-center-shell',
      'data-skin': skin,
      style: { display: 'flex', flexDirection: 'column', gap: 0, height: '100%', minHeight: 0, background: paper, overflow: 'auto', paddingBottom: 96 },
      children: [
        jsx('style', { children: SKIN_CSS }),
        jsx('div', { style: { padding: '12px 18px 0' }, children: tabs }),
        jsxs('div', {
          style: { display: 'flex', flexDirection: 'column', gap: 14, padding: 18, minWidth: 0 },
          children: [
            jsxs('div', {
              style: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'end', flexWrap: 'wrap' },
              children: [
                jsxs('div', {
                  children: [
                    jsx('div', { style: { fontFamily: DISPLAY_FONT, fontSize: 26, lineHeight: 1.15, letterSpacing: '-.02em', fontWeight: 600 }, children: 'Community creations' }),
                    jsx('div', {
                      style: { fontSize: 12, color: text.tertiary, marginTop: 4 },
                      children: 'Games other people made. Game Center only opens the link in your browser.'
                    })
                  ]
                }),
                jsxs('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }, children: [
                  button(submit.label, openSubmit, {
                    primary: true,
                    disabled: !submit.href,
                    title: submit.href || 'Submissions are not open yet.'
                  }),
                  button('Back to Game Center', () => setArea('games'))
                ] })
              ]
            }),
            submit.href
              ? null
              : jsx('div', {
                  role: 'status',
                  style: { fontSize: 12, color: text.secondary },
                  children: 'Submissions are not open yet. The guide is docs/SUBMIT-A-GAME.md in the Game Center folder.'
                }),
            jsx(CommunityShelf, { community, ctx }),
            reply
              ? jsx('div', { role: 'status', 'aria-live': 'polite', style: { fontSize: 12, color: text.secondary }, children: reply })
              : null
          ]
        })
      ]
    })
  }

  const tileGrid = children => jsx('div', {
    // 200 px a card, not 260: the lobby panel gives up half its width on the main screen, and that
    // width buys one more column of game cards.
    style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 200px), 1fr))', gap: 12 },
    children
  })

  // Labs: the experiment shelf. The Make games workshop is its first block; a new experiment is one
  // more entry in this list, with the same element and no new styles. Each block is a real
  // component, so its own state never depends on which other screens have been on this page before.
  const labsBlocks = [
    labsPlay.length
      ? jsx('div', {
          key: 'playable-experiments',
          style: { display: 'contents' },
          children: labsBlock('From the workshop',
            'Drafts you can see now. They open when they are ready; nothing here is rated or in a lobby, and it may change or be removed.',
            tileGrid(labsPlay.map(item => labsPlayCard(item, openTable))))
        })
      : null,
    (makers.items || []).length
      ? jsx(LabsLinks, {
          title: 'Make games',
          note: makers.note || 'Tools for making games, not playing them. Each card opens that tool’s own page.',
          notice: makers.notice,
          items: makers.items,
          ctx
        }, 'make-games')
      : null,
    // Pet Battles is an experiment, so it lives here and not on the Play shelf - and it is locked
    // with the rest of this shelf: visible, no way in.
    jsx('div', {
      key: 'pet-battles-labs',
      style: { minWidth: 0 },
      children: labsBlock(
        'Play a battle',
        'A turn-based 3v3 pet battle with original critters. Pick a type and four moves, then take on the computer.',
        labsLocked(jsx(PetBattlesLabsCard, {}), 'pet-battles')
      )
    }, 'pet-battles-labs'),
    // Mafia Town: the same mafia table with the town square drawn on top. Locked like its neighbours.
    jsx('div', {
      key: 'mafia-town-labs',
      style: { minWidth: 0 },
      children: labsBlock(
        'Play a different table',
        'The Mafia talking table drawn as a town square: night, dawn, speech bubbles, and votes by portrait.',
        labsLocked(jsx(MafiaTownCard, {}), 'mafia-town')
      )
    }, 'mafia-town-labs')
  ].filter(Boolean)

  // One shelf for everything that is not curated Play: the games a plugin installed and the
  // prototypes from the workshop, under a single heading and a single sentence. Two sections
  // both saying "experimental" read as a filing system, not as something to try. The whole shelf -
  // the Coming-soon cards and the Labs blocks - is off the main page and behind ONE small
  // "Experimental" link, where it is kept locked and hidden for later. Nothing of it is drawn on
  // the Play page any more.
  const experiments = jsxs('div', {
    'data-experiments': '1',
    style: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 },
    children: [
      heading('Experimental'),
      // The one short line under the heading: the shelf is a window.
      jsx('div', { 'data-experimental-help': '1', style: { fontSize: 13, color: text.secondary, marginBottom: 2, maxWidth: 620 }, children: LABS_LOCK_HELP }),
      jsx('div', { 'data-experiments-note': '1', style: { fontSize: 12, color: text.tertiary, marginBottom: 2, maxWidth: 620 }, children: EXPERIMENTS_NOTE }),
      yourList.length
        ? tileGrid(yourList.map(item => jsx(YourGameCard, { item, onOpen: openYourGame }, item.id)))
        : jsx('div', { style: { fontSize: 13, color: text.tertiary }, children: 'Nothing installed yet. A game another plugin ships lands here the moment the plugin is on.' }),
      // The workshop blocks keep their own titles; the shelf heading above covers the section.
      labsShelf(labsBlocks, undefined, { withHeading: false }),
      suggestionRow(suggestions, ctx)
    ]
  })

  // The one small link's destination. It is the shelf above, drawn on its own screen so the Play
  // page stays clean; every card in it is still locked, so the screen is a window, not a door.
  if (area === 'experimental') {
    return jsxs('div', {
      className: 'games-center-shell',
      'data-skin': skin,
      style: { display: 'flex', flexDirection: 'column', gap: 0, height: '100%', minHeight: 0, background: paper, overflow: 'auto', paddingBottom: 96 },
      children: [
        jsx('style', { children: SKIN_CSS }),
        jsx('div', { style: { padding: '12px 18px 0' }, children: tabs }),
        jsxs('div', {
          style: { display: 'flex', flexDirection: 'column', gap: 14, padding: 18, minWidth: 0 },
          children: [
            jsxs('div', {
              style: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
              children: [
                jsx('div', {
                  style: { fontSize: 12, color: text.tertiary },
                  children: 'Kept here for a look, off the Play page. Nothing in it opens yet.'
                }),
                button('Back to Game Center', () => setArea('games'))
              ]
            }),
            experiments
          ]
        })
      ]
    })
  }

  const store = jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 18, padding: 18, paddingBottom: 96, minWidth: 0, overflow: 'auto', background: paper },
    children: [
      tabs,
      jsxs('div', {
        style: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'end', flexWrap: 'wrap' },
        children: [
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 },
            children: [
              jsx(GameCenterMark, { size: 48 }),
              jsxs('div', {
                children: [
                  // The install in view, at the TOP of the Games screen beside the wordmark: small and
                  // muted, one source (/v1/version), the same component Settings mounts.
                  jsxs('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', minWidth: 0 }, children: [
                    jsx(GameCenterWordmark, {}),
                    jsx('span', {
                      'data-games-version-header': '1',
                      children: jsx(GamesVersionChip, {
                        ctx,
                        style: { fontSize: 10, padding: '1px 6px', opacity: 0.8, letterSpacing: '0.02em' }
                      })
                    })
                  ] }),
                  jsx('div', {
                    style: { fontSize: 12, color: text.tertiary, marginTop: 4 },
                    children: view.player.named ? `You are ${view.player.name}` : 'Pick a name in Settings to chat'
                  }),
                  jsx('div', {
                    style: { marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
                    children: [
                      jsx(PointsChip, { ctx }),
                      // The obvious door: one press opens the side pane and keeps a game beside
                      // the chat while Hermes works. While the pane is open the same button reads
                      // Close side pane.
                      // From full screen the door LEAVES Game Center: back to the chat with the
                      // pane on the right, on the same game.
                      paneDoorButtonElement(paneOn, null, () => paneFromPage(ctx, selected))
                    ]
                  })
                ]
              })
            ]
          }),
          jsxs('div', { style: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }, children: [
            jsx('div', { style: { width: 220 }, children: field(query, setQuery, 'Search games', () => {}) }),
            // The clear way back: one link, back under the chat, wherever this page was left.
            textLink('Back to chat', () => closeGameCenter(ctx)),
            textLink('How to play', () => setLobbyHowto(true)),
            // One small link, and the only trace of the experiments on this page: the Coming-soon
            // cards and the Labs shelf live behind it.
            textLink('Experimental', () => setArea('experimental')),
            textLink('Settings', () => setArea('settings')),
            textLink('Community creations', () => setArea('community'))
          ] })
        ]
      }),
      // The way out to the project itself: one row of three links, settled
      // right under the header beside Experimental / Settings / Community creations, each handed to
      // the person's own browser by the same door the Submit button uses.
      jsx(GameCenterLinks, { ctx, onNote: setReply }),
      // No alert drops anywhere for now. The rows are still read from
      // /alerts and the component is still in the bundle, so bringing it back is this one line.
      null,
      // Find match lives in the lobby panel now, where it can see the lobby's own answer:
      // the stand-alone bar here used to press with whatever game happened to be selected,
      // which is how it could say it was looking for blackjack.
      jsx(LobbyWhoOnline, {
        view, ctx, current,
        // "Play here" on a Hall row: the lobby server took the room, so open that game's table,
        // which draws the server's picture instead of a local game.
        onPlayHere: match => openTable((match && match.game) || current)
      }),
      view.notice ? jsx('div', {
        role: 'status', 'aria-live': 'polite',
        style: { padding: '10px 12px', borderRadius: 8, border: `1px solid ${accent}`, fontSize: 13, color: text.primary, background: card },
        children: view.notice
      }) : null,
      playProblems.length
        ? jsx('div', { role: 'status', style: { fontSize: 12, color: text.secondary }, children: playProblems.join(' ') })
        : null,
      jsxs('div', {
        children: [
          heading('Play'),
          jsx('div', { style: { fontSize: 12, color: text.tertiary, marginBottom: 8 }, children: PLAY_NOTE }),
          playList.length
            ? tileGrid(jp2LPlayTiles(playList, openTable, waitingCount, openJackpot, matches))
            : jsx('div', { style: { fontSize: 13, color: text.tertiary }, children: 'No curated games to show.' })
        ]
      }),
      jsx(LobbyLadder, { view, current }),
      null
    ]
  })
  const right = jsx(LobbyChatColumn, {
    view, ctx, send, chat, setChat, name, setName, current,
    // "Play here" on the match card: the lobby server has taken the room, so open that game's
    // table, which draws the server's own picture instead of a local game.
    onPlayHere: match => openTable((match && match.game) || current)
  })

  return jsx('div', {
    className: 'games-center-shell',
    'data-skin': skin,
    style: { height: '100%', minHeight: 0, minWidth: 0, containerType: 'inline-size' },
    children: jsx('div', {
    className: 'games-center-layout',
    style: {
      display: 'grid',
      gridTemplateColumns: playing ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) minmax(110px, 140px)',
      height: '100%',
      minHeight: 0,
      background: paper,
      isolation: 'isolate',
      position: 'relative',
      zIndex: 1
    },
    children: [
      jsx('style', { children: `
        .games-center-layout { container-type: inline-size; }
        .games-play-table { box-sizing: border-box; }
        .games-play-table button:focus-visible, .games-play-table select:focus-visible { outline: 2px solid var(--ui-accent, #7ec8ff); outline-offset: 3px; }
        .games-board-panel > .games-board-stage, .doctrine-board-panel > .games-board-stage { min-width: 0; flex-shrink: 0; }
        .games-seabattle-boards { min-width: 0; }
        @container (max-width: 880px) {
          .games-seabattle-boards { flex-direction: column !important; align-items: center !important; }
        }
        @container (max-width: 520px) { .games-seats { grid-template-columns: minmax(0, 1fr) !important; } }
        @container (max-width: 820px) {
          .games-center-layout { grid-template-columns: minmax(0, 1fr) !important; grid-auto-rows: max-content; overflow: auto; }
          .games-center-layout > .games-play-table { height: auto !important; overflow: visible !important; padding: 14px !important; }
          .games-center-lobby { min-width: 0 !important; border-left: 0 !important; border-top: 1px solid var(--ui-stroke-secondary); max-height: 260px; }
        }
        @media (max-width: 900px) {
          .games-center-layout { grid-template-columns: minmax(0, 1fr) !important; grid-auto-rows: max-content; overflow: auto; }
          .games-center-layout > .games-play-table { height: auto !important; overflow: visible !important; padding: 14px !important; }
          .games-center-lobby { min-width: 0 !important; border-left: 0 !important; border-top: 1px solid var(--ui-stroke-secondary); max-height: 260px; }
        }
        @media (prefers-reduced-motion: reduce) { .games-play-table * { animation: none !important; transition: none !important; } }
      ` + SKIN_CSS }),
      playing && board.error
        ? jsxs('div', {
            role: 'alert',
            'data-games-board-error': playing,
            style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 12px', borderRadius: 10, border: `1px solid ${stroke}`, background: card, color: text.secondary, fontSize: 13 },
            children: [
              jsx('span', { children: `This game could not load (${board.error}). Retrying every few seconds.` }),
              button('Back to games', () => setPlaying(''))
            ]
          })
        : null,
      // JACKPOT v2 first: it is not a server game, so it never asks the shelf for a board — it is
      // the machine itself, at the size this column allows, and nothing of it is clipped.
      playing === JP2L_ID || playing === 'slots'
        ? jsx(Jackpot2Full, { ctx, onBack: () => setPlaying('') })
        : playing && game && game.id === playing
        ? game.id === 'doctrine'
          ? jsx(DoctrinePanel, {
              game,
              view,
              board,
              send,
              playMove,
              importText: async text => {
                const answer = await ctx.rest('/doctrine/import', { method: 'POST', body: { text } })
                return answer
              },
              refresh,
              ctx,
              onBack: () => setPlaying('')
            })
          : game.id === ARENA_ID
            ? jsx(ArenaPanel, { game, view, board, send, ctx, onBack: () => setPlaying('') })
            : game.id === PETB_ID
              ? jsx(PetBattlePanel, {
                  game,
                  view,
                  board,
                  send,
                  ctx,
                  onBack: () => setPlaying('')
                })
              : game.id === 'mafia' && town
              ? jsx(MafiaTown, {
                  game,
                  view,
                  board,
                  send,
                  ctx,
                  onBack: () => setPlaying(''),
                  onClassic: () => setTown(false)
                })
              : TALKING_IDS.includes(game.id)
              ? jsx(TalkingTable, {
                  game,
                  view,
                  board,
                  send,
                  refresh,
                  ctx,
                  onBack: () => setPlaying('')
                })
              : (game.kind || 'table') === 'table'
              ? jsx(PlayTable, {
                  game,
                  view,
                  board,
                  playMove,
                  send,
                  ctx,
                  onBack: () => setPlaying('')
                })
              : jsx(LaunchPanel, { game, view, board, send, ctx, onBack: () => setPlaying('') })
        : store,
      playing ? null : right,
      playing || !lobbyHowto ? null : jsx(LobbyHowTo, { onClose: () => setLobbyHowto(false) })
    ]
    })
  })
}
