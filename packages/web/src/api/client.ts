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

  // Human edits carry no token cost. 'human' keeps them distinguishable from
  // agent activity in /metrics instead of polluting it as 'unknown'.
  private human(params: Record<string, unknown>): Record<string, unknown> {
    return { input_tokens: 0, output_tokens: 0, model: 'human', ...params }
  }

  createCard(params: {
    project: string
    title: string
    type: string
    sprint_id: string
    body?: string
    priority?: string
    tags?: string[]
    due_date?: string | null
    status?: string
    blocked_by?: string[]
  }): Promise<McpResult<Card>> {
    return this.call('kanban_create_card', this.human(params))
  }

  /** Frontmatter fields only — the body zones have their own tools. */
  updateCard(params: {
    id: string
    version: number
    title?: string
    priority?: string
    tags?: string[]
    due_date?: string | null
    assigned_to?: string | null
    blocked_by?: string[]
    sprint_id?: string
    agent_notes?: string | null
    status?: string
  }): Promise<McpResult<Card>> {
    return this.call('kanban_update_card', this.human(params))
  }

  updateSpec(params: { id: string; version: number; spec: string }): Promise<McpResult<Card>> {
    return this.call('kanban_update_spec', this.human(params))
  }

  updateNotes(params: { id: string; version: number; notes: string }): Promise<McpResult<Card>> {
    return this.call('kanban_update_notes', this.human(params))
  }

  archiveCard(params: { id: string; version: number }): Promise<McpResult<Card>> {
    return this.call('kanban_archive_card', this.human(params))
  }

  unarchiveCard(params: { id: string; version: number }): Promise<McpResult<Card>> {
    return this.call('kanban_unarchive_card', this.human(params))
  }

  deleteCard(params: { id: string; version: number }): Promise<McpResult<{ deleted: true; id: string }>> {
    return this.call('kanban_delete_card', this.human(params))
  }

  createSprint(params: { project: string; name: string; goal?: string }): Promise<McpResult<Sprint>> {
    return this.call('kanban_create_sprint', params)
  }

  startSprint(params: { sprint_id: string }): Promise<McpResult<Sprint>> {
    return this.call('kanban_start_sprint', params)
  }

  closeSprint(params: { sprint_id: string; rollover_to?: string | null }): Promise<McpResult<unknown>> {
    return this.call('kanban_close_sprint', params)
  }

  createProject(params: { project: string; actor: string }): Promise<McpResult<{ project: string; token?: string }>> {
    return this.call('kanban_create_project', params)
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
