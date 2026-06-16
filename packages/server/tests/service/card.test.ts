import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Paths } from '../../src/config.js'
import { createTempVault, cleanupVault, setupTestProject } from '../helpers/vault.js'
import { createTestDb, createTestRepo } from '../helpers/db.js'
import { makeManagerClaims, makeAgentClaims, makeDevClaims, makeSprint } from '../helpers/factories.js'
import { CardService } from '../../src/services/card.js'
import { SprintService } from '../../src/services/sprint.js'
import { AtomicWriter } from '../../src/writer/atomic.js'
import { SSEEventBus } from '../../src/server/sse.js'
import type { CardRepository } from '../../src/cards/repository.js'
import type { AuditLogger } from '../../src/audit/logger.js'
import { HttpError } from '../../src/services/errors.js'

let paths: Paths
let repo: CardRepository
let writer: AtomicWriter
let cardService: CardService
let sprintService: SprintService
const sse = new SSEEventBus()
const audit = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogger
const MGR = makeManagerClaims()
const PM = makeAgentClaims()

const TOKEN = { input_tokens: 0, output_tokens: 0, model: 'test' }

beforeEach(async () => {
  paths = await createTempVault()
  const db = createTestDb()
  repo = createTestRepo(db)
  writer = new AtomicWriter(paths, repo)
  cardService = new CardService(paths, repo, writer, audit, sse)
  sprintService = new SprintService(paths, repo, writer, audit, sse)
  vi.clearAllMocks()
})

afterEach(async () => {
  await cleanupVault(paths)
})

async function setupWithActiveSprint() {
  await setupTestProject(paths, 'test-project')
  const sprint = await sprintService.createSprint({ project: 'test-project', name: 'S1' }, MGR)
  await sprintService.startSprint({ sprint_id: sprint.id }, MGR)
  return sprint
}

async function createCard(sprintId: string, overrides: Record<string, unknown> = {}) {
  return cardService.create(
    { ...TOKEN, title: 'Test Card', type: 'task', project: 'test-project', sprint_id: sprintId, ...overrides },
    MGR,
  )
}

describe('CardService.create', () => {
  it('creates a card with position = 1000 when column is empty', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id)
    expect(card.position).toBe(1000)
    expect(card.version).toBe(1)
    expect(card.id).toMatch(/^card-/)
  })

  it('stacks cards at maxPosition + 1000', async () => {
    const sprint = await setupWithActiveSprint()
    const card1 = await createCard(sprint.id)
    const card2 = await createCard(sprint.id, { title: 'Second Card' })
    expect(card2.position).toBe(card1.position + 1000)
  })

  it('rejects creating card in closed sprint', async () => {
    await setupTestProject(paths, 'test-project')
    const sprint = await sprintService.createSprint({ project: 'test-project', name: 'S1' }, MGR)
    await sprintService.startSprint({ sprint_id: sprint.id }, MGR)
    await sprintService.closeSprint({ sprint_id: sprint.id }, MGR)

    await expect(createCard(sprint.id)).rejects.toBeInstanceOf(HttpError)
  })

  it('throws 403 when dev agent tries to call update', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id)
    const devClaims = makeDevClaims()

    await expect(
      cardService.update({ ...TOKEN, id: card.id, version: 1, title: 'Hack' }, devClaims),
    ).rejects.toMatchObject({ status: 403 })
  })
})

describe('CardService.update — version conflict detection (409)', () => {
  it('returns 409 with conflicting_fields when version is stale', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id)

    try {
      // Card is at version 1; claiming version 99 simulates a stale read
      await cardService.update(
        { ...TOKEN, id: card.id, version: 99, title: 'New Title' },
        MGR,
      )
      expect.fail('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError)
      const err = e as HttpError
      expect(err.status).toBe(409)
      expect(err.body.conflicting_fields).toContain('title')
      expect(err.body.current_version).toBe(1)
      expect(err.body.your_version).toBe(99)
      expect(err.body.current_card).toBeDefined()
    }
  })

  it('returns empty conflicting_fields when proposed value matches current', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id)

    try {
      // Submit version 99 (stale) but same title — no real conflict on title
      await cardService.update(
        { ...TOKEN, id: card.id, version: 99, title: card.title },
        MGR,
      )
      expect.fail('should throw')
    } catch (e) {
      const err = e as HttpError
      expect(err.status).toBe(409)
      // title wasn't actually changed so it should not appear in conflicting_fields
      expect((err.body.conflicting_fields as string[])).not.toContain('title')
    }
  })

  it('rejects update from dev agent with 403', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id)
    const devClaims = makeDevClaims()

    await expect(
      cardService.update({ ...TOKEN, id: card.id, version: 1, title: 'Hack' }, devClaims),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('rejects body in update (body_immutable)', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id)

    await expect(
      cardService.update({ ...TOKEN, id: card.id, version: 1, body: 'new body' }, MGR),
    ).rejects.toMatchObject({ status: 400 })
  })
})

