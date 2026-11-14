// The plugin's id changed, and the browser kept what it saved under the old one.
//
// The host namespaces a Desktop plugin's storage by the plugin's id, so after the rename every key
// that carries the old id is unreachable: the pane's own state, and anything else the host or a
// later build wrote under that name. `desktop/src/01-legacy-storage.js` copies each such key to the
// same name with the new id, once, and leaves the old key where it is. This harness runs the
// part that ships inside `desktop/plugin.js` against a fake store, for the four cases that matter:
// a key only the old id has, a key both have, the second load, and a browser that refuses storage.
//
// The old id is never written here: it is read out of the shipped part, so this harness cannot pass
// against a copy of the plugin that renamed nothing.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const PART = fs.readFileSync(path.join(__dirname, '../desktop/src/01-legacy-storage.js'), 'utf8')
const BUNDLE = fs.readFileSync(path.join(__dirname, '../desktop/plugin.js'), 'utf8')
assert.ok(BUNDLE.includes(PART.trim()), 'the storage part is not in the shipped bundle: run tools/build_plugin.py')
assert.ok(/migrateLegacyStorage\(\)\n/.test(BUNDLE), 'the bundle never calls the copy')
assert.equal(BUNDLE.split('migrateLegacyStorage()\n').length - 1, 1,
  'the copy is called once, at register, not per component')

// A localStorage-shaped store: length, key(index), getItem, setItem, removeItem, and a record of
// every write so "the second load copies nothing" is countable.
function fakeStore(entries) {
  const data = new Map(Object.entries(entries || {}))
  const writes = []
  return {
    writes,
    data,
    get length() { return data.size },
    key: index => Array.from(data.keys())[index] ?? null,
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { writes.push(key); data.set(key, String(value)) },
    removeItem: key => { data.delete(key) }
  }
}

function load(storage) {
  const sandbox = { console: { log: () => {}, warn: () => {}, error: () => {} } }
  sandbox.window = storage === null ? {} : { localStorage: storage }
  vm.createContext(sandbox)
  vm.runInContext(PART, sandbox)
  vm.runInContext('globalThis.ids = { old: OLD_ID, now: PLUGIN_ID }', sandbox)
  assert.equal(typeof sandbox.migrateLegacyStorage, 'function', 'the part does not define migrateLegacyStorage')
  return { migrate: sandbox.migrateLegacyStorage, ids: sandbox.ids }
}

const { migrate, ids } = load(fakeStore())
const OLD = ids.old
const NEW = ids.now
assert.equal(typeof OLD, 'string')
assert.ok(OLD.length > 0 && OLD !== NEW, `the old id (${OLD}) and the new id (${NEW}) must differ`)
assert.equal(typeof NEW, 'string')

{
  // A key only the old id has is copied to its new name, value and all, and the old key stays.
  const store = fakeStore({
    [OLD + ':pane-width']: '720px',
    [OLD + '.pane.gone']: '1',
    'gameshelf.slots.scale': '0.8' // already carries no plugin id: not ours to touch
  })
  const copied = load(store).migrate()

  assert.equal(copied, 2, `copied ${copied} keys, expected 2`)
  assert.equal(store.getItem(NEW + ':pane-width'), '720px', 'the pane width did not follow the id')
  assert.equal(store.getItem(NEW + '.pane.gone'), '1', 'the dismissed flag did not follow the id')
  assert.equal(store.getItem(OLD + ':pane-width'), '720px', 'the old key was deleted; it must stay')
  assert.equal(store.getItem('gameshelf.slots.scale'), '0.8', 'a key without the plugin id was rewritten')
  assert.deepEqual(store.writes, [NEW + ':pane-width', NEW + '.pane.gone'],
    'the copy wrote something other than the two new keys')
  console.log('storage: an old key is copied to the new id and the old one is kept: passed')
}

{
  // Both present: the new key wins, and the old one is still not touched.
  const store = fakeStore({
    [OLD + '-model-recent']: 'old-provider/gpt',
    [NEW + '-model-recent']: 'new-provider/glm'
  })
  load(store).migrate()

  assert.equal(store.getItem(NEW + '-model-recent'), 'new-provider/glm',
    'the copy overwrote the choice the person made under the new id')
  assert.deepEqual(store.writes, [], 'the copy wrote over a key that already existed')
  console.log('storage: a key the new id already has is never overwritten: passed')
}

{
  // The second load copies nothing: no writes, so the page does not churn storage on every start.
  const store = fakeStore({ [OLD + ':pane-game']: 'connect4' })
  assert.equal(load(store).migrate(), 1, 'the first load did not copy the key')
  const writesAfterFirst = store.writes.length
  assert.equal(load(store).migrate(), 0, 'the second load copied again: the copy is not once')
  assert.equal(store.writes.length, writesAfterFirst, 'the second load still wrote to storage')
  console.log('storage: the second load copies nothing: passed')
}

{
  // No storage at all (an older desktop, or private mode) and a store that throws: both are quiet.
  assert.equal(load(null).migrate(), 0, 'a window with no localStorage must be a no-op')
  const angry = fakeStore({ [OLD + ':x']: '1' })
  angry.getItem = () => { throw new Error('QuotaExceededError') }
  assert.equal(load(angry).migrate(), 0, 'a store that throws must be a no-op, not an exception')
  console.log('storage: a missing or refusing store is a quiet no-op: passed')
}
