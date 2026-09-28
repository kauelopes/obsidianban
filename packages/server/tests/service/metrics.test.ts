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

/**
 * by_role é o que responde "quanto cada tipo de agente (wizard/pm/dev) gastou"
 * sem precisar decifrar `actor` — ver roleFromClaims em cards/repository.ts.
 */
describe('MetricsService by_role', () => {
  it('agrega por role e cai em "desconhecido" para linhas sem a coluna (pré-migração)', () => {
    const db = createTestDb()
    const ins = db.prepare(
      `INSERT INTO token_log (ts, op, card_id, card_type, actor, model, input_tokens, output_tokens, project, role)
       VALUES (@ts, @op, @card_id, @card_type, @actor, @model, @input_tokens, @output_tokens, @project, @role)`,
    )
    ins.run({ ts: '2026-07-01T10:00:00Z', op: 'CREATE', card_id: 'card-x', card_type: 'task', actor: 'agent:pm-1', model: 'claude-opus-4-8', input_tokens: 100, output_tokens: 50, project: 'alfa', role: 'pm' })
    ins.run({ ts: '2026-07-02T10:00:00Z', op: 'WORKFLOW_DEV', card_id: '', card_type: 'workflow_round', actor: 'workflow:dev', model: 'claude-sonnet-5', input_tokens: 30, output_tokens: 10, project: 'alfa', role: 'dev' })
    ins.run({ ts: '2026-07-03T10:00:00Z', op: 'PLANNING', card_id: 'sess-1', card_type: 'planning', actor: 'kaue', model: 'claude-opus-4-8', input_tokens: 7, output_tokens: 3, project: 'beta', role: 'wizard' })
    // Linha legada, gravada antes da coluna `role` existir — não passa `role`.
    ins.run({ ts: '2026-07-04T10:00:00Z', op: 'UPDATE', card_id: 'card-y', card_type: 'task', actor: 'agent:dev-1', model: 'claude-sonnet-5', input_tokens: 5, output_tokens: 2, project: 'alfa', role: null })

    const m = new MetricsService(db).collect({})
    expect(m.by_role).toEqual([
      { role: 'desconhecido', input_tokens: 5, output_tokens: 2, cost_usd: 0, ops: 1 },
      { role: 'dev', input_tokens: 30, output_tokens: 10, cost_usd: 0, ops: 1 },
      { role: 'pm', input_tokens: 100, output_tokens: 50, cost_usd: 0, ops: 1 },
      { role: 'wizard', input_tokens: 7, output_tokens: 3, cost_usd: 0, ops: 1 },
    ])
  })

  it('sem linhas, devolve lista vazia', () => {
    const db = createTestDb()
    const m = new MetricsService(db).collect({})
    expect(m.by_role).toEqual([])
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
 * card_id fecha a lacuna documentada em cards.total_* (que só soma
 * input/output): com este filtro dá pra somar TUDO — cache e custo inclusos —
 * que já foi cobrado a um card específico, direto do token_log.
 */
describe('MetricsService filtro por card_id', () => {
  it('soma apenas as linhas do card pedido, ignorando outros cards e datas fora da janela', () => {
    const db = createTestDb()
    const ins = db.prepare(
      `INSERT INTO token_log (ts, op, card_id, card_type, actor, model, input_tokens, output_tokens, project,
                              cache_read_tokens, cache_creation_tokens, cost_usd)
       VALUES (@ts, @op, @card_id, @card_type, @actor, @model, @input_tokens, @output_tokens, @project,
               @cache_read_tokens, @cache_creation_tokens, @cost_usd)`,
    )
    ins.run({ ts: '2026-07-01T10:00:00Z', op: 'CREATE', card_id: 'card-a', card_type: 'task', actor: 'agent:dev-1', model: 'claude-sonnet-5', project: 'alfa', input_tokens: 10, output_tokens: 5, cache_read_tokens: 1000, cache_creation_tokens: 100, cost_usd: 0.05 })
    ins.run({ ts: '2026-07-02T10:00:00Z', op: 'UPDATE', card_id: 'card-a', card_type: 'task', actor: 'agent:dev-1', model: 'claude-sonnet-5', project: 'alfa', input_tokens: 200, output_tokens: 50, cache_read_tokens: 2000, cache_creation_tokens: 0, cost_usd: 0.1 })
    ins.run({ ts: '2026-07-02T11:00:00Z', op: 'UPDATE', card_id: 'card-b', card_type: 'task', actor: 'agent:dev-1', model: 'claude-sonnet-5', project: 'alfa', input_tokens: 999, output_tokens: 999, cache_read_tokens: 999, cache_creation_tokens: 999, cost_usd: 9 })

    const m = new MetricsService(db).collect({ card_id: 'card-a' })
    expect(m.summary.total_input_tokens).toBe(210)
    expect(m.summary.total_output_tokens).toBe(55)
    expect(m.summary.total_cache_read_tokens).toBe(3000)
    expect(m.summary.total_cache_creation_tokens).toBe(100)
    expect(m.summary.total_cost_usd).toBeCloseTo(0.15, 6)
    expect(m.summary.total_ops).toBe(2)
  })

  it('combina com from_date/to_date', () => {
    const db = createTestDb()
    const ins = db.prepare(
      `INSERT INTO token_log (ts, op, card_id, card_type, actor, model, input_tokens, output_tokens, project)
       VALUES (@ts, @op, @card_id, @card_type, @actor, @model, @input_tokens, @output_tokens, @project)`,
    )
    ins.run({ ts: '2026-07-01T10:00:00Z', op: 'CREATE', card_id: 'card-a', card_type: 'task', actor: 'agent:dev-1', model: 'test', project: 'alfa', input_tokens: 10, output_tokens: 0 })
    ins.run({ ts: '2026-07-05T10:00:00Z', op: 'UPDATE', card_id: 'card-a', card_type: 'task', actor: 'agent:dev-1', model: 'test', project: 'alfa', input_tokens: 20, output_tokens: 0 })

    const m = new MetricsService(db).collect({ card_id: 'card-a', from_date: '2026-07-01', to_date: '2026-07-01' })
    expect(m.summary.total_input_tokens).toBe(10)
    expect(m.summary.total_ops).toBe(1)
  })

  it('zera os blocos de terminal — uso de terminal não pertence a card nenhum', () => {
    const db = createTestDb()
    db.prepare(
      `INSERT INTO token_log (ts, op, card_id, card_type, actor, model, input_tokens, output_tokens, project)
       VALUES ('2026-07-01T10:00:00Z', 'CREATE', 'card-a', 'task', 'agent:dev-1', 'test', 10, 0, 'alfa')`,
    ).run()
    db.prepare(
      `INSERT INTO terminal_usage
         (session_id, project, ts, model, input_tokens, output_tokens,
          cache_read_tokens, cache_creation_tokens, cache_5m_tokens, cache_1h_tokens,
          cost_usd, cwd, git_branch, source_file)
       VALUES ('sess-1', 'alfa', '2026-07-01T09:00:00.000Z', 'claude-sonnet-5', 40, 20, 1000, 100, 100, 0, 0.25, '/repo', 'main', 'proj/sess-1.jsonl')`,
    ).run()

    const m = new MetricsService(db).collect({ card_id: 'card-a' })
    expect(m.terminal.total_ops).toBe(0)
    expect(m.terminal.total_cost_usd).toBe(0)
    expect(m.terminal_by_model).toEqual([])
    expect(m.terminal_by_day).toEqual([])
    expect(m.by_origin.find((o) => o.origin === 'terminal')?.input_tokens).toBe(0)
  })
})

/**
 * Camada "nenhum token se perde": linhas WORKFLOW_* (registro por round, sem
 * card) carregam cache e custo medido, e o summary os agrega. cost_usd é o
 * número autoritativo — as linhas antigas ficam em 0, nunca somem.
 */
/**
 * `terminal` e `by_origin` vêm de `terminal_usage` (ingestão do
 * TerminalUsageService, Fase 1) — tabela separada de token_log, mas mesma
 * janela de datas e mesma postura read-only.
 */
describe('MetricsService terminal/by_origin', () => {
  it('agrega terminal_usage separado do board e soma os dois em by_origin', () => {
    const db = createTestDb()
    seed(db) // board: 137 input / 63 output / cost 0 / 3 ops (dentro da janela usada abaixo)
    db.prepare(
      `INSERT INTO terminal_usage
         (session_id, project, ts, model, input_tokens, output_tokens,
          cache_read_tokens, cache_creation_tokens, cache_5m_tokens, cache_1h_tokens,
          cost_usd, cwd, git_branch, source_file)
       VALUES ('sess-1', 'alfa', '2026-07-01T09:00:00.000Z', 'claude-sonnet-5', 40, 20, 1000, 100, 100, 0, 0.25, '/repo', 'main', 'proj/sess-1.jsonl')`,
    ).run()

    const m = new MetricsService(db).collect({})
    expect(m.terminal).toEqual({
      total_input_tokens: 40,
      total_output_tokens: 20,
      total_cache_read_tokens: 1000,
      total_cache_creation_tokens: 100,
      total_cost_usd: 0.25,
      total_ops: 1,
    })
    expect(m.by_origin).toEqual([
      { origin: 'board', input_tokens: 137, output_tokens: 63, cost_usd: 0, ops: 3 },
      { origin: 'terminal', input_tokens: 40, output_tokens: 20, cost_usd: 0.25, ops: 1 },
    ])
  })

  it('respeita a janela de datas igual às demais agregações', () => {
    const db = createTestDb()
    db.prepare(
      `INSERT INTO terminal_usage (session_id, project, ts, model, input_tokens, output_tokens, cost_usd, source_file)
       VALUES ('sess-1', 'alfa', '2026-07-01T09:00:00.000Z', 'claude-sonnet-5', 40, 20, 0.25, 'proj/sess-1.jsonl')`,
    ).run()
    db.prepare(
      `INSERT INTO terminal_usage (session_id, project, ts, model, input_tokens, output_tokens, cost_usd, source_file)
       VALUES ('sess-1', 'alfa', '2026-07-10T09:00:00.000Z', 'claude-sonnet-5', 999, 999, 9, 'proj/sess-1.jsonl')`,
    ).run()

    const m = new MetricsService(db).collect({ from_date: '2026-07-01', to_date: '2026-07-01' })
    expect(m.terminal?.total_ops).toBe(1)
    expect(m.terminal?.total_input_tokens).toBe(40)
  })

  it('sem linhas em terminal_usage, devolve zeros — não undefined', () => {
    const db = createTestDb()
    const m = new MetricsService(db).collect({})
    expect(m.terminal).toEqual({
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_creation_tokens: 0,
      total_cost_usd: 0,
      total_ops: 0,
    })
    expect(m.by_origin).toEqual([
      { origin: 'board', input_tokens: 0, output_tokens: 0, cost_usd: 0, ops: 0 },
      { origin: 'terminal', input_tokens: 0, output_tokens: 0, cost_usd: 0, ops: 0 },
    ])
  })
})

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
