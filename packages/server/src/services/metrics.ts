import type Database from 'better-sqlite3'
import type { Metrics, MetricsFilter } from '@obsidiankan/types'
import { badRequest } from './errors.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

interface SummaryRow {
  total_input_tokens: number
  total_output_tokens: number
  total_ops: number
}

interface ByTypeRow {
  type: string
  input_tokens: number
  output_tokens: number
  ops: number
}

interface ByDayRow {
  date: string
  input_tokens: number
  output_tokens: number
}

interface ByModelRow {
  model: string
  input_tokens: number
  output_tokens: number
}

interface ByAgentRow {
  actor: string
  input_tokens: number
  output_tokens: number
}

interface ByOpRow {
  op: string
  input_tokens: number
  output_tokens: number
  count: number
}

interface ByProjectRow {
  project: string
  input_tokens: number
  output_tokens: number
  ops: number
}

/**
 * Read-only aggregation over the `token_log` table. The token_log is the
 * authoritative source for token accounting (one row per mutating MCP op);
 * `cards.total_input_tokens` is a cached sum on the target card only.
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
    const whereClause = where.length > 0 ? ' WHERE ' + where.join(' AND ') : ''

    const summary = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
                COUNT(*) AS total_ops
         FROM token_log${whereClause}`,
      )
      .get(params) as SummaryRow

    const byType = this.db
      .prepare(
        `SELECT card_type AS type,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
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
                SUM(output_tokens) AS output_tokens
         FROM token_log${whereClause}
         GROUP BY date
         ORDER BY date ASC`,
      )
      .all(params) as ByDayRow[]

    const byModel = this.db
      .prepare(
        `SELECT model,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens
         FROM token_log${whereClause}
         GROUP BY model
         ORDER BY model ASC`,
      )
      .all(params) as ByModelRow[]

    const byAgent = this.db
      .prepare(
        `SELECT actor,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens
         FROM token_log${whereClause}
         GROUP BY actor
         ORDER BY actor ASC`,
      )
      .all(params) as ByAgentRow[]

    const byOperation = this.db
      .prepare(
        `SELECT op,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
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
                COUNT(*) AS ops
         FROM token_log${whereClause}
         GROUP BY project
         ORDER BY project ASC`,
      )
      .all(params) as ByProjectRow[]

    return {
      summary,
      by_type: byType,
      by_day: byDay,
      by_model: byModel,
      by_agent: byAgent,
      by_operation: byOperation,
      by_project: byProject,
    }
  }
}
