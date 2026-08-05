import { parsePaneKey } from './stable-pane-id'
import type {
  SessionGcCandidate,
  SessionGcRosterRecord,
  SessionGcScope,
  SessionGcSessionSurface,
  SessionGcSkippedSurface
} from './orchestration-session-gc'
import {
  compareCandidates,
  compareSkipped,
  providerSessionId,
  sessionSurfaceId,
  sortSessions
} from './orchestration-session-gc-fingerprint'

const UNKNOWN_WORKTREE_VALUES = new Set(['', 'null', 'undefined', 'unknown'])

function hasKnownWorktree(value: string | null | undefined): value is string {
  return typeof value === 'string' && !UNKNOWN_WORKTREE_VALUES.has(value.trim().toLowerCase())
}

function paneKeysEquivalent(left: string, right: string): boolean {
  if (left === right) {
    return true
  }
  const leftLeaf = parsePaneKey(left)?.leafId
  const rightLeaf = parsePaneKey(right)?.leafId
  return Boolean(leftLeaf && rightLeaf && leftLeaf === rightLeaf)
}

function sessionMatchesRoster(
  session: SessionGcSessionSurface,
  roster: SessionGcRosterRecord
): boolean {
  return paneKeysEquivalent(session.paneKey, roster.pane)
}

function candidateFrom(
  session: SessionGcSessionSurface,
  roster: SessionGcRosterRecord
): SessionGcCandidate {
  return {
    ...session,
    id: sessionSurfaceId(session),
    rosterId: roster.id,
    role: roster.role,
    project: roster.project,
    board: roster.board,
    runId: roster.runId
  }
}

function isInScope(record: SessionGcRosterRecord, scope: SessionGcScope): boolean {
  return (
    record.project === scope.project && record.board === scope.board && record.runId === scope.runId
  )
}

/**
 * Matches live surfaces against official lifecycle rows without selecting a
 * handle, changing a row, or widening beyond one project/board/Run scope.
 */
export function collectSessionGcCandidates(args: {
  scope: SessionGcScope
  sessions: readonly SessionGcSessionSurface[]
  rosters: readonly SessionGcRosterRecord[]
}): { candidates: SessionGcCandidate[]; skipped: SessionGcSkippedSurface[] } {
  const targetRosters = args.rosters.filter(
    (roster) =>
      isInScope(roster, args.scope) &&
      roster.lifecycle === 'retired' &&
      (roster.status === undefined || roster.status === 'retired')
  )
  const sortedSessions = sortSessions(args.sessions)
  const matchingRostersBySessionId = new Map<string, SessionGcRosterRecord[]>()
  const allMatchingRostersBySessionId = new Map<string, SessionGcRosterRecord[]>()
  const matchingSessionsByRosterId = new Map<string, SessionGcSessionSurface[]>()
  const providerSessionCounts = new Map<string, number>()

  for (const session of sortedSessions) {
    const providerId = providerSessionId(session)
    providerSessionCounts.set(providerId, (providerSessionCounts.get(providerId) ?? 0) + 1)
    const matchingRosters = targetRosters.filter((roster) => sessionMatchesRoster(session, roster))
    const sessionId = sessionSurfaceId(session)
    const allMatchingRosters = args.rosters.filter((roster) =>
      sessionMatchesRoster(session, roster)
    )
    const knownRosters = matchingRostersBySessionId.get(sessionId) ?? []
    const knownAllRosters = allMatchingRostersBySessionId.get(sessionId) ?? []
    matchingRostersBySessionId.set(sessionId, [
      ...knownRosters,
      ...matchingRosters.filter((roster) => !knownRosters.includes(roster))
    ])
    allMatchingRostersBySessionId.set(sessionId, [
      ...knownAllRosters,
      ...allMatchingRosters.filter((roster) => !knownAllRosters.includes(roster))
    ])
    for (const roster of matchingRosters) {
      const matches = matchingSessionsByRosterId.get(roster.id) ?? []
      matches.push(session)
      matchingSessionsByRosterId.set(roster.id, matches)
    }
  }

  const candidates: SessionGcCandidate[] = []
  const skipped: SessionGcSkippedSurface[] = []
  const sessionIdCounts = new Map<string, number>()
  for (const session of sortedSessions) {
    const id = sessionSurfaceId(session)
    sessionIdCounts.set(id, (sessionIdCounts.get(id) ?? 0) + 1)
  }
  for (const session of sortedSessions) {
    const id = sessionSurfaceId(session)
    const matchingRosters = matchingRostersBySessionId.get(id) ?? []
    if (matchingRosters.length === 0) {
      continue
    }
    if ((sessionIdCounts.get(id) ?? 0) > 1) {
      skipped.push({ ...session, reason: 'duplicate-session' })
      continue
    }
    if (providerSessionCounts.get(providerSessionId(session)) !== 1) {
      skipped.push({ ...session, reason: 'duplicate-session' })
      continue
    }
    const allMatchingRosters = allMatchingRostersBySessionId.get(id) ?? []
    if (
      allMatchingRosters.some(
        (roster) => roster.lifecycle === 'active' || roster.status === 'active'
      )
    ) {
      skipped.push({ ...session, reason: 'active-roster' })
      continue
    }
    if (allMatchingRosters.length > 1 || matchingRosters.length > 1) {
      skipped.push({ ...session, reason: 'ambiguous-roster' })
      continue
    }
    const roster = matchingRosters[0]!
    const matchingSessions = matchingSessionsByRosterId.get(roster.id) ?? []
    if (matchingSessions.length !== 1) {
      skipped.push({ ...session, reason: 'ambiguous-session' })
      continue
    }
    if (!hasKnownWorktree(roster.worktree) || !hasKnownWorktree(session.worktreeId)) {
      skipped.push({ ...session, reason: 'unknown-worktree' })
      continue
    }
    if (roster.worktree !== session.worktreeId) {
      skipped.push({ ...session, reason: 'worktree-mismatch' })
      continue
    }
    if (session.ownership === 'user') {
      skipped.push({ ...session, reason: 'user-owned' })
      continue
    }
    if (session.ownership !== 'orchestration') {
      skipped.push({ ...session, reason: 'unknown-owner' })
      continue
    }
    candidates.push(candidateFrom(session, roster))
  }

  candidates.sort(compareCandidates)
  skipped.sort(compareSkipped)
  return { candidates, skipped }
}
