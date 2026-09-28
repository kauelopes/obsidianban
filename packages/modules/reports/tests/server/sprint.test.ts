import { describe, expect, it } from 'vitest'
import { ModuleHttpError } from '@obsidiankan/module-sdk'
import { sprintPeriod, sprintReport } from '../../server/types/sprint.js'
import { toMarkdown } from '../../server/markdown.js'
import { localDay } from '../../server/period.js'
import { card, emptyMetrics, fakeData, move, project, sprint } from './fixtures.js'

const NOW = new Date('2026-07-20T12:00:00.000Z')

function scenario() {
  const cards = [
    card({ id: 'c1', title: 'Tela de login', status: 'done', assigned_to: 'agent:dev', total_cost_usd: 1.5, total_input_tokens: 1000, total_output_tokens: 500 }),
    card({ id: 'c2', title: 'API de sessão', status: 'done', assigned_to: 'agent:dev', total_cost_usd: 0.5 }),
    card({ id: 'c3', title: 'Recuperar senha', status: 'review', priority: 'high', blocked_by: ['c9'] }),
    card({ id: 'c4', title: 'Fora da sprint', status: 'done', sprint_id: 'sprint-outra' }),
  ]
  const moves = [
    move('c1', 'todo', 'in_progress', '2026-07-06T10:00:00.000Z'),
    move('c1', 'in_progress', 'review', '2026-07-07T10:00:00.000Z'),
    move('c1', 'review', 'in_progress', '2026-07-07T14:00:00.000Z'), // retrabalho
    move('c1', 'in_progress', 'done', '2026-07-08T10:00:00.000Z'),
    move('c2', 'todo', 'in_progress', '2026-07-08T09:00:00.000Z'),
    move('c2', 'in_progress', 'done', '2026-07-08T15:00:00.000Z'),
    move('c3', 'todo', 'in_progress', '2026-07-09T09:00:00.000Z'),
    move('c3', 'in_progress', 'review', '2026-07-09T12:00:00.000Z'),
    move('c4', 'todo', 'done', '2026-07-09T12:00:00.000Z'),
  ]
  const stalled = [
    { card_id: 'c3', project: 'alfa', title: 'Recuperar senha', status: 'review', version: 3, priority: 'high', assigned_to: null, updated_at: '', escalated_at: '2026-07-09T13:00:00.000Z', reason: 'precisa de decisão' },
  ]
  const metrics = (f: { sprint_id?: string }) => {
    const m = emptyMetrics()
    if (f.sprint_id !== 'sprint-aaaa0001') return m
    m.summary = { ...m.summary, total_input_tokens: 1200, total_output_tokens: 300, total_cost_usd: 4.5, total_ops: 3 }
    m.by_operation = [
      { op: 'WORKFLOW_DEV', input_tokens: 1000, output_tokens: 200, cost_usd: 4, count: 2 },
      { op: 'MOVE', input_tokens: 200, output_tokens: 100, cost_usd: 0.5, count: 1 },
    ]
    return m
  }
  return fakeData({ cards, moves, stalled, metrics })
}

describe('sprintPeriod', () => {
  it('usa início→fim, ou até hoje quando ativa, ou a criação quando nunca começou', () => {
    expect(sprintPeriod(sprint(), '2026-07-20')).toEqual({ from: '2026-07-06', to: '2026-07-10' })
    expect(sprintPeriod(sprint({ status: 'active', ended_at: null }), '2026-07-20')).toEqual({ from: '2026-07-06', to: '2026-07-20' })
    expect(sprintPeriod(sprint({ status: 'planning', started_at: null, ended_at: null }), '2026-07-20')).toEqual({ from: '2026-07-01', to: '2026-07-20' })
  })
})

describe('sprintReport.resolve', () => {
  it('valida projeto e sprint e resolve o período', async () => {
    const ctx = { data: scenario(), now: NOW }
    await expect(sprintReport.resolve({ type: 'sprint', project: 'alfa', sprint_id: 'sprint-aaaa0001' }, ctx)).resolves.toEqual({
      type: 'sprint',
      project: 'alfa',
      sprint_id: 'sprint-aaaa0001',
      from: '2026-07-06',
      to: '2026-07-10',
      include_analysis: false,
    })
    await expect(sprintReport.resolve({ type: 'sprint', project: 'nada', sprint_id: 'x' }, ctx)).rejects.toMatchObject({ status: 404 })
    await expect(sprintReport.resolve({ type: 'sprint', project: 'alfa' }, ctx)).rejects.toBeInstanceOf(ModuleHttpError)
    await expect(sprintReport.resolve({ type: 'sprint', project: 'alfa', sprint_id: 'sprint-x' }, ctx)).rejects.toMatchObject({
      status: 404,
      body: { error: 'sprint_not_found' },
    })
  })
})

