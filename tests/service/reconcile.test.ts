import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Paths } from '../../src/config.js'
import { createTempVault, cleanupVault, setupTestProject, writeCardFile } from '../helpers/vault.js'
import { createTestDb, createTestRepo } from '../helpers/db.js'
import { makeCard, makeSprint } from '../helpers/factories.js'
import { reconcile } from '../../src/startup/reconcile.js'
import { serializeCard } from '../../src/cards/serialize.js'
import { sha256 } from '../../src/writer/atomic.js'
import type { CardRepository } from '../../src/cards/repository.js'
import type { AuditLogger } from '../../src/audit/logger.js'

let paths: Paths
let repo: CardRepository
const audit = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogger

function buildCardFile(overrides = {}): string {
  const card = makeCard(overrides)
  const { file_basename: _fb, ...cardWithoutBasename } = card
  return serializeCard(cardWithoutBasename as Parameters<typeof serializeCard>[0], '')
}

beforeEach(async () => {
  paths = await createTempVault()
  const db = createTestDb()
  repo = createTestRepo(db)
  vi.clearAllMocks()
})

afterEach(async () => {
  await cleanupVault(paths)
})

describe('reconcile — DB sync from disk', () => {
  it('inserts a card from disk into the empty DB', async () => {
    await setupTestProject(paths, 'test-project', makeSprint({ status: 'active' }))
    const content = buildCardFile()
    await writeCardFile(paths, 'test-project', 'test-card', content)

    const report = await reconcile(paths, repo, audit, { sqliteRebuilt: false })
    expect(report.scanned).toBe(1)
    expect(report.reconciled).toBe(1)
    expect(report.orphansRemoved).toBe(0)
    expect(report.parseErrors).toBe(0)

    const row = repo.findById('card-testcard1')
    expect(row).not.toBeNull()
    expect(row?.title).toBe('Test Card')
  })

  it('does not re-process unchanged files (hash discrimination)', async () => {
    await setupTestProject(paths, 'test-project', makeSprint({ status: 'active' }))
    const content = buildCardFile()
    await writeCardFile(paths, 'test-project', 'test-card', content)

    // First reconcile
    await reconcile(paths, repo, audit, { sqliteRebuilt: false })
    vi.clearAllMocks()

    // Second reconcile — file unchanged, should produce 0 reconciled
    const report = await reconcile(paths, repo, audit, { sqliteRebuilt: false })
    expect(report.reconciled).toBe(0)
  })

  it('removes orphan cards from the DB when .md file is deleted', async () => {
    await setupTestProject(paths, 'test-project', makeSprint({ status: 'active' }))
    const content = buildCardFile()
    await writeCardFile(paths, 'test-project', 'test-card', content)
    await reconcile(paths, repo, audit, { sqliteRebuilt: false })

    // Delete the file
    await fs.unlink(path.join(paths.kanbanData, 'test-project', 'test-card.md'))

    const report = await reconcile(paths, repo, audit, { sqliteRebuilt: false })
    expect(report.orphansRemoved).toBe(1)
    expect(repo.findById('card-testcard1')).toBeNull()
  })

  it('counts parse errors without throwing (best-effort)', async () => {
    await setupTestProject(paths, 'test-project')
    await writeCardFile(paths, 'test-project', 'bad-card', '---\ninvalid frontmatter here\n---\n')

    const report = await reconcile(paths, repo, audit, { sqliteRebuilt: false })
    expect(report.parseErrors).toBeGreaterThanOrEqual(1)
    expect(report.reconciled).toBe(0)
  })

  it('logs project mismatch as parse error and skips card', async () => {
    await setupTestProject(paths, 'test-project')
    // Card has project: 'other-project' but lives under test-project/
    const content = buildCardFile({ project: 'other-project' })
    await writeCardFile(paths, 'test-project', 'test-card', content)

    const report = await reconcile(paths, repo, audit, { sqliteRebuilt: false })
    expect(report.parseErrors).toBe(1)
    expect(repo.findById('card-testcard1')).toBeNull()
  })
})

describe('reconcile — hash re-processing on change', () => {
  it('reconciles a card again when its content changes', async () => {
    await setupTestProject(paths, 'test-project', makeSprint({ status: 'active' }))
    const content = buildCardFile()
    const filePath = path.join(paths.kanbanData, 'test-project', 'test-card.md')
    await writeCardFile(paths, 'test-project', 'test-card', content)
    await reconcile(paths, repo, audit, { sqliteRebuilt: false })

    // Mutate the file (new version in frontmatter)
    const updated = buildCardFile({ version: 2, title: 'Updated Title' })
    await fs.writeFile(filePath, updated, 'utf8')

    const report = await reconcile(paths, repo, audit, { sqliteRebuilt: false })
    expect(report.reconciled).toBe(1)
    expect(repo.findById('card-testcard1')?.title).toBe('Updated Title')
  })
})
