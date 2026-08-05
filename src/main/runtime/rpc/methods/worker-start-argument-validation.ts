import type { TuiAgent } from '../../../../shared/types'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { z } from 'zod'
import type { WorkerStartParams } from './orchestration-worker-start-schema'

type WorkerStartParamsType = z.infer<typeof WorkerStartParams>
type RuntimeWithAgentValidation = {
  validateOrchestrationAgentLauncher(agent: TuiAgent): void
}

export function hasWorkerStartCreationOptions(
  params: Pick<
    WorkerStartParamsType,
    'name' | 'repo' | 'baseBranch' | 'displayName' | 'comment' | 'setup'
  >
): boolean {
  return Boolean(
    params.name ||
    params.repo ||
    params.baseBranch ||
    params.displayName ||
    params.comment ||
    params.setup
  )
}

// Why: the argument-combination rules for worker-start are a pure validation
// boundary with no side effects; extracting them keeps the handler focused on
// topology and dispatch orchestration.
export function validateWorkerStartArguments(
  params: WorkerStartParamsType,
  createsWorktree: boolean,
  runtime: RuntimeWithAgentValidation
): TuiAgent | undefined {
  if (params.terminal && params.agent) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal reuses an existing agent and cannot combine with --agent.'
    )
  }
  if (createsWorktree && params.terminal) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal cannot combine with new-worktree creation.'
    )
  }
  if (createsWorktree && !params.name) {
    throw new OrchestrationError('invalid_argument', 'New worktrees require --name.')
  }
  if (!createsWorktree && hasWorkerStartCreationOptions(params)) {
    throw new OrchestrationError(
      'invalid_argument',
      'Creation and setup options apply only to new-child or new-top-level worktrees.'
    )
  }
  const agent = params.agent
  if (!params.terminal && (!agent || !isTuiAgent(agent))) {
    throw new OrchestrationError(
      'agent_unconfigured',
      'A configured --agent is required when worker-start creates a terminal.'
    )
  }
  if (agent) {
    runtime.validateOrchestrationAgentLauncher(agent as TuiAgent)
  }
  return agent ? (agent as TuiAgent) : undefined
}
