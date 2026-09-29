/**
 * dsh-workspace-auto-sort — host wiring smoke tests (node:test, no deps).
 *
 * A fake cordis ctx (get/on/effect/systemPrompt/logger) plus a fake registry
 * replaying insertBefore semantics prove the event → debounce → plan → move
 * pipeline without a host. node:test mock timers own the debounce window;
 * setImmediate flushes drive the microtask chain.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../src/index.js'

const PLUGIN_KEY = '@dsh-plugins/dsh-workspace-auto-sort'
const MOUNTED = Symbol.for('dsh-web-ui.mounted-plugins')

test.beforeEach(() => {
  globalThis[MOUNTED]?.delete(PLUGIN_KEY)
})

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise(set => setImmediate(set))
}

/** Apply with the round log disabled unless a test asks for it. */
const boot = (ctx, config = {}) => apply(ctx, { logFile: 'off', ...config })

/** A qualifying user-prompt event by default; overrides merge over it. */
const userEvent = (event = {}) => ({
  type: 'user/message',
  data: { source: { kind: 'user' } },
  ...event,
})

/** Fake registry: same insertBefore order semantics as WorkspaceRegistry. */
function makeRegistry(workspaces, { failNext = false } = {}) {
  const order = workspaces.map(workspace => workspace.id)
  const byId = new Map(workspaces.map(workspace => [workspace.id, workspace]))
  const calls = []
  let failing = failNext
  return {
    calls,
    order,
    set failingNext(value) { failing = value },
    list: () => order.map(id => byId.get(id)),
    async insertBefore(id, beforeId) {
      if (failing) { failing = false; throw new Error('cannot reorder unknown workspace') }
      if (!order.includes(id) || (beforeId !== undefined && !order.includes(beforeId))) {
        throw new Error('cannot reorder unknown workspace')
      }
      calls.push([id, beforeId])
      const at = beforeId === undefined ? order.length : order.indexOf(beforeId)
      order.splice(order.indexOf(id), 1)
      order.splice(at, 0, id)
      return [...order]
    },
  }
}

/** Fake persistence: one snapshot per session with a header createdAt. */
function makePersistence(entries) {
  let listCalls = 0
  return {
    get listCalls() { return listCalls },
    async list() {
      listCalls += 1
      return entries.map(([id, time]) => ({ header: { id, createdAt: new Date(time).toISOString() } }))
    },
  }
}

function makeCtx({ registry, persistence } = {}) {
  const listeners = new Map()
  const listenerOptions = []
  const effects = []
  const sections = []
  const warns = []
  const registered = []
  const ctx = {
    logger: { warn: (...args) => warns.push(args.join(' ')), error: () => {}, info: () => {} },
    get: name => (name === 'workspaceRegistry' ? registry : name === 'sessionPersistence' ? persistence : undefined),
    on(name, cb, options) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(cb)
      listenerOptions.push(options)
      return () => {
        const arr = listeners.get(name)
        const at = arr.indexOf(cb)
        if (at >= 0) arr.splice(at, 1)
      }
    },
    webServer: {
      register(route) {
        registered.push(route)
        return () => {
          const at = registered.indexOf(route)
          if (at >= 0) registered.splice(at, 1)
        }
      },
    },
    effect(fn, label) {
      const dispose = fn()
      effects.push({ dispose, label })
      return dispose
    },
    systemPrompt: { section: section => sections.push(section) },
  }
  return { ctx, listeners, listenerOptions, effects, sections, warns, registered }
}

/** Minimal request/response doubles for the loopback route handlers. */
function makeReq(method, { address = '127.0.0.1', host = '127.0.0.1:8080', origin } = {}) {
  const headers = { host }
  if (origin !== undefined) headers.origin = origin
  return { method, socket: { remoteAddress: address }, headers }
}

function makeRes() {
  const captured = { status: undefined, body: undefined }
  captured.writeHead = (status) => { captured.status = status }
  captured.end = (body) => { captured.body = JSON.parse(body) }
  return captured
}

const findRoute = (registered, path) => registered.find(route => route.path === path)?.handler

const fire = (listeners, session, event) => {
  const payload = userEvent(event)
  for (const cb of listeners.get('session/event') ?? []) cb(session, payload)
}

const W1 = { id: 'w1', path: '/w1', title: 'w1', sessionIds: ['s1'] }
const W2 = { id: 'w2', path: '/w2', title: 'w2', sessionIds: ['s2'] }

test('session activity reorders the durable order after the debounce window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const registry = makeRegistry([W1, W2])
  const { ctx, listeners } = makeCtx({ registry })
  boot(ctx)

  fire(listeners, { id: 's2', header: {} }, { time: 1000 })
  await flush()
  assert.deepEqual(registry.calls, [], 'nothing happens before the debounce window closes')

  t.mock.timers.tick(750)
  await flush()
  assert.deepEqual(registry.calls, [['w2', 'w1']])
  assert.deepEqual(registry.order, ['w2', 'w1'])
})

