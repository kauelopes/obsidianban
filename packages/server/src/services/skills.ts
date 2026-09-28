import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { REQUIRED_SKILL_FILES, resolveSkillsSource } from './workflow-readiness.js'
import { badRequest, notFound } from './errors.js'
import type { SkillFileEntry } from '@obsidiankan/types'

/**
 * Lista fixa, não passeio de diretório: os mesmos arquivos que
 * workflow-readiness replica para cada projeto — nada além disso é editável
 * por aqui.
 */
export function listSkillFiles(): SkillFileEntry[] {
  return REQUIRED_SKILL_FILES.map((relPath) => ({
    skill: relPath.split('/')[0]!,
    path: relPath,
  }))
}

function resolveSkillFilePath(relPath: string): string {
  if (!REQUIRED_SKILL_FILES.includes(relPath)) throw badRequest('unknown_skill_file', { path: relPath })
  const root = path.resolve(resolveSkillsSource())
  const file = path.resolve(root, relPath)
  // Defesa em profundidade — mesma postura de vault/repo-docs.ts — ainda que
  // a checagem acima já restrinja relPath a uma lista fixa, sem `..`.
  if (!file.startsWith(root + path.sep)) throw badRequest('invalid_path')
  return file
}

export async function readSkillFile(relPath: string): Promise<string> {
  const file = resolveSkillFilePath(relPath)
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    throw notFound()
  }
}

/**
 * tmp → fsync → rename: mesma técnica do AtomicWriter de cards, sem o
 * acoplamento a CardRepository — este é o arquivo-fonte único replicado por
 * workflow-readiness para cada target_repo, não um card.
 */
export async function writeSkillFile(relPath: string, content: string): Promise<void> {
  const file = resolveSkillFilePath(relPath)
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  const handle = await fs.open(tmp, 'w')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(tmp, file)
}
