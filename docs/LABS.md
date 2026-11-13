# Labs — where a Phase 1 experiment goes
_Applies to Game Center 1.0.0 · last revised 2026-11-12 (43be8583)_

Labs is the one shelf on the Games page for things that are not Play. It ships with one badge
(`Labs · experiment`), one note and one card shape, so a screen built by one lane and a card built
by another still read as one shelf.

Play is `shelf/curated.json`. Something that lives in Labs never appears in Play, never sits at a
Game Center table, is never seated in a lobby or a tournament, and is never rated.

## The badge travels, the shelf does not

The same badge (`Labs · experiment`) also marks a **draft feature inside its own screen**, such as the
Lobby tab's *Bots and leagues* area or the stock league row. That is a different thing from a Labs card
on the Games page: those features do sit at the server's tables and some are rated, because rating is
what they are for. The rule above is about the **Labs shelf**: a card in that shelf is a link-out to
somebody else's experiment, so it is never seated or rated here. A Lobby draft is ours, and the badge
says it is unfinished, not that it is unrated.

## Put a card in Labs

`desktop/src/27-labs.js` has the three pieces you need; do not add a fourth style.

```js
// A whole block inside the shelf: a small title, one plain sentence, then cards.
labsBlock(title, note, children)

// One link-out card: name, who made it, one plain line, one quiet way out.
// `item` is { id, title, maker, kind, summary, note, url }. `kind` is 'plugin' or 'skill'.
labsCard(item, ctx, setNote)

// The block most lanes want: a grid of link-out cards plus its own notice line.
LabsLinks({ title, note, notice, items, ctx })
```

Add the block to the shelf in `desktop/src/70-home.js`, as an element (never a direct call — the
block holds state of its own):

```js
const labsBlocks = [
  makers.items.length
    ? jsx(LabsLinks, { title: 'Make games', note: '…', notice: makers.notice, items: makers.items, ctx }, 'make-games')
    : null,
  jsx(LabsLinks, { title: 'Your experiment', note: '…', items: yourItems, ctx }, 'your-experiment')
].filter(Boolean)

…
labsShelf(labsBlocks)
```

`labsShelf(...)` returns `null` when it has no blocks, and `LabsLinks` returns `null` when it has no
cards, so an empty shelf is never drawn. Build each block conditionally as an element (as above);
never call a block as a plain function, because its hooks would then belong to the page.

## A screen, not a link

A Labs item may open its own screen instead of a page. Then:

- the screen is a part of its own under `desktop/src/` and is reached from the card, the same way a
  Play game is (`setPlaying(id)` in `70-home.js`, or `host.navigate(route)` for another plugin);
- the card's behaviour line says `Opens in its own screen. Experimental build.`;
- everything in the product rules still holds: mouse only, no typing to move, no drop-down menus,
  one clear win/lose overlay.

## What a Labs card may and may not carry

Must: a title, one plain line of what it is, who made it, and at most one action.

Must not: a marketing claim, an unverified link, anything loaded from another site inside Hermes, a
keyboard-only control, a drop-down, or the solid accent button. The solid accent button belongs to
a game you can play right here; a card that leaves Hermes gets a quiet underlined link.

## Data, not code

A link-out shelf is a JSON file read by the backend and passed to the page in `/view`. Copy
`shelf/makers.json` for the shape; read it with a small function shaped like `makers_shelf()` in
`shelf/catalog.py`, which validates every entry and turns a bad one into a one-line problem instead
of an exception. Every `url` is https, and the page never fetches it — `Open` hands the address to
the system browser.
