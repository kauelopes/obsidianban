import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type Database from 'better-sqlite3'
import type { TokenValidator } from '../auth/validator.js'
import { extractBearer } from '../auth/validator.js'
import type { IdempotencyStore } from './idempotency.js'
import { isValidRequestId } from './idempotency.js'
import type { SSEEventBus } from './sse.js'
import type { TokenClaims } from '@obsidiankan/types'
import { HttpError } from '../services/errors.js'
import type { MetricsService } from '../services/metrics.js'
import type { McpHttpManager } from './mcp-http.js'
import type { StaticSite } from './static.js'

export interface ServerState {
  startedAt: number
  vaultPath: string
  /** true while startup reconciliation is still running */
  reconciling: boolean
  db: Database.Database
}

export interface HttpServerDeps {
  port: number
  state: ServerState
  validator: TokenValidator
  idempotency: IdempotencyStore
  sse: SSEEventBus
  metrics: MetricsService
  mcp: McpHttpManager
  /** Built web SPA, served from the same origin. Absent when not built. */
  site?: StaticSite | undefined
}

interface ToolHandler {
  (params: unknown, claims: TokenClaims): Promise<unknown>
}

export class HttpServer {
  private server: http.Server | null = null
  private readonly tools = new Map<string, ToolHandler>()

  constructor(private readonly deps: HttpServerDeps) {}

  registerTool(name: string, handler: ToolHandler): void {
    this.tools.set(name, handler)
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.dispatch(req, res).catch((err) => {
        if (err instanceof HttpError) {
          sendJson(res, err.status, err.body)
          return
        }
        sendJson(res, 500, { error: 'internal_error', message: (err as Error).message })
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(this.deps.port, '127.0.0.1', resolve))
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve, reject) =>
      this.server!.close((err) => (err ? reject(err) : resolve())),
    )
    this.server = null
  }

  getPort(): number | null {
    const addr = this.server?.address()
    if (!addr || typeof addr === 'string') return null
    return addr.port
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? ''

    if (req.method === 'GET' && url === '/health') {
      return this.handleHealth(res)
    }
    if (req.method === 'GET' && url === '/events') {
      return this.handleEvents(req, res)
    }
    if (req.method === 'GET' && url.split('?')[0] === '/metrics') {
      return this.handleMetrics(req, res, url)
    }

    const toolMatch = /^\/mcp\/tool\/([^/?]+)$/.exec(url.split('?')[0] ?? '')
    if (toolMatch && req.method === 'POST') {
      return this.handleToolCall(req, res, toolMatch[1]!)
    }

    if (url.split('?')[0] === '/mcp') {
      return this.handleMcp(req, res)
    }

    // The SPA is served last so it can never shadow an API route.
    if (req.method === 'GET' && this.deps.site) {
      return this.deps.site.serve(url, res)
    }

    sendJson(res, 404, { error: 'not_found' })
  }

  private handleEvents(req: IncomingMessage, res: ServerResponse): void {
    const lastIdHeader = req.headers['last-event-id']
    const lastId =
      typeof lastIdHeader === 'string' && /^\d+$/.test(lastIdHeader) ? Number(lastIdHeader) : null

    res.statusCode = 200
    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('cache-control', 'no-cache')
    res.setHeader('connection', 'keep-alive')
    res.flushHeaders?.()
    res.write(': open\n\n')

    const unsubscribe = this.deps.sse.subscribe(res, lastId)
    req.on('close', () => unsubscribe())
  }

  private handleHealth(res: ServerResponse): void {
    const { state } = this.deps
    if (state.reconciling) {
      sendJson(res, 503, { status: 'reconciling' })
      return
    }
    const row = state.db.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }
    sendJson(res, 200, {
      status: 'ok',
      uptime_s: Math.floor((Date.now() - state.startedAt) / 1000),
      vault: state.vaultPath,
      cards_indexed: row.n,
    })
  }

  private handleMetrics(req: IncomingMessage, res: ServerResponse, url: string): void {
    // Defense in depth: server already binds to 127.0.0.1, but reject anything
    // not coming from loopback in case the bind ever changes.
    const remote = req.socket.remoteAddress ?? ''
    if (!isLoopback(remote)) {
      sendJson(res, 403, { error: 'forbidden', reason: 'localhost_only' })
      return
    }
    const params = new URL(url, 'http://localhost').searchParams
    try {
      const metrics = this.deps.metrics.collect({
        from_date: params.get('from_date') ?? undefined,
        to_date: params.get('to_date') ?? undefined,
      })
      sendJson(res, 200, metrics)
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, err.body)
        return
      }
      throw err
    }
  }

  private async handleToolCall(
    req: IncomingMessage,
    res: ServerResponse,
    toolName: string,
  ): Promise<void> {
    const claims = await this.authenticate(req, res)
    if (!claims) return

    const body = await readJsonBody(req).catch((_err) => null)
    if (body === null) {
      sendJson(res, 400, { error: 'invalid_json' })
      return
    }
    const params = body as Record<string, unknown>
    const requestId = typeof params['request_id'] === 'string' ? params['request_id'] : undefined
    if (requestId !== undefined && !isValidRequestId(requestId)) {
      sendJson(res, 400, { error: 'invalid_request_id' })
      return
    }

    if (requestId) {
      const cached = this.deps.idempotency.get(requestId)
      if (cached) {
        sendJson(res, 200, cached.response)
        return
      }
    }

    const handler = this.tools.get(toolName)
    if (!handler) {
      sendJson(res, 501, { error: 'not_implemented', tool: toolName })
      return
    }

    try {
      const response = await handler(params, claims)
      if (requestId) await this.deps.idempotency.put(requestId, response)
      sendJson(res, 200, response)
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, err.body)
        return
      }
      throw err
    }
  }

  private async handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Stateless Streamable HTTP: the client drives everything over POST. There
    // is no server-initiated stream to open, so GET/DELETE are not supported.
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, {
        error: 'method_not_allowed',
        hint: 'the /mcp endpoint is stateless Streamable HTTP — use POST',
      })
      return
    }
    const claims = await this.authenticate(req, res)
    if (!claims) return
    const body = await readJsonBody(req).catch((_err) => null)
    if (body === null) {
      sendJson(res, 400, { error: 'invalid_json' })
      return
    }
    await this.deps.mcp.handleRequest(req, res, claims, body)
  }

  private async authenticate(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<TokenClaims | null> {
    const bearer = extractBearer(req.headers.authorization)
    const result = await this.deps.validator.validate(bearer)
    if (!result.ok) {
      const errors = {
        missing: 'missing_token',
        invalid: 'invalid_token',
        revoked: 'revoked_token',
      } as const
      sendJson(res, 401, { error: errors[result.reason] })
      return null
    }
    return result.claims
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function isLoopback(addr: string): boolean {
  return addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.')
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