test('a burst of activity collapses into one reorder round', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const registry = makeRegistry([W1, W2])
  const { ctx, listeners } = makeCtx({ registry })
  boot(ctx)
  await flush()

  for (let time = 1000; time < 5000; time += 1000) {
    fire(listeners, { id: 's2', header: {} }, { time })
  }
  t.mock.timers.tick(750)
  await flush()
  assert.deepEqual(registry.calls, [['w2', 'w1']])
})

test('subagent sessions never reorder the visible tree', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const registry = makeRegistry([W1, W2])
  const { ctx, listeners } = makeCtx({ registry })
  boot(ctx)
  await flush()

  fire(listeners, { id: 's2', header: { origin: 'subagent' } }, { time: 9000 })
  t.mock.timers.tick(750)
  await flush()
  assert.deepEqual(registry.calls, [])
})

test('events that do not advance a session time are ignored', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const registry = makeRegistry([W1, W2])
  const { ctx, listeners } = makeCtx({ registry })
  boot(ctx)
  await flush()

  fire(listeners, { id: 's2', header: {} }, { time: 1000 })
  t.mock.timers.tick(750)
  await flush()
  assert.equal(registry.calls.length, 1)

  registry.calls.length = 0
  fire(listeners, { id: 's2', header: {} }, { time: 999 })
  fire(listeners, { id: 's2', header: {} }, { time: 1000 })
  t.mock.timers.tick(750)
  await flush()
  assert.deepEqual(registry.calls, [])
})

test('a missing workspaceRegistry degrades with exactly one warning', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { ctx, listeners, warns } = makeCtx({})
  boot(ctx)
  await flush()

  fire(listeners, { id: 's2', header: {} }, { time: 1000 })
  t.mock.timers.tick(750)
  await flush()
  fire(listeners, { id: 's2', header: {} }, { time: 2000 })
  t.mock.timers.tick(750)
  await flush()
  assert.equal(warns.length, 1)
  assert.match(warns[0], /workspaceRegistry/)
})

test('a failed move aborts the round and the next activity replans', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const registry = makeRegistry([W1, W2], { failNext: true })
  const { ctx, listeners, warns } = makeCtx({ registry })
  boot(ctx)
  await flush()

  fire(listeners, { id: 's2', header: {} }, { time: 1000 })
  t.mock.timers.tick(750)
  await flush()
  assert.deepEqual(registry.calls, [], 'the failing move must abort before recording')
  assert.ok(warns.some(w => /aborting this round/.test(w)))

  fire(listeners, { id: 's2', header: {} }, { time: 2000 })
  t.mock.timers.tick(750)
  await flush()
  assert.deepEqual(registry.calls, [['w2', 'w1']])
})

test('cold sessions rank by persisted header createdAt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const registry = makeRegistry([W1, W2])
  const persistence = makePersistence([['s1', 5000], ['s2', 100]])
  const { ctx, listeners } = makeCtx({ registry, persistence })
  boot(ctx)
  await flush()
  assert.deepEqual(registry.calls, [], 'seeding alone never reorders')

  // w1's cold session is newer than w2's; w2 running below that stays put.
  fire(listeners, { id: 's2', header: {} }, { time: 2000 })
  t.mock.timers.tick(750)
  await flush()
  assert.deepEqual(registry.calls, [])

  fire(listeners, { id: 's2', header: {} }, { time: 6000 })
  t.mock.timers.tick(750)
  await flush()
  assert.deepEqual(registry.calls, [['w2', 'w1']])
})

test('enabled: false stays fully dormant', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const registry = makeRegistry([W1, W2])
  const persistence = makePersistence([['s1', 1]])
  const { ctx, listeners, sections } = makeCtx({ registry, persistence })
  boot(ctx, { enabled: false })
  await flush()

  assert.equal(listeners.get('session/event')?.length ?? 0, 0)
  assert.equal(persistence.listCalls, 0)
  assert.deepEqual(sections, [])
})

test('announceToAgent adds the model-facing section', () => {
  const { ctx, sections } = makeCtx({})
  boot(ctx, { announceToAgent: true })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'plugin:dsh-workspace-auto-sort')
})

test('an invalid debounceMs fails loud at load', () => {
  for (const bad of [-1, 1.5, Number.NaN, '750', undefined]) {
    globalThis[MOUNTED]?.delete(PLUGIN_KEY)
    const { ctx } = makeCtx({})
    assert.throws(() => apply(ctx, { logFile: 'off', debounceMs: bad }), TypeError)
  }
  globalThis[MOUNTED]?.delete(PLUGIN_KEY)
  const { ctx } = makeCtx({})
  assert.doesNotThrow(() => boot(ctx, { debounceMs: 0 }))
})

test('teardown removes the listener and clears a pending debounce', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const registry = makeRegistry([W1, W2])
  const { ctx, listeners, effects } = makeCtx({ registry })
  boot(ctx)
  await flush()

  fire(listeners, { id: 's2', header: {} }, { time: 1000 })
  for (const { dispose } of effects) dispose()
  assert.equal(listeners.get('session/event')?.length ?? 0, 0)

  t.mock.timers.tick(750)
  await flush()
  assert.deepEqual(registry.calls, [])
})

