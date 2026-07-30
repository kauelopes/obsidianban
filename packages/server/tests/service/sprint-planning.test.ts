import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SprintPlanningService } from '../../src/services/sprint-planning.js'
import { SprintPlanningSessionStore } from '../../src/sprint-planning/session.js'
import type { TurnResult, TurnRunner } from '../../src/planning/claude-runner.js'
import { SprintService } from '../../src/services/sprint.js'
import { EpicService } from '../../src/services/epic.js'
import { CardService } from '../../src/services/card.js'
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
let epics: EpicService
let cards: CardService
let sse: SSEEventBus
let events: SSEEvent[]
let service: SprintPlanningService

const mgr = makeManagerClaims()
const FORM_PAYLOAD = { fields: [{ id: 'capacity', label: 'Capacidade', value: '5' }] }
const CHOICE_PAYLOAD = {
  question: 'Qual objetivo?',
  options: [
    { id: 'adhoc', label: 'Novo objetivo' },
    { id: 'outra', label: 'Outra opção' },
  ],
}
const TASKS_STRUCTURE = {
  name: 'Sprint nova',
  goal: 'entregar x',
  tasks: [{ title: 'Tarefa 1', type: 'task' }],
}
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
  epics = new EpicService(paths, audit, sse)
  cards = new CardService(paths, repo, writer, audit, sse)
  service = new SprintPlanningService(
    paths,
    store,
    runner,
    repo,
    sse,
    'claude-test',
    sprints,
    epics,
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

  it('dispara o primeiro turno (capacity) imediatamente — toda etapa tem prefill', async () => {
    await setupTestProject(paths, 'test-project')
    runner.pushScreen(FORM_PAYLOAD)
    const s = await service.start({ project: 'test-project' }, mgr)
    expect(['generating', 'awaiting_user']).toContain(s.status)
    const settled = await settle(s.session_id)
    expect(settled.current_step).toBe('capacity')
    expect(settled.status).toBe('awaiting_user')
    expect(settled.project).toBe('test-project')
    expect(runner.prompts[0]).toContain('facilitador de Sprint Planning')
  })

  it('uma sessão ativa por projeto — segundo start no mesmo projeto é 409, outro projeto ok', async () => {
    await setupTestProject(paths, 'test-project')
    await setupTestProject(paths, 'outro-projeto')
    runner.pushScreen(FORM_PAYLOAD)
    await service.start({ project: 'test-project' }, mgr)
    await expect(service.start({ project: 'test-project' }, mgr)).rejects.toMatchObject({ status: 409 })

    runner.pushScreen(FORM_PAYLOAD)
    const s2 = await service.start({ project: 'outro-projeto' }, mgr)
    expect(s2.project).toBe('outro-projeto')
  })

  it('contexto: sugere capacidade a partir da velocidade das sprints fechadas', async () => {
    await setupTestProject(paths, 'test-project')
    const sprint = await sprints.createSprint({ project: 'test-project', name: 'Sprint 1' }, mgr)
    await sprints.startSprint({ sprint_id: sprint.id }, mgr)
    for (const title of ['a', 'b']) {
      const card = await cards.create(
        { title, type: 'task', project: 'test-project', sprint_id: sprint.id, input_tokens: 0, output_tokens: 0, model: 'test' },
        mgr,
      )
      await cards.move({ id: card.id, to_status: 'done', version: card.version }, mgr)
    }
    await sprints.closeSprint({ sprint_id: sprint.id, rollover_to: null }, mgr)

    runner.pushScreen(FORM_PAYLOAD)
    const s = await service.start({ project: 'test-project' }, mgr)
    expect(s.context.suggested_capacity).toEqual({ avg_cards_per_sprint: 2, sample_sprints: 1 })
  })
})

describe('fluxo completo até review', () => {
  it('goal com épico existente seta epic_id; tasks emite structure; review habilita finalize', async () => {
    await setupTestProject(paths, 'test-project')
    const { epic } = await epics.createEpic({ project: 'test-project', name: 'Épico A', objective: 'x' }, mgr)

    runner.pushScreen(FORM_PAYLOAD)
    const s = await service.start({ project: 'test-project' }, mgr)
    await settle(s.session_id)

    runner.pushScreen({
      question: 'Qual objetivo?',
      options: [{ id: epic.id, label: epic.name }, { id: 'adhoc', label: 'novo' }],
    })
    await service.answer({ session_id: s.session_id, step: 'capacity', answer: { capacity: '5' } }, mgr)
    let settled = await settle(s.session_id)
    expect(settled.current_step).toBe('goal')

    runner.pushScreen(CONFIRM_PAYLOAD, { structure: TASKS_STRUCTURE })
    await service.answer({ session_id: s.session_id, step: 'goal', answer: { choice: epic.id } }, mgr)
    settled = await settle(s.session_id)
    expect(settled.epic_id).toBe(epic.id)
    expect(settled.current_step).toBe('tasks')
    expect(settled.outputs['tasks']?.structure).toEqual(TASKS_STRUCTURE)

    runner.pushScreen(FORM_PAYLOAD)
    await service.answer({ session_id: s.session_id, step: 'tasks', answer: { approved: true } }, mgr)
    settled = await settle(s.session_id)
    expect(settled.current_step).toBe('risks')

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

  it('objetivo ad-hoc (adhoc) não seta epic_id', async () => {
    await setupTestProject(paths, 'test-project')
    runner.pushScreen(FORM_PAYLOAD)
    const s = await service.start({ project: 'test-project' }, mgr)
    await settle(s.session_id)

    runner.pushScreen(CHOICE_PAYLOAD)
    await service.answer({ session_id: s.session_id, step: 'capacity', answer: { capacity: '3' } }, mgr)
    await settle(s.session_id)

    runner.pushScreen(CONFIRM_PAYLOAD, { structure: TASKS_STRUCTURE })
    const settled = await service.answer(
      { session_id: s.session_id, step: 'goal', answer: { choice: 'adhoc' } },
      mgr,
    )
    expect(settled.epic_id).toBeNull()
  })
})

describe('finalize', () => {
  it('exige structure da etapa tasks; chama o materializer quando pronto', async () => {
    await setupTestProject(paths, 'test-project')
    runner.pushScreen(FORM_PAYLOAD)
    const s = await service.start({ project: 'test-project' }, mgr)
    await settle(s.session_id)

    await expect(service.finalize({ session_id: s.session_id }, mgr)).rejects.toMatchObject({
      status: 409,
    })

    const materializer = vi.fn().mockResolvedValue({
      project: 'test-project',
      sprint_id: 'sprint-x',
      epic_linked: false,
      new_cards_created: 1,
      new_cards_failed: [],
    })
    service = new SprintPlanningService(paths, store, runner, repo, sse, 'claude-test', sprints, epics, materializer)

    runner.pushScreen(CHOICE_PAYLOAD)
    await service.answer({ session_id: s.session_id, step: 'capacity', answer: { capacity: '3' } }, mgr)
    await settle(s.session_id)
    runner.pushScreen(CONFIRM_PAYLOAD, { structure: TASKS_STRUCTURE })
    await service.answer({ session_id: s.session_id, step: 'goal', answer: { choice: 'adhoc' } }, mgr)
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
    runner.pushScreen(FORM_PAYLOAD)
    const s = await service.start({ project: 'test-project' }, mgr)
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
