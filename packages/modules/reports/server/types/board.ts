import type { ReportParams, ReportSection } from '../api-types.js'
import { fmtDate, fmtHours, fmtInt, fmtPct, fmtPeriod, fmtTokens, fmtUsd } from '../format.js'
import { addDays, daysInclusive, localDay } from '../period.js'
import { deliveries, flowWarnings, weekRows, weekly, type Delivery } from './project.js'
import {
  doneColumn,
  requirePeriod,
  round2,
  type BuildContext,
  type BuiltReport,
  type ReportTypeDef,
} from './common.js'

/** Metas com prazo até esta distância depois do período entram como "próximas". */
const UPCOMING_GOAL_DAYS = 30

export const boardReport: ReportTypeDef = {
  info: {
    id: 'board',
    label: 'Relatório do board',
    description: 'Desempenho de todos os projetos no período: comparativo, ritmo, custo por modelo e papel, sprints e metas.',
    needs: ['period'],
  },

  async resolve(req, ctx) {
    const { from, to } = requirePeriod(req, localDay(ctx.now))
    return { type: 'board', project: null, sprint_id: null, from, to, include_analysis: req.include_analysis === true }
  },

  async build(params, ctx) {
    return buildBoard(params, ctx)
  },
}

async function buildBoard(params: ReportParams, ctx: BuildContext): Promise<BuiltReport> {
  const { data } = ctx
  const period = { from: params.from!, to: params.to! }
  const today = localDay(ctx.now)
  const projects = await data.listProjects()

  const metrics = data.metrics({ from_date: period.from, to_date: period.to })
  const flowAll = await data.flow({ from_date: period.from, to_date: period.to })
  const warnings = flowWarnings(flowAll, period)
  const stalled = await data.stalledReviews()

  const rows = []
  const allDelivered: Delivery[] = []
  for (const p of projects) {
    const flow = await data.flow({ project: p.name, from_date: period.from, to_date: period.to })
    const { moves } = await data.moves({ project: p.name, from_date: period.from, to_date: period.to })
    const cards = new Map(data.listCards({ project: p.name, includeArchived: true }).map((c) => [c.id, c]))
    const projectDelivered = deliveries(moves, doneColumn(p.columns), cards)
    allDelivered.push(...projectDelivered)
    const delivered = projectDelivered.length
    const usage = metrics.by_project.find((u) => u.project === p.name)
    const cost = round2(usage?.cost_usd ?? 0)
    rows.push({
      name: p.name,
      delivered,
      cost,
      ops: usage?.ops ?? 0,
      cycle: flow.cycle_time_hours,
      rework: flow.rework.rate,
      active: p.sprints.find((s) => s.status === 'active')?.name ?? null,
      stalled: stalled.filter((s) => s.project === p.name).length,
      lastMove: moves.reduce<string | null>((acc, m) => (!acc || m.ts > acc ? m.ts : acc), null),
    })
  }
  rows.sort((a, b) => b.delivered - a.delivered || b.cost - a.cost)

  const delivered = rows.reduce((a, r) => a + r.delivered, 0)
  const cost = round2(metrics.summary.total_cost_usd)
  const tokens = metrics.summary.total_input_tokens + metrics.summary.total_output_tokens
  const active = rows.filter((r) => r.delivered > 0 || r.ops > 0)
  const idle = rows.filter((r) => r.delivered === 0 && r.ops === 0)

  const closedSprints = projects
    .flatMap((p) => p.sprints.map((s) => ({ project: p.name, sprint: s })))
    .filter(({ sprint }) => sprint.ended_at && localDay(sprint.ended_at) >= period.from && localDay(sprint.ended_at) <= period.to)
    .sort((a, b) => a.sprint.ended_at!.localeCompare(b.sprint.ended_at!))

  const horizon = addDays(period.to, UPCOMING_GOAL_DAYS)
  const goals = projects
    .flatMap((p) => p.goals.map((g) => ({ project: p.name, goal: g })))
    .filter(({ goal }) => goal.status === 'open' && goal.target_date && goal.target_date <= horizon)
    .sort((a, b) => a.goal.target_date!.localeCompare(b.goal.target_date!))

  const terminal = metrics.by_origin?.find((o) => o.origin === 'terminal')
  const days = daysInclusive(period.from, period.to)
  const weeks = weekly(allDelivered, flowAll)

  const sections: ReportSection[] = [
    {
      title: 'Resumo',
      blocks: [
        {
          kind: 'kpis',
          items: [
            { label: 'Projetos com atividade', value: `${fmtInt(active.length)} de ${fmtInt(rows.length)}` },
            { label: 'Entregas', value: fmtInt(delivered), hint: `em ${fmtInt(days)} dia(s)` },
            { label: 'Custo medido (board)', value: fmtUsd(cost), hint: `${fmtTokens(tokens)} tokens` },
            { label: 'Tempo de ciclo (p50)', value: flowAll.cycle_time_hours.count ? fmtHours(flowAll.cycle_time_hours.p50) : '—' },
          ],
        },
        { kind: 'paragraph', text: boardSentence(rows, delivered, closedSprints.length) },
      ],
    },
    {
      title: 'Comparativo por projeto',
      blocks: rows.length
        ? [
            {
              kind: 'table',
              columns: ['Projeto', 'Entregas', 'Custo', 'Custo/entrega', 'Ciclo p50', 'Retrabalho', 'Sprint ativa'],
              rows: rows.map((r) => [
                r.name,
                fmtInt(r.delivered),
                fmtUsd(r.cost),
                r.delivered > 0 && r.cost > 0 ? fmtUsd(r.cost / r.delivered) : '—',
                r.cycle.count ? fmtHours(r.cycle.p50) : '—',
                fmtPct(r.rework),
                r.active ?? '—',
              ]),
              numeric: [1, 2, 3, 4, 5],
            },
            { kind: 'chart', chart: 'bar', title: 'Entregas por projeto', labels: rows.map((r) => r.name), series: [{ name: 'Entregas', values: rows.map((r) => r.delivered) }] },
            { kind: 'chart', chart: 'bar', title: 'Custo por projeto (US$)', labels: rows.map((r) => r.name), series: [{ name: 'Custo', values: rows.map((r) => r.cost) }] },
          ]
        : [{ kind: 'paragraph', text: 'Nenhum projeto ativo no vault.' }],
    },
    {
      title: 'Ritmo semanal',
      lead: 'Todos os projetos somados.',
      blocks: weeks.length
        ? [
            { kind: 'chart', chart: 'bar', title: 'Entregas por semana', labels: weeks.map((w) => fmtDate(w.week).slice(0, 5)), series: [{ name: 'Entregas', values: weeks.map((w) => w.delivered) }] },
            { kind: 'table', columns: ['Semana de', 'Entregas', 'Custo', 'Custo/entrega'], rows: weekRows(weeks), numeric: [1, 2, 3] },
          ]
        : [{ kind: 'paragraph', text: 'Nenhuma entrega nem custo registrado no período.' }],
    },
    {
      title: 'Custo',
      lead: 'Uso medido no board (token_log). Terminal é estimado por tabela de preço e aparece à parte.',
      blocks: [
        ...(metrics.by_model.length
          ? [
              {
                kind: 'table' as const,
                caption: 'Por modelo',
                columns: ['Modelo', 'Tokens', 'Custo'],
                rows: metrics.by_model
                  .filter((m) => m.cost_usd > 0 || m.input_tokens + m.output_tokens > 0)
                  .sort((a, b) => b.cost_usd - a.cost_usd)
                  .map((m) => [m.model, fmtTokens(m.input_tokens + m.output_tokens), fmtUsd(m.cost_usd)]),
                numeric: [1, 2],
              },
            ]
          : []),
        ...(metrics.by_role.length
          ? [
              {
                kind: 'table' as const,
                caption: 'Por papel',
                columns: ['Papel', 'Operações', 'Custo'],
                rows: [...metrics.by_role].sort((a, b) => b.cost_usd - a.cost_usd).map((r) => [r.role, fmtInt(r.ops), fmtUsd(r.cost_usd)]),
                numeric: [1, 2],
              },
            ]
          : []),
        ...(terminal && terminal.ops > 0
          ? [
              {
                kind: 'callout' as const,
                title: 'Uso de terminal (estimado)',
                text: `Além do board, ${fmtInt(terminal.ops)} chamada(s) em sessões de terminal somaram ${fmtTokens(terminal.input_tokens + terminal.output_tokens)} tokens, ~${fmtUsd(terminal.cost_usd)} pela tabela de preços — estimativa, não medição.`,
                tone: 'info' as const,
              },
            ]
          : []),
        ...(metrics.summary.total_ops === 0 ? [{ kind: 'paragraph' as const, text: 'Nenhum uso de tokens registrado no período.' }] : []),
      ],
    },
    {
      title: 'Sprints encerradas',
      blocks: closedSprints.length
        ? [
            {
              kind: 'table',
              columns: ['Projeto', 'Sprint', 'Início', 'Fim'],
              rows: closedSprints.map(({ project, sprint }) => [project, sprint.name, fmtDate(sprint.started_at), fmtDate(sprint.ended_at)]),
            },
          ]
        : [{ kind: 'paragraph', text: 'Nenhuma sprint encerrada no período.' }],
    },
    {
      title: 'Atenção',
      lead: 'Estado atual e o que vem pela frente.',
      blocks: [
        ...(goals.length
          ? [
              {
                kind: 'table' as const,
                caption: `Metas abertas com prazo até ${fmtDate(horizon)}`,
                columns: ['Projeto', 'Meta', 'Prazo', 'Situação'],
                rows: goals.map(({ project, goal }) => [project, goal.title, fmtDate(goal.target_date), goal.target_date! < today ? 'atrasada' : 'no prazo']),
              },
            ]
          : []),
        ...(stalled.length
          ? [{ kind: 'callout' as const, title: 'Esperando decisão', text: stalled.map((s) => `${s.project}: ${s.title}`).join('; '), tone: 'warn' as const }]
          : []),
        ...(idle.length
          ? [{ kind: 'callout' as const, title: 'Sem atividade no período', text: idle.map((r) => r.name).join(', '), tone: 'info' as const }]
          : []),
        ...(!goals.length && !stalled.length && !idle.length ? [{ kind: 'paragraph' as const, text: 'Nada pendente de atenção.' }] : []),
      ],
    },
  ]

  const notes = [
    'Entrega: último MOVE do card para done dentro do período.',
    'Custo do board: token_log (medido), inclui rodadas dos agentes do workflow; terminal é estimado e fica fora do total.',
    'Projeto com atividade: teve entrega ou alguma operação registrada no período. Projetos arquivados ficam de fora.',
    ...warnings,
  ]

  return {
    document: {
      kicker: 'Relatório do board',
      title: 'Desempenho do board',
      subtitle: `Todos os projetos · ${fmtPeriod(period)}`,
      period,
      generated_at: ctx.now.toISOString(),
      sections,
      notes,
    },
    facts: {
      tipo: 'board',
      periodo: { ...period, dias: days },
      totais: { projetos: rows.length, com_atividade: active.length, entregas: delivered, usd: cost, tokens },
      projetos: rows.map((r) => ({
        nome: r.name,
        entregas: r.delivered,
        usd: r.cost,
        ciclo_p50_horas: r.cycle.count ? r.cycle.p50 : null,
        retrabalho_pct: Math.round(r.rework * 100),
        sprint_ativa: r.active,
        esperando_decisao: r.stalled,
        ultimo_movimento: r.lastMove,
      })),
      semanas: weeks.map((w) => ({ semana: w.week, entregas: w.delivered, usd: round2(w.cost) })),
      custo_por_modelo: metrics.by_model.filter((m) => m.cost_usd > 0).map((m) => ({ modelo: m.model, usd: round2(m.cost_usd) })),
      terminal_estimado_usd: terminal ? round2(terminal.cost_usd) : 0,
      sprints_encerradas: closedSprints.map(({ project, sprint }) => ({ projeto: project, sprint: sprint.name })),
      metas_proximas: goals.map(({ project, goal }) => ({ projeto: project, meta: goal.title, prazo: goal.target_date })),
      sem_atividade: idle.map((r) => r.name),
    },
    warnings,
  }
}

function boardSentence(rows: Array<{ name: string; delivered: number }>, delivered: number, closed: number): string {
  if (rows.length === 0) return 'Nenhum projeto ativo no vault.'
  const top = rows.find((r) => r.delivered > 0)
  const head = `No período, o board somou ${fmtInt(delivered)} entrega(s) e ${fmtInt(closed)} sprint(s) encerrada(s)`
  return top ? `${head}; ${top.name} liderou com ${fmtInt(top.delivered)}.` : `${head}.`
}