describe('sprintReport.build', () => {
  it('calcula escopo, fluxo e custo só com os cards da sprint', async () => {
    const data = scenario()
    const ctx = { data, now: NOW }
    const params = await sprintReport.resolve({ type: 'sprint', project: 'alfa', sprint_id: 'sprint-aaaa0001' }, ctx)
    const { document, facts, warnings } = await sprintReport.build(params, ctx)

    expect(warnings).toEqual([])
    expect(facts['escopo']).toEqual({ cards: 3, concluidos: 2, pendentes: 1, conclusao_pct: 67, bloqueados: 1 })
    const fluxo = facts['fluxo'] as { ciclo_horas: { count: number; p50: number }; voltas: number; retrabalho_pct: number }
    // c1: 06 10h → 08 10h = 48h; c2: 6h → p50 = 6h (menor dos dois)
    expect(fluxo.ciclo_horas).toMatchObject({ count: 2, p50: 6, max: 48 })
    expect(fluxo.voltas).toBe(1)
    // Custo da sprint = token_log por sprint_id (inclui rodadas do workflow),
    // não a soma dos cards (que daria 2,00).
    expect(facts['custo']).toMatchObject({ usd: 4.5, tokens: 1500, operacoes: 3 })
    const md = toMarkdown(document)
    expect(md).toContain('| rodada do agente dev (workflow) | 2 | 1.200 | US$ 4,00 |')
    expect(md).toContain('**Cards com mais uso**')
    expect(facts['esperando_decisao']).toEqual(['Recuperar senha'])

    expect(document.title).toBe('Sprint S1')
    expect(document.period).toEqual({ from: '2026-07-06', to: '2026-07-10' })
    expect(document.sections.map((s) => s.title)).toEqual(['Resumo', 'Progresso', 'Entregas', 'Pendências', 'Fluxo', 'Custo'])

    const chart = document.sections[1]!.blocks[0]!
    expect(chart).toMatchObject({ kind: 'chart', chart: 'line' })
    if (chart.kind === 'chart') {
      expect(chart.labels).toEqual(['06/07', '07/07', '08/07', '09/07', '10/07'])
      expect(chart.series[0]!.values).toEqual([0, 0, 2, 2, 2])
      expect(chart.series[1]!.values).toEqual([3, 3, 3, 3, 3])
    }
  })

  it('inclui cards arquivados — o fechamento da sprint arquiva o que foi concluído', async () => {
    const data = fakeData({ cards: [card({ id: 'c1', status: 'done', archived: true }), card({ id: 'c2', status: 'todo' })] })
    const ctx = { data, now: NOW }
    const params = await sprintReport.resolve({ type: 'sprint', project: 'alfa', sprint_id: 'sprint-aaaa0001' }, ctx)
    const { facts } = await sprintReport.build(params, ctx)
    expect(facts['escopo']).toMatchObject({ cards: 2, concluidos: 1 })
  })

  it('sprint de horas: burn-up por hora e duração em horas', async () => {
    const short = sprint({ started_at: '2026-07-06T09:20:00.000Z', ended_at: '2026-07-06T12:10:00.000Z' })
    const data = fakeData({
      projects: [project({ sprints: [short] })],
      cards: [card({ id: 'c1', status: 'done' })],
      moves: [move('c1', 'todo', 'done', '2026-07-06T10:30:00.000Z')],
    })
    const ctx = { data, now: NOW }
    const params = await sprintReport.resolve({ type: 'sprint', project: 'alfa', sprint_id: 'sprint-aaaa0001' }, ctx)
    const { document } = await sprintReport.build(params, ctx)
    const chart = document.sections[1]!.blocks[0]!
    if (chart.kind !== 'chart') throw new Error('esperava gráfico')
    // horário de Brasília (TZ fixado no vitest.config): 09:20Z = 06:20 local
    expect(chart.labels).toEqual(['06/07 06h', '06/07 07h', '06/07 08h', '06/07 09h'])
    expect(chart.series[0]!.values).toEqual([0, 1, 1, 1])
    const summary = document.sections[0]!.blocks.find((b) => b.kind === 'paragraph')
    expect(summary).toMatchObject({ text: 'Em 2,8 h, 1 de 1 cards foram concluídos.' })
  })

  it('card concluído sem MOVE no período vira aviso, não número inventado', async () => {
    const data = fakeData({ cards: [card({ id: 'c1', status: 'done' })] })
    const ctx = { data, now: NOW }
    const params = await sprintReport.resolve({ type: 'sprint', project: 'alfa', sprint_id: 'sprint-aaaa0001' }, ctx)
    const { warnings, document } = await sprintReport.build(params, ctx)
    expect(warnings[0]).toMatch(/1 card\(s\) concluído\(s\) sem transição/)
    expect(document.notes.at(-1)).toBe(warnings[0])
  })

  it('sprint vazia gera documento coerente', async () => {
    const ctx = { data: fakeData({ projects: [project({ sprints: [sprint({ goal: null })] })] }), now: NOW }
    const params = await sprintReport.resolve({ type: 'sprint', project: 'alfa', sprint_id: 'sprint-aaaa0001' }, ctx)
    const { document } = await sprintReport.build(params, ctx)
    const md = toMarkdown(document)
    expect(md).toContain('não tem cards associados')
    expect(md).toContain('Nenhum card concluído nesta sprint.')
  })
})

describe('datas no fuso local', () => {
  it('sprint da noite de Brasília fica no dia local, não no dia UTC seguinte', async () => {
    // 20:30–22:30 do dia 06/07 em Brasília = 23:30Z do 06 até 01:30Z do 07
    const night = sprint({ started_at: '2026-07-06T23:30:00.000Z', ended_at: '2026-07-07T01:30:00.000Z' })
    expect(sprintPeriod(night, '2026-07-20')).toEqual({ from: '2026-07-06', to: '2026-07-06' })
  })

  it('"hoje" e "gerado em" seguem o relógio local às 23h', async () => {
    const lateNow = new Date('2026-08-01T02:00:00.000Z') // 31/07 23h em Brasília
    const active = sprint({ status: 'active', ended_at: null })
    expect(sprintPeriod(active, localDay(lateNow))).toEqual({ from: '2026-07-06', to: '2026-07-31' })
    const ctx = { data: fakeData({ projects: [project({ sprints: [active] })] }), now: lateNow }
    const params = await sprintReport.resolve({ type: 'sprint', project: 'alfa', sprint_id: 'sprint-aaaa0001' }, ctx)
    const { document } = await sprintReport.build(params, ctx)
    expect(toMarkdown(document)).toContain('gerado em 31/07/2026')
  })
})
