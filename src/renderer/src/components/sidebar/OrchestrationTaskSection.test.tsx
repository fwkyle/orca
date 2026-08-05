// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'

const mocks = vi.hoisted(() => ({
  state: {
    settings: { activeRuntimeEnvironmentId: null },
    agentStatusByPaneKey: {
      'pane-source:0': {
        state: 'working',
        orchestration: { taskId: 'task_78b7ce444fe6' }
      }
    },
    runtimeAgentOrchestrationByPaneKey: {}
  },
  callRuntimeRpc: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

vi.mock('@/runtime/runtime-rpc-client', async () => {
  const actual = await vi.importActual<typeof RuntimeRpcClient>('@/runtime/runtime-rpc-client')
  return {
    ...actual,
    callRuntimeRpc: mocks.callRuntimeRpc,
    getActiveRuntimeTarget: () => ({ kind: 'local' })
  }
})

import OrchestrationTaskSection from './OrchestrationTaskSection'

beforeEach(() => {
  mocks.callRuntimeRpc.mockReset()
  mocks.callRuntimeRpc.mockImplementation((_target: unknown, method: string) => {
    if (method === 'orchestration.taskList') {
      return Promise.resolve({
        tasks: [
          {
            id: 'task_78b7ce444fe6',
            spec: 'Source card task',
            display_name: 'Source card',
            status: 'pending',
            run_id: null,
            assignment_state: 'inbox'
          }
        ],
        count: 1,
        runId: null
      })
    }
    if (method === 'orchestration.runList') {
      return Promise.resolve({
        runs: [{ id: 'run_main', objective: 'Main Run', legacy: 0 }]
      })
    }
    if (method === 'orchestration.taskHandoff') {
      return Promise.resolve({
        task: {
          id: 'task_78b7ce444fe6',
          assignment_state: 'assigned',
          run_id: 'run_main'
        }
      })
    }
    throw new Error(`unexpected method: ${method}`)
  })
})

afterEach(cleanup)

describe('OrchestrationTaskSection', () => {
  it('shows the inbox badge, preserved working state, and handoff control', async () => {
    const view = render(<OrchestrationTaskSection />)

    await waitFor(() => expect(view.container.querySelector('[data-inbox-badge]')).not.toBeNull())
    expect(view.container.querySelector('[data-inbox-task-id="task_78b7ce444fe6"]')).not.toBeNull()
    expect(screen.getByText('Working')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Hand off Source card' })).toBeTruthy()
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'orchestration.taskList', {
      assignmentState: 'inbox'
    })
  })

  it('hands off the same card ID to the selected Run', async () => {
    const view = render(<OrchestrationTaskSection />)

    const button = await screen.findByRole('button', { name: 'Hand off Source card' })
    button.click()

    await waitFor(() =>
      expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
        { kind: 'local' },
        'orchestration.taskHandoff',
        { id: 'task_78b7ce444fe6', run: 'run_main' }
      )
    )
    expect(view.container.querySelector('[data-inbox-task-id="task_78b7ce444fe6"]')).not.toBeNull()
  })
})
