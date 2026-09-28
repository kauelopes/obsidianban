import type Database from 'better-sqlite3'
import type { Metrics, MetricsFilter } from '@obsidiankan/types'
import { badRequest } from './errors.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

interface SummaryRow {
  total_input_tokens: number
  total_output_tokens: number
  total_cache_read_tokens: number
  total_cache_creation_tokens: number
  total_cost_usd: number
  total_ops: number
}

interface ByTypeRow {
  type: string
  input_tokens: number
  output_tokens: number
  cost_usd: number
  ops: number
}

interface ByDayRow {
  date: string
  input_tokens: number
  output_tokens: number
  cost_usd: number
}

interface ByModelRow {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  cost_usd: number
}

interface ByAgentRow {
  actor: string
  input_tokens: number
  output_tokens: number
  cost_usd: number
}

interface ByRoleRow {
  role: string
  input_tokens: number
  output_tokens: number
  cost_usd: number
  ops: number
}

interface ByOpRow {
  op: string
  input_tokens: number
  output_tokens: number
  cost_usd: number
  count: number
}

interface ByProjectRow {
  project: string
  input_tokens: number
  output_tokens: number
  cost_usd: number
  ops: number
}

interface ByProjectDayRow {
  project: string
  date: string
  input_tokens: number
  output_tokens: number
  cost_usd: number
  ops: number
}

interface TerminalSummaryRow {
  total_input_tokens: number
  total_output_tokens: number
  total_cache_read_tokens: number
  total_cache_creation_tokens: number
  total_cost_usd: number
  total_ops: number
}

interface TerminalByModelRow {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  cost_usd: number
  ops: number
}

interface TerminalByDayRow {
  date: string
  input_tokens: number
  output_tokens: number
  cost_usd: number
  ops: number
}

/**
 * Read-only aggregation over the `token_log` table. The token_log is the
 * authoritative source for token accounting (one row per mutating MCP op);
 * `cards.total_input_tokens` is a cached sum on the target card only.
 *
 * Also aggregates `terminal_usage` (sessões de terminal fora do board,
 * ingeridas por `TerminalUsageService`) into `terminal`/`by_origin` — mesma
 * postura read-only, dado já fresco quando o caller chama `ensureFresh()`
 * antes (GET /metrics faz isso).
 */
export class MetricsService {
  constructor(private readonly db: Database.Database) {}

