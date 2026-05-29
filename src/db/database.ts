import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { SCHEMA_STATEMENTS } from './schema.js'

export interface OpenResult {
  db: Database.Database
  createdFromScratch: boolean
}

export async function openDatabase(sqlitePath: string): Promise<OpenResult> {
  await fs.mkdir(path.dirname(sqlitePath), { recursive: true })
  const existedBefore = await fileExists(sqlitePath)
  if (!existedBefore) {
    // Stale WAL/SHM from a previous run would make SQLite fail to open a fresh DB.
    await fs.unlink(sqlitePath + '-wal').catch(() => undefined)
    await fs.unlink(sqlitePath + '-shm').catch(() => undefined)
  }
  const db = new Database(sqlitePath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  applySchema(db)
  const createdFromScratch = !existedBefore || isFreshlyCreated(db)
  return { db, createdFromScratch }
}

function applySchema(db: Database.Database): void {
  const tx = db.transaction(() => {
    for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt)
    migrateAddFileBasename(db)
    migrateAddArchived(db)
    migrateAddSprintAndDeps(db)
  })
  tx()
}

/**
 * Add `file_basename` to pre-batch-6b vaults (idempotent — checked via
 * PRAGMA). Back-fills existing rows with the legacy filename `<id>` so
 * the corresponding .md files still resolve.
 */
function migrateAddFileBasename(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(cards)`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'file_basename')) {
    db.exec(`ALTER TABLE cards ADD COLUMN file_basename TEXT NOT NULL DEFAULT ''`)
  }
  db.exec(`UPDATE cards SET file_basename = id WHERE file_basename = ''`)
  // Index must come after the column exists on legacy DBs.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_project_basename ON cards(project, file_basename)`)
}

/**
 * Add `archived` to pre-Sprint-04+1 vaults (idempotent). Existing rows
 * default to 0 (not archived) — historical cards remain visible until
 * explicitly archived via the new tool.
 */
function migrateAddArchived(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(cards)`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'archived')) {
    db.exec(`ALTER TABLE cards ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`)
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_project_archived ON cards(project, archived)`)
}

/**
 * Add `sprint_id` and `blocked_by` together — they land in the same release
 * and share a migration window so a vault only sees one ALTER pass.
 */
function migrateAddSprintAndDeps(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(cards)`).all() as Array<{ name: string }>
  const names = new Set(cols.map((c) => c.name))
  if (!names.has('sprint_id')) {
    db.exec(`ALTER TABLE cards ADD COLUMN sprint_id TEXT`)
  }
  if (!names.has('blocked_by')) {
    db.exec(`ALTER TABLE cards ADD COLUMN blocked_by TEXT NOT NULL DEFAULT '[]'`)
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_project_sprint ON cards(project, sprint_id)`)
}

function isFreshlyCreated(db: Database.Database): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }
  return row.n === 0
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
