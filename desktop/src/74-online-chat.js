// ---- 74-online-chat.js: the table's chat, as the one panel the online table draws
//
// Split out of 73-online-table.js so neither part grows past what a reader can hold. The table owns
// the state (the box's words, the send in flight, the refusal) and this part draws it.
//
// It is a plain function rather than a component, and that is deliberate: the panel is drawn inside
// OnlineTable's own tree, so the list, the box and the refusal are one set of elements — the same
// elements the UI harness walks to read the screen's words.
const ONLINE_CHAT_KEEP = 50

// Who said it, in the website's words: players and the host plainest, a watcher named as one.
function onlineChatRole(role) {
  return role === 'host' ? ' (host)' : role === 'player' ? '' : ' (watching)'
}

// One line of the server's own chat: who said it, and what they said.
function onlineChatLine(message, index) {
  const line = message && typeof message === 'object' ? message : {}
  const who = String(line.name || 'Someone')
  const tag = onlineChatRole(String(line.role || ''))
  return jsxs('div', {
    key: String(line.id != null ? line.id : index),
    'data-chat-line': '1',
    style: { fontSize: 12, lineHeight: 1.4, minWidth: 0, overflowWrap: 'anywhere', color: text.secondary },
    children: [
      jsx('b', { style: { color: text.primary }, children: tag ? `${who}${tag}` : who }),
      jsx('span', { children: `: ${String(line.text || '')}` })
    ]
  })
}

// The panel: the server's list, a box capped where the server caps, and Send. It sits beside the
// board on a wide page and under it on a narrow one, and it scrolls to the newest line.
function onlineChatPanel({ lines, draft, problem, canType, sending, log, onDraft, onSend }) {
  return jsxs('section', {
    className: 'games-online-chat',
    'aria-label': 'Table chat',
    'data-online-chat': '1',
    style: { display: 'flex', flexDirection: 'column', gap: 8, flex: '1 1 260px', minWidth: 220, maxWidth: 380, minHeight: 220, padding: 10, border: `1px solid ${stroke}`, borderRadius: 12, background: card },
    children: [
      jsx('div', {
        title: `Everyone at this table — players, the host and watchers — shares this chat. The server keeps the last ${ONLINE_CHAT_KEEP} messages.`,
        style: { fontSize: 13, fontWeight: 700 },
        children: 'Table chat'
      }),
      jsx('div', {
        className: 'games-online-chat-log', 'data-chat-list': '1', role: 'log', 'aria-live': 'polite',
        ref: log,
        style: { display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minHeight: 120, maxHeight: '40vh', overflowY: 'auto', paddingRight: 4 },
        children: lines.length
          ? lines.map(onlineChatLine)
          : jsx('span', { style: { fontSize: 12, color: text.tertiary, fontStyle: 'italic' }, children: 'Say hi. Players and watchers share this chat.' })
      }),
      jsxs('div', { style: { display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }, children: [
        jsx('input', {
          className: 'games-online-chat-input', 'data-chat-input': '1',
          value: draft, maxLength: 300, placeholder: 'Message',
          'aria-label': 'Chat message',
          title: 'Up to 300 characters, like the website. Enter sends; Send does the same.',
          disabled: !canType,
          onChange: event => onDraft(event.target.value),
          onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); onSend() } },
          style: { flex: 1, minWidth: 0, padding: '7px 10px', borderRadius: 8, border: `1px solid ${stroke}`, background: 'transparent', color: 'inherit', fontSize: 12 }
        }),
        button('Send', onSend, {
          primary: true, disabled: !canType || sending || !draft.trim(),
          title: 'Sends your message to everyone at this table. It appears once the table has taken it.'
        })
      ] }),
      problem ? jsx('div', { role: 'alert', style: { fontSize: 12, border: '1px solid #d76b65', borderRadius: 8, padding: '6px 8px' }, children: problem }) : null
    ]
  })
}
