import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Paths } from '../../src/config.js'
import { createTempVault, cleanupVault } from '../helpers/vault.js'
import {
  loadProjectMeta,
  saveProjectMeta,
  findActiveSprint,
  cleanupOrphanTmpFiles,
  ensureProject,
  metaPath,
} from '../../src/vault/layout.js'

let paths: Paths

beforeEach(async () => {
  paths = await createTempVault()
})

afterEach(async () => {
  await cleanupVault(paths)
})

describe('loadProjectMeta — sprint created_at backfill', () => {
  it('copies started_at into created_at for legacy sprints missing created_at', async () => {
    await ensureProject(paths, 'test-project')
    const file = metaPath(paths, 'test-project')
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))
    raw.sprints = [
      {
        id: 'sprint-001',
        name: 'S1',
        status: 'active',
        started_at: '2024-01-01T00:00:00.000Z',
        created_at: null,
        closed_at: null,
        goal: null,
        promoted_to_todo: [],
      },
    ]
    await fs.writeFile(file, JSON.stringify(raw, null, 2) + '\n', 'utf8')

    const meta = await loadProjectMeta(paths, 'test-project')
    expect(meta.sprints![0].created_at).toBe('2024-01-01T00:00:00.000Z')

    // Verify it was persisted to disk
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(onDisk.sprints[0].created_at).toBe('2024-01-01T00:00:00.000Z')
  })

  it('does not rewrite file when no backfill is needed', async () => {
    await ensureProject(paths, 'test-project')
    const file = metaPath(paths, 'test-project')
    const before = (await fs.stat(file)).mtimeMs

    await loadProjectMeta(paths, 'test-project')
    const after = (await fs.stat(file)).mtimeMs
    expect(after).toBe(before)
  })
})

describe('loadProjectMeta — column slug backfill', () => {
  it('replaces in-progress with in_progress on first load', async () => {
    await ensureProject(paths, 'test-project')
    const file = metaPath(paths, 'test-project')
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))
    raw.columns = ['backlog', 'todo', 'in-progress', 'done']
    await fs.writeFile(file, JSON.stringify(raw, null, 2) + '\n', 'utf8')

    const meta = await loadProjectMeta(paths, 'test-project')
    expect(meta.columns).toContain('in_progress')
    expect(meta.columns).not.toContain('in-progress')

    // Persisted to disk
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(onDisk.columns).toContain('in_progress')
  })
})

describe('saveProjectMeta', () => {
  it('persists meta changes to disk', async () => {
    const meta = await ensureProject(paths, 'test-project')
    meta.columns = ['todo', 'done']
    await saveProjectMeta(paths, 'test-project', meta)

    const loaded = await loadProjectMeta(paths, 'test-project')
    expect(loaded.columns).toEqual(['todo', 'done'])
  })
})

describe('findActiveSprint', () => {
  it('returns active sprint from meta', async () => {
    await ensureProject(paths, 'test-project')
    const file = metaPath(paths, 'test-project')
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))
    raw.sprints = [
      {
        id: 'sprint-active',
        name: 'Active',
        status: 'active',
        started_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        closed_at: null,
        goal: null,
        promoted_to_todo: [],
      },
    ]
    await fs.writeFile(file, JSON.stringify(raw, null, 2) + '\n', 'utf8')

    const sprint = await findActiveSprint(paths, 'test-project')
    expect(sprint?.id).toBe('sprint-active')
    expect(sprint?.status).toBe('active')
  })

  it('returns null when no active sprint exists', async () => {
    await ensureProject(paths, 'test-project')
    const sprint = await findActiveSprint(paths, 'test-project')
    expect(sprint).toBeNull()
  })

  it('returns null when project does not exist', async () => {
    const sprint = await findActiveSprint(paths, 'nonexistent-project')
    expect(sprint).toBeNull()
  })
})

describe('cleanupOrphanTmpFiles', () => {
  it('removes .tmp files from project directories', async () => {
    await ensureProject(paths, 'test-project')
    const tmpFile = path.join(paths.kanbanData, 'test-project', 'card-abc.tmp')
    await fs.writeFile(tmpFile, 'stale write', 'utf8')

    const removed = await cleanupOrphanTmpFiles(paths)
    expect(removed).toBe(1)

    await expect(fs.access(tmpFile)).rejects.toThrow()
  })

  it('ignores non-.tmp files', async () => {
    await ensureProject(paths, 'test-project')
    const mdFile = path.join(paths.kanbanData, 'test-project', 'card-abc.md')
    await fs.writeFile(mdFile, '---\nid: card-abc\n---\n', 'utf8')

    const removed = await cleanupOrphanTmpFiles(paths)
    expect(removed).toBe(0)

    await expect(fs.access(mdFile)).resolves.toBeUndefined()
  })

  it('returns 0 when there are no projects', async () => {
    const removed = await cleanupOrphanTmpFiles(paths)
    expect(removed).toBe(0)
  })
})
