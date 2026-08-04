import type {
  DigestCardDone,
  DigestGoalDone,
  DigestGoalUpcoming,
  DigestSprintClosed,
  DigestStalledReview,
  WeeklyDigest,
} from '@obsidiankan/types'
import type { Paths } from '../config.js'
import type { CardRepository } from '../cards/repository.js'
import { listProjectsSafe, loadProjectMetaOrNull } from '../vault/layout.js'
import { DIGEST_AUDIT_MAX_LINES, STALE_REVIEW_DAYS } from '../util/constants.js'
import { scanAuditLog } from './audit-scan.js'
import type { ActivityService } from './activity.js'
import type { MetricsService } from './metrics.js'
import type { SupervisionService } from './supervision.js'

const DAY_MS = 86_400_000

/**
 * Retrospectiva de uma semana civil.
 *
 * Endpoint agregado em vez de composição no cliente porque duas das seções
 * (cards e metas concluídos) só existem no audit log, que não tem superfície
 * de leitura por janela — e montar o resto no front seriam 4-5 chamadas
 * coordenadas para uma tela só.
 *
 * "Concluído na semana" vem do audit, não de `cards.updated_at`: aquela coluna
 * muda em qualquer mutação, então um card feito há meses reapareceria na
 * semana ao ganhar uma tag. O audit registra a transição em si.
 *
 * Limites conhecidos e aceitos: card criado já em `done` não gera MOVE e fica
 * de fora; meta fechada editando o _meta.json à mão no Obsidian não gera
 * GOAL_SET e também fica de fora.
 */
export class DigestService {
  constructor(
    private readonly paths: Paths,
    private readonly repo: CardRepository,
    private readonly metrics: MetricsService,
    private readonly activity: ActivityService,
    private readonly supervision: SupervisionService,
  ) {}

  async collect(opts: { weekStart: string; tzOffsetMinutes?: number }): Promise<WeeklyDigest> {
    const weekStart = mondayOf(opts.weekStart)
    const weekEnd = addDays(weekStart, 6)
    // Limites como instantes UTC: o audit grava ISO completo, e a comparação
    // de string só funciona contra um prefixo bem formado.
    const startMs = Date.parse(`${weekStart}T00:00:00.000Z`)
    const endMs = startMs + 7 * DAY_MS
    const inWindow = (ts: string): boolean => {
      const ms = Date.parse(ts)
      return !Number.isNaN(ms) && ms >= startMs && ms < endMs
    }

    const sprints_closed: DigestSprintClosed[] = []
    const goals_upcoming: DigestGoalUpcoming[] = []
    // Título de meta só existe no _meta.json — o audit guarda id e status.
    const goalTitles = new Map<string, { project: string; title: string }>()

    const nextWeekStart = addDays(weekStart, 7)
    const nextWeekEnd = addDays(weekStart, 13)

    for (const project of await listProjectsSafe(this.paths)) {
      const meta = await loadProjectMetaOrNull(this.paths, project)
      if (meta === null) continue

      for (const s of meta.sprints ?? []) {
        if (s.status === 'closed' && s.ended_at && inWindow(s.ended_at)) {
          sprints_closed.push({
            project,
            sprint_id: s.id,
            name: s.name,
            goal: s.goal,
            ended_at: s.ended_at,
          })
        }
      }

      for (const g of meta.goals ?? []) {
        goalTitles.set(`${project}/${g.id}`, { project, title: g.title })
        if (
          g.status === 'open' &&
          g.target_date !== null &&
          g.target_date >= nextWeekStart &&
          g.target_date <= nextWeekEnd
        ) {
          goals_upcoming.push({
            project,
            goal_id: g.id,
            title: g.title,
            target_date: g.target_date,
          })
        }
      }
    }

    const { cardsDone, goalsDone, truncated } = await this.scanAudit(inWindow, goalTitles)

    sprints_closed.sort((a, b) => a.ended_at.localeCompare(b.ended_at))
    goals_upcoming.sort((a, b) => a.target_date.localeCompare(b.target_date))
    cardsDone.sort((a, b) => a.ts.localeCompare(b.ts))
    goalsDone.sort((a, b) => a.ts.localeCompare(b.ts))

    const metrics = this.metrics.collect({ from_date: weekStart, to_date: weekEnd })

    // A estimativa de horas é uma janela deslizante de 7 dias — só bate com a
    // semana civil quando ela é a corrente.
    const isCurrentWeek = mondayOf(new Date().toISOString().slice(0, 10)) === weekStart
    let hours_estimate = 0
    if (isCurrentWeek) {
      const act = await this.activity.collect({
        days: 7,
        tzOffsetMinutes: opts.tzOffsetMinutes ?? 0,
      })
      hours_estimate = act.projects.reduce((sum, p) => sum + p.estimated_hours_week, 0)
    }

    return {
      week_start: weekStart,
      week_end: weekEnd,
      sprints_closed,
      cards_done: cardsDone,
      goals_done: goalsDone,
      goals_upcoming,
      stalled_reviews: await this.stalledReviews(),
      activity: {
        summary: metrics.summary,
        by_day: metrics.by_day,
        by_project: metrics.by_project,
      },
      hours_estimate: Math.round(hours_estimate * 10) / 10,
      hours_estimate_available: isCurrentWeek,
      audit_truncated: truncated,
    }
  }

