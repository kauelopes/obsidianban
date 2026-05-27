import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { Paths } from '../config.js'
import type { Card } from '../types.js'
import type { CardRepository } from '../cards/repository.js'
import { serializeCard } from '../cards/serialize.js'

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function cardFilePath(paths: Paths, project: string, id: string): string {
  return path.join(paths.kanbanData, project, `${id}.md`)
}

/**
 * The MCP-originated discriminator (PRD §7.4) is content-based, not
 * timing-based: after a write, the SQLite `file_hash` equals SHA-256
 * of the .md. The watcher compares each event's content hash against
 * SQLite and skips matching ones — a stronger implementation of the
 * same invariant, without a race window.
 */
export class AtomicWriter {
  constructor(
    private readonly paths: Paths,
    private readonly repo: CardRepository,
  ) {}

  async write(card: Omit<Card, 'body'>, body: string): Promise<{ fileHash: string }> {
    const filePath = cardFilePath(this.paths, card.project, card.id)
    const tmpPath = filePath + '.tmp'
    const content = serializeCard(card, body)
    const fileHash = sha256(content)

    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const handle = await fs.open(tmpPath, 'w')
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(tmpPath, filePath)
    this.repo.upsert(card, fileHash)

    return { fileHash }
  }
}
