import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Paths } from '../config.js'
import type { CardRepository } from '../cards/repository.js'
import type { AuditLogger } from '../audit/logger.js'
import type { AtomicWriter } from '../writer/atomic.js'
import type { SSEEventBus } from '../server/sse.js'
import { loadProjectMeta } from '../vault/layout.js'
import type { Card, ReorderResult, TokenClaims } from '../types.js'
import { cardFromFrontmatter, parseCardFile } from '../cards/serialize.js'
import { badRequest, conflict, notFound } from './errors.js'
import {
  generateCardId,
  optDueDate,
  optNullableString,
  optPriority,
  optString,
  optTags,
  rejectDisallowed,
  requireInt,
  requireString,
} from './validation.js'

/** Fields the agent is allowed to send in update_card. */
const UPDATE_ALLOWED_AGENT = [
  'id',
  'version',
  'input_tokens',
  'output_tokens',
  'model',
  'request_id',
  'title',
  'status',
  'priority',
  'tags',
  'due_date',
  'assigned_to',
  'agent_notes',
  'body',
] as const
const UPDATE_ALLOWED_MANAGER = [...UPDATE_ALLOWED_AGENT, 'owner'] as const

/** Fields allowed in create_card. `project` semantics differ by role: for
 *  managers it's mandatory; for agents it's optional but, if sent, must
 *  match claims.project_id (validated below). Lets UI clients use one shape. */
const CREATE_ALLOWED = [
  'title',
  'type',
  'input_tokens',
  'output_tokens',
  'model',
  'status',
  'priority',
  'tags',
  'due_date',
  'assigned_to',
  'body',
  'agent_notes',
  'request_id',
  'project',
] as const

const MOVE_ALLOWED = [
  'id', 'version', 'to_status', 'input_tokens', 'output_tokens', 'model', 'request_id',
] as const
const REORDER_ALLOWED = [
  'id', 'version', 'after_card_id', 'input_tokens', 'output_tokens', 'model', 'request_id',
] as const

/**
 * Mutation entry point for cards. Read isolation:
 *   - agent token: only sees / writes to claims.project_id
 *   - manager token: any project
 * Cross-project access collapses to 404 (BR-03).
 */
export class CardService {
  constructor(
    private readonly paths: Paths,
    private readonly repo: CardRepository,
    private readonly writer: AtomicWriter,
    private readonly audit: AuditLogger,
    private readonly sse: SSEEventBus,
  ) {}

  async get(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    const id = requireString(params, 'id')
    const row = this.repo.findById(id)
    if (!row) throw notFound()
    if (claims.role === 'agent' && row.project !== claims.project_id) throw notFound()

    const filePath = path.join(this.paths.kanbanData, row.project, `${id}.md`)
    const content = await fs.readFile(filePath, 'utf8').catch((err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw notFound()
      throw err
    })
    const parsed = parseCardFile(content)
    const card = cardFromFrontmatter(parsed.data)
    card.body = parsed.body
    return card
  }

  async create(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    rejectDisallowed(params, CREATE_ALLOWED)

    const title = requireString(params, 'title', 200)
    const type = requireString(params, 'type')
    const inputTokens = requireInt(params, 'input_tokens')
    const outputTokens = requireInt(params, 'output_tokens')
    const model = requireString(params, 'model')
    const priority = optPriority(params) ?? 'medium'
    const tags = optTags(params) ?? []
    const dueDate = optDueDate(params).value
    const assignedTo = optString(params, 'assigned_to')
    const body = optString(params, 'body') ?? ''
    const agentNotes = optString(params, 'agent_notes', 2000)

    let project: string
    if (claims.role === 'agent') {
      project = claims.project_id
      const sent = params['project']
      if (sent !== undefined && sent !== project) {
        throw badRequest('invalid_field', {
          field: 'project',
          reason: 'agent token can only create cards in its own project',
        })
      }
    } else {
      project = requireString(params, 'project')
    }

    const meta = await loadProjectMeta(this.paths, project).catch(() => {
      throw badRequest('invalid_project', { project })
    })
    const requestedStatus = optString(params, 'status')
    const status = requestedStatus ?? meta.columns[0]
    if (!status) throw badRequest('invalid_project', { project, reason: 'no columns defined' })
    if (!meta.columns.includes(status)) {
      throw badRequest('invalid_field', { field: 'status', allowed: meta.columns })
    }

    const id = generateCardId()
    const maxPos = this.repo.maxPosition(project, status)
    const position = (maxPos ?? 0) + 1000
    const now = new Date().toISOString()
    const card: Omit<Card, 'body'> = {
      id,
      project,
      title,
      status,
      type,
      version: 1,
      position,
      priority,
      tags,
      due_date: dueDate,
      assigned_to: assignedTo,
      owner: null,
      agent_notes: agentNotes,
      total_input_tokens: inputTokens,
      total_output_tokens: outputTokens,
      created_at: now,
      updated_at: now,
      created_by: claims.actor,
      updated_by: claims.actor,
    }

    await this.writer.write(card, body)
    this.repo.logTokens({
      ts: now,
      op: 'CREATE',
      card_id: id,
      card_type: type,
      actor: claims.actor,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      project,
    })
    await this.audit.log({
      ts: now,
      op: 'CREATE',
      project,
      card_id: id,
      version: 1,
      actor: claims.actor,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      model,
    })
    this.sse.emit({
      type: 'CARD_CREATED',
      payload: { card_id: id, project, status, position },
    })

    return { ...card, body }
  }

