export type Author = 'human' | 'agent' | 'unknown'

/**
 * Deriva a autoria da última escrita a partir de `updated_by`.
 *
 * O contrato em packages/shared documenta os prefixos `human:`, `agent:` e
 * `external:`, mas o vault real está cheio de atores sem prefixo nenhum —
 * `kae`, `asdf`, `dev-claude`, `pm-agent`, `plugin`. Conferido nos dois vaults
 * antes de escrever isto.
 *
 * Então 'unknown' não é um caso impossível a ser tratado com fallback
 * defensivo: é o estado da maioria dos cards existentes, e a UI desenha um
 * trilho neutro para ele em vez de fingir que sabe quem escreveu.
 */
export function authorOf(updatedBy: string | null | undefined): Author {
  if (!updatedBy) return 'unknown'
  if (updatedBy.startsWith('human:')) return 'human'
  if (updatedBy.startsWith('agent:')) return 'agent'
  return 'unknown'
}

/** Classe do trilho de autoria, usada no card do board e nas zonas. */
export function authorClass(updatedBy: string | null | undefined): string {
  const a = authorOf(updatedBy)
  return a === 'unknown' ? '' : ` by-${a}`
}
