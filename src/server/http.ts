import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type Database from 'better-sqlite3'
import type { TokenValidator } from '../auth/validator.js'
import { extractBearer } from '../auth/validator.js'
import type { IdempotencyStore } from './idempotency.js'
import { isValidRequestId } from './idempotency.js'
import type { TokenClaims } from '../types.js'

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

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? ''

    if (req.method === 'GET' && url === '/health') {
      return this.handleHealth(res)
    }

    const toolMatch = /^\/mcp\/tool\/([^/?]+)$/.exec(url.split('?')[0] ?? '')
    if (toolMatch && req.method === 'POST') {
      return this.handleToolCall(req, res, toolMatch[1]!)
    }

    sendJson(res, 404, { error: 'not_found' })
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

  private async handleToolCall(
    req: IncomingMessage,
    res: ServerResponse,
    toolName: string,
  ): Promise<void> {
    const claims = await this.authenticate(req, res)
    if (!claims) return

    const body = await readJsonBody(req).catch(() => null)
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

    const response = await handler(params, claims)
    if (requestId) await this.deps.idempotency.put(requestId, response)
    sendJson(res, 200, response)
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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