  async update(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    const allowed = claims.role === 'manager' ? UPDATE_ALLOWED_MANAGER : UPDATE_ALLOWED_AGENT
    rejectDisallowed(params, allowed)

    const id = requireString(params, 'id')
    const claimedVersion = requireInt(params, 'version', 1)
    const inputTokens = requireInt(params, 'input_tokens')
    const outputTokens = requireInt(params, 'output_tokens')
    const model = requireString(params, 'model')

    const row = this.repo.findById(id)
    if (!row) throw notFound()
    if (claims.role === 'agent' && row.project !== claims.project_id) throw notFound()
    const current = this.repo.toCard(row)

    // Read body from disk so we have it both for conflict responses and for
    // the no-body update path (preserve existing body).
    const filePath = path.join(this.paths.kanbanData, row.project, `${id}.md`)
    const fileContent = await fs.readFile(filePath, 'utf8').catch((err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw notFound()
      throw err
    })
    const parsedFile = parseCardFile(fileContent)
    const currentBody = parsedFile.body

    // Compute proposed updates (the new field values the caller wants applied).
    const proposed: Partial<Omit<Card, 'body'>> & { body?: string } = {}
    if ('title' in params) proposed.title = requireString(params, 'title', 200)
    if ('status' in params) {
      const s = requireString(params, 'status')
      const meta = await loadProjectMeta(this.paths, row.project).catch(() => null)
      if (!meta || !meta.columns.includes(s)) {
        throw badRequest('invalid_field', { field: 'status', allowed: meta?.columns ?? [] })
      }
      proposed.status = s
    }
    if ('priority' in params) {
      const pr = optPriority(params)
      if (pr) proposed.priority = pr
    }
    if ('tags' in params) {
      const t = optTags(params)
      if (t) proposed.tags = t
    }
    const due = optDueDate(params)
    if (due.present) proposed.due_date = due.value
    const assigned = optNullableString(params, 'assigned_to')
    if (assigned.present) proposed.assigned_to = assigned.value
    if ('agent_notes' in params) {
      proposed.agent_notes = optString(params, 'agent_notes', 2000)
    }
    if (claims.role === 'manager' && 'owner' in params) {
      proposed.owner = optNullableString(params, 'owner').value
    }
    if ('body' in params) proposed.body = optString(params, 'body') ?? ''

    // Version check — must happen after disallowed-field check but before
    // applying any change. PRD §6.4: 409 with current_card + conflicting_fields.
    if (claimedVersion !== current.version) {
      const conflicting: string[] = []
      for (const k of Object.keys(proposed) as Array<keyof typeof proposed>) {
        if (k === 'body') {
          if (proposed.body !== currentBody) conflicting.push('body')
          continue
        }
        const before = (current as Record<string, unknown>)[k]
        const after = (proposed as Record<string, unknown>)[k]
        if (JSON.stringify(before) !== JSON.stringify(after)) conflicting.push(k as string)
      }
      throw conflict({
        message: `Version mismatch: expected ${claimedVersion}, found ${current.version}`,
        your_version: claimedVersion,
        current_version: current.version,
        conflicting_fields: conflicting,
        current_card: { ...current, body: currentBody },
      })
    }

    // Apply proposed fields onto the current card.
    const merged: Omit<Card, 'body'> = { ...current }
    const changedFields: string[] = []
    for (const k of Object.keys(proposed) as Array<keyof typeof proposed>) {
      if (k === 'body') continue
      const before = (current as Record<string, unknown>)[k]
      const after = (proposed as Record<string, unknown>)[k]
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        ;(merged as Record<string, unknown>)[k] = after
        changedFields.push(k as string)
      }
    }
    const newBody = 'body' in proposed ? proposed.body! : currentBody
    if (newBody !== currentBody) changedFields.push('body')

