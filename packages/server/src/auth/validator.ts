import { timingSafeEqual } from 'node:crypto'
import type { Paths } from '../config.js'
import { listProjectsSafe } from '../vault/layout.js'
import { sha256Hex, lookupBySha } from './tokens.js'
import type { SessionToken } from './session.js'
import type { TokenClaims } from '@obsidiankan/types'

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
  private session: SessionToken | null = null

  constructor(private readonly paths: Paths) {}

  /**
   * Registra o token de sessão do navegador. Ele não está em lugar nenhum do
   * vault, então a validação tem de conhecê-lo por aqui.
   */
  useSession(session: SessionToken): void {
    this.session = session
  }

  async validate(bearer: string | undefined): Promise<ValidationResult> {
    if (!bearer) return { ok: false, reason: 'missing' }
    const sha = sha256Hex(bearer)

    // Antes do vault: a sessão é o caminho quente, é uma comparação em memória,
    // e não faz sentido varrer os projetos para descobrir que era ela.
    if (this.session && equalHex(sha, this.session.sha256)) {
      return { ok: true, claims: { role: 'manager', actor: this.session.actor } }
    }

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

/**
 * Comparação de hashes em tempo constante. Ambos são sha256 em hex, então o
 * tamanho é sempre igual e o timingSafeEqual nunca lança.
 */
function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

export function extractBearer(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined
  const m = /^Bearer\s+(.+)$/i.exec(authHeader)
  return m?.[1]
}
