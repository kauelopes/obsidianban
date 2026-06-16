import type { Paths } from '../config.js'
import type { CardRepository, CardRow } from '../cards/repository.js'
import type { AuditLogger } from '../audit/logger.js'
import type { AtomicWriter } from '../writer/atomic.js'
import type { SSEEventBus } from '../server/sse.js'
import { loadProjectMetaOrNull } from '../vault/layout.js'
import type { Card, ReorderResult, Sprint, TokenClaims } from '@obsidiankan/types'
import { badRequest, HttpError } from './errors.js'
import { optInt, optString, rejectDisallowed } from './validation.js'
import { CardReader } from './card-reader.js'
import { CardWriter } from './card-writer.js'
import { CardMover } from './card-mover.js'
import { CardBlocker } from './card-blocker.js'
import { unmetBlockers, safeParseStringArray } from './card-shared.js'

// Per-card entries in bulk_create payloads cannot carry these — they're
// owned by the envelope (one cost, one optional dedupe key for the batch).
const BULK_ENVELOPE_FIELDS = ['input_tokens', 'output_tokens', 'model', 'request_id'] as const

const BULK_CREATE_LIMIT = 100

/**
 * Mutation entry point for cards. Read isolation:
 *   - agent token: only sees / writes to claims.project_id
 *   - manager token: any project
 * Cross-project access collapses to 404 (BR-03).
 */
export class CardService {
  private readonly reader: CardReader
  private readonly cardWriter: CardWriter
  private readonly cardMover: CardMover
  private readonly cardBlocker: CardBlocker

  constructor(
    private readonly paths: Paths,
    private readonly repo: CardRepository,
    private readonly writer: AtomicWriter,
    private readonly audit: AuditLogger,
    private readonly sse: SSEEventBus,
  ) {
    this.reader = new CardReader(paths, repo)
    this.cardWriter = new CardWriter(paths, repo, writer, audit, sse)
    this.cardMover = new CardMover(paths, repo, writer, audit, sse)
    this.cardBlocker = new CardBlocker(paths, repo, writer, audit, sse)
  }

  private async requireDevActiveSprint(claims: TokenClaims): Promise<Sprint> {
    return this.reader.requireDevActiveSprint(claims)
  }

  async get(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    return this.reader.get(params, claims)
  }

  async create(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    return this.cardWriter.create(params, claims)
  }

  async update(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    return this.cardWriter.update(params, claims)
  }

  async move(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    if (claims.role === 'agent' && claims.agent_type === 'dev') await this.requireDevActiveSprint(claims)
    return this.cardMover.move(params, claims)
  }

  async reorder(params: Record<string, unknown>, claims: TokenClaims): Promise<ReorderResult> {
    return this.cardMover.reorder(params, claims)
  }

  async delete(params: Record<string, unknown>, claims: TokenClaims): Promise<{ deleted: true; id: string }> {
    return this.cardWriter.delete(params, claims)
  }

  async archive(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    return this.cardWriter.archive(params, claims)
  }

  async unarchive(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    return this.cardWriter.unarchive(params, claims)
  }

  async claim(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    if (claims.role === 'agent' && claims.agent_type === 'dev') await this.requireDevActiveSprint(claims)
    return this.cardBlocker.claim(params, claims)
  }

  async release(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    if (claims.role === 'agent' && claims.agent_type === 'dev') await this.requireDevActiveSprint(claims)
    return this.cardBlocker.release(params, claims)
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

    const envelopeInputTokens = optInt(params, 'input_tokens', 0)
    const envelopeOutputTokens = optInt(params, 'output_tokens', 0)
    const envelopeModel = optString(params, 'model') ?? 'unknown'
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
        const card = await this.cardWriter.create(inner, claims)
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
    reason?: 'no_todo_cards' | 'all_blocked' | 'empty' | 'no_active_sprint'
    backlog_count?: number
  }> {
    const project =
      claims.role === 'agent' ? claims.project_id : optString(params, 'project') ?? undefined
    let sprintIdFilter = optString(params, 'sprint_id')
    if (claims.role === 'agent' && claims.agent_type === 'dev') {
      const active = await this.requireDevActiveSprint(claims)
      sprintIdFilter = active.id
    }
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

    // Two-pass: first classify every candidate so blocked_candidates is the
    // true count across the whole result set, not just the cards scanned
    // before the first hit.
    let firstPick: CardRow | null = null
    let blockedCandidates = 0
    for (const row of rows) {
      if (sprintIdFilter != null && row.sprint_id !== sprintIdFilter) continue
      const blockers = safeParseStringArray(row.blocked_by)
      const isBlocked =
        blockers.length > 0 && unmetBlockers(this.repo, blockers).length > 0
      if (isBlocked) {
        blockedCandidates += 1
      } else if (firstPick === null) {
        firstPick = row
      }
    }
    if (firstPick !== null) {
      return { card: this.repo.toCard(firstPick), blocked_candidates: blockedCandidates }
    }

    // Compute backlog count to help agent diagnose why there's nothing to pick.
    const backlogRows = this.repo.query({
      project,
      status: 'backlog',
      includeArchived: false,
      orderBy: 'priority',
      limit: 200,
      offset: 0,
    })
    const backlogCount = sprintIdFilter
      ? backlogRows.filter((r) => r.sprint_id === sprintIdFilter).length
      : backlogRows.length

    let reason: 'no_todo_cards' | 'all_blocked' | 'empty' | 'no_active_sprint'
    if (blockedCandidates > 0) {
      reason = 'all_blocked'
    } else if (backlogCount > 0) {
      // Backlog cards exist but haven't been promoted — check whether it's
      // because no sprint is active (the most actionable diagnosis).
      const meta = project
        ? await loadProjectMetaOrNull(this.paths, project)
        : null
      const sprints = meta?.sprints ?? []
      const hasActiveSprint = sprintIdFilter
        ? sprints.some((s) => s.id === sprintIdFilter && s.status === 'active')
        : sprints.some((s) => s.status === 'active')
      reason = hasActiveSprint ? 'no_todo_cards' : 'no_active_sprint'
    } else {
      reason = 'empty'
    }

    return { card: null, blocked_candidates: blockedCandidates, reason, backlog_count: backlogCount }
  }

  /**
   * Append-only log entry for Dev agents (and any agent). Accepts only
   * id, version, log_entry, and token cost fields — no other mutations.
   * Delegates to cardWriter.update() after stripping disallowed fields.
   */
  async logOnCard(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    if (claims.role === 'agent' && claims.agent_type === 'dev') await this.requireDevActiveSprint(claims)
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
    return this.cardWriter.update(params, elevatedClaims)
  }
}