    // Status change → re-position to bottom of destination column (PRD §5.4).
    if (proposed.status && proposed.status !== current.status) {
      const maxPos = this.repo.maxPosition(row.project, proposed.status)
      merged.position = (maxPos ?? 0) + 1000
      changedFields.push('position')
    }

    merged.version = current.version + 1
    const now = new Date().toISOString()
    merged.updated_at = now
    merged.updated_by = claims.actor
    merged.total_input_tokens = current.total_input_tokens + inputTokens
    merged.total_output_tokens = current.total_output_tokens + outputTokens

    await this.writer.write(merged, newBody)
    this.repo.logTokens({
      ts: now,
      op: 'UPDATE',
      card_id: id,
      card_type: current.type,
      actor: claims.actor,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      project: row.project,
    })
    await this.audit.log({
      ts: now,
      op: 'UPDATE',
      project: row.project,
      card_id: id,
      version: merged.version,
      actor: claims.actor,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      model,
      changed_fields: changedFields,
    })
    this.sse.emit({
      type: 'CARD_UPDATED',
      payload: { card_id: id, project: row.project, changed_fields: changedFields },
    })
    return { ...merged, body: newBody }
  }

  async move(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    rejectDisallowed(params, MOVE_ALLOWED)
    const id = requireString(params, 'id')
    const claimedVersion = requireInt(params, 'version', 1)
    const toStatus = requireString(params, 'to_status')
    const inputTokens = requireInt(params, 'input_tokens')
    const outputTokens = requireInt(params, 'output_tokens')
    const model = requireString(params, 'model')

    const row = this.repo.findById(id)
    if (!row) throw notFound()
    if (claims.role === 'agent' && row.project !== claims.project_id) throw notFound()

    const meta = await loadProjectMeta(this.paths, row.project).catch(() => null)
    if (!meta || !meta.columns.includes(toStatus)) {
      throw badRequest('invalid_field', { field: 'to_status', allowed: meta?.columns ?? [] })
    }

    const current = this.repo.toCard(row)
    const filePath = path.join(this.paths.kanbanData, row.project, `${id}.md`)
    const parsedFile = parseCardFile(await fs.readFile(filePath, 'utf8'))
    const body = parsedFile.body

    if (claimedVersion !== current.version) {
      const conflicting = current.status === toStatus ? [] : ['status']
      throw conflict({
        message: `Version mismatch: expected ${claimedVersion}, found ${current.version}`,
        your_version: claimedVersion,
        current_version: current.version,
        conflicting_fields: conflicting,
        current_card: { ...current, body },
      })
    }

    const fromStatus = current.status
    const maxPos = this.repo.maxPosition(row.project, toStatus)
    const newPosition = (maxPos ?? 0) + 1000
    const now = new Date().toISOString()
    const merged: Omit<Card, 'body'> = {
      ...current,
      status: toStatus,
      position: newPosition,
      version: current.version + 1,
      updated_at: now,
      updated_by: claims.actor,
      total_input_tokens: current.total_input_tokens + inputTokens,
      total_output_tokens: current.total_output_tokens + outputTokens,
    }

    await this.writer.write(merged, body)
    this.repo.logTokens({
      ts: now, op: 'MOVE', card_id: id, card_type: current.type,
      actor: claims.actor, model, input_tokens: inputTokens, output_tokens: outputTokens,
      project: row.project,
    })
    await this.audit.log({
      ts: now, op: 'MOVE', project: row.project, card_id: id, version: merged.version,
      actor: claims.actor, input_tokens: inputTokens, output_tokens: outputTokens, model,
      from_status: fromStatus, to_status: toStatus,
    })
    this.sse.emit({
      type: 'CARD_MOVED',
      payload: { card_id: id, project: row.project, from_status: fromStatus, to_status: toStatus, new_position: newPosition },
    })

    return { ...merged, body }
  }

  async reorder(params: Record<string, unknown>, claims: TokenClaims): Promise<ReorderResult> {
    rejectDisallowed(params, REORDER_ALLOWED)
    const id = requireString(params, 'id')
    const claimedVersion = requireInt(params, 'version', 1)
    const inputTokens = requireInt(params, 'input_tokens')
    const outputTokens = requireInt(params, 'output_tokens')
    const model = requireString(params, 'model')

    // after_card_id is required but may be null (insert at top)
    if (!('after_card_id' in params)) {
      throw badRequest('invalid_field', { field: 'after_card_id', expected: 'string or null' })
    }
    const rawAfter = params['after_card_id']
    let afterCardId: string | null
    if (rawAfter === null) afterCardId = null
    else if (typeof rawAfter === 'string') afterCardId = rawAfter
    else throw badRequest('invalid_field', { field: 'after_card_id', expected: 'string or null' })

    const row = this.repo.findById(id)
    if (!row) throw notFound()
    if (claims.role === 'agent' && row.project !== claims.project_id) throw notFound()
    const current = this.repo.toCard(row)

    const filePath = path.join(this.paths.kanbanData, row.project, `${id}.md`)
    const parsedFile = parseCardFile(await fs.readFile(filePath, 'utf8'))
    const body = parsedFile.body

    if (claimedVersion !== current.version) {
      throw conflict({
        message: `Version mismatch: expected ${claimedVersion}, found ${current.version}`,
        your_version: claimedVersion,
        current_version: current.version,
        conflicting_fields: [],
        current_card: { ...current, body },
      })
    }

    if (afterCardId !== null) {
      const afterRow = this.repo.findById(afterCardId)
      if (!afterRow || afterRow.project !== row.project || afterRow.status !== current.status) {
        throw badRequest('invalid_field', {
          field: 'after_card_id',
          reason: 'must reference a card in the same project and column',
        })
      }
    }

    // Build the new column order: take the existing column, remove the target,
    // insert it after `afterCardId` (or at the top if null), then normalize.
    const column = this.repo.findByColumn(row.project, current.status)
    const withoutTarget = column.filter((r) => r.id !== id)
    let insertIdx: number
    if (afterCardId === null) insertIdx = 0
    else insertIdx = withoutTarget.findIndex((r) => r.id === afterCardId) + 1
    const reordered = [
      ...withoutTarget.slice(0, insertIdx),
      row,
      ...withoutTarget.slice(insertIdx),
    ]

    const now = new Date().toISOString()
    const affectedCards: Array<{ id: string; new_version: number; new_position: number }> = []
    let targetCard: Omit<Card, 'body'> = current

    for (let i = 0; i < reordered.length; i++) {
      const r = reordered[i]!
      const newPos = (i + 1) * 1000
      const isTarget = r.id === id
      const card = this.repo.toCard(r)
      const oldPos = card.position
      if (newPos === oldPos && !isTarget) {
        // unchanged neighbour — no write, no audit row
        continue
      }
      const updated: Omit<Card, 'body'> = {
        ...card,
        position: newPos,
        version: card.version + 1,
        updated_at: now,
        updated_by: isTarget ? claims.actor : 'system:reorder',
      }
      if (isTarget) {
        updated.total_input_tokens = card.total_input_tokens + inputTokens
        updated.total_output_tokens = card.total_output_tokens + outputTokens
        targetCard = updated
      }
      // Read each neighbour's body from disk (needed for atomic rewrite).
      let cardBody = ''
      if (isTarget) {
        cardBody = body
      } else {
        const fp = path.join(this.paths.kanbanData, row.project, `${r.id}.md`)
        cardBody = parseCardFile(await fs.readFile(fp, 'utf8')).body
      }
      await this.writer.write(updated, cardBody)
      affectedCards.push({ id: r.id, new_version: updated.version, new_position: newPos })
    }

    this.repo.logTokens({
      ts: now, op: 'REORDER', card_id: id, card_type: current.type,
      actor: claims.actor, model, input_tokens: inputTokens, output_tokens: outputTokens,
      project: row.project,
    })
    await this.audit.log({
      ts: now, op: 'REORDER', project: row.project, card_id: id, version: targetCard.version,
      actor: claims.actor, input_tokens: inputTokens, output_tokens: outputTokens, model,
      affected_cards: affectedCards.map((a) => a.id),
    })
    this.sse.emit({
      type: 'CARD_REORDERED',
      payload: {
        project: row.project,
        status: current.status,
        affected_cards: affectedCards.map((a) => ({ id: a.id, new_position: a.new_position })),
      },
    })

    return { card: { ...targetCard, body }, affected_cards: affectedCards }
  }
}
