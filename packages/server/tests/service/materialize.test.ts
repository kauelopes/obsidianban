import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PlanningService } from '../../src/services/planning.js'
import { PlanningSessionStore, newPlanningSession } from '../../src/planning/session.js'
import { createMaterializer } from '../../src/planning/materialize.js'
import { AdminService } from '../../src/services/admin.js'
import { EpicService } from '../../src/services/epic.js'
import { SprintService } from '../../src/services/sprint.js'
import { CardService } from '../../src/services/card.js'
import { AtomicWriter } from '../../src/writer/atomic.js'
import { AuditLogger } from '../../src/audit/logger.js'
import { SSEEventBus } from '../../src/server/sse.js'
import { isCardFile } from '../../src/watcher/file-watcher.js'
import { loadProjectMeta } from '../../src/vault/layout.js'
import { createTempVault, cleanupVault } from '../helpers/vault.js'
import { createTestDb, createTestRepo } from '../helpers/db.js'
import { makeManagerClaims } from '../helpers/factories.js'
import type { TurnRunner } from '../../src/planning/claude-runner.js'
import type { Paths } from '../../src/config.js'

const mgr = makeManagerClaims()

const STRUCTURE = {
  project: { name: 'novo-projeto' },
  goals: [{ title: 'MVP no ar', target_date: '2026-10-01' }],
  epics: [
    {
      name: 'Fundação Técnica',
      objective: 'Base do sistema',
      sprints: [
        {
          name: 'Sprint 1',
          goal: 'Esqueleto',
          tasks: [
            { title: 'Setup do repo', type: 'chore', body: '# Spec\ninit', priority: 'high' },
            { title: 'CI básica', type: 'task' },
          ],
        },
        { name: 'Sprint 2', goal: 'API', tasks: [{ title: 'Endpoint /health', type: 'feature' }] },
      ],
    },
    {
      name: 'Produto',
      objective: 'Valor ao usuário',
      sprints: [{ name: 'Sprint 3', goal: 'UI', tasks: [{ title: 'Tela inicial', type: 'feature' }] }],
    },
  ],
}

let paths: Paths
let store: PlanningSessionStore
let planning: PlanningService
let sprints: SprintService
let deps: Parameters<typeof createMaterializer>[0]

const inertRunner: TurnRunner = {
  runTurn: async () => {
    throw new Error('sem turnos neste teste')
  },
  cancel: () => {},
}

async function readySession(): Promise<string> {
  const s = newPlanningSession('review')
  s.status = 'awaiting_user'
  s.project_name = 'novo-projeto'
  s.answers['review'] = { approved: true }
  s.outputs['sprints_tasks'] = { screen_payload: { markdown: 'plano' }, structure: STRUCTURE }
  s.kad = { vision: '# Visão\nok', roadmap: '# Roadmap\nfases' }
  await store.save(s)
  return s.session_id
}

beforeEach(async () => {
  paths = await createTempVault()
  store = new PlanningSessionStore(paths)
  const db = createTestDb()
  const repo = createTestRepo(db)
  const audit = new AuditLogger(paths.auditLog)
  const sse = new SSEEventBus()
  const writer = new AtomicWriter(paths, repo)
  const admin = new AdminService(paths, repo, audit, sse)
  const epicsSvc = new EpicService(paths, audit, sse)
  sprints = new SprintService(paths, repo, writer, audit, sse)
  const cards = new CardService(paths, repo, writer, audit, sse)
  deps = { paths, admin, sprints, cards, epics: epicsSvc, saveSession: (s) => store.save(s) }
  planning = new PlanningService(store, inertRunner, repo, sse, 'claude-test', createMaterializer(deps))
})

afterEach(async () => {
  await cleanupVault(paths)
})

