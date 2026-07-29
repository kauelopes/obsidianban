import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { EpicService } from '../../src/services/epic.js'
import { AuditLogger } from '../../src/audit/logger.js'
import { SSEEventBus } from '../../src/server/sse.js'
import { loadProjectMeta, saveProjectMeta } from '../../src/vault/layout.js'
import { createTempVault, cleanupVault, setupTestProject } from '../helpers/vault.js'
import { makeManagerClaims, makeAgentClaims, makeDevClaims, makeSprint } from '../helpers/factories.js'
import type { Paths } from '../../src/config.js'
import type { SSEEvent } from '@obsidiankan/types'

let paths: Paths
let sse: SSEEventBus
let epics: EpicService
let events: SSEEvent[]

beforeEach(async () => {
  paths = await createTempVault()
  sse = new SSEEventBus()
  events = []
  const origEmit = sse.emit.bind(sse)
  sse.emit = (e) => {
    events.push(e)
    origEmit(e)
  }
  epics = new EpicService(paths, new AuditLogger(paths.auditLog), sse)
  await setupTestProject(paths, 'test-project', makeSprint())
})

afterEach(async () => {
  await cleanupVault(paths)
})

const mgr = makeManagerClaims()

describe('kanban_create_epic', () => {
  it('cria com status open, persiste no _meta.json e emite PROJECT_EPICS_UPDATED', async () => {
    const { epic } = await epics.createEpic(
      { project: 'test-project', name: 'Autenticação', objective: 'Login completo' },
      mgr,
    )
    expect(epic.id).toMatch(/^epic-/)
    expect(epic.status).toBe('open')
    expect(epic.sprint_ids).toEqual([])

    const meta = await loadProjectMeta(paths, 'test-project')
    expect(meta.epics).toHaveLength(1)
    expect(events).toContainEqual({
      type: 'PROJECT_EPICS_UPDATED',
      payload: { project: 'test-project' },
    })
  })

  it('aceita sprint_ids existentes e recusa sprint desconhecida', async () => {
    const { epic } = await epics.createEpic(
      { project: 'test-project', name: 'E1', sprint_ids: ['sprint-test001'] },
      mgr,
    )
    expect(epic.sprint_ids).toEqual(['sprint-test001'])

    await expect(
      epics.createEpic({ project: 'test-project', name: 'E2', sprint_ids: ['sprint-nope'] }, mgr),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('um sprint pertence a no máximo um épico — 409 no segundo', async () => {
    await epics.createEpic(
      { project: 'test-project', name: 'E1', sprint_ids: ['sprint-test001'] },
      mgr,
    )
    await expect(
      epics.createEpic({ project: 'test-project', name: 'E2', sprint_ids: ['sprint-test001'] }, mgr),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('pm agent opera no próprio projeto sem passar project; dev é negado', async () => {
    const { project, epic } = await epics.createEpic({ name: 'Do PM' }, makeAgentClaims())
    expect(project).toBe('test-project')
    expect(epic.name).toBe('Do PM')
    await expect(epics.createEpic({ name: 'x' }, makeDevClaims())).rejects.toMatchObject({
      status: 403,
    })
  })

  it('grava EPIC_SET no audit log', async () => {
    await epics.createEpic({ project: 'test-project', name: 'E' }, mgr)
    const audit = await fs.readFile(paths.auditLog, 'utf8')
    expect(audit).toContain('"EPIC_SET"')
  })
})

describe('kanban_update_epic', () => {
  it('atualiza campos parcialmente — omitidos ficam como estavam', async () => {
    const { epic } = await epics.createEpic(
      { project: 'test-project', name: 'E1', objective: 'obj' },
      mgr,
    )
    const { epic: updated } = await epics.updateEpic(
      { project: 'test-project', id: epic.id, status: 'done' },
      mgr,
    )
    expect(updated.name).toBe('E1')
    expect(updated.objective).toBe('obj')
    expect(updated.status).toBe('done')
    expect(updated.created_at).toBe(epic.created_at)
  })

  it('objective: null limpa; sprint_ids é substituição total', async () => {
    const { epic } = await epics.createEpic(
      { project: 'test-project', name: 'E1', objective: 'obj', sprint_ids: ['sprint-test001'] },
      mgr,
    )
    const { epic: updated } = await epics.updateEpic(
      { project: 'test-project', id: epic.id, objective: null, sprint_ids: [] },
      mgr,
    )
    expect(updated.objective).toBeNull()
    expect(updated.sprint_ids).toEqual([])
  })

  it('re-atribuir o próprio sprint ao mesmo épico não conflita; a outro épico sim', async () => {
    const { epic: e1 } = await epics.createEpic(
      { project: 'test-project', name: 'E1', sprint_ids: ['sprint-test001'] },
      mgr,
    )
    const { epic: same } = await epics.updateEpic(
      { project: 'test-project', id: e1.id, sprint_ids: ['sprint-test001'] },
      mgr,
    )
    expect(same.sprint_ids).toEqual(['sprint-test001'])

    const { epic: e2 } = await epics.createEpic({ project: 'test-project', name: 'E2' }, mgr)
    await expect(
      epics.updateEpic(
        { project: 'test-project', id: e2.id, sprint_ids: ['sprint-test001'] },
        mgr,
      ),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('id inexistente é 404; status inválido é 400', async () => {
    await expect(
      epics.updateEpic({ project: 'test-project', id: 'epic-nope', status: 'done' }, mgr),
    ).rejects.toMatchObject({ status: 404 })
    const { epic } = await epics.createEpic({ project: 'test-project', name: 'E' }, mgr)
    await expect(
      epics.updateEpic({ project: 'test-project', id: epic.id, status: 'paused' }, mgr),
    ).rejects.toMatchObject({ status: 400 })
  })
})

describe('kanban_list_epics', () => {
  it('lista os épicos do projeto; projeto desconhecido é 404', async () => {
    await epics.createEpic({ project: 'test-project', name: 'E1' }, mgr)
    const { epics: listed } = await epics.listEpics({ project: 'test-project' }, mgr)
    expect(listed).toHaveLength(1)
    await expect(epics.listEpics({ project: 'nope' }, mgr)).rejects.toMatchObject({ status: 404 })
  })

  it('épico malformado no _meta.json some da listagem sem derrubar', async () => {
    const meta = await loadProjectMeta(paths, 'test-project')
    ;(meta as unknown as Record<string, unknown>)['epics'] = [
      { id: 'epic-ok', name: 'válido', status: 'open', created_at: '2026-01-01T00:00:00Z' },
      { id: 42, name: 'quebrado' },
    ]
    await saveProjectMeta(paths, 'test-project', meta)
    const { epics: listed } = await epics.listEpics({ project: 'test-project' }, mgr)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.objective).toBeNull()
    expect(listed[0]!.sprint_ids).toEqual([])
  })
})