  /**
   * Uma passada só pelo log para as duas seções que dependem dele. Streaming
   * linha a linha como o HistoryService: o arquivo só cresce, e ele é lido
   * inteiro porque não há índice por timestamp (o teto de linhas é o que
   * garante que a request termina).
   */
  private async scanAudit(
    inWindow: (ts: string) => boolean,
    goalTitles: ReadonlyMap<string, { project: string; title: string }>,
  ): Promise<{ cardsDone: DigestCardDone[]; goalsDone: DigestGoalDone[]; truncated: boolean }> {
    const cardsDone: DigestCardDone[] = []
    // Uma meta reaberta e fechada de novo na mesma semana conta uma vez, pela
    // última transição — daí o Map em vez de push.
    const goalsDone = new Map<string, DigestGoalDone>()

    const { truncated } = await scanAuditLog(
      this.paths.auditLog,
      (entry) => {
        if (!entry.ts || !inWindow(entry.ts)) return

        if (entry.op === 'MOVE' && entry.to_status === 'done' && entry.card_id) {
          const row = this.repo.findById(entry.card_id)
          cardsDone.push({
            project: entry.project ?? row?.project ?? '',
            card_id: entry.card_id,
            // Card apagado depois ainda é uma entrega da semana; sem título,
            // o id é melhor do que sumir com a linha.
            title: row?.title ?? entry.card_id,
            ts: entry.ts,
          })
          return
        }

        if (entry.op === 'GOAL_SET' && entry.project && entry.reason) {
          const [goalId, status] = entry.reason.split(' ')
          if (!goalId || status !== 'done') return
          const key = `${entry.project}/${goalId}`
          goalsDone.set(key, {
            project: entry.project,
            goal_id: goalId,
            title: goalTitles.get(key)?.title ?? goalId,
            ts: entry.ts,
          })
        }
      },
      DIGEST_AUDIT_MAX_LINES,
    )

    return { cardsDone, goalsDone: [...goalsDone.values()], truncated }
  }

  /** Escalações que já passaram do limite de espera — estado de agora. */
  private async stalledReviews(): Promise<DigestStalledReview[]> {
    const items = await this.supervision.listStalledReviews()
    const now = Date.now()
    return items
      .map((item) => {
        const since = Date.parse(item.escalated_at ?? item.updated_at)
        return {
          project: item.project,
          card_id: item.card_id,
          title: item.title,
          escalated_at: item.escalated_at,
          days_stalled: Number.isNaN(since) ? 0 : Math.floor((now - since) / DAY_MS),
        }
      })
      .filter((i) => i.days_stalled >= STALE_REVIEW_DAYS)
      .sort((a, b) => b.days_stalled - a.days_stalled)
  }
}

/** Segunda-feira da semana que contém `iso` (semana pt-BR: seg–dom). */
export function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`)
  const back = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - back)
  return d.toISOString().slice(0, 10)
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10)
}
