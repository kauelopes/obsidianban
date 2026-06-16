import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Paths } from '../../src/config.js'
import { pathsFor } from '../../src/config.js'
import { ensureLayout, ensureProject, saveProjectMeta } from '../../src/vault/layout.js'
import type { ProjectMeta } from '../../src/vault/layout.js'
import { DEFAULT_COLUMNS } from '../../src/vault/layout.js'
import type { Sprint } from '@obsidiankan/types'

export async function createTempVault(): Promise<Paths> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidiankan-test-'))
  const paths = pathsFor(dir)
  await ensureLayout(paths)
  return paths
}

export async function cleanupVault(paths: Paths): Promise<void> {
  await fs.rm(paths.vault, { recursive: true, force: true })
}

export async function setupTestProject(
  paths: Paths,
  project: string,
  sprint?: Sprint,
): Promise<ProjectMeta> {
  await ensureProject(paths, project)
  const meta: ProjectMeta = {
    project_id: project,
    columns: [...DEFAULT_COLUMNS],
    agent_tokens: [],
    created_at: '2026-01-01T00:00:00.000Z',
    sprints: sprint ? [sprint] : [],
  }
  await saveProjectMeta(paths, project, meta)
  return meta
}

export async function writeCardFile(
  paths: Paths,
  project: string,
  basename: string,
  content: string,
): Promise<void> {
  const dir = path.join(paths.kanbanData, project)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${basename}.md`), content, 'utf8')
}
