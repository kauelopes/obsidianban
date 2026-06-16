import { promises as fs } from 'node:fs'
import path from 'node:path'

const TTL_MS = 24 * 60 * 60 * 1000

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isValidRequestId(requestId: string): boolean {
  return UUID_V4.test(requestId)
}

export interface CachedEntry {
  request_id: string
  ts: number
  response: unknown
}

interface FileShape {
  entries: CachedEntry[]
}

export class IdempotencyStore {
  private cache = new Map<string, CachedEntry>()

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as FileShape
      const now = Date.now()
      for (const e of parsed.entries) {
        if (now - e.ts < TTL_MS) this.cache.set(e.request_id, e)
      }
      // Persist the pruned set (drops expired entries).
      await this.persist()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  get(requestId: string): CachedEntry | null {
    const entry = this.cache.get(requestId)
    if (!entry) return null
    if (Date.now() - entry.ts >= TTL_MS) {
      this.cache.delete(requestId)
      return null
    }
    return entry
  }

  async put(requestId: string, response: unknown): Promise<void> {
    this.cache.set(requestId, { request_id: requestId, ts: Date.now(), response })
    await this.persist()
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const data: FileShape = { entries: [...this.cache.values()] }
    await fs.writeFile(this.filePath, JSON.stringify(data) + '\n', 'utf8')
  }
}
