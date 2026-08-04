import type {
  AuditEntry,
  FlowMetrics,
  FlowPercentiles,
  FlowRework,
  FlowWeek,
} from '@obsidiankan/types'
import type { Paths } from '../config.js'
import { DEFAULT_COLUMNS, listProjectsSafe, loadProjectMetaOrNull } from '../vault/layout.js'
import { DIGEST_AUDIT_MAX_LINES } from '../util/constants.js'
import { scanAuditLog } from './audit-scan.js'
import type { MetricsService } from './metrics.js'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/**
 * Métricas de fluxo — o que o projeto ENTREGA, complemento do /metrics, que
 * mede o que ele custa.
 *
 * A fonte é o audit log: cada `MOVE` carrega `from_status`, `to_status` e `ts`,
 * então cycle time, espera por decisão e retrabalho são todos deriváveis
 * retroativamente — a série nasce com todo o histórico do vault, sem precisar
 * instrumentar nada novo.
 *
 * O custo semanal NÃO vem daqui: vem do MetricsService (token_log), que é a
 * fonte autoritativa de uso. Somar `cost_usd` do audit daria quase o mesmo
 * número, mas dois números "quase iguais" na mesma tela é um bug esperando
 * para ser reportado.
 */
export class FlowService {
  constructor(
    private readonly paths: Paths,
    private readonly metrics: MetricsService,
  ) {}

  async collect(filter: { from_date?: string; to_date?: string } = {}): Promise<FlowMetrics> {
    const rank = await this.columnRanks()

    const from = filter.from_date ? Date.parse(`${filter.from_date}T00:00:00.000Z`) : null
    // to_date é inclusivo, como no /metrics — soma o dia inteiro.
    const to = filter.to_date ? Date.parse(`${filter.to_date}T00:00:00.000Z`) + DAY_MS : null
    const inWindow = (ms: number): boolean =>
      (from === null || ms >= from) && (to === null || ms < to)

    // Um card por vez, em ordem cronológica: o log é append-only e já vem
    // ordenado, mas agrupar por card é o que permite ler transições em pares.
    const byCard = new Map<string, AuditEntry[]>()
    const deliveredByWeek = new Map<string, number>()
    const rework: FlowRework = { forward: 0, backward: 0, rate: 0, by_transition: [] }
    const transitions = new Map<string, number>()
    let windowFrom: string | null = null
    let windowTo: string | null = null

    const { truncated } = await scanAuditLog(
      this.paths.auditLog,
      (entry) => {
        if (entry.op !== 'MOVE' || !entry.card_id || !entry.ts) return
        const ms = Date.parse(entry.ts)
        if (Number.isNaN(ms) || !inWindow(ms)) return

        if (windowFrom === null || entry.ts < windowFrom) windowFrom = entry.ts
        if (windowTo === null || entry.ts > windowTo) windowTo = entry.ts

        const list = byCard.get(entry.card_id)
        if (list) list.push(entry)
        else byCard.set(entry.card_id, [entry])

        if (entry.to_status === 'done') {
          const wk = mondayOf(entry.ts.slice(0, 10))
          deliveredByWeek.set(wk, (deliveredByWeek.get(wk) ?? 0) + 1)
        }

        const order = rank(entry.project)
        const f = order.indexOf(entry.from_status ?? '')
        const t = order.indexOf(entry.to_status ?? '')
        // Status fora das colunas declaradas não tem ordem — não dá para dizer
        // se foi avanço ou volta, e chutar inventaria retrabalho.
        if (f < 0 || t < 0 || f === t) return
        if (t < f) {
          rework.backward++
          const key = `${entry.from_status}→${entry.to_status}`
          transitions.set(key, (transitions.get(key) ?? 0) + 1)
        } else {
          rework.forward++
        }
      },
      DIGEST_AUDIT_MAX_LINES,
    )

    const total = rework.forward + rework.backward
    rework.rate = total > 0 ? rework.backward / total : 0
    rework.by_transition = [...transitions.entries()]
      .map(([key, count]) => {
        const [from_status = '', to_status = ''] = key.split('→')
        return { from_status, to_status, count }
      })
      .sort((a, b) => b.count - a.count)

    const cycle: number[] = []
    const latency: number[] = []
    for (const moves of byCard.values()) {
      moves.sort((a, b) => a.ts.localeCompare(b.ts))
      let startedAt: number | null = null
      let reviewAt: number | null = null
      for (const m of moves) {
        const ms = Date.parse(m.ts)
        // Primeiro in_progress abre o relógio; done fecha e reabre para um
        // eventual segundo ciclo (card que voltou e foi refeito).
        if (m.to_status === 'in_progress' && startedAt === null) startedAt = ms
        if (m.to_status === 'done' && startedAt !== null) {
          cycle.push((ms - startedAt) / HOUR_MS)
          startedAt = null
        }
        if (m.to_status === 'review') reviewAt = ms
        else if (reviewAt !== null) {
          latency.push((ms - reviewAt) / HOUR_MS)
          reviewAt = null
        }
      }
    }

    const by_week = this.weeks(deliveredByWeek, filter)

    return {
      window_from: windowFrom,
      window_to: windowTo,
      cycle_time_hours: percentiles(cycle),
      decision_latency_hours: percentiles(latency),
      rework,
      by_week,
      cost_reporting_starts: by_week.find((w) => w.cost_usd > 0)?.week_start ?? null,
      audit_truncated: truncated,
    }
  }

