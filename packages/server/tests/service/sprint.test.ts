import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Paths } from '../../src/config.js'
import { createTempVault, cleanupVault, setupTestProject } from '../helpers/vault.js'
import { createTestDb, createTestRepo } from '../helpers/db.js'
import { makeManagerClaims, makeAgentClaims, makeDevClaims, makeSprint } from '../helpers/factories.js'
import { SprintService } from '../../src/services/sprint.js'
import { CardService } from '../../src/services/card.js'
import { AtomicWriter } from '../../src/writer/atomic.js'
import { SSEEventBus } from '../../src/server/sse.js'
import type { CardRepository } from '../../src/cards/repository.js'
import type { AuditLogger } from '../../src/audit/logger.js'
import { HttpError } from '../../src/services/errors.js'

let paths: Paths
let repo: CardRepository
let writer: AtomicWriter
let sprintService: SprintService
let cardService: CardService
const sse = new SSEEventBus()
const audit = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogger
const PM = makeAgentClaims()
const MGR = makeManagerClaims()

const BASE_CARD = {
  type: 'task',
  input_tokens: 0,
  output_tokens: 0,
  model: 'test',
}

beforeEach(async () => {
  paths = await createTempVault()
  const db = createTestDb()
  repo = createTestRepo(db)
  writer = new AtomicWriter(paths, repo)
  sprintService = new SprintService(paths, repo, writer, audit, sse)
  cardService = new CardService(paths, repo, writer, audit, sse)
  vi.clearAllMocks()
})

afterEach(async () => {
  await cleanupVault(paths)
})

async function setupActiveSprint() {
  await setupTestProject(paths, 'test-project')
  const sprint = await sprintService.createSprint({ project: 'test-project', name: 'Sprint 1' }, MGR)
  await sprintService.startSprint({ sprint_id: sprint.id }, MGR)
  return sprint
}

async function setupPlanningSprintWithBacklog() {
  await setupTestProject(paths, 'test-project')
  const sprint = await sprintService.createSprint({ project: 'test-project', name: 'Sprint 1' }, MGR)
  // Create a card in backlog (planning sprint)
  const card = await cardService.create(
    { ...BASE_CARD, title: 'Backlog Card', type: 'task', project: 'test-project', sprint_id: sprint.id },
    MGR,
  )
  return { sprint, card }
}

describe('SprintService.createSprint', () => {
  it('creates a sprint in planning status', async () => {
    await setupTestProject(paths, 'test-project')
    const sprint = await sprintService.createSprint(
      { project: 'test-project', name: 'Sprint 1', goal: 'Finish feature X' },
      MGR,
    )
    expect(sprint.status).toBe('planning')
    expect(sprint.name).toBe('Sprint 1')
    expect(sprint.goal).toBe('Finish feature X')
    expect(sprint.id).toMatch(/^sprint-/)
    expect(sprint.started_at).toBeNull()
  })
})

