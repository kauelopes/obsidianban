import { ModuleHttpError } from '@obsidiankan/module-sdk'
import type { CardSummary, Metrics, Sprint } from '@obsidiankan/types'
import type { Block, ReportParams, ReportSection } from '../api-types.js'
import { flowByCard, percentiles } from '../cycle.js'
import { fmtDate, fmtHours, fmtInt, fmtPct, fmtPeriod, fmtTokens, fmtUsd } from '../format.js'
import { daysInclusive, eachDay, localDay, localDayEndIso } from '../period.js'
import {
  badRequest,
  cardCost,
  doneColumn,
  requireProject,
  round2,
  sample,
  sum,
  type BuildContext,
  type BuiltReport,
  type ReportTypeDef,
} from './common.js'

const SPRINT_STATUS: Record<Sprint['status'], string> = {
  planning: 'em planejamento',
  active: 'ativa',
  closed: 'encerrada',
}

export const sprintReport: ReportTypeDef = {
  info: {
    id: 'sprint',
    label: 'Relatório de sprint',
    description: 'Entregas, pendências, fluxo e custo de uma sprint, do início ao fim (ou até hoje, se ainda ativa).',
    needs: ['project', 'sprint'],
  },

  async resolve(req, ctx) {
    const project = await requireProject(ctx, req.project)
    if (!req.sprint_id) throw badRequest('invalid_field', { field: 'sprint_id', hint: 'sprint obrigatória' })
    const sprint = project.sprints.find((s) => s.id === req.sprint_id)
    if (!sprint) throw new ModuleHttpError(404, { error: 'sprint_not_found', sprint_id: req.sprint_id })
    const { from, to } = sprintPeriod(sprint, localDay(ctx.now))
    return {
      type: 'sprint',
      project: project.name,
      sprint_id: sprint.id,
      from,
      to,
      include_analysis: req.include_analysis === true,
    }
  },

  async build(params, ctx) {
    return buildSprint(params, ctx)
  },
}

/** Janela da sprint: início (ou criação) até o fim (ou hoje). */
export function sprintPeriod(s: Sprint, today: string): { from: string; to: string } {
  const from = localDay(s.started_at ?? s.created_at)
  const end = s.ended_at ? localDay(s.ended_at) : today
  return { from, to: end < from ? from : end }
}

