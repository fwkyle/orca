import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE

vi.mock('../format', () => ({ printResult: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'

afterEach(() => {
  callMock.mockReset()
  if (originalTerminalHandle === undefined) {
    delete process.env.ORCA_TERMINAL_HANDLE
  } else {
    process.env.ORCA_TERMINAL_HANDLE = originalTerminalHandle
  }
})

describe('orchestration inbox task commands', () => {
  beforeEach(() => {
    delete process.env.ORCA_TERMINAL_HANDLE
  })

  it('passes an explicit Run only when --run is supplied', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_creator'
    callMock
      .mockResolvedValueOnce({ result: { terminal: { handle: 'term_creator' } } })
      .mockResolvedValueOnce({ result: { task: { id: 'task_1', status: 'pending' } } })

    await ORCHESTRATION_HANDLERS['orchestration task-create']({
      flags: new Map([
        ['spec', 'run-scoped work'],
        ['run', 'run_main']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'orchestration.taskCreate',
      expect.objectContaining({ run: 'run_main', callerTerminalHandle: 'term_creator' })
    )
  })

  it('requests inbox tasks without resolving a hidden Run', async () => {
    callMock.mockResolvedValue({ result: { tasks: [], count: 0, runId: null } })

    await ORCHESTRATION_HANDLERS['orchestration task-list']({
      flags: new Map([['inbox', true]]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.taskList',
      expect.objectContaining({
        assignmentState: 'inbox',
        run: undefined,
        callerTerminalHandle: undefined
      })
    )
  })

  it('hands an inbox card to the selected Run', async () => {
    callMock.mockResolvedValue({ result: { task: { id: 'task_1', status: 'pending' } } })

    await ORCHESTRATION_HANDLERS['orchestration task-handoff']({
      flags: new Map([
        ['id', 'task_1'],
        ['run', 'run_main']
      ]),
      client: { call: callMock },
      json: true
    } as never)

    expect(callMock).toHaveBeenCalledWith('orchestration.taskHandoff', {
      id: 'task_1',
      run: 'run_main'
    })
  })
})
