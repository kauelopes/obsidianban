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

function cardFilePath(paths: Paths, project: string, basename: string): string {
  return path.join(paths.kanbanData, project, `${basename}.md`)
}

export interface WriteOptions {
  /** If set and different from `basename`, the previous .md is removed
   *  after the new one is durably committed (rename semantics). */
  previousBasename?: string
}

/**
 * Writes a card .md atomically (tmp → fsync → rename) and updates the
 * SQLite cache. Supports renaming by removing the previous file after
 * the new one lands; SQLite is the tiebreaker if both files exist mid-flight.
 *
 * The MCP-originated discriminator (PRD §7.4) is content-based, not
 * timing-based: after a write, the SQLite `file_hash` equals SHA-256
 * of the .md. The watcher compares each event's content hash against
 * SQLite and skips matching ones.
 */
export class AtomicWriter {
  constructor(
    private readonly paths: Paths,
    private readonly repo: CardRepository,
  ) {}

  async write(
    card: Omit<Card, 'body'>,
    body: string,
    basename: string,
    options: WriteOptions = {},
  ): Promise<{ fileHash: string }> {
    const filePath = cardFilePath(this.paths, card.project, basename)
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
    this.repo.upsert(card, fileHash, basename)

    if (options.previousBasename && options.previousBasename !== basename) {
      const oldPath = cardFilePath(this.paths, card.project, options.previousBasename)
      await fs.unlink(oldPath).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      })
    }

    return { fileHash }
  }
}
