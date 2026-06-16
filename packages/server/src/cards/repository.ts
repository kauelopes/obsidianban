import type Database from 'better-sqlite3'
import type { Card } from '@obsidiankan/types'

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
  file_basename: string
  archived: number  // SQLite stores 0/1; toCard converts to boolean
  sprint_id: string | null
  blocked_by: string  // JSON-encoded string[]
}

const COLUMNS =
  'id, project, title, status, type, version, position, priority, tags, ' +
  'due_date, assigned_to, owner, agent_notes, total_input_tokens, total_output_tokens, ' +
  'created_at, updated_at, created_by, updated_by, file_hash, file_basename, archived, ' +
  'sprint_id, blocked_by'

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

  insert(card: Omit<Card, 'body'>, fileHash: string, fileBasename: string): void {
    this.db
      .prepare(`INSERT INTO cards (${COLUMNS}) VALUES (${PLACEHOLDERS})`)
      .run({
        ...card,
        tags: JSON.stringify(card.tags),
        file_hash: fileHash,
        file_basename: fileBasename,
        archived: card.archived ? 1 : 0,
        blocked_by: JSON.stringify(card.blocked_by),
      })
  }

  upsert(card: Omit<Card, 'body'>, fileHash: string, fileBasename: string): void {
    const existing = this.findById(card.id)
    if (existing) this.update(card, fileHash, fileBasename)
    else this.insert(card, fileHash, fileBasename)
  }

  update(card: Omit<Card, 'body'>, fileHash: string, fileBasename: string): void {
    this.db
      .prepare(
        `UPDATE cards SET
           project=@project, title=@title, status=@status, type=@type,
           version=@version, position=@position, priority=@priority, tags=@tags,
           due_date=@due_date, assigned_to=@assigned_to, owner=@owner,
           agent_notes=@agent_notes, total_input_tokens=@total_input_tokens,
           total_output_tokens=@total_output_tokens, updated_at=@updated_at,
           updated_by=@updated_by, file_hash=@file_hash, file_basename=@file_basename,
           archived=@archived, sprint_id=@sprint_id, blocked_by=@blocked_by
         WHERE id=@id`,
      )
      .run({
        ...card,
        tags: JSON.stringify(card.tags),
        file_hash: fileHash,
        file_basename: fileBasename,
        archived: card.archived ? 1 : 0,
        blocked_by: JSON.stringify(card.blocked_by),
      })
  }

  findByBasename(project: string, basename: string): CardRow | null {
    const row = this.db
      .prepare('SELECT * FROM cards WHERE project = ? AND file_basename = ?')
      .get(project, basename)
    return (row as CardRow | undefined) ?? null
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM cards WHERE id=?').run(id)
  }

  /** Returns the number of rows deleted — used by project hard-delete. */
  deleteByProject(project: string): number {
    const r = this.db.prepare('DELETE FROM cards WHERE project=?').run(project)
    return r.changes
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
    sprintId?: string
    assignedTo?: string
    tags?: string[]
    includeArchived?: boolean
    archivedOnly?: boolean
    orderBy: 'position' | 'updated_at' | 'priority' | 'due_date'
    limit: number
    offset: number
  }): CardRow[] {
    const where: string[] = []
    const params: Record<string, unknown> = {}
    // archivedOnly takes precedence; otherwise hide archived unless opted-in
    if (opts.archivedOnly) {
      where.push('archived = 1')
    } else if (!opts.includeArchived) {
      where.push('archived = 0')
    }
    if (opts.project) {
      where.push('project = @project')
      params['project'] = opts.project
    }
    if (opts.status) {
      where.push('status = @status')
      params['status'] = opts.status
    }
    if (opts.sprintId) {
      where.push('sprint_id = @sprintId')
      params['sprintId'] = opts.sprintId
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
    op: 'CREATE' | 'UPDATE' | 'MOVE' | 'REORDER' | 'DELETE'
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

  /** Cards in a column ordered by position, optionally scoped to a sprint. */
  findByColumn(project: string, status: string, sprintId?: string | null): CardRow[] {
    if (sprintId != null) {
      return this.db
        .prepare(
          'SELECT * FROM cards WHERE project = ? AND status = ? AND sprint_id = ? ORDER BY position ASC',
        )
        .all(project, status, sprintId) as CardRow[]
    }
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
      file_basename: row.file_basename,
      archived: row.archived === 1,
      sprint_id: row.sprint_id,
      blocked_by: safeJsonStringArray(row.blocked_by),
    }
  }

  /**
   * All cards belonging to a sprint. Used by SprintService.get_sprint to
   * compute aggregates and by close_sprint to find rollover candidates.
   */
  findBySprint(sprintId: string): CardRow[] {
    return this.db
      .prepare('SELECT * FROM cards WHERE sprint_id = ? ORDER BY status, position ASC')
      .all(sprintId) as CardRow[]
  }
}

function safeJsonStringArray(raw: string): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v
    return []
  } catch (_err) {
    return [] // malformed JSON stored in SQLite column — return empty array
  }
}
