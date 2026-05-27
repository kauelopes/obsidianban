import type Database from 'better-sqlite3'
import type { Card } from '../types.js'

export interface CardRow {
  id: string
  project: string
  title: string
  status: string
  type: string
  version: number
  position: number
  priority: string
  tags: string
  due_date: string | null
  assigned_to: string | null
  owner: string | null
  agent_notes: string | null
  total_input_tokens: number
  total_output_tokens: number
  created_at: string
  updated_at: string
  created_by: string
  updated_by: string
  file_hash: string
}

const COLUMNS =
  'id, project, title, status, type, version, position, priority, tags, ' +
  'due_date, assigned_to, owner, agent_notes, total_input_tokens, total_output_tokens, ' +
  'created_at, updated_at, created_by, updated_by, file_hash'

const PLACEHOLDERS = COLUMNS.split(', ')
  .map((c) => '@' + c)
  .join(', ')

export class CardRepository {
  constructor(private readonly db: Database.Database) {}

  insert(card: Omit<Card, 'body'>, fileHash: string): void {
    this.db
      .prepare(`INSERT INTO cards (${COLUMNS}) VALUES (${PLACEHOLDERS})`)
      .run({ ...card, tags: JSON.stringify(card.tags), file_hash: fileHash })
  }

  upsert(card: Omit<Card, 'body'>, fileHash: string): void {
    const existing = this.findById(card.id)
    if (existing) this.update(card, fileHash)
    else this.insert(card, fileHash)
  }

  update(card: Omit<Card, 'body'>, fileHash: string): void {
    this.db
      .prepare(
        `UPDATE cards SET
           project=@project, title=@title, status=@status, type=@type,
           version=@version, position=@position, priority=@priority, tags=@tags,
           due_date=@due_date, assigned_to=@assigned_to, owner=@owner,
           agent_notes=@agent_notes, total_input_tokens=@total_input_tokens,
           total_output_tokens=@total_output_tokens, updated_at=@updated_at,
           updated_by=@updated_by, file_hash=@file_hash
         WHERE id=@id`,
      )
      .run({ ...card, tags: JSON.stringify(card.tags), file_hash: fileHash })
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM cards WHERE id=?').run(id)
  }

  findById(id: string): CardRow | null {
    const row = this.db.prepare('SELECT * FROM cards WHERE id=?').get(id)
    return (row as CardRow | undefined) ?? null
  }

  allIds(): string[] {
    return (this.db.prepare('SELECT id FROM cards').all() as Array<{ id: string }>).map(
      (r) => r.id,
    )
  }

  toCard(row: CardRow): Omit<Card, 'body'> {
    return {
      id: row.id,
      project: row.project,
      title: row.title,
      status: row.status,
      type: row.type,
      version: row.version,
      position: row.position,
      priority: row.priority as Card['priority'],
      tags: JSON.parse(row.tags) as string[],
      due_date: row.due_date,
      assigned_to: row.assigned_to,
      owner: row.owner,
      agent_notes: row.agent_notes,
      total_input_tokens: row.total_input_tokens,
      total_output_tokens: row.total_output_tokens,
      created_at: row.created_at,
      updated_at: row.updated_at,
      created_by: row.created_by,
      updated_by: row.updated_by,
    }
  }
}
