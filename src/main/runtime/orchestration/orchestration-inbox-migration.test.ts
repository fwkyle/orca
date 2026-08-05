import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

function sqliteFor(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

let db: OrchestrationDb | undefined

afterEach(() => {
  db?.close()
  db = undefined
})

describe('orchestration inbox task migration', () => {
  it('preserves existing task IDs, status, order, and Run assignment across v25 → v26', () => {
    db = new OrchestrationDb(':memory:')
    const seeded = db
    const run = seeded.createRun({
      objective: 'existing cards',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
    })
    const raw = sqliteFor(seeded)
    raw.exec('DROP TABLE tasks')
    raw.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        parent_id TEXT,
        created_by_terminal_handle TEXT,
        task_title TEXT,
        display_name TEXT,
        spec TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked')),
        deps TEXT NOT NULL DEFAULT '[]',
        result TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );
      CREATE INDEX idx_tasks_status ON tasks(status);
      CREATE INDEX idx_tasks_parent ON tasks(parent_id);
      CREATE INDEX idx_tasks_run_status ON tasks(run_id, status);
      INSERT INTO tasks (
        id, run_id, task_title, display_name, spec, status, deps, created_at
      ) VALUES
        ('task_existing_ready', '${run.id}', 'Ready card', 'Ready card', 'ready card', 'ready', '[]', '2026-01-01 00:00:01'),
        ('task_existing_done', '${run.id}', 'Done card', 'Done card', 'done card', 'completed', '[]', '2026-01-01 00:00:02');
    `)
    const beforeCards = raw
      .prepare('SELECT id, status, run_id FROM tasks ORDER BY created_at')
      .all() as { id: string; status: string; run_id: string }[]
    raw.pragma('user_version = 25')
    const createTables = (db as unknown as { createTables: () => void }).createTables.bind(db)
    createTables()
    const migrate = (db as unknown as { migrate: () => void }).migrate.bind(db)
    migrate()
    const cards = db.listTasks({ runId: run.id }).map((task) => ({
      id: task.id,
      status: task.status,
      run_id: task.run_id,
      assignment_state: task.assignment_state
    }))

    expect(sqliteFor(db).pragma('user_version', { simple: true })).toBe(26)
    expect(cards.map(({ id, status, run_id }) => ({ id, status, run_id }))).toEqual(beforeCards)
    expect(cards).toEqual([
      { id: 'task_existing_ready', status: 'ready', run_id: run.id, assignment_state: 'assigned' },
      {
        id: 'task_existing_done',
        status: 'completed',
        run_id: run.id,
        assignment_state: 'assigned'
      }
    ])
    expect(
      (
        sqliteFor(db)
          .prepare("SELECT \"notnull\" FROM pragma_table_info('tasks') WHERE name = 'run_id'")
          .get() as { notnull: number }
      ).notnull
    ).toBe(0)
  })

  it('keeps one inbox card ID through handoff and completion', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'handoff target',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
    })
    const inbox = db.createTask({ spec: 'inbox card', runId: null })

    const handedOff = db.handoffTask(inbox.id, run.id)
    expect(handedOff).toMatchObject({
      id: inbox.id,
      run_id: run.id,
      assignment_state: 'assigned'
    })

    const completed = db.updateTaskStatus(inbox.id, 'completed')
    expect(completed).toMatchObject({
      id: inbox.id,
      run_id: run.id,
      assignment_state: 'assigned',
      status: 'completed'
    })
  })
})
