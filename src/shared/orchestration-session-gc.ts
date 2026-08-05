import { buildPreviewFingerprint, sessionSurfaceId } from './orchestration-session-gc-fingerprint'
import { collectSessionGcCandidates } from './orchestration-session-gc-matching'

export const ORCHESTRATION_SESSION_GC_CONTRACT_VERSION = 1 as const

export type SessionGcLifecycle = 'active' | 'stale' | 'inactive' | 'retired'

export type SessionGcWorkspaceKind = 'git-worktree' | 'folder-workspace' | 'ssh'

export type SessionGcOwnership = 'orchestration' | 'user' | 'unknown'

export type SessionGcScope = {
  project: string
  board: string
  runId: string
}

/** Read-only projection; only the official `retired` lifecycle is eligible. */
export type SessionGcRosterRecord = {
  id: string
  pane: string
  worktree: string | null
  project: string
  board: string
  role: string
  runId: string
  lifecycle: SessionGcLifecycle
  status?: SessionGcLifecycle
}

/** One session surface observed in the current renderer/runtime snapshot. */
export type SessionGcSessionSurface = {
  sessionId: string
  tabId: string
  paneKey: string
  worktreeId: string
  workspaceKind: SessionGcWorkspaceKind
  connectionId: string | null
  ownership: SessionGcOwnership
}

export type SessionGcSkipReason =
  | 'ambiguous-roster'
  | 'active-roster'
  | 'ambiguous-session'
  | 'user-owned'
  | 'unknown-owner'
  | 'duplicate-session'
  | 'unknown-worktree'
  | 'worktree-mismatch'

export type SessionGcSkippedSurface = SessionGcSessionSurface & {
  reason: SessionGcSkipReason
}

export type SessionGcCandidate = SessionGcSessionSurface & {
  id: string
  rosterId: string
  role: string
  project: string
  board: string
  runId: string
}

export type SessionGcPreview = {
  contractVersion: typeof ORCHESTRATION_SESSION_GC_CONTRACT_VERSION
  scope: SessionGcScope
  sourceSessionCount: number
  candidateCount: number
  remainingSessionCount: number
  candidates: readonly SessionGcCandidate[]
  skipped: readonly SessionGcSkippedSurface[]
  fingerprint: string
}

export type SessionGcApproval = {
  contractVersion: typeof ORCHESTRATION_SESSION_GC_CONTRACT_VERSION
  previewFingerprint: string
  confirmedBy: 'kyle'
  confirmedAt: number
}

export type SessionGcConfirmation = {
  confirmedBy: string
  confirmedAt: number
}

export type SessionGcExecutionReceipt = {
  contractVersion: typeof ORCHESTRATION_SESSION_GC_CONTRACT_VERSION
  previewFingerprint: string
  executedCandidateIds: readonly string[]
  expectedRemainingSessionCount: number
}

function requireScopeValue(value: string, name: keyof SessionGcScope): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`session_gc_${name}_required`)
  }
  return trimmed
}

