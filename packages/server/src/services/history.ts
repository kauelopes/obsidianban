import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { AuditEntry, TokenClaims } from '@obsidiankan/types'
import type { Paths } from '../config.js'
import { logger } from '../util/logger.js'
import { badRequest } from './errors.js'
import { requirePmOrManager } from './guards.js'

const DEFAULT_LIMIT = 100

/**
 * Lê o audit log append-only e devolve o histórico de um card.
 *
 * `.kanban/audit.ndjson` registra toda mutação desde o primeiro dia — ator,
 * versão, campos alterados, tokens — e até aqui NADA em src/ lia esse arquivo
 * de volta. Os dados de auditoria já estavam no disco sem nenhuma superfície
 * que os mostrasse.
 *
 * O registro NÃO é um formato plano, e a variação não é só por `op`: dois
 * registros do mesmo `op` carregam campos diferentes conforme o call site.
 * Conferido no audit.ndjson real — há `UPDATE` com `changed_fields` e `reason`
 * mas sem tokens (promoção de sprint) e `UPDATE` com tokens e `model` (escrita
 * via MCP). As operações de sprint não têm `card_id` nenhum.
 *
 * Por isso todo campo além de `ts` e `op` é opcional em `AuditEntry`, e quem
 * consome tem de checar presença em vez de assumir a forma pelo `op`.
 */
export class HistoryService {
  constructor(private readonly paths: Paths) {}

  async getCardHistory(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<{
    card_id: string
    entries: AuditEntry[]
    truncated: boolean
  }> {
    // O catálogo marca a tool como 'pm', mas isso só filtra o tools/list do MCP:
    // a rota REST entrega qualquer nome de tool a quem o souber. A recusa tem de
    // morar aqui.
    requirePmOrManager(claims)

    const id = params['id']
    if (typeof id !== 'string' || !id.trim()) {
      throw badRequest('invalid_field', { field: 'id', expected: 'non-empty string' })
    }
    const rawLimit = params['limit']
    const limit = typeof rawLimit === 'number' ? rawLimit : DEFAULT_LIMIT

    const matches: AuditEntry[] = []
    try {
      // Streaming linha a linha: o arquivo só cresce, e carregar tudo na
      // memória para filtrar por um card seria desperdício conforme ele cresce.
      const rl = createInterface({
        input: createReadStream(this.paths.auditLog, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      })
      for await (const line of rl) {
        if (!line.trim()) continue
        if (!line.includes(id)) continue
        let entry: AuditEntry
        try {
          entry = JSON.parse(line) as AuditEntry
        } catch {
          // Uma linha corrompida não invalida o resto do histórico.
          continue
        }
        if (entry.card_id === id) matches.push(entry)
      }
    } catch (err) {
      const code = (err as { code?: string }).code
      // Vault novo ainda não tem audit log: histórico vazio é a resposta
      // correta, não um erro.
      if (code !== 'ENOENT') {
        logger.warn({ err, card_id: id }, 'history: failed to read audit log')
      }
      return { card_id: id, entries: [], truncated: false }
    }

    // Mais recente primeiro, e o corte tira as entradas mais antigas.
    matches.reverse()
    const truncated = matches.length > limit
    return { card_id: id, entries: matches.slice(0, limit), truncated }
  }
}
