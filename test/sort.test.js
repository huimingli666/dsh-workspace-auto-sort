/**
 * dsh-workspace-auto-sort — pure ordering logic tests (node:test, no deps).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeFolderPath, parentFolderPath, planReorder, rankWorkspace } from '../src/sort.js'

/** Replay a move list through insertBefore semantics (remove id, insert before anchor). */
function applyMoves(order, moves) {
  const sim = [...order]
  for (const { id, beforeId } of moves) {
    assert.ok(sim.includes(id), `move source ${id} must be present`)
    assert.ok(sim.includes(beforeId), `move anchor ${beforeId} must be present`)
    sim.splice(sim.indexOf(id), 1)
    sim.splice(sim.indexOf(beforeId), 0, id)
  }
  return sim
}

/** Workspace factory: id doubles as the path when none is given. */
function ws(id, path, sessionIds = []) {
  return { id, path: path ?? id, sessionIds }
}

test('normalizeFolderPath folds Windows separators and strips trailing slashes', () => {
  assert.equal(normalizeFolderPath('/a/b/'), '/a/b')
  assert.equal(normalizeFolderPath('/a/b'), '/a/b')
  assert.equal(normalizeFolderPath('C:\\a\\b\\'), 'C:/a/b')
  assert.equal(normalizeFolderPath('\\\\server\\share\\'), '//server/share')
  // POSIX backslashes are literal characters, not separators.
  assert.equal(normalizeFolderPath('/a/b\\c'), '/a/b\\c')
})

test('parentFolderPath finds the nearest registered ancestor and excludes the self path', () => {
  assert.equal(parentFolderPath('/a/b/c', ['/a', '/a/b']), '/a/b')
  assert.equal(parentFolderPath('/a', ['/a']), undefined)
  assert.equal(parentFolderPath('/a/b', ['/a']), '/a')
  assert.equal(parentFolderPath('/a/b', []), undefined)
})

test('parentFolderPath requires a path-segment boundary between parent and child', () => {
  assert.equal(parentFolderPath('/aab', ['/aa']), undefined)
  assert.equal(parentFolderPath('/aa/b', ['/aa']), '/aa')
})

test('parentFolderPath tolerates trailing-slash and separator spellings', () => {
  // The registered parent spelling is returned verbatim, like the GUI's own helper.
  assert.equal(parentFolderPath('/a/b/', ['/a/']), '/a/')
  assert.equal(parentFolderPath('C:\\x\\y', ['C:\\x']), 'C:\\x')
})

test('rankWorkspace takes the newest activity with header-createdAt fallback and zero floor', () => {
  const activity = new Map([['s1', 100]])
  const fallback = new Map([['s1', 999], ['s2', 50]])
  assert.equal(rankWorkspace(['s1', 's2'], activity, fallback), 100)
  assert.equal(rankWorkspace(['s2'], activity, fallback), 50)
  assert.equal(rankWorkspace(['s9'], activity, fallback), 0)
  assert.equal(rankWorkspace([], activity, fallback), 0)
})

test('planReorder is a no-op when the outermost subsequence is already sorted', () => {
  const plan = planReorder(
    [ws('w1', '/w1', ['s1']), ws('w2', '/w2', ['s2'])],
    new Map([['s1', 200], ['s2', 100]]),
    new Map(),
  )
  assert.deepEqual(plan.moves, [])
  assert.deepEqual(plan.order, ['w1', 'w2'])
})

test('planReorder moves a workspace whose session just ran to the front', () => {
  const plan = planReorder(
    [ws('w1', '/w1', ['s1']), ws('w2', '/w2', ['s2'])],
    new Map([['s2', 300]]),
    new Map([['s1', 100]]),
  )
  assert.deepEqual(plan.order, ['w2', 'w1'])
  assert.deepEqual(plan.moves, [{ id: 'w2', beforeId: 'w1' }])
  assert.deepEqual(applyMoves(['w1', 'w2'], plan.moves), plan.order)
})