async function buildSprint(params: ReportParams, ctx: BuildContext): Promise<BuiltReport> {
  const project = (await ctx.data.getProject(params.project!))!
  const sprint = project.sprints.find((s) => s.id === params.sprint_id)!
  const period = { from: params.from!, to: params.to! }
  const done = doneColumn(project.columns)
  const warnings: string[] = []

  // Arquivados entram: o fechamento da sprint arquiva o que foi concluído, e
  // sem eles o relatório de uma sprint encerrada sairia vazio.
  const cards = ctx.data.listCards({ project: project.name, sprintId: sprint.id, includeArchived: true })
  const ids = new Set(cards.map((c) => c.id))
  const { moves: allMoves, truncated } = await ctx.data.moves({ project: project.name, from_date: period.from, to_date: period.to })
  if (truncated) warnings.push('O audit log passou do teto de leitura: transições mais recentes podem faltar.')
  const moves = allMoves.filter((m) => ids.has(m.card_id))
  const flows = flowByCard(moves, project.columns)

  const doneCards = cards.filter((c) => c.status === done)
  const pending = cards.filter((c) => c.status !== done)
  const completion = cards.length > 0 ? doneCards.length / cards.length : 0

  const cycle = percentiles([...flows.values()].flatMap((f) => f.cycles))
  const review = percentiles([...flows.values()].flatMap((f) => f.reviewWaits))
  const backward = sum([...flows.values()].map((f) => f.backward))
  const forward = sum([...flows.values()].map((f) => f.forward))
  const reworkRate = backward + forward > 0 ? backward / (backward + forward) : 0

  // Custo da sprint vem do token_log (fonte autoritativa de uso), recortado
  // por sprint_id: inclui as rodadas dos agentes do workflow, que não ficam em
  // card nenhum. Os totais por card servem só para ranquear os mais caros.
  const usage = ctx.data.metrics({ sprint_id: sprint.id })
  const cost = round2(usage.summary.total_cost_usd)
  const tokens = usage.summary.total_input_tokens + usage.summary.total_output_tokens
  const byStatus = project.columns.map((col) => ({ status: col, n: cards.filter((c) => c.status === col).length }))
  const blocked = pending.filter((c) => c.blocked_by.length > 0)
  const stalled = (await ctx.data.stalledReviews(project.name)).filter((s) => ids.has(s.card_id))

  // Burn-up: entregas acumuladas pela hora do MOVE para done. Card concluído
  // sem MOVE registrado na janela (ex.: importado já em done) não tem hora —
  // entra no total, mas não na curva, e o aviso diz isso.
  const doneAt = new Map<string, string>()
  for (const c of doneCards) {
    const at = flows.get(c.id)?.doneAt
    if (at) doneAt.set(c.id, at)
  }
  const undated = doneCards.length - doneAt.size
  if (undated > 0) warnings.push(`${undated} card(s) concluído(s) sem transição registrada no período — fora do gráfico de progresso.`)
  const buckets = burnBuckets(sprint, period, ctx.now)
  const burn = buckets.map((b) => [...doneAt.values()].filter((t) => t < b.end).length)

  const byAssignee = groupCount(cards, (c) => c.assigned_to ?? 'sem responsável', (c) => c.status === done)
  const cardTokens = (c: CardSummary) => c.total_input_tokens + c.total_output_tokens
  const topCost = [...cards]
    .filter((c) => cardCost(c) > 0 || cardTokens(c) > 0)
    .sort((a, b) => cardCost(b) - cardCost(a) || cardTokens(b) - cardTokens(a))
    .slice(0, 8)

  const title = `Sprint ${sprint.name}`
  const subtitle = `${project.name} · sprint ${SPRINT_STATUS[sprint.status]} · ${fmtPeriod(period)}`

  const summary: Block[] = [
    {
      kind: 'kpis',
      items: [
        { label: 'Concluídos', value: `${fmtInt(doneCards.length)} de ${fmtInt(cards.length)}`, hint: fmtPct(completion) },
        { label: 'Tempo de ciclo (p50)', value: cycle.count ? fmtHours(cycle.p50) : '—', hint: `${cycle.count} ciclo(s)` },
        { label: 'Retrabalho', value: fmtPct(reworkRate), hint: `${backward} volta(s)` },
        { label: 'Custo medido', value: fmtUsd(cost), hint: `${fmtTokens(tokens)} tokens` },
      ],
    },
    { kind: 'paragraph', text: summarySentence(sprint, cards.length, doneCards.length, pending.length, blocked.length, durationLabel(sprint, period, ctx.now)) },
  ]
  if (sprint.goal) summary.push({ kind: 'callout', title: 'Objetivo da sprint', text: sprint.goal, tone: 'info' })

  const sections: ReportSection[] = [
    { title: 'Resumo', blocks: summary },
    {
      title: 'Progresso',
      lead: 'Entregas acumuladas ao longo da sprint, contra o escopo atual.',
      blocks: [
        {
          kind: 'chart',
          chart: 'line',
          title: 'Cards concluídos (acumulado)',
          labels: buckets.map((b) => b.label),
          series: [
            { name: 'Concluídos', values: burn },
            { name: 'Escopo', values: buckets.map(() => cards.length) },
          ],
        },
        {
          kind: 'table',
          columns: ['Coluna', 'Cards', '% do escopo'],
          rows: byStatus.map((s) => [s.status, fmtInt(s.n), cards.length ? fmtPct(s.n / cards.length) : '—']),
          numeric: [1, 2],
        },
      ],
    },
    {
      title: 'Entregas',
      lead: doneCards.length ? `${fmtInt(doneCards.length)} card(s) chegaram a ${done}.` : 'Nenhum card concluído nesta sprint.',
      blocks: doneCards.length
        ? [
            {
              kind: 'table',
              columns: ['Card', 'Tipo', 'Responsável', 'Concluído em', 'Ciclo'],
              rows: [...doneCards]
                .sort((a, b) => (flows.get(a.id)?.doneAt ?? '').localeCompare(flows.get(b.id)?.doneAt ?? ''))
                .map((c) => {
                  const f = flows.get(c.id)
                  return [c.title, c.type, c.assigned_to ?? '—', fmtDate(f?.doneAt), f?.cycles.length ? fmtHours(sum(f.cycles)) : '—']
                }),
              numeric: [4],
            },
          ]
        : [],
    },
    {
      title: 'Pendências',
      lead: pending.length ? `${fmtInt(pending.length)} card(s) não chegaram a ${done}.` : 'Nada pendente: todo o escopo foi concluído.',
      blocks: [
        ...(pending.length
          ? [
              {
                kind: 'table' as const,
                columns: ['Card', 'Coluna', 'Prioridade', 'Responsável', 'Bloqueado por'],
                rows: pending.map((c) => [c.title, c.status, c.priority, c.assigned_to ?? '—', c.blocked_by.length ? fmtInt(c.blocked_by.length) : '—']),
              },
            ]
          : []),
        ...(stalled.length
          ? [
              {
                kind: 'callout' as const,
                title: 'Esperando decisão',
                text: stalled.map((s) => `${s.title}${s.escalated_at ? ` (escalado em ${fmtDate(s.escalated_at)})` : ''}`).join('; '),
                tone: 'warn' as const,
              },
            ]
          : []),
      ],
    },
    {
      title: 'Fluxo',
      lead: 'Tempos medidos pelas transições do audit log dos cards da sprint.',
      blocks: [
        {
          kind: 'kpis',
          items: [
            { label: 'Ciclo p50', value: cycle.count ? fmtHours(cycle.p50) : '—' },
            { label: 'Ciclo p90', value: cycle.count ? fmtHours(cycle.p90) : '—' },
            { label: 'Espera em review (p50)', value: review.count ? fmtHours(review.p50) : '—' },
            { label: 'Transições', value: fmtInt(moves.length) },
          ],
        },
        {
          kind: 'table',
          columns: ['Responsável', 'Cards', 'Concluídos'],
          rows: byAssignee.map((a) => [a.key, fmtInt(a.total), fmtInt(a.hits)]),
          numeric: [1, 2],
        },
      ],
    },
    {
      title: 'Custo',
      lead: 'Uso medido no token_log da sprint: operações nos cards e rodadas dos agentes do workflow.',
      blocks: costBlocks(usage, topCost, cardTokens),
    },
  ]

  const notes = [
    'Tempo de ciclo: do primeiro MOVE para in_progress até done; um card refeito conta dois ciclos.',
    'Retrabalho: transições para uma coluna anterior, pela ordem de colunas do projeto.',
    'Custo: soma do custo medido no token_log com o sprint_id da sprint (inclui rodadas do workflow). Operações sem custo reportado contam zero.',
    ...warnings,
  ]

  return {
    document: {
      kicker: 'Relatório de sprint',
      title,
      subtitle,
      period,
      generated_at: ctx.now.toISOString(),
      sections,
      notes,
    },
    facts: {
      tipo: 'sprint',
      projeto: project.name,
      sprint: { nome: sprint.name, objetivo: sprint.goal, status: sprint.status, periodo: period, duracao: durationLabel(sprint, period, ctx.now) },
      escopo: { cards: cards.length, concluidos: doneCards.length, pendentes: pending.length, conclusao_pct: Math.round(completion * 100), bloqueados: blocked.length },
      por_coluna: byStatus,
      fluxo: { ciclo_horas: cycle, espera_review_horas: review, retrabalho_pct: Math.round(reworkRate * 100), voltas: backward },
      custo: { usd: cost, tokens, operacoes: usage.summary.total_ops, por_operacao: usage.by_operation.map((o) => ({ op: o.op, usd: round2(o.cost_usd), n: o.count })) },
      cards_mais_caros: topCost.map((c) => ({ titulo: c.title, usd: round2(cardCost(c)) })),
      esperando_decisao: stalled.map((s) => s.title),
      concluidos: sample(doneCards.map((c) => c.title), 30),
      pendentes: sample(pending.map((c) => ({ titulo: c.title, coluna: c.status, prioridade: c.priority })), 30),
    },
    warnings,
  }
}

