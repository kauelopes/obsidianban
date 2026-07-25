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
      { project: 'alfa', input_tokens: 130, output_tokens: 60, ops: 2 },
      { project: 'beta', input_tokens: 7, output_tokens: 3, ops: 1 },
    ])
  })

  it('respeita a janela de datas como as demais agregações', () => {
    const db = createTestDb()
    seed(db)
    const m = new MetricsService(db).collect({ from_date: '2026-07-02', to_date: '2026-07-03' })
    expect(m.by_project).toEqual([
      { project: 'alfa', input_tokens: 30, output_tokens: 10, ops: 1 },
      { project: 'beta', input_tokens: 7, output_tokens: 3, ops: 1 },
    ])
  })

  it('sem linhas, devolve lista vazia — não undefined', () => {
    const db = createTestDb()
    const m = new MetricsService(db).collect({})
    expect(m.by_project).toEqual([])
  })
})
