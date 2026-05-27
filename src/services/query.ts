import type { CardRepository } from '../cards/repository.js'
import type { CardSummary, TokenClaims } from '../types.js'
import { badRequest } from './errors.js'

const VALID_ORDER = ['position', 'updated_at', 'priority', 'due_date'] as const
type OrderBy = (typeof VALID_ORDER)[number]

/**
 * Read-only queries against SQLite. Never touches `.md` files — `list_cards`
 * is contractually disk-free (PRD §6 TASK-09 DoD).
 */
export class QueryService {
  constructor(private readonly repo: CardRepository) {}

  list(params: Record<string, unknown>, claims: TokenClaims): { cards: CardSummary[] } {
    const status = optString(params, 'status')
    const assignedTo = optString(params, 'assigned_to')
    const tags = optStringArray(params, 'tags')
    const limit = clampInt(params['limit'], 50, 1, 200, 'limit')
    const offset = clampInt(params['offset'], 0, 0, Number.MAX_SAFE_INTEGER, 'offset')
    const orderBy = optEnum(params, 'order_by', VALID_ORDER, 'position')

    const project = claims.role === 'agent' ? claims.project_id : optString(params, 'project')

    const rows = this.repo.query({
      project: project ?? undefined,
      status: status ?? undefined,
      assignedTo: assignedTo ?? undefined,
      tags: tags ?? undefined,
      orderBy: orderBy as OrderBy,
      limit,
      offset,
    })
    return { cards: rows.map((r) => this.repo.toCard(r)) }
  }
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
