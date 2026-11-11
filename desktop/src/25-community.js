// ---- 25-community.js: the community shelf: link-out cards only
// The Community shelf: games other people made and host on their own sites. Game Center only
// hands the address to the system browser on Open. It never frames, fetches or loads these
// pages, so nothing from a community site runs inside Hermes.
const COMMUNITY_LINE = 'Made by the community; opens in your browser'
// Two cards are not a web game: a download page and a watch-only page. The card says which in one
// word, so nobody presses Open expecting to play in the browser.
const COMMUNITY_KINDS = {
  web: { badge: 'Web page', line: COMMUNITY_LINE, action: 'Open' },
  download: {
    badge: 'Download',
    line: 'Made by the community; opens its download page in your browser',
    action: 'Download page'
  },
  watch: {
    badge: 'Watch demo',
    line: 'Made by the community; opens a watch-only page in your browser',
    action: 'Open page'
  }
}

function communityCard(item, ctx, setReply) {
  const open = async () => {
    const url = String(item.url || '')
    if (!/^https:\/\//i.test(url)) {
      setReply('That community link is not a web address Game Center can open.')
      return
    }
    try {
      const opened = ctx && ctx.os && typeof ctx.os.openExternal === 'function'
        ? await ctx.os.openExternal(url)
        : false
      if (!opened) setReply(`Could not open ${url} in your browser.`)
    } catch {
      setReply(`Could not open ${url} in your browser.`)
    }
  }
  const kind = COMMUNITY_KINDS[item.kind] || null
  return jsxs('div', {
    'data-community-card': item.id,
    style: { display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 6, border: `1px solid ${stroke}`, borderRadius: 16, padding: 16, background: card, minWidth: 0 },
    children: [
      jsxs('div', { style: { minWidth: 0 }, children: [
        jsxs('div', {
          style: { display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' },
          children: [
            jsx('div', { style: { fontWeight: 700, fontSize: 16 }, children: item.title }),
            kind
              ? jsx('span', { style: { fontSize: 11, color: text.tertiary, border: `1px solid ${stroke}`, borderRadius: 999, padding: '1px 7px' }, children: kind.badge })
              : null
          ]
        }),
        jsx('div', { style: { fontSize: 12, color: text.secondary, marginTop: 2 }, children: `by ${item.creator}` }),
        jsx('div', { style: { fontSize: 12, color: text.tertiary, marginTop: 4 }, children: kind ? kind.line : COMMUNITY_LINE }),
        item.note
          ? jsx('div', { style: { fontSize: 11, color: text.tertiary, marginTop: 4, lineHeight: 1.35 }, children: item.note })
          : null
      ] }),
      jsx('div', { style: { display: 'flex', gap: 8, marginTop: 6 }, children: [
        button(kind ? kind.action : 'Open', open, { primary: true })
      ] })
    ]
  })
}

function communityShelf(community, ctx, setNote, note = '') {
  const games = (community && community.games) || []
  const problems = (community && community.problems) || []
  if (!games.length && !problems.length) return null
  return jsxs('div', {
    children: [
      heading('Community'),
      jsx('div', {
        style: { fontSize: 12, color: text.tertiary, marginBottom: 8 },
        children: (community && community.notice) || 'Made by the community. Not part of Game Center or Nous.'
      }),
      games.length
        ? jsx('div', {
            style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))', gap: 12 },
            children: games.map(item => communityCard(item, ctx, setNote))
          })
        : null,
      problems.length
        ? jsx('div', { role: 'status', style: { fontSize: 12, color: text.secondary, marginTop: 8 }, children: problems.join(' ') })
        : null,
      note
        ? jsx('div', { role: 'status', 'aria-live': 'polite', style: { fontSize: 12, color: text.secondary, marginTop: 8 }, children: note })
        : null
    ]
  })
}

// The shelf keeps its own note, right under the cards, so a link that will not open says why
// where the person pressed Open instead of in the pane below the store.
function CommunityShelf({ community, ctx }) {
  const [note, setNote] = useState('')
  return communityShelf(community, ctx, setNote, note)
}
