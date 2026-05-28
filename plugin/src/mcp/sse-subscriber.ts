import http from 'node:http'

export interface SSEFrame {
  id: number
  type: string
  data: unknown
}

export type SseStatus = 'connecting' | 'connected' | 'disconnected'

export interface SSEConfig {
  baseUrl: string
  onEvent: (frame: SSEFrame) => void
  onStatusChange?: (status: SseStatus) => void
  /** Override for tests. Default: ramp 1s → 30s, cap 30s. */
  backoffStartMs?: number
  backoffMaxMs?: number
}

/**
 * Long-lived SSE client built on node:http (NOT the global fetch) so the
 * same module compiles for the stdio MCP path later (Sprint 00 R-07).
 * Reconnects with exponential backoff and resumes via Last-Event-ID.
 */
export class SSESubscriber {
  private req: http.ClientRequest | null = null
  private res: http.IncomingMessage | null = null
  private buf = ''
  private lastEventId: number | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private currentBackoff: number

  constructor(private readonly cfg: SSEConfig) {
    this.currentBackoff = cfg.backoffStartMs ?? 1000
  }

  start(): void {
    if (!this.stopped && this.req) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.req) {
      this.req.destroy()
      this.req = null
    }
    if (this.res) {
      this.res.destroy()
      this.res = null
    }
  }

  private connect(): void {
    if (this.stopped) return
    this.cfg.onStatusChange?.('connecting')
    let url: URL
    try {
      url = new URL('/events', this.cfg.baseUrl)
    } catch {
      this.scheduleReconnect()
      return
    }
    const headers: Record<string, string> = { accept: 'text/event-stream' }
    if (this.lastEventId != null) headers['last-event-id'] = String(this.lastEventId)
    this.buf = ''

    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        method: 'GET',
        path: url.pathname,
        headers,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          this.scheduleReconnect()
          return
        }
        this.res = res
        this.cfg.onStatusChange?.('connected')
        this.currentBackoff = this.cfg.backoffStartMs ?? 1000
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => this.feed(chunk))
        res.on('end', () => this.scheduleReconnect())
        res.on('error', () => this.scheduleReconnect())
      },
    )
    req.on('error', () => this.scheduleReconnect())
    req.end()
    this.req = req
  }

  private feed(chunk: string): void {
    this.buf += chunk
    let idx: number
    while ((idx = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 2)
      this.parseBlock(block)
    }
  }

  private parseBlock(block: string): void {
    let id: number | null = null
    let type: string | null = null
    let data: unknown = null
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) {
        const n = Number(line.slice(4))
        if (Number.isFinite(n)) id = n
      } else if (line.startsWith('event: ')) {
        type = line.slice(7)
      } else if (line.startsWith('data: ')) {
        try {
          data = JSON.parse(line.slice(6))
        } catch {
          /* ignore malformed payload */
        }
      }
    }
    if (type && id != null) {
      this.lastEventId = id
      this.cfg.onEvent({ id, type, data })
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    if (this.reconnectTimer) return
    this.cfg.onStatusChange?.('disconnected')
    if (this.req) {
      this.req.destroy()
      this.req = null
    }
    if (this.res) {
      this.res.destroy()
      this.res = null
    }
    const delay = this.currentBackoff
    const max = this.cfg.backoffMaxMs ?? 30_000
    this.currentBackoff = Math.min(this.currentBackoff * 2, max)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }
}