describe('SprintService.startSprint', () => {
  it('transitions sprint from planning to active', async () => {
    await setupTestProject(paths, 'test-project')
    const sprint = await sprintService.createSprint({ project: 'test-project', name: 'Sprint 1' }, MGR)
    const started = await sprintService.startSprint({ sprint_id: sprint.id }, MGR)
    expect(started.status).toBe('active')
    expect(started.started_at).toBeTruthy()
  })

  it('promotes backlog cards to todo on start', async () => {
    const { sprint, card } = await setupPlanningSprintWithBacklog()
    // Card should start in backlog (planning sprint default)
    expect(card.status).toBe('backlog')

    const result = await sprintService.startSprint({ sprint_id: sprint.id }, MGR)
    expect(result.promoted_to_todo).toContain(card.id)

    // Verify in DB
    const row = repo.findById(card.id)
    expect(row?.status).toBe('todo')
  })

  it('rejects starting when another sprint is already active (409)', async () => {
    await setupTestProject(paths, 'test-project')
    const s1 = await sprintService.createSprint({ project: 'test-project', name: 'Sprint 1' }, MGR)
    const s2 = await sprintService.createSprint({ project: 'test-project', name: 'Sprint 2' }, MGR)
    await sprintService.startSprint({ sprint_id: s1.id }, MGR)

    try {
      await sprintService.startSprint({ sprint_id: s2.id }, MGR)
      expect.fail('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError)
      expect((e as HttpError).status).toBe(409)
      expect((e as HttpError).body).toMatchObject({
        reason: 'another_sprint_active',
        active_sprint_id: s1.id,
      })
    }
  })
})

describe('SprintService.addToSprint', () => {
  it('rejects adding cards to a closed sprint', async () => {
    const { sprint, card } = await setupPlanningSprintWithBacklog()
    await sprintService.startSprint({ sprint_id: sprint.id }, MGR)
    await sprintService.closeSprint({ sprint_id: sprint.id }, MGR)

    const sprint2 = await sprintService.createSprint({ project: 'test-project', name: 'Sprint 2' }, MGR)
    try {
      await sprintService.addToSprint({ sprint_id: sprint.id, card_ids: [card.id] }, MGR)
      expect.fail('should throw')
    } catch (e) {
      void sprint2
      expect(e).toBeInstanceOf(HttpError)
      expect((e as HttpError).status).toBe(400)
    }
  })
})

describe('SprintService.closeSprint', () => {
  it('archives done cards automatically on close', async () => {
    const activeSprint = await setupActiveSprint()
    // Create a done card
    const card = await cardService.create(
      { ...BASE_CARD, title: 'Done Card', type: 'task', project: 'test-project', sprint_id: activeSprint.id, status: 'done' },
      MGR,
    )

    await sprintService.closeSprint({ sprint_id: activeSprint.id }, MGR)

    const row = repo.findById(card.id)
    expect(row?.archived).toBe(1)
  })

  it('does not roll over unfinished cards when rollover_to is absent', async () => {
    const activeSprint = await setupActiveSprint()
    const card = await cardService.create(
      { ...BASE_CARD, title: 'Unfinished', type: 'task', project: 'test-project', sprint_id: activeSprint.id, status: 'todo' },
      MGR,
    )

    const result = await sprintService.closeSprint({ sprint_id: activeSprint.id }, MGR)
    expect(result.rolled_over).toHaveLength(0)

    // Card remains in the closed sprint
    const row = repo.findById(card.id)
    expect(row?.sprint_id).toBe(activeSprint.id)
  })

  it('rolls over unfinished cards to the target sprint', async () => {
    const activeSprint = await setupActiveSprint()
    const card = await cardService.create(
      { ...BASE_CARD, title: 'Unfinished', type: 'task', project: 'test-project', sprint_id: activeSprint.id, status: 'todo' },
      MGR,
    )
    const nextSprint = await sprintService.createSprint(
      { project: 'test-project', name: 'Sprint 2' },
      MGR,
    )

    const result = await sprintService.closeSprint(
      { sprint_id: activeSprint.id, rollover_to: nextSprint.id },
      MGR,
    )
    expect(result.rolled_over).toContain(card.id)

    const row = repo.findById(card.id)
    expect(row?.sprint_id).toBe(nextSprint.id)
  })
})

describe('SprintService.listSprints', () => {
  it('filters by status', async () => {
    await setupTestProject(paths, 'test-project')
    const s1 = await sprintService.createSprint({ project: 'test-project', name: 'Planning Sprint' }, MGR)
    const s2 = await sprintService.createSprint({ project: 'test-project', name: 'Active Sprint' }, MGR)
    await sprintService.startSprint({ sprint_id: s2.id }, MGR)

    const { sprints: planning } = await sprintService.listSprints({ project: 'test-project', status: 'planning' }, MGR)
    expect(planning.map((s) => s.id)).toContain(s1.id)
    expect(planning.map((s) => s.id)).not.toContain(s2.id)

    const { sprints: active } = await sprintService.listSprints({ project: 'test-project', status: 'active' }, MGR)
    expect(active.map((s) => s.id)).toContain(s2.id)
  })
})

describe('SprintService.getSprint', () => {
  it('returns sprint detail with correct aggregates', async () => {
    const activeSprint = await setupActiveSprint()
    await cardService.create(
      { ...BASE_CARD, title: 'Done', type: 'task', project: 'test-project', sprint_id: activeSprint.id, status: 'done' },
      MGR,
    )
    await cardService.create(
      { ...BASE_CARD, title: 'Todo', type: 'task', project: 'test-project', sprint_id: activeSprint.id, status: 'todo' },
      MGR,
    )

    const detail = await sprintService.getSprint({ sprint_id: activeSprint.id }, MGR)
    expect(detail.sprint.id).toBe(activeSprint.id)
    expect(detail.aggregates.cards_total).toBe(2)
    expect(detail.aggregates.cards_done).toBe(1)
    expect(detail.aggregates.cards_todo).toBe(1)
  })
})

describe('SprintService.moveBetweenSprints', () => {
  it('moves a card from one sprint to another', async () => {
    const activeSprint = await setupActiveSprint()
    const card = await cardService.create(
      { ...BASE_CARD, title: 'Card', type: 'task', project: 'test-project', sprint_id: activeSprint.id, status: 'todo' },
      MGR,
    )
    const nextSprint = await sprintService.createSprint(
      { project: 'test-project', name: 'Sprint 2' },
      MGR,
    )

    const result = await sprintService.moveBetweenSprints(
      { sprint_id: activeSprint.id, target_sprint_id: nextSprint.id, card_ids: [card.id] },
      MGR,
    )
    expect(result.updated).toContain(card.id)

    const row = repo.findById(card.id)
    expect(row?.sprint_id).toBe(nextSprint.id)
  })

  it('fails cards that are not in the source sprint', async () => {
    const activeSprint = await setupActiveSprint()
    const nextSprint = await sprintService.createSprint(
      { project: 'test-project', name: 'Sprint 2' },
      MGR,
    )
    const card = await cardService.create(
      { ...BASE_CARD, title: 'Card', type: 'task', project: 'test-project', sprint_id: nextSprint.id },
      MGR,
    )

    const result = await sprintService.moveBetweenSprints(
      { sprint_id: activeSprint.id, target_sprint_id: nextSprint.id, card_ids: [card.id] },
      MGR,
    )
    expect(result.failed[0]).toMatchObject({ card_id: card.id, reason: 'not_in_source_sprint' })
  })
})

describe('SprintService.addToSprint', () => {
  it('moves card to todo when move_to_todo is true', async () => {
    const activeSprint = await setupActiveSprint()
    const card = await cardService.create(
      { ...BASE_CARD, title: 'Card', type: 'task', project: 'test-project', sprint_id: activeSprint.id, status: 'in_progress' },
      MGR,
    )

    const result = await sprintService.addToSprint(
      { sprint_id: activeSprint.id, card_ids: [card.id], move_to_todo: true },
      MGR,
    )
    expect(result.moved_to_todo).toContain(card.id)

    const row = repo.findById(card.id)
    expect(row?.status).toBe('todo')
  })

  it('is a no-op when card is already in sprint and in todo', async () => {
    const activeSprint = await setupActiveSprint()
    const card = await cardService.create(
      { ...BASE_CARD, title: 'Card', type: 'task', project: 'test-project', sprint_id: activeSprint.id, status: 'todo' },
      MGR,
    )

    const result = await sprintService.addToSprint(
      { sprint_id: activeSprint.id, card_ids: [card.id], move_to_todo: true },
      MGR,
    )
    expect(result.updated).toContain(card.id)
    // version should not have bumped
    const row = repo.findById(card.id)
    expect(row?.version).toBe(card.version)
  })

  it('reports not_found for unknown card ids', async () => {
    const activeSprint = await setupActiveSprint()

    const result = await sprintService.addToSprint(
      { sprint_id: activeSprint.id, card_ids: ['card-doesnotexist'] },
      MGR,
    )
    expect(result.failed[0]).toMatchObject({ card_id: 'card-doesnotexist', reason: 'not_found' })
  })
})

describe('SprintService.closeSprint', () => {
  it('throws 400 when closing an already-closed sprint', async () => {
    const activeSprint = await setupActiveSprint()
    await sprintService.closeSprint({ sprint_id: activeSprint.id }, MGR)

    await expect(
      sprintService.closeSprint({ sprint_id: activeSprint.id }, MGR),
    ).rejects.toMatchObject({ status: 400 })
  })
})

describe('SprintService — PM agent restrictions', () => {
  it('allows PM agent to create a sprint', async () => {
    await setupTestProject(paths, 'test-project')
    const sprint = await sprintService.createSprint({ name: 'S1' }, PM)
    expect(sprint.status).toBe('planning')
  })

  it('rejects dev agent from creating a sprint', async () => {
    await setupTestProject(paths, 'test-project')
    const devClaims = makeDevClaims()
    await expect(
      sprintService.createSprint({ name: 'S1' }, devClaims),
    ).rejects.toMatchObject({ status: 403 })
  })
})
