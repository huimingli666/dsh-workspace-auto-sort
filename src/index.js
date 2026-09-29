/**
 * dsh-workspace-auto-sort — host half.
 *
 * Watches committed session activity and keeps the outermost workspaces
 * ordered by their newest child-session recency: the owning workspace's rank
 * refreshes on each qualifying event, a debounce window coalesces bursts, and
 * a serialized rewrite replays the durable registry order through the official
 * `workspaceRegistry.insertBefore` — the same API a manual drag uses, so every
 * move persists and the GUI re-renders from the ordinary workspace-changed
 * broadcast. No browser half: there is nothing to draw. Everything rides
 * official dsh host services — no dsh source changes.
 *
 * The default recency basis is the session's last user prompt (the same basis
 * the GUI's "last updated" labels show); `activity: 'any'` widens it to every
 * committed event. Loopback-only diagnostics live under
 * /api/dsh-workspace-auto-sort (GET /status, POST /reorder), and every reorder
 * round is appended to a log file under ~/.dsh/logs for offline debugging.
 */
import { planReorder, rankWorkspace } from './sort.js'
import { makeRoutes } from './routes.js'
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Stable cordis plugin name. */
export const name = 'workspace-auto-sort'

/** webServer mounts the diagnostics routes; systemPrompt serves the optional
 * announcement. Ordering inputs resolve lazily via ctx.get. */
export const inject = ['webServer', 'systemPrompt']

/** Defaults merged over the composition entry (if any). */
export const defaultConfig = Object.freeze({
  enabled: true,
  debounceMs: 750,
  announceToAgent: false,
  /** Recency basis: 'prompt' = last user message (matches the GUI labels);
   * 'any' = every committed session event (running tasks keep bubbling). */
  activity: 'prompt',
  /** Participation scope: 'all' sorts every workspace (what the sidebar
   * shows by default); 'outermost' keeps path-nested workspaces pinned. */
  scope: 'all',
  /** Round-log path; '' = ~/.dsh/logs/dsh-workspace-auto-sort.log, 'off' = disabled. */
  logFile: '',
})

/** Keep the package from being applied twice in one process (bundle row +
 * plugin-add row / HMR reload can otherwise load it twice). Shares the same
 * Symbol.for registry key the host's web UI uses for mounted-plugin dedupe. */
const MOUNTED = Symbol.for('dsh-web-ui.mounted-plugins')
function mountedSet() {
  const registry = globalThis
  return (registry[MOUNTED] ??= new Set())
}
function mountOnce(packageName, fn) {
  return (...args) => {
    const mounted = mountedSet()
    if (mounted.has(packageName)) return
    mounted.add(packageName)
    const ctx = args[0]
    ctx?.effect?.(() => () => { mounted.delete(packageName) })
    return fn(...args)
  }
}

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 192

/** Model-facing announcement: plugin presence, behavior, and limits. */
const SORT_GUIDANCE = '本机已安装 dsh-workspace-auto-sort 插件（工作区自动排序）：任一会话收到新的用户消息时，插件会自动把最外层工作区按「子会话最后一条用户消息时间」降序持久化重排（嵌套子工作区相对顺序保持不动），刚被使用的工作区会上浮到最前。手动拖拽的工作区顺序会在下一次会话活动时被重新排序；关闭该插件即可恢复纯手动排序。状态与手动触发：GET /api/dsh-workspace-auto-sort/status、POST /api/dsh-workspace-auto-sort/reorder（loopback-only）。用户提到「工作区自动排序 / 按最近活动排列工作区」时即指本插件。'

/** Logger without inject-guard surprises: ctx.logger is a cordis accessor,
 * not a mixin — resolve defensively and fall back to console. */
function safeLogger(ctx) {
  try {
    return ctx.logger ?? console
  } catch {
    return console
  }
}

/**
 * Validate the merged config; a bad value fails loud at load.
 * @param {unknown} value - Candidate debounce window.
 * @returns {number} The validated window in milliseconds.
 */
function debounceMsOf(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`dsh-workspace-auto-sort: debounceMs must be a non-negative integer, got ${String(value)}`)
  }
  return value
}

/**
 * Resolve the round-log path from config.
 * @param {unknown} value - Configured logFile ('' default, 'off', or a path).
 * @returns {string | undefined} Absolute log path, or undefined when disabled.
 */
function logFileOf(value) {
  if (value === 'off') return undefined
  if (value === undefined || value === '') return join(homedir(), '.dsh', 'logs', 'dsh-workspace-auto-sort.log')
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`dsh-workspace-auto-sort: logFile must be '', 'off', or a path, got ${String(value)}`)
  }
  return value
}

/**
 * Validate the activity basis.
 * @param {unknown} value - Configured basis.
 * @returns {string} 'prompt' or 'any'.
 */
