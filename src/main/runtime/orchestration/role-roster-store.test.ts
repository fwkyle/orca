import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

describe('role roster store', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    // Why: Windows keeps the SQLite file locked until the DB handle closes,
    // so migration temp directories must close before recursive cleanup.
    db?.close()
    db = undefined
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  function createRoster(
    d: OrchestrationDb,
    overrides?: Partial<Parameters<OrchestrationDb['createRoleRoster']>[0]>
  ) {
    return d.createRoleRoster({
      pane: 'tab_1:leaf_1',
      project: 'proj',
      board: 'board_a',
      role: 'worker',
      runId: 'run_1',
      ...overrides
    })
  }

  it('creates a roster record with identity and defaults', () => {
    const d = createDb()
    const row = createRoster(d, { role: 'coordinator' })
    expect(row.id).toMatch(/^roster_/)
    expect(row.status).toBe('active')
    expect(row.kind).toBe('worker')
    expect(row.can_dispatch).toBe(0)
    expect(row.last_seen_handle).toBeNull()
    expect(row.pane).toBe('tab_1:leaf_1')
    expect(d.getRoleRoster(row.id)?.id).toBe(row.id)
  })

  it('persists optional metadata and permissions', () => {
    const d = createDb()
    const row = createRoster(d, {
      kind: 'supervisor',
      model: 'gpt-x',
      title: 'Lead',
      canDispatch: true,
      canCommit: true,
      canMessageSuper: false,
      lastSeenHandle: 'term_A',
      parentRole: 'coordinator',
      reportsTo: 'roster_parent'
    })
    expect(row.kind).toBe('supervisor')
    expect(row.model).toBe('gpt-x')
    expect(row.can_dispatch).toBe(1)
    expect(row.can_commit).toBe(1)
    expect(row.can_message_super).toBe(0)
    expect(row.last_seen_handle).toBe('term_A')
    expect(row.parent_role).toBe('coordinator')
    expect(row.reports_to).toBe('roster_parent')
  })

  it('updates mutable fields without touching identity', () => {
    const d = createDb()
    const row = createRoster(d)
    const updated = d.updateRoleRoster(row.id, {
      kind: 'coordinator',
      model: 'claude-y',
      canDispatch: true
    })
    expect(updated?.kind).toBe('coordinator')
    expect(updated?.model).toBe('claude-y')
    expect(updated?.can_dispatch).toBe(1)
    expect(updated?.pane).toBe('tab_1:leaf_1')
    expect(updated?.role).toBe('worker')
    expect(updated?.run_id).toBe('run_1')
    expect(updated?.updated_at).toBeTruthy()
  })

  it('returns undefined when updating or deactivating an unknown roster id', () => {
    const d = createDb()
    expect(d.updateRoleRoster('roster_missing', { model: 'x' })).toBeUndefined()
    expect(d.deactivateRoleRoster('roster_missing')).toBeUndefined()
  })

  it('deactivates a roster record', () => {
    const d = createDb()
    const row = createRoster(d)
    const deactivated = d.deactivateRoleRoster(row.id)
    expect(deactivated?.status).toBe('inactive')
    expect(d.getRoleRoster(row.id)?.status).toBe('inactive')
  })

  it('refreshes last_seen_handle on reconnect while preserving the same record', () => {
    const d = createDb()
    const row = createRoster(d, { lastSeenHandle: 'term_A' })
    const refreshed = d.refreshRoleRosterHandle(row.id, 'term_B')
    expect(refreshed?.id).toBe(row.id)
    expect(refreshed?.last_seen_handle).toBe('term_B')
    const after = d.getRoleRoster(row.id)
    expect(after?.id).toBe(row.id)
    expect(after?.last_seen_handle).toBe('term_B')
    expect(after?.pane).toBe('tab_1:leaf_1')
    expect(after?.status).toBe('active')
  })

  it('refreshRoleRosterHandle refuses inactive or unknown records without touching the handle', () => {
    const d = createDb()
    const row = createRoster(d, { lastSeenHandle: 'term_A' })
    d.deactivateRoleRoster(row.id)
    expect(d.refreshRoleRosterHandle(row.id, 'term_B')).toBeUndefined()
    expect(d.getRoleRoster(row.id)?.last_seen_handle).toBe('term_A')
    expect(d.refreshRoleRosterHandle('roster_missing', 'term_B')).toBeUndefined()
  })

  it('resolveActiveRoleRoster returns the single active match', () => {
    const d = createDb()
    const row = createRoster(d)
    const found = d.resolveActiveRoleRoster({
      project: 'proj',
      board: 'board_a',
      role: 'worker',
      pane: 'tab_1:leaf_1',
      runId: 'run_1'
    })
    expect(found?.id).toBe(row.id)
  })

  it('resolveActiveRoleRoster matches pane by stable leaf after break-out', () => {
    const d = createDb()
    const LEAF = '11111111-1111-1111-8111-111111111111'
    const row = createRoster(d, { pane: `tab_1:${LEAF}` })
    const found = d.resolveActiveRoleRoster({
      project: 'proj',
      board: 'board_a',
      role: 'worker',
      pane: `tab_2:${LEAF}`,
      runId: 'run_1'
    })
    expect(found?.id).toBe(row.id)
  })

  it('resolveActiveRoleRoster returns undefined when none active', () => {
    const d = createDb()
    const row = createRoster(d)
    d.deactivateRoleRoster(row.id)
    expect(
      d.resolveActiveRoleRoster({
        project: 'proj',
        board: 'board_a',
        role: 'worker',
        pane: 'tab_1:leaf_1',
        runId: 'run_1'
      })
    ).toBeUndefined()
  })

  it('resolveActiveRoleRoster fails on ambiguous active candidates instead of auto-selecting', () => {
    const d = createDb()
    createRoster(d)
    createRoster(d)
    expect(() =>
      d.resolveActiveRoleRoster({
        project: 'proj',
        board: 'board_a',
        role: 'worker',
        pane: 'tab_1:leaf_1',
        runId: 'run_1'
      })
    ).toThrow(/Multiple active role roster records match/)
  })

  it('resolveActiveRoleRoster distinguishes records by run_id', () => {
    const d = createDb()
    createRoster(d)
    const other = createRoster(d, { runId: 'run_2' })
    const found = d.resolveActiveRoleRoster({
      project: 'proj',
      board: 'board_a',
      role: 'worker',
      pane: 'tab_1:leaf_1',
      runId: 'run_2'
    })
    expect(found?.id).toBe(other.id)
  })

  it('resolveActiveRoleRosterByRole selects the single active candidate for the role', () => {
    const d = createDb()
    const row = createRoster(d)
    createRoster(d, { role: 'coordinator', pane: 'tab_1:leaf_2' })
    const found = d.resolveActiveRoleRosterByRole({
      project: 'proj',
      board: 'board_a',
      role: 'worker',
      runId: 'run_1'
    })
    expect(found?.id).toBe(row.id)
  })

  it('resolveActiveRoleRosterByRole returns undefined when no active candidate exists', () => {
    const d = createDb()
    const row = createRoster(d)
    d.deactivateRoleRoster(row.id)
    expect(
      d.resolveActiveRoleRosterByRole({
        project: 'proj',
        board: 'board_a',
        role: 'worker',
        runId: 'run_1'
      })
    ).toBeUndefined()
    expect(
      d.resolveActiveRoleRosterByRole({
        project: 'proj',
        board: 'board_a',
        role: 'supervisor',
        runId: 'run_1'
      })
    ).toBeUndefined()
  })

  it('resolveActiveRoleRosterByRole refuses active duplicates on different panes instead of auto-selecting', () => {
    const d = createDb()
    createRoster(d, { pane: 'tab_1:leaf_1' })
    createRoster(d, { pane: 'tab_1:leaf_2' })
    expect(() =>
      d.resolveActiveRoleRosterByRole({
        project: 'proj',
        board: 'board_a',
        role: 'worker',
        runId: 'run_1'
      })
    ).toThrow(/Multiple active role roster records match/)
  })

  it('listRoleRosters filters by status, run, and role', () => {
    const d = createDb()
    const a = createRoster(d)
    const b = createRoster(d, { pane: 'tab_1:leaf_2', role: 'coordinator', runId: 'run_2' })
    d.deactivateRoleRoster(b.id)
    expect(d.listRoleRosters({ status: 'active' }).map((r) => r.id)).toEqual([a.id])
    expect(d.listRoleRosters({ runId: 'run_2' })[0]?.status).toBe('inactive')
    expect(d.listRoleRosters({ role: 'coordinator' }).map((r) => r.id)).toEqual([b.id])
    expect(d.listRoleRosters({ role: 'worker', status: 'active' }).map((r) => r.id)).toEqual([a.id])
    expect(d.listRoleRosters({ role: 'supervisor' })).toEqual([])
  })

  it('resetTasks preserves role rosters for live runs while clearing tasks', () => {
    const d = createDb()
    d.insertMessage({ from: 'a', to: 'b', subject: 'test' })
    d.createTask({ spec: 'work' })
    const row = createRoster(d)

    d.resetTasks()

    expect(d.listTasks()).toHaveLength(0)
    expect(d.getInbox()).toHaveLength(1)
    expect(d.getRoleRoster(row.id)?.status).toBe('active')
    expect(
      d.resolveActiveRoleRosterByRole({
        project: 'proj',
        board: 'board_a',
        role: 'worker',
        runId: 'run_1'
      })?.id
    ).toBe(row.id)
  })

  it('resetAll still clears role rosters', () => {
    const d = createDb()
    createRoster(d)

    d.resetAll()

    expect(d.listRoleRosters()).toEqual([])
  })

  it('adds the role_roster table through the v23 migration on a pre-v23 DB', () => {
    // Why: build a real pre-v23 DB by migrating to current schema, then
    // dropping role_roster and pinning user_version=22. createTables no longer
    // creates role_roster, so only the v23 migrate block can restore it —
    // deleting that block fails this test.
    tempDir = mkdtempSync(join(tmpdir(), 'orca-db-migrate-v23-'))
    const dbPath = join(tempDir, 'test.db')
    const seeded = new OrchestrationDb(dbPath)
    seeded.close()

    const raw = new Database(dbPath)
    raw.exec('DROP TABLE IF EXISTS role_roster')
    raw.exec('DROP INDEX IF EXISTS idx_role_roster_identity')
    raw.exec('DROP INDEX IF EXISTS idx_role_roster_pane')
    raw.pragma('user_version = 22')
    raw.close()

    const d = new OrchestrationDb(dbPath)
    db = d
    const sqlite = (d as unknown as { db: Database.Database }).db
    const tableRow = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_roster'`)
      .get() as { name: string } | undefined
    expect(tableRow?.name).toBe('role_roster')
    expect(sqlite.pragma('user_version', { simple: true })).toBe(26)

    const row = createRoster(d, { lastSeenHandle: 'term_A' })
    expect(d.refreshRoleRosterHandle(row.id, 'term_B')?.last_seen_handle).toBe('term_B')
  })
})
