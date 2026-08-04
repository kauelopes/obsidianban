import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AuditEntry, Goal, Sprint } from '@obsidiankan/types'
import type { Paths } from '../../src/config.js'
import { DigestService, mondayOf } from '../../src/services/digest.js'
import { MetricsService } from '../../src/services/metrics.js'
import { ActivityService } from '../../src/services/activity.js'
import { GitActivityService } from '../../src/services/git-activity.js'
import { SupervisionService } from '../../src/services/supervision.js'
import { loadProjectMeta, saveProjectMeta } from '../../src/vault/layout.js'
import { createTestDb, createTestRepo } from '../helpers/db.js'
import { createTempVault, cleanupVault, setupTestProject, writeCardFile } from '../helpers/vault.js'
import { makeCard, makeSprint } from '../helpers/factories.js'
import { serializeCard } from '../../src/cards/serialize.js'
import type { AuditLogger } from '../../src/audit/logger.js'
import { reconcile } from '../../src/startup/reconcile.js'
import { STALE_REVIEW_DAYS } from '../../src/util/constants.js'

// Semana fixa (segunda 2026-07-06 a domingo 2026-07-12) para as seções que
// vêm do audit/_meta.json; o que depende de "agora" usa datas relativas.
const WEEK = '2026-07-06'
const IN_WEEK = '2026-07-08T12:00:00.000Z'
const BEFORE = '2026-07-05T23:00:00.000Z'
const AFTER = '2026-07-13T01:00:00.000Z'

let paths: Paths
let db: ReturnType<typeof createTestDb>
let repo: ReturnType<typeof createTestRepo>
let service: DigestService
const audit = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogger

function build(): DigestService {
  return new DigestService(
    paths,
    repo,
    new MetricsService(db),
    new ActivityService(db, paths, new GitActivityService()),
    new SupervisionService(paths, repo),
  )
}

/** Indexa os .md escritos no vault — o digest lê título/status do SQLite. */
async function index(): Promise<void> {
  await reconcile(paths, repo, audit, { sqliteRebuilt: false })
}

async function appendAudit(entries: (Partial<AuditEntry> & { ts: string; op: string })[]) {
  await fs.mkdir(path.dirname(paths.auditLog), { recursive: true })
  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await fs.appendFile(paths.auditLog, lines, 'utf8')
}

async function setGoals(project: string, goals: Goal[]) {
  const meta = await loadProjectMeta(paths, project)
  meta.goals = goals
  await saveProjectMeta(paths, project, meta)
}

async function setSprints(project: string, sprints: Sprint[]) {
  const meta = await loadProjectMeta(paths, project)
  meta.sprints = sprints
  await saveProjectMeta(paths, project, meta)
}

