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

const PRIORITY_RANK = `CASE priority
  WHEN 'critical' THEN 0
  WHEN 'high' THEN 1
  WHEN 'medium' THEN 2
  WHEN 'low' THEN 3
  ELSE 4 END`

function orderByClause(o: 'position' | 'updated_at' | 'priority' | 'due_date'): string {
  switch (o) {
    case 'position':
      return 'position ASC'
    case 'updated_at':
      return 'updated_at DESC'
    case 'priority':
      return PRIORITY_RANK + ' ASC, position ASC'
    case 'due_date':
      return 'due_date IS NULL, due_date ASC'
  }
}

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

  query(opts: {
    project?: string
    status?: string
    assignedTo?: string
    tags?: string[]
    orderBy: 'position' | 'updated_at' | 'priority' | 'due_date'
    limit: number
    offset: number
  }): CardRow[] {
    const where: string[] = []
    const params: Record<string, unknown> = {}
    if (opts.project) {
      where.push('project = @project')
      params['project'] = opts.project
    }
    if (opts.status) {
      where.push('status = @status')
      params['status'] = opts.status
    }
    if (opts.assignedTo) {
      where.push('assigned_to = @assignedTo')
      params['assignedTo'] = opts.assignedTo
    }
    // tag AND filter: tags column stores JSON like ["a","b"]; LIKE with the
    // JSON-encoded value matches exact tag entries (quotes guard against
    // substring collisions between "auth" and "authorized").
    if (opts.tags && opts.tags.length > 0) {
      opts.tags.forEach((t, i) => {
        where.push(`tags LIKE @tag${i}`)
        params[`tag${i}`] = '%' + JSON.stringify(t) + '%'
      })
    }
    const sql =
      `SELECT * FROM cards` +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ` ORDER BY ${orderByClause(opts.orderBy)} LIMIT @limit OFFSET @offset`
    params['limit'] = opts.limit
    params['offset'] = opts.offset
    return this.db.prepare(sql).all(params) as CardRow[]
  }

  logTokens(entry: {
    ts: string
    op: 'CREATE' | 'UPDATE' | 'MOVE' | 'REORDER'
    card_id: string
    card_type: string
    actor: string
    model: string
    input_tokens: number
    output_tokens: number
    project: string
  }): void {
    this.db
      .prepare(
        `INSERT INTO token_log
           (ts, op, card_id, card_type, actor, model, input_tokens, output_tokens, project)
         VALUES (@ts, @op, @card_id, @card_type, @actor, @model, @input_tokens, @output_tokens, @project)`,
      )
      .run(entry)
  }

  /** Cards in a column ordered by position. */
  findByColumn(project: string, status: string): CardRow[] {
    return this.db
      .prepare(
        'SELECT * FROM cards WHERE project = ? AND status = ? ORDER BY position ASC',
      )
      .all(project, status) as CardRow[]
  }

  /** Highest position in a (project, status) column, or null if empty. */
  maxPosition(project: string, status: string): number | null {
    const row = this.db
      .prepare('SELECT MAX(position) AS m FROM cards WHERE project = ? AND status = ?')
      .get(project, status) as { m: number | null }
    return row.m
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
