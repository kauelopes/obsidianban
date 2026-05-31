import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Paths } from '../config.js'
import type { CardRepository, CardRow } from '../cards/repository.js'
import type { AuditLogger } from '../audit/logger.js'
import type { AtomicWriter } from '../writer/atomic.js'
import type { SSEEventBus } from '../server/sse.js'
import { loadProjectMeta } from '../vault/layout.js'
import type { Card, ReorderResult, TokenClaims } from '../types.js'
import { cardFromFrontmatter, parseCardFile } from '../cards/serialize.js'
import { slugifyTitle, uniqueBasename } from '../cards/slug.js'
import { badRequest, conflict, forbidden, HttpError, notFound } from './errors.js'
import {
  generateCardId,
  optDueDate,
  optInt,
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
  'log_entry',
  'blocked_by',
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
  'blocked_by',
  'sprint_id',
] as const

const MOVE_ALLOWED = [
  'id', 'version', 'to_status', 'input_tokens', 'output_tokens', 'model', 'request_id',
] as const
const REORDER_ALLOWED = [
  'id', 'version', 'after_card_id', 'input_tokens', 'output_tokens', 'model', 'request_id',
] as const
const DELETE_ALLOWED = [
  'id', 'version', 'input_tokens', 'output_tokens', 'model', 'request_id',
] as const
const CLAIM_ALLOWED = [
  'id', 'version', 'input_tokens', 'output_tokens', 'model', 'request_id', 'actor',
] as const

const RELEASE_ALLOWED = [
  'id', 'version', 'input_tokens', 'output_tokens', 'model', 'request_id',
] as const

// Per-card entries in bulk_create payloads cannot carry these — they're
// owned by the envelope (one cost, one optional dedupe key for the batch).
const BULK_ENVELOPE_FIELDS = ['input_tokens', 'output_tokens', 'model', 'request_id'] as const

const BULK_CREATE_LIMIT = 100

