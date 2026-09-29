/**
 * dsh-workspace-auto-sort — pure ordering logic.
 *
 * Everything here is synchronous and side-effect free so node:test can cover
 * every branch without a host. The host half (./index.js) feeds it the live
 * workspace projection plus the activity/fallback timestamp maps and applies
 * the returned move list through `workspaceRegistry.insertBefore`.
 */

/**
 * Normalize separators for ancestor comparison without interpreting POSIX
 * backslashes as separators. Mirrors ui-workspace's `folderPath`: a Windows
 * path (drive letter or UNC) gets its backslashes folded to slashes; every
 * path loses trailing slashes. Case-sensitive, like workspace identity.
 * @param {string} path - Workspace directory path in host spelling.
 * @returns {string} comparison spelling with forward slashes and no trailing slashes.
 */
export function normalizeFolderPath(path) {
  const windows = /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\')
  const slashed = windows ? path.replaceAll('\\', '/') : path
  return slashed.replace(/\/+$/, '')
}

/**
 * Find the nearest registered ancestor of one path, excluding the path's own
 * workspace. Mirrors ui-workspace's `owningParentFolder`: containment requires
 * the child to start with `root + '/'`, so sibling directories sharing a
 * string prefix never nest into each other.
 * @param {string} path - Workspace directory to place.
 * @param {readonly string[]} parents - Registered workspace directory paths.
 * @returns {string | undefined} The owning parent path, or undefined when no
 *   registered workspace contains this one.
 */
export function parentFolderPath(path, parents) {
  const child = normalizeFolderPath(path)
  let owner
  let length = -1
  for (const parent of parents) {
    const root = normalizeFolderPath(parent)
    if (root.length > length && child !== root && child.startsWith(`${root}/`)) {
      owner = parent
      length = root.length
    }
  }
  return owner
}

/**
 * Recency rank of one workspace: the newest activity among its accounted
 * sessions. Each session falls back activity → persisted header creation time
 * → 0, so a never-run session still sorts by its birth and a workspace whose
 * sessions are all unknown sinks below every ranked one.
 * @param {readonly string[]} sessionIds - Accounted session ids (may be empty).
 * @param {ReadMap} lastActivity - Session id → last committed event time (epoch ms).
 * @param {ReadMap} fallbackTimes - Session id → persisted header createdAt (epoch ms).
 * @returns {number} The workspace rank.
 *
 * @typedef {Map<string, number>} ReadMap
 */
export function rankWorkspace(sessionIds, lastActivity, fallbackTimes) {
  let rank = 0
  for (const id of sessionIds) {
    const time = lastActivity.get(id) ?? fallbackTimes.get(id) ?? 0
    if (time > rank) rank = time
  }
  return rank
}

/**
 * Plan the durable order rewrite that sorts workspaces by child-session
 * recency. With scope 'all' (the default, matching the sidebar the user
 * actually sees — nesting there is an opt-in view option) every workspace
 * participates; with scope 'outermost' only entries without a registered
 * path ancestor participate, and non-participating entries keep their
 * relative order and are never named as a moved id or anchor.
 *
 * The moves are planned on the participating subsequence alone and replay
 * through the registry's DOM-insertBefore-like `insertBefore(id, beforeId?)`:
 * move k inserts the wanted workspace before the current occupant of
 * subsequence slot k, so each move grows the fixed prefix by one and the
 * whole plan needs at most m-1 moves for m participants. Replaying on the
 * full list moves non-participants' flat indexes as participants travel past
 * them, which cannot change their rendered position inside a parent subtree.
 * @param {readonly PlanWorkspace[]} workspaces - Live workspace projection in
 *   current registry order.
 * @param {ReadMap} lastActivity - Session id → last committed event time.
 * @param {ReadMap} fallbackTimes - Session id → persisted header createdAt.
 * @param {{ scope?: 'all' | 'outermost' }} [options] - Participation scope.
 * @returns {Plan} The replayed order and the move list; `moves` is empty when
 *   the participating subsequence is already sorted.
 *
 * @typedef {{ id: string, path: string, sessionIds: readonly string[] }} PlanWorkspace
 * @typedef {{ order: readonly string[], moves: readonly PlanMove[] }} Plan
 * @typedef {{ id: string, beforeId: string }} PlanMove
 */
export function planReorder(workspaces, lastActivity, fallbackTimes, options = {}) {
  const scope = options.scope === 'outermost' ? 'outermost' : 'all'
  const current = workspaces.map(workspace => workspace.id)
  const paths = workspaces.map(workspace => workspace.path)
  let participants
  if (scope === 'all') {
    participants = current
  } else {
    const nestedPaths = new Set()
    for (const path of paths) {
      if (parentFolderPath(path, paths) !== undefined) nestedPaths.add(path)
    }
    participants = current.filter((id, index) => !nestedPaths.has(paths[index]))
  }

  const rankById = new Map(workspaces.map(workspace => [
    workspace.id,
    rankWorkspace(workspace.sessionIds, lastActivity, fallbackTimes),
  ]))
  const sorted = participants.map(id => ({ id, rank: rankById.get(id) ?? 0 }))
    .sort((left, right) => right.rank - left.rank)
    .map(entry => entry.id)

  let differs = false
  for (let index = 0; index < participants.length; index++) {
    if (participants[index] !== sorted[index]) {
      differs = true
      break
    }
  }
  if (!differs) return { order: current, moves: [] }

  const sim = [...participants]
  const moves = []
  for (let slot = 0; slot < sorted.length; slot++) {
    // Subsequence slots below `slot` already equal the target, and `sorted`
    // is a permutation of `participants`, so the wanted id sits after `slot`.
    while (sim[slot] !== sorted[slot]) {
      const id = sorted[slot]
      moves.push({ id, beforeId: sim[slot] })
      sim.splice(sim.indexOf(id), 1)
      sim.splice(slot, 0, id)
    }
  }

  // Replay the moves over the full current list to report the exact order a
  // compliant registry ends up with.
  const order = [...current]
  for (const { id, beforeId } of moves) {
    order.splice(order.indexOf(id), 1)
    order.splice(order.indexOf(beforeId), 0, id)
  }
  return { order, moves }
}