function costBlocks(usage: Metrics, topCost: CardSummary[], cardTokens: (c: CardSummary) => number): Block[] {
  if (usage.summary.total_ops === 0 && topCost.length === 0) {
    return [{ kind: 'paragraph', text: 'Nenhum uso de tokens registrado para esta sprint.' }]
  }
  const blocks: Block[] = []
  if (usage.by_operation.length > 0) {
    blocks.push({
      kind: 'table',
      columns: ['Operação', 'Vezes', 'Tokens', 'Custo'],
      rows: [...usage.by_operation]
        .sort((a, b) => b.cost_usd - a.cost_usd)
        .map((o) => [OP_LABEL[o.op] ?? o.op, fmtInt(o.count), fmtTokens(o.input_tokens + o.output_tokens), fmtUsd(o.cost_usd)]),
      numeric: [1, 2, 3],
      caption: 'Por tipo de operação',
    })
  }
  const models = usage.by_model.filter((m) => m.cost_usd > 0 || m.input_tokens + m.output_tokens > 0)
  if (models.length > 1) {
    blocks.push({
      kind: 'table',
      columns: ['Modelo', 'Tokens', 'Custo'],
      rows: models.map((m) => [m.model, fmtTokens(m.input_tokens + m.output_tokens), fmtUsd(m.cost_usd)]),
      numeric: [1, 2],
      caption: 'Por modelo',
    })
  }
  if (topCost.length > 0) {
    blocks.push({
      kind: 'table',
      columns: ['Card', 'Coluna', 'Tokens', 'Custo'],
      rows: topCost.map((c) => [c.title, c.status, fmtTokens(cardTokens(c)), fmtUsd(cardCost(c))]),
      numeric: [2, 3],
      caption: 'Cards com mais uso',
    })
  }
  return blocks
}

