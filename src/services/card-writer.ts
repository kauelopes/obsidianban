import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Paths } from '../config.js'
import type { CardRepository } from '../cards/repository.js'
import type { AuditLogger } from '../audit/logger.js'
import type { AtomicWriter } from '../writer/atomic.js'
import type { SSEEventBus } from '../server/sse.js'
import { loadProjectMeta, loadProjectMetaOrNull } from '../vault/layout.js'
import type { Card, TokenClaims } from '../types.js'
import { slugifyTitle, uniqueBasename } from '../cards/slug.js'
import { POSITION_GAP } from '../util/constants.js'
import { badRequest, conflict, forbidden, notFound } from './errors.js'
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
import { readCardFile, readCardBody } from '../vault/card-file.js'
import {
  assertWritable,
  isAdvancingBeyondTodo,
  unmetBlockers,
  blockedConflict,
  sprintNotActiveError,
  safeParseStringArray,
} from './card-shared.js'

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

const DELETE_ALLOWED = [
  'id', 'version', 'input_tokens', 'output_tokens', 'model', 'request_id',
] as const

const ARCHIVE_ALLOWED = [
  'id', 'version', 'input_tokens', 'output_tokens', 'model', 'request_id',
] as const

export class CardWriter {
  constructor(
    private readonly paths: Paths,
    private readonly repo: CardRepository,
    private readonly writer: AtomicWriter,
    private readonly audit: AuditLogger,
    private readonly sse: SSEEventBus,
  ) {}

  async create(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    rejectDisallowed(params, CREATE_ALLOWED)

    const title = requireString(params, 'title', 200, 'short card title, max 200 chars')
    const type = requireString(params, 'type', undefined, "card type — e.g. 'feature', 'bug', 'task', 'chore'")
    const inputTokens = optInt(params, 'input_tokens', 0)
    const outputTokens = optInt(params, 'output_tokens', 0)
    const model = optString(params, 'model') ?? 'unknown'
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

    const meta = await loadProjectMeta(this.paths, project).catch((_err) => {
      throw badRequest('invalid_project', { project })
    })

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

    const requestedStatus = optString(params, 'status')
    // Active sprint: default to 'todo' — backlog has no meaning once the sprint
    // has started and pick_next would never see a backlog card.
    // Planning sprint: default to 'backlog' (first column).
    const defaultStatus = targetSprint.status === 'active' && meta.columns.includes('todo')
      ? 'todo'
      : meta.columns[0]
    const status = requestedStatus ?? defaultStatus
    if (!status) throw badRequest('invalid_project', { project, reason: 'no columns defined' })
    if (!meta.columns.includes(status)) {
      throw badRequest('invalid_field', { field: 'status', allowed: meta.columns })
    }
    // Sprint lock on create: forward statuses (in_progress, review, done) require
    // an active sprint. Planning sprints only accept backlog and todo.
    if (targetSprint.status !== 'active' && isAdvancingBeyondTodo(status, 'todo')) {
      throw sprintNotActiveError(targetSprint)
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
    const position = (maxPos ?? 0) + POSITION_GAP
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
    const inputTokens = optInt(params, 'input_tokens', 0)
    const outputTokens = optInt(params, 'output_tokens', 0)
    const model = optString(params, 'model') ?? 'unknown'

    const row = this.repo.findById(id)
    if (!row) throw notFound()
    if (claims.role === 'agent' && row.project !== claims.project_id) throw notFound()
    const current = this.repo.toCard(row)
    assertWritable(current.assigned_to, claims)

    // Read body from disk so we have it both for conflict responses and for
    // the no-body update path (preserve existing body).
    const filePath = path.join(this.paths.kanbanData, row.project, `${row.file_basename}.md`)
    const parsedFile = await readCardFile(filePath).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw notFound()
      throw err
    })
    const currentBody = parsedFile.body

