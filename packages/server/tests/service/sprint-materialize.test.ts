import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { SprintPlanningService } from '../../src/services/sprint-planning.js'
import {
  SprintPlanningSessionStore,
  newSprintPlanningSession,
  type SprintPlanningContext,
} from '../../src/sprint-planning/session.js'
import { createSprintMaterializer } from '../../src/sprint-planning/materialize.js'
import { SprintService } from '../../src/services/sprint.js'
import { EpicService } from '../../src/services/epic.js'
import { CardService } from '../../src/services/card.js'
import { AtomicWriter } from '../../src/writer/atomic.js'
import { AuditLogger } from '../../src/audit/logger.js'
import { SSEEventBus } from '../../src/server/sse.js'
import { loadProjectMeta } from '../../src/vault/layout.js'
import { createTempVault, cleanupVault, setupTestProject } from '../helpers/vault.js'
import { createTestDb, createTestRepo } from '../helpers/db.js'
import { makeManagerClaims } from '../helpers/factories.js'
import type { Paths } from '../../src/config.js'
import type { TurnRunner } from '../../src/planning/claude-runner.js'

const mgr = makeManagerClaims()

const STRUCTURE = {
  name: 'Sprint nova',
  goal: 'entregar o essencial',
  tasks: [
    { title: 'Tarefa 1', type: 'task', body: '# Spec\nfazer', priority: 'high', tags: ['x'] },
    { title: 'Tarefa 2', type: 'feature' },
  ],
}

const inertRunner: TurnRunner = {
  runTurn: async () => {
    throw new Error('sem turnos neste teste')
  },
  cancel: () => {},
}

const EMPTY_CONTEXT: SprintPlanningContext = {
  project_epics: [],
  suggested_capacity: null,
  target_repo: null,
}

let paths: Paths
let store: SprintPlanningSessionStore
let sprints: SprintService
let epics: EpicService
let cards: CardService
let service: SprintPlanningService

async function readySession(project: string, epicId: string | null = null): Promise<string> {
  const s = newSprintPlanningSession(project, EMPTY_CONTEXT, 'review')
  s.status = 'awaiting_user'
  s.epic_id = epicId
  s.answers['review'] = { approved: true }
  s.outputs['tasks'] = { screen_payload: { markdown: 'plano' }, structure: STRUCTURE }
  await store.save(s)
  return s.session_id
}

beforeEach(async () => {
  paths = await createTempVault()
  store = new SprintPlanningSessionStore(paths)
  const db = createTestDb()
  const repo = createTestRepo(db)
  const audit = new AuditLogger(paths.auditLog)
  const sse = new SSEEventBus()
  const writer = new AtomicWriter(paths, repo)
  sprints = new SprintService(paths, repo, writer, audit, sse)
  epics = new EpicService(paths, audit, sse)
  cards = new CardService(paths, repo, writer, audit, sse)
  service = new SprintPlanningService(
    paths,
    store,
    inertRunner,
    repo,
    sse,
    'claude-test',
    sprints,
    epics,
    createSprintMaterializer({ sprints, cards, epics, modelLabel: 'claude-test', saveSession: (s) => store.save(s) }),
  )
  await setupTestProject(paths, 'proj')
})

afterEach(async () => {
  await cleanupVault(paths)
})

describe('kanban_sprint_planning_finalize', () => {
  it('materializa sprint (em planning) e as tarefas novas', async () => {
    const id = await readySession('proj')
    const r = await service.finalize({ session_id: id }, mgr)

    expect(r.project).toBe('proj')
    expect(r.epic_linked).toBe(false)
    expect(r.new_cards_created).toBe(2)
    expect(r.new_cards_failed).toEqual([])

    const meta = await loadProjectMeta(paths, 'proj')
    expect(meta.sprints).toHaveLength(1)
    expect(meta.sprints![0]!.status).toBe('planning')
    expect(meta.sprints![0]!.name).toBe('Sprint nova')

    const files = (await fs.readdir(path.join(paths.kanbanData, 'proj'))).filter((f) => f.endsWith('.md'))
    expect(files).toHaveLength(2)

    const session = await service.get({ session_id: id }, mgr)
    expect(session.status).toBe('done')
  })

  it('vincula ao épico escolhido acrescentando ao sprint_ids, sem apagar vínculos existentes', async () => {
    const outraSprint = await sprints.createSprint({ project: 'proj', name: 'Sprint velha' }, mgr)
    const { epic } = await epics.createEpic(
      { project: 'proj', name: 'Épico A', objective: 'x', sprint_ids: [outraSprint.id] },
      mgr,
    )
    const id = await readySession('proj', epic.id)
    const r = await service.finalize({ session_id: id }, mgr)
    expect(r.epic_linked).toBe(true)

    const { epics: list } = await epics.listEpics({ project: 'proj' }, mgr)
    const updated = list.find((e) => e.id === epic.id)!
    expect(updated.sprint_ids).toContain(outraSprint.id)
    expect(updated.sprint_ids).toContain(r.sprint_id)
    expect(updated.sprint_ids).toHaveLength(2)
  })

  it('falha no meio → error com checkpoint; re-chamar retoma sem duplicar', async () => {
    const id = await readySession('proj')
    const orig = sprints.createSprint.bind(sprints)
    let calls = 0
    vi.spyOn(sprints, 'createSprint').mockImplementation(async (p, c) => {
      calls++
      if (calls === 1) throw new Error('disco cheio')
      return orig(p, c)
    })

    await expect(service.finalize({ session_id: id }, mgr)).rejects.toThrow('disco cheio')
    let session = await service.get({ session_id: id }, mgr)
    expect(session.status).toBe('error')
    expect(session.materialization?.sprint_created).toBeUndefined()

    const r = await service.finalize({ session_id: id }, mgr)
    expect(r.new_cards_created).toBe(2)
    const meta = await loadProjectMeta(paths, 'proj')
    expect(meta.sprints).toHaveLength(1)
    session = await service.get({ session_id: id }, mgr)
    expect(session.status).toBe('done')
  })

  it('estrutura inválida é 400, sem efeito', async () => {
    const s = newSprintPlanningSession('proj', EMPTY_CONTEXT, 'review')
    s.status = 'awaiting_user'
    s.answers['review'] = { approved: true }
    s.outputs['tasks'] = { screen_payload: {}, structure: { name: 'x' } }
    await store.save(s)
    await expect(service.finalize({ session_id: s.session_id }, mgr)).rejects.toMatchObject({
      status: 400,
    })
  })

  it('sessão sem structure é 409', async () => {
    const s = newSprintPlanningSession('proj', EMPTY_CONTEXT, 'capacity')
    await store.save(s)
    await expect(service.finalize({ session_id: s.session_id }, mgr)).rejects.toMatchObject({
      status: 409,
    })
  })
})
