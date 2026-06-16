import Database from 'better-sqlite3'
import { SCHEMA_STATEMENTS } from '../../src/db/schema.js'
import { CardRepository } from '../../src/cards/repository.js'

export function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  const tx = db.transaction(() => {
    for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt)
    // Apply same migrations as openDatabase
    const cols = db.prepare('PRAGMA table_info(cards)').all() as Array<{ name: string }>
    const names = new Set(cols.map((c) => c.name))
    if (!names.has('file_basename')) {
      db.exec(`ALTER TABLE cards ADD COLUMN file_basename TEXT NOT NULL DEFAULT ''`)
    }
    if (!names.has('archived')) {
      db.exec(`ALTER TABLE cards ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`)
    }
    if (!names.has('sprint_id')) {
      db.exec(`ALTER TABLE cards ADD COLUMN sprint_id TEXT`)
    }
    if (!names.has('blocked_by')) {
      db.exec(`ALTER TABLE cards ADD COLUMN blocked_by TEXT NOT NULL DEFAULT '[]'`)
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_project_basename ON cards(project, file_basename)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_project_archived ON cards(project, archived)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_project_sprint ON cards(project, sprint_id)`)
    db.exec(`UPDATE cards SET file_basename = id WHERE file_basename = ''`)
  })
  tx()
  return db
}

export function createTestRepo(db: Database.Database): CardRepository {
  return new CardRepository(db)
}
