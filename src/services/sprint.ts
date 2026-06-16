import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Paths } from '../config.js'
import { logger } from '../util/logger.js'
import type { Sprint, TokenClaims, Card } from '../types.js'
import type { CardRepository } from '../cards/repository.js'
import type { AuditLogger } from '../audit/logger.js'
import type { SSEEventBus } from '../server/sse.js'
import type { AtomicWriter } from '../writer/atomic.js'
import {
  loadProjectMeta,
  loadProjectMetaOrNull,
  saveProjectMeta,
  type ProjectMeta,
} from '../vault/layout.js'
import { parseCardFile } from '../cards/serialize.js'
import { generateSprintId, requireString, optString } from './validation.js'
import { badRequest, HttpError, notFound } from './errors.js'

interface SprintAggregates {
  cards_total: number
  cards_done: number
  cards_in_progress: number
  cards_todo: number
  cards_other: number
  total_input_tokens: number
  total_output_tokens: number
}

const MAX_NAME = 80
const MAX_GOAL = 1000

export class SprintService {
  constructor(
    private readonly paths: Paths,
    private readonly repo: CardRepository,
    private readonly writer: AtomicWriter,
    private readonly audit: AuditLogger,
    private readonly sse: SSEEventBus,
  ) {}

  async createSprint(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<Sprint> {
    requirePmOrManager(claims)
    const project = claims.role === 'agent'
      ? claims.project_id
      : requireString(params, 'project')
    const name = requireString(params, 'name', MAX_NAME)
    const goalRaw = optString(params, 'goal', MAX_GOAL)
    const goal = goalRaw ?? null

    const meta = await loadProjectMetaOrNull(this.paths, project)
    if (!meta) throw notFound()

    const now = new Date().toISOString()
    const sprint: Sprint = {
      id: generateSprintId(),
      name,
      goal,
      created_at: now,
      started_at: null,
      ended_at: null,
      status: 'planning',
    }
    meta.sprints = [...(meta.sprints ?? []), sprint]
    await saveProjectMeta(this.paths, project, meta)
    await this.audit.log({
      ts: now,
      op: 'SPRINT_CREATED',
      project,
      actor: claims.actor,
      reason: `sprint_id=${sprint.id} name=${name}`,
    })
    this.sse.emit({ type: 'SPRINT_CREATED', payload: { sprint_id: sprint.id, project } })
    return sprint
  }

  /**
   * Transition a sprint from planning → active. Refuses if another sprint
   * in the same project is already active — the model is one active sprint
   * per project, so the agent's "what should I work on" answer is unambiguous.
   */
  async startSprint(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<Sprint & { project: string; promoted_to_todo: string[] }> {
    requirePmOrManager(claims)
    const sprintId = requireString(params, 'sprint_id')
    const located = await this.findSprint(sprintId, claims)
    if (located.sprint.status === 'active') {
      throw badRequest('invalid_field', { field: 'sprint_id', reason: 'already active' })
    }
    if (located.sprint.status === 'closed') {
      throw badRequest('invalid_field', { field: 'sprint_id', reason: 'sprint is closed' })
    }
    const otherActive = (located.meta.sprints ?? []).find(
      (s) => s.id !== sprintId && s.status === 'active',
    )
    if (otherActive) {
      throw new HttpError(409, {
        error: 'conflict',
        reason: 'another_sprint_active',
        active_sprint_id: otherActive.id,
      })
    }
    const startedAt = new Date().toISOString()
    located.sprint.status = 'active'
    located.sprint.started_at = startedAt
    await saveProjectMeta(this.paths, located.project, located.meta)

    // Promote all backlog cards in this sprint to todo.
    const sprintCards = this.repo.findBySprint(sprintId)
    const backlogCards = sprintCards.filter((r) => r.status === 'backlog')
    const promotedToTodo: string[] = []
    const todoCol = located.meta.columns.includes('todo') ? 'todo' : located.meta.columns[0] ?? 'todo'
    for (const row of backlogCards) {
      const current = this.repo.toCard(row)
      const maxPos = this.repo.maxPosition(located.project, todoCol)
      const promoted: Omit<Card, 'body'> = {
        ...current,
        status: todoCol,
        position: (maxPos ?? 0) + 1000,
        version: current.version + 1,
        updated_at: startedAt,
        updated_by: claims.actor,
      }
      const body = await this.readBody(located.project, row.file_basename)
      await this.writer.write(promoted, body, row.file_basename)
      await this.audit.log({
        ts: startedAt,
        op: 'UPDATE',
        project: located.project,
        card_id: row.id,
        version: promoted.version,
        actor: claims.actor,
        changed_fields: ['status', 'position'],
        reason: `promoted backlog→todo on sprint start`,
      })
      this.sse.emit({
        type: 'CARD_UPDATED',
        payload: { card_id: row.id, project: located.project, changed_fields: ['status', 'position'] },
      })
      promotedToTodo.push(row.id)
    }

    await this.audit.log({
      ts: startedAt,
      op: 'SPRINT_STARTED',
      project: located.project,
      actor: claims.actor,
      reason: `sprint_id=${sprintId} promoted_to_todo=${promotedToTodo.length}`,
    })
    this.sse.emit({ type: 'SPRINT_STARTED', payload: { sprint_id: sprintId, project: located.project } })
    return { ...located.sprint, project: located.project, promoted_to_todo: promotedToTodo }
  }

  /**
   * List sprints for a project. Agents only see their own project's
   * sprints; managers see whatever project is requested.
   */
  async listSprints(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<{ sprints: Sprint[] }> {
    const project =
      claims.role === 'agent' ? claims.project_id : requireString(params, 'project')
    const status = optString(params, 'status') ?? 'all'
    const allowed = ['planning', 'active', 'closed', 'open', 'all']
    if (!allowed.includes(status)) {
      throw badRequest('invalid_field', { field: 'status', allowed })
    }
    const meta = await loadProjectMetaOrNull(this.paths, project)
    if (!meta) return { sprints: [] }
    let sprints = meta.sprints ?? []
    if (status === 'open') {
      sprints = sprints.filter((s) => s.status === 'planning' || s.status === 'active')
    } else if (status !== 'all') {
      sprints = sprints.filter((s) => s.status === status)
    }
    return { sprints }
  }

  async getSprint(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<{
    sprint: Sprint
    project: string
    cards: Array<Omit<Card, 'body'>>
    aggregates: SprintAggregates
  }> {
    const sprintId = requireString(params, 'sprint_id')
    const located = await this.findSprint(sprintId, claims)
    const cards = this.repo.findBySprint(sprintId).map((r) => this.repo.toCard(r))
    const aggregates: SprintAggregates = {
      cards_total: cards.length,
      cards_done: 0,
      cards_in_progress: 0,
      cards_todo: 0,
      cards_other: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
    }
    for (const c of cards) {
      aggregates.total_input_tokens += c.total_input_tokens
      aggregates.total_output_tokens += c.total_output_tokens
      if (c.status === 'done') aggregates.cards_done += 1
      else if (c.status === 'in_progress') aggregates.cards_in_progress += 1
      else if (c.status === 'todo') aggregates.cards_todo += 1
      else aggregates.cards_other += 1
    }
    return { sprint: located.sprint, project: located.project, cards, aggregates }
  }

  /**
   * Bulk membership update. Reassigning a card already in another sprint
   * silently moves it; cards in the same sprint are no-ops. Optionally
   * sets status='todo' on each so a "start sprint" workflow lands all the
   * cards in the active column in one call.
   */
  async addToSprint(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<{
    sprint_id: string
    updated: string[]
    added: string[]
    moved_to_todo: string[]
    failed: Array<{ card_id: string; reason: string }>
  }> {
    requirePmOrManager(claims)
    const sprintId = requireString(params, 'sprint_id')
    const located = await this.findSprint(sprintId, claims)
    if (located.sprint.status === 'closed') {
      throw badRequest('invalid_field', {
        field: 'sprint_id', reason: 'sprint is closed',
      })
    }
    const cardIds = requireStringArray(params, 'card_ids')
    const moveToTodo = params['move_to_todo'] === true

    const targetMeta = await loadProjectMetaOrNull(this.paths, located.project)
    if (!targetMeta) throw notFound()
    const todoCol = targetMeta.columns.includes('todo') ? 'todo' : targetMeta.columns[0]

    const updated: string[] = []
    const added: string[] = []
    const movedToTodo: string[] = []
    const failed: Array<{ card_id: string; reason: string }> = []
    for (const cardId of cardIds) {
      const row = this.repo.findById(cardId)
      if (!row) { failed.push({ card_id: cardId, reason: 'not_found' }); continue }
      if (row.project !== located.project) {
        failed.push({ card_id: cardId, reason: 'cross_project' })
        continue
      }
      const alreadyInSprint = row.sprint_id === sprintId
      if (alreadyInSprint && (!moveToTodo || row.status === todoCol)) {
        // No-op short-circuit.
        updated.push(cardId)
        continue
      }
      const current = this.repo.toCard(row)
      const next: Omit<Card, 'body'> = {
        ...current,
        sprint_id: sprintId,
        status: moveToTodo && todoCol ? todoCol : current.status,
        version: current.version + 1,
        updated_at: new Date().toISOString(),
        updated_by: claims.actor,
      }
      if (moveToTodo && todoCol && current.status !== todoCol) {
        const maxPos = this.repo.maxPosition(row.project, todoCol)
        next.position = (maxPos ?? 0) + 1000
      }
      const body = await this.readBody(row.project, row.file_basename)
      await this.writer.write(next, body, row.file_basename)
      await this.audit.log({
        ts: next.updated_at,
        op: 'UPDATE',
        project: row.project,
        card_id: cardId,
        version: next.version,
        actor: claims.actor,
        changed_fields: moveToTodo && current.status !== todoCol
          ? ['sprint_id', 'status']
          : ['sprint_id'],
      })
      this.sse.emit({
        type: 'CARD_UPDATED',
        payload: {
          card_id: cardId,
          project: row.project,
          changed_fields: ['sprint_id'],
        },
      })
      if (!alreadyInSprint) added.push(cardId)
      else if (moveToTodo && current.status !== todoCol) movedToTodo.push(cardId)
      updated.push(cardId)
    }
    this.sse.emit({
      type: 'SPRINT_UPDATED',
      payload: { sprint_id: sprintId, project: located.project },
    })
    return { sprint_id: sprintId, updated, added, moved_to_todo: movedToTodo, failed }
  }

  /**
   * Move cards from one sprint to another (in the same project). Replaces
   * the old remove_from_sprint: under the "every card belongs to a sprint"
   * rule, you can no longer strip sprint_id back to null. To pull a card
   * out of active work, archive it. To re-assign to a different sprint,
   * use this tool.
   *
   * Asserts source membership so a careless call doesn't silently move
   * cards from a sprint the caller didn't mean to touch (that's the role
   * of add_to_sprint, which silently reassigns).
   */
  async moveBetweenSprints(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<{
    sprint_id: string
    target_sprint_id: string
    updated: string[]
    failed: Array<{ card_id: string; reason: string }>
  }> {
    requirePmOrManager(claims)
    const sprintId = requireString(params, 'sprint_id')
    const targetSprintId = requireString(params, 'target_sprint_id')
    if (sprintId === targetSprintId) {
      throw badRequest('invalid_field', {
        field: 'target_sprint_id', reason: 'source and target sprint must differ',
      })
    }
    const located = await this.findSprint(sprintId, claims)
    const target = await this.findSprint(targetSprintId, claims)
    if (target.project !== located.project) {
      throw badRequest('invalid_field', {
        field: 'target_sprint_id', reason: 'must be in same project',
      })
    }
    if (target.sprint.status === 'closed') {
      throw badRequest('invalid_field', {
        field: 'target_sprint_id', reason: 'target sprint is closed',
      })
    }
    const cardIds = requireStringArray(params, 'card_ids')

    const updated: string[] = []
    const failed: Array<{ card_id: string; reason: string }> = []
    for (const cardId of cardIds) {
      const row = this.repo.findById(cardId)
      if (!row) { failed.push({ card_id: cardId, reason: 'not_found' }); continue }
      if (row.sprint_id !== sprintId) {
        failed.push({ card_id: cardId, reason: 'not_in_source_sprint' })
        continue
      }
      const current = this.repo.toCard(row)
      const next: Omit<Card, 'body'> = {
        ...current,
        sprint_id: targetSprintId,
        version: current.version + 1,
        updated_at: new Date().toISOString(),
        updated_by: claims.actor,
      }
      const body = await this.readBody(row.project, row.file_basename)
      await this.writer.write(next, body, row.file_basename)
      await this.audit.log({
        ts: next.updated_at,
        op: 'UPDATE',
        project: row.project,
        card_id: cardId,
        version: next.version,
        actor: claims.actor,
        changed_fields: ['sprint_id'],
        reason: `moved ${sprintId} → ${targetSprintId}`,
      })
      this.sse.emit({
        type: 'CARD_UPDATED',
        payload: { card_id: cardId, project: row.project, changed_fields: ['sprint_id'] },
      })
      updated.push(cardId)
    }
    this.sse.emit({
      type: 'SPRINT_UPDATED',
      payload: { sprint_id: sprintId, project: located.project },
    })
    this.sse.emit({
      type: 'SPRINT_UPDATED',
      payload: { sprint_id: targetSprintId, project: located.project },
    })
    return { sprint_id: sprintId, target_sprint_id: targetSprintId, updated, failed }
  }

  /**
   * Closes a sprint and decides what happens to its still-open cards.
   * `rollover_to: 'next-sprint-id'` reassigns them to that sprint;
   * `rollover_to: null` clears their sprint_id (back to the backlog of
   * unassigned cards); omitting `rollover_to` defaults to null.
   * Cards already done stay attached for retrospective accounting.
   */
  async closeSprint(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<{
    sprint_id: string
    closed_at: string
    rolled_over: string[]
    finished: string[]
    archived: string[]
  }> {
    requirePmOrManager(claims)
    const sprintId = requireString(params, 'sprint_id')
    const located = await this.findSprint(sprintId, claims)
    if (located.sprint.status === 'closed') {
      throw badRequest('invalid_field', { field: 'sprint_id', reason: 'already closed' })
    }
    // rollover_to may be:
    //   - a sprint_id string: unfinished cards move to that planning sprint
    //   - null (or absent): unfinished cards remain attached to the closed
    //     sprint as historical record (no movement)
    const unfinishedCount = this.repo.findBySprint(sprintId).filter((r) => r.status !== 'done').length
    const rolloverToRaw = params['rollover_to']
    let rolloverTo: string | null = null
    if (typeof rolloverToRaw === 'string') {
      const target = await this.findSprint(rolloverToRaw, claims)
      if (target.project !== located.project) {
        throw badRequest('invalid_field', {
          field: 'rollover_to', reason: 'must be in same project',
        })
      }
      if (target.sprint.status !== 'planning') {
        throw badRequest('invalid_field', {
          field: 'rollover_to', reason: 'rollover target must be in planning',
        })
      }
      rolloverTo = rolloverToRaw
    } else if (rolloverToRaw !== undefined && rolloverToRaw !== null) {
      throw badRequest('invalid_field', {
        field: 'rollover_to',
        expected: 'string (sprint_id of a planning sprint) or null to close without rollover',
      })
    }
    void unfinishedCount

    const closedAt = new Date().toISOString()
    located.sprint.status = 'closed'
    located.sprint.ended_at = closedAt
    await saveProjectMeta(this.paths, located.project, located.meta)

    const rolledOver: string[] = []
    const finished: string[] = []
    const archived: string[] = []
    const cards = this.repo.findBySprint(sprintId)
    for (const row of cards) {
      if (row.status === 'done') {
        // Archive completed cards automatically when the sprint closes.
        const current = this.repo.toCard(row)
        const archivedCard: Omit<Card, 'body'> = {
          ...current,
          archived: true,
          version: current.version + 1,
          updated_at: closedAt,
          updated_by: claims.actor,
        }
        const body = await this.readBody(row.project, row.file_basename)
        await this.writer.write(archivedCard, body, row.file_basename)
        await this.audit.log({
          ts: closedAt,
          op: 'ARCHIVE',
          project: row.project,
          card_id: row.id,
          version: archivedCard.version,
          actor: claims.actor,
          changed_fields: ['archived'],
          reason: `auto-archived on sprint close`,
        })
        this.sse.emit({
          type: 'CARD_ARCHIVED',
          payload: { card_id: row.id, project: row.project },
        })
        finished.push(row.id)
        archived.push(row.id)
        continue
      }
      if (!rolloverTo) continue   // shouldn't happen — validated above
      const current = this.repo.toCard(row)
      const next: Omit<Card, 'body'> = {
        ...current,
        sprint_id: rolloverTo,
        version: current.version + 1,
        updated_at: closedAt,
        updated_by: claims.actor,
      }
      const body = await this.readBody(row.project, row.file_basename)
      await this.writer.write(next, body, row.file_basename)
      await this.audit.log({
        ts: closedAt,
        op: 'UPDATE',
        project: row.project,
        card_id: row.id,
        version: next.version,
        actor: claims.actor,
        changed_fields: ['sprint_id'],
        reason: `rolled over to ${rolloverTo}`,
      })
      this.sse.emit({
        type: 'CARD_UPDATED',
        payload: { card_id: row.id, project: row.project, changed_fields: ['sprint_id'] },
      })
      rolledOver.push(row.id)
    }

    await this.audit.log({
      ts: closedAt,
      op: 'SPRINT_CLOSED',
      project: located.project,
      actor: claims.actor,
      reason: `sprint_id=${sprintId} rollover_to=${rolloverTo} ` +
        `rolled=${rolledOver.length} finished=${finished.length}`,
    })
    this.sse.emit({
      type: 'SPRINT_CLOSED',
      payload: { sprint_id: sprintId, project: located.project },
    })
    return { sprint_id: sprintId, closed_at: closedAt, rolled_over: rolledOver, finished, archived }
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /**
   * Find a sprint by id across all projects (manager) or only the agent's
   * project. Returns the sprint, its parent meta, and the project name so
   * the caller can save the meta after mutation.
   */
  private async findSprint(
    sprintId: string,
    claims: TokenClaims,
  ): Promise<{ sprint: Sprint; meta: ProjectMeta; project: string }> {
    if (claims.role === 'agent') {
      const meta = await loadProjectMetaOrNull(this.paths, claims.project_id)
      if (!meta) throw notFound()
      const sprint = (meta.sprints ?? []).find((s) => s.id === sprintId)
      if (!sprint) throw notFound()
      return { sprint, meta, project: claims.project_id }
    }
    // Manager — scan every project. Sprints are few, so this is cheap.
    const dirs = await fs.readdir(this.paths.kanbanData, { withFileTypes: true }).catch((err) => {
      logger.warn({ err }, 'getSprint: readdir failed')
      return [] as import('node:fs').Dirent[]
    })
    for (const e of dirs) {
      if (!e.isDirectory()) continue
      const meta = await loadProjectMetaOrNull(this.paths, e.name)
      if (!meta) continue
      const sprint = (meta.sprints ?? []).find((s) => s.id === sprintId)
      if (sprint) return { sprint, meta, project: e.name }
    }
    throw notFound()
  }

  private async readBody(project: string, basename: string): Promise<string> {
    const filePath = path.join(this.paths.kanbanData, project, `${basename}.md`)
    return fs
      .readFile(filePath, 'utf8')
      .then(parseCardFile)
      .then((p) => p.body)
      .catch((_err) => '') // missing or unreadable card body is non-fatal
  }
}

function requirePmOrManager(claims: TokenClaims): void {
  if (claims.role === 'manager') return
  if (claims.role === 'agent' && claims.agent_type === 'pm') return
  throw new HttpError(403, { error: 'forbidden', reason: 'pm_agent_or_manager_required' })
}

function requireStringArray(p: Record<string, unknown>, key: string): string[] {
  const v = p[key]
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string')) {
    throw badRequest('invalid_field', { field: key, expected: 'non-empty string[]' })
  }
  return v as string[]
}
