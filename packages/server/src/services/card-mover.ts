import path from 'node:path'
import type { Paths } from '../config.js'
import type { CardRepository } from '../cards/repository.js'
import type { AuditLogger } from '../audit/logger.js'
import type { AtomicWriter } from '../writer/atomic.js'
import type { SSEEventBus } from '../server/sse.js'
import { loadProjectMetaOrNull } from '../vault/layout.js'
import type { Card, ReorderResult, TokenClaims } from '@obsidiankan/types'
import { badRequest, conflict, notFound } from './errors.js'
import { POSITION_GAP } from '../util/constants.js'
import {
  optInt,
  optUsageExtras,
  optString,
  rejectDisallowed,
  requireInt,
  requireString,
} from './validation.js'
import { readCardFile } from '../vault/card-file.js'
import {
  assertWritable,
  isAdvancingBeyondTodo,
  unmetBlockers,
  blockedConflict,
  sprintNotActiveError,
} from './card-shared.js'

const MOVE_ALLOWED = [
  'id', 'version', 'to_status', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_creation_tokens', 'cost_usd', 'model', 'request_id',
] as const
const REORDER_ALLOWED = [
  'id', 'version', 'after_card_id', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_creation_tokens', 'cost_usd', 'model', 'request_id',
] as const

export class CardMover {
  constructor(
    private readonly paths: Paths,
    private readonly repo: CardRepository,
    private readonly writer: AtomicWriter,
    private readonly audit: AuditLogger,
    private readonly sse: SSEEventBus,
  ) {}

  async move(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    rejectDisallowed(params, MOVE_ALLOWED)
    const id = requireString(params, 'id')
    const claimedVersion = requireInt(params, 'version', 1)
    const toStatus = requireString(params, 'to_status')
    const inputTokens = optInt(params, 'input_tokens', 0)
    const outputTokens = optInt(params, 'output_tokens', 0)
    const model = optString(params, 'model') ?? 'unknown'

    const row = this.repo.findById(id)
    if (!row) throw notFound()
    if (claims.role === 'agent' && row.project !== claims.project_id) throw notFound()

    const meta = await loadProjectMetaOrNull(this.paths, row.project)
    const resolvedStatus = meta?.columns.includes(toStatus) ? toStatus : null
    if (!meta || !resolvedStatus) {
      throw badRequest('invalid_field', { field: 'to_status', allowed: meta?.columns ?? [] })
    }

    const current = this.repo.toCard(row)
    assertWritable(current.assigned_to, claims)

    // Sprint lock: forward movement requires an active sprint.
    if (current.sprint_id != null) {
      const sprint = (meta.sprints ?? []).find((s) => s.id === current.sprint_id)
      if (sprint && sprint.status !== 'active') {
        const fromIdx = meta.columns.indexOf(current.status)
        const toIdx = meta.columns.indexOf(resolvedStatus)
        if (toIdx > fromIdx) throw sprintNotActiveError(sprint)
      }
    }

    if (isAdvancingBeyondTodo(resolvedStatus, current.status)) {
      const unmet = unmetBlockers(this.repo, current.blocked_by)
      if (unmet.length > 0) throw blockedConflict(unmet)
    }

    const filePath = path.join(this.paths.kanbanData, row.project, `${row.file_basename}.md`)
    const parsedFile = await readCardFile(filePath)
    const body = parsedFile.body

    if (claimedVersion !== current.version) {
      const conflicting = current.status === resolvedStatus ? [] : ['status']
      throw conflict({
        message: `Version mismatch: expected ${claimedVersion}, found ${current.version}`,
        hint: 'the card changed since you last read it — re-read it with kanban_get_card and retry with the current version',
        your_version: claimedVersion,
        current_version: current.version,
        conflicting_fields: conflicting,
        current_card: { ...current, body },
      })
    }

    const fromStatus = current.status
    const maxPos = this.repo.maxPosition(row.project, resolvedStatus)
    const newPosition = (maxPos ?? 0) + POSITION_GAP
    const now = new Date().toISOString()
    const merged: Omit<Card, 'body'> = {
      ...current,
      status: resolvedStatus,
      position: newPosition,
      version: current.version + 1,
      updated_at: now,
      updated_by: claims.actor,
      total_input_tokens: current.total_input_tokens + inputTokens,
      total_output_tokens: current.total_output_tokens + outputTokens,
    }

    await this.writer.write(merged, body, row.file_basename)
    const usage = optUsageExtras(params)
    this.repo.logTokens({
      ts: now, op: 'MOVE', card_id: id, card_type: current.type,
      actor: claims.actor, model, input_tokens: inputTokens, output_tokens: outputTokens,
      project: row.project, ...usage,
    })
    await this.audit.log({
      ts: now, op: 'MOVE', project: row.project, card_id: id, version: merged.version,
      actor: claims.actor, input_tokens: inputTokens, output_tokens: outputTokens, model,
      from_status: fromStatus, to_status: resolvedStatus, ...usage,
    })
    this.sse.emit({
      type: 'CARD_MOVED',
      payload: { card_id: id, project: row.project, from_status: fromStatus, to_status: resolvedStatus, new_position: newPosition },
    })

    return { ...merged, body, file_basename: row.file_basename }
  }

  async reorder(params: Record<string, unknown>, claims: TokenClaims): Promise<ReorderResult> {
    rejectDisallowed(params, REORDER_ALLOWED)
    const id = requireString(params, 'id')
    const claimedVersion = requireInt(params, 'version', 1)
    const inputTokens = optInt(params, 'input_tokens', 0)
    const outputTokens = optInt(params, 'output_tokens', 0)
    const model = optString(params, 'model') ?? 'unknown'

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
    assertWritable(current.assigned_to, claims)

    const filePath = path.join(this.paths.kanbanData, row.project, `${row.file_basename}.md`)
    const parsedFile = await readCardFile(filePath)
    const body = parsedFile.body

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

    if (afterCardId !== null) {
      const afterRow = this.repo.findById(afterCardId)
      if (!afterRow || afterRow.project !== row.project || afterRow.status !== current.status) {
        throw badRequest('invalid_field', {
          field: 'after_card_id',
          reason: 'must reference a card in the same project and column',
        })
      }
    }

    // Build the new column order: take the existing column scoped to the same
    // sprint (so reordering in sprint A never touches cards in sprint B).
    const column = this.repo.findByColumn(row.project, current.status, current.sprint_id)
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
      const newPos = (i + 1) * POSITION_GAP
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
        cardBody = (await readCardFile(fp)).body
      }
      await this.writer.write(updated, cardBody, r.file_basename)
      affectedCards.push({ id: r.id, new_version: updated.version, new_position: newPos })
    }

    const usage = optUsageExtras(params)
    this.repo.logTokens({
      ts: now, op: 'REORDER', card_id: id, card_type: current.type,
      actor: claims.actor, model, input_tokens: inputTokens, output_tokens: outputTokens,
      project: row.project, ...usage,
    })
    await this.audit.log({
      ts: now, op: 'REORDER', project: row.project, card_id: id, version: targetCard.version,
      actor: claims.actor, input_tokens: inputTokens, output_tokens: outputTokens, model,
      affected_cards: affectedCards.map((a) => a.id), ...usage,
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
}
