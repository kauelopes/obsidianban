import type { CardRepository } from '../cards/repository.js'
import type { CardSummary, TokenClaims } from '@obsidiankan/types'
import type { Paths } from '../config.js'
import { badRequest, HttpError } from './errors.js'
import { findActiveSprint } from '../vault/layout.js'

const VALID_ORDER = ['position', 'updated_at', 'priority', 'due_date'] as const
type OrderBy = (typeof VALID_ORDER)[number]

/**
 * Read-only queries against SQLite. Pulls archived-project state via the
 * injected callback so that — for managers fetching the whole board — cards
 * in archived projects disappear cleanly alongside their headers.
 */
export class QueryService {
  constructor(
    private readonly repo: CardRepository,
    private readonly paths: Paths,
    private readonly getArchivedProjects: () => Promise<Set<string>>,
  ) {}

  async list(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<{ cards: CardSummary[] }> {
    if (claims.role === 'agent' && claims.agent_type === 'dev') {
      const active = await findActiveSprint(this.paths, claims.project_id)
      if (!active) {
        throw new HttpError(409, {
          error: 'no_active_sprint',
          reason: 'no sprint is currently active in this project',
          hint: 'PM/manager: start a sprint with kanban_start_sprint. Dev agents must wait for an active sprint before any card operation.',
        })
      }
      params = { ...params, sprint_id: active.id }
    }

    const status = optString(params, 'status')
    const sprintId = optString(params, 'sprint_id')
    const assignedTo = optString(params, 'assigned_to')
    const tags = optStringArray(params, 'tags')
    const limit = clampInt(params['limit'], 50, 1, 200, 'limit')
    const offset = clampInt(params['offset'], 0, 0, Number.MAX_SAFE_INTEGER, 'offset')
    const orderBy = optEnum(params, 'order_by', VALID_ORDER, 'position')
    const includeArchived = optBool(params, 'include_archived', false)
    const archivedOnly = optBool(params, 'archived_only', false)
    const includeArchivedProjects = optBool(params, 'include_archived_projects', false)

    const project = claims.role === 'agent' ? claims.project_id : optString(params, 'project')

    const rows = this.repo.query({
      project: project ?? undefined,
      status: status ?? undefined,
      sprintId: sprintId ?? undefined,
      assignedTo: assignedTo ?? undefined,
      tags: tags ?? undefined,
      includeArchived,
      archivedOnly,
      orderBy: orderBy as OrderBy,
      limit,
      offset,
    })

    // Cascade hide: only for managers fetching the whole board without an
    // explicit project filter. Agents continue to see their own cards even
    // if the project was archived (their auth still works); a manager
    // querying a single project explicitly also gets every card back —
    // they asked for it specifically. The plugin opts back in to archived
    // projects via include_archived_projects when its showArchived toggle
    // is on.
    let cards = rows.map((r) => this.repo.toCard(r))
    if (
      claims.role === 'manager' &&
      project == null &&
      !includeArchivedProjects
    ) {
      const archived = await this.getArchivedProjects()
      if (archived.size > 0) {
        cards = cards.filter((c) => !archived.has(c.project))
      }
    }
    return { cards }
  }
}

function optBool(p: Record<string, unknown>, key: string, def: boolean): boolean {
  const v = p[key]
  if (v == null) return def
  if (typeof v !== 'boolean') throw badRequest('invalid_field', { field: key, expected: 'boolean' })
  return v
}

function optString(p: Record<string, unknown>, key: string): string | null {
  const v = p[key]
  if (v == null) return null
  if (typeof v !== 'string') throw badRequest('invalid_field', { field: key, expected: 'string' })
  return v
}

function optStringArray(p: Record<string, unknown>, key: string): string[] | null {
  const v = p[key]
  if (v == null) return null
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw badRequest('invalid_field', { field: key, expected: 'string[]' })
  }
  return v as string[]
}

function clampInt(
  v: unknown,
  def: number,
  min: number,
  max: number,
  field: string,
): number {
  if (v == null) return def
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw badRequest('invalid_field', { field, expected: 'integer' })
  }
  if (v < min || v > max) {
    throw badRequest('invalid_field', { field, min, max })
  }
  return v
}

function optEnum<T extends string>(
  p: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  def: T,
): T {
  const v = p[key]
  if (v == null) return def
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw badRequest('invalid_field', { field: key, allowed })
  }
  return v as T
}
