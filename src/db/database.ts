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
  })
  tx()
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
