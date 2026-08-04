import path from 'node:path'
import { parseSections, parseLogEntries } from '@obsidiankan/types'
import type { Paths } from '../config.js'
import type { CardRepository, CardRow } from '../cards/repository.js'
import { readCardFile } from '../vault/card-file.js'
import { logger } from '../util/logger.js'
import { requirePmOrManager } from './guards.js'
import type { TokenClaims } from '@obsidiankan/types'
import { STALE_IN_PROGRESS_MS } from '../util/constants.js'

/**
 * Interface mínima do JobManager real (chega no Task 5). Nesta fase o
 * serviço sempre recebe `null` — o critério de stuck lida com essa ausência
 * dando o benefício da dúvida ao prefixo `job:` (ver `isJobAssigned`).
 */
export interface JobManagerLike {
  isJobRunning(assignedTo: string): boolean
}

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
  /**
   * Cards presos em `in_progress` (dev agent morto/travado), mesmo shape do
   * item de `escalations` mas com critério de inclusão diferente — ver
   * `listEscalations`. Um card nunca aparece nos dois arrays.
   */
  stuck_in_progress: EscalationItem[]
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
 *
 * `stuck_in_progress` é um segundo critério de escalação, ortogonal ao de
 * `review`: um card em `in_progress` cujo `updated_at` está mais velho que
 * `STALE_IN_PROGRESS_MS` provavelmente teve o dev agent morrer ou travar sem
 * mover o card — nenhum humano/PM fica sabendo disso hoje porque
 * `kanban_pick_next` também ignora `in_progress`, então o card só existiria
 * na consciência de quem soubesse procurar. `jobManager` é quem sabe
 * distinguir "morto" de "um job de longa duração ainda rodando" (Task 5); até
 * lá ele é sempre `null` e o serviço confia no contrato do prefixo `job:` em
 * `assigned_to` (ver `isJobAssigned`) para não marcar como stuck algo que o
 * orquestrador já trata como job em andamento.
 */
export class SupervisionService {
  constructor(
    private readonly paths: Paths,
    private readonly repo: CardRepository,
    private readonly jobManager: JobManagerLike | null = null,
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

    const reviewRows = rows.filter((row) => row.status === 'review')
    const escalations = await this.buildItems(reviewRows)

    const now = Date.now()
    const stuckRows = rows.filter(
      (row) =>
        row.status === 'in_progress' &&
        !this.isJobAssigned(row.assigned_to) &&
        now - Date.parse(row.updated_at) > STALE_IN_PROGRESS_MS,
    )
    const stuck_in_progress = await this.buildItems(stuckRows)

    // Mais recente primeiro: a decisão mais fresca é a que interessa.
    escalations.sort((a, b) => (b.escalated_at ?? '').localeCompare(a.escalated_at ?? ''))
    stuck_in_progress.sort((a, b) => (b.escalated_at ?? '').localeCompare(a.escalated_at ?? ''))
    return { escalations, stuck_in_progress, scanned: rows.length }
  }

  /**
   * Todos os cards em `review`, sem guard de papel — para o digest semanal,
   * que roda numa rota sem token (a barreira é de rede, como /metrics). Não
   * aplica o corte de idade: quem chama decide o limiar, aqui só se lê o
   * estado. Mesma construção de item de `listEscalations`.
   */
  async listStalledReviews(project?: string): Promise<EscalationItem[]> {
    const rows = this.repo.query({
      ...(project ? { project } : {}),
      orderBy: 'updated_at',
      limit: 1000,
      offset: 0,
    })
    return this.buildItems(rows.filter((row) => row.status === 'review'))
  }

  /**
   * `assigned_to` com prefixo `job:` é o contrato do orquestrador para "job em
   * andamento" (ver sprint-workflow.ts). Sem `jobManager` (sempre o caso até o
   * Task 5), dar o benefício da dúvida ao prefixo em vez de marcar como
   * stuck — falso negativo aqui é preferível a interromper visualmente um job
   * de longa duração que só ainda não terminou.
   */
  private isJobAssigned(assignedTo: string | null): boolean {
    if (assignedTo === null) return false
    if (this.jobManager) return this.jobManager.isJobRunning(assignedTo)
    return assignedTo.startsWith('job:')
  }

  private async buildItems(rows: readonly CardRow[]): Promise<EscalationItem[]> {
    const items: EscalationItem[] = []

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

      // A inclusão na lista já foi decidida pelo status — aqui só extraímos
      // o melhor texto/timestamp disponíveis para exibir, sem exigir kind.
      const entries = parseLogEntries(parseSections(body).agentLog)
      const last = entries.length > 0 ? entries[entries.length - 1] : null

      items.push({
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

    return items
  }
}