const OP_LABEL: Record<string, string> = {
  WORKFLOW_DEV: 'rodada do agente dev (workflow)',
  WORKFLOW_TRIAGE: 'triagem do pm (workflow)',
  PLANNING: 'planejamento',
  CREATE: 'criação de card',
  UPDATE: 'edição de card',
  MOVE: 'movimentação de card',
  REORDER: 'reordenação',
  DELETE: 'exclusão',
}

const HOUR_MS = 3_600_000
/** Até aqui o burn-up vai por hora; acima, por dia. Sprint de agente dura horas. */
const HOURLY_MAX_MS = 48 * HOUR_MS

/**
 * Pontos do burn-up. `end` é exclusivo: conta tudo concluído antes dele. Com
 * timestamps reais de início/fim e duração curta, buckets de hora; senão, um
 * por dia do período.
 */
export function burnBuckets(s: Sprint, period: { from: string; to: string }, now: Date): Array<{ label: string; end: string }> {
  const start = Date.parse(s.started_at ?? s.created_at)
  const stop = s.ended_at ? Date.parse(s.ended_at) : now.getTime()
  if (stop > start && stop - start <= HOURLY_MAX_MS) {
    const first = Math.floor(start / HOUR_MS) * HOUR_MS
    const out: Array<{ label: string; end: string }> = []
    for (let t = first; t < stop; t += HOUR_MS) {
      const d = new Date(t)
      out.push({
        label: `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}h`,
        end: new Date(t + HOUR_MS).toISOString(),
      })
    }
    return out
  }
  return eachDay(period.from, period.to).map((d) => ({ label: fmtDate(d).slice(0, 5), end: localDayEndIso(d) }))
}

/** "6,5 h" para sprint curta (com início e fim reais), "12 dia(s)" para as demais. */
function durationLabel(s: Sprint, period: { from: string; to: string }, now: Date): string {
  const start = Date.parse(s.started_at ?? s.created_at)
  const stop = s.ended_at ? Date.parse(s.ended_at) : now.getTime()
  if (stop > start && stop - start <= HOURLY_MAX_MS) return fmtHours((stop - start) / HOUR_MS)
  return `${fmtInt(daysInclusive(period.from, period.to))} dia(s)`
}

function summarySentence(s: Sprint, total: number, done: number, pending: number, blocked: number, duration: string): string {
  if (total === 0) return `A sprint ${s.name} não tem cards associados.`
  const parts = [`Em ${duration}, ${fmtInt(done)} de ${fmtInt(total)} cards foram concluídos`]
  if (pending > 0) parts.push(`${fmtInt(pending)} seguem pendentes${blocked > 0 ? ` (${fmtInt(blocked)} com bloqueio declarado)` : ''}`)
  return `${parts.join('; ')}.`
}

function groupCount(
  cards: readonly CardSummary[],
  key: (c: CardSummary) => string,
  hit: (c: CardSummary) => boolean,
): Array<{ key: string; total: number; hits: number }> {
  const m = new Map<string, { total: number; hits: number }>()
  for (const c of cards) {
    const k = key(c)
    const e = m.get(k) ?? { total: 0, hits: 0 }
    e.total++
    if (hit(c)) e.hits++
    m.set(k, e)
  }
  return [...m.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.total - a.total)
}
