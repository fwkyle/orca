import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { reconcileLifecycleMessage } from '../../orchestration/lifecycle-reconciliation'
import type { RpcMethod } from '../core'
import { ALL_RPC_METHODS } from './index'

// Why: card 8 — the retire RPC is the official transition verb. It must demand
// the full identity (project+board+role+stable pane+run), return the checklist
// as data instead of throwing, and never stop a terminal.
describe('orchestration.rosterRetire', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'resolveTerminalPane').mockImplementation(
      (paneKey: string) => ({ handle: `term_live_for_${paneKey}` }) as never
    )
    runId = db.createRun({
      objective: 'card 8',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_0:leaf_0'
    }).id
  })

  afterEach(() => db.close())

  function findMethod(name: string): RpcMethod {
    const method = ALL_RPC_METHODS.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`${name} is not registered`)
    }
    return method as RpcMethod
  }

  function seedClosedCard(): { rosterId: string; taskId: string } {
    const roster = db.createRoleRoster({
      pane: 'tab_1:leaf_1',
      project: 'proj',
      board: 'board_a',
      role: 'card8-worker',
      runId,
      lastSeenHandle: 'term_worker_old'
    })
    const task = db.createTask({ spec: 'card 8', runId })
    db.updateTaskStatus(task.id, 'ready')
    const dispatch = db.createDispatchContext(task.id, 'term_worker_old', 'tab_1:leaf_1')
    const message = db.insertMessage({
      from: 'term_worker_old',
      to: `run:${runId}`,
      subject: 'done',
      body: 'done',
      type: 'worker_done',
      runId,
      senderPaneKey: 'tab_1:leaf_1',
      payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id, outcome: 'succeeded' })
    })
    reconcileLifecycleMessage(db, message, () => {})
    return { rosterId: roster.id, taskId: task.id }
  }

  async function callRetire(params: Record<string, unknown>): Promise<{
    retired: boolean
    member: { id: string; status: string } | null
    blockers: { code: string }[]
    warnings: string[]
  }> {
    const method = findMethod('orchestration.rosterRetire')
    return (await method.handler(method.params!.parse(params), { runtime })) as never
  }

  it('is registered alongside the other roster methods', () => {
    expect(findMethod('orchestration.rosterRetire').name).toBe('orchestration.rosterRetire')
  })

  it('rejects a call missing the stable pane or run identity', () => {
    const method = findMethod('orchestration.rosterRetire')
    expect(() =>
      method.params!.parse({ project: 'proj', board: 'board_a', role: 'card8-worker' })
    ).toThrow()
  })

  it('retires a fully closed card and drops it out of active resolve', async () => {
    const { rosterId, taskId } = seedClosedCard()
    const result = await callRetire({
      project: 'proj',
      board: 'board_a',
      role: 'card8-worker',
      pane: 'tab_1:leaf_1',
      run: runId,
      task: taskId,
      dirtyChangesMoved: true,
      dirtyChangesEvidence: '/tmp/orca-evidence/card8/notes.md'
    })

    expect(result.retired).toBe(true)
    expect(result.member?.status).toBe('retired')
    expect(db.getRoleRoster(rosterId)?.last_seen_handle).toBe('term_worker_old')

    const listMethod = findMethod('orchestration.rosterList')
    const active = (await listMethod.handler(listMethod.params!.parse({ status: 'active' }), {
      runtime
    })) as { members: unknown[] }
    expect(active.members).toHaveLength(0)
    const retired = (await listMethod.handler(listMethod.params!.parse({ status: 'retired' }), {
      runtime
    })) as { members: { lifecycle: string; lastSeenHandle: string | null }[] }
    expect(retired.members).toHaveLength(1)
    expect(retired.members[0].lifecycle).toBe('retired')
    expect(retired.members[0].lastSeenHandle).toBe('term_worker_old')
  })

  it('returns blockers as data and leaves the record active when confirmation is missing', async () => {
    const { rosterId, taskId } = seedClosedCard()
    const result = await callRetire({
      project: 'proj',
      board: 'board_a',
      role: 'card8-worker',
      pane: 'tab_1:leaf_1',
      run: runId,
      task: taskId
    })

    expect(result.retired).toBe(false)
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(['dirty_changes_moved'])
    expect(result.warnings.length).toBe(1)
    expect(db.getRoleRoster(rosterId)?.status).toBe('active')
  })
})
