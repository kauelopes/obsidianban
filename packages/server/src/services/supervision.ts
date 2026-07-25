import path from 'node:path'
import { parseSections, lastExplicitLogKind, parseLogEntries, type LogKind } from '@obsidiankan/types'
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
 * O estado de escalação é derivado do arquivo, não indexado: o kind vive no
 * cabeçalho da entrada do `# Agent Log`, e o body não é espelhado no SQLite.
 * Reler os arquivos em vez de manter uma coluna derivada significa que não há
 * índice para dessincronizar — e como o `.md` é a fonte de verdade, uma
 * escalação escrita à mão no Obsidian também aparece aqui.
 *
 * O custo é uma leitura por card não arquivado. Com dezenas ou centenas de
 * cards isso é irrelevante em loopback; num vault com milhares valeria uma
 * coluna derivada preenchida na reconciliação. Limite conhecido e anotado, não
 * escondido.
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

    for (const row of rows) {
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

      const agentLog = parseSections(body).agentLog
      const kind: LogKind | null = lastExplicitLogKind(agentLog)
      if (kind !== 'escalate') continue

      // A entrada que escalou é a última com kind explícito.
      const entries = parseLogEntries(agentLog)
      const last = [...entries].reverse().find((e) => e.explicit && e.kind === 'escalate')

      escalations.push({
        card_id: row.id,
        project: row.project,
        title: row.title,
        status: row.status,
        version: row.version,
        priority: row.priority,
        assigned_to: row.assigned_to,
        updated_at: row.updated_at,
        escalated_at: last?.ts ?? null,
        reason: last?.text ?? '',
      })
    }

    // Mais recente primeiro: a decisão mais fresca é a que interessa.
    escalations.sort((a, b) => (b.escalated_at ?? '').localeCompare(a.escalated_at ?? ''))
    return { escalations, scanned: rows.length }
  }
}
