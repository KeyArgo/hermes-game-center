# Hermes issues to open

_Applies to Game Center 1.0.0 · last revised 2026-11-13 (f17ea3f0)_

Requested by the catalog review of 2026-11-12. The plugin does not open these itself; they are written
here, ready to file, so a reviewer can see what was asked for and why.

## 1. A public, read-only pet API

**Title:** `Expose a public read-only API for the active pet (name, spritesheet, frame cells)`

**Why.** Game Center draws the person's own Hermes pet on one of its tables (a "labs" extra: the pet
sits in the corner of a card game and reacts to the result). To do that it reads `agent.pet.store`,
`agent.pet.constants` and `agent.pet.render.PetRenderer`, which are private: a Hermes release may move
them, and the catalog validator flags the import under its rule about private internals. Every read in
`shelf/pet.py` is already behind an `available()` probe and degrades to "no pet", so a move breaks a
decoration rather than the plugin — but it is still a plugin reading internals it does not own.

**Ask.** A small, documented, read-only surface — e.g. `ctx.pet.info()` returning the active pet's
slug, display name, spritesheet path and scale, and `ctx.pet.cells(state, cols)` returning the frame
grid the host itself renders — so a plugin can draw the pet without importing `agent.pet.*`. Read-only
is enough: Game Center never changes the pet, never installs one and never writes to the store.

**What it affects.** `shelf/pet.py` (the only file that imports `agent.pet`) and the pets card of the
Experimental shelf. Without the API the feature stays behind the fail-soft probe and a future release
that moves those modules turns it off quietly, which is acceptable but not the same thing as supported.

## 2. Not needed: a "chat column bounds" API

The same review offered to add an API for the conversation's bounds if the over-chat slot machine
needed one. It does not: the machines are a `composer.underside` contribution now, the slot's own
width is the frame, and nothing measures the conversation. Recorded here so the offer is not
mistaken for an open request.
