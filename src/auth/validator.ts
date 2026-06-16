import type { Paths } from '../config.js'
import { listProjectsSafe } from '../vault/layout.js'
import { sha256Hex, lookupBySha } from './tokens.js'
import type { TokenClaims } from '../types.js'

/**
 * Result of validating a Bearer token. `claims` is set on success.
 * Failures distinguish three causes so the HTTP layer can return the
 * appropriate status (401 vs 404 mapping is done by the caller, since
 * 404 requires knowing which resource was requested).
 */
export type ValidationResult =
  | { ok: true; claims: TokenClaims }
  | { ok: false; reason: 'missing' | 'invalid' | 'revoked' }

export class TokenValidator {
  constructor(private readonly paths: Paths) {}

  async validate(bearer: string | undefined): Promise<ValidationResult> {
    if (!bearer) return { ok: false, reason: 'missing' }
    const sha = sha256Hex(bearer)
    const projects = await listProjectsSafe(this.paths)
    const hit = await lookupBySha(this.paths, sha, projects)
    if (!hit) return { ok: false, reason: 'invalid' }
    if (hit.record.revoked_at) return { ok: false, reason: 'revoked' }
    if (hit.project_id) {
      return {
        ok: true,
        claims: {
          role: 'agent',
          project_id: hit.project_id,
          actor: hit.record.actor,
          agent_type: hit.record.agent_type ?? 'pm',
        },
      }
    }
    return { ok: true, claims: { role: 'manager', actor: hit.record.actor } }
  }
}

export function extractBearer(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined
  const m = /^Bearer\s+(.+)$/i.exec(authHeader)
  return m?.[1]
}