function activityOf(value) {
  if (value !== 'prompt' && value !== 'any') {
    throw new TypeError(`dsh-workspace-auto-sort: activity must be 'prompt' or 'any', got ${String(value)}`)
  }
  return value
}

/**
 * Validate the participation scope.
 * @param {unknown} value - Configured scope.
 * @returns {string} 'all' or 'outermost'.
 */
function scopeOf(value) {
  if (value !== 'all' && value !== 'outermost') {
    throw new TypeError(`dsh-workspace-auto-sort: scope must be 'all' or 'outermost', got ${String(value)}`)
  }
  return value
}

/**
 * Mount the activity listener, the serialized reorder chain, and the
 * loopback-only diagnostics routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {object} [config] - composition-entry config.
 */
export const apply = mountOnce('@dsh-plugins/dsh-workspace-auto-sort', applyImpl)

function applyImpl(ctx, config = {}) {
  const resolved = { ...defaultConfig, ...(config ?? {}) }
  const debounceMs = debounceMsOf(resolved.debounceMs)
  const activity = activityOf(resolved.activity)
  const scope = scopeOf(resolved.scope)
  const logPath = logFileOf(resolved.logFile)
  const logger = safeLogger(ctx)

  /** Fire-and-forget append of one round-record line; logging never throws. */
  const logLine = (record) => {
    if (logPath === undefined) return
    void (async () => {
      try {
        await mkdir(dirname(logPath), { recursive: true })
        await appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8')
      } catch (error) {
        logger.warn?.(`dsh-workspace-auto-sort: log write failed: ${String(error)}`)
      }
    })()
  }

  // Session id → newest qualifying activity time (epoch ms). Populated only
  // by live activity; `fallbackTimes` covers sessions that never ran in this
  // host process with their persisted header creation time.
  const lastActivity = new Map()
  const fallbackTimes = new Map()
  // Observability counters for the status route.
  const stats = {
    startedAt: new Date().toISOString(),
    enabled: resolved.enabled !== false,
    activity,
    eventCount: 0,
    subagentIgnored: 0,
    otherIgnored: 0,
    staleIgnored: 0,
    seededFallbacks: 0,
    seedError: undefined,
    reorderRounds: 0,
    movesApplied: 0,
    lastEventAt: undefined,
    lastReorderAt: undefined,
    lastPlan: undefined,
    lastError: undefined,
  }
  let timer
  let warnedRegistryMissing = false
  let reorderChain = Promise.resolve()

  /** Live workspace projection for planning and status reporting. */
  const currentWorkspaces = () => {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return { registry: undefined, workspaces: [] }
    return {
      registry,
      workspaces: registry.list().map(workspace => ({
        id: String(workspace.id),
        path: workspace.path,
        title: workspace.title,
        sessionIds: Array.from(workspace.sessionIds, String),
      })),
    }
  }

  const rankOf = workspace => rankWorkspace(workspace.sessionIds, lastActivity, fallbackTimes)

  const getStatus = () => ({
    ...stats,
    debounceMs,
    fallbackCount: fallbackTimes.size,
    trackedSessions: lastActivity.size,
    workspaces: currentWorkspaces().workspaces.map(workspace => ({
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
      sessionCount: workspace.sessionIds.length,
      rank: rankOf(workspace),
    })),
  })

  const recordRound = (outcome) => {
    stats.reorderRounds += 1
    stats.movesApplied += outcome.applied
    stats.lastReorderAt = new Date().toISOString()
    stats.lastPlan = { at: stats.lastReorderAt, ...outcome }
    return outcome
  }

  const reorderOnce = async () => {
    const { registry, workspaces } = currentWorkspaces()
    if (registry === undefined) {
      if (!warnedRegistryMissing) {
        warnedRegistryMissing = true
        logger.warn?.('dsh-workspace-auto-sort: no workspaceRegistry on this host; reordering stays dormant')
      }
      return recordRound({ applied: 0, order: [], registryFound: false })
    }
    warnedRegistryMissing = false
    const plan = planReorder(workspaces, lastActivity, fallbackTimes, { scope })
    for (const move of plan.moves) {
      try {
        await registry.insertBefore(move.id, move.beforeId)
      } catch (error) {
        // The projection aged out from under the plan (a concurrent delete,
        // for example). Stop the round; the next activity replans from scratch.
        stats.lastError = String(error)
        logger.warn?.(`dsh-workspace-auto-sort: move ${move.id} before ${move.beforeId} failed, aborting this round: ${String(error)}`)
        return recordRound({ applied: 0, order: plan.order, aborted: true })
      }
    }
    const outcome = recordRound({ applied: plan.moves.length, moves: plan.moves, order: plan.order })
    logLine({
      at: stats.lastReorderAt,
      activity,
      scope,
      ranks: workspaces.map(workspace => ({
        id: workspace.id,
        title: workspace.title,
        rank: rankOf(workspace),
        sessions: workspace.sessionIds.length,
      })),
      moves: plan.moves,
      order: plan.order,
    })
    return outcome
  }

  const schedule = () => {
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      reorderChain = reorderChain.then(() => reorderOnce()).catch((error) => {
        stats.lastError = String(error)
        logger.warn?.(`dsh-workspace-auto-sort: reorder round failed: ${String(error)}`)
      })
    }, debounceMs)
  }

  const onSessionEvent = (session, event) => {
    // Subagent sessions stay hidden on every grouping surface, so their
    // writes must not reorder what the user sees.
    if (session?.header?.origin === 'subagent') {
      stats.subagentIgnored += 1
      return
    }
    const id = session?.id
    if (id === undefined) return
    stats.eventCount += 1
    stats.lastEventAt = new Date().toISOString()
    // 'prompt' basis: only the user's own messages advance recency, matching
    // the GUI's "last updated" labels exactly and keeping long-running
    // background tasks from pinning their workspace at the top.
    if (activity === 'prompt'
      && !(event?.type === 'user/message' && event?.data?.source?.kind === 'user')) {
      stats.otherIgnored += 1
      return
    }
    const time = typeof event?.time === 'number' && Number.isFinite(event.time)
      ? event.time
      : Date.now()
    if ((lastActivity.get(id) ?? Number.NEGATIVE_INFINITY) >= time) {
      stats.staleIgnored += 1
      return
    }
    lastActivity.set(id, time)
    schedule()
  }

  const runReorder = async () => {
    const pending = reorderChain.then(() => reorderOnce()).catch((error) => {
      stats.lastError = String(error)
      logger.warn?.(`dsh-workspace-auto-sort: forced reorder failed: ${String(error)}`)
      return { applied: 0, order: [], error: String(error) }
    })
    reorderChain = pending.then(() => {}, () => {})
    return await pending
  }

  const disposers = []
  try {
    ctx.effect(() => {
      if (stats.enabled) {
        // `global: true` admits this listener for every session regardless of
        // scope filtering: workspace recency must observe agent-scoped and
        // main sessions alike.
        disposers.push(ctx.on('session/event', onSessionEvent, { global: true }))
      }
      const { routes } = makeRoutes({ getStatus, runReorder })
      for (const route of routes) disposers.push(ctx.webServer.register(route))
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch (error) {
            console.error('[dsh-workspace-auto-sort] dispose failed:', error)
          }
        }
        if (timer !== undefined) clearTimeout(timer)
      }
    }, 'dsh-workspace-auto-sort: teardown')
  } catch (error) {
    console.error('[dsh-workspace-auto-sort] listener/route registration failed:', error)
    return
  }

  // Seed cold-session fallback times once; a failure only costs ordering
  // precision for sessions that have not run in this process yet. A disabled
  // plugin stays fully dormant: no listener, no persistence reads.
  if (stats.enabled) {
    // The persistence service activates asynchronously: the first attempt at
    // apply time can legitimately see it absent (the 0-seed case in the
    // field), so retry once after a grace period before giving up.
    const seedOnce = async () => {
      const persistence = ctx.get('sessionPersistence')
      if (persistence === undefined) return false
      for (const snapshot of await persistence.list()) {
        const id = snapshot?.header?.id
        const created = Date.parse(snapshot?.header?.createdAt ?? '')
        if (id !== undefined && Number.isFinite(created)) fallbackTimes.set(String(id), created)
      }
      return true
    }
    void (async () => {
      try {
        const seeded = await seedOnce()
        if (!seeded) {
          await new Promise(resolve => setTimeout(resolve, 15000))
          await seedOnce()
        }
        stats.seededFallbacks = fallbackTimes.size
      } catch (error) {
        stats.seedError = String(error)
        logger.warn?.(`dsh-workspace-auto-sort: seeding fallback times failed: ${String(error)}`)
      }
      const summary = `dsh-workspace-auto-sort: active (activity ${activity}, scope ${scope}, debounce ${debounceMs}ms, ${fallbackTimes.size} fallback times seeded, ${currentWorkspaces().workspaces.length} workspaces)`
      logger.info?.(summary)
      logLine({ at: new Date().toISOString(), kind: 'start', summary })
    })()
  }

  if (resolved.announceToAgent === true) {
    try {
      ctx.systemPrompt.section({
        name: 'plugin:dsh-workspace-auto-sort',
        order: SECTION_ORDER,
        text: SORT_GUIDANCE,
      })
    } catch (error) {
      console.error('[dsh-workspace-auto-sort] announcement section failed:', error)
    }
  }
}
