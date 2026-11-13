// ---- 00-header.js: the module doc comment, the imports and the shared constants
/**
 * Game Center — Play is the curated shelf; Your games is whatever you installed, labelled as
 * outside code; Community creations is a side link. Playing still sends /games lines. The page
 * does not judge moves.
 *
 * Plain ESM, jsx() only; imports limited to @hermes/plugin-sdk, react, react/jsx-runtime.
 */

import { COMPOSER_AREAS, host, PALETTE_AREA, PANES_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA, STATUSBAR_AREAS, useValue } from '@hermes/plugin-sdk'
import { Component, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ROUTE = '/games'
const ONLINE_URL = 'https://games.hermesnet.xyz'
const POLL_MS = 3000
const PLAY_HEIGHT = 560
const ARENA_ID = 'doctrine-arena'
const ARENA_STORM = { start: 18, end: 34, from: 640, to: 260 }
const ARENA_SEATS = [
  { seat: 0, name: 'Bulwark', colour: '#7ec8ff' },
  { seat: 1, name: 'Skirmisher', colour: '#ff9f6e' },
  { seat: 2, name: 'Sniper', colour: '#9ae66e' },
  { seat: 3, name: 'Bruiser', colour: '#e579ff' }
]
// One watch speed for every game: the bots step every 900 ms.
const WATCH_MS = 900

const text = {
  primary: 'var(--ui-text-primary, inherit)',
  secondary: 'var(--ui-text-secondary)',
  tertiary: 'var(--ui-text-tertiary)'
}
const stroke = 'var(--ui-stroke-secondary)'
const accent = 'var(--ui-accent)'
const fill = 'var(--ui-fill-tertiary, rgba(127,127,127,0.12))'
const paper = 'var(--ui-bg-editor, var(--ui-bg-solid, #101820))'
const card = 'var(--ui-bg-elevated, var(--ui-bg-card, #161e28))'
