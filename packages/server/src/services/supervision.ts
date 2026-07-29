import path from 'node:path'
import { parseSections, parseLogEntries } from '@obsidiankan/types'
import type { Paths } from '../config.js'
import type { CardRepository } from '../cards/repository.js'
import { readCardFile } from '../vault/card-file.js'
import { logger } from '../util/logger.js'
import { requirePmOrManager } from './guards.js'
import type { TokenClaims } from '@obsidiankan/types'

export interface EscalationItem {
  card_id: string
  project: string
  title: string
  status: string
  version: number
  priority: string
  assigned_to: string | null
  updated_at: string
  /** Timestamp da entrada que escalou. */
  escalated_at: string | null
  /** Texto da entrada que escalou — é a pergunta que espera decisão. */
  reason: string
}

export interface EscalationsResult {
  escalations: EscalationItem[]
  /** Cards varridos, para a UI poder dizer sobre o que a resposta fala. */
  scanned: number
}

/**
 * Inbox de escalações.
 *
 * O critério é `status === 'review'`, não um `log_kind: 'escalate'` marcado à
 * mão. `review` já É o protocolo de escalação (ver agent-runbook.md §3): o
 * dev agent só entra na coluna quando está bloqueado ou propondo algo, e o
 * workflow de sprint (deterministic pre-pass + triagem LLM) já tenta resolver
 * todo card de `review` a cada rodada antes de deixá-lo ali. Um card que
 * sobrevive até essa leitura já passou por dois filtros automáticos — exigir
 * também a tag era um segundo sinal que podia dessincronizar do status (ex:
 * dev loga uma nota simples ao mover para review, sem `escalate`), fazendo a
 * inbox humana ficar vazia enquanto o board mostrava um card esperando.
 *
 * `reason`/`escalated_at` continuam lendo o arquivo (fonte de verdade, sem
 * índice para dessincronizar) mas agora com fallback: usam a última entrada
 * do Agent Log seja qual for seu kind, e caem para `updated_at` quando não há
 * log nenhum — a inclusão na lista não depende mais de existir uma entrada
 * marcada.
 *
 * O custo é uma leitura por card em `review` (não mais por card não
 * arquivado). Com dezenas ou centenas de cards isso é irrelevante em
 * loopback; num vault com milhares valeria uma coluna derivada preenchida na
 * reconciliação. Limite conhecido e anotado, não escondido.
 */
export class SupervisionService {
  constructor(
    private readonly paths: Paths,
    private readonly repo: CardRepository,
  ) {}

  async listEscalations(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<EscalationsResult> {
    requirePmOrManager(claims)

    const projectFilter =
      claims.role === 'agent'
        ? claims.project_id
        : typeof params['project'] === 'string'
          ? params['project']
          : null

    // `query` já esconde arquivados por padrão. O teto alto é deliberado: uma
    // inbox que corta silenciosamente mente sobre o que falta decidir.
    const rows = this.repo.query({
      ...(projectFilter ? { project: projectFilter } : {}),
      orderBy: 'updated_at',
      limit: 1000,
      offset: 0,
    })

    const escalations: EscalationItem[] = []
    const reviewRows = rows.filter((row) => row.status === 'review')

    for (const row of reviewRows) {
      const filePath = path.join(this.paths.kanbanData, row.project, `${row.file_basename}.md`)
      let body: string
      try {
        body = (await readCardFile(filePath)).body
      } catch (err) {
        // Um card cujo arquivo sumiu não deve derrubar a inbox inteira; a
        // reconciliação é quem cuida de órfãos.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn({ err, card_id: row.id }, 'supervision: failed to read card')
        }
        continue
      }

      // A inclusão na lista já foi decidida pelo status — aqui só extraímos
      // o melhor texto/timestamp disponíveis para exibir, sem exigir kind.
      const entries = parseLogEntries(parseSections(body).agentLog)
      const last = entries.length > 0 ? entries[entries.length - 1] : null

      escalations.push({
        card_id: row.id,
        project: row.project,
        title: row.title,
        status: row.status,
        version: row.version,
        priority: row.priority,
        assigned_to: row.assigned_to,
        updated_at: row.updated_at,
        escalated_at: last?.ts ?? row.updated_at,
        reason: last?.text.trim() || 'Sem entrada de log — abra o card para decidir.',
      })
    }

    // Mais recente primeiro: a decisão mais fresca é a que interessa.
    escalations.sort((a, b) => (b.escalated_at ?? '').localeCompare(a.escalated_at ?? ''))
    return { escalations, scanned: rows.length }
  }
}
