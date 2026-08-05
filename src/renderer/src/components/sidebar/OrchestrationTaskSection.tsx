import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, Inbox, Loader2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { AgentStateDot, agentStateLabel, type AgentDotState } from '@/components/AgentStateDot'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { AgentStatusState } from '../../../../shared/agent-status-types'

type InboxTask = {
  id: string
  spec: string
  task_title?: string | null
  display_name?: string | null
  status: string
  run_id: null
  assignment_state: 'inbox'
}

type RunOption = {
  id: string
  objective: string
  legacy: number
}

type InboxTaskListResult = {
  tasks: InboxTask[]
  count: number
  runId: null
}

type RunListResult = {
  runs: RunOption[]
}

const INBOX_REFRESH_INTERVAL_MS = 15_000
const INBOX_AGENT_STATES: ReadonlySet<AgentStatusState> = new Set(['working', 'blocked', 'waiting'])

function taskLabel(task: InboxTask): string {
  return task.display_name?.trim() || task.task_title?.trim() || task.spec.trim()
}

function taskState(task: InboxTask, agentState?: AgentStatusState): AgentDotState {
  if (agentState && INBOX_AGENT_STATES.has(agentState)) {
    return agentState
  }
  if (task.status === 'blocked') {
    return 'blocked'
  }
  if (task.status === 'failed') {
    return 'failed'
  }
  if (task.status === 'completed') {
    return 'done'
  }
  return 'idle'
}

function stateLabel(task: InboxTask, agentState?: AgentStatusState): string {
  const state = taskState(task, agentState)
  return state === 'idle' ? task.status : agentStateLabel(state)
}

function inboxCountLabel(count: number): string {
  return translate(
    'auto.components.sidebar.OrchestrationTaskSection.inboxCount',
    '{{value0}} inbox',
    {
      value0: count
    }
  )
}

function inboxCountAriaLabel(count: number): string {
  return translate(
    'auto.components.sidebar.OrchestrationTaskSection.inboxCountAriaLabel',
    '{{value0}} inbox tasks',
    { value0: count }
  )
}

function handoffTaskLabel(label: string): string {
  return translate(
    'auto.components.sidebar.OrchestrationTaskSection.handoffTask',
    'Hand off {{value0}}',
    { value0: label }
  )
}

function selectTaskAgentStates(
  entries: ReturnType<typeof useAppStore.getState>['agentStatusByPaneKey'],
  runtimeOrchestration: ReturnType<
    typeof useAppStore.getState
  >['runtimeAgentOrchestrationByPaneKey']
): Map<string, AgentStatusState> {
  const byTask = new Map<string, AgentStatusState>()
  const priority: Record<AgentStatusState, number> = {
    working: 3,
    blocked: 2,
    waiting: 1,
    done: 0
  }
  for (const [paneKey, entry] of Object.entries(entries)) {
    const taskId =
      entry.orchestration?.taskId ?? runtimeOrchestration?.[paneKey]?.taskId ?? undefined
    if (!taskId || !INBOX_AGENT_STATES.has(entry.state)) {
      continue
    }
    const prior = byTask.get(taskId)
    if (!prior || priority[entry.state] > priority[prior]) {
      byTask.set(taskId, entry.state)
    }
  }
  return byTask
}

