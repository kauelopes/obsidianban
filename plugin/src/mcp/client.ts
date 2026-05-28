import http from 'node:http'
import type {
  ArchiveCardParams,
  Card,
  CardSummary,
  CreateCardParams,
  DeleteCardParams,
  ListCardsParams,
  MoveCardParams,
  Metrics,
  MetricsFilter,
  ReorderCardParams,
  ReorderResult,
  UpdateCardParams,
} from '../../../src/types.js'

export interface ConflictError {
  kind: 'conflict'
  status: 409
  message: string
  yourVersion: number
  currentVersion: number
  conflictingFields: string[]
  currentCard: Card
}

export interface ValidationError {
  kind: 'validation'
  status: 400
  message: string
  disallowedFields: string[]
  allowedFields: string[]
}

export interface ServerError {
  kind: 'server'
  status: number
  message: string
  raw?: unknown
}

export interface OfflineError {
  kind: 'offline'
  message: string
  cause: string
}

export type McpError = ConflictError | ValidationError | ServerError | OfflineError

export type McpResult<T> = { ok: true; data: T } | { ok: false; error: McpError }

export interface McpClientConfig {
  baseUrl: string
  token: string
  /** ms; default 5000 */
  timeoutMs?: number
}

interface RawResponse {
  kind: 'response'
  status: number
  body: unknown
}

/**
 * MCP HTTP client for the Obsidian plugin. Uses node:http directly (not the
 * global `fetch`) so the same code path supports SSE later. Errors never
 * throw — every method returns a discriminated `McpResult`.
 */
export class McpClient {
  private readonly baseUrl: URL
  private readonly token: string
  private readonly timeoutMs: number

  constructor(cfg: McpClientConfig) {
    this.baseUrl = new URL(cfg.baseUrl)
    this.token = cfg.token
    this.timeoutMs = cfg.timeoutMs ?? 5000
  }

  listCards(params: ListCardsParams = {}): Promise<McpResult<{ cards: CardSummary[] }>> {
    return this.call('kanban_list_cards', params)
  }

  getCard(id: string): Promise<McpResult<Card>> {
    return this.call('kanban_get_card', { id })
  }

  createCard(params: CreateCardParams): Promise<McpResult<Card>> {
    return this.call('kanban_create_card', params)
  }

  updateCard(params: UpdateCardParams): Promise<McpResult<Card>> {
    return this.call('kanban_update_card', params)
  }

  moveCard(params: MoveCardParams): Promise<McpResult<Card>> {
    return this.call('kanban_move_card', params)
  }

  reorderCard(params: ReorderCardParams): Promise<McpResult<ReorderResult>> {
    return this.call('kanban_reorder_card', params)
  }

  deleteCard(params: DeleteCardParams): Promise<McpResult<{ deleted: true; id: string }>> {
    return this.call('kanban_delete_card', params)
  }

  archiveCard(params: ArchiveCardParams): Promise<McpResult<Card>> {
    return this.call('kanban_archive_card', params)
  }

  unarchiveCard(params: ArchiveCardParams): Promise<McpResult<Card>> {
    return this.call('kanban_unarchive_card', params)
  }

  createProject(params: { project: string; actor: string }): Promise<McpResult<{
    project: string
    token: string
    token_id: string
    actor: string
    created_at: string
  }>> {
    return this.call('kanban_create_project', params)
  }

  listProjects(): Promise<McpResult<{
    projects: Array<{ project: string; columns: string[] }>
  }>> {
    return this.call('kanban_list_projects', {})
  }

  async getMetrics(filter: MetricsFilter = {}): Promise<McpResult<Metrics>> {
    const search = new URLSearchParams()
    if (filter.from_date != null) search.set('from_date', filter.from_date)
    if (filter.to_date != null) search.set('to_date', filter.to_date)
    const qs = search.toString()
    const path = '/metrics' + (qs ? `?${qs}` : '')
    const raw = await this.request('GET', path, null)
    if (raw.kind === 'offline') return { ok: false, error: raw }
    return this.toResult<Metrics>(raw)
  }

  async health(): Promise<McpResult<{ status: string; cards_indexed: number }>> {
    const raw = await this.request('GET', '/health', null)
    if (raw.kind === 'offline') return { ok: false, error: raw }
    return this.toResult(raw)
  }

  private async call<T>(tool: string, params: unknown): Promise<McpResult<T>> {
    const raw = await this.request('POST', `/mcp/tool/${tool}`, params)
    if (raw.kind === 'offline') return { ok: false, error: raw }
    return this.toResult<T>(raw)
  }

  private toResult<T>(raw: RawResponse): McpResult<T> {
    if (raw.status === 200) return { ok: true, data: raw.body as T }
    const body = (raw.body ?? {}) as Record<string, unknown>
    if (raw.status === 409) {
      return {
        ok: false,
        error: {
          kind: 'conflict',
          status: 409,
          message: typeof body['message'] === 'string' ? body['message'] : 'conflict',
          yourVersion: typeof body['your_version'] === 'number' ? body['your_version'] : 0,
          currentVersion: typeof body['current_version'] === 'number' ? body['current_version'] : 0,
          conflictingFields: Array.isArray(body['conflicting_fields'])
            ? (body['conflicting_fields'] as string[])
            : [],
          currentCard: body['current_card'] as Card,
        },
      }
    }
    if (raw.status === 400) {
      return {
        ok: false,
        error: {
          kind: 'validation',
          status: 400,
          message: typeof body['message'] === 'string' ? body['message'] : 'invalid_request',
          disallowedFields: Array.isArray(body['disallowed_fields'])
            ? (body['disallowed_fields'] as string[])
            : [],
          allowedFields: Array.isArray(body['allowed_fields'])
            ? (body['allowed_fields'] as string[])
            : [],
        },
      }
    }
    return {
      ok: false,
      error: {
        kind: 'server',
        status: raw.status,
        message:
          typeof body['message'] === 'string'
            ? body['message']
            : typeof body['error'] === 'string'
              ? body['error']
              : `http_${raw.status}`,
        raw: body,
      },
    }
  }

  private request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
  ): Promise<RawResponse | OfflineError> {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8')
    return new Promise((resolve) => {
      const headers: Record<string, string> = {
        accept: 'application/json',
      }
      if (this.token) headers['authorization'] = `Bearer ${this.token}`
      if (payload) {
        headers['content-type'] = 'application/json'
        headers['content-length'] = String(payload.length)
      }
      const req = http.request(
        {
          host: this.baseUrl.hostname,
          port: this.baseUrl.port,
          method,
          path,
          headers,
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let parsed: unknown = null
            try {
              parsed = text.length > 0 ? JSON.parse(text) : null
            } catch {
              resolve({
                kind: 'offline',
                message: 'invalid_response',
                cause: `non-JSON body from ${path}`,
              })
              return
            }
            resolve({ kind: 'response', status: res.statusCode ?? 0, body: parsed })
          })
        },
      )
      req.on('error', (err) => {
        resolve({
          kind: 'offline',
          message: 'mcp_unreachable',
          cause: (err as NodeJS.ErrnoException).code ?? err.message,
        })
      })
      req.on('timeout', () => {
        req.destroy()
        resolve({ kind: 'offline', message: 'timeout', cause: 'ETIMEDOUT' })
      })
      if (payload) req.write(payload)
      req.end()
    })
  }
}
