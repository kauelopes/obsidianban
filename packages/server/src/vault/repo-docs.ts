import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { KadFile } from '@obsidiankan/types'
import type { Paths } from '../config.js'
import { loadProjectMetaOrNull } from './layout.js'

/**
 * Limite de profundidade puramente defensivo — `docs/` de um repo real nunca
 * chega perto disso; existe só para não seguir um symlink cíclico indefinidamente.
 */
const MAX_DEPTH = 8

export function repoDocsDir(targetRepo: string): string {
  return path.join(targetRepo, 'docs')
}

/**
 * `target_repo` é opcional por projeto (kanban_set_project_repo) — sem ele,
 * ou sem `docs/` dentro dele, a lista é vazia, não erro.
 */
export async function listRepoDocs(paths: Paths, project: string): Promise<KadFile[]> {
  const meta = await loadProjectMetaOrNull(paths, project)
  if (!meta?.target_repo) return []
  const dir = repoDocsDir(meta.target_repo)

  const files: KadFile[] = []
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(current, e.name)
      if (e.isDirectory()) {
        await walk(full, depth + 1)
      } else if (e.isFile() && e.name.endsWith('.md')) {
        const rel = path.relative(dir, full)
        const id = rel.slice(0, -'.md'.length).split(path.sep).join('/')
        const stat = await fs.stat(full)
        files.push({ id, label: id, mtime: stat.mtime.toISOString() })
      }
    }
  }
  await walk(dir, 0)
  files.sort((a, b) => a.id.localeCompare(b.id))
  return files
}

/** Aceita subpastas (`kad/vision`) mas nunca `..` — um segmento por vez, cada um seguro. */
function isSafeRelativeId(id: string): boolean {
  if (id.startsWith('/') || id.includes('\\')) return false
  const segments = id.split('/')
  return segments.every((s) => s.length > 0 && s !== '.' && s !== '..')
}

export async function readRepoDoc(paths: Paths, project: string, docId: string): Promise<string | null> {
  if (!isSafeRelativeId(docId)) return null
  const meta = await loadProjectMetaOrNull(paths, project)
  if (!meta?.target_repo) return null
  const dir = path.resolve(repoDocsDir(meta.target_repo))
  const file = path.resolve(dir, `${docId}.md`)
  // Defesa em profundidade, mesma postura de vault/kad.ts e server/static.ts.
  if (!file.startsWith(dir + path.sep)) return null
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}