  /**
   * Série semanal: entregas do audit cruzadas com o custo do token_log. As duas
   * fontes cobrem períodos diferentes de propósito — houve semanas com entrega
   * e sem medição de token, e é exatamente isso que `cost_per_card: null`
   * comunica em vez de um zero que pareceria "de graça".
   */
  private weeks(
    delivered: ReadonlyMap<string, number>,
    filter: { from_date?: string; to_date?: string },
  ): FlowWeek[] {
    const metrics = this.metrics.collect({
      ...(filter.from_date ? { from_date: filter.from_date } : {}),
      ...(filter.to_date ? { to_date: filter.to_date } : {}),
    })
    const costByWeek = new Map<string, number>()
    for (const day of metrics.by_day) {
      const wk = mondayOf(day.date)
      costByWeek.set(wk, (costByWeek.get(wk) ?? 0) + day.cost_usd)
    }

    const all = [...new Set([...delivered.keys(), ...costByWeek.keys()])].sort()
    if (all.length === 0) return []

    // Semanas sem nada no meio da série entram zeradas: um buraco de cinco
    // semanas é o dado mais importante do gráfico, e ele some se a série pular
    // direto da semana 25 para a 31.
    const out: FlowWeek[] = []
    for (let wk = all[0]!; wk <= all.at(-1)!; wk = addDays(wk, 7)) {
      const n = delivered.get(wk) ?? 0
      const cost = round2(costByWeek.get(wk) ?? 0)
      out.push({
        week_start: wk,
        delivered: n,
        cost_usd: cost,
        cost_per_card: n > 0 && cost > 0 ? round2(cost / n) : null,
      })
    }
    return out
  }

  /** Ordem de colunas por projeto — sem meta, o padrão do vault. */
  private async columnRanks(): Promise<(project: string | undefined) => string[]> {
    const byProject = new Map<string, string[]>()
    for (const name of await listProjectsSafe(this.paths)) {
      const meta = await loadProjectMetaOrNull(this.paths, name)
      if (meta) byProject.set(name, meta.columns)
    }
    return (project) =>
      (project ? byProject.get(project) : undefined) ?? [...DEFAULT_COLUMNS]
  }
}

/** p50/p90/max em horas. Sem amostra, tudo zero e `count: 0` avisa. */
export function percentiles(values: readonly number[]): FlowPercentiles {
  if (values.length === 0) return { count: 0, p50: 0, p90: 0, max: 0 }
  const xs = [...values].sort((a, b) => a - b)
  const at = (q: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(xs.length * q) - 1))]!
  return {
    count: xs.length,
    p50: round2(at(0.5)),
    p90: round2(at(0.9)),
    max: round2(xs.at(-1)!),
  }
}

function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
