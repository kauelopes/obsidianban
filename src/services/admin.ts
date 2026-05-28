import type { Paths } from '../config.js'
import type { TokenClaims } from '../types.js'
import { createAgentToken, type IssuedToken } from '../auth/tokens.js'
import { badRequest, HttpError } from './errors.js'

// Project names map directly to directory names under kanban-data/, so they
// must be filesystem-safe and free of traversal.
const SAFE_PROJECT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

// Actor names are shown in audit logs and prefixed by role convention
// (agent:foo, human:bar), so `:` is allowed but slashes and dots-only are not.
const SAFE_ACTOR = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/

export interface CreateProjectResult {
  project: string
  token_id: string
  token: string
  actor: string
  created_at: string
}

export class AdminService {
  constructor(private readonly paths: Paths) {}

  async createProject(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<CreateProjectResult> {
    if (claims.role !== 'manager') {
      throw new HttpError(403, { error: 'forbidden', reason: 'manager_required' })
    }
    const project = requireMatch(params, 'project', SAFE_PROJECT, '[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}')
    const actor = requireMatch(params, 'actor', SAFE_ACTOR, '[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}')
    const issued: IssuedToken = await createAgentToken(this.paths, project, actor)
    return {
      project,
      token_id: issued.token_id,
      token: issued.raw,
      actor: issued.actor,
      created_at: issued.created_at,
    }
  }
}

function requireMatch(
  p: Record<string, unknown>,
  field: string,
  pattern: RegExp,
  patternStr: string,
): string {
  const v = p[field]
  if (typeof v !== 'string' || v.length === 0) {
    throw badRequest('invalid_field', { field, expected: 'string' })
  }
  if (!pattern.test(v)) {
    throw badRequest('invalid_field', { field, reason: `must match ${patternStr}` })
  }
  return v
}