describe('kanban_planning_finalize', () => {
  it('materializa projeto, épicos, sprints, cards, goals e KAD', async () => {
    const id = await readySession()
    const r = await planning.finalize({ session_id: id }, mgr)

    expect(r.project).toBe('novo-projeto')
    expect(r.token).toBeTruthy()
    expect(r.epics).toBe(2)
    expect(r.sprints).toBe(3)
    expect(r.cards_created).toBe(4)
    expect(r.cards_failed).toEqual([])
    expect(r.goals).toBe(1)
    expect(r.kad_files).toContain('kad/vision.md')
    expect(r.repo_copy_ok).toBeNull()

    const meta = await loadProjectMeta(paths, 'novo-projeto')
    expect(meta.epics).toHaveLength(2)
    expect(meta.sprints).toHaveLength(3)
    expect(meta.goals).toHaveLength(1)
    // vínculo épico → sprints
    const fundacao = meta.epics!.find((e) => e.name === 'Fundação Técnica')!
    expect(fundacao.sprint_ids).toHaveLength(2)
    // sprints ficam em planning — ativar é decisão humana
    expect(meta.sprints!.every((s) => s.status === 'planning')).toBe(true)

    const vision = await fs.readFile(
      path.join(paths.kanbanData, 'novo-projeto', 'kad', 'vision.md'),
      'utf8',
    )
    expect(vision).toContain('# Visão')

    const session = await planning.get({ session_id: id }, mgr)
    expect(session.status).toBe('done')
  })

  it('cards ganham a tag epic:<slug> e pertencem à sprint certa', async () => {
    const id = await readySession()
    await planning.finalize({ session_id: id }, mgr)
    const meta = await loadProjectMeta(paths, 'novo-projeto')
    const sprint1 = meta.sprints!.find((s) => s.name === 'Sprint 1')!
    const files = await fs.readdir(path.join(paths.kanbanData, 'novo-projeto'))
    const cardFiles = files.filter((f) => f.endsWith('.md'))
    expect(cardFiles).toHaveLength(4)
    const setup = await fs.readFile(
      path.join(paths.kanbanData, 'novo-projeto', cardFiles.find((f) => f.includes('setup'))!),
      'utf8',
    )
    expect(setup).toContain('epic:fundacao-tecnica')
    expect(setup).toContain(sprint1.id)
  })

  it('falha no meio → error com checkpoint; re-chamar retoma sem duplicar (token null + hint)', async () => {
    const id = await readySession()
    const orig = sprints.createSprint.bind(sprints)
    let calls = 0
    vi.spyOn(sprints, 'createSprint').mockImplementation(async (p, c) => {
      calls++
      if (calls === 2) throw new Error('disco cheio')
      return orig(p, c)
    })

    await expect(planning.finalize({ session_id: id }, mgr)).rejects.toThrow('disco cheio')
    let session = await planning.get({ session_id: id }, mgr)
    expect(session.status).toBe('error')
    expect(session.materialization?.project_created).toBe(true)

    const r = await planning.finalize({ session_id: id }, mgr)
    expect(r.token).toBeNull()
    expect(r.token_hint).toContain('kanban_create_agent_token')
    expect(r.sprints).toBe(3)
    expect(r.cards_created).toBe(4)

    const meta = await loadProjectMeta(paths, 'novo-projeto')
    expect(meta.sprints).toHaveLength(3)
    expect(meta.epics).toHaveLength(2)
    session = await planning.get({ session_id: id }, mgr)
    expect(session.status).toBe('done')
  })

  it('estrutura inválida é 400 com detalhe, sem efeito', async () => {
    const s = newPlanningSession('review')
    s.answers['review'] = { approved: true }
    s.outputs['sprints_tasks'] = { screen_payload: {}, structure: { project: { name: 'x' } } }
    await store.save(s)
    await expect(planning.finalize({ session_id: s.session_id }, mgr)).rejects.toMatchObject({
      status: 400,
    })
  })

  it('sessão sem structure é 409', async () => {
    const s = newPlanningSession('identity')
    await store.save(s)
    await expect(planning.finalize({ session_id: s.session_id }, mgr)).rejects.toMatchObject({
      status: 409,
    })
  })

  it('copia o KAD para <target_repo>/docs/kad quando há repo', async () => {
    const repoDir = path.join(paths.vault, 'fake-repo')
    await fs.mkdir(repoDir, { recursive: true })
    const s = newPlanningSession('review')
    s.status = 'awaiting_user'
    s.answers['review'] = { approved: true }
    s.target_repo = repoDir
    s.outputs['sprints_tasks'] = {
      screen_payload: { markdown: 'x' },
      structure: { ...STRUCTURE, project: { name: 'com-repo', target_repo: repoDir } },
    }
    s.kad = { vision: '# V' }
    await store.save(s)

    const r = await planning.finalize({ session_id: s.session_id }, mgr)
    expect(r.repo_copy_ok).toBe(true)
    expect(r.workflow_readiness).toBeDefined()
    const copied = await fs.readFile(path.join(repoDir, 'docs', 'kad', 'vision.md'), 'utf8')
    expect(copied).toBe('# V')
  })
})

describe('watcher ignora subpastas de projeto', () => {
  it('kad/*.md não é card; card direto no projeto é', () => {
    const kd = paths.kanbanData
    expect(isCardFile(path.join(kd, 'p1', 'meu-card.md'), kd)).toBe(true)
    expect(isCardFile(path.join(kd, 'p1', 'kad', 'vision.md'), kd)).toBe(false)
    expect(isCardFile(path.join(kd, 'p1', '_meta.json'), kd)).toBe(false)
    expect(isCardFile(path.join(kd, 'p1', 'sub', 'outra', 'x.md'), kd)).toBe(false)
  })
})