function goal(over: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-1',
    title: 'Meta',
    target_date: null,
    status: 'open',
    created_at: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

beforeEach(async () => {
  paths = await createTempVault()
  db = createTestDb()
  repo = createTestRepo(db)
  await setupTestProject(paths, 'alfa')
  service = build()
  vi.clearAllMocks()
})

afterEach(async () => {
  await cleanupVault(paths)
})

describe('mondayOf', () => {
  it('normaliza qualquer dia para a segunda da sua semana', () => {
    expect(mondayOf('2026-07-06')).toBe('2026-07-06') // segunda
    expect(mondayOf('2026-07-08')).toBe('2026-07-06') // quarta
    expect(mondayOf('2026-07-12')).toBe('2026-07-06') // domingo fecha a semana
    expect(mondayOf('2026-07-13')).toBe('2026-07-13') // segunda seguinte
  })
})

describe('DigestService.collect — janela', () => {
  it('normaliza week_start e devolve segunda a domingo', async () => {
    const d = await service.collect({ weekStart: '2026-07-09' })
    expect(d.week_start).toBe('2026-07-06')
    expect(d.week_end).toBe('2026-07-12')
  })

  it('vault sem audit log não quebra — semana vazia', async () => {
    const d = await service.collect({ weekStart: WEEK })
    expect(d.cards_done).toEqual([])
    expect(d.goals_done).toEqual([])
    expect(d.audit_truncated).toBe(false)
  })
})

describe('DigestService.collect — sprints fechadas', () => {
  it('inclui só as fechadas dentro da janela', async () => {
    await setSprints('alfa', [
      makeSprint({ id: 'sprint-a', name: 'Dentro', status: 'closed', ended_at: IN_WEEK }),
      makeSprint({ id: 'sprint-b', name: 'Antes', status: 'closed', ended_at: BEFORE }),
      makeSprint({ id: 'sprint-c', name: 'Depois', status: 'closed', ended_at: AFTER }),
      makeSprint({ id: 'sprint-d', name: 'Aberta', status: 'active', ended_at: null }),
    ])
    const d = await service.collect({ weekStart: WEEK })
    expect(d.sprints_closed.map((s) => s.name)).toEqual(['Dentro'])
    expect(d.sprints_closed[0]!.project).toBe('alfa')
  })
})

describe('DigestService.collect — cards concluídos', () => {
  it('conta MOVE→done na janela, ignora fora e outros status', async () => {
    await appendAudit([
      { ts: IN_WEEK, op: 'MOVE', project: 'alfa', card_id: 'card-1', to_status: 'done' },
      { ts: BEFORE, op: 'MOVE', project: 'alfa', card_id: 'card-2', to_status: 'done' },
      { ts: AFTER, op: 'MOVE', project: 'alfa', card_id: 'card-3', to_status: 'done' },
      { ts: IN_WEEK, op: 'MOVE', project: 'alfa', card_id: 'card-4', to_status: 'review' },
      { ts: IN_WEEK, op: 'UPDATE', project: 'alfa', card_id: 'card-5' },
    ])
    const d = await service.collect({ weekStart: WEEK })
    expect(d.cards_done.map((c) => c.card_id)).toEqual(['card-1'])
  })

  it('card que não existe mais cai para o id como título', async () => {
    await appendAudit([
      { ts: IN_WEEK, op: 'MOVE', project: 'alfa', card_id: 'card-sumiu', to_status: 'done' },
    ])
    const d = await service.collect({ weekStart: WEEK })
    expect(d.cards_done[0]!.title).toBe('card-sumiu')
  })

  it('usa o título real quando o card ainda está indexado', async () => {
    const card = makeCard({ id: 'card-vivo', project: 'alfa', title: 'Entregar API', status: 'done', file_basename: 'card-vivo' })
    const { file_basename: _fb, ...rest } = card
    await writeCardFile(paths, 'alfa', 'card-vivo', serializeCard(rest as Parameters<typeof serializeCard>[0], ''))
    await index()

    await appendAudit([
      { ts: IN_WEEK, op: 'MOVE', project: 'alfa', card_id: 'card-vivo', to_status: 'done' },
    ])
    const d = await service.collect({ weekStart: WEEK })
    expect(d.cards_done[0]!.title).toBe('Entregar API')
  })

  it('linha corrompida não derruba o resto da semana', async () => {
    await fs.mkdir(path.dirname(paths.auditLog), { recursive: true })
    await fs.appendFile(paths.auditLog, '{ nao é json\n', 'utf8')
    await appendAudit([
      { ts: IN_WEEK, op: 'MOVE', project: 'alfa', card_id: 'card-1', to_status: 'done' },
    ])
    const d = await service.collect({ weekStart: WEEK })
    expect(d.cards_done).toHaveLength(1)
  })
})

describe('DigestService.collect — metas', () => {
  it('meta fechada na janela aparece com o título do _meta.json', async () => {
    await setGoals('alfa', [goal({ id: 'goal-x', title: 'Publicar beta', status: 'done' })])
    await appendAudit([{ ts: IN_WEEK, op: 'GOAL_SET', project: 'alfa', reason: 'goal-x done' }])
    const d = await service.collect({ weekStart: WEEK })
    expect(d.goals_done).toHaveLength(1)
    expect(d.goals_done[0]!.title).toBe('Publicar beta')
  })

  it('fechar, reabrir e fechar de novo na mesma semana conta uma vez, pela última', async () => {
    await setGoals('alfa', [goal({ id: 'goal-x', title: 'Vai e volta', status: 'done' })])
    await appendAudit([
      { ts: '2026-07-07T10:00:00.000Z', op: 'GOAL_SET', project: 'alfa', reason: 'goal-x done' },
      { ts: '2026-07-08T10:00:00.000Z', op: 'GOAL_SET', project: 'alfa', reason: 'goal-x open' },
      { ts: '2026-07-09T10:00:00.000Z', op: 'GOAL_SET', project: 'alfa', reason: 'goal-x done' },
    ])
    const d = await service.collect({ weekStart: WEEK })
    expect(d.goals_done).toHaveLength(1)
    expect(d.goals_done[0]!.ts).toBe('2026-07-09T10:00:00.000Z')
  })

  it('GOAL_SET que não é conclusão não entra', async () => {
    await appendAudit([{ ts: IN_WEEK, op: 'GOAL_SET', project: 'alfa', reason: 'goal-x open' }])
    const d = await service.collect({ weekStart: WEEK })
    expect(d.goals_done).toEqual([])
  })

  it('lista metas que vencem na semana seguinte, não as desta nem as distantes', async () => {
    await setGoals('alfa', [
      goal({ id: 'g-prox', title: 'Semana que vem', target_date: '2026-07-15' }),
      goal({ id: 'g-esta', title: 'Esta semana', target_date: '2026-07-09' }),
      goal({ id: 'g-longe', title: 'Mês que vem', target_date: '2026-08-20' }),
      goal({ id: 'g-feita', title: 'Fechada', target_date: '2026-07-15', status: 'done' }),
    ])
    const d = await service.collect({ weekStart: WEEK })
    expect(d.goals_upcoming.map((g) => g.goal_id)).toEqual(['g-prox'])
  })
})

describe('DigestService.collect — escalações paradas', () => {
  it('só entra o que passou do limiar de dias em review', async () => {
    const old = new Date(Date.now() - (STALE_REVIEW_DAYS + 2) * 86_400_000).toISOString()
    const recent = new Date(Date.now() - 3600_000).toISOString()
    for (const [id, ts] of [
      ['card-parado', old],
      ['card-fresco', recent],
    ] as const) {
      const card = makeCard({ id, project: 'alfa', title: id, status: 'review', updated_at: ts, file_basename: id })
      const { file_basename: _fb, ...rest } = card
      await writeCardFile(paths, 'alfa', id, serializeCard(rest as Parameters<typeof serializeCard>[0], ''))
    }
    await index()

    const d = await service.collect({ weekStart: WEEK })
    expect(d.stalled_reviews.map((s) => s.card_id)).toEqual(['card-parado'])
    expect(d.stalled_reviews[0]!.days_stalled).toBeGreaterThanOrEqual(STALE_REVIEW_DAYS)
  })
})

describe('DigestService.collect — atividade', () => {
  it('semana passada não finge estimativa de horas', async () => {
    const d = await service.collect({ weekStart: WEEK })
    expect(d.hours_estimate_available).toBe(false)
    expect(d.hours_estimate).toBe(0)
  })

  it('semana corrente traz a estimativa', async () => {
    const thisWeek = mondayOf(new Date().toISOString().slice(0, 10))
    const d = await service.collect({ weekStart: thisWeek })
    expect(d.hours_estimate_available).toBe(true)
  })

  it('recorta o custo da janela a partir do token_log', async () => {
    db.prepare(
      `INSERT INTO token_log (ts, op, card_id, card_type, actor, model, input_tokens, output_tokens, project, cost_usd)
       VALUES (@ts, 'MOVE', 'card-1', 'task', 'agent:dev', 'claude', 100, 50, 'alfa', 0.5)`,
    ).run({ ts: IN_WEEK })
    db.prepare(
      `INSERT INTO token_log (ts, op, card_id, card_type, actor, model, input_tokens, output_tokens, project, cost_usd)
       VALUES (@ts, 'MOVE', 'card-2', 'task', 'agent:dev', 'claude', 999, 999, 'alfa', 9.9)`,
    ).run({ ts: AFTER })

    const d = await service.collect({ weekStart: WEEK })
    expect(d.activity.summary.total_input_tokens).toBe(100)
    expect(d.activity.summary.total_cost_usd).toBeCloseTo(0.5)
    expect(d.activity.by_project.map((p) => p.project)).toEqual(['alfa'])
  })
})
