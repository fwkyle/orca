import { describe, expect, it, vi } from 'vitest'
import {
  approveOrchestrationSessionGcPreview,
  countRemainingSessionSurfaces,
  executeOrchestrationSessionGc,
  previewOrchestrationSessionGc,
  sessionGcCandidateIds,
  type SessionGcRosterRecord,
  type SessionGcSessionSurface
} from './orchestration-session-gc'
import {
  SESSION_GC_CANONICAL_SERIALIZATION_VERSION,
  serializeSessionGcCanonical,
  sessionSurfaceId
} from './orchestration-session-gc-fingerprint'

const SCOPE = { project: 'orca', board: 'improvement-1', runId: 'run-ended' } as const
const PANE_GIT = 'tab-git:11111111-1111-4111-8111-111111111111'
const PANE_FOLDER = 'tab-folder:22222222-2222-4222-8222-222222222222'
const PANE_SSH = 'tab-ssh:33333333-3333-4333-8333-333333333333'
const PANE_ACTIVE = 'tab-active:44444444-4444-4444-8444-444444444444'
const PANE_OTHER = 'tab-other:55555555-5555-4555-8555-555555555555'
const LEGACY_SEPARATOR = '\u001f'

function roster(
  id: string,
  pane: string,
  overrides: Partial<SessionGcRosterRecord> = {}
): SessionGcRosterRecord {
  return {
    id,
    pane,
    worktree: 'worktree:target',
    project: SCOPE.project,
    board: SCOPE.board,
    role: id,
    runId: SCOPE.runId,
    lifecycle: 'retired',
    ...overrides
  }
}

function session(
  sessionId: string,
  paneKey: string,
  overrides: Partial<SessionGcSessionSurface> = {}
): SessionGcSessionSurface {
  return {
    sessionId,
    tabId: sessionId,
    paneKey,
    worktreeId: 'worktree:target',
    workspaceKind: 'git-worktree',
    connectionId: null,
    ownership: 'orchestration',
    ...overrides
  }
}

function legacySessionSurfaceId(surface: SessionGcSessionSurface): string {
  return [
    surface.workspaceKind,
    surface.worktreeId,
    surface.connectionId ?? '',
    surface.sessionId,
    surface.tabId,
    surface.paneKey,
    surface.ownership
  ].join(LEGACY_SEPARATOR)
}

function legacyRosterRecordId(record: SessionGcRosterRecord): string {
  return [
    record.id,
    record.project,
    record.board,
    record.runId,
    record.role,
    record.pane,
    record.worktree ?? '',
    record.lifecycle,
    record.status ?? ''
  ].join(LEGACY_SEPARATOR)
}

function legacyPreviewFingerprint(
  surface: SessionGcSessionSurface,
  record: SessionGcRosterRecord
): string {
  return [
    'v1',
    SCOPE.project,
    SCOPE.board,
    SCOPE.runId,
    legacySessionSurfaceId(surface),
    legacyRosterRecordId(record),
    [legacySessionSurfaceId(surface), record.id].join(LEGACY_SEPARATOR)
  ].join(LEGACY_SEPARATOR)
}