describe('CardService.update — position on status change', () => {
  it('moves card to bottom of destination column on status change', async () => {
    const sprint = await setupWithActiveSprint()
    const existing = await createCard(sprint.id, { status: 'in_progress' })
    const card = await createCard(sprint.id)

    const updated = await cardService.update(
      { ...TOKEN, id: card.id, version: 1, status: 'in_progress' },
      MGR,
    )
    // existing card is at 1000, so new position should be 2000
    expect(updated.position).toBeGreaterThan(existing.position)
    expect(updated.status).toBe('in_progress')
  })
})

describe('CardService — blocked_by cycle detection', () => {
  it('rejects blocked_by when it creates a cycle (A blocks B, B tries to block A)', async () => {
    const sprint = await setupWithActiveSprint()
    const cardA = await createCard(sprint.id, { title: 'Card A' })
    const cardB = await createCard(sprint.id, { title: 'Card B', blocked_by: [cardA.id] })

    // Now try to have A block B — would create a cycle
    await expect(
      cardService.update(
        { ...TOKEN, id: cardA.id, version: cardA.version, blocked_by: [cardB.id] },
        MGR,
      ),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('rejects self-reference in blocked_by', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id)

    await expect(
      cardService.update({ ...TOKEN, id: card.id, version: card.version, blocked_by: [card.id] }, MGR),
    ).rejects.toMatchObject({ status: 400 })
  })
})

describe('CardService.claim', () => {
  it('assigns the card to the actor', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id)

    const claimed = await cardService.claim(
      { ...TOKEN, id: card.id, version: card.version },
      PM,
    )
    expect(claimed.assigned_to).toBe(PM.actor)
    expect(claimed.version).toBe(2)
  })

  it('is idempotent when same actor re-claims', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id)

    const first = await cardService.claim({ ...TOKEN, id: card.id, version: 1 }, PM)
    const second = await cardService.claim({ ...TOKEN, id: card.id, version: first.version }, PM)

    // Second claim is idempotent — version does not bump
    expect(second.version).toBe(first.version)
  })

  it('returns 409 when card is already claimed by a different actor', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id)

    // Actor A claims
    await cardService.claim({ ...TOKEN, id: card.id, version: card.version }, PM)

    const otherClaims = makeAgentClaims({ actor: 'agent:other-agent' })

    try {
      // Re-read current version from DB
      const row = repo.findById(card.id)!
      await cardService.claim({ ...TOKEN, id: card.id, version: row.version }, otherClaims)
      expect.fail('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError)
      expect((e as HttpError).status).toBe(409)
      expect((e as HttpError).body).toMatchObject({ error: 'already_claimed' })
    }
  })
})

describe('CardService.pickNext', () => {
  it('returns the highest priority unblocked card in todo', async () => {
    const sprint = await setupWithActiveSprint()
    const low = await createCard(sprint.id, { title: 'Low Priority', priority: 'low' })
    const high = await createCard(sprint.id, { title: 'High Priority', priority: 'high' })

    const result = await cardService.pickNext({ status: 'todo' }, PM)
    expect(result.card?.id).toBe(high.id)
    void low
  })

  it('skips blocked cards', async () => {
    const sprint = await setupWithActiveSprint()
    const blocker = await createCard(sprint.id, { title: 'Blocker', priority: 'high' })
    const blocked = await createCard(sprint.id, {
      title: 'Blocked',
      priority: 'high',
      blocked_by: [blocker.id],
    })
    const free = await createCard(sprint.id, { title: 'Free', priority: 'medium' })

    const result = await cardService.pickNext({ status: 'todo' }, PM)
    // blocker itself is free (nothing blocks it), high priority → should be picked
    expect(result.card?.id).toBe(blocker.id)
    void blocked
    void free
  })
})