function normalizeScope(scope: SessionGcScope): SessionGcScope {
  return {
    project: requireScopeValue(scope.project, 'project'),
    board: requireScopeValue(scope.board, 'board'),
    runId: requireScopeValue(scope.runId, 'runId')
  }
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Builds the only list that a later executor may receive. This function is
 * deliberately read-only: it does not touch the roster, tabs, PTYs, or DB.
 */
export function previewOrchestrationSessionGc(args: {
  scope: SessionGcScope
  sessions: readonly SessionGcSessionSurface[]
  rosters: readonly SessionGcRosterRecord[]
}): SessionGcPreview {
  const scope = normalizeScope(args.scope)
  const { candidates, skipped } = collectSessionGcCandidates({
    scope,
    sessions: args.sessions,
    rosters: args.rosters
  })
  const candidateIds = new Set(candidates.map((candidate) => candidate.id))
  const preview: SessionGcPreview = {
    contractVersion: ORCHESTRATION_SESSION_GC_CONTRACT_VERSION,
    scope,
    sourceSessionCount: new Set(args.sessions.map(sessionSurfaceId)).size,
    candidateCount: candidates.length,
    remainingSessionCount: countRemainingSessionSurfaces(args.sessions, candidateIds),
    candidates,
    skipped,
    fingerprint: ''
  }
  preview.fingerprint = buildPreviewFingerprint({
    contractVersion: ORCHESTRATION_SESSION_GC_CONTRACT_VERSION,
    scope,
    sessions: args.sessions,
    rosters: args.rosters,
    candidates,
    skipped
  })
  return preview
}

/**
 * Counts the same source snapshot used by preview. Sidebar badges must use
 * this exact set difference, never the number of roster rows or stale tasks.
 */
export function countRemainingSessionSurfaces(
  sessions: readonly SessionGcSessionSurface[],
  candidateIds: ReadonlySet<string>
): number {
  const remainingIds = new Set<string>()
  for (const session of sessions) {
    const id = sessionSurfaceId(session)
    if (!candidateIds.has(id)) {
      remainingIds.add(id)
    }
  }
  return remainingIds.size
}

export function approveOrchestrationSessionGcPreview(
  preview: SessionGcPreview,
  confirmation: SessionGcConfirmation
): SessionGcApproval {
  if (confirmation.confirmedBy.trim().toLowerCase() !== 'kyle') {
    throw new Error('session_gc_kyle_confirmation_required')
  }
  if (!Number.isFinite(confirmation.confirmedAt) || confirmation.confirmedAt < 0) {
    throw new Error('session_gc_confirmation_timestamp_invalid')
  }
  return {
    contractVersion: ORCHESTRATION_SESSION_GC_CONTRACT_VERSION,
    previewFingerprint: preview.fingerprint,
    confirmedBy: 'kyle',
    confirmedAt: confirmation.confirmedAt
  }
}

/**
 * Rechecks the exact preview before invoking the injected executor. Production
 * wiring is intentionally absent in this card; tests may inject a recorder.
 */
export async function executeOrchestrationSessionGc(args: {
  preview: SessionGcPreview
  approval: SessionGcApproval
  sessions: readonly SessionGcSessionSurface[]
  rosters: readonly SessionGcRosterRecord[]
  executeCandidates: (candidates: readonly SessionGcCandidate[]) => void | Promise<void>
}): Promise<SessionGcExecutionReceipt> {
  if (
    args.approval.contractVersion !== ORCHESTRATION_SESSION_GC_CONTRACT_VERSION ||
    args.approval.confirmedBy !== 'kyle' ||
    args.approval.previewFingerprint !== args.preview.fingerprint
  ) {
    throw new Error('session_gc_approval_mismatch')
  }

  const current = previewOrchestrationSessionGc({
    scope: args.preview.scope,
    sessions: args.sessions,
    rosters: args.rosters
  })
  const expectedIds = args.preview.candidates.map((candidate) => candidate.id)
  const currentIds = current.candidates.map((candidate) => candidate.id)
  if (
    current.fingerprint !== args.preview.fingerprint ||
    !sameStringList(currentIds, expectedIds)
  ) {
    throw new Error('session_gc_preview_stale')
  }

  await args.executeCandidates(current.candidates)
  const executedCandidateIds = current.candidates.map((candidate) => candidate.id)
  return {
    contractVersion: ORCHESTRATION_SESSION_GC_CONTRACT_VERSION,
    previewFingerprint: args.preview.fingerprint,
    executedCandidateIds,
    expectedRemainingSessionCount: current.remainingSessionCount
  }
}

export function sessionGcCandidateIds(
  candidates: readonly SessionGcCandidate[]
): ReadonlySet<string> {
  return new Set(candidates.map((candidate) => candidate.id))
}
