import { describe, expect, it } from 'vitest'
import type { FlowMetrics, Metrics } from '@obsidiankan/types'
import { projectReport, deliveries, sprintsInPeriod } from '../../server/types/project.js'
import { boardReport } from '../../server/types/board.js'
import { toMarkdown } from '../../server/markdown.js'
import { card, emptyFlow, emptyMetrics, fakeData, move, project, sprint } from './fixtures.js'

const NOW = new Date('2026-07-31T12:00:00.000Z')

function metrics(): Metrics {
  const m = emptyMetrics()
  m.summary = { ...m.summary, total_input_tokens: 1000, total_output_tokens: 500, total_cost_usd: 12, total_ops: 20 }
  m.by_project = [
    { project: 'alfa', input_tokens: 800, output_tokens: 400, cost_usd: 10, ops: 15 },
    { project: 'beta', input_tokens: 200, output_tokens: 100, cost_usd: 2, ops: 5 },
  ]
  m.by_model = [{ model: 'opus', input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 12 }]
  m.by_role = [{ role: 'dev', input_tokens: 1000, output_tokens: 500, cost_usd: 12, ops: 20 }]
  m.by_origin = [
    { origin: 'board', input_tokens: 1500, output_tokens: 0, cost_usd: 12, ops: 20 },
    { origin: 'terminal', input_tokens: 5000, output_tokens: 100, cost_usd: 3.3, ops: 7 },
  ]
  return m
}

function flow(f: { project?: string }): FlowMetrics {
  const base = emptyFlow()
  if (f.project === 'gama') return base
  return {
    ...base,
    cycle_time_hours: { count: 2, p50: 5, p90: 9, max: 9 },
    rework: { forward: 9, backward: 1, rate: 0.1, by_transition: [{ from_status: 'review', to_status: 'in_progress', count: 1 }] },
    by_week: [
      { week_start: '2026-07-06', delivered: 1, cost_usd: 4, cost_per_card: 4 },
      { week_start: '2026-07-13', delivered: 0, cost_usd: 0, cost_per_card: null },
      { week_start: '2026-07-20', delivered: 1, cost_usd: 6, cost_per_card: 6 },
    ],
    cost_reporting_starts: '2026-07-06',
  }
}

function data() {
  const alfa = project({
    sprints: [
      sprint({ id: 'sprint-a1', name: 'A1', started_at: '2026-07-06T09:00:00Z', ended_at: '2026-07-10T18:00:00Z', status: 'closed' }),
      sprint({ id: 'sprint-a2', name: 'A2', started_at: '2026-07-20T09:00:00Z', ended_at: null, status: 'active' }),
      sprint({ id: 'sprint-a0', name: 'Velha', started_at: '2026-05-01T09:00:00Z', ended_at: '2026-05-10T09:00:00Z', status: 'closed' }),
      sprint({ id: 'sprint-a3', name: 'Futura', started_at: null, ended_at: null, status: 'planning' }),
    ],
    goals: [
      { id: 'goal-1', title: 'Lançar beta', target_date: '2026-07-15', status: 'open', created_at: '' },
      { id: 'goal-2', title: 'Documentar', target_date: '2026-08-20', status: 'open', created_at: '' },
    ],
    epics: [{ id: 'epic-1', name: 'Login', objective: null, status: 'open', sprint_ids: ['sprint-a1', 'sprint-a2'], created_at: '' }],
  })
  const beta = project({ name: 'beta', sprints: [sprint({ id: 'sprint-b1', name: 'B1', status: 'closed', started_at: '2026-07-01T00:00:00Z', ended_at: '2026-07-25T00:00:00Z' })] })
  const gama = project({ name: 'gama', sprints: [] })
  return fakeData({
    projects: [alfa, beta, gama],
    cards: [
      card({ id: 'a1', title: 'Tela de login', status: 'done', sprint_id: 'sprint-a1', archived: true }),
      card({ id: 'a2', title: 'Sessão', status: 'done', sprint_id: 'sprint-a2' }),
      card({ id: 'a3', title: 'Senha', status: 'review', sprint_id: 'sprint-a2' }),
      card({ id: 'b1', project: 'beta', title: 'Relatório', status: 'done', sprint_id: 'sprint-b1' }),
    ],
    moves: [
      move('a1', 'todo', 'done', '2026-07-08T10:00:00Z'),
      move('a2', 'todo', 'done', '2026-07-21T10:00:00Z'),
      move('a2', 'done', 'in_progress', '2026-07-21T11:00:00Z'),
      move('a2', 'in_progress', 'done', '2026-07-22T10:00:00Z'),
      move('b1', 'todo', 'done', '2026-07-24T10:00:00Z', 'beta'),
    ],
    stalled: [{ card_id: 'a3', project: 'alfa', title: 'Senha', status: 'review', version: 1, priority: 'high', assigned_to: null, updated_at: '', escalated_at: null, reason: '' }],
    metrics: (f) => (f.sprint_id ? { ...emptyMetrics(), summary: { ...emptyMetrics().summary, total_cost_usd: f.sprint_id === 'sprint-a1' ? 4 : 6 } } : metrics()),
    flow,
  })
}

