import type { ServerResponse } from 'node:http'
import type { SSEEvent } from '@obsidiankan/types'

const HISTORY_LIMIT = 100

interface Client {
  id: number
  res: ServerResponse
}

/**
 * In-memory pub/sub for SSE clients. Keeps a rolling window of the last
 * HISTORY_LIMIT events so a client reconnecting with `Last-Event-ID: N`
 * can resume without loss. Bound by HISTORY_LIMIT — older events are
 * dropped silently and clients with very stale IDs get only what we have.
 */
export class SSEEventBus {
  private clients = new Set<Client>()
  private readonly history: Array<{ id: number; event: SSEEvent }> = []
  private nextEventId = 1
  private nextClientId = 1

  emit(event: SSEEvent): void {
    const id = this.nextEventId++
    this.history.push({ id, event })
    if (this.history.length > HISTORY_LIMIT) this.history.shift()
    for (const c of this.clients) this.send(c.res, id, event)
  }

  subscribe(res: ServerResponse, lastEventId: number | null): () => void {
    const id = this.nextClientId++
    const client: Client = { id, res }
    this.clients.add(client)

    if (lastEventId !== null) {
      for (const h of this.history) {
        if (h.id > lastEventId) this.send(res, h.id, h.event)
      }
    }

    return () => this.clients.delete(client)
  }

  size(): number {
    return this.clients.size
  }

  private send(res: ServerResponse, id: number, event: SSEEvent): void {
    try {
      res.write(
        `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`,
      )
    } catch {
      // socket may have died between emit and write; subscribe cleanup handles removal.
    }
  }
}