describe('CardService.reorder — position recalculation without collision', () => {
  it('reorders cards and assigns non-colliding positions', async () => {
    const sprint = await setupWithActiveSprint()
    const card1 = await createCard(sprint.id, { title: 'Card 1' })
    const card2 = await createCard(sprint.id, { title: 'Card 2' })
    const card3 = await createCard(sprint.id, { title: 'Card 3' })

    // Move card3 to top (after null)
    const result = await cardService.reorder(
      { ...TOKEN, id: card3.id, version: card3.version, after_card_id: null },
      MGR,
    )

    const positions = result.affected_cards.map((a) => a.new_position)
    const uniquePositions = new Set(positions)
    // All affected positions must be unique
    expect(uniquePositions.size).toBe(positions.length)
    // card3 should now be at position 1000 (first slot)
    expect(result.card.position).toBe(1000)
    void card1
    void card2
  })
})

describe('CardService.delete', () => {
  it('deletes a card and removes it from the DB', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id)

    await cardService.delete({ ...TOKEN, id: card.id, version: card.version }, MGR)
    expect(repo.findById(card.id)).toBeNull()
  })

  it('returns 409 when version is stale on delete', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id)

    await expect(
      cardService.delete({ ...TOKEN, id: card.id, version: 99 }, MGR),
    ).rejects.toMatchObject({ status: 409 })
  })
})

describe('CardService.archive / unarchive', () => {
  it('archives a card', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id)

    const archived = await cardService.archive({ ...TOKEN, id: card.id, version: card.version }, MGR)
    expect(archived.archived).toBe(true)
    expect(archived.version).toBe(2)
  })

  it('unarchives a card', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id)

    const archivedCard = await cardService.archive({ ...TOKEN, id: card.id, version: card.version }, MGR)
    const unarchived = await cardService.unarchive(
      { ...TOKEN, id: archivedCard.id, version: archivedCard.version },
      MGR,
    )
    expect(unarchived.archived).toBe(false)
  })

  it('is idempotent when archiving an already-archived card', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id)

    const first = await cardService.archive({ ...TOKEN, id: card.id, version: card.version }, MGR)
    const second = await cardService.archive({ ...TOKEN, id: card.id, version: first.version }, MGR)
    expect(second.archived).toBe(true)
    // idempotent: version does not bump on no-op
    expect(second.version).toBe(first.version)
  })
})

describe('CardService.move', () => {
  it('moves card to a new column and repositions it at the bottom', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id, { status: 'todo' })

    const moved = await cardService.move(
      { ...TOKEN, id: card.id, version: card.version, to_status: 'in_progress' },
      MGR,
    )
    expect(moved.status).toBe('in_progress')
    expect(moved.position).toBe(1000)
  })

  it('rejects move to unknown column', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id)

    await expect(
      cardService.move({ ...TOKEN, id: card.id, version: card.version, to_status: 'nonexistent' }, MGR),
    ).rejects.toMatchObject({ status: 400 })
  })
})

describe('CardService.release', () => {
  it('releases a claimed card back to unassigned', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id)
    const claimed = await cardService.claim({ ...TOKEN, id: card.id, version: card.version }, PM)

    const released = await cardService.release(
      { ...TOKEN, id: claimed.id, version: claimed.version },
      PM,
    )
    expect(released.assigned_to).toBeNull()
  })

  it('reverts status to todo on release by default', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id, { status: 'in_progress' })
    await cardService.claim({ ...TOKEN, id: card.id, version: card.version }, PM)
    const row = repo.findById(card.id)!

    const released = await cardService.release(
      { ...TOKEN, id: card.id, version: row.version },
      PM,
    )
    expect(released.status).toBe('todo')
  })

  it('keeps status when revert_to_status is null', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id, { status: 'in_progress' })
    await cardService.claim({ ...TOKEN, id: card.id, version: card.version }, PM)
    const row = repo.findById(card.id)!

    const released = await cardService.release(
      { ...TOKEN, id: card.id, version: row.version, revert_to_status: null },
      PM,
    )
    expect(released.status).toBe('in_progress')
  })

  it('is a no-op when card is already unassigned', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id)

    const result = await cardService.release(
      { ...TOKEN, id: card.id, version: card.version },
      PM,
    )
    expect(result.assigned_to).toBeNull()
    expect(result.version).toBe(card.version)
  })
})

