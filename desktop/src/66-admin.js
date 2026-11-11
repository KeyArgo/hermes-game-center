// ---- 66-admin.js: the Admin tab — roles, reports, lookups and the audit log
// The tab exists only when the lobby says this account is staff (view.online.staff.role).
// Every button is one POST to /online/admin/action; the lobby re-checks both the
// account key and the staff key on every call, so this page can only offer what
// the person may already do.

const ADMIN_ROLE_LABEL = { owner: 'Owner', admin: 'Admin', moderator: 'Moderator' }
const ADMIN_REASONS = ['Spam', 'Abuse or threats', 'Impersonation', 'Something else']

function adminRoleBadge(role) {
  if (!role) return null
  return jsx('span', {
    style: {
      fontSize: 11, color: role === 'owner' ? '#d6a23a' : role === 'admin' ? accent : '#5cc28a',
      border: `1px solid ${role === 'owner' ? '#d6a23a' : role === 'admin' ? accent : '#5cc28a'}`,
      borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap'
    },
    children: ADMIN_ROLE_LABEL[role] || role
  })
}

function adminWhen(seconds) {
  if (!seconds) return ''
  const date = new Date(seconds * 1000)
  const now = new Date()
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString()
}

function adminUntil(until) {
  if (!until) return 'permanently'
  return 'until ' + new Date(until * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function adminCan(role, what) {
  const rank = { owner: 3, admin: 2, moderator: 1 }[role] || 0
  if (what === 'permanent' || what === 'rename' || what === 'bots' || what === 'table' || what === 'team') return rank >= 2
  if (what === 'appoint-admin') return rank >= 3
  return rank >= 1
}

function adminRow(children, key) {
  return jsx('div', { key, style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }, children })
}

function adminCard(children, key) {
  return jsx('div', {
    key,
    style: {
      display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 10,
      border: `1px solid ${stroke}`, background: card, minWidth: 0
    },
    children
  })
}

function adminMuted(label) {
  return jsx('div', { style: { fontSize: 12, color: text.tertiary, lineHeight: 1.45 }, children: label })
}

function AdminPage({ ctx, view, onBack }) {
  const online = view.online || {}
  const staff = online.staff || { role: '', name: '', powers: [] }
  const [where, setWhere] = useState('reports')
  const [reason, setReason] = useState('')
  const [key, setKey] = useState('')
  const [flash, setFlash] = useState('')
  const [issued, setIssued] = useState(null)
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(0)
  const [overview, setOverview] = useState(null)
  const [reports, setReports] = useState(null)
  const [audit, setAudit] = useState(null)
  const [found, setFound] = useState(null)
  const [query, setQuery] = useState('')
  const [newName, setNewName] = useState('')
  const [problem, setProblem] = useState('')
  const role = staff.role

  const load = useCallback(async () => {
    if (!role) return
    setProblem('')
    try {
      const [counts, queue, history] = await Promise.all([
        ctx.rest('/online/admin/overview'),
        ctx.rest('/online/admin/reports?state=open'),
        ctx.rest('/online/admin/audit?limit=80')
      ])
      setOverview(counts && counts.ok ? counts : null)
      setReports(queue && queue.ok ? (queue.reports || []) : [])
      setAudit(history && history.ok ? (history.entries || []) : [])
    } catch (failure) {
      setProblem((failure && failure.message) || 'The lobby could not be reached.')
    }
  }, [ctx, role])

  useEffect(() => { load() }, [load, version])
  useEffect(() => {
    if (where === 'audit' || where === 'team') load()
  }, [where, load])

  const run = useCallback(async payload => {
    setBusy(true)
    setFlash('')
    try {
      const answer = await ctx.rest('/online/admin/action', {
        method: 'POST',
        body: { ...payload, reason }
      })
      setFlash((answer && (answer.text || (answer.ok ? 'Done.' : 'That was refused.'))) || 'Done.')
      if (answer && answer.ok && answer.staff_key) {
        setIssued({ name: answer.staff_name || payload.target || '', role: answer.staff_role || payload.role || '', key: answer.staff_key })
      }
      if (answer && answer.ok) { setVersion(value => value + 1); setReason('') }
      return answer
    } catch (failure) {
      setFlash((failure && failure.message) || 'That did not go through.')
      return null
    } finally { setBusy(false) }
  }, [ctx, reason])

  const useKey = async () => {
    setBusy(true); setProblem(''); setFlash('')
    try {
      const answer = await ctx.rest('/online/staff', { method: 'POST', body: { key: key.trim() } })
      if (answer && answer.ok) { setFlash(answer.text || 'Staff key saved.'); setKey('') }
      else setProblem((answer && answer.text) || 'That staff key does not work with this account.')
    } catch (failure) {
      setProblem((failure && failure.message) || 'That staff key does not work with this account.')
    } finally { setBusy(false) }
  }

  const lookUp = async () => {
    if (!query.trim()) return
    setProblem(''); setFound(null)
    try {
      const answer = await ctx.rest('/online/admin/user?name=' + encodeURIComponent(query.trim()))
      if (answer && answer.ok && answer.player) setFound(answer.player)
      else setProblem((answer && (answer.text || answer.error)) || 'No such name.')
    } catch (failure) { setProblem((failure && failure.message) || 'That lookup failed.') }
  }

  if (!role) {
    return jsxs('div', {
      style: { display: 'flex', flexDirection: 'column', gap: 12, padding: 18, maxWidth: 560 },
      children: [
        adminRow([jsx('div', { style: { fontSize: 20, fontWeight: 700 }, children: 'Admin' }), labsBadge()]),
        adminMuted('Staff only. Paste the staff key an owner or admin gave you. It is checked against the name you play as, and kept in Hermes\u2019s credentials on this computer.'),
        adminRow([field(key, setKey, 'Staff key', useKey, { label: 'Staff key' }), button('Use it', useKey, { primary: true, disabled: busy || !key.trim() })]),
        problem ? jsx('div', { style: { fontSize: 12, color: '#e2726c' }, children: problem }) : null,
        flash ? jsx('div', { style: { fontSize: 12, color: text.secondary }, children: flash }) : null,
        textLink('Back to the Game Center', onBack)
      ]
    })
  }

  const places = [['reports', 'Reports'], ['lookup', 'Look up'], ['audit', 'Audit log'], ['team', 'Team']]
  const reportCards = (reports || []).map(row => adminCard([
    jsxs('div', {
      style: { display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
      children: [
        jsx('b', { style: { fontSize: 13 }, children: `${row.kind === 'message' ? 'Message' : row.kind === 'bot' ? 'Bot' : 'Name'} \u00b7 ${row.target_name || 'unknown'}` }),
        jsx('span', { style: { fontSize: 11, color: text.tertiary }, children: adminWhen(row.at) })
      ]
    }),
    row.text ? jsx('div', {
      style: { fontSize: 12, color: text.secondary, borderLeft: `3px solid ${stroke}`, padding: '6px 9px', background: fill, borderRadius: 6, overflowWrap: 'anywhere' },
      children: row.text
    }) : null,
    adminMuted(`Reported by ${row.reporter_name}${row.reason ? ' \u00b7 ' + row.reason : ''}${row.room_id ? ' \u00b7 ' + (row.room_id === '__lobby__' ? 'the lobby' : 'table ' + row.room_id) : ''}`),
    adminRow([
      row.kind === 'message' ? button('Delete message', () => run({ action: 'delete-message', message_id: row.message_id, room_id: row.room_id, target_id: row.target_id }), { disabled: busy }) : null,
      button('Silence 1h', () => run({ action: 'silence', target_id: row.target_id, minutes: 60 }), { disabled: busy }),
      button('Suspend 7 days', () => run({ action: 'suspend', target_id: row.target_id, minutes: 10080 }), { disabled: busy }),
      button('Nothing wrong', () => run({ action: 'close-report', report_id: row.id, resolution: 'Nothing wrong.' }), { disabled: busy })
    ])
  ], row.id))

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 12, padding: 18, overflow: 'auto', minHeight: 0, background: paper },
    children: [
      jsxs('div', {
        style: { display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
        children: [
          adminRow([
            jsx('div', { style: { fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }, children: 'Admin' }),
            adminRoleBadge(role), labsBadge()
          ]),
          textLink('Back to the Game Center', onBack)
        ]
      }),
      adminRow([
        jsx('div', { style: { fontSize: 12, color: text.tertiary }, children: 'Reason (kept in the audit log)' }),
        field(reason, setReason, 'e.g. spam in lobby chat', () => {}, { label: 'Reason for this action' })
      ]),
      adminRow([
        ...places.map(([id, label]) => button(label, () => (id === where ? setVersion(value => value + 1) : setWhere(id)), { primary: where === id })),
        // New reports arrive while a moderator is looking at the queue, so this
        // panel stays put until someone asks for the latest: one click, no typing.
        button('Refresh', () => setVersion(value => value + 1), { disabled: busy })
      ]),
      flash ? jsx('div', { style: { fontSize: 12, color: text.secondary, border: `1px solid ${accent}`, borderRadius: 8, padding: '8px 10px' }, children: flash }) : null,
      issued ? jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 6, border: `1px solid ${accent}`, borderRadius: 8, padding: 10 },
        children: [
          jsx('b', { style: { fontSize: 13 }, children: `${issued.name} is ${ADMIN_ROLE_LABEL[issued.role] || issued.role}. Give them this staff key out of band:` }),
          pre(issued.key),
          adminMuted('They sign in as their own name, then paste it in Admin. It is shown once and cannot be read back.'),
          textLink('I have copied it', () => setIssued(null))
        ]
      }) : null,
      problem ? jsx('div', { style: { fontSize: 12, color: '#e2726c', border: '1px solid #e2726c', borderRadius: 8, padding: '8px 10px' }, children: problem }) : null,

      where === 'reports' ? jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 },
        children: [
          reportCards.length ? reportCards : adminMuted('Nothing to look at. Nice.')
        ]
      }) : null,

      where === 'lookup' ? jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 },
        children: [
          adminRow([
            field(query, setQuery, 'Name, exactly as they play', lookUp, { label: 'Name to look up' }),
            button('Look up', lookUp, { primary: true, disabled: !query.trim() })
          ]),
          !found ? adminMuted('Search a person or a bot to see their record, reports and past actions.') : adminCard([
            adminRow([
              jsx('div', { style: { fontSize: 17, fontWeight: 700 }, children: found.name }),
              found.bot ? badge('BOT') : null,
              adminRoleBadge(found.staff_role)
            ]),
            adminMuted(`${found.games} games \u00b7 ${found.wins}W ${found.losses}L ${found.draws}D \u00b7 ${found.reports_against} reports (${found.open_reports} open) \u00b7 joined ${adminWhen(found.joined)}${found.owner ? ' \u00b7 owner ' + found.owner : ''}`),
            found.silenced_until !== 0 ? adminMuted('Silenced ' + adminUntil(found.silenced_until)) : null,
            found.suspended_until !== 0 ? adminMuted('Suspended ' + adminUntil(found.suspended_until)) : null,
            heading('Silence (they can still play)'),
            adminRow([
              button('10 min', () => run({ action: 'silence', target_id: found.id, minutes: 10 }), { disabled: busy }),
              button('1 hour', () => run({ action: 'silence', target_id: found.id, minutes: 60 }), { disabled: busy }),
              button('24 hours', () => run({ action: 'silence', target_id: found.id, minutes: 1440 }), { disabled: busy }),
              adminCan(role, 'permanent') ? button('Forever', () => run({ action: 'silence', target_id: found.id, minutes: 0 }), { disabled: busy }) : null,
              button('Lift silence', () => run({ action: 'unsilence', target_id: found.id }), { disabled: busy })
            ]),
            heading('Suspend or ban (blocks sign-in, queue and the ladder)'),
            adminRow([
              button('1 hour', () => run({ action: 'suspend', target_id: found.id, minutes: 60 }), { disabled: busy }),
              button('1 day', () => run({ action: 'suspend', target_id: found.id, minutes: 1440 }), { disabled: busy }),
              button('7 days', () => run({ action: 'suspend', target_id: found.id, minutes: 10080 }), { disabled: busy }),
              adminCan(role, 'permanent') ? button('Permanent ban', () => run({ action: 'suspend', target_id: found.id, minutes: 0 }), { disabled: busy }) : null,
              button('Lift suspension', () => run({ action: 'unsuspend', target_id: found.id }), { disabled: busy })
            ]),
            adminCan(role, 'rename') ? adminRow([
              field(newName, setNewName, 'New name', () => { if (newName.trim()) run({ action: 'force-rename', target_id: found.id, name: newName.trim() }) }, { label: 'New name' }),
              button('Force rename', () => { if (newName.trim()) run({ action: 'force-rename', target_id: found.id, name: newName.trim() }) }, { disabled: busy || !newName.trim() })
            ]) : null,
            adminCan(role, 'bots') && found.bot ? adminRow([
              button('Remove bot from the ladder', () => run({ action: 'bot-remove', target_id: found.id }), { disabled: busy }),
              button('Reset its record', () => run({ action: 'bot-reset', target_id: found.id }), { disabled: busy })
            ]) : null,
            adminCan(role, 'team') ? adminRow([
              button('Make moderator', () => run({ action: 'appoint', target_id: found.id, role: 'moderator' }), { disabled: busy }),
              adminCan(role, 'appoint-admin') ? button('Make admin', () => run({ action: 'appoint', target_id: found.id, role: 'admin' }), { disabled: busy }) : null,
              found.staff_role && found.staff_role !== 'owner' ? button('Remove role', () => run({ action: 'revoke', target_id: found.id }), { disabled: busy }) : null
            ]) : null,
            found.actions && found.actions.length ? jsxs('div', {
              style: { display: 'flex', flexDirection: 'column', gap: 4 },
              children: [
                heading('Past actions'),
                ...found.actions.slice(0, 8).map(row => adminMuted(`${adminWhen(row.at)} \u00b7 ${row.actor_name} (${row.actor_role}) \u00b7 ${row.action}${row.reason ? ' \u00b7 ' + row.reason : ''}${row.undone ? ' \u00b7 undone' : ''}`))
              ]
            }) : null
          ])
        ]
      }) : null,

      where === 'audit' ? jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
        children: [
          !audit ? adminMuted('Loading the audit log\u2026') : !audit.length ? adminMuted('No staff actions yet.') :
            audit.map(row => jsxs('div', {
              key: row.id,
              style: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', fontSize: 12, color: row.undone ? text.tertiary : text.secondary, borderBottom: `1px solid ${stroke}`, padding: '5px 0', flexWrap: 'wrap' },
              children: [
                jsx('span', { children: `${adminWhen(row.at)} \u00b7 ${row.actor_name} (${row.actor_role}) \u00b7 ${row.action}${row.target_name ? ' \u2192 ' + row.target_name : ''}${row.reason ? ' \u00b7 ' + row.reason : ''}${row.undone ? ' \u00b7 undone' : ''}` }),
                !row.undone && !row.undo_of && adminCan(role, 'permanent')
                  ? textLink('Undo', () => run({ action: 'undo', audit_id: row.id }))
                  : null
              ]
            }))
        ]
      }) : null,

      where === 'team' ? jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 },
        children: [
          adminRow([
            badge(`${(overview && overview.players) || 0} people`),
            badge(`${(overview && overview.reports_open) || 0} open reports`),
            badge(`${(overview && overview.suspended) || 0} suspended`),
            badge(`${(overview && overview.silenced) || 0} silenced`)
          ]),
          adminCard([
            heading('Staff'),
            ...(((overview && overview.staff) || []).map(row => adminRow([
              jsx('b', { style: { fontSize: 13 }, children: row.name }), adminRoleBadge(row.role)
            ], row.name))),
            !((overview && overview.staff) || []).length ? adminMuted('No staff yet. The owner is made on the server: python -m online.admin grant-owner <name>.') : null
          ]),
          !adminCan(role, 'team') ? adminMuted('Only an owner or an admin appoints moderators. Only the owner appoints admins.') : adminCard([
            heading('Appoint by name'),
            adminRow([
              field(query, setQuery, 'Name on the lobby', () => {}, { label: 'Name to appoint' }),
              button('Make moderator', () => run({ action: 'appoint', target: query.trim(), role: 'moderator' }), { disabled: busy || !query.trim() }),
              adminCan(role, 'appoint-admin') ? button('Make admin', () => run({ action: 'appoint', target: query.trim(), role: 'admin' }), { disabled: busy || !query.trim() }) : null
            ]),
            adminMuted('The staff key is returned once, in the answer below. Give it to that person out of band: it never goes in chat.')
          ]),
          adminCard([
            heading('This computer'),
            adminMuted('The staff key lives in Hermes\u2019s credentials. Forgetting it here does not change the role on the lobby.'),
            textLink('Forget the staff key here', async () => {
              try {
                const answer = await ctx.rest('/online/staff/clear', { method: 'POST', body: {} })
                setFlash((answer && answer.text) || 'Staff key forgotten.')
              } catch { setFlash('Could not forget the key here.') }
            })
          ])
        ]
      }) : null
    ]
  })
}
