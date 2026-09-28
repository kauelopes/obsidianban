import type { CardMove, ModuleDataApi, ProjectInfo } from '@obsidiankan/module-sdk'
import type { CardSummary, FlowMetrics, Sprint } from '@obsidiankan/types'
import type { ReportParams, ReportSection } from '../api-types.js'
import { fmtDate, fmtHours, fmtInt, fmtPct, fmtPeriod, fmtTokens, fmtUsd } from '../format.js'
import { addDays, daysInclusive, isoDate, mondayOf, overlaps } from '../period.js'
import {
  doneColumn,
  requirePeriod,
  requireProject,
  round2,
  sample,
  type BuildContext,
  type BuiltReport,
  type ReportTypeDef,
} from './common.js'

const DELIVERED_MAX_ROWS = 60

export const projectReport: ReportTypeDef = {
  info: {
    id: 'project',
    label: 'Relatório de projeto',
    description: 'Desenvolvimento de um projeto num período: ritmo semanal, sprints, entregas, épicos, metas, fluxo e custo.',
    needs: ['project', 'period'],
  },

  async resolve(req, ctx) {
    const project = await requireProject(ctx, req.project)
    const { from, to } = requirePeriod(req, isoDate(ctx.now))
    return { type: 'project', project: project.name, sprint_id: null, from, to, include_analysis: req.include_analysis === true }
  },

  async build(params, ctx) {
    return buildProject(params, ctx)
  },
}

export interface Delivery {
  card: CardSummary | null
  card_id: string
  at: string
}

/** Último MOVE para a coluna de entregue de cada card, dentro da janela. */
export function deliveries(moves: readonly CardMove[], done: string, cards: ReadonlyMap<string, CardSummary>): Delivery[] {
  const last = new Map<string, string>()
  for (const m of moves) {
    if (m.to_status !== done) continue
    const prev = last.get(m.card_id)
    if (!prev || m.ts > prev) last.set(m.card_id, m.ts)
  }
  return [...last.entries()]
    .map(([card_id, at]) => ({ card_id, at, card: cards.get(card_id) ?? null }))
    .sort((a, b) => a.at.localeCompare(b.at))
}

/** Sprint toca o período: do início (ou criação) ao fim (ou hoje). Planejamento puro fica de fora. */
export function sprintsInPeriod(p: ProjectInfo, period: { from: string; to: string }, today: string): Sprint[] {
  return p.sprints
    .filter((s) => s.status !== 'planning' || s.started_at)
    .filter((s) => overlaps((s.started_at ?? s.created_at).slice(0, 10), (s.ended_at ?? today).slice(0, 10), period.from, period.to))
    .sort((a, b) => (a.started_at ?? a.created_at).localeCompare(b.started_at ?? b.created_at))
}

export interface WeekRow {
  week: string
  delivered: number
  cost: number
}

/**
 * Série semanal com a MESMA definição de entrega do resto do relatório
 * (último done do card no período) — o by_week do FlowService conta cada MOVE
 * para done, e um card refeito faria a soma das semanas passar do total. O
 * custo semanal vem do FlowService (token_log). Semanas vazias no meio entram
 * zeradas: um buraco é informação.
 */
export function weekly(delivered: readonly Delivery[], flow: FlowMetrics): WeekRow[] {
  const byWeek = new Map<string, number>()
  for (const d of delivered) {
    const wk = mondayOf(d.at)
    byWeek.set(wk, (byWeek.get(wk) ?? 0) + 1)
  }
  const cost = new Map(flow.by_week.map((w) => [w.week_start, w.cost_usd]))
  const all = [...new Set([...byWeek.keys(), ...cost.keys()])].sort()
  if (all.length === 0) return []
  const out: WeekRow[] = []
  for (let wk = all[0]!; wk <= all.at(-1)!; wk = addDays(wk, 7)) {
    out.push({ week: wk, delivered: byWeek.get(wk) ?? 0, cost: cost.get(wk) ?? 0 })
  }
  return out
}

