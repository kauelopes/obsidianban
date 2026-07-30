import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Paths } from '../../src/config.js'
import { createTempVault, cleanupVault, setupTestProject, writeCardFile } from '../helpers/vault.js'
import { createTestDb, createTestRepo } from '../helpers/db.js'
import { makeCard, makeManagerClaims, makeSprint } from '../helpers/factories.js'
import { serializeCard } from '../../src/cards/serialize.js'
import { reconcile } from '../../src/startup/reconcile.js'
import { SupervisionService } from '../../src/services/supervision.js'
import type { CardRepository } from '../../src/cards/repository.js'
import type { AuditLogger } from '../../src/audit/logger.js'
import { STALE_IN_PROGRESS_MS } from '../../src/util/constants.js'

let paths: Paths
let repo: CardRepository
let service: SupervisionService
const audit = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogger
const MGR = makeManagerClaims()

const OLD_TS = new Date(Date.now() - STALE_IN_PROGRESS_MS - 60_000).toISOString()
const RECENT_TS = new Date(Date.now() - 60_000).toISOString()

function buildCardFile(overrides: Parameters<typeof makeCard>[0] = {}): string {
  const card = makeCard(overrides)
  const { file_basename: _fb, ...cardWithoutBasename } = card
  return serializeCard(cardWithoutBasename as Parameters<typeof serializeCard>[0], '')
}

beforeEach(async () => {
  paths = await createTempVault()
  const db = createTestDb()
  repo = createTestRepo(db)
  service = new SupervisionService(paths, repo)
  vi.clearAllMocks()
})

afterEach(async () => {
  await cleanupVault(paths)
})

describe('SupervisionService.listEscalations — stuck_in_progress', () => {
  it('includes an in_progress card whose updated_at is older than the stale threshold', async () => {
    await setupTestProject(paths, 'test-project', makeSprint({ status: 'active' }))
    const content = buildCardFile({
      id: 'card-stale1',
      file_basename: 'stale-card',
      status: 'in_progress',
      updated_at: OLD_TS,
      assigned_to: 'agent:dev-agent',
    })
    await writeCardFile(paths, 'test-project', 'stale-card', content)
    await reconcile(paths, repo, audit, { sqliteRebuilt: false })

    const result = await service.listEscalations({}, MGR)

    expect(result.stuck_in_progress.map((i) => i.card_id)).toEqual(['card-stale1'])
    expect(result.escalations.map((i) => i.card_id)).not.toContain('card-stale1')
  })

  it('excludes an in_progress card whose updated_at is recent', async () => {
    await setupTestProject(paths, 'test-project', makeSprint({ status: 'active' }))
    const content = buildCardFile({
      id: 'card-fresh1',
      file_basename: 'fresh-card',
      status: 'in_progress',
      updated_at: RECENT_TS,
      assigned_to: 'agent:dev-agent',
    })
    await writeCardFile(paths, 'test-project', 'fresh-card', content)
    await reconcile(paths, repo, audit, { sqliteRebuilt: false })

    const result = await service.listEscalations({}, MGR)

    expect(result.stuck_in_progress).toEqual([])
  })

  it('keeps a review card in escalations only, never in stuck_in_progress', async () => {
    await setupTestProject(paths, 'test-project', makeSprint({ status: 'active' }))
    const content = buildCardFile({
      id: 'card-review1',
      file_basename: 'review-card',
      status: 'review',
      updated_at: OLD_TS,
    })
    await writeCardFile(paths, 'test-project', 'review-card', content)
    await reconcile(paths, repo, audit, { sqliteRebuilt: false })

    const result = await service.listEscalations({}, MGR)

    expect(result.escalations.map((i) => i.card_id)).toEqual(['card-review1'])
    expect(result.stuck_in_progress).toEqual([])
  })

  it('excludes a stale in_progress card assigned to a job (job: prefix), even with jobManager null', async () => {
    await setupTestProject(paths, 'test-project', makeSprint({ status: 'active' }))
    const content = buildCardFile({
      id: 'card-job1',
      file_basename: 'job-card',
      status: 'in_progress',
      updated_at: OLD_TS,
      assigned_to: 'job:xyz',
    })
    await writeCardFile(paths, 'test-project', 'job-card', content)
    await reconcile(paths, repo, audit, { sqliteRebuilt: false })

    const result = await service.listEscalations({}, MGR)

    expect(result.stuck_in_progress).toEqual([])
  })
})
