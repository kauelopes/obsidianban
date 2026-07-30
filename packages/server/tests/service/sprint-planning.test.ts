import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SprintPlanningService } from '../../src/services/sprint-planning.js'
import { SprintPlanningSessionStore } from '../../src/sprint-planning/session.js'
import type { TurnResult, TurnRunner } from '../../src/planning/claude-runner.js'
import { SprintService } from '../../src/services/sprint.js'
import { AtomicWriter } from '../../src/writer/atomic.js'
import { AuditLogger } from '../../src/audit/logger.js'
import { SSEEventBus } from '../../src/server/sse.js'
import { createTempVault, cleanupVault, setupTestProject } from '../helpers/vault.js'
import { createTestDb, createTestRepo } from '../helpers/db.js'
import { makeManagerClaims, makeAgentClaims } from '../helpers/factories.js'
import type { Paths } from '../../src/config.js'
import type { CardRepository } from '../../src/cards/repository.js'
import type { SSEEvent } from '@obsidiankan/types'

/** Runner fake: fila de respostas, um TurnResult por turno (mesmo padrão de planning.test.ts). */
class FakeRunner implements TurnRunner {
  queue: TurnResult[] = []
  prompts: string[] = []
  cancelled = false

  push(partial: Partial<TurnResult> & { text?: string }): void {
    this.queue.push({
      ok: true,
      text: '',
      sessionId: 'claude-sess-1',
      usage: { input: 100, output: 50, usd: 0.01 },
      rateLimited: false,
      error: null,
      ...partial,
    })
  }

  pushScreen(payload: unknown, extra: Record<string, unknown> = {}): void {
    this.push({ text: JSON.stringify({ screen_payload: payload, ...extra }) })
  }

  async runTurn(prompt: string): Promise<TurnResult> {
    this.prompts.push(prompt)
    const next = this.queue.shift()
    if (!next) throw new Error('FakeRunner: fila vazia')
    return next
  }

  cancel(): void {
    this.cancelled = true
  }
}

let paths: Paths
let store: SprintPlanningSessionStore
let runner: FakeRunner
let repo: CardRepository
let sprints: SprintService
let sse: SSEEventBus
let events: SSEEvent[]
let service: SprintPlanningService

const mgr = makeManagerClaims()
const TASK_LIST_INTRO_PAYLOAD = { intro: 'contexto sintético' }
const TASKS_STRUCTURE = {
  name: 'Sprint nova',
  goal: 'entregar x',
  tasks: [{ title: 'Tarefa 1', type: 'task' }],
}
const RISKS_PAYLOAD = { fields: [{ id: 'risks', label: 'Riscos', value: 'nenhum identificado' }] }
const CONFIRM_PAYLOAD = { markdown: '## resumo' }

