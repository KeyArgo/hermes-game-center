// ---- 09-diagnostics.js: our own errors and heap, one short line to our own log
// A crash inside a Game Center surface is worth one line in the plugin's own log
// (POST /log, rate limited on the server). Only our own code is reported: an error
// whose file or stack does not name this plugin belongs to the host and is left
// alone. While a surface is open, the heap is sampled every five minutes when the
// browser offers performance.memory. Nothing here reads or styles the host's markup.
const DIAG_OWN = /hermes-gameshelf/
const DIAG_HEAP_MS = 5 * 60 * 1000
const DIAG_LINE = 200
const diagWatch = { surfaces: 0, ctx: null, timer: null, onError: null, onReject: null }

function diagSend(body) {
  const ctx = diagWatch.ctx
  if (!ctx || typeof ctx.rest !== 'function') return
  try {
    const answer = ctx.rest('/log', { method: 'POST', body })
    if (answer && typeof answer.catch === 'function') answer.catch(() => {})
  } catch {
    // Reporting must never be the second crash.
  }
}

function diagOwnFile(name) {
  return typeof name === 'string' && DIAG_OWN.test(name)
}

function diagErrorLine(event) {
  const message = String((event && event.message) || 'error').slice(0, DIAG_LINE)
  const file = String((event && event.filename) || '').split('/').pop()
  const where = file ? ` (${file}:${(event && event.lineno) || 0})` : ''
  return message + where
}

function diagReasonLine(reason) {
  return String((reason && reason.message) || reason || 'rejection').slice(0, DIAG_LINE)
}

// A surface (the Games page or the side pane) calls this while it is mounted and
// runs the returned cleanup when it unmounts. The first surface opens the watch;
// the last one closes it, so no listener or timer outlives the plugin's screens.
function diagSurfaceOpen(ctx) {
  diagWatch.surfaces += 1
  diagWatch.ctx = ctx
  if (diagWatch.surfaces === 1) {
    diagWatch.onError = event => {
      const stack = event && event.error && event.error.stack
      if (!diagOwnFile(event && event.filename) && !diagOwnFile(stack)) return
      diagSend({ kind: 'error', message: diagErrorLine(event) })
    }
    diagWatch.onReject = event => {
      const reason = event && event.reason
      if (!diagOwnFile(reason && reason.stack) && !diagOwnFile(reason && reason.fileName)) return
      diagSend({ kind: 'rejection', message: diagReasonLine(reason) })
    }
    window.addEventListener('error', diagWatch.onError)
    window.addEventListener('unhandledrejection', diagWatch.onReject)
    diagWatch.timer = setInterval(() => {
      const memory = typeof performance !== 'undefined' ? performance.memory : null
      if (memory && typeof memory.usedJSHeapSize === 'number') {
        diagSend({ kind: 'heap', used: memory.usedJSHeapSize })
      }
    }, DIAG_HEAP_MS)
  }
  return diagSurfaceClose
}

function diagSurfaceClose() {
  diagWatch.surfaces = Math.max(0, diagWatch.surfaces - 1)
  if (diagWatch.surfaces > 0) return
  if (diagWatch.onError) window.removeEventListener('error', diagWatch.onError)
  if (diagWatch.onReject) window.removeEventListener('unhandledrejection', diagWatch.onReject)
  if (diagWatch.timer !== null) clearInterval(diagWatch.timer)
  diagWatch.onError = null
  diagWatch.onReject = null
  diagWatch.timer = null
  diagWatch.ctx = null
}
