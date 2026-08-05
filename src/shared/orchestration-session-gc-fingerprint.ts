import type {
  SessionGcCandidate,
  SessionGcRosterRecord,
  SessionGcScope,
  SessionGcSessionSurface,
  SessionGcSkippedSurface
} from './orchestration-session-gc'

export const SESSION_GC_CANONICAL_SERIALIZATION_VERSION = 1 as const

export type SessionGcCanonicalValue =
  | undefined
  | null
  | boolean
  | number
  | string
  | readonly SessionGcCanonicalValue[]
  | { readonly [key: string]: SessionGcCanonicalValue }

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function encodeString(value: string): string {
  const payload = JSON.stringify(value)
  return `s${payload}:${payload.length}`
}

function encodeNumber(value: number): string {
  const payload = Number.isNaN(value)
    ? 'NaN'
    : value === Infinity
      ? 'Infinity'
      : value === -Infinity
        ? '-Infinity'
        : Object.is(value, -0)
          ? '-0'
          : String(value)
  return `d${payload}:${payload.length}`
}

function encodeCanonicalValue(value: SessionGcCanonicalValue): string {
  if (value === undefined) {
    return 'u0:'
  }
  if (value === null) {
    return 'n0:'
  }
  if (typeof value === 'string') {
    return encodeString(value)
  }
  if (typeof value === 'boolean') {
    return `b${value ? '1' : '0'}:1`
  }
  if (typeof value === 'number') {
    return encodeNumber(value)
  }
  if (Array.isArray(value)) {
    const payload = value.map(encodeCanonicalValue).join('')
    return `a${value.length}:${payload}`
  }

  const keys = Object.keys(value).sort(compareStrings)
  const payload = keys
    .map((key) => `${encodeString(key)}${encodeCanonicalValue(value[key])}`)
    .join('')
  return `o${keys.length}:${payload}`
}

function canonicalRecord(
  recordType: string,
  fields: readonly [string, SessionGcCanonicalValue][]
): SessionGcCanonicalValue {
  return {
    recordType,
    fields: fields.map(([name, value]) => ({ name, value }))
  }
}

/** Versioned, typed, length-delimited serialization for every approval input. */
export function serializeSessionGcCanonical(value: SessionGcCanonicalValue): string {
  return `session-gc-canonical-v${SESSION_GC_CANONICAL_SERIALIZATION_VERSION}:${encodeCanonicalValue(value)}`
}

function canonicalSessionSurface(surface: SessionGcSessionSurface): SessionGcCanonicalValue {
  return canonicalRecord('session-surface', [
    ['workspaceKind', surface.workspaceKind],
    ['worktreeId', surface.worktreeId],
    ['connectionId', surface.connectionId],
    ['sessionId', surface.sessionId],
    ['tabId', surface.tabId],
    ['paneKey', surface.paneKey],
    ['ownership', surface.ownership]
  ])
}

function canonicalRosterRecord(record: SessionGcRosterRecord): SessionGcCanonicalValue {
  return canonicalRecord('roster-record', [
    ['id', record.id],
    ['project', record.project],
    ['board', record.board],
    ['runId', record.runId],
    ['role', record.role],
    ['pane', record.pane],
    ['worktree', record.worktree],
    ['lifecycle', record.lifecycle],
    ['status', record.status]
  ])
}

function canonicalCandidate(candidate: SessionGcCandidate): SessionGcCanonicalValue {
  return canonicalRecord('candidate', [
    ['id', candidate.id],
    ['rosterId', candidate.rosterId],
    ['role', candidate.role],
    ['project', candidate.project],
    ['board', candidate.board],
    ['runId', candidate.runId],
    ['surface', canonicalSessionSurface(candidate)]
  ])
}

function canonicalSkippedSurface(surface: SessionGcSkippedSurface): SessionGcCanonicalValue {
  return canonicalRecord('skipped-surface', [
    ['sessionId', surface.sessionId],
    ['tabId', surface.tabId],
    ['paneKey', surface.paneKey],
    ['reason', surface.reason],
    ['workspaceKind', surface.workspaceKind],
    ['worktreeId', surface.worktreeId],
    ['connectionId', surface.connectionId],
    ['ownership', surface.ownership]
  ])
}

function canonicalScope(scope: SessionGcScope): SessionGcCanonicalValue {
  return canonicalRecord('scope', [
    ['project', scope.project],
    ['board', scope.board],
    ['runId', scope.runId]
  ])
}

export function providerSessionId(surface: SessionGcSessionSurface): string {
  return surface.sessionId
}

export function sessionSurfaceId(surface: SessionGcSessionSurface): string {
  return serializeSessionGcCanonical(canonicalSessionSurface(surface))
}

export function rosterRecordId(record: SessionGcRosterRecord): string {
  return serializeSessionGcCanonical(canonicalRosterRecord(record))
}

export function sortSessions(
  sessions: readonly SessionGcSessionSurface[]
): SessionGcSessionSurface[] {
  return [...sessions].sort((left, right) =>
    compareStrings(sessionSurfaceId(left), sessionSurfaceId(right))
  )
}

export function sortRosters(rosters: readonly SessionGcRosterRecord[]): SessionGcRosterRecord[] {
  return [...rosters].sort((left, right) =>
    compareStrings(rosterRecordId(left), rosterRecordId(right))
  )
}

export function compareCandidates(left: SessionGcCandidate, right: SessionGcCandidate): number {
  return compareStrings(left.id, right.id)
}

export function compareSkipped(
  left: SessionGcSkippedSurface,
  right: SessionGcSkippedSurface
): number {
  return compareStrings(
    serializeSessionGcCanonical(canonicalSkippedSurface(left)),
    serializeSessionGcCanonical(canonicalSkippedSurface(right))
  )
}

export function buildPreviewFingerprint(args: {
  contractVersion: number
  scope: SessionGcScope
  sessions: readonly SessionGcSessionSurface[]
  rosters: readonly SessionGcRosterRecord[]
  candidates: readonly SessionGcCandidate[]
  skipped: readonly SessionGcSkippedSurface[]
}): string {
  return serializeSessionGcCanonical({
    recordType: 'preview',
    contractVersion: args.contractVersion,
    scope: canonicalScope(args.scope),
    sessions: sortSessions(args.sessions).map(canonicalSessionSurface),
    rosters: sortRosters(args.rosters).map(canonicalRosterRecord),
    candidates: [...args.candidates].sort(compareCandidates).map(canonicalCandidate),
    skipped: [...args.skipped].sort(compareSkipped).map(canonicalSkippedSurface)
  })
}