describe('orchestration session GC contract', () => {
  it('preserves type, length, controls, null, empty values, and field boundaries', () => {
    const separator = LEGACY_SEPARATOR
    const serialized = [
      serializeSessionGcCanonical({ value: 'line\u0000break' }),
      serializeSessionGcCanonical({ value: `line${separator}break` }),
      serializeSessionGcCanonical({ value: '' }),
      serializeSessionGcCanonical({ value: null }),
      serializeSessionGcCanonical({ first: `left${separator}right`, second: 'tail' }),
      serializeSessionGcCanonical({ first: 'left', second: `right${separator}tail` })
    ]

    expect(new Set(serialized).size).toBe(serialized.length)
    expect(
      serialized.every((value) =>
        value.startsWith(`session-gc-canonical-v${SESSION_GC_CANONICAL_SERIALIZATION_VERSION}:`)
      )
    ).toBe(true)
    expect(sessionSurfaceId(session('null-connection', PANE_GIT, { connectionId: null }))).not.toBe(
      sessionSurfaceId(session('empty-connection', PANE_GIT, { connectionId: '' }))
    )
  })

  it('rejects a legacy delimiter collision before invoking the executor', async () => {
    const firstSurface = session('collision-session', PANE_GIT, {
      worktreeId: `${PANE_GIT}${LEGACY_SEPARATOR}${PANE_GIT}`,
      connectionId: 'provider'
    })
    const secondSurface = session('collision-session', PANE_GIT, {
      worktreeId: PANE_GIT,
      connectionId: `${PANE_GIT}${LEGACY_SEPARATOR}provider`
    })
    const firstRoster = roster('collision-roster', PANE_GIT, {
      role: 'worker',
      worktree: firstSurface.worktreeId
    })
    const secondRoster = roster('collision-roster', PANE_GIT, {
      role: `worker${LEGACY_SEPARATOR}${PANE_GIT}`,
      worktree: secondSurface.worktreeId
    })

    expect(legacySessionSurfaceId(firstSurface)).toBe(legacySessionSurfaceId(secondSurface))
    expect(legacyRosterRecordId(firstRoster)).toBe(legacyRosterRecordId(secondRoster))
    expect(legacyPreviewFingerprint(firstSurface, firstRoster)).toBe(
      legacyPreviewFingerprint(secondSurface, secondRoster)
    )

    const firstPreview = previewOrchestrationSessionGc({
      scope: SCOPE,
      sessions: [firstSurface],
      rosters: [firstRoster]
    })
    const secondPreview = previewOrchestrationSessionGc({
      scope: SCOPE,
      sessions: [secondSurface],
      rosters: [secondRoster]
    })
    expect(firstPreview.candidates[0]?.id).not.toBe(secondPreview.candidates[0]?.id)
    expect(firstPreview.fingerprint).not.toBe(secondPreview.fingerprint)

    const approval = approveOrchestrationSessionGcPreview(firstPreview, {
      confirmedBy: 'kyle',
      confirmedAt: 500
    })
    const executeCandidates = vi.fn()
    await expect(
      executeOrchestrationSessionGc({
        preview: firstPreview,
        approval,
        sessions: [secondSurface],
        rosters: [secondRoster],
        executeCandidates
      })
    ).rejects.toThrow('session_gc_preview_stale')
    expect(executeCandidates).not.toHaveBeenCalled()
  })

  it('previews only retired exact-scope sessions across git, folder, and SSH workspaces', () => {
    const sessions = [
      session('git-session', PANE_GIT),
      session('folder-session', PANE_FOLDER, {
        workspaceKind: 'folder-workspace',
        worktreeId: 'folder:folder-1'
      }),
      session('ssh-session', PANE_SSH, {
        workspaceKind: 'ssh',
        worktreeId: 'ssh-workspace-1',
        connectionId: 'ssh-connection-1'
      }),
      session('active-session', PANE_ACTIVE),
      session('other-session', PANE_OTHER)
    ]
    const rosters = [
      roster('roster-git', PANE_GIT),
      roster('roster-folder', PANE_FOLDER, { worktree: 'folder:folder-1' }),
      roster('roster-ssh', PANE_SSH, { worktree: 'ssh-workspace-1' }),
      roster('roster-active', PANE_ACTIVE, { lifecycle: 'active' }),
      roster('roster-other', PANE_OTHER, { board: 'other-board' })
    ]

    const preview = previewOrchestrationSessionGc({ scope: SCOPE, sessions, rosters })

    expect(preview.candidates.map((candidate) => candidate.sessionId)).toEqual([
      'folder-session',
      'git-session',
      'ssh-session'
    ])
    expect(preview.candidateCount).toBe(3)
    expect(preview.sourceSessionCount).toBe(5)
    expect(preview.remainingSessionCount).toBe(2)
    expect(preview.candidates[0]).not.toHaveProperty('handle')
    expect(preview.candidates.every((candidate) => candidate.runId === SCOPE.runId)).toBe(true)
    expect(preview.candidates.every((candidate) => candidate.board === SCOPE.board)).toBe(true)
  })

  it('fails closed for user-owned, unknown-owner, and ambiguous session surfaces', () => {
    const userPane = 'tab-user:66666666-6666-4666-8666-666666666666'
    const unknownPane = 'tab-unknown:77777777-7777-4777-8777-777777777777'
    const ambiguousPane = 'tab-ambiguous:88888888-8888-4888-8888-888888888888'
    const sessions = [
      session('user-session', userPane, { ownership: 'user' }),
      session('unknown-session', unknownPane, { ownership: 'unknown' }),
      session('ambiguous-a', ambiguousPane),
      session('ambiguous-b', ambiguousPane)
    ]
    const rosters = [
      roster('roster-user', userPane),
      roster('roster-unknown', unknownPane),
      roster('roster-ambiguous', ambiguousPane)
    ]

    const preview = previewOrchestrationSessionGc({ scope: SCOPE, sessions, rosters })

    expect(preview.candidates).toEqual([])
    expect(preview.skipped.map((surface) => surface.reason)).toEqual([
      'ambiguous-session',
      'ambiguous-session',
      'unknown-owner',
      'user-owned'
    ])
  })

  it('uses stable pane equivalence but never widens project, board, or Run scope', () => {
    const remintedPane = 'new-tab:99999999-9999-4999-8999-999999999999'
    const sessionRow = session('reminted-session', remintedPane)
    const targetRoster = roster('roster-reminted', `old-tab:${remintedPane.split(':')[1]}`)
    const otherRunRoster = roster('roster-other-run', remintedPane, { runId: 'run-other' })

    const preview = previewOrchestrationSessionGc({
      scope: SCOPE,
      sessions: [sessionRow],
      rosters: [targetRoster, otherRunRoster]
    })

    expect(preview.candidates).toEqual([])
    expect(preview.skipped).toEqual([expect.objectContaining({ reason: 'ambiguous-roster' })])
  })

  it('rejects a pane that moved to a different workspace instead of guessing ownership', () => {
    const pane = 'tab-moved:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const preview = previewOrchestrationSessionGc({
      scope: SCOPE,
      sessions: [session('moved-session', pane, { worktreeId: 'worktree:new' })],
      rosters: [roster('roster-moved', pane, { worktree: 'worktree:old' })]
    })

    expect(preview.candidates).toEqual([])
    expect(preview.skipped).toEqual([
      expect.objectContaining({ sessionId: 'moved-session', reason: 'worktree-mismatch' })
    ])
  })

  it('does not select a provider session shared by another workspace', () => {
    const sharedSessionId = 'shared-provider-session'
    const targetPane = 'tab-target:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const otherPane = 'tab-other:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const preview = previewOrchestrationSessionGc({
      scope: SCOPE,
      sessions: [
        session(sharedSessionId, targetPane),
        session(sharedSessionId, otherPane, {
          workspaceKind: 'folder-workspace',
          worktreeId: 'folder:other'
        })
      ],
      rosters: [
        roster('roster-shared-target', targetPane),
        roster('roster-shared-other', otherPane, { worktree: 'folder:other' })
      ]
    })

    expect(preview.candidates).toEqual([])
    expect(preview.skipped).toHaveLength(2)
    expect(preview.skipped.every((surface) => surface.reason === 'duplicate-session')).toBe(true)
  })

  it('does not guess the current workspace for null or unknown roster worktrees', () => {
    const nullWorktreePane = 'tab-null-worktree:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const unknownWorktreePane = 'tab-unknown-worktree:ffffffff-ffff-4fff-8fff-ffffffffffff'
    const preview = previewOrchestrationSessionGc({
      scope: SCOPE,
      sessions: [
        session('null-worktree-session', nullWorktreePane),
        session('unknown-worktree-session', unknownWorktreePane)
      ],
      rosters: [
        roster('roster-null-worktree', nullWorktreePane, { worktree: null }),
        roster('roster-unknown-worktree', unknownWorktreePane, { worktree: 'unknown' })
      ]
    })

    expect(preview.candidates).toEqual([])
    expect(preview.skipped).toEqual([
      expect.objectContaining({ sessionId: 'null-worktree-session', reason: 'unknown-worktree' }),
      expect.objectContaining({
        sessionId: 'unknown-worktree-session',
        reason: 'unknown-worktree'
      })
    ])
  })

  it('keeps a retired row from claiming a pane held by another active Run', () => {
    const pane = 'tab-reused:dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const preview = previewOrchestrationSessionGc({
      scope: SCOPE,
      sessions: [session('reused-session', pane)],
      rosters: [
        roster('roster-retired', pane),
        roster('roster-active-other-run', pane, {
          runId: 'run-live',
          lifecycle: 'active',
          status: 'active'
        })
      ]
    })

    expect(preview.candidates).toEqual([])
    expect(preview.skipped).toEqual([expect.objectContaining({ reason: 'active-roster' })])
  })

  it('requires kyle confirmation and binds approval to the exact preview', () => {
    const preview = previewOrchestrationSessionGc({
      scope: SCOPE,
      sessions: [session('git-session', PANE_GIT)],
      rosters: [roster('roster-git', PANE_GIT)]
    })

    expect(() =>
      approveOrchestrationSessionGcPreview(preview, {
        confirmedBy: 'someone-else',
        confirmedAt: 100
      })
    ).toThrow('session_gc_kyle_confirmation_required')

    const approval = approveOrchestrationSessionGcPreview(preview, {
      confirmedBy: 'KYLE',
      confirmedAt: 100
    })
    expect(approval).toEqual({
      contractVersion: 1,
      previewFingerprint: preview.fingerprint,
      confirmedBy: 'kyle',
      confirmedAt: 100
    })
  })

  it('executes exactly the approved list and leaves other board/run sessions counted', async () => {
    const sessions = [session('git-session', PANE_GIT), session('other-session', PANE_OTHER)]
    const rosters = [
      roster('roster-git', PANE_GIT),
      roster('roster-other', PANE_OTHER, { runId: 'run-other' })
    ]
    const preview = previewOrchestrationSessionGc({ scope: SCOPE, sessions, rosters })
    const approval = approveOrchestrationSessionGcPreview(preview, {
      confirmedBy: 'kyle',
      confirmedAt: 200
    })
    const executeCandidates = vi.fn()

    const receipt = await executeOrchestrationSessionGc({
      preview,
      approval,
      sessions,
      rosters,
      executeCandidates
    })

    expect(executeCandidates).toHaveBeenCalledOnce()
    expect(executeCandidates).toHaveBeenCalledWith(preview.candidates)
    expect(receipt.executedCandidateIds).toEqual([preview.candidates[0]?.id])
    expect(receipt.expectedRemainingSessionCount).toBe(1)
    expect(countRemainingSessionSurfaces(sessions, sessionGcCandidateIds(preview.candidates))).toBe(
      1
    )
  })

  it('rejects a changed exact list before invoking the executor', async () => {
    const sessions = [session('git-session', PANE_GIT)]
    const rosters = [roster('roster-git', PANE_GIT)]
    const preview = previewOrchestrationSessionGc({ scope: SCOPE, sessions, rosters })
    const approval = approveOrchestrationSessionGcPreview(preview, {
      confirmedBy: 'kyle',
      confirmedAt: 300
    })
    const executeCandidates = vi.fn()

    await expect(
      executeOrchestrationSessionGc({
        preview,
        approval,
        sessions: [...sessions, session('new-session', PANE_ACTIVE)],
        rosters: [...rosters, roster('roster-new', PANE_ACTIVE)],
        executeCandidates
      })
    ).rejects.toThrow('session_gc_preview_stale')
    expect(executeCandidates).not.toHaveBeenCalled()
  })

  it('rejects tab, pane, workspace, connection, and session identity drift before execution', async () => {
    const originalSession = session('identity-session', PANE_GIT, { connectionId: 'provider-a' })
    const sessions = [originalSession]
    const rosters = [roster('roster-identity', PANE_GIT)]
    const preview = previewOrchestrationSessionGc({ scope: SCOPE, sessions, rosters })
    const approval = approveOrchestrationSessionGcPreview(preview, {
      confirmedBy: 'kyle',
      confirmedAt: 400
    })
    const changedSessions: SessionGcSessionSurface[] = [
      { ...originalSession, tabId: 'tab-renamed' },
      { ...originalSession, paneKey: 'tab-reminted:11111111-1111-4111-8111-111111111111' },
      { ...originalSession, worktreeId: 'worktree:moved' },
      { ...originalSession, connectionId: 'provider-b' },
      { ...originalSession, sessionId: 'identity-session-replaced' }
    ]

    for (const changedSession of changedSessions) {
      const executeCandidates = vi.fn()
      await expect(
        executeOrchestrationSessionGc({
          preview,
          approval,
          sessions: [changedSession],
          rosters,
          executeCandidates
        })
      ).rejects.toThrow('session_gc_preview_stale')
      expect(executeCandidates).not.toHaveBeenCalled()
    }
  })
})
