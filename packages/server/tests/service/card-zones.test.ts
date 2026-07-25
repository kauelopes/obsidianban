import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Paths } from '../../src/config.js'
import { createTempVault, cleanupVault, setupTestProject } from '../helpers/vault.js'
import { createTestDb, createTestRepo } from '../helpers/db.js'
import { makeManagerClaims, makeAgentClaims, makeDevClaims } from '../helpers/factories.js'
import { CardService } from '../../src/services/card.js'
import { SprintService } from '../../src/services/sprint.js'
import { AtomicWriter } from '../../src/writer/atomic.js'
import { SSEEventBus } from '../../src/server/sse.js'
import { parseSections } from '@obsidiankan/types'
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
const DEV = makeDevClaims()

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

/** A card carrying all three zones, with the log written the normal way. */
async function cardWithLog() {
  const sprint = await setupWithActiveSprint()
  const created = await cardService.create(
    {
      ...TOKEN,
      title: 'Test Card',
      type: 'task',
      project: 'test-project',
      sprint_id: sprint.id,
      body: '# Spec\n\nspec original',
    },
    MGR,
  )
  const logged = await cardService.logOnCard(
    { ...TOKEN, id: created.id, version: created.version, log_entry: 'primeira entrada' },
    MGR,
  )
  return logged
}