  collect(filter: MetricsFilter): Metrics {
    const where: string[] = []
    const params: Record<string, string> = {}
    if (filter.from_date != null) {
      if (!DATE_RE.test(filter.from_date)) {
        throw badRequest('invalid_field', { field: 'from_date', expected: 'YYYY-MM-DD' })
      }
      where.push('substr(ts, 1, 10) >= @from_date')
      params['from_date'] = filter.from_date
    }
    if (filter.to_date != null) {
      if (!DATE_RE.test(filter.to_date)) {
        throw badRequest('invalid_field', { field: 'to_date', expected: 'YYYY-MM-DD' })
      }
      where.push('substr(ts, 1, 10) <= @to_date')
      params['to_date'] = filter.to_date
    }
    if (filter.card_id != null) {
      where.push('card_id = @card_id')
      params['card_id'] = filter.card_id
    }
    if (filter.sprint_id != null) {
      where.push('sprint_id = @sprint_id')
      params['sprint_id'] = filter.sprint_id
    }
    const whereClause = where.length > 0 ? ' WHERE ' + where.join(' AND ') : ''

    const summary = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
                COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read_tokens,
                COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_creation_tokens,
                COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
                COUNT(*) AS total_ops
         FROM token_log${whereClause}`,
      )
      .get(params) as SummaryRow

    const byType = this.db
      .prepare(
        `SELECT card_type AS type,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cost_usd) AS cost_usd,
                COUNT(*) AS ops
         FROM token_log${whereClause}
         GROUP BY card_type
         ORDER BY card_type ASC`,
      )
      .all(params) as ByTypeRow[]

    const byDay = this.db
      .prepare(
        `SELECT substr(ts, 1, 10) AS date,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cost_usd) AS cost_usd
         FROM token_log${whereClause}
         GROUP BY date
         ORDER BY date ASC`,
      )
      .all(params) as ByDayRow[]

    const byModel = this.db
      .prepare(
        `SELECT model,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cost_usd) AS cost_usd,
                SUM(cache_read_tokens) AS cache_read_tokens,
                SUM(cache_creation_tokens) AS cache_creation_tokens
         FROM token_log${whereClause}
         GROUP BY model
         ORDER BY model ASC`,
      )
      .all(params) as ByModelRow[]

    const byAgent = this.db
      .prepare(
        `SELECT actor,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cost_usd) AS cost_usd
         FROM token_log${whereClause}
         GROUP BY actor
         ORDER BY actor ASC`,
      )
      .all(params) as ByAgentRow[]

    // Linhas anteriores à coluna `role` (migração) ficam sem bucket — melhor
    // aparecer como 'desconhecido' na UI do que ser descartada ou forçada num
    // bucket errado.
    const byRole = this.db
      .prepare(
        `SELECT COALESCE(role, 'desconhecido') AS role,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cost_usd) AS cost_usd,
                COUNT(*) AS ops
         FROM token_log${whereClause}
         GROUP BY role
         ORDER BY role ASC`,
      )
      .all(params) as ByRoleRow[]

    const byOperation = this.db
      .prepare(
        `SELECT op,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cost_usd) AS cost_usd,
                COUNT(*) AS count
         FROM token_log${whereClause}
         GROUP BY op
         ORDER BY op ASC`,
      )
      .all(params) as ByOpRow[]

    const byProject = this.db
      .prepare(
        `SELECT project,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cost_usd) AS cost_usd,
                COUNT(*) AS ops
         FROM token_log${whereClause}
         GROUP BY project
         ORDER BY project ASC`,
      )
      .all(params) as ByProjectRow[]

    // Datas em UTC, como by_day: aqui é contabilidade; a visão em fuso local
    // é papel do ActivityService.
    const byProjectDay = this.db
      .prepare(
        `SELECT project,
                substr(ts, 1, 10) AS date,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cost_usd) AS cost_usd,
                COUNT(*) AS ops
         FROM token_log${whereClause}
         GROUP BY project, date
         ORDER BY project ASC, date ASC`,
      )
      .all(params) as ByProjectDayRow[]

    // terminal_usage não tem card_id — o filtro de data reusa os mesmos
    // parâmetros, mas o WHERE é reconstruído sem a cláusula card_id. Com
    // card_id, o recorte é de um card: uso de terminal não pertence a nenhum,
    // e devolvê-lo cheio faria a UI somar o vault inteiro ao total do card.
    // Mesmo raciocínio para sprint_id: sessão de terminal não pertence a sprint.
    const terminalWhere: string[] = filter.card_id != null || filter.sprint_id != null ? ['0 = 1'] : []
    if (filter.from_date != null) terminalWhere.push('substr(ts, 1, 10) >= @from_date')
    if (filter.to_date != null) terminalWhere.push('substr(ts, 1, 10) <= @to_date')
    const terminalWhereClause = terminalWhere.length > 0 ? ' WHERE ' + terminalWhere.join(' AND ') : ''

    const terminal = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
                COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read_tokens,
                COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_creation_tokens,
                COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
                COUNT(*) AS total_ops
         FROM terminal_usage${terminalWhereClause}`,
      )
      .get(params) as TerminalSummaryRow

    // Ambos row-level sobre terminal_usage — model e ts já são gravados por
    // sessão ingerida (ver TerminalUsageService), então isto é surfacing puro,
    // sem reprocessar `.jsonl` nenhum.
    const terminalByModel = this.db
      .prepare(
        `SELECT model,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens,
                SUM(cache_creation_tokens) AS cache_creation_tokens,
                SUM(cost_usd) AS cost_usd,
                COUNT(*) AS ops
         FROM terminal_usage${terminalWhereClause}
         GROUP BY model
         ORDER BY model ASC`,
      )
      .all(params) as TerminalByModelRow[]

    const terminalByDay = this.db
      .prepare(
        `SELECT substr(ts, 1, 10) AS date,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cost_usd) AS cost_usd,
                COUNT(*) AS ops
         FROM terminal_usage${terminalWhereClause}
         GROUP BY date
         ORDER BY date ASC`,
      )
      .all(params) as TerminalByDayRow[]

    const byOrigin: Metrics['by_origin'] = [
      {
        origin: 'board',
        input_tokens: summary.total_input_tokens,
        output_tokens: summary.total_output_tokens,
        cost_usd: summary.total_cost_usd,
        ops: summary.total_ops,
      },
      {
        origin: 'terminal',
        input_tokens: terminal.total_input_tokens,
        output_tokens: terminal.total_output_tokens,
        cost_usd: terminal.total_cost_usd,
        ops: terminal.total_ops,
      },
    ]

    return {
      summary,
      by_type: byType,
      by_day: byDay,
      by_model: byModel,
      by_agent: byAgent,
      by_role: byRole,
      by_operation: byOperation,
      by_project: byProject,
      by_project_day: byProjectDay,
      terminal,
      terminal_by_model: terminalByModel,
      terminal_by_day: terminalByDay,
      by_origin: byOrigin,
    }
  }
}
