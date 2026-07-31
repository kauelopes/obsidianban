import type { TokenClaims } from '@obsidiankan/types'
import type { ProjectMeta } from '../vault/layout.js'

export interface SprintLifecycleContext {
  sprintId: string
  project: string
  meta: ProjectMeta
  claims: TokenClaims
}

/**
 * Ponto de extensão genérico para efeitos colaterais de início/fim de sprint
 * (ex: GitLifecycleHook). SprintService roda cada hook best-effort — uma
 * falha aqui nunca desfaz a transição de status já aplicada.
 */
export interface SprintLifecycleHook {
  onStart?(ctx: SprintLifecycleContext): Promise<void>
  onClose?(ctx: SprintLifecycleContext): Promise<void>
}
