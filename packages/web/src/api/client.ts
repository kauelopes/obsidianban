import type {
  Card,
  CardSummary,
  ListCardsParams,
  MoveCardParams,
  ReorderCardParams,
  ReorderResult,
  Sprint,
} from '@obsidiankan/types'
import { type McpResult, toMcpResult } from './result.js'

export interface ClientConfig {
  /** Same-origin in production; the Vite proxy covers dev. */
  baseUrl?: string
  token: string
  timeoutMs?: number
}

export class KanbanClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number

  constructor(cfg: ClientConfig) {
    this.baseUrl = (cfg.baseUrl ?? '').replace(/\/$/, '')
    this.token = cfg.token
    this.timeoutMs = cfg.timeoutMs ?? 10_000
  }

  private async call<T>(tool: string, params: Record<string, unknown>): Promise<McpResult<T>> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}/mcp/tool/${tool}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(params),
        signal: ctrl.signal,
      })
      const text = await res.text()
      let body: unknown = null
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          // A non-JSON body is a server-side failure, not a protocol response.
          return {
            ok: false,
            error: { kind: 'server', status: res.status, message: text.slice(0, 200) },
          }
        }
      }
      return toMcpResult<T>(res.status, body)
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        error: {
          kind: 'offline',
          message: 'não foi possível falar com o servidor kanban',
          cause: ctrl.signal.aborted ? `timeout após ${this.timeoutMs}ms` : cause,
        },
      }
    } finally {
      clearTimeout(timer)
    }
  }

  listCards(params: ListCardsParams = {}): Promise<McpResult<{ cards: CardSummary[] }>> {
    return this.call('kanban_list_cards', params as Record<string, unknown>)
  }

  getCard(id: string): Promise<McpResult<Card>> {
    return this.call('kanban_get_card', { id })
  }

  moveCard(params: MoveCardParams): Promise<McpResult<Card>> {
    return this.call('kanban_move_card', params as unknown as Record<string, unknown>)
  }

  reorderCard(params: ReorderCardParams): Promise<McpResult<ReorderResult>> {
    return this.call('kanban_reorder_card', params as unknown as Record<string, unknown>)
  }

  listProjects(
    opts: { include_archived?: boolean } = {},
  ): Promise<McpResult<{ projects: Array<{ project: string; columns: string[]; archived: boolean; sprints?: Sprint[] }> }>> {
    return this.call('kanban_list_projects', opts)
  }

  listSprints(params: { project: string; status?: string }): Promise<McpResult<{ sprints: Sprint[] }>> {
    return this.call('kanban_list_sprints', params)
  }

  /** GET /health is a plain route, not a tool — and it needs no token. */
  async health(): Promise<McpResult<{ status: string; cards_indexed: number }>> {
    try {
      const res = await fetch(`${this.baseUrl}/health`)
      return toMcpResult(res.status, await res.json())
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: 'offline',
          message: 'servidor kanban fora do ar',
          cause: err instanceof Error ? err.message : String(err),
        },
      }
    }
  }
}