describe('helpers', () => {
  it('deliveries: último done de cada card, reaberto conta uma vez', () => {
    const d = deliveries(
      [move('x', 'todo', 'done', '2026-07-01T00:00:00Z'), move('x', 'done', 'todo', '2026-07-02T00:00:00Z'), move('x', 'todo', 'done', '2026-07-03T00:00:00Z')],
      'done',
      new Map(),
    )
    expect(d).toEqual([{ card_id: 'x', at: '2026-07-03T00:00:00Z', card: null }])
  })

  it('sprintsInPeriod: sprints que tocam o período, sem planejamento puro', () => {
    const p = project({
      sprints: [
        sprint({ id: 's1', started_at: '2026-06-28T00:00:00Z', ended_at: '2026-07-02T00:00:00Z' }),
        sprint({ id: 's2', started_at: '2026-07-20T00:00:00Z', ended_at: null, status: 'active' }),
        sprint({ id: 's3', started_at: null, ended_at: null, status: 'planning' }),
        sprint({ id: 's4', started_at: '2026-08-02T00:00:00Z', ended_at: null, status: 'active' }),
      ],
    })
    expect(sprintsInPeriod(p, { from: '2026-07-01', to: '2026-07-31' }, '2026-07-31').map((s) => s.id)).toEqual(['s1', 's2'])
  })
})

