import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Paths } from '../../src/config.js'
import { createTempVault, cleanupVault, setupTestProject } from '../helpers/vault.js'
import { createTestDb, createTestRepo } from '../helpers/db.js'
import { makeCard, makeSprint } from '../helpers/factories.js'
import { FileWatcher } from '../../src/watcher/file-watcher.js'
import { AtomicWriter } from '../../src/writer/atomic.js'
import { parseCardFile, extractBodyRaw } from '../../src/cards/serialize.js'
import type { CardRepository } from '../../src/cards/repository.js'
import type { AuditLogger } from '../../src/audit/logger.js'
import type { SSEEventBus } from '../../src/server/sse.js'

const BODY = [
  '# Spec',
  '',
  'Conteudo escrito pelo humano que nao pode ser perdido.',
  '',
  '# Agent Log',
  '',
  '**2026-06-01T00:53:07Z**',
  '',
  'Primeira passada do dev agent.',
].join('\n')

let paths: Paths
let repo: CardRepository
let writer: AtomicWriter
let watcher: FileWatcher
const audit = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogger
const sse = { emit: vi.fn() } as unknown as SSEEventBus

// The watcher's reconciliation entry point is private; driving it directly
// keeps the test deterministic instead of racing chokidar's debounce.
function process(filePath: string): Promise<void> {
  return (watcher as unknown as { process(p: string): Promise<void> }).process(filePath)
}

function cardPath(basename: string): string {
  return path.join(paths.kanbanData, 'test-project', `${basename}.md`)
}

async function seedCard(): Promise<string> {
  const card = makeCard()
  await writer.write(card, BODY, 'test-card')
  return cardPath('test-card')
}

beforeEach(async () => {
  paths = await createTempVault()
  await setupTestProject(paths, 'test-project', makeSprint({ status: 'active' }))
  const db = createTestDb()
  repo = createTestRepo(db)
  writer = new AtomicWriter(paths, repo)
  watcher = new FileWatcher(paths, repo, writer, audit, sse)
  vi.clearAllMocks()
})

afterEach(async () => {
  await cleanupVault(paths)
})

describe('watcher revert — body preservation', () => {
  it('preserves the body when the frontmatter fails to parse as YAML', async () => {
    const file = await seedCard()
    await fs.writeFile(file, `---\n: : não é yaml : :\n---\n${BODY}`, 'utf8')

    await process(file)

    const after = parseCardFile(await fs.readFile(file, 'utf8'))
    expect(after.body.trim()).toBe(BODY.trim())
    expect(after.data['id']).toBe('card-testcard1')
  })

  it('preserves the body when the id field is tampered with', async () => {
    const file = await seedCard()
    const original = await fs.readFile(file, 'utf8')
    await fs.writeFile(file, original.replace('id: card-testcard1', 'id: card-hijacked'), 'utf8')

    await process(file)

    const after = parseCardFile(await fs.readFile(file, 'utf8'))
    expect(after.body.trim()).toBe(BODY.trim())
    expect(after.data['id']).toBe('card-testcard1')
  })

  it('preserves the body when a frontmatter field has the wrong type', async () => {
    const file = await seedCard()
    const original = await fs.readFile(file, 'utf8')
    await fs.writeFile(file, original.replace('priority: medium', 'priority: urgentissimo'), 'utf8')

    await process(file)

    const after = parseCardFile(await fs.readFile(file, 'utf8'))
    expect(after.body.trim()).toBe(BODY.trim())
    expect(after.data['priority']).toBe('medium')
  })

  it('preserves the body when the frontmatter block is removed entirely', async () => {
    const file = await seedCard()
    await fs.writeFile(file, BODY, 'utf8')

    await process(file)

    const after = parseCardFile(await fs.readFile(file, 'utf8'))
    expect(after.body.trim()).toBe(BODY.trim())
    expect(after.data['id']).toBe('card-testcard1')
  })
})

describe('extractBodyRaw', () => {
  it('strips an unparseable frontmatter block', () => {
    expect(extractBodyRaw(`---\n: : :\n---\n# Spec\n\ncorpo`)).toBe('# Spec\n\ncorpo')
  })

  it('returns the whole text when there is no frontmatter fence', () => {
    expect(extractBodyRaw('# Spec\n\ncorpo')).toBe('# Spec\n\ncorpo')
  })

  it('returns the whole text when the opening fence is never closed', () => {
    const text = '---\nid: card-1\n# Spec'
    expect(extractBodyRaw(text)).toBe(text)
  })

  it('keeps --- separators that appear inside the body', () => {
    expect(extractBodyRaw('---\nid: x\n---\nantes\n\n---\n\ndepois')).toBe(
      'antes\n\n---\n\ndepois',
    )
  })
})