const ARCHIVE_ALLOWED = [
  'id', 'version', 'input_tokens', 'output_tokens', 'model', 'request_id',
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

  /**
   * Throw 403 if the caller is an agent and the card is owned by someone
   * else. Manager passes through; unassigned cards pass through (an agent
   * interacting with a null-assigned card is implicitly claiming it).
   * Used to gate every mutation that isn't get/list.
   */
  private assertWritable(assignedTo: string | null, claims: TokenClaims): void {
    if (claims.role === 'manager') return
    if (assignedTo == null) return
    if (assignedTo === claims.actor) return
    throw forbidden('not_assigned', { assigned_to: assignedTo })
  }

  async get(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    const id = requireString(params, 'id')
    const row = this.repo.findById(id)
    if (!row) throw notFound()
    if (claims.role === 'agent' && row.project !== claims.project_id) throw notFound()

    const filePath = path.join(this.paths.kanbanData, row.project, `${row.file_basename}.md`)
    const content = await fs.readFile(filePath, 'utf8').catch((err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw notFound()
      throw err
    })
    const parsed = parseCardFile(content)
    const card = cardFromFrontmatter(parsed.data)
    card.body = parsed.body
    card.file_basename = row.file_basename
    return card
  }

  async create(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    rejectDisallowed(params, CREATE_ALLOWED)

    const title = requireString(params, 'title', 200, 'short card title, max 200 chars')
    const type = requireString(params, 'type', undefined, "card type — e.g. 'feature', 'bug', 'task', 'chore'")
    const inputTokens = optInt(params, 'input_tokens', 0)
    const outputTokens = optInt(params, 'output_tokens', 0)
    const model = requireString(params, 'model', undefined, "model identifier — e.g. 'claude-sonnet-4-6'")
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

    // sprint_id is mandatory on create: every new card belongs to a sprint.
    // Validate it points to a sprint in the same project and is in a state
    // that accepts new work (planning or active — closed sprints are frozen
    // history). Legacy cards with sprint_id=null are grandfathered (created
    // before this rule), but no new card can be born outside a sprint.
    const sprintId = requireString(params, 'sprint_id', undefined, 'id of a planning or active sprint in this project — call kanban_list_sprints to see available options')
    const allSprints = meta.sprints ?? []
    const targetSprint = allSprints.find((s) => s.id === sprintId)
    if (!targetSprint) {
      const available = allSprints
        .filter((s) => s.status !== 'closed')
        .map((s) => ({ id: s.id, name: s.name, status: s.status }))
      throw badRequest('invalid_field', {
        field: 'sprint_id',
        reason: `sprint "${sprintId}" not found in project "${project}"`,
        hint: 'use kanban_list_sprints to get valid sprint ids',
        available_sprints: available.length > 0 ? available : 'none — create a sprint first with kanban_create_sprint',
      })
    }
    if (targetSprint.status === 'closed') {
      const available = allSprints
        .filter((s) => s.status !== 'closed')
        .map((s) => ({ id: s.id, name: s.name, status: s.status }))
      throw badRequest('invalid_field', {
        field: 'sprint_id',
        reason: `sprint "${targetSprint.name}" is closed — cards cannot be added to a closed sprint`,
        hint: 'pick a planning or active sprint',
        available_sprints: available.length > 0 ? available : 'none — create a sprint first with kanban_create_sprint',
      })
    }

    const id = generateCardId()
    // blocked_by on create: same validation as update (existence, same-project,
    // dedup, sort). Self/cycle checks trivially pass since the new id isn't
    // in the repo yet, but we still pass it so normalizeBlockedBy's contract
    // stays consistent across create/update.
    const blockedBy =
      'blocked_by' in params
        ? this.normalizeBlockedBy(params['blocked_by'], id, project)
        : []
    const maxPos = this.repo.maxPosition(project, status)
    const position = (maxPos ?? 0) + 1000
    const now = new Date().toISOString()
    const fileBasename = uniqueBasename(this.repo, project, slugifyTitle(title))
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
      archived: false,
      sprint_id: sprintId,
      blocked_by: blockedBy,
      created_at: now,
      updated_at: now,
      created_by: claims.actor,
      updated_by: claims.actor,
    }

    await this.writer.write(card, body, fileBasename)
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

    return { ...card, body, file_basename: fileBasename }
  }

  async update(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    // Dev agents may not call update — they must use kanban_log_on_card.
    if (claims.role === 'agent' && claims.agent_type === 'dev') {
      throw forbidden('dev_agent_restricted', {
        message: 'Dev agents cannot call kanban_update_card. Use kanban_log_on_card to append entries to the card.',
        allowed_tool: 'kanban_log_on_card',
      })
    }
    // body is write-once at creation — give a clear error before the generic disallowed-field check.
    if ('body' in params) {
      throw badRequest('body_immutable', {
        message: 'body is write-once at creation. Use log_entry to append a timestamped entry to the # Agent Log section.',
        use_instead: 'log_entry',
      })
    }
    const allowed = claims.role === 'manager' ? UPDATE_ALLOWED_MANAGER : UPDATE_ALLOWED_AGENT
    rejectDisallowed(params, allowed)

    const id = requireString(params, 'id')
    const claimedVersion = requireInt(params, 'version', 1)
    const inputTokens = requireInt(params, 'input_tokens', 0, 'input tokens spent by the LLM working on this card since the last update — from usage.input_tokens of the current API response')
    const outputTokens = requireInt(params, 'output_tokens', 0, 'output tokens spent by the LLM working on this card since the last update — from usage.output_tokens of the current API response')
    const model = requireString(params, 'model', undefined, "model identifier — e.g. 'claude-sonnet-4-6'")

    const row = this.repo.findById(id)
    if (!row) throw notFound()
    if (claims.role === 'agent' && row.project !== claims.project_id) throw notFound()
    const current = this.repo.toCard(row)
    this.assertWritable(current.assigned_to, claims)

    // Read body from disk so we have it both for conflict responses and for
    // the no-body update path (preserve existing body).
    const filePath = path.join(this.paths.kanbanData, row.project, `${row.file_basename}.md`)
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
      // Sprint lock on status change via update — same rule as move().
      if (claims.role === 'agent' && current.sprint_id != null) {
        const sprint = (meta.sprints ?? []).find((sp) => sp.id === current.sprint_id)
        if (sprint && sprint.status !== 'active') {
          const fromIdx = meta.columns.indexOf(current.status)
          const toIdx = meta.columns.indexOf(s)
          if (toIdx > fromIdx) {
            throw badRequest('sprint_not_active', {
              message: `Cannot advance card status — sprint "${sprint.name}" is ${sprint.status}. Start the sprint first.`,
              sprint_id: sprint.id,
              sprint_status: sprint.status,
            })
          }
        }
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
    if (assigned.present) {
      proposed.assigned_to = assigned.value
      // Agents can only claim (set to own actor) or release (set to null).
      // Cross-agent reassignment is a manager-only operation.
      if (claims.role === 'agent' && assigned.value !== claims.actor && assigned.value !== null) {
        throw forbidden('cannot_reassign', { target: assigned.value })
      }
    }
    if ('agent_notes' in params) {
      proposed.agent_notes = optString(params, 'agent_notes', 2000)
    }
    if (claims.role === 'manager' && 'owner' in params) {
      proposed.owner = optNullableString(params, 'owner').value
    }
    if ('log_entry' in params) {
      const entry = optString(params, 'log_entry', 4000)
      if (entry) {
        const ts = new Date().toISOString().slice(0, 16).replace('T', ' ')
        const block = `**${ts}**\n\n${entry.trimEnd()}`
        const SECTION = '# Agent Log'
        if (currentBody.includes(SECTION)) {
          proposed.body = `${currentBody.trimEnd()}\n\n${block}`
        } else {
          proposed.body = currentBody
            ? `${currentBody.trimEnd()}\n\n${SECTION}\n\n${block}`
            : `${SECTION}\n\n${block}`
        }
      }
    }
    if ('blocked_by' in params) {
      const next = this.normalizeBlockedBy(params['blocked_by'], current.id, row.project)
      proposed.blocked_by = next
    }

    // Status change: if we're advancing into "in-progress" or beyond, the
    // card must not have unsatisfied blockers. We compare against `proposed`
    // so a single update can both rewrite blocked_by AND advance status,
    // as long as the new blocker list is satisfied.
    if (proposed.status && this.isAdvancingBeyondTodo(proposed.status, current.status)) {
      const blockersToCheck = proposed.blocked_by ?? current.blocked_by
      const unmet = this.unmetBlockers(blockersToCheck)
      if (unmet.length > 0) throw this.blockedConflict(unmet)
    }

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

    // Recompute filename when the title changed; keep existing on no-op or
    // when the slug collides with what we already have.
    let newBasename = row.file_basename
    if (merged.title !== current.title) {
      newBasename = uniqueBasename(this.repo, row.project, slugifyTitle(merged.title), id)
    }
    await this.writer.write(merged, newBody, newBasename, {
      previousBasename: row.file_basename,
    })
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
    return { ...merged, body: newBody, file_basename: newBasename }
  }

  async move(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    rejectDisallowed(params, MOVE_ALLOWED)
    const id = requireString(params, 'id')
    const claimedVersion = requireInt(params, 'version', 1)
    const toStatus = requireString(params, 'to_status')
    const inputTokens = requireInt(params, 'input_tokens', 0, 'input tokens spent by the LLM working on this card since the last update — from usage.input_tokens of the current API response')
    const outputTokens = requireInt(params, 'output_tokens', 0, 'output tokens spent by the LLM working on this card since the last update — from usage.output_tokens of the current API response')
    const model = requireString(params, 'model', undefined, "model identifier — e.g. 'claude-sonnet-4-6'")

    const row = this.repo.findById(id)
    if (!row) throw notFound()
    if (claims.role === 'agent' && row.project !== claims.project_id) throw notFound()

    const meta = await loadProjectMeta(this.paths, row.project).catch(() => null)
    if (!meta || !meta.columns.includes(toStatus)) {
      throw badRequest('invalid_field', { field: 'to_status', allowed: meta?.columns ?? [] })
    }

    const current = this.repo.toCard(row)
    this.assertWritable(current.assigned_to, claims)

    // Sprint lock: agents cannot move a card forward unless its sprint is active.
    if (claims.role === 'agent' && current.sprint_id != null) {
      const sprint = (meta.sprints ?? []).find((s) => s.id === current.sprint_id)
      if (sprint && sprint.status !== 'active') {
        const fromIdx = meta.columns.indexOf(current.status)
        const toIdx = meta.columns.indexOf(toStatus)
        if (toIdx > fromIdx) {
          throw badRequest('sprint_not_active', {
            message: `Cannot move card forward — sprint "${sprint.name}" is ${sprint.status}. Start the sprint first.`,
            sprint_id: sprint.id,
            sprint_status: sprint.status,
          })
        }
      }
    }

    if (this.isAdvancingBeyondTodo(toStatus, current.status)) {
      const unmet = this.unmetBlockers(current.blocked_by)
      if (unmet.length > 0) throw this.blockedConflict(unmet)
    }
    const filePath = path.join(this.paths.kanbanData, row.project, `${row.file_basename}.md`)
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

    await this.writer.write(merged, body, row.file_basename)
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

    return { ...merged, body, file_basename: row.file_basename }
  }

  async reorder(params: Record<string, unknown>, claims: TokenClaims): Promise<ReorderResult> {
    rejectDisallowed(params, REORDER_ALLOWED)
    const id = requireString(params, 'id')
    const claimedVersion = requireInt(params, 'version', 1)
    const inputTokens = requireInt(params, 'input_tokens', 0, 'input tokens spent by the LLM working on this card since the last update — from usage.input_tokens of the current API response')
    const outputTokens = requireInt(params, 'output_tokens', 0, 'output tokens spent by the LLM working on this card since the last update — from usage.output_tokens of the current API response')
    const model = requireString(params, 'model', undefined, "model identifier — e.g. 'claude-sonnet-4-6'")

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
    this.assertWritable(current.assigned_to, claims)

    const filePath = path.join(this.paths.kanbanData, row.project, `${row.file_basename}.md`)
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
        const fp = path.join(this.paths.kanbanData, row.project, `${r.file_basename}.md`)
        cardBody = parseCardFile(await fs.readFile(fp, 'utf8')).body
      }
      await this.writer.write(updated, cardBody, r.file_basename)
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

    return {
      card: { ...targetCard, body, file_basename: row.file_basename },
      affected_cards: affectedCards,
    }
  }

  async delete(params: Record<string, unknown>, claims: TokenClaims): Promise<{ deleted: true; id: string }> {
    rejectDisallowed(params, DELETE_ALLOWED)
    const id = requireString(params, 'id')
    const claimedVersion = requireInt(params, 'version', 1)
    const inputTokens = requireInt(params, 'input_tokens')
    const outputTokens = requireInt(params, 'output_tokens')
    const model = requireString(params, 'model')

    const row = this.repo.findById(id)
    if (!row) throw notFound()
    if (claims.role === 'agent' && row.project !== claims.project_id) throw notFound()
    this.assertWritable(this.repo.toCard(row).assigned_to, claims)

    if (claimedVersion !== row.version) {
      const current = this.repo.toCard(row)
      const filePath = path.join(this.paths.kanbanData, row.project, `${row.file_basename}.md`)
      const body = await fs.readFile(filePath, 'utf8').then(parseCardFile).then((p) => p.body).catch(() => '')
      throw conflict({
        message: `Version mismatch: expected ${claimedVersion}, found ${row.version}`,
        your_version: claimedVersion,
        current_version: row.version,
        conflicting_fields: [],
        current_card: { ...current, body },
      })
    }

    const filePath = path.join(this.paths.kanbanData, row.project, `${row.file_basename}.md`)
    await fs.unlink(filePath).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    })
    this.repo.delete(id)

    const now = new Date().toISOString()
    this.repo.logTokens({
      ts: now, op: 'DELETE', card_id: id, card_type: row.type,
      actor: claims.actor, model, input_tokens: inputTokens, output_tokens: outputTokens,
      project: row.project,
    })
    await this.audit.log({
      ts: now, op: 'DELETE', project: row.project, card_id: id, version: row.version,
      actor: claims.actor, input_tokens: inputTokens, output_tokens: outputTokens, model,
    })
    this.sse.emit({
      type: 'CARD_DELETED',
      payload: { card_id: id, project: row.project },
    })

    return { deleted: true, id }
  }

  async archive(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    return this.setArchived(params, claims, true)
  }

  async unarchive(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    return this.setArchived(params, claims, false)
  }

  private async setArchived(
    params: Record<string, unknown>,
    claims: TokenClaims,
    target: boolean,
  ): Promise<Card> {
    rejectDisallowed(params, ARCHIVE_ALLOWED)
    const id = requireString(params, 'id')
    const claimedVersion = requireInt(params, 'version', 1)
    const inputTokens = requireInt(params, 'input_tokens')
    const outputTokens = requireInt(params, 'output_tokens')
    const model = requireString(params, 'model')

    const row = this.repo.findById(id)
    if (!row) throw notFound()
    if (claims.role === 'agent' && row.project !== claims.project_id) throw notFound()
    const current = this.repo.toCard(row)
    this.assertWritable(current.assigned_to, claims)

    const filePath = path.join(this.paths.kanbanData, row.project, `${row.file_basename}.md`)
    const body = await fs.readFile(filePath, 'utf8').then(parseCardFile).then((p) => p.body).catch(() => '')

    if (claimedVersion !== current.version) {
      throw conflict({
        message: `Version mismatch: expected ${claimedVersion}, found ${current.version}`,
        your_version: claimedVersion,
        current_version: current.version,
        conflicting_fields: [],
        current_card: { ...current, body },
      })
    }

    // No-op short circuit: re-archiving an archived card (or vice versa)
    // returns the current card without bumping version or charging tokens.
    if (current.archived === target) return { ...current, body }

    const now = new Date().toISOString()
    const next: Omit<Card, 'body'> = {
      ...current,
      archived: target,
      version: current.version + 1,
      total_input_tokens: current.total_input_tokens + inputTokens,
      total_output_tokens: current.total_output_tokens + outputTokens,
      updated_at: now,
      updated_by: claims.actor,
    }

    await this.writer.write(next, body, row.file_basename)
    const op: 'ARCHIVE' | 'UNARCHIVE' = target ? 'ARCHIVE' : 'UNARCHIVE'
    this.repo.logTokens({
      ts: now, op: 'UPDATE', card_id: id, card_type: row.type,
      actor: claims.actor, model, input_tokens: inputTokens, output_tokens: outputTokens,
      project: row.project,
    })
    await this.audit.log({
      ts: now, op, project: row.project, card_id: id, version: next.version,
      actor: claims.actor, input_tokens: inputTokens, output_tokens: outputTokens, model,
    })
    this.sse.emit({
      type: target ? 'CARD_ARCHIVED' : 'CARD_UNARCHIVED',
      payload: { card_id: id, project: row.project },
    })
    return { ...next, body }
  }

  /**
   * Claim an unassigned card for the caller. Sugar over update_card with
   * cleaner errors: 409 `already_claimed` if someone else holds it.
   * Manager tokens can claim on behalf of an agent by passing actor=...
   * (defaults to claims.actor).
   */
  async claim(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    rejectDisallowed(params, CLAIM_ALLOWED)
    const id = requireString(params, 'id')
    const claimedVersion = requireInt(params, 'version', 1)
    const inputTokens = requireInt(params, 'input_tokens')
    const outputTokens = requireInt(params, 'output_tokens')
    const model = requireString(params, 'model')
    // Managers can claim-on-behalf via explicit actor; agents always claim
    // for themselves regardless of the param.
    const requestedActor = optString(params, 'actor')
    const targetActor =
      claims.role === 'manager' && requestedActor ? requestedActor : claims.actor

    const row = this.repo.findById(id)
    if (!row) throw notFound()
    if (claims.role === 'agent' && row.project !== claims.project_id) throw notFound()
    const current = this.repo.toCard(row)

    if (current.assigned_to != null && current.assigned_to !== targetActor) {
      throw conflict({
        error: 'already_claimed',
        message: `card is already claimed by ${current.assigned_to}`,
        current_assigned_to: current.assigned_to,
        current_version: current.version,
      })
    }

    return this.applyAssignedTo({
      id,
      claimedVersion,
      inputTokens,
      outputTokens,
      model,
      row,
      current,
      targetActor,
      op: 'CLAIM',
      sseFields: ['assigned_to'],
      claims,
    })
  }

  /**
   * Release a card you currently own. Manager tokens can release any card.
   */
  async release(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    rejectDisallowed(params, RELEASE_ALLOWED)
    const id = requireString(params, 'id')
    const claimedVersion = requireInt(params, 'version', 1)
    const inputTokens = requireInt(params, 'input_tokens')
    const outputTokens = requireInt(params, 'output_tokens')
    const model = requireString(params, 'model')

    const row = this.repo.findById(id)
    if (!row) throw notFound()
    if (claims.role === 'agent' && row.project !== claims.project_id) throw notFound()
    const current = this.repo.toCard(row)
    this.assertWritable(current.assigned_to, claims)

    if (current.assigned_to == null) {
      // No-op short-circuit, matching the project-archive semantics.
      const filePath = path.join(this.paths.kanbanData, row.project, `${row.file_basename}.md`)
      const body = await fs.readFile(filePath, 'utf8').then(parseCardFile).then((p) => p.body).catch(() => '')
      return { ...current, body }
    }

    return this.applyAssignedTo({
      id,
      claimedVersion,
      inputTokens,
      outputTokens,
      model,
      row,
      current,
      targetActor: null,
      op: 'RELEASE',
      sseFields: ['assigned_to'],
      claims,
    })
  }

  private async applyAssignedTo(args: {
    id: string
    claimedVersion: number
    inputTokens: number
    outputTokens: number
    model: string
    row: CardRow
    current: Omit<Card, 'body'>
    targetActor: string | null
    op: 'CLAIM' | 'RELEASE'
    sseFields: string[]
    claims: TokenClaims
  }): Promise<Card> {
    const { id, claimedVersion, inputTokens, outputTokens, model, row, current, targetActor, op, sseFields, claims } = args
    const filePath = path.join(this.paths.kanbanData, row.project, `${row.file_basename}.md`)
    const body = await fs.readFile(filePath, 'utf8').then(parseCardFile).then((p) => p.body).catch(() => '')

    if (claimedVersion !== current.version) {
      throw conflict({
        message: `Version mismatch: expected ${claimedVersion}, found ${current.version}`,
        your_version: claimedVersion,
        current_version: current.version,
        conflicting_fields: current.assigned_to !== targetActor ? ['assigned_to'] : [],
        current_card: { ...current, body },
      })
    }

    const now = new Date().toISOString()
    const next: Omit<Card, 'body'> = {
      ...current,
      assigned_to: targetActor,
      version: current.version + 1,
      total_input_tokens: current.total_input_tokens + inputTokens,
      total_output_tokens: current.total_output_tokens + outputTokens,
      updated_at: now,
      updated_by: claims.actor,
    }
    await this.writer.write(next, body, row.file_basename)
    this.repo.logTokens({
      ts: now, op: 'UPDATE', card_id: id, card_type: row.type,
      actor: claims.actor, model, input_tokens: inputTokens, output_tokens: outputTokens,
      project: row.project,
    })
    await this.audit.log({
      ts: now, op, project: row.project, card_id: id, version: next.version,
      actor: claims.actor, input_tokens: inputTokens, output_tokens: outputTokens, model,
      changed_fields: sseFields,
    })
    this.sse.emit({
      type: 'CARD_UPDATED',
      payload: { card_id: id, project: row.project, changed_fields: sseFields },
    })
    return { ...next, body }
  }

  /**
   * Create up to BULK_CREATE_LIMIT cards in one call. Use case: an agent
   * reads a PRD and produces N cards in a single LLM round — instead of
   * N tool calls and N audit rows for the same conversation, we charge
   * the envelope cost once and prorate it per card so per-card token
   * stats remain meaningful.
   *
   * Partial success on purpose: individual validation failures are
   * collected in `failed[]` with the original index, so the caller can
   * retry only the broken ones rather than the whole batch.
   */
  async bulkCreate(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<{
    created: Array<{ index: number; card: Card }>
    failed: Array<{ index: number; error: string; detail: Record<string, unknown> }>
  }> {
    const rawCards = params['cards']
    if (!Array.isArray(rawCards)) {
      throw badRequest('invalid_field', { field: 'cards', expected: 'array' })
    }
    if (rawCards.length === 0) {
      throw badRequest('invalid_field', { field: 'cards', reason: 'empty' })
    }
    if (rawCards.length > BULK_CREATE_LIMIT) {
      throw badRequest('invalid_field', {
        field: 'cards', reason: `at most ${BULK_CREATE_LIMIT} entries per call`,
        max: BULK_CREATE_LIMIT, given: rawCards.length,
      })
    }

    const envelopeInputTokens = requireInt(params, 'input_tokens')
    const envelopeOutputTokens = requireInt(params, 'output_tokens')
    const envelopeModel = requireString(params, 'model')
    // Optional project sugar — when set and the per-card entry omits its
    // own project, the envelope value is injected. Managers can still set
    // project per card to mix projects in one batch.
    const envelopeProject = params['project']
    if (envelopeProject != null && typeof envelopeProject !== 'string') {
      throw badRequest('invalid_field', { field: 'project', expected: 'string' })
    }
    // sprint_id envelope sugar mirrors project: parsing a PRD into a backlog
    // usually targets one sprint, so accepting it once at the envelope avoids
    // repeating it on every entry.
    const envelopeSprint = params['sprint_id']
    if (envelopeSprint != null && typeof envelopeSprint !== 'string') {
      throw badRequest('invalid_field', { field: 'sprint_id', expected: 'string' })
    }

    const n = rawCards.length
    const perInputBase = Math.floor(envelopeInputTokens / n)
    const perOutputBase = Math.floor(envelopeOutputTokens / n)
    const inputRemainder = envelopeInputTokens - perInputBase * n
    const outputRemainder = envelopeOutputTokens - perOutputBase * n

    const created: Array<{ index: number; card: Card }> = []
    const failed: Array<{ index: number; error: string; detail: Record<string, unknown> }> = []

    for (let i = 0; i < n; i++) {
      const entry = rawCards[i]
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        failed.push({ index: i, error: 'invalid_card', detail: { reason: 'must be object' } })
        continue
      }
      const cardInput = entry as Record<string, unknown>
      const conflictingKeys = BULK_ENVELOPE_FIELDS.filter((k) => k in cardInput)
      if (conflictingKeys.length > 0) {
        failed.push({
          index: i,
          error: 'invalid_card',
          detail: { reason: 'envelope-owned fields not allowed per card', fields: conflictingKeys },
        })
        continue
      }

      const isLast = i === n - 1
      const perInput = perInputBase + (isLast ? inputRemainder : 0)
      const perOutput = perOutputBase + (isLast ? outputRemainder : 0)
      const inner: Record<string, unknown> = {
        ...cardInput,
        input_tokens: perInput,
        output_tokens: perOutput,
        model: envelopeModel,
      }
      if (envelopeProject != null && !('project' in inner)) {
        inner['project'] = envelopeProject
      }
      if (envelopeSprint != null && !('sprint_id' in inner)) {
        inner['sprint_id'] = envelopeSprint
      }

      try {
        const card = await this.create(inner, claims)
        created.push({ index: i, card })
      } catch (err) {
        if (err instanceof HttpError) {
          const body = err.body as Record<string, unknown>
          const errCode = typeof body['error'] === 'string' ? body['error'] : 'http_error'
          failed.push({ index: i, error: errCode, detail: body })
        } else {
          failed.push({
            index: i, error: 'internal_error',
            detail: { message: (err as Error).message },
          })
        }
      }
    }

    return { created, failed }
  }

  // ── Dependencies helpers ────────────────────────────────────────────────

  /**
   * Returns true when the status transition crosses the "ready to advance"
   * boundary — anything past `todo` (in-progress, review, done) counts. The
   * threshold is intentionally simple: it matches the kanban_create_project
   * default columns and stays valid for any project that follows the same
   * "earlier columns are unstarted" convention.
   */
  private isAdvancingBeyondTodo(toStatus: string, fromStatus: string): boolean {
    const unstarted = new Set(['backlog', 'todo'])
    return !unstarted.has(toStatus) && unstarted.has(fromStatus)
  }

  /**
   * Return blockers that are NOT yet satisfied. A blocker is satisfied if
   * its card is `done` OR archived OR has been deleted (so an outdated
   * blocker reference never permanently locks a card). Cross-project
   * blockers are treated as unsatisfied if the blocker can't be found,
   * which is a conservative choice — it forces the manager to clean up.
   */
  private unmetBlockers(blockerIds: readonly string[]): Array<{
    id: string
    status: string | 'missing'
  }> {
    const unmet: Array<{ id: string; status: string | 'missing' }> = []
    for (const blockerId of blockerIds) {
      const row = this.repo.findById(blockerId)
      if (!row) {
        unmet.push({ id: blockerId, status: 'missing' })
        continue
      }
      if (row.status === 'done') continue
      if (row.archived === 1) continue
      unmet.push({ id: blockerId, status: row.status })
    }
    return unmet
  }

  private blockedConflict(
    unmet: Array<{ id: string; status: string | 'missing' }>,
  ): HttpError {
    return new HttpError(409, {
      error: 'blocked',
      message: 'card has unsatisfied dependencies',
      blockers: unmet,
    })
  }

  /**
   * Validate, dedupe, and cycle-check a proposed blocked_by list. Throws
   * 400 on bad input (non-string, self-reference, missing card, cycle).
   * Returns the canonicalized list (sorted for deterministic frontmatter).
   */
  private normalizeBlockedBy(raw: unknown, selfId: string, project: string): string[] {
    if (raw === null) return []
    if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) {
      throw badRequest('invalid_field', { field: 'blocked_by', expected: 'string[]' })
    }
    const dedup = Array.from(new Set(raw as string[]))
    if (dedup.includes(selfId)) {
      throw badRequest('invalid_field', {
        field: 'blocked_by', reason: 'card cannot block itself',
      })
    }
    for (const id of dedup) {
      const row = this.repo.findById(id)
      if (!row) {
        throw badRequest('invalid_field', {
          field: 'blocked_by', reason: `unknown card id ${id}`,
        })
      }
      if (row.project !== project) {
        throw badRequest('invalid_field', {
          field: 'blocked_by', reason: `cross-project blocker ${id}`,
        })
      }
    }
    // Cycle detection: walk forward from each proposed blocker; if any
    // path reaches selfId we'd form a cycle once we accept the new list.
    for (const startId of dedup) {
      if (this.reachesViaBlockers(startId, selfId)) {
        throw badRequest('invalid_field', {
          field: 'blocked_by', reason: `cycle: ${startId} → … → ${selfId}`,
        })
      }
    }
    return [...dedup].sort()
  }

  private reachesViaBlockers(startId: string, targetId: string): boolean {
    const seen = new Set<string>()
    const stack = [startId]
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (cur === targetId) return true
      if (seen.has(cur)) continue
      seen.add(cur)
      const row = this.repo.findById(cur)
      if (!row) continue
      const blockers = safeParseStringArray(row.blocked_by)
      for (const next of blockers) stack.push(next)
    }
    return false
  }

  /**
   * Find the next card "ready to pick up" — first non-blocked card in the
   * caller's project that matches the optional filters. Returns null when
   * nothing is ready, along with the count of would-match cards that are
   * still blocked so the agent can see "there's work, but it's gated".
   */
  async pickNext(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<{
    card: Omit<Card, 'body'> | null
    blocked_candidates: number
  }> {
    const project =
      claims.role === 'agent' ? claims.project_id : optString(params, 'project') ?? undefined
    const sprintIdFilter = optString(params, 'sprint_id')
    const assignedToFilter = optString(params, 'assigned_to')
    const statusFilter = optString(params, 'status') ?? 'todo'

    // Pull a generous slice; pick_next is meant to be called frequently
    // and the result set is small (cards in `todo` in one project).
    const rows = this.repo.query({
      project,
      status: statusFilter,
      assignedTo: assignedToFilter ?? undefined,
      includeArchived: false,
      orderBy: 'priority',
      limit: 200,
      offset: 0,
    })

    let blockedCandidates = 0
    for (const row of rows) {
      if (sprintIdFilter != null && row.sprint_id !== sprintIdFilter) continue
      const blockers = safeParseStringArray(row.blocked_by)
      if (blockers.length === 0) {
        return { card: this.repo.toCard(row), blocked_candidates: blockedCandidates }
      }
      const unmet = this.unmetBlockers(blockers)
      if (unmet.length === 0) {
        return { card: this.repo.toCard(row), blocked_candidates: blockedCandidates }
      }
      blockedCandidates += 1
    }
    return { card: null, blocked_candidates: blockedCandidates }
  }

  /**
   * Append-only log entry for Dev agents (and any agent). Accepts only
   * id, version, log_entry, and token cost fields — no other mutations.
   * Delegates to update() after stripping disallowed fields.
   */
  async logOnCard(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    const LOG_ONLY = ['id', 'version', 'log_entry', 'input_tokens', 'output_tokens', 'model', 'request_id'] as const
    rejectDisallowed(params, LOG_ONLY)
    if (!('log_entry' in params) || !params['log_entry']) {
      throw badRequest('missing_field', { field: 'log_entry', message: 'log_entry is required for kanban_log_on_card.' })
    }
    // Temporarily elevate dev agents to pm for the duration of this delegated update
    // so the pm-only guard in update() doesn't fire for a legitimate log call.
    const elevatedClaims: TokenClaims = claims.role === 'agent' && claims.agent_type === 'dev'
      ? { ...claims, agent_type: 'pm' }
      : claims
    return this.update(params, elevatedClaims)
  }
}

function safeParseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v
    return []
  } catch {
    return []
  }
}
