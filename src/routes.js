/**
 * dsh-workspace-auto-sort — the loopback-only HTTP face.
 *
 * Two routes under /api/dsh-workspace-auto-sort:
 *   GET  /status   → { mounted, enabled, counters, registry, lastPlan, lastError }
 *   POST /reorder  → forces one reorder round now; returns the applied plan
 *
 * Both sit behind the same request-level trust fence DSH host plugins use:
 * loopback socket + loopback Host + browser same-origin markers. X-Forwarded-For is never trusted. Responses carry no
 * session content — only ids, counts, timestamps, and workspace metadata.
 */

/** IPv4 127/8 predicate. */
function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket address names the loopback range (127/8, ::1, mapped). */
function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Whether a normalized hostname names a loopback authority. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * Request-level trust fence: loopback socket + loopback Host + browser
 * same-origin markers. X-Forwarded-For is never trusted.
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** One JSON response. */
function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

/** Route family base path. */
export const BASE_PATH = '/api/dsh-workspace-auto-sort'

/** Route family dependencies: live status snapshot + forced reorder runner. */
export function makeRoutes({ getStatus, runReorder }) {
  return {
    routes: [
      {
        kind: 'exact',
        path: `${BASE_PATH}/status`,
        handler: async (req, res) => {
          if (!isLoopbackRequest(req)) {
            writeJson(res, 403, { error: 'forbidden: loopback-only' })
            return
          }
          if ((req.method ?? 'GET') !== 'GET') {
            writeJson(res, 405, { error: `method not allowed: ${req.method}` })
            return
          }
          writeJson(res, 200, getStatus())
        },
      },
      {
        kind: 'exact',
        path: `${BASE_PATH}/reorder`,
        handler: async (req, res) => {
          if (!isLoopbackRequest(req)) {
            writeJson(res, 403, { error: 'forbidden: loopback-only' })
            return
          }
          if ((req.method ?? 'GET') !== 'POST') {
            writeJson(res, 405, { error: `method not allowed: ${req.method}` })
            return
          }
          try {
            writeJson(res, 200, { ok: true, ...(await runReorder()) })
          } catch (error) {
            writeJson(res, 200, { ok: false, message: error instanceof Error ? error.message : String(error) })
          }
        },
      },
    ],
  }
}