    // Compute proposed updates (the new field values the caller wants applied).
    const proposed: Partial<Omit<Card, 'body'>> & { body?: string } = {}
    if ('title' in params) proposed.title = requireString(params, 'title', 200)
    if ('status' in params) {
      const s = requireString(params, 'status')
      const meta = await loadProjectMetaOrNull(this.paths, row.project)
      const resolvedS = meta?.columns.includes(s) ? s : null
      if (!meta || !resolvedS) {
        throw badRequest('invalid_field', { field: 'status', allowed: meta?.columns ?? [] })
      }
      // Sprint lock on status change: forward movement requires an active sprint.
      if (current.sprint_id != null) {
        const sprint = (meta.sprints ?? []).find((sp) => sp.id === current.sprint_id)
        if (sprint && sprint.status !== 'active') {
          const fromIdx = meta.columns.indexOf(current.status)
          const toIdx = meta.columns.indexOf(resolvedS)
          if (toIdx > fromIdx) throw sprintNotActiveError(sprint)
        }
      }
      proposed.status = resolvedS
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
      let entry = optString(params, 'log_entry', 4000)
      if (entry) {
        // LLMs sometimes emit \n as two literal characters (backslash + n)
        // instead of a real newline. Since log_entry is always Markdown,
        // normalize both forms to actual newlines.
        entry = entry.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
        const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
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

    // Status change: if we're advancing into "in_progress" or beyond, the
    // card must not have unsatisfied blockers. We compare against `proposed`
    // so a single update can both rewrite blocked_by AND advance status,
    // as long as the new blocker list is satisfied.
    if (proposed.status && isAdvancingBeyondTodo(proposed.status, current.status)) {
      const blockersToCheck = proposed.blocked_by ?? current.blocked_by
      const unmet = unmetBlockers(this.repo, blockersToCheck)
      if (unmet.length > 0) throw blockedConflict(unmet)
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
        hint: 'the card changed since you last read it — re-read it with kanban_get_card and retry with the current version',
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
      merged.position = (maxPos ?? 0) + POSITION_GAP
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

  async delete(params: Record<string, unknown>, claims: TokenClaims): Promise<{ deleted: true; id: string }> {
    rejectDisallowed(params, DELETE_ALLOWED)
    const id = requireString(params, 'id')
    const claimedVersion = requireInt(params, 'version', 1)
    const inputTokens = optInt(params, 'input_tokens', 0)
    const outputTokens = optInt(params, 'output_tokens', 0)
    const model = optString(params, 'model') ?? 'unknown'

    const row = this.repo.findById(id)
    if (!row) throw notFound()
    if (claims.role === 'agent' && row.project !== claims.project_id) throw notFound()
    assertWritable(this.repo.toCard(row).assigned_to, claims)

    if (claimedVersion !== row.version) {
      const current = this.repo.toCard(row)
      const filePath = path.join(this.paths.kanbanData, row.project, `${row.file_basename}.md`)
      const body = await readCardBody(filePath)
      throw conflict({
        message: `Version mismatch: expected ${claimedVersion}, found ${row.version}`,
        hint: 'the card changed since you last read it — re-read it with kanban_get_card and retry with the current version',
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
    const inputTokens = optInt(params, 'input_tokens', 0)
    const outputTokens = optInt(params, 'output_tokens', 0)
    const model = optString(params, 'model') ?? 'unknown'

    const row = this.repo.findById(id)
    if (!row) throw notFound()
    if (claims.role === 'agent' && row.project !== claims.project_id) throw notFound()
    const current = this.repo.toCard(row)
    assertWritable(current.assigned_to, claims)

    const filePath = path.join(this.paths.kanbanData, row.project, `${row.file_basename}.md`)
    const body = await readCardBody(filePath)

    if (claimedVersion !== current.version) {
      throw conflict({
        message: `Version mismatch: expected ${claimedVersion}, found ${current.version}`,
        hint: 'the card changed since you last read it — re-read it with kanban_get_card and retry with the current version',
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
}
