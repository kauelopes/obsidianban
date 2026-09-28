import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { ReportDocument, ReportMeta } from './api-types.js'

export const REPORT_ID_RE = /^rep-\d{8}-[0-9a-f]{6}$/

export type ReportFile = 'report.json' | 'document.json' | 'report.md' | 'report.pdf'

/**
 * Um diretório por relatório em `<dataDir>/reports/<id>/`: report.json (meta
 * e status), document.json (a estrutura que gera MD e PDF), report.md e
 * report.pdf. Escrita atômica (.tmp único → rename), como os stores do core.
 */
export class ReportStore {
  readonly root: string

  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'reports')
  }

  newId(now: Date): string {
    const day = now.toISOString().slice(0, 10).replace(/-/g, '')
    return `rep-${day}-${randomBytes(3).toString('hex')}`
  }

  dir(id: string): string {
    if (!REPORT_ID_RE.test(id)) throw new Error(`id de relatório inválido: ${id}`)
    return path.join(this.root, id)
  }

  file(id: string, name: ReportFile): string {
    return path.join(this.dir(id), name)
  }

  async saveMeta(meta: ReportMeta): Promise<void> {
    await this.write(meta.id, 'report.json', JSON.stringify(meta, null, 2) + '\n')
  }

  async saveDocument(id: string, doc: ReportDocument): Promise<void> {
    await this.write(id, 'document.json', JSON.stringify(doc, null, 2) + '\n')
  }

  async saveMarkdown(id: string, md: string): Promise<void> {
    await this.write(id, 'report.md', md)
  }

  async loadMeta(id: string): Promise<ReportMeta | null> {
    if (!REPORT_ID_RE.test(id)) return null
    return readJson<ReportMeta>(this.file(id, 'report.json'))
  }

  async loadDocument(id: string): Promise<ReportDocument | null> {
    if (!REPORT_ID_RE.test(id)) return null
    return readJson<ReportDocument>(this.file(id, 'document.json'))
  }

  async read(id: string, name: 'report.md' | 'report.pdf'): Promise<Buffer | null> {
    if (!REPORT_ID_RE.test(id)) return null
    try {
      return await fs.readFile(this.file(id, name))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  /** Mais recentes primeiro. Diretório sem report.json legível é ignorado. */
  async list(): Promise<ReportMeta[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.root)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const metas: ReportMeta[] = []
    for (const name of names) {
      if (!REPORT_ID_RE.test(name)) continue
      const meta = await this.loadMeta(name)
      if (meta) metas.push(meta)
    }
    return metas.sort((a, b) => b.created_at.localeCompare(a.created_at))
  }

  async remove(id: string): Promise<void> {
    await fs.rm(this.dir(id), { recursive: true, force: true })
  }

  private async write(id: string, name: ReportFile, content: string): Promise<void> {
    const dir = this.dir(id)
    await fs.mkdir(dir, { recursive: true })
    const target = path.join(dir, name)
    const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`
    await fs.writeFile(tmp, content, 'utf8')
    await fs.rename(tmp, target)
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}
