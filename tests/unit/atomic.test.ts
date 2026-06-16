import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Paths } from '../../src/config.js'
import { AtomicWriter, sha256 } from '../../src/writer/atomic.js'
import { serializeCard } from '../../src/cards/serialize.js'
import { createTempVault, cleanupVault, setupTestProject } from '../helpers/vault.js'
import { createTestDb, createTestRepo } from '../helpers/db.js'
import { makeCard } from '../helpers/factories.js'
import type { CardRepository } from '../../src/cards/repository.js'

let paths: Paths
let repo: CardRepository
let writer: AtomicWriter

beforeEach(async () => {
  paths = await createTempVault()
  const db = createTestDb()
  repo = createTestRepo(db)
  await setupTestProject(paths, 'proj')
  writer = new AtomicWriter(paths, repo)
})

afterEach(async () => {
  await cleanupVault(paths)
})

describe('sha256', () => {
  it('produces a 64-character hex string', () => {
    expect(sha256('hello')).toHaveLength(64)
    expect(sha256('hello')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic', () => {
    expect(sha256('same input')).toBe(sha256('same input'))
  })

  it('differs for different inputs', () => {
    expect(sha256('a')).not.toBe(sha256('b'))
  })
})

describe('AtomicWriter.write', () => {
  it('creates the .md file at the correct path', async () => {
    const card = makeCard({ project: 'proj' })
    await writer.write(card, 'body text', 'my-slug')
    const filePath = path.join(paths.kanbanData, 'proj', 'my-slug.md')
    await expect(fs.stat(filePath)).resolves.toBeDefined()
  })

  it('file content equals serializeCard output', async () => {
    const card = makeCard({ project: 'proj' })
    const body = 'card body content'
    await writer.write(card, body, 'my-slug')
    const filePath = path.join(paths.kanbanData, 'proj', 'my-slug.md')
    const content = await fs.readFile(filePath, 'utf8')
    expect(content).toBe(serializeCard(card, body))
  })

  it('tmp file is cleaned up after successful write', async () => {
    const card = makeCard({ project: 'proj' })
    await writer.write(card, 'body', 'my-slug')
    const tmpPath = path.join(paths.kanbanData, 'proj', 'my-slug.md.tmp')
    await expect(fs.stat(tmpPath)).rejects.toThrow()
  })

  it('upserts the card in the repository', async () => {
    const card = makeCard({ project: 'proj', id: 'card-upsert01' })
    await writer.write(card, 'body', 'my-slug')
    const found = repo.findById('card-upsert01')
    expect(found).not.toBeNull()
  })

  it('returns the correct fileHash', async () => {
    const card = makeCard({ project: 'proj' })
    const body = 'some body'
    const { fileHash } = await writer.write(card, body, 'my-slug')
    const expectedHash = sha256(serializeCard(card, body))
    expect(fileHash).toBe(expectedHash)
  })

  it('auto-creates the project directory if missing', async () => {
    const card = makeCard({ project: 'newproject' })
    await writer.write(card, 'body', 'slug')
    const dirPath = path.join(paths.kanbanData, 'newproject')
    const stat = await fs.stat(dirPath)
    expect(stat.isDirectory()).toBe(true)
  })

  it('deletes the old file when previousBasename differs', async () => {
    // Create old file first
    const oldPath = path.join(paths.kanbanData, 'proj', 'old-slug.md')
    await fs.writeFile(oldPath, 'old content', 'utf8')

    const card = makeCard({ project: 'proj' })
    await writer.write(card, 'body', 'new-slug', { previousBasename: 'old-slug' })

    // New file exists
    const newPath = path.join(paths.kanbanData, 'proj', 'new-slug.md')
    await expect(fs.stat(newPath)).resolves.toBeDefined()
    // Old file is gone
    await expect(fs.stat(oldPath)).rejects.toThrow()
  })

  it('does not delete the file when previousBasename equals basename', async () => {
    const card = makeCard({ project: 'proj' })
    await writer.write(card, 'body', 'same-slug', { previousBasename: 'same-slug' })
    const filePath = path.join(paths.kanbanData, 'proj', 'same-slug.md')
    await expect(fs.stat(filePath)).resolves.toBeDefined()
  })

  it('silently ignores ENOENT when previousBasename file does not exist', async () => {
    const card = makeCard({ project: 'proj' })
    await expect(
      writer.write(card, 'body', 'new-slug', { previousBasename: 'ghost-slug' }),
    ).resolves.not.toThrow()
  })
})
