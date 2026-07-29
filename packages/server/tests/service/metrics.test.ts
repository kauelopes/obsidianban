import { describe, expect, it } from 'vitest'
import { MetricsService } from '../../src/services/metrics.js'
import { createTestDb } from '../helpers/db.js'

/**
 * O by_project é o que permite à home responder "quanto cada projeto gastou"
 * sem baixar cards. A coluna project sempre existiu no token_log; estes testes
 * travam a agregação que passou a expô-la.
 */
function seed(db: ReturnType<typeof createTestDb>) {
  const ins = db.prepare(
    `INSERT INTO token_log (ts, op, card_id, card_type, actor, model, input_tokens, output_tokens, project)
     VALUES (@ts, @op, @card_id, @card_type, @actor, @model, @input_tokens, @output_tokens, @project)`,
  )
  const rows = [
    { ts: '2026-07-01T10:00:00Z', op: 'CREATE', project: 'alfa', model: 'claude-opus-4-8', input_tokens: 100, output_tokens: 50 },
    { ts: '2026-07-02T10:00:00Z', op: 'UPDATE', project: 'alfa', model: 'gpt-5.1-codex', input_tokens: 30, output_tokens: 10 },
    { ts: '2026-07-03T10:00:00Z', op: 'UPDATE', project: 'beta', model: 'claude-haiku-4-5', input_tokens: 7, output_tokens: 3 },
  ]
  for (const r of rows) {
    ins.run({ ...r, card_id: 'card-x', card_type: 'task', actor: 'agent:dev-1' })
  }
}

describe('MetricsService by_project', () => {
  it('agrega tokens e contagem por projeto, ordenado por nome', () => {
    const db = createTestDb()
    seed(db)
    const m = new MetricsService(db).collect({})
    expect(m.by_project).toEqual([
      { project: 'alfa', input_tokens: 130, output_tokens: 60, cost_usd: 0, ops: 2 },
      { project: 'beta', input_tokens: 7, output_tokens: 3, cost_usd: 0, ops: 1 },
    ])
  })

  it('respeita a janela de datas como as demais agregações', () => {
    const db = createTestDb()
    seed(db)
    const m = new MetricsService(db).collect({ from_date: '2026-07-02', to_date: '2026-07-03' })
    expect(m.by_project).toEqual([
      { project: 'alfa', input_tokens: 30, output_tokens: 10, cost_usd: 0, ops: 1 },
      { project: 'beta', input_tokens: 7, output_tokens: 3, cost_usd: 0, ops: 1 },
    ])
  })

  it('sem linhas, devolve lista vazia — não undefined', () => {
    const db = createTestDb()
    const m = new MetricsService(db).collect({})
    expect(m.by_project).toEqual([])
  })
})

describe('MetricsService by_project_day', () => {
  it('cruza projeto e dia (UTC), contando ops mesmo com tokens zerados', () => {
    const db = createTestDb()
    seed(db)
    // MOVE humano no mesmo dia do CREATE de alfa: tokens 0, mas é atividade.
    db.prepare(
      `INSERT INTO token_log (ts, op, card_id, card_type, actor, model, input_tokens, output_tokens, project)
       VALUES ('2026-07-01T18:00:00Z', 'MOVE', 'card-x', 'task', 'human:kaue', 'human', 0, 0, 'alfa')`,
    ).run()
    const m = new MetricsService(db).collect({})
    expect(m.by_project_day).toEqual([
      { project: 'alfa', date: '2026-07-01', input_tokens: 100, output_tokens: 50, cost_usd: 0, ops: 2 },
      { project: 'alfa', date: '2026-07-02', input_tokens: 30, output_tokens: 10, cost_usd: 0, ops: 1 },
      { project: 'beta', date: '2026-07-03', input_tokens: 7, output_tokens: 3, cost_usd: 0, ops: 1 },
    ])
  })

  it('respeita a janela de datas', () => {
    const db = createTestDb()
    seed(db)
    const m = new MetricsService(db).collect({ from_date: '2026-07-02', to_date: '2026-07-02' })
    expect(m.by_project_day).toEqual([
      { project: 'alfa', date: '2026-07-02', input_tokens: 30, output_tokens: 10, cost_usd: 0, ops: 1 },
    ])
  })
})

/**
 * Camada "nenhum token se perde": linhas WORKFLOW_* (registro por round, sem
 * card) carregam cache e custo medido, e o summary os agrega. cost_usd é o
 * número autoritativo — as linhas antigas ficam em 0, nunca somem.
 */
describe('MetricsService usage medido (cache + cost_usd)', () => {
  it('soma cache e custo no summary e nos recortes por modelo/projeto', () => {
    const db = createTestDb()
    seed(db)
    db.prepare(
      `INSERT INTO token_log (ts, op, card_id, card_type, actor, model, input_tokens, output_tokens, project,
                              cache_read_tokens, cache_creation_tokens, cost_usd, sprint_id)
       VALUES ('2026-07-04T10:00:00Z', 'WORKFLOW_DEV', '', 'workflow_round', 'workflow:pm', 'claude-opus-4-8',
               20, 3000, 'alfa', 250000, 40000, 1.7343, 'sprint-01')`,
    ).run()

    const m = new MetricsService(db).collect({})
    expect(m.summary.total_cache_read_tokens).toBe(250000)
    expect(m.summary.total_cache_creation_tokens).toBe(40000)
    expect(m.summary.total_cost_usd).toBeCloseTo(1.7343, 6)

    const opus = m.by_model.find((r) => r.model === 'claude-opus-4-8')!
    expect(opus.cache_read_tokens).toBe(250000)
    expect(opus.cost_usd).toBeCloseTo(1.7343, 6)

    const alfa = m.by_project.find((r) => r.project === 'alfa')!
    expect(alfa.cost_usd).toBeCloseTo(1.7343, 6)
    expect(alfa.ops).toBe(3)

    const round = m.by_operation.find((r) => r.op === 'WORKFLOW_DEV')!
    expect(round.count).toBe(1)
    expect(round.cost_usd).toBeCloseTo(1.7343, 6)
  })
})
