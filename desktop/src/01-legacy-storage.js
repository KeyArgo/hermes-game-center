// ---- 01-legacy-storage.js: the plugin's id, and what the browser saved under the old one
// The host keys everything this plugin registers and stores by its manifest id, and the id changed
// from the old one below to the new one. Anything saved under a key that carries the old id — the
// pane's own state, or whatever a later part names after the plugin — would simply never be read
// again. So on load every key that carries the old id is copied to the same name with the new id.
// Read the old, write the new, and leave the old key exactly where it is.
const PLUGIN_ID = 'hermes-game-center'
const OLD_ID = 'hermes-gameshelf'

// Copies each old key that the new key does not already have. Returns how many it copied: 0 on the
// second and every later load, which is what makes this safe to call on every register.
function migrateLegacyStorage(storage) {
  const store = storage || (typeof window === 'undefined' ? null : window.localStorage)
  if (!store || typeof store.key !== 'function' || typeof store.getItem !== 'function') return 0
  let copied = 0
  try {
    // Snapshot the keys first: setItem while walking the store moves the indices underfoot.
    const keys = []
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index)
      if (typeof key === 'string' && key.includes(OLD_ID)) keys.push(key)
    }
    for (const key of keys) {
      const renamed = key.split(OLD_ID).join(PLUGIN_ID)
      if (store.getItem(renamed) !== null) continue // the new key wins; never overwrite it
      const value = store.getItem(key)
      if (value === null) continue
      store.setItem(renamed, value)
      copied += 1
    }
  } catch (failure) {
    // A browser that refuses storage (private mode, a full quota) still gets a working page.
  }
  return copied
}