describe('kanban_update_spec — access', () => {
  it('refuses a dev agent with 403', async () => {
    const card = await cardWithLog()
    await expect(
      cardService.updateSpec({ ...TOKEN, id: card.id, version: card.version, spec: 'novo' }, DEV),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('points the refused dev agent at the zone it may write', async () => {
    const card = await cardWithLog()
    const err = await cardService
      .updateSpec({ ...TOKEN, id: card.id, version: card.version, spec: 'novo' }, DEV)
      .then(() => null)
      .catch((e: unknown) => e as HttpError)

    const body = err!.body as Record<string, unknown>
    expect(body['reason']).toBe('spec_is_read_only_for_dev')
    expect(body['allowed_tool']).toBe('kanban_update_notes')
    expect(String(body['message'])).not.toContain('kanban_update_card')
  })

  it('leaves the card untouched when the dev agent is refused', async () => {
    const card = await cardWithLog()
    await cardService
      .updateSpec({ ...TOKEN, id: card.id, version: card.version, spec: 'novo' }, DEV)
      .catch(() => undefined)
    const after = await cardService.get({ id: card.id }, MGR)
    expect(after.version).toBe(card.version)
    expect(parseSections(after.body).spec).toBe('spec original')
  })

  it('succeeds for a pm agent and leaves # Agent Log intact', async () => {
    const card = await cardWithLog()
    const before = parseSections(card.body).agentLog
    expect(before).toContain('primeira entrada')

    const updated = await cardService.updateSpec(
      { ...TOKEN, id: card.id, version: card.version, spec: 'spec reescrita pelo PM' },
      PM,
    )
    const zones = parseSections(updated.body)
    expect(zones.spec).toBe('spec reescrita pelo PM')
    expect(zones.agentLog).toBe(before)
    expect(updated.version).toBe(card.version + 1)
  })

  it('succeeds for a manager', async () => {
    const card = await cardWithLog()
    const updated = await cardService.updateSpec(
      { ...TOKEN, id: card.id, version: card.version, spec: 'spec do humano' },
      MGR,
    )
    expect(parseSections(updated.body).spec).toBe('spec do humano')
    expect(updated.updated_by).toBe(MGR.actor)
  })
})

describe('kanban_update_notes — access', () => {
  it('allows a dev agent to write Notes', async () => {
    const card = await cardWithLog()
    const updated = await cardService.updateNotes(
      { ...TOKEN, id: card.id, version: card.version, notes: 'abordagem escolhida: X' },
      DEV,
    )
    expect(parseSections(updated.body).notes).toBe('abordagem escolhida: X')
  })

  it('leaves Spec and Agent Log untouched', async () => {
    const card = await cardWithLog()
    const before = parseSections(card.body)
    const updated = await cardService.updateNotes(
      { ...TOKEN, id: card.id, version: card.version, notes: 'memoria' },
      DEV,
    )
    const after = parseSections(updated.body)
    expect(after.spec).toBe(before.spec)
    expect(after.agentLog).toBe(before.agentLog)
  })

  it('replaces rather than appends — Notes is not history', async () => {
    const card = await cardWithLog()
    const first = await cardService.updateNotes(
      { ...TOKEN, id: card.id, version: card.version, notes: 'primeira' },
      DEV,
    )
    const second = await cardService.updateNotes(
      { ...TOKEN, id: first.id, version: first.version, notes: 'segunda' },
      DEV,
    )
    const notes = parseSections(second.body).notes
    expect(notes).toBe('segunda')
    expect(notes).not.toContain('primeira')
  })
})

describe('zone writes — optimistic locking', () => {
  it('returns 409 with current_card on a stale version', async () => {
    const card = await cardWithLog()
    await cardService.updateSpec({ ...TOKEN, id: card.id, version: card.version, spec: 'A' }, PM)

    const err = await cardService
      .updateSpec({ ...TOKEN, id: card.id, version: card.version, spec: 'B' }, PM)
      .then(() => null)
      .catch((e: unknown) => e as HttpError)

    expect(err).not.toBeNull()
    expect(err!.status).toBe(409)
    const detail = err!.body as Record<string, unknown>
    expect(detail['current_version']).toBe(card.version + 1)
    expect(detail['current_card']).toBeDefined()
    expect(detail['conflicting_fields']).toContain('body')
  })

  it('the losing write does not reach the card', async () => {
    const card = await cardWithLog()
    await cardService.updateSpec({ ...TOKEN, id: card.id, version: card.version, spec: 'A' }, PM)
    await cardService
      .updateSpec({ ...TOKEN, id: card.id, version: card.version, spec: 'B' }, PM)
      .catch(() => undefined)

    const after = await cardService.get({ id: card.id }, MGR)
    expect(parseSections(after.body).spec).toBe('A')
  })
})

describe('zone writes — validation', () => {
  it('rejects an absent spec field', async () => {
    const card = await cardWithLog()
    await expect(
      cardService.updateSpec({ ...TOKEN, id: card.id, version: card.version }, PM),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('rejects a non-string spec', async () => {
    const card = await cardWithLog()
    await expect(
      cardService.updateSpec({ ...TOKEN, id: card.id, version: card.version, spec: 42 }, PM),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('rejects fields outside the allow-list', async () => {
    const card = await cardWithLog()
    await expect(
      cardService.updateSpec(
        { ...TOKEN, id: card.id, version: card.version, spec: 'x', title: 'nope' },
        PM,
      ),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('still refuses a raw body write through kanban_update_card', async () => {
    const card = await cardWithLog()
    await expect(
      cardService.update({ ...TOKEN, id: card.id, version: card.version, body: 'tudo' }, MGR),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('clears the zone on an empty string, keeping the other zones', async () => {
    const card = await cardWithLog()
    const updated = await cardService.updateSpec(
      { ...TOKEN, id: card.id, version: card.version, spec: '' },
      PM,
    )
    const zones = parseSections(updated.body)
    expect(zones.spec).toBe('')
    expect(zones.agentLog).toContain('primeira entrada')
  })
})

describe('zone writes — legacy cards', () => {
  it('promotes a heading-less body to Spec and preserves it under Notes writes', async () => {
    const sprint = await setupWithActiveSprint()
    const created = await cardService.create(
      {
        ...TOKEN,
        title: 'Legado',
        type: 'task',
        project: 'test-project',
        sprint_id: sprint.id,
        body: 'descricao antiga sem headings',
      },
      MGR,
    )
    expect(parseSections(created.body).spec).toBe('descricao antiga sem headings')

    const updated = await cardService.updateNotes(
      { ...TOKEN, id: created.id, version: created.version, notes: 'nota nova' },
      DEV,
    )
    const zones = parseSections(updated.body)
    expect(zones.spec).toBe('descricao antiga sem headings')
    expect(zones.notes).toBe('nota nova')
  })

  it('appending a log after a zone write keeps all three zones', async () => {
    const card = await cardWithLog()
    const withNotes = await cardService.updateNotes(
      { ...TOKEN, id: card.id, version: card.version, notes: 'memoria' },
      DEV,
    )
    const logged = await cardService.logOnCard(
      { ...TOKEN, id: withNotes.id, version: withNotes.version, log_entry: 'segunda entrada' },
      MGR,
    )
    const zones = parseSections(logged.body)
    expect(zones.spec).toBe('spec original')
    expect(zones.notes).toBe('memoria')
    expect(zones.agentLog).toContain('primeira entrada')
    expect(zones.agentLog).toContain('segunda entrada')
  })
})
