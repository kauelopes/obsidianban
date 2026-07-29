import type { TokenClaims } from '@obsidiankan/types'
import { forbidden } from './errors.js'

/**
 * O `access` do TOOL_CATALOG só decide o que aparece no tools/list do MCP. A
 * rota REST `/mcp/tool/:name` executa qualquer tool registrada para qualquer
 * token válido, então a recusa por papel tem de estar no serviço.
 */
export function requirePmOrManager(claims: TokenClaims): void {
  if (claims.role === 'manager') return
  if (claims.role === 'agent' && claims.agent_type === 'pm') return
  throw forbidden('pm_agent_or_manager_required')
}

/** Planejamento de projeto é privilégio humano — só a sessão do navegador. */
export function requireManager(claims: TokenClaims): void {
  if (claims.role !== 'manager') throw forbidden('manager_required')
}