export function weekRows(weeks: readonly WeekRow[]): string[][] {
  return weeks.map((w) => [
    fmtDate(w.week),
    fmtInt(w.delivered),
    fmtUsd(w.cost),
    w.delivered > 0 && w.cost > 0 ? fmtUsd(w.cost / w.delivered) : '—',
  ])
}

export function flowWarnings(flow: FlowMetrics, period: { from: string }): string[] {
  const out: string[] = []
  if (flow.audit_truncated) out.push('O audit log passou do teto de leitura: transições mais recentes podem faltar.')
  if (flow.cost_reporting_starts && flow.cost_reporting_starts > period.from) {
    out.push(`Custo só passou a ser medido na semana de ${fmtDate(flow.cost_reporting_starts)}: antes disso, custo zero significa "não medido".`)
  }
  return out
}

async function buildProject(params: ReportParams, ctx: BuildContext): Promise<BuiltReport> {
  const data: ModuleDataApi = ctx.data
  const project = (await data.getProject(params.project!))!
  const period = { from: params.from!, to: params.to! }
  const today = isoDate(ctx.now)
  const done = doneColumn(project.columns)

  const flow = await data.flow({ project: project.name, from_date: period.from, to_date: period.to })
  const warnings = flowWarnings(flow, period)
  const { moves } = await data.moves({ project: project.name, from_date: period.from, to_date: period.to })
  const allCards = data.listCards({ project: project.name, includeArchived: true })
  const byId = new Map(allCards.map((c) => [c.id, c]))
  const delivered = deliveries(moves, done, byId)

  const metrics = data.metrics({ from_date: period.from, to_date: period.to })
  const usage = metrics.by_project.find((p) => p.project === project.name)
  const cost = round2(usage?.cost_usd ?? 0)
  const tokens = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0)
  const costPerCard = delivered.length > 0 && cost > 0 ? cost / delivered.length : null

  const sprints = sprintsInPeriod(project, period, today).map((s) => {
    const cards = data.listCards({ project: project.name, sprintId: s.id, includeArchived: true })
    return {
      sprint: s,
      total: cards.length,
      done: cards.filter((c) => c.status === done).length,
      cost: round2(data.metrics({ sprint_id: s.id }).summary.total_cost_usd),
    }
  })

  const epics = project.epics.map((e) => {
    const cards = e.sprint_ids.flatMap((sid) => data.listCards({ project: project.name, sprintId: sid, includeArchived: true }))
    return { epic: e, total: cards.length, done: cards.filter((c) => c.status === done).length }
  })

  const goals = [...project.goals].sort((a, b) => (a.target_date ?? '9999').localeCompare(b.target_date ?? '9999'))
  const overdue = goals.filter((g) => g.status === 'open' && g.target_date && g.target_date < today)

  const current = data.listCards({ project: project.name })
  const wip = project.columns.map((col) => ({ col, n: current.filter((c) => c.status === col).length }))
  const stalled = await data.stalledReviews(project.name)

  const weeks = weekly(delivered, flow)
  const days = daysInclusive(period.from, period.to)

  const sections: ReportSection[] = [
    {
      title: 'Resumo',
      blocks: [
        {
          kind: 'kpis',
          items: [
            { label: 'Entregas', value: fmtInt(delivered.length), hint: `em ${fmtInt(days)} dia(s)` },
            { label: 'Custo medido', value: fmtUsd(cost), hint: `${fmtTokens(tokens)} tokens` },
            { label: 'Custo por entrega', value: costPerCard === null ? '—' : fmtUsd(costPerCard) },
            { label: 'Tempo de ciclo (p50)', value: flow.cycle_time_hours.count ? fmtHours(flow.cycle_time_hours.p50) : '—', hint: `${flow.cycle_time_hours.count} ciclo(s)` },
          ],
        },
        {
          kind: 'paragraph',
          text: projectSentence(project.name, delivered.length, sprints.length, flow.rework.rate, stalled.length),
        },
      ],
    },
    {
      title: 'Ritmo semanal',
      lead: 'Entregas por semana (MOVE para done) e o custo medido no mesmo recorte.',
      blocks: weeks.length
        ? [
            { kind: 'chart', chart: 'bar', title: 'Entregas por semana', labels: weeks.map((w) => fmtDate(w.week).slice(0, 5)), series: [{ name: 'Entregas', values: weeks.map((w) => w.delivered) }] },
            { kind: 'chart', chart: 'bar', title: 'Custo por semana (US$)', labels: weeks.map((w) => fmtDate(w.week).slice(0, 5)), series: [{ name: 'Custo', values: weeks.map((w) => w.cost) }] },
            { kind: 'table', columns: ['Semana de', 'Entregas', 'Custo', 'Custo/entrega'], rows: weekRows(weeks), numeric: [1, 2, 3] },
          ]
        : [{ kind: 'paragraph', text: 'Nenhuma entrega nem custo registrado no período.' }],
    },
    {
      title: 'Sprints no período',
      blocks: sprints.length
        ? [
            {
              kind: 'table',
              columns: ['Sprint', 'Status', 'Início', 'Fim', 'Concluídos', 'Custo'],
              rows: sprints.map((s) => [
                s.sprint.name,
                s.sprint.status === 'active' ? 'ativa' : s.sprint.status === 'closed' ? 'encerrada' : 'planejamento',
                fmtDate(s.sprint.started_at),
                fmtDate(s.sprint.ended_at),
                `${fmtInt(s.done)} de ${fmtInt(s.total)}`,
                fmtUsd(s.cost),
              ]),
              numeric: [4, 5],
            },
          ]
        : [{ kind: 'paragraph', text: 'Nenhuma sprint rodou no período.' }],
    },
    {
      title: 'Entregas',
      lead: delivered.length > DELIVERED_MAX_ROWS ? `As ${DELIVERED_MAX_ROWS} mais recentes de ${fmtInt(delivered.length)}.` : undefined,
      blocks: delivered.length
        ? [
            {
              kind: 'table',
              columns: ['Card', 'Tipo', 'Sprint', 'Entregue em'],
              rows: delivered.slice(-DELIVERED_MAX_ROWS).map((d) => [
                d.card?.title ?? d.card_id,
                d.card?.type ?? '—',
                project.sprints.find((s) => s.id === d.card?.sprint_id)?.name ?? '—',
                fmtDate(d.at),
              ]),
            },
          ]
        : [{ kind: 'paragraph', text: 'Nenhum card chegou a done no período.' }],
    },
    {
      title: 'Épicos e metas',
      blocks: [
        ...(epics.length
          ? [
              {
                kind: 'table' as const,
                caption: 'Épicos',
                columns: ['Épico', 'Status', 'Sprints', 'Progresso'],
                rows: epics.map((e) => [
                  e.epic.name,
                  e.epic.status,
                  fmtInt(e.epic.sprint_ids.length),
                  e.total ? `${fmtInt(e.done)} de ${fmtInt(e.total)} (${fmtPct(e.done / e.total)})` : '—',
                ]),
                numeric: [2],
              },
            ]
          : []),
        ...(goals.length
          ? [
              {
                kind: 'table' as const,
                caption: 'Metas',
                columns: ['Meta', 'Status', 'Prazo'],
                rows: goals.map((g) => [g.title, g.status === 'open' && overdue.includes(g) ? 'aberta · atrasada' : g.status, fmtDate(g.target_date)]),
              },
            ]
          : []),
        ...(!epics.length && !goals.length ? [{ kind: 'paragraph' as const, text: 'O projeto não declara épicos nem metas.' }] : []),
      ],
    },
    {
      title: 'Fluxo',
      lead: 'Transições do audit log do projeto no período.',
      blocks: [
        {
          kind: 'kpis',
          items: [
            { label: 'Ciclo p50', value: flow.cycle_time_hours.count ? fmtHours(flow.cycle_time_hours.p50) : '—' },
            { label: 'Ciclo p90', value: flow.cycle_time_hours.count ? fmtHours(flow.cycle_time_hours.p90) : '—' },
            { label: 'Espera em review (p50)', value: flow.decision_latency_hours.count ? fmtHours(flow.decision_latency_hours.p50) : '—' },
            { label: 'Retrabalho', value: fmtPct(flow.rework.rate), hint: `${fmtInt(flow.rework.backward)} volta(s)` },
          ],
        },
        ...(flow.rework.by_transition.length
          ? [
              {
                kind: 'table' as const,
                caption: 'Voltas mais comuns',
                columns: ['De', 'Para', 'Vezes'],
                rows: flow.rework.by_transition.slice(0, 6).map((t) => [t.from_status, t.to_status, fmtInt(t.count)]),
                numeric: [2],
              },
            ]
          : []),
      ],
    },
    {
      title: 'Situação atual',
      lead: `Estado do board em ${fmtDate(today)}, independente do período.`,
      blocks: [
        { kind: 'table', columns: ['Coluna', 'Cards'], rows: wip.map((w) => [w.col, fmtInt(w.n)]), numeric: [1] },
        ...(stalled.length
          ? [{ kind: 'callout' as const, title: 'Esperando decisão', text: stalled.map((s) => s.title).join('; '), tone: 'warn' as const }]
          : []),
        ...(overdue.length
          ? [{ kind: 'callout' as const, title: 'Metas atrasadas', text: overdue.map((g) => `${g.title} (prazo ${fmtDate(g.target_date)})`).join('; '), tone: 'warn' as const }]
          : []),
      ],
    },
  ]

  const notes = [
    'Entrega: último MOVE do card para done dentro do período (card reaberto e refeito conta uma vez).',
    'Custo: token_log do projeto no período (fonte autoritativa de uso), inclui rodadas dos agentes do workflow.',
    'Tempo de ciclo e retrabalho: mesma definição da aba Estatísticas (audit log).',
    ...warnings,
  ]

  return {
    document: {
      kicker: 'Relatório de projeto',
      title: `Projeto ${project.name}`,
      subtitle: `Desenvolvimento de ${fmtPeriod(period)}`,
      period,
      generated_at: ctx.now.toISOString(),
      sections,
      notes,
    },
    facts: {
      tipo: 'projeto',
      projeto: project.name,
      periodo: { ...period, dias: days },
      entregas: delivered.length,
      custo: { usd: cost, tokens, por_entrega: costPerCard === null ? null : round2(costPerCard) },
      semanas: weeks.map((w) => ({ semana: w.week, entregas: w.delivered, usd: round2(w.cost) })),
      fluxo: {
        ciclo_horas: flow.cycle_time_hours,
        espera_review_horas: flow.decision_latency_hours,
        retrabalho_pct: Math.round(flow.rework.rate * 100),
        voltas_mais_comuns: flow.rework.by_transition.slice(0, 3),
      },
      sprints: sprints.map((s) => ({ nome: s.sprint.name, status: s.sprint.status, concluidos: s.done, total: s.total, usd: s.cost })),
      epicos: epics.map((e) => ({ nome: e.epic.name, status: e.epic.status, concluidos: e.done, total: e.total })),
      metas: goals.map((g) => ({ titulo: g.title, status: g.status, prazo: g.target_date, atrasada: overdue.includes(g) })),
      situacao_atual: Object.fromEntries(wip.map((w) => [w.col, w.n])),
      esperando_decisao: stalled.map((s) => s.title),
      entregues: sample(delivered.map((d) => d.card?.title ?? d.card_id).reverse(), 30),
    },
    warnings,
  }
}

function projectSentence(name: string, delivered: number, sprints: number, rework: number, stalled: number): string {
  const parts = [`${name} entregou ${fmtInt(delivered)} card(s) no período, em ${fmtInt(sprints)} sprint(s)`]
  if (rework > 0) parts.push(`com ${fmtPct(rework)} das transições voltando de coluna`)
  const tail = stalled > 0 ? ` Hoje, ${fmtInt(stalled)} card(s) esperam decisão em review.` : ''
  return `${parts.join(', ')}.${tail}`
}

