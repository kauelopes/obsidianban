import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { KadFile } from '@obsidiankan/types'
import type { Paths } from '../config.js'
import { projectDir } from './layout.js'
import { KAD_DOC_IDS, type KadDocId } from '../planning/session.js'

const KAD_DOC_LABEL: Record<KadDocId, string> = {
  vision: 'Visão',
  prd: 'PRD',
  domain_model: 'Modelo de domínio',
  architecture: 'Arquitetura',
  knowledge: 'Conhecimento',
  features: 'Features',
  stories: 'Histórias',
  roadmap: 'Roadmap',
}

const KAD_DOC_RANK = new Map(KAD_DOC_IDS.map((id, i) => [id, i]))

/** Nome de arquivo seguro: sem extensão, sem `/` nem `..` — bloqueia escape antes de qualquer join. */
const SAFE_DOC_ID = /^[a-zA-Z0-9_-]+$/

export function kadDir(paths: Paths, project: string): string {
  return path.join(projectDir(paths, project), 'kad')
}

/**
 * Enumera os docs KAD de um projeto. Projeto que nunca passou pelo wizard não
 * tem `kad/` — isso não é erro, é lista vazia (ver materialize.ts §6).
 */
export async function listKadDocs(paths: Paths, project: string): Promise<KadFile[]> {
  const dir = kadDir(paths, project)
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const files: KadFile[] = []
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue
    const id = e.name.slice(0, -'.md'.length)
    const stat = await fs.stat(path.join(dir, e.name))
    files.push({
      id,
      label: KAD_DOC_LABEL[id as KadDocId] ?? id,
      mtime: stat.mtime.toISOString(),
    })
  }

  // Ids conhecidos na ordem canônica primeiro; o resto (docs futuros/inesperados) depois, alfabético.
  files.sort((a, b) => {
    const ra = KAD_DOC_RANK.get(a.id as KadDocId) ?? Number.MAX_SAFE_INTEGER
    const rb = KAD_DOC_RANK.get(b.id as KadDocId) ?? Number.MAX_SAFE_INTEGER
    return ra - rb || a.id.localeCompare(b.id)
  })
  return files
}

/**
 * Lê um doc KAD por id. `null` cobre tanto id inválido quanto arquivo
 * inexistente — o handler HTTP trata os dois como 404, sem distinguir
 * "tentativa de escape" de "arquivo não existe" na resposta.
 */
export async function readKadDoc(paths: Paths, project: string, docId: string): Promise<string | null> {
  if (!SAFE_DOC_ID.test(docId)) return null
  const dir = path.resolve(kadDir(paths, project))
  // Defesa em profundidade: o regex acima já impede qualquer separador de
  // path em `docId`, mas reconfirma o prefixo aqui (mesma postura de
  // server/static.ts) em vez de confiar só na validação de entrada.
  const file = path.resolve(dir, `${docId}.md`)
  if (!file.startsWith(dir + path.sep)) return null
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}
