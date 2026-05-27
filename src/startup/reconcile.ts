import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Paths } from '../config.js'
import type { AuditLogger } from '../audit/logger.js'
import type { CardRepository } from '../cards/repository.js'
import { listProjects } from '../vault/layout.js'
import { sha256 } from '../writer/atomic.js'
import { parseCardFile, cardFromFrontmatter } from '../cards/serialize.js'

export interface ReconciliationReport {
  scanned: number
  reconciled: number
  orphansRemoved: number
  parseErrors: number
  sqliteRebuilt: boolean
}

export async function reconcile(
  paths: Paths,
  repo: CardRepository,
  audit: AuditLogger,
  opts: { sqliteRebuilt: boolean },
): Promise<ReconciliationReport> {
  const report: ReconciliationReport = {
    scanned: 0,
    reconciled: 0,
    orphansRemoved: 0,
    parseErrors: 0,
    sqliteRebuilt: opts.sqliteRebuilt,
  }

  const seen = new Set<string>()
  const projects = await listProjects(paths).catch(() => [])

  for (const project of projects) {
    const dir = path.join(paths.kanbanData, project)
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      report.scanned++
      const filePath = path.join(dir, entry.name)
      const content = await fs.readFile(filePath, 'utf8')
      const hash = sha256(content)

      try {
        const { data, body: _body } = parseCardFile(content)
        const card = cardFromFrontmatter(data)
        if (card.project !== project) {
          await audit.log({
            op: 'PARSE_ERROR',
            project,
            card_id: card.id,
            reason: `project mismatch: file under ${project}, frontmatter says ${card.project}`,
          })
          report.parseErrors++
          continue
        }
        seen.add(card.id)
        const existing = repo.findById(card.id)
        if (!existing || existing.file_hash !== hash) {
          repo.upsert(card, hash)
          await audit.log({
            op: 'RECONCILED',
            project,
            card_id: card.id,
            version: card.version,
          })
          report.reconciled++
        }
      } catch (err) {
        report.parseErrors++
        await audit.log({
          op: 'PARSE_ERROR',
          project,
          reason: (err as Error).message,
        })
      }
    }
  }

  for (const id of repo.allIds()) {
    if (seen.has(id)) continue
    const row = repo.findById(id)
    repo.delete(id)
    report.orphansRemoved++
    await audit.log({
      op: 'ORPHAN_REMOVED',
      card_id: id,
      project: row?.project,
    })
  }

  if (opts.sqliteRebuilt) {
    await audit.log({ op: 'SQLITE_REBUILT', card_count: report.scanned - report.parseErrors })
  }

  return report
}
