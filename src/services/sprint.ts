import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Paths } from '../config.js'
import type { Sprint, TokenClaims, Card } from '../types.js'
import type { CardRepository } from '../cards/repository.js'
import type { AuditLogger } from '../audit/logger.js'
import type { SSEEventBus } from '../server/sse.js'
import type { AtomicWriter } from '../writer/atomic.js'
import {
  loadProjectMeta,
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
    if (claims.role !== 'manager') {
      throw new HttpError(403, { error: 'forbidden', reason: 'manager_required' })
    }
    const project = requireString(params, 'project')
    const name = requireString(params, 'name', MAX_NAME)
    const goalRaw = optString(params, 'goal', MAX_GOAL)
    const goal = goalRaw ?? ''

    const meta = await loadProjectMeta(this.paths, project).catch(() => null)
    if (!meta) throw notFound()

    const sprint: Sprint = {
      id: generateSprintId(),
      name,
      goal,
      started_at: new Date().toISOString(),
      ended_at: null,
      status: 'active',
    }
    meta.sprints = [...(meta.sprints ?? []), sprint]
    await saveProjectMeta(this.paths, project, meta)
    await this.audit.log({
      ts: sprint.started_at,
      op: 'SPRINT_CREATED',
      project,
      actor: claims.actor,
      reason: `sprint_id=${sprint.id} name=${name}`,
    })
    this.sse.emit({ type: 'SPRINT_CREATED', payload: { sprint_id: sprint.id, project } })
    return sprint
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
    if (status !== 'active' && status !== 'closed' && status !== 'all') {
      throw badRequest('invalid_field', { field: 'status', allowed: ['active', 'closed', 'all'] })
    }
    const meta = await loadProjectMeta(this.paths, project).catch(() => null)
    if (!meta) return { sprints: [] }
    let sprints = meta.sprints ?? []
    if (status !== 'all') sprints = sprints.filter((s) => s.status === status)
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
      else if (c.status === 'in-progress') aggregates.cards_in_progress += 1
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
    failed: Array<{ card_id: string; reason: string }>
  }> {
    if (claims.role !== 'manager') {
      throw new HttpError(403, { error: 'forbidden', reason: 'manager_required' })
    }
    const sprintId = requireString(params, 'sprint_id')
    const located = await this.findSprint(sprintId, claims)
    if (located.sprint.status === 'closed') {
      throw badRequest('invalid_field', {
        field: 'sprint_id', reason: 'sprint is closed',
      })
    }
    const cardIds = requireStringArray(params, 'card_ids')
    const moveToTodo = params['move_to_todo'] === true

    const targetMeta = await loadProjectMeta(this.paths, located.project).catch(() => null)
    if (!targetMeta) throw notFound()
    const todoCol = targetMeta.columns.includes('todo') ? 'todo' : targetMeta.columns[0]

    const updated: string[] = []
    const failed: Array<{ card_id: string; reason: string }> = []
    for (const cardId of cardIds) {
      const row = this.repo.findById(cardId)
      if (!row) { failed.push({ card_id: cardId, reason: 'not_found' }); continue }
      if (row.project !== located.project) {
        failed.push({ card_id: cardId, reason: 'cross_project' })
        continue
      }
      if (row.sprint_id === sprintId && (!moveToTodo || row.status === todoCol)) {
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
      updated.push(cardId)
    }
    this.sse.emit({
      type: 'SPRINT_UPDATED',
      payload: { sprint_id: sprintId, project: located.project },
    })
    return { sprint_id: sprintId, updated, failed }
  }

  async removeFromSprint(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<{
    sprint_id: string
    updated: string[]
    failed: Array<{ card_id: string; reason: string }>
  }> {
    if (claims.role !== 'manager') {
      throw new HttpError(403, { error: 'forbidden', reason: 'manager_required' })
    }
    const sprintId = requireString(params, 'sprint_id')
    const located = await this.findSprint(sprintId, claims)
    const cardIds = requireStringArray(params, 'card_ids')

    const updated: string[] = []
    const failed: Array<{ card_id: string; reason: string }> = []
    for (const cardId of cardIds) {
      const row = this.repo.findById(cardId)
      if (!row) { failed.push({ card_id: cardId, reason: 'not_found' }); continue }
      if (row.sprint_id !== sprintId) {
        failed.push({ card_id: cardId, reason: 'not_in_sprint' })
        continue
      }
      const current = this.repo.toCard(row)
      const next: Omit<Card, 'body'> = {
        ...current,
        sprint_id: null,
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
    return { sprint_id: sprintId, updated, failed }
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
  }> {
    if (claims.role !== 'manager') {
      throw new HttpError(403, { error: 'forbidden', reason: 'manager_required' })
    }
    const sprintId = requireString(params, 'sprint_id')
    const located = await this.findSprint(sprintId, claims)
    if (located.sprint.status === 'closed') {
      throw badRequest('invalid_field', { field: 'sprint_id', reason: 'already closed' })
    }
    let rolloverTo: string | null = null
    if ('rollover_to' in params) {
      const v = params['rollover_to']
      if (v !== null && typeof v !== 'string') {
        throw badRequest('invalid_field', { field: 'rollover_to', expected: 'string or null' })
      }
      if (typeof v === 'string') {
        // Validate target sprint exists in same project + is active.
        const target = await this.findSprint(v, claims)
        if (target.project !== located.project) {
          throw badRequest('invalid_field', {
            field: 'rollover_to', reason: 'must be in same project',
          })
        }
        if (target.sprint.status !== 'active') {
          throw badRequest('invalid_field', {
            field: 'rollover_to', reason: 'rollover target must be active',
          })
        }
        rolloverTo = v
      }
    }

    const closedAt = new Date().toISOString()
    located.sprint.status = 'closed'
    located.sprint.ended_at = closedAt
    await saveProjectMeta(this.paths, located.project, located.meta)

    const rolledOver: string[] = []
    const finished: string[] = []
    const cards = this.repo.findBySprint(sprintId)
    for (const row of cards) {
      if (row.status === 'done') {
        finished.push(row.id)
        continue
      }
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
        reason: rolloverTo ? `rolled over to ${rolloverTo}` : 'sprint closed',
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
      reason: `sprint_id=${sprintId} rollover_to=${rolloverTo ?? 'null'} ` +
        `rolled=${rolledOver.length} finished=${finished.length}`,
    })
    this.sse.emit({
      type: 'SPRINT_CLOSED',
      payload: { sprint_id: sprintId, project: located.project },
    })
    return { sprint_id: sprintId, closed_at: closedAt, rolled_over: rolledOver, finished }
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
      const meta = await loadProjectMeta(this.paths, claims.project_id).catch(() => null)
      if (!meta) throw notFound()
      const sprint = (meta.sprints ?? []).find((s) => s.id === sprintId)
      if (!sprint) throw notFound()
      return { sprint, meta, project: claims.project_id }
    }
    // Manager — scan every project. Sprints are few, so this is cheap.
    const dirs = await fs.readdir(this.paths.kanbanData, { withFileTypes: true }).catch(() => [])
    for (const e of dirs) {
      if (!e.isDirectory()) continue
      const meta = await loadProjectMeta(this.paths, e.name).catch(() => null)
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
      .catch(() => '')
  }
}

function requireStringArray(p: Record<string, unknown>, key: string): string[] {
  const v = p[key]
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string')) {
    throw badRequest('invalid_field', { field: key, expected: 'non-empty string[]' })
  }
  return v as string[]
}
