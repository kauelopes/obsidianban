import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AuditEntry } from '@obsidiankan/types'
import type { Paths } from '../../src/config.js'
import { FlowService, percentiles } from '../../src/services/flow.js'
import { MetricsService } from '../../src/services/metrics.js'
import { createTestDb } from '../helpers/db.js'
import { createTempVault, cleanupVault, setupTestProject } from '../helpers/vault.js'

let paths: Paths
let db: ReturnType<typeof createTestDb>
let service: FlowService

/** Segunda 2026-07-06 — semana-base dos casos. */
const MON = '2026-07-06'

function at(day: string, hour: number): string {
  return `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`
}

async function audit(entries: (Partial<AuditEntry> & { ts: string; op: string })[]) {
  await fs.mkdir(path.dirname(paths.auditLog), { recursive: true })
  await fs.appendFile(paths.auditLog, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
}

function move(card: string, from: string, to: string, ts: string, project = 'alfa') {
  return { ts, op: 'MOVE', project, card_id: card, from_status: from, to_status: to }
}

function logCost(ts: string, usd: number, project = 'alfa') {
  db.prepare(
    `INSERT INTO token_log (ts, op, card_id, card_type, actor, model, input_tokens, output_tokens, project, cost_usd)
     VALUES (@ts, 'MOVE', 'card-x', 'task', 'agent:dev', 'claude', 10, 10, @project, @usd)`,
  ).run({ ts, usd, project })
}

beforeEach(async () => {
  paths = await createTempVault()
  db = createTestDb()
  await setupTestProject(paths, 'alfa')
  service = new FlowService(paths, new MetricsService(db))
})

afterEach(async () => {
  await cleanupVault(paths)
})

describe('percentiles', () => {
  it('sem amostra devolve zeros e count 0 — não finge medição', () => {
    expect(percentiles([])).toEqual({ count: 0, p50: 0, p90: 0, max: 0 })
  })

  it('p50/p90/max sobre uma série conhecida', () => {
    const p = percentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(p.count).toBe(10)
    expect(p.p50).toBe(5)
    expect(p.p90).toBe(9)
    expect(p.max).toBe(10)
  })

  it('amostra única é os três percentis', () => {
    expect(percentiles([4.2])).toEqual({ count: 1, p50: 4.2, p90: 4.2, max: 4.2 })
  })
})

describe('FlowService — cycle time', () => {
  it('mede de in_progress até done', async () => {
    await audit([
      move('card-1', 'todo', 'in_progress', at(MON, 9)),
      move('card-1', 'in_progress', 'done', at(MON, 12)),
    ])
    const f = await service.collect()
    expect(f.cycle_time_hours).toMatchObject({ count: 1, p50: 3, max: 3 })
  })

  it('card que voltou e foi refeito conta dois ciclos', async () => {
    await audit([
      move('card-1', 'todo', 'in_progress', at(MON, 1)),
      move('card-1', 'in_progress', 'done', at(MON, 2)),
      move('card-1', 'done', 'todo', at(MON, 3)),
      move('card-1', 'todo', 'in_progress', at(MON, 4)),
      move('card-1', 'in_progress', 'done', at(MON, 9)),
    ])
    const f = await service.collect()
    expect(f.cycle_time_hours.count).toBe(2)
    expect(f.cycle_time_hours.max).toBe(5)
  })

  it('card que nunca chegou a done não entra na amostra', async () => {
    await audit([move('card-1', 'todo', 'in_progress', at(MON, 9))])
    const f = await service.collect()
    expect(f.cycle_time_hours.count).toBe(0)
  })
})

describe('FlowService — latência de decisão', () => {
  it('mede o tempo parado em review até sair', async () => {
    await audit([
      move('card-1', 'in_progress', 'review', at(MON, 8)),
      move('card-1', 'review', 'done', at(MON, 20)),
    ])
    const f = await service.collect()
    expect(f.decision_latency_hours).toMatchObject({ count: 1, p50: 12 })
  })

  it('card ainda parado em review não vira amostra — a espera não acabou', async () => {
    await audit([move('card-1', 'in_progress', 'review', at(MON, 8))])
    const f = await service.collect()
    expect(f.decision_latency_hours.count).toBe(0)
  })

  it('conta a volta para todo como fim da espera', async () => {
    await audit([
      move('card-1', 'in_progress', 'review', at(MON, 8)),
      move('card-1', 'review', 'todo', at(MON, 10)),
    ])
    const f = await service.collect()
    expect(f.decision_latency_hours).toMatchObject({ count: 1, p50: 2 })
  })
})

describe('FlowService — retrabalho', () => {
  it('separa avanço de volta e agrupa por transição', async () => {
    await audit([
      move('card-1', 'todo', 'in_progress', at(MON, 1)),
      move('card-1', 'in_progress', 'review', at(MON, 2)),
      move('card-1', 'review', 'todo', at(MON, 3)),
      move('card-2', 'review', 'todo', at(MON, 4)),
      move('card-3', 'in_progress', 'todo', at(MON, 5)),
    ])
    const f = await service.collect()
    expect(f.rework.forward).toBe(2)
    expect(f.rework.backward).toBe(3)
    expect(f.rework.rate).toBeCloseTo(0.6)
    expect(f.rework.by_transition[0]).toEqual({ from_status: 'review', to_status: 'todo', count: 2 })
  })

  it('status fora das colunas do projeto não vira retrabalho inventado', async () => {
    await audit([move('card-1', 'limbo', 'todo', at(MON, 1))])
    const f = await service.collect()
    expect(f.rework.forward).toBe(0)
    expect(f.rework.backward).toBe(0)
    expect(f.rework.rate).toBe(0)
  })

  it('respeita a ordem de colunas do projeto, não a padrão', async () => {
    // Projeto com 'review' ANTES de 'in_progress': a mesma transição que seria
    // volta no padrão aqui é avanço.
    const { loadProjectMeta, saveProjectMeta } = await import('../../src/vault/layout.js')
    const meta = await loadProjectMeta(paths, 'alfa')
    meta.columns = ['todo', 'review', 'in_progress', 'done']
    await saveProjectMeta(paths, 'alfa', meta)

    await audit([move('card-1', 'review', 'in_progress', at(MON, 1))])
    const f = await service.collect()
    expect(f.rework.forward).toBe(1)
    expect(f.rework.backward).toBe(0)
  })
})

describe('FlowService — série semanal', () => {
  it('conta entregas por semana e preenche semanas vazias no meio', async () => {
    await audit([
      move('card-1', 'review', 'done', at(MON, 10)),
      move('card-2', 'review', 'done', at(MON, 11)),
      // Três semanas depois — o buraco no meio precisa aparecer.
      move('card-3', 'review', 'done', at('2026-07-27', 10)),
    ])
    const f = await service.collect()
    expect(f.by_week.map((w) => [w.week_start, w.delivered])).toEqual([
      ['2026-07-06', 2],
      ['2026-07-13', 0],
      ['2026-07-20', 0],
      ['2026-07-27', 1],
    ])
  })

  it('custo por card vem do token_log, e é null quando não houve medição', async () => {
    await audit([
      move('card-1', 'review', 'done', at(MON, 10)),
      move('card-2', 'review', 'done', at(MON, 11)),
      move('card-3', 'review', 'done', at('2026-07-13', 10)),
    ])
    logCost(at('2026-07-13', 10), 4)

    const f = await service.collect()
    const [w1, w2] = f.by_week
    // Semana com entrega e sem medição: null, não zero.
    expect(w1).toMatchObject({ delivered: 2, cost_usd: 0, cost_per_card: null })
    expect(w2).toMatchObject({ delivered: 1, cost_usd: 4, cost_per_card: 4 })
    expect(f.cost_reporting_starts).toBe('2026-07-13')
  })

  it('sem custo em lugar nenhum, cost_reporting_starts é null', async () => {
    await audit([move('card-1', 'review', 'done', at(MON, 10))])
    const f = await service.collect()
    expect(f.cost_reporting_starts).toBeNull()
  })
})

describe('FlowService — janela e robustez', () => {
  it('from_date/to_date recortam a amostra, com to_date inclusivo', async () => {
    await audit([
      move('card-1', 'todo', 'in_progress', at('2026-07-01', 9)),
      move('card-1', 'in_progress', 'done', at('2026-07-01', 10)),
      move('card-2', 'todo', 'in_progress', at('2026-07-10', 9)),
      move('card-2', 'in_progress', 'done', at('2026-07-10', 10)),
    ])
    const f = await service.collect({ from_date: '2026-07-10', to_date: '2026-07-10' })
    expect(f.cycle_time_hours.count).toBe(1)
    expect(f.window_from?.slice(0, 10)).toBe('2026-07-10')
  })

  it('vault sem audit log devolve tudo zerado em vez de erro', async () => {
    const f = await service.collect()
    expect(f.cycle_time_hours.count).toBe(0)
    expect(f.by_week).toEqual([])
    expect(f.window_from).toBeNull()
    expect(f.audit_truncated).toBe(false)
  })

  it('linha corrompida não derruba a leitura', async () => {
    await fs.mkdir(path.dirname(paths.auditLog), { recursive: true })
    await fs.appendFile(paths.auditLog, '{ quebrado\n', 'utf8')
    await audit([
      move('card-1', 'todo', 'in_progress', at(MON, 9)),
      move('card-1', 'in_progress', 'done', at(MON, 10)),
    ])
    const f = await service.collect()
    expect(f.cycle_time_hours.count).toBe(1)
  })
})

describe('FlowService — filtro de projeto', () => {
  it('só conta os MOVEs e o custo do projeto pedido', async () => {
    await setupTestProject(paths, 'beta')
    await audit([
      move('card-a', 'todo', 'in_progress', at(MON, 9)),
      move('card-a', 'in_progress', 'done', at(MON, 11)),
      move('card-b', 'todo', 'in_progress', at(MON, 9), 'beta'),
      move('card-b', 'in_progress', 'done', at(MON, 19), 'beta'),
    ])
    logCost(at(MON, 10), 4)
    logCost(at(MON, 10), 100, 'beta')

    const alfa = await service.collect({ project: 'alfa' })
    expect(alfa.cycle_time_hours).toMatchObject({ count: 1, p50: 2 })
    expect(alfa.by_week).toEqual([{ week_start: MON, delivered: 1, cost_usd: 4, cost_per_card: 4 }])

    const all = await service.collect()
    expect(all.cycle_time_hours.count).toBe(2)
    expect(all.by_week[0]).toMatchObject({ delivered: 2, cost_usd: 104 })
  })
})
