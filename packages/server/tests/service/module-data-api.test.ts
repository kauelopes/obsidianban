import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Paths } from '../../src/config.js'
import { createModuleDataApi } from '../../src/modules/data-api.js'
import { MetricsService } from '../../src/services/metrics.js'
import { FlowService } from '../../src/services/flow.js'
import { loadProjectMeta, saveProjectMeta } from '../../src/vault/layout.js'
import { createTestDb, createTestRepo } from '../helpers/db.js'
import { createTempVault, cleanupVault, setupTestProject } from '../helpers/vault.js'

let paths: Paths

async function audit(lines: object[]) {
  await fs.mkdir(path.dirname(paths.auditLog), { recursive: true })
  await fs.appendFile(paths.auditLog, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
}

function api() {
  const db = createTestDb()
  const metrics = new MetricsService(db)
  return createModuleDataApi({
    paths,
    repo: createTestRepo(db),
    metrics,
    flow: new FlowService(paths, metrics),
    digest: {} as never,
    supervision: { listStalledReviews: async () => [] },
  })
}

beforeEach(async () => {
  paths = await createTempVault()
})

afterEach(async () => {
  await cleanupVault(paths)
})

describe('ModuleDataApi', () => {
  it('listProjects esconde arquivados por padrão e devolve cópias', async () => {
    await setupTestProject(paths, 'alfa')
    await setupTestProject(paths, 'beta')
    const meta = await loadProjectMeta(paths, 'beta')
    await saveProjectMeta(paths, 'beta', { ...meta, archived: true })

    const data = api()
    expect((await data.listProjects()).map((p) => p.name)).toEqual(['alfa'])
    expect((await data.listProjects({ includeArchived: true })).map((p) => p.name).sort()).toEqual(['alfa', 'beta'])

    const alfa = (await data.getProject('alfa'))!
    alfa.columns.push('mexido')
    expect((await data.getProject('alfa'))!.columns).not.toContain('mexido')
    expect(await data.getProject('nao-existe')).toBeNull()
  })

  it('moves filtra por projeto e janela, com to_date inclusivo', async () => {
    await audit([
      { ts: '2026-07-01T10:00:00.000Z', op: 'MOVE', project: 'alfa', card_id: 'c1', from_status: 'todo', to_status: 'in_progress', actor: 'agent:dev' },
      { ts: '2026-07-03T23:59:00.000Z', op: 'MOVE', project: 'alfa', card_id: 'c1', from_status: 'in_progress', to_status: 'done' },
      { ts: '2026-07-04T00:00:00.000Z', op: 'MOVE', project: 'alfa', card_id: 'c2', from_status: 'todo', to_status: 'done' },
      { ts: '2026-07-02T00:00:00.000Z', op: 'MOVE', project: 'beta', card_id: 'c3', from_status: 'todo', to_status: 'done' },
      { ts: '2026-07-02T00:00:00.000Z', op: 'UPDATE', project: 'alfa', card_id: 'c1' },
    ])
    const { moves, truncated } = await api().moves({ project: 'alfa', from_date: '2026-07-01', to_date: '2026-07-03' })
    expect(truncated).toBe(false)
    expect(moves.map((m) => `${m.card_id}:${m.to_status}`)).toEqual(['c1:in_progress', 'c1:done'])
    expect(moves[0]!.actor).toBe('agent:dev')
    expect(moves[1]!.actor).toBeNull()
  })
})