describe('projectReport', () => {
  it('valida projeto e período (futuro recusado, fim limitado a hoje)', async () => {
    const ctx = { data: data(), now: NOW }
    await expect(projectReport.resolve({ type: 'project', project: 'alfa', from: '2026-07-01', to: '2026-08-31' }, ctx)).resolves.toMatchObject({ from: '2026-07-01', to: '2026-07-31' })
    await expect(projectReport.resolve({ type: 'project', project: 'alfa', from: '2026-08-01', to: '2026-08-31' }, ctx)).rejects.toMatchObject({ status: 400 })
    await expect(projectReport.resolve({ type: 'project', project: 'alfa', from: '2026-07-10', to: '2026-07-01' }, ctx)).rejects.toMatchObject({ body: { error: 'invalid_period' } })
    await expect(projectReport.resolve({ type: 'project', project: 'alfa', from: '2026-02-30', to: '2026-07-01' }, ctx)).rejects.toMatchObject({ body: { field: 'from' } })
    await expect(projectReport.resolve({ type: 'project', from: '2026-07-01', to: '2026-07-10' }, ctx)).rejects.toMatchObject({ body: { field: 'project' } })
  })

  it('monta entregas, sprints, épicos, metas e custo do projeto', async () => {
    const ctx = { data: data(), now: NOW }
    const params = await projectReport.resolve({ type: 'project', project: 'alfa', from: '2026-07-01', to: '2026-07-31' }, ctx)
    const { document, facts } = await projectReport.build(params, ctx)

    expect(facts['entregas']).toBe(2)
    expect(facts['custo']).toEqual({ usd: 10, tokens: 1200, por_entrega: 5 })
    expect(facts['sprints']).toEqual([
      { nome: 'A1', status: 'closed', concluidos: 1, total: 1, usd: 4 },
      { nome: 'A2', status: 'active', concluidos: 1, total: 2, usd: 6 },
    ])
    expect(facts['epicos']).toEqual([{ nome: 'Login', status: 'open', concluidos: 2, total: 3 }])
    expect(facts['metas']).toEqual([
      { titulo: 'Lançar beta', status: 'open', prazo: '2026-07-15', atrasada: true },
      { titulo: 'Documentar', status: 'open', prazo: '2026-08-20', atrasada: false },
    ])
    expect(facts['esperando_decisao']).toEqual(['Senha'])

    const md = toMarkdown(document)
    expect(md).toContain('# Projeto alfa')
    expect(md).toContain('| Tela de login | task | A1 | 08/07/2026 |')
    expect(md).toContain('| Lançar beta | aberta · atrasada | 15/07/2026 |')
    expect(md).toContain('| Login | open | 2 | 2 de 3 (67%) |')
    expect(md).toContain('> **Atenção — Metas atrasadas**')
  })
})

describe('boardReport', () => {
  it('compara projetos, separa terminal estimado e aponta projeto parado', async () => {
    const ctx = { data: data(), now: NOW }
    const params = await boardReport.resolve({ type: 'board', from: '2026-07-01', to: '2026-07-31' }, ctx)
    expect(params).toMatchObject({ project: null, from: '2026-07-01', to: '2026-07-31' })
    const { document, facts } = await boardReport.build(params, ctx)

    expect(facts['totais']).toEqual({ projetos: 3, com_atividade: 2, entregas: 3, usd: 12, tokens: 1500 })
    const projetos = facts['projetos'] as Array<{ nome: string; entregas: number }>
    expect(projetos.map((p) => [p.nome, p.entregas])).toEqual([['alfa', 2], ['beta', 1], ['gama', 0]])
    expect(facts['sem_atividade']).toEqual(['gama'])
    // a2 foi reaberto e refeito: a série semanal conta a entrega uma vez só,
    // igual ao total — não os MOVEs para done.
    const semanas = facts['semanas'] as Array<{ semana: string; entregas: number }>
    expect(semanas.reduce((a, w) => a + w.entregas, 0)).toBe(3)
    expect(semanas.map((w) => w.semana)).toEqual(['2026-07-06', '2026-07-13', '2026-07-20'])
    expect(facts['terminal_estimado_usd']).toBe(3.3)
    expect(facts['sprints_encerradas']).toEqual([
      { projeto: 'alfa', sprint: 'A1' },
      { projeto: 'beta', sprint: 'B1' },
    ])
    expect(facts['metas_proximas']).toHaveLength(2)

    const md = toMarkdown(document)
    expect(md).toContain('No período, o board somou 3 entrega(s) e 2 sprint(s) encerrada(s); alfa liderou com 2.')
    expect(md).toContain('| alfa | 2 | US$ 10,00 | US$ 5,00 | 5,0 h | 10% | A2 |')
    expect(md).toContain('estimativa, não medição')
    expect(md).toContain('> **Sem atividade no período**')
  })

  it('vault vazio não quebra', async () => {
    const ctx = { data: fakeData({ projects: [] }), now: NOW }
    const params = await boardReport.resolve({ type: 'board', from: '2026-07-01', to: '2026-07-31' }, ctx)
    const { document } = await boardReport.build(params, ctx)
    expect(toMarkdown(document)).toContain('Nenhum projeto ativo no vault.')
  })
})
