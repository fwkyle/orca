import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupLegacyCompatibilityDispatcherHarnesses,
  COORDINATOR_HANDLE,
  createHarness,
  currentEvidence,
  CURRENT_COORDINATOR_HANDLE,
  CURRENT_COORDINATOR_PANE,
  evidence,
  invoke,
  request
} from './orchestration-legacy-compatibility-dispatcher-test-fixture'

afterEach(() => {
  cleanupLegacyCompatibilityDispatcherHarnesses()
})

describe('legacy coordinator gate run routing', () => {
  it.each(['dispatch', 'websocket'] as const)(
    '%s creates an inbox card for an unbound caller instead of routing to a legacy Run',
    async (transport) => {
      const harness = createHarness()

      const response = await invoke(
        harness.dispatcher,
        request(
          'orchestration.taskCreate',
          {
            spec: 'fresh assignment',
            callerTerminalHandle: CURRENT_COORDINATOR_HANDLE
          },
          currentEvidence('coordinator'),
          `unbound-task-create-${transport}`
        ),
        transport
      )

      expect(response).toMatchObject({
        ok: true,
        result: {
          task: { run_id: null, assignment_state: 'inbox', spec: 'fresh assignment' }
        }
      })
      expect(harness.db.listTasks({ assignmentState: 'inbox' })).toHaveLength(1)
      expect(harness.db.listTasks({ runId: harness.adoptedRunId })).toHaveLength(1)
    }
  )

  it('keeps an inbox card unassigned even when attestation fails', async () => {
    const harness = createHarness()
    const run = harness.db.createRun({
      objective: 'current work',
      coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
      coordinatorPaneKey: CURRENT_COORDINATOR_PANE
    })

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskCreate',
        {
          spec: 'fresh assignment',
          callerTerminalHandle: CURRENT_COORDINATOR_HANDLE
        },
        { ...currentEvidence('coordinator'), launchToken: '' },
        'unattested-bound-task-create'
      )
    )

    expect(response).toMatchObject({
      ok: true,
      result: { task: { run_id: null, assignment_state: 'inbox', spec: 'fresh assignment' } }
    })
    expect(harness.db.listTasks({ runId: run.id })).toHaveLength(0)
    expect(harness.db.listTasks({ assignmentState: 'inbox' })).toHaveLength(1)
  })

  it('lets a current coordinator rebind the unclaimed adopted Run with actionable guidance', async () => {
    const harness = createHarness()

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.runUse',
        { id: harness.adoptedRunId, from: CURRENT_COORDINATOR_HANDLE },
        currentEvidence('coordinator'),
        'unclaimed-adopted-run-use'
      )
    )

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'consumer_fenced',
        data: {
          recoveryCommand: `orca orchestration run-use --id ${harness.adoptedRunId} --takeover-legacy`
        }
      }
    })
  })

  it('keeps a retained legacy coordinator task in the inbox without --run', async () => {
    const harness = createHarness()

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskCreate',
        {
          spec: 'retained assignment',
          callerTerminalHandle: COORDINATOR_HANDLE
        },
        evidence('coordinator'),
        'retained-adopted-task-create'
      )
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        task: { run_id: null, assignment_state: 'inbox', spec: 'retained assignment' }
      }
    })
    expect(harness.db.listTasks({ runId: harness.adoptedRunId })).toHaveLength(1)
    expect(harness.db.listTasks({ assignmentState: 'inbox' })).toHaveLength(1)
  })

  it('keeps a current coordinator task in the inbox when a current Run is bound but --run is omitted', async () => {
    const harness = createHarness()
    const run = harness.db.createRun({
      objective: 'current work',
      coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
      coordinatorPaneKey: CURRENT_COORDINATOR_PANE
    })

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskCreate',
        { spec: 'current inbox assignment', callerTerminalHandle: CURRENT_COORDINATOR_HANDLE },
        currentEvidence('coordinator'),
        'current-inbox-task-create'
      )
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        task: { run_id: null, assignment_state: 'inbox', spec: 'current inbox assignment' }
      }
    })
    expect(harness.db.listTasks({ runId: run.id })).toHaveLength(0)
    expect(harness.db.listTasks({ assignmentState: 'inbox' })).toHaveLength(1)
  })

  it('still fences a stale legacy coordinator once the adopted Run is claimed', async () => {
    const harness = createHarness()
    harness.db.bindRun({
      runId: harness.adoptedRunId,
      coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
      coordinatorPaneKey: CURRENT_COORDINATOR_PANE,
      takeoverLegacy: true
    })

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskCreate',
        {
          spec: 'stale assignment',
          run: harness.adoptedRunId,
          callerTerminalHandle: COORDINATOR_HANDLE
        },
        evidence('coordinator'),
        'claimed-adopted-task-create'
      )
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'legacy_read_only' }
    })
    expect(harness.db.listTasks({ runId: harness.adoptedRunId })).toHaveLength(1)
  })
})
