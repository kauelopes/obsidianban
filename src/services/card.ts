import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Paths } from '../config.js'
import type { CardRepository } from '../cards/repository.js'
import type { AuditLogger } from '../audit/logger.js'
import type { AtomicWriter } from '../writer/atomic.js'
import { loadProjectMeta } from '../vault/layout.js'
import type { Card, TokenClaims } from '../types.js'
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

/** Fields the agent is allowed to send in create_card. */
const CREATE_ALLOWED_AGENT = [
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
] as const
/** Manager additionally must specify the project (no claims.project_id). */
const CREATE_ALLOWED_MANAGER = [...CREATE_ALLOWED_AGENT, 'project'] as const

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
    rejectDisallowed(params, claims.role === 'manager' ? CREATE_ALLOWED_MANAGER : CREATE_ALLOWED_AGENT)

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

    const project = claims.role === 'agent' ? claims.project_id : requireString(params, 'project')

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
    return { ...merged, body: newBody }
  }
}
