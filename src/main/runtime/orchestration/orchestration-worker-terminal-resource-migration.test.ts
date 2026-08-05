import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

function sqliteFor(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

let tempDir: string | undefined
let db: OrchestrationDb | undefined

afterEach(() => {
  db?.close()
  db = undefined
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

// Seeds a fully-migrated DB at the given user_version with a non-federated worker
// dispatch whose agent_terminal_handle is set, so backfillWorkerTerminalResources
// has a candidate row to act on.
function seedLegacyWorkerDispatch(dbPath: string, schemaVersion: number): string {
  const db0 = new OrchestrationDb(dbPath)
  const task = db0.createTask({ spec: 'worker terminal migration seed' })
  const ctx = db0.createDispatchContext(task.id, 'term_worker_seed')
  // Why: createDispatchContext inserts into dispatch_contexts only; worker_dispatches
  // is populated by the worker-start path. For a migration fixture we seed it directly
  // so the backfill query finds a non-federated candidate with a terminal handle.
  sqliteFor(db0)
    .prepare(
      `INSERT INTO worker_dispatches (dispatch_id, agent_terminal_handle, start_options)
       VALUES (?, ?, '{}')`
    )
    .run(ctx.id, 'pty_handle_seed')
  db0.close()

  const raw = new Database(dbPath)
  raw.pragma(`user_version = ${schemaVersion}`)
  raw.close()
  return ctx.id
}

function countWorkerTerminalResources(db: OrchestrationDb): number {
  return (
    sqliteFor(db).prepare('SELECT COUNT(*) as n FROM worker_terminal_resources').get() as {
      n: number
    }
  ).n
}

describe('worker terminal resource backfill migration (schema v25)', () => {
  it('backfills worker_terminal_resources from an existing v22 database', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-wtr-migration-v22-'))
    const dbPath = join(tempDir, 'orchestration.db')
    const ctxId = seedLegacyWorkerDispatch(dbPath, 22)

    db = new OrchestrationDb(dbPath)
    expect(sqliteFor(db).pragma('user_version', { simple: true })).toBe(26)
    expect(countWorkerTerminalResources(db)).toBe(1)
    const resource = db.getWorkerTerminalResourceByOwner(ctxId)
    expect(resource).toBeDefined()
    expect(resource?.terminal_handle).toBe('pty_handle_seed')
    expect(resource?.ownership_state).toBe('external')
    expect(resource?.retained_reason).toBe('legacy_ambiguous')
  })

  it('backfills worker_terminal_resources from an existing v23 database', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-wtr-migration-v23-'))
    const dbPath = join(tempDir, 'orchestration.db')
    const ctxId = seedLegacyWorkerDispatch(dbPath, 23)

    db = new OrchestrationDb(dbPath)
    expect(sqliteFor(db).pragma('user_version', { simple: true })).toBe(26)
    expect(countWorkerTerminalResources(db)).toBe(1)
    const resource = db.getWorkerTerminalResourceByOwner(ctxId)
    expect(resource?.terminal_handle).toBe('pty_handle_seed')
  })

  it('backfills worker_terminal_resources from an existing v24 database', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-wtr-migration-v24-'))
    const dbPath = join(tempDir, 'orchestration.db')
    const ctxId = seedLegacyWorkerDispatch(dbPath, 24)

    db = new OrchestrationDb(dbPath)
    expect(sqliteFor(db).pragma('user_version', { simple: true })).toBe(26)
    expect(countWorkerTerminalResources(db)).toBe(1)
    const resource = db.getWorkerTerminalResourceByOwner(ctxId)
    expect(resource?.terminal_handle).toBe('pty_handle_seed')
  })

  it('does not duplicate resources on re-open (idempotent)', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-wtr-migration-idempotent-'))
    const dbPath = join(tempDir, 'orchestration.db')
    seedLegacyWorkerDispatch(dbPath, 23)

    db = new OrchestrationDb(dbPath)
    expect(countWorkerTerminalResources(db)).toBe(1)
    db.close()
    db = undefined

    db = new OrchestrationDb(dbPath)
    expect(countWorkerTerminalResources(db)).toBe(1)
  })

  it('leaves federated worker dispatches untouched', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-wtr-migration-federated-'))
    const dbPath = join(tempDir, 'orchestration.db')
    const ctxId = seedLegacyWorkerDispatch(dbPath, 23)

    const raw = new Database(dbPath)
    raw
      .prepare(
        'INSERT INTO federated_dispatches (dispatch_id, environment_id, environment_name, peer_fingerprint, protocol_version) VALUES (?, ?, ?, ?, ?)'
      )
      .run(ctxId, 'env_seed', 'seed-env', 'fp_seed', 1)
    raw.pragma('user_version = 23')
    raw.close()

    db = new OrchestrationDb(dbPath)
    expect(sqliteFor(db).pragma('user_version', { simple: true })).toBe(26)
    expect(countWorkerTerminalResources(db)).toBe(0)
  })
})