describe('CardService.get', () => {
  it('returns card with body from disk', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id, { body: 'initial body content' })

    const fetched = await cardService.get({ id: card.id }, MGR)
    expect(fetched.id).toBe(card.id)
    expect(fetched.title).toBe('Test Card')
    expect(fetched.body).toBeDefined()
  })

  it('throws 404 for unknown card id', async () => {
    await setupWithActiveSprint()
    await expect(
      cardService.get({ id: 'card-doesnotexist' }, MGR),
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe('CardService — blocked advancement', () => {
  it('rejects advancing a blocked card past todo (409 blocked)', async () => {
    const sprint = await setupWithActiveSprint()
    const blocker = await createCard(sprint.id, { title: 'Blocker', status: 'todo' })
    const blocked = await createCard(sprint.id, {
      title: 'Blocked',
      status: 'todo',
      blocked_by: [blocker.id],
    })

    await expect(
      cardService.move(
        { ...TOKEN, id: blocked.id, version: blocked.version, to_status: 'in_progress' },
        MGR,
      ),
    ).rejects.toMatchObject({ status: 409, body: { error: 'blocked' } })
  })

  it('allows advancing when all blockers are done', async () => {
    const sprint = await setupWithActiveSprint()
    const blocker = await createCard(sprint.id, { title: 'Blocker', status: 'done' })
    const blocked = await createCard(sprint.id, {
      title: 'Blocked',
      status: 'todo',
      blocked_by: [blocker.id],
    })

    const moved = await cardService.move(
      { ...TOKEN, id: blocked.id, version: blocked.version, to_status: 'in_progress' },
      MGR,
    )
    expect(moved.status).toBe('in_progress')
  })
})

describe('CardService.bulkCreate', () => {
  it('creates multiple cards in one call', async () => {
    const sprint = await setupWithActiveSprint()

    const result = await cardService.bulkCreate(
      {
        project: 'test-project',
        sprint_id: sprint.id,
        cards: [
          { title: 'Task 1', type: 'task' },
          { title: 'Task 2', type: 'task' },
        ],
        input_tokens: 200,
        output_tokens: 100,
        model: 'test',
      },
      MGR,
    )

    expect(result.created).toHaveLength(2)
    expect(result.failed).toHaveLength(0)
    expect(result.created[0].card.title).toBe('Task 1')
    expect(result.created[1].card.title).toBe('Task 2')
  })

  it('returns partial success when some cards fail validation', async () => {
    const sprint = await setupWithActiveSprint()

    const result = await cardService.bulkCreate(
      {
        project: 'test-project',
        sprint_id: sprint.id,
        cards: [
          { title: 'Valid Task', type: 'task' },
          { title: 'x'.repeat(201), type: 'task' },
        ],
        model: 'test',
      },
      MGR,
    )

    expect(result.created).toHaveLength(1)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].index).toBe(1)
  })

  it('throws 400 when cards array is empty', async () => {
    await setupWithActiveSprint()
    await expect(
      cardService.bulkCreate({ cards: [], model: 'test' }, MGR),
    ).rejects.toMatchObject({ status: 400 })
  })
})

describe('CardService.logOnCard', () => {
  it('appends a log entry to the card body', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id)

    const result = await cardService.logOnCard(
      { ...TOKEN, id: card.id, version: card.version, log_entry: '## Progress\nDone something.' },
      PM,
    )
    expect(result.version).toBeGreaterThan(card.version)
  })

  it('throws 400 when log_entry is missing', async () => {
    const sprint = await setupWithActiveSprint()
    const card = await createCard(sprint.id)

    await expect(
      cardService.logOnCard({ ...TOKEN, id: card.id, version: card.version }, PM),
    ).rejects.toMatchObject({ status: 400 })
  })
})
