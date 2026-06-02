import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Paths } from '../config.js'
import type { Sprint } from '../types.js'

export const DEFAULT_COLUMNS = ['backlog', 'todo', 'in_progress', 'review', 'done'] as const

export interface ProjectMeta {
  project_id: string
  columns: string[]
  agent_tokens: TokenRecord[]
  created_at: string
  /** Optional — absent on legacy metas means the project is active. */
  archived?: boolean
  /** Optional — absent on legacy metas means no sprints declared yet. */
  sprints?: Sprint[]
}

export interface TokenRecord {
  token_id: string
  sha256: string
  actor: string
  /** 'pm' = project-manager agent (full write); 'dev' = developer agent (log-only). Absent on legacy records → treated as 'pm'. */
  agent_type?: 'pm' | 'dev'
  created_at: string
  revoked_at: string | null
}

export async function ensureLayout(paths: Paths): Promise<void> {
  await fs.mkdir(paths.kanbanData, { recursive: true })
  await fs.mkdir(paths.kanbanInternal, { recursive: true })
}

export async function listProjects(paths: Paths): Promise<string[]> {
  const entries = await fs.readdir(paths.kanbanData, { withFileTypes: true })
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
}

export function projectDir(paths: Paths, project: string): string {
  return path.join(paths.kanbanData, project)
}

export function metaPath(paths: Paths, project: string): string {
  return path.join(projectDir(paths, project), '_meta.json')
}

export async function ensureProject(paths: Paths, project: string): Promise<ProjectMeta> {
  const dir = projectDir(paths, project)
  await fs.mkdir(dir, { recursive: true })
  const file = metaPath(paths, project)
  try {
    const raw = await fs.readFile(file, 'utf8')
    return JSON.parse(raw) as ProjectMeta
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    const meta: ProjectMeta = {
      project_id: project,
      columns: [...DEFAULT_COLUMNS],
      agent_tokens: [],
      created_at: new Date().toISOString(),
    }
    await fs.writeFile(file, JSON.stringify(meta, null, 2) + '\n', 'utf8')
    return meta
  }
}

export async function loadProjectMeta(paths: Paths, project: string): Promise<ProjectMeta> {
  const file = metaPath(paths, project)
  const raw = await fs.readFile(file, 'utf8')
  const meta = JSON.parse(raw) as ProjectMeta
  let dirty = false
  // Backfill: pre-planning-status sprints had no `created_at` and always had
  // `started_at` set on create. The new schema separates the two, so when
  // reading legacy records we copy started_at into created_at.
  if (meta.sprints) {
    for (const s of meta.sprints) {
      if (s.created_at == null && s.started_at != null) {
        s.created_at = s.started_at
        dirty = true
      }
    }
  }
  // Backfill: column slugs historically used hyphens ('in-progress').
  // Canonical form is underscores ('in_progress'). Fix on first load.
  if (meta.columns) {
    const fixed = meta.columns.map((c) => c === 'in-progress' ? 'in_progress' : c)
    if (fixed.some((c, i) => c !== meta.columns[i])) {
      meta.columns = fixed
      dirty = true
    }
  }
  if (dirty) {
    await fs.writeFile(file, JSON.stringify(meta, null, 2) + '\n', 'utf8')
  }
  return meta
}

export async function saveProjectMeta(
  paths: Paths,
  project: string,
  meta: ProjectMeta,
): Promise<void> {
  await fs.writeFile(metaPath(paths, project), JSON.stringify(meta, null, 2) + '\n', 'utf8')
}

export async function findActiveSprint(paths: Paths, project: string): Promise<Sprint | null> {
  const meta = await loadProjectMeta(paths, project).catch(() => null)
  return (meta?.sprints ?? []).find((s) => s.status === 'active') ?? null
}

export async function cleanupOrphanTmpFiles(paths: Paths): Promise<number> {
  let removed = 0
  const projects = await listProjects(paths).catch(() => [])
  for (const project of projects) {
    const dir = projectDir(paths, project)
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.tmp')) {
        await fs.unlink(path.join(dir, entry.name))
        removed++
      }
    }
  }
  return removed
}
