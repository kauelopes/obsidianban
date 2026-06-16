import type { TokenClaims } from '@obsidiankan/types'

/**
 * Access level for a tool:
 *   'all'     — every authenticated caller (manager, pm agent, dev agent)
 *   'pm'      — pm agents and managers (not dev agents)
 *   'manager' — managers only
 */
export type ToolAccess = 'all' | 'pm' | 'manager'

export function isToolVisible(access: ToolAccess, claims: TokenClaims): boolean {
  if (claims.role === 'manager') return true
  if (access === 'manager') return false
  if (access === 'pm') return claims.agent_type === 'pm'
  return true
}
