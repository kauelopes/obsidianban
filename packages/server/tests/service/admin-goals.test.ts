import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { AdminService } from '../../src/services/admin.js'
import { AuditLogger } from '../../src/audit/logger.js'
import { SSEEventBus } from '../../src/server/sse.js'
import { loadProjectMeta, metaPath, saveProjectMeta } from '../../src/vault/layout.js'
import { createTempVault, cleanupVault, setupTestProject } from '../helpers/vault.js'
import { createTestDb, createTestRepo } from '../helpers/db.js'
import { makeManagerClaims, makeAgentClaims, makeDevClaims } from '../helpers/factories.js'
import type { Paths } from '../../src/config.js'

let paths: Paths
let admin: AdminService

beforeEach(async () => {
  paths = await createTempVault()
  admin = new AdminService(
    paths,
    createTestRepo(createTestDb()),
    new AuditLogger(paths.auditLog),
    new SSEEventBus(),
  )
  await setupTestProject(paths, 'test-project')
})

afterEach(async () => {
  await cleanupVault(paths)
})

const mgr = makeManagerClaims()

describe('kanban_set_goal', () => {
  it('cria sem id, persiste no _meta.json e aparece em list_projects', async () => {
    const { goal } = await admin.setGoal(
      { project: 'test-project', title: 'Lançar v1', target_date: '2026-09-30' },
      mgr,
    )
    expect(goal.id).toMatch(/^goal-/)
    expect(goal.status).toBe('open')

    const meta = await loadProjectMeta(paths, 'test-project')
    expect(meta.goals).toHaveLength(1)

    const { projects } = await admin.listProjects({}, mgr)
    expect(projects[0]!.goals?.[0]?.title).toBe('Lançar v1')
  })

  it('com id faz upsert parcial — campos omitidos ficam como estavam', async () => {
    const { goal } = await admin.setGoal(
      { project: 'test-project', title: 'Meta', target_date: '2026-09-30' },
      mgr,
    )
    const { goal: updated } = await admin.setGoal(
      { project: 'test-project', id: goal.id, status: 'done' },
      mgr,
    )
    expect(updated.title).toBe('Meta')
    expect(updated.target_date).toBe('2026-09-30')
    expect(updated.status).toBe('done')
    expect(updated.created_at).toBe(goal.created_at)
  })

  it('id inexistente é 404, não criação silenciosa', async () => {
    await expect(
      admin.setGoal({ project: 'test-project', id: 'goal-nope', status: 'done' }, mgr),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('pm agent opera no próprio projeto sem passar project; dev é negado', async () => {
    const { goal } = await admin.setGoal({ title: 'Meta do PM' }, makeAgentClaims())
    expect(goal.title).toBe('Meta do PM')
    await expect(admin.setGoal({ title: 'x' }, makeDevClaims())).rejects.toMatchObject({
      status: 403,
    })
  })

  it('valida target_date e status', async () => {
    await expect(
      admin.setGoal({ project: 'test-project', title: 'x', target_date: 'amanhã' }, mgr),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      admin.setGoal({ project: 'test-project', title: 'x', status: 'paused' }, mgr),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('grava GOAL_SET no audit log', async () => {
    await admin.setGoal({ project: 'test-project', title: 'Meta' }, mgr)
    const audit = await fs.readFile(paths.auditLog, 'utf8')
    expect(audit).toContain('"GOAL_SET"')
  })
})

describe('kanban_delete_goal', () => {
  it('remove por id; id desconhecido é 404', async () => {
    const { goal } = await admin.setGoal({ project: 'test-project', title: 'Meta' }, mgr)
    const res = await admin.deleteGoal({ project: 'test-project', id: goal.id }, mgr)
    expect(res.goal_id).toBe(goal.id)
    const meta = await loadProjectMeta(paths, 'test-project')
    expect(meta.goals).toEqual([])
    await expect(
      admin.deleteGoal({ project: 'test-project', id: goal.id }, mgr),
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe('goals malformados no _meta.json', () => {
  it('não derrubam o listProjects — somem da listagem, ficam no arquivo', async () => {
    const meta = await loadProjectMeta(paths, 'test-project')
    // Simula edição à mão no Obsidian: uma meta válida sem target_date, uma quebrada.
    ;(meta as unknown as Record<string, unknown>)['goals'] = [
      { id: 'goal-ok', title: 'válida', status: 'open', created_at: '2026-01-01T00:00:00Z' },
      { id: 42, title: 'quebrada' },
    ]
    await saveProjectMeta(paths, 'test-project', meta)
    expect(await fs.readFile(metaPath(paths, 'test-project'), 'utf8')).toContain('quebrada')

    const { projects } = await admin.listProjects({}, mgr)
    expect(projects[0]!.goals).toHaveLength(1)
    expect(projects[0]!.goals![0]!.target_date).toBeNull()
  })
})