test('the session listener registers with global scope admission', async () => {
  const { ctx, listenerOptions } = makeCtx({})
  boot(ctx)
  const sessionListeners = listenerOptions.filter(options => options !== undefined)
  assert.equal(sessionListeners.length, 1)
  assert.equal(sessionListeners[0].global, true)
})

test('status route serves diagnostics over loopback only', async () => {
  const registry = makeRegistry([W1, W2])
  const { ctx, registered } = makeCtx({ registry })
  boot(ctx)
  const status = findRoute(registered, '/api/dsh-workspace-auto-sort/status')

  const denied = makeRes()
  await status(makeReq('GET', { address: '10.0.0.8' }), denied)
  assert.equal(denied.status, 403)

  const res = makeRes()
  await status(makeReq('GET'), res)
  assert.equal(res.status, 200)
  assert.equal(res.body.enabled, true)
  assert.equal(res.body.trackedSessions, 0)
  assert.deepEqual(res.body.workspaces.map(workspace => workspace.id), ['w1', 'w2'])
  assert.ok(res.body.workspaces.every(workspace => workspace.rank === 0))
})

test('reorder route forces a round and reports the applied plan', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const registry = makeRegistry([W1, W2])
  const { ctx, listeners, registered } = makeCtx({ registry })
  boot(ctx)
  await flush()
  const reorder = findRoute(registered, '/api/dsh-workspace-auto-sort/reorder')

  const wrongMethod = makeRes()
  await reorder(makeReq('GET'), wrongMethod)
  assert.equal(wrongMethod.status, 405)

  // No activity yet: the forced round is a no-op with the current order.
  const idle = makeRes()
  await reorder(makeReq('POST'), idle)
  assert.deepEqual(idle.body, { ok: true, applied: 0, moves: [], order: ['w1', 'w2'] })

  // Pending activity (debounce not elapsed): the forced round applies at once.
  fire(listeners, { id: 's2', header: {} }, { time: 1000 })
  const res = makeRes()
  await reorder(makeReq('POST'), res)
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.applied, 1)
  assert.deepEqual(res.body.order, ['w2', 'w1'])
  assert.deepEqual(registry.calls, [['w2', 'w1']])

  const after = makeRes()
  await findRoute(registered, '/api/dsh-workspace-auto-sort/status')(makeReq('GET'), after)
  // Two forced rounds ran (the idle probe and the applying one); only the
  // second had a move.
  assert.equal(after.body.reorderRounds, 2)
  assert.equal(after.body.movesApplied, 1)
})

test('prompt basis ignores non-user events; user messages reorder', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const registry = makeRegistry([W1, W2])
  const { ctx, listeners } = makeCtx({ registry })
  boot(ctx)
  await flush()

  // Assistant reply, tool result, and foreign-source messages never rank.
  fire(listeners, { id: 's2', header: {} }, { type: 'assistant/message', data: {}, time: 9000 })
  fire(listeners, { id: 's2', header: {} }, { type: 'user/message', data: { source: { kind: 'tool' } }, time: 9000 })
  t.mock.timers.tick(750)
  await flush()
  assert.deepEqual(registry.calls, [])

  // The user's own message advances recency immediately (after the debounce).
  fire(listeners, { id: 's2', header: {} }, { time: 1000 })
  t.mock.timers.tick(750)
  await flush()
  assert.deepEqual(registry.calls, [['w2', 'w1']])
})

test('any basis counts every committed event', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const registry = makeRegistry([W1, W2])
  const { ctx, listeners } = makeCtx({ registry })
  boot(ctx, { activity: 'any' })
  await flush()

  fire(listeners, { id: 's2', header: {} }, { type: 'assistant/message', data: {}, time: 9000 })
  t.mock.timers.tick(750)
  await flush()
  assert.deepEqual(registry.calls, [['w2', 'w1']])
})

test('an unknown activity basis fails loud at load', () => {
  globalThis[MOUNTED]?.delete(PLUGIN_KEY)
  const { ctx } = makeCtx({})
  assert.throws(() => apply(ctx, { logFile: 'off', activity: 'hourly' }), TypeError)
})

test('each round appends a rank snapshot to the round log', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { mkdtemp, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'auto-sort-log-'))
  const logPath = join(dir, 'rounds.log')

  const registry = makeRegistry([W1, W2])
  const { ctx, listeners } = makeCtx({ registry })
  boot(ctx, { logFile: logPath })
  await flush()

  fire(listeners, { id: 's2', header: {} }, { time: 1000 })
  t.mock.timers.tick(750)
  await flush()

  const lines = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const round = lines.find(line => line.kind === undefined)
  assert.ok(round, 'one round record expected')
  assert.deepEqual(round.moves, [{ id: 'w2', beforeId: 'w1' }])
  assert.deepEqual(round.order, ['w2', 'w1'])
  assert.ok(round.ranks.every(rank => typeof rank.rank === 'number' && typeof rank.title === 'string'))
})

test('an unknown scope fails loud at load', () => {
  globalThis[MOUNTED]?.delete(PLUGIN_KEY)
  const { ctx } = makeCtx({})
  assert.throws(() => apply(ctx, { logFile: 'off', scope: 'flat' }), TypeError)
})