export function OrchestrationTaskSection(): React.JSX.Element {
  useTranslation()
  const settings = useAppStore((s) => s.settings)
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const runtimeAgentOrchestrationByPaneKey = useAppStore(
    (s) => s.runtimeAgentOrchestrationByPaneKey
  )
  const target = useMemo(() => getActiveRuntimeTarget(settings), [settings])
  const [tasks, setTasks] = useState<InboxTask[]>([])
  const [runs, setRuns] = useState<RunOption[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>()
  const [handoffTaskId, setHandoffTaskId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const agentStatesByTask = useMemo(
    () => selectTaskAgentStates(agentStatusByPaneKey, runtimeAgentOrchestrationByPaneKey),
    [agentStatusByPaneKey, runtimeAgentOrchestrationByPaneKey]
  )

  const refresh = useCallback(async () => {
    try {
      const [inboxResult, runResult] = await Promise.all([
        callRuntimeRpc<InboxTaskListResult>(target, 'orchestration.taskList', {
          assignmentState: 'inbox'
        }),
        callRuntimeRpc<RunListResult>(target, 'orchestration.runList')
      ])
      setTasks(inboxResult.tasks)
      const availableRuns = runResult.runs.filter((run) => run.legacy !== 1)
      setRuns(availableRuns)
      setSelectedRunId((current) =>
        current && availableRuns.some((run) => run.id === current) ? current : availableRuns[0]?.id
      )
      setError(null)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : translate(
              'auto.components.sidebar.OrchestrationTaskSection.loadError',
              'Could not load tasks.'
            )
      )
    } finally {
      setLoading(false)
    }
  }, [target])

  useEffect(() => {
    setLoading(true)
    void refresh()
    const timer = window.setInterval(() => void refresh(), INBOX_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  const handoff = useCallback(
    async (taskId: string) => {
      if (!selectedRunId) {
        return
      }
      setHandoffTaskId(taskId)
      try {
        await callRuntimeRpc(target, 'orchestration.taskHandoff', {
          id: taskId,
          run: selectedRunId
        })
        await refresh()
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : translate(
                'auto.components.sidebar.OrchestrationTaskSection.handoffError',
                'Could not hand off the task.'
              )
        )
      } finally {
        setHandoffTaskId(null)
      }
    },
    [refresh, selectedRunId, target]
  )

  return (
    <section
      className="shrink-0 border-b border-worktree-sidebar-border px-2 pb-2 pt-1"
      data-orchestration-task-section=""
      aria-label={translate('auto.components.sidebar.OrchestrationTaskSection.title', 'Tasks')}
    >
      <div className="flex h-7 items-center gap-1.5 px-1">
        <Inbox className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {translate('auto.components.sidebar.OrchestrationTaskSection.title', 'Tasks')}
        </span>
        {tasks.length > 0 && (
          <Badge
            variant="outline"
            className="h-4 px-1.5 text-[10px]"
            data-inbox-badge=""
            aria-label={inboxCountAriaLabel(tasks.length)}
          >
            {inboxCountLabel(tasks.length)}
          </Badge>
        )}
        {loading && <Loader2 className="ml-auto size-3 animate-spin text-muted-foreground" />}
      </div>

      {error ? (
        <p className="px-1 text-[11px] text-destructive" role="alert">
          {error}
        </p>
      ) : tasks.length === 0 ? (
        <p className="px-1 text-[11px] text-muted-foreground">
          {translate('auto.components.sidebar.OrchestrationTaskSection.empty', 'Inbox is empty')}
        </p>
      ) : (
        <div
          className="flex max-h-44 flex-col gap-1 overflow-y-auto scrollbar-sleek"
          data-inbox-list=""
        >
          {tasks.map((task) => {
            const state = taskState(task, agentStatesByTask.get(task.id))
            return (
              <div
                key={task.id}
                className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-[11px] hover:bg-worktree-sidebar-accent"
                data-inbox-task-id={task.id}
              >
                <AgentStateDot state={state} size="sm" />
                <span className="min-w-0 flex-1 truncate" title={task.spec}>
                  {taskLabel(task)}
                </span>
                <span className={cn('shrink-0 text-[10px] text-muted-foreground')}>
                  {stateLabel(task, agentStatesByTask.get(task.id))}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-5 shrink-0"
                  aria-label={handoffTaskLabel(taskLabel(task))}
                  title={translate(
                    'auto.components.sidebar.OrchestrationTaskSection.handoffTitle',
                    'Hand off to Run'
                  )}
                  disabled={!selectedRunId || handoffTaskId !== null}
                  onClick={() => void handoff(task.id)}
                >
                  <ArrowUpRight className="size-3" aria-hidden="true" />
                </Button>
              </div>
            )
          })}
        </div>
      )}

      {tasks.length > 0 && (
        <div className="mt-1 flex items-center gap-1">
          <Select value={selectedRunId} onValueChange={setSelectedRunId}>
            <SelectTrigger size="sm" className="h-7 min-w-0 flex-1 text-[11px]">
              <SelectValue
                placeholder={translate(
                  'auto.components.sidebar.OrchestrationTaskSection.chooseRun',
                  'Choose a Run'
                )}
              />
            </SelectTrigger>
            <SelectContent>
              {runs.map((run) => (
                <SelectItem key={run.id} value={run.id} className="text-xs">
                  {run.objective || run.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </section>
  )
}

export default React.memo(OrchestrationTaskSection)
