import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  startFederatedWorker,
  validateRemoteWorkerStart
} from './orchestration-federated-worker-start'
import { WorkerStartParams } from './orchestration-worker-start-schema'
import { validateWorkerStartArguments } from './worker-start-argument-validation'

const CREATION_OPTIONS_MESSAGE =
  'Creation and setup options apply only to new-child or new-top-level worktrees.'
const REMOTE_CREATION_OPTIONS_MESSAGE =
  'Creation and setup options apply only to remote new-top-level worktrees.'

function params(overrides: Record<string, unknown> = {}) {
  return WorkerStartParams.parse({ task: 'task_1', from: 'term_coord', ...overrides })
}

function runtime() {
  return { validateOrchestrationAgentLauncher: vi.fn() }
}

function remoteParams(overrides: Record<string, unknown> = {}) {
  return params({
    on: 'windows',
    worktree: 'id:remote-repo::existing-worker',
    agent: 'codex',
    ...overrides
  })
}

function expectValidationError(action: () => unknown, code: string, message: string): void {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(OrchestrationError)
    expect(error).toMatchObject({ code, message })
    return
  }
  throw new Error(`Expected ${code}: ${message}`)
}

describe('validateWorkerStartArguments', () => {
  it.each([false, true])(
    'rejects --terminal with --agent before checking the worktree mode (%s)',
    (createsWorktree) => {
      const agentRuntime = runtime()

      expectValidationError(
        () =>
          validateWorkerStartArguments(
            params({ terminal: 'term_existing', agent: 'codex', name: 'worker' }),
            createsWorktree,
            agentRuntime
          ),
        'invalid_argument',
        '--terminal reuses an existing agent and cannot combine with --agent.'
      )
      expect(agentRuntime.validateOrchestrationAgentLauncher).not.toHaveBeenCalled()
    }
  )

  it.each(['new-child', 'new-top-level'])(
    'rejects --terminal for %s worktrees before requiring --name',
    (worktree) => {
      const agentRuntime = runtime()

      expectValidationError(
        () =>
          validateWorkerStartArguments(
            params({ worktree, terminal: 'term_existing' }),
            true,
            agentRuntime
          ),
        'invalid_argument',
        '--terminal cannot combine with new-worktree creation.'
      )
      expect(agentRuntime.validateOrchestrationAgentLauncher).not.toHaveBeenCalled()
    }
  )

  it.each(['new-child', 'new-top-level'])('requires --name for %s worktrees', (worktree) => {
    const agentRuntime = runtime()

    expectValidationError(
      () => validateWorkerStartArguments(params({ worktree, agent: 'codex' }), true, agentRuntime),
      'invalid_argument',
      'New worktrees require --name.'
    )
    expect(agentRuntime.validateOrchestrationAgentLauncher).not.toHaveBeenCalled()
  })

  it.each(['current', 'existing'])('rejects creation flags for %s worktrees', (worktree) => {
    const agentRuntime = runtime()
    const creationOptions = [
      { name: 'worker' },
      { repo: '/repo' },
      { baseBranch: 'main' },
      { displayName: 'Worker display name' },
      { comment: 'Worker comment' },
      { setup: 'run' }
    ]

    for (const option of creationOptions) {
      expectValidationError(
        () =>
          validateWorkerStartArguments(
            params({ worktree, agent: 'codex', ...option }),
            false,
            agentRuntime
          ),
        'invalid_argument',
        CREATION_OPTIONS_MESSAGE
      )
    }
    expect(agentRuntime.validateOrchestrationAgentLauncher).not.toHaveBeenCalled()
  })

  it.each(['new-child', 'new-top-level'])('allows creation flags for %s worktrees', (worktree) => {
    const agentRuntime = runtime()
    const result = validateWorkerStartArguments(
      params({
        worktree,
        name: 'worker',
        repo: '/repo',
        baseBranch: 'main',
        displayName: 'Worker display name',
        comment: 'Worker comment',
        setup: 'run',
        agent: 'codex'
      }),
      true,
      agentRuntime
    )

    expect(result).toBe('codex')
    expect(agentRuntime.validateOrchestrationAgentLauncher).toHaveBeenCalledOnce()
    expect(agentRuntime.validateOrchestrationAgentLauncher).toHaveBeenCalledWith('codex')
  })

  it.each([
    { worktree: 'current', createsWorktree: false, overrides: {} },
    { worktree: 'existing', createsWorktree: false, overrides: {} },
    { worktree: 'new-child', createsWorktree: true, overrides: { name: 'worker' } },
    { worktree: 'new-top-level', createsWorktree: true, overrides: { name: 'worker' } }
  ])('requires a configured agent when %s creates a terminal', ({ createsWorktree, overrides }) => {
    const agentRuntime = runtime()

    expectValidationError(
      () => validateWorkerStartArguments(params(overrides), createsWorktree, agentRuntime),
      'agent_unconfigured',
      'A configured --agent is required when worker-start creates a terminal.'
    )
    expect(agentRuntime.validateOrchestrationAgentLauncher).not.toHaveBeenCalled()
  })

  it.each([
    { worktree: 'current', createsWorktree: false },
    { worktree: 'existing', createsWorktree: false }
  ])('allows an existing terminal for %s without --agent', ({ createsWorktree }) => {
    const agentRuntime = runtime()

    expect(
      validateWorkerStartArguments(
        params({ terminal: 'term_existing' }),
        createsWorktree,
        agentRuntime
      )
    ).toBeUndefined()
    expect(agentRuntime.validateOrchestrationAgentLauncher).not.toHaveBeenCalled()
  })

  it.each([
    { worktree: 'current', createsWorktree: false, overrides: { agent: 'codex' } },
    { worktree: 'existing', createsWorktree: false, overrides: { agent: 'codex' } },
    { worktree: 'new-child', createsWorktree: true, overrides: { name: 'worker', agent: 'codex' } },
    {
      worktree: 'new-top-level',
      createsWorktree: true,
      overrides: { name: 'worker', agent: 'codex' }
    }
  ])('accepts a configured agent for %s worktrees', ({ createsWorktree, overrides }) => {
    const agentRuntime = runtime()

    expect(validateWorkerStartArguments(params(overrides), createsWorktree, agentRuntime)).toBe(
      'codex'
    )
    expect(agentRuntime.validateOrchestrationAgentLauncher).toHaveBeenCalledOnce()
    expect(agentRuntime.validateOrchestrationAgentLauncher).toHaveBeenCalledWith('codex')
  })

  it('reports an unconfigured agent instead of calling the launcher validator', () => {
    const agentRuntime = runtime()

    expectValidationError(
      () => validateWorkerStartArguments(params({ agent: 'not-configured' }), false, agentRuntime),
      'agent_unconfigured',
      'A configured --agent is required when worker-start creates a terminal.'
    )
    expect(agentRuntime.validateOrchestrationAgentLauncher).not.toHaveBeenCalled()
  })

  it.each([{ displayName: 'Remote worker display name' }, { comment: 'Remote worker comment' }])(
    'rejects %s for an exact remote existing worktree',
    (creationOption) => {
      expectValidationError(
        () => validateRemoteWorkerStart(remoteParams(creationOption), false),
        'invalid_argument',
        REMOTE_CREATION_OPTIONS_MESSAGE
      )
    }
  )

  it('allows display name and comment for remote new-top-level creation', () => {
    expect(() =>
      validateRemoteWorkerStart(
        remoteParams({
          worktree: 'new-top-level',
          name: 'remote-worker',
          repo: 'id:remote-repo',
          displayName: 'Remote worker display name',
          comment: 'Remote worker comment'
        }),
        true
      )
    ).not.toThrow()
  })

  it.each([{ displayName: 'Remote worker display name' }, { comment: 'Remote worker comment' }])(
    'rejects remote %s before resolving the server or creating a dispatch',
    async (creationOption) => {
      const resolveServer = vi.fn()
      const createStartingWorkerDispatch = vi.fn()
      const runtime = {
        resolveOrchestrationWorkerServer: resolveServer
      } as unknown as OrcaRuntimeService
      const db = { createStartingWorkerDispatch } as unknown as OrchestrationDb

      await expect(
        startFederatedWorker({
          params: remoteParams(creationOption),
          runtime,
          db,
          runId: 'run_1',
          task: { id: 'task_1', spec: 'remote worker', status: 'ready' },
          orchestrationMutation: {
            callerFingerprint: 'caller',
            requestId: 'request_1',
            method: 'orchestration.workerStart',
            payloadHash: 'hash'
          }
        })
      ).rejects.toMatchObject({
        code: 'invalid_argument',
        message: REMOTE_CREATION_OPTIONS_MESSAGE
      })
      expect(resolveServer).not.toHaveBeenCalled()
      expect(createStartingWorkerDispatch).not.toHaveBeenCalled()
    }
  )
})
