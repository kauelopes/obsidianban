import path from 'node:path'
import type { Paths } from '../config.js'
import type { CardRepository, CardRow } from '../cards/repository.js'
import type { AuditLogger } from '../audit/logger.js'
import type { AtomicWriter } from '../writer/atomic.js'
import type { SSEEventBus } from '../server/sse.js'
import { loadProjectMetaOrNull } from '../vault/layout.js'
import type { Card, TokenClaims } from '@obsidiankan/types'
import { conflict, notFound } from './errors.js'
import { optInt, optString, rejectDisallowed, requireInt, requireString } from './validation.js'
import { readCardBody } from '../vault/card-file.js'
import { assertWritable } from './card-shared.js'

const CLAIM_ALLOWED = [
  'id', 'version', 'input_tokens', 'output_tokens', 'model', 'request_id', 'actor',
] as const
const RELEASE_ALLOWED = [
  'id', 'version', 'revert_to_status', 'input_tokens', 'output_tokens', 'model', 'request_id',
] as const

export class CardBlocker {
  constructor(
    private readonly paths: Paths,
    private readonly repo: CardRepository,
    private readonly writer: AtomicWriter,
    private readonly audit: AuditLogger,
    private readonly sse: SSEEventBus,
  ) {}

  async claim(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    rejectDisallowed(params, CLAIM_ALLOWED)
    const id = requireString(params, 'id')
    const claimedVersion = requireInt(params, 'version', 1)
    const inputTokens = optInt(params, 'input_tokens', 0)
    const outputTokens = optInt(params, 'output_tokens', 0)
    const model = optString(params, 'model') ?? 'unknown'
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

    // Idempotent re-claim by the same actor: return current state without bumping version.
    if (current.assigned_to === targetActor) {
      const filePath = path.join(this.paths.kanbanData, row.project, `${row.file_basename}.md`)
      const body = await readCardBody(filePath)
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
      targetActor,
      op: 'CLAIM',
      sseFields: ['assigned_to'],
      claims,
    })
  }

  async release(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    rejectDisallowed(params, RELEASE_ALLOWED)
    const id = requireString(params, 'id')
    const claimedVersion = requireInt(params, 'version', 1)
    const inputTokens = optInt(params, 'input_tokens', 0)
    const outputTokens = optInt(params, 'output_tokens', 0)
    const model = optString(params, 'model') ?? 'unknown'
    // null = keep status as-is; string = revert to that column; absent = default 'todo'
    const revertToStatus = 'revert_to_status' in params
      ? (params['revert_to_status'] === null ? null : requireString(params, 'revert_to_status'))
      : 'todo'

    const row = this.repo.findById(id)
    if (!row) throw notFound()
    if (claims.role === 'agent' && row.project !== claims.project_id) throw notFound()
    const current = this.repo.toCard(row)
    assertWritable(current.assigned_to, claims)

    if (current.assigned_to == null) {
      // No-op short-circuit, matching the project-archive semantics.
      const filePath = path.join(this.paths.kanbanData, row.project, `${row.file_basename}.md`)
      const body = await readCardBody(filePath)
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
      revertToStatus,
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
    revertToStatus?: string | null
    op: 'CLAIM' | 'RELEASE'
    sseFields: string[]
    claims: TokenClaims
  }): Promise<Card> {
    const { id, claimedVersion, inputTokens, outputTokens, model, row, current, targetActor, op, claims } = args
    const filePath = path.join(this.paths.kanbanData, row.project, `${row.file_basename}.md`)
    const body = await readCardBody(filePath)

    if (claimedVersion !== current.version) {
      throw conflict({
        message: `Version mismatch: expected ${claimedVersion}, found ${current.version}`,
        hint: 'the card changed since you last read it — re-read it with kanban_get_card and retry with the current version',
        your_version: claimedVersion,
        current_version: current.version,
        conflicting_fields: current.assigned_to !== targetActor ? ['assigned_to'] : [],
        current_card: { ...current, body },
      })
    }

    // Revert status: only when releasing and the card is in a forward column.
    const unstarted = new Set(['backlog', 'todo'])
    let newStatus = current.status
    let newPosition = current.position
    const sseFields = [...args.sseFields]
    if (args.revertToStatus && !unstarted.has(current.status)) {
      const meta = await loadProjectMetaOrNull(this.paths, row.project)
      if (meta?.columns.includes(args.revertToStatus)) {
        newStatus = args.revertToStatus
        newPosition = (this.repo.maxPosition(row.project, args.revertToStatus) ?? 0) + 1000
        if (!sseFields.includes('status')) sseFields.push('status', 'position')
      }
    }

    const now = new Date().toISOString()
    const next: Omit<Card, 'body'> = {
      ...current,
      assigned_to: targetActor,
      status: newStatus,
      position: newPosition,
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
}