/** Espera o turno fire-and-forget assentar (status sai de generating). */
async function settle(sessionId: string): Promise<ReturnType<SprintPlanningService['get']>> {
  for (let i = 0; i < 50; i++) {
    const s = await service.get({ session_id: sessionId }, mgr)
    if (s.status !== 'generating') return Promise.resolve(s)
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('sessão não saiu de generating')
}

beforeEach(async () => {
  paths = await createTempVault()
  store = new SprintPlanningSessionStore(paths)
  runner = new FakeRunner()
  const db = createTestDb()
  repo = createTestRepo(db)
  const writer = new AtomicWriter(paths, repo)
  const audit = new AuditLogger(paths.auditLog)
  sse = new SSEEventBus()
  events = []
  const origEmit = sse.emit.bind(sse)
  sse.emit = (e) => {
    events.push(e)
    origEmit(e)
  }
  sprints = new SprintService(paths, repo, writer, audit, sse)
  service = new SprintPlanningService(
    paths,
    store,
    runner,
    repo,
    sse,
    'claude-test',
    sprints,
    async () => {
      throw new Error('materializer não usado neste teste')
    },
  )
})

afterEach(async () => {
  await cleanupVault(paths)
})

describe('start', () => {
  it('projeto desconhecido é 404; agente não-pm/manager é 403', async () => {
    await expect(service.start({ project: 'ghost' }, mgr)).rejects.toMatchObject({ status: 404 })
    await setupTestProject(paths, 'test-project')
    await expect(
      service.start({ project: 'test-project' }, makeAgentClaims({ agent_type: 'dev' })),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('nasce em awaiting_user na etapa goal, sem turno de LLM', async () => {
    await setupTestProject(paths, 'test-project')
    const s = await service.start({ project: 'test-project' }, mgr)
    expect(s.status).toBe('awaiting_user')
    expect(s.current_step).toBe('goal')
    expect(s.project).toBe('test-project')
    expect(runner.prompts).toHaveLength(0)
    const payload = s.outputs['goal']?.screen_payload as { fields: Array<{ id: string }> }
    expect(payload.fields.map((f) => f.id)).toEqual(['objective'])
  })

  it('uma sessão ativa por projeto — segundo start no mesmo projeto é 409, outro projeto ok', async () => {
    await setupTestProject(paths, 'test-project')
    await setupTestProject(paths, 'outro-projeto')
    await service.start({ project: 'test-project' }, mgr)
    await expect(service.start({ project: 'test-project' }, mgr)).rejects.toMatchObject({ status: 409 })

    const s2 = await service.start({ project: 'outro-projeto' }, mgr)
    expect(s2.project).toBe('outro-projeto')
  })
})

describe('fluxo completo até review', () => {
  it('goal com texto livre dispara o turno de tasks; edição humana e avanço até review', async () => {
    await setupTestProject(paths, 'test-project')
    const s = await service.start({ project: 'test-project' }, mgr)
    expect(s.current_step).toBe('goal')

    runner.pushScreen(TASK_LIST_INTRO_PAYLOAD, { structure: TASKS_STRUCTURE })
    await service.answer(
      { session_id: s.session_id, step: 'goal', answer: { objective: 'melhorar o onboarding' } },
      mgr,
    )
    let settled = await settle(s.session_id)
    expect(settled.current_step).toBe('tasks')
    expect(settled.answers['goal']).toEqual({ objective: 'melhorar o onboarding' })
    expect(settled.outputs['tasks']?.structure).toEqual(TASKS_STRUCTURE)
    expect(runner.prompts[0]).toContain('melhorar o onboarding')

    runner.pushScreen(RISKS_PAYLOAD)
    await service.answer(
      { session_id: s.session_id, step: 'tasks', answer: { tasks: [{ title: 'Tarefa 1 editada', type: 'task' }] } },
      mgr,
    )
    settled = await settle(s.session_id)
    expect(settled.current_step).toBe('risks')
    expect(settled.outputs['tasks']?.structure).toEqual({
      name: TASKS_STRUCTURE.name,
      goal: TASKS_STRUCTURE.goal,
      tasks: [{ title: 'Tarefa 1 editada', type: 'task' }],
    })

    runner.pushScreen(CONFIRM_PAYLOAD)
    await service.answer({ session_id: s.session_id, step: 'risks', answer: { risks: 'nenhum' } }, mgr)
    settled = await settle(s.session_id)
    expect(settled.current_step).toBe('review')

    settled = await service.answer(
      { session_id: s.session_id, step: 'review', answer: { approved: true } },
      mgr,
    )
    expect(settled.status).toBe('awaiting_user')
    expect(settled.answers['review']).toEqual({ approved: true })
  })
})

describe('captureTasks (edição humana da etapa tasks)', () => {
  async function reachTasksStep(): Promise<string> {
    await setupTestProject(paths, 'test-project')
    const s = await service.start({ project: 'test-project' }, mgr)
    runner.pushScreen({}, { structure: TASKS_STRUCTURE })
    await service.answer({ session_id: s.session_id, step: 'goal', answer: { objective: 'objetivo x' } }, mgr)
    await settle(s.session_id)
    return s.session_id
  }

  it('edição válida sobrescreve structure.tasks preservando name/goal', async () => {
    const sessionId = await reachTasksStep()
    const settled = await service.answer(
      {
        session_id: sessionId,
        step: 'tasks',
        answer: { tasks: [{ title: 'Nova tarefa', type: 'feature', priority: 'high' }] },
      },
      mgr,
    )
    expect(settled.outputs['tasks']?.structure).toEqual({
      name: TASKS_STRUCTURE.name,
      goal: TASKS_STRUCTURE.goal,
      tasks: [{ title: 'Nova tarefa', type: 'feature', priority: 'high' }],
    })
  })

  it('lista vazia é rejeitada com 400 e não avança a etapa', async () => {
    const sessionId = await reachTasksStep()
    await expect(
      service.answer({ session_id: sessionId, step: 'tasks', answer: { tasks: [] } }, mgr),
    ).rejects.toMatchObject({ status: 400 })
    const after = await service.get({ session_id: sessionId }, mgr)
    expect(after.current_step).toBe('tasks')
  })

  it('type inválido é rejeitado com 400', async () => {
    const sessionId = await reachTasksStep()
    await expect(
      service.answer(
        { session_id: sessionId, step: 'tasks', answer: { tasks: [{ title: 'x', type: 'invalido' }] } },
        mgr,
      ),
    ).rejects.toMatchObject({ status: 400 })
  })
})

describe('finalize', () => {
  it('exige structure da etapa tasks; chama o materializer quando pronto', async () => {
    await setupTestProject(paths, 'test-project')
    const s = await service.start({ project: 'test-project' }, mgr)

    await expect(service.finalize({ session_id: s.session_id }, mgr)).rejects.toMatchObject({
      status: 409,
    })

    const materializer = vi.fn().mockResolvedValue({
      project: 'test-project',
      sprint_id: 'sprint-x',
      new_cards_created: 1,
      new_cards_failed: [],
    })
    service = new SprintPlanningService(paths, store, runner, repo, sse, 'claude-test', sprints, materializer)

    runner.pushScreen({}, { structure: TASKS_STRUCTURE })
    await service.answer({ session_id: s.session_id, step: 'goal', answer: { objective: 'objetivo x' } }, mgr)
    await settle(s.session_id)

    const result = await service.finalize({ session_id: s.session_id }, mgr)
    expect(result.sprint_id).toBe('sprint-x')
    expect(materializer).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: s.session_id }),
      TASKS_STRUCTURE,
      mgr,
    )
    expect(events.some((e) => e.type === 'SPRINT_PLANNING_FINALIZED')).toBe(true)
  })
})

describe('registra tokens', () => {
  it('token_log com op PLANNING e card_type sprint_planning', async () => {
    const spy = vi.spyOn(repo, 'logTokens')
    await setupTestProject(paths, 'test-project')
    const s = await service.start({ project: 'test-project' }, mgr)
    runner.pushScreen({}, { structure: TASKS_STRUCTURE })
    await service.answer({ session_id: s.session_id, step: 'goal', answer: { objective: 'objetivo x' } }, mgr)
    await settle(s.session_id)
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'PLANNING',
        card_type: 'sprint_planning',
        model: 'claude-test',
        project: 'test-project',
      }),
    )
  })
})