test('planReorder permutes only the outermost subsequence; nested entries are never named', () => {
  // /outer/child nests under /outer; w-old and w-new are outermost.
  const workspaces = [
    ws('w-old', '/w-old', ['s-old']),
    ws('child', '/w-old/child', ['s-child']),
    ws('w-new', '/w-new', ['s-new']),
    ws('other', '/other', ['s-other']),
  ]
  const activity = new Map([['s-new', 500], ['s-old', 100], ['s-other', 200], ['s-child', 900]])
  const plan = planReorder(workspaces, activity, new Map(), { scope: 'outermost' })
  // Outermost by recency: w-new (500), other (200), w-old (100). The child's
  // 900 ranks only its own nested workspace, which never moves.
  assert.deepEqual(plan.order, ['w-new', 'other', 'w-old', 'child'])
  assert.deepEqual(applyMoves(['w-old', 'child', 'w-new', 'other'], plan.moves), plan.order)
  assert.ok(plan.moves.every(move => move.id !== 'child' && move.beforeId !== 'child'),
    'nested workspaces must not appear in any move')
  // The outermost subsequence alone is what gets sorted.
  assert.deepEqual(
    plan.order.filter(id => id !== 'child'),
    ['w-new', 'other', 'w-old'],
  )
})

test('default scope all sorts every workspace, including path-nested ones', () => {
  const workspaces = [
    ws('w-old', '/w-old', ['s-old']),
    ws('child', '/w-old/child', ['s-child']),
    ws('w-new', '/w-new', ['s-new']),
    ws('other', '/other', ['s-other']),
  ]
  const activity = new Map([['s-new', 500], ['s-old', 100], ['s-other', 200], ['s-child', 900]])
  const plan = planReorder(workspaces, activity, new Map())
  // Every workspace participates: child (900) leads, then w-new (500), other (200), w-old (100).
  assert.deepEqual(plan.order, ['child', 'w-new', 'other', 'w-old'])
  assert.deepEqual(applyMoves(['w-old', 'child', 'w-new', 'other'], plan.moves), plan.order)
})

test('outermost scope keeps a path-nested workspace pinned even when it ranks last', () => {
  // Regression for the field report: a nested workspace that sits first in
  // the list must not block the rest from sorting.
  const workspaces = [
    ws('pinned', '/pinned-root/pinned', ['s-pinned']),
    ws('root', '/pinned-root', ['s-root']),
    ws('a', '/a', ['sa']),
    ws('b', '/b', ['sb']),
  ]
  const activity = new Map([['sb', 300], ['sa', 200], ['s-pinned', 100], ['s-root', 50]])
  const plan = planReorder(workspaces, activity, new Map(), { scope: 'outermost' })
  // pinned is nested (its parent /pinned-root is registered), so it keeps its
  // leading slot untouched while the outermost three sort by recency.
  assert.deepEqual(plan.order, ['pinned', 'b', 'a', 'root'])
  assert.deepEqual(applyMoves(['pinned', 'root', 'a', 'b'], plan.moves), plan.order)
  assert.ok(plan.moves.every(move => move.id !== 'pinned' && move.beforeId !== 'pinned'),
    'the pinned nested workspace must not appear in any move')
})

test('planReorder breaks rank ties stably and sinks session-less workspaces', () => {
  const workspaces = [
    ws('a', '/a', ['sa']),
    ws('b', '/b', ['sb']),
    ws('empty', '/empty', []),
  ]
  const plan = planReorder(workspaces, new Map([['sa', 100], ['sb', 100]]), new Map())
  assert.deepEqual(plan.order, ['a', 'b', 'empty'])
  assert.deepEqual(plan.moves, [])
})

test('planReorder produces at most m-1 moves for m workspaces and always replays', () => {
  // Reverse-sorted chain: worst case for a fixed-prefix strategy.
  const workspaces = [
    ws('w1', '/w1', ['s1']),
    ws('w2', '/w2', ['s2']),
    ws('w3', '/w3', ['s3']),
    ws('w4', '/w4', ['s4']),
    ws('nested', '/w1/nested', ['s5']),
  ]
  const activity = new Map([['s1', 10], ['s2', 20], ['s3', 30], ['s4', 40], ['s5', 50]])
  const plan = planReorder(workspaces, activity, new Map())
  assert.ok(plan.moves.length <= 4, 'at most m-1 = 4 moves for 5 workspaces')
  assert.deepEqual(applyMoves(['w1', 'w2', 'w3', 'w4', 'nested'], plan.moves), plan.order)
})

test('outermost scope leaves nested-only changes alone', () => {
  const workspaces = [
    ws('parent', '/parent', ['s-parent']),
    ws('child', '/parent/child', ['s-child']),
  ]
  // s-child activity ranks only the nested child workspace; with the
  // outermost scope there are no participating changes, so nothing moves.
  const plan = planReorder(
    workspaces,
    new Map([['s-child', 500], ['s-parent', 100]]),
    new Map(),
    { scope: 'outermost' },
  )
  assert.deepEqual(plan.moves, [])
  assert.deepEqual(plan.order, ['parent', 'child'])
})
