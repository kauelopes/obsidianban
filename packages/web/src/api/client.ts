import type {
  AddToSprintResult,
  Card,
  CardHistoryResult,
  CardSummary,
  CreateAgentTokenResult,
  EscalationsResult,
  LogKind,
  DeleteProjectResult,
  GetSprintResult,
  Goal,
  ListCardsParams,
  ActivityResponse,
  Metrics,
  MoveBetweenSprintsResult,
  MoveCardParams,
  ProjectShapeResult,
  ReorderCardParams,
  ReorderResult,
  SetProjectRepoResult,
  Sprint,
  WorkflowLogResult,
  WorkflowReadinessResult,
  WorkflowRunView,
} from '@obsidiankan/types'
import type {
  Epic,
  PlanningFinalizeResult,
  PlanningSessionView,
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

  private async call<T>(
    tool: string,
    params: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<McpResult<T>> {
    const ctrl = new AbortController()
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
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
          cause: ctrl.signal.aborted ? `timeout após ${timeoutMs}ms` : cause,
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

  /**
   * `log_kind` é o que coloca (ou tira) o card da inbox de escalações. Sem ele
   * a entrada conta como `progress`.
   */
  logOnCard(params: {
    id: string
    version: number
    log_entry: string
    log_kind?: LogKind
  }): Promise<McpResult<Card>> {
    return this.call('kanban_log_on_card', this.human(params))
  }

  listEscalations(params: { project?: string } = {}): Promise<McpResult<EscalationsResult>> {
    return this.call('kanban_list_escalations', params)
  }

  getCardHistory(params: {
    id: string
    limit?: number
  }): Promise<McpResult<CardHistoryResult>> {
    return this.call('kanban_get_card_history', params)
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

  /** Mints an initial pm token, returned raw exactly once. */
  createProject(params: { project: string; actor: string; target_repo?: string }): Promise<
    McpResult<{
      project: string
      actor: string
      created_at: string
      token: string
      token_id: string
      /** Só vem quando target_repo foi informado — mesma forma de setProjectRepo. */
      workflow_readiness?: WorkflowReadinessResult
    }>
  > {
    return this.call('kanban_create_project', params)
  }

  listProjects(
    opts: { include_archived?: boolean } = {},
  ): Promise<McpResult<{ projects: Array<{ project: string; columns: string[]; archived: boolean; target_repo?: string | null; goals?: Goal[] }> }>> {
    return this.call('kanban_list_projects', opts)
  }

  /** Upsert: sem `id` cria. Campos omitidos num update ficam como estão. */
  setGoal(params: {
    project: string
    id?: string
    title?: string
    target_date?: string | null
    status?: Goal['status']
    notes?: string
  }): Promise<McpResult<{ project: string; goal: Goal }>> {
    return this.call('kanban_set_goal', params)
  }

  deleteGoal(params: { project: string; id: string }): Promise<McpResult<{ project: string; goal_id: string }>> {
    return this.call('kanban_delete_goal', params)
  }

  listSprints(params: { project: string; status?: string }): Promise<McpResult<{ sprints: Sprint[] }>> {
    return this.call('kanban_list_sprints', params)
  }

  /** Os agregados vêm aninhados em `aggregates`, não no topo da resposta. */
  getSprint(params: { sprint_id: string }): Promise<McpResult<GetSprintResult>> {
    return this.call('kanban_get_sprint', params)
  }

  addToSprint(params: {
    sprint_id: string
    card_ids: string[]
    move_to_todo?: boolean
  }): Promise<McpResult<AddToSprintResult>> {
    return this.call('kanban_add_to_sprint', params)
  }

  /** `sprint_id` + `target_sprint_id` — não `from_`/`to_`. Conferido por curl. */
  moveBetweenSprints(params: {
    sprint_id: string
    target_sprint_id: string
    card_ids: string[]
  }): Promise<McpResult<MoveBetweenSprintsResult>> {
    return this.call('kanban_move_between_sprints', params)
  }

  /**
   * Definir o repo também instala as skills, escreve os configs e minta os
   * tokens de pm/dev que faltarem — tudo em `workflow_readiness`.
   * Passar `null` limpa o repo, e nesse caso a resposta não traz
   * `workflow_readiness` nem `target_repo`.
   */
  setProjectRepo(params: {
    project: string
    target_repo: string | null
  }): Promise<McpResult<SetProjectRepoResult>> {
    return this.call('kanban_set_project_repo', params)
  }

  archiveProject(params: { project: string }): Promise<McpResult<ProjectShapeResult>> {
    return this.call('kanban_archive_project', params)
  }

  unarchiveProject(params: { project: string }): Promise<McpResult<ProjectShapeResult>> {
    return this.call('kanban_unarchive_project', params)
  }

  /** `confirm` tem de ser igual ao nome do projeto, senão o servidor recusa. */
  deleteProject(params: {
    project: string
    confirm: string
  }): Promise<McpResult<DeleteProjectResult>> {
    return this.call('kanban_delete_project', params)
  }

  /** O token bruto aparece uma vez só na resposta e não é recuperável depois. */
  createAgentToken(params: {
    project: string
    actor: string
    agent_type?: 'pm' | 'dev'
  }): Promise<McpResult<CreateAgentTokenResult>> {
    return this.call('kanban_create_agent_token', params)
  }

  /**
   * Libera o claim de um card. Existe na UI como ação de supervisão: um agente
   * que morreu deixa o card preso em `assigned_to` para sempre.
   * `revert_to_status: null` mantém a coluna atual.
   */
  releaseCard(params: {
    id: string
    version: number
    revert_to_status?: string | null
  }): Promise<McpResult<Card>> {
    return this.call('kanban_release_card', this.human(params))
  }

  /** GET /metrics é rota própria, loopback-only, e não pede token. */
  async getMetrics(params: { from_date?: string; to_date?: string } = {}): Promise<
    McpResult<Metrics>
  > {
    const qs = new URLSearchParams()
    if (params.from_date) qs.set('from_date', params.from_date)
    if (params.to_date) qs.set('to_date', params.to_date)
    const suffix = qs.size > 0 ? `?${qs.toString()}` : ''
    try {
      const res = await fetch(`${this.baseUrl}/metrics${suffix}`)
      return toMcpResult(res.status, await res.json())
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: 'offline',
          message: 'não foi possível ler as métricas',
          cause: err instanceof Error ? err.message : String(err),
        },
      }
    }
  }

  /**
   * GET /activity segue o modelo do /metrics (rota própria, loopback, sem
   * token). O tz_offset vai sempre: os buckets diários são no fuso de QUEM
   * olha, e só o navegador sabe qual é.
   */
  async getActivity(params: { days?: number } = {}): Promise<McpResult<ActivityResponse>> {
    const qs = new URLSearchParams({ tz_offset: String(new Date().getTimezoneOffset()) })
    if (params.days) qs.set('days', String(params.days))
    try {
      const res = await fetch(`${this.baseUrl}/activity?${qs.toString()}`)
      return toMcpResult(res.status, await res.json())
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: 'offline',
          message: 'não foi possível ler a atividade',
          cause: err instanceof Error ? err.message : String(err),
        },
      }
    }
  }

  // ── Planejamento (wizard KAD) ──────────────────────────────────────────────
  // answer/refine/retry retornam já (o turno roda no servidor); o resultado
  // chega por SSE PLANNING_* com planningGet de polling como fallback. Só o
  // finalize é síncrono — materialização é escrita local, mas ganha folga.

  planningStart(): Promise<McpResult<PlanningSessionView>> {
    return this.call('kanban_planning_start', {})
  }

  planningGet(sessionId: string): Promise<McpResult<PlanningSessionView>> {
    return this.call('kanban_planning_get', { session_id: sessionId })
  }

  planningList(): Promise<McpResult<{ sessions: PlanningSessionView[] }>> {
    return this.call('kanban_planning_list', {})
  }

  planningAnswer(
    sessionId: string,
    step: string,
    answer: unknown,
  ): Promise<McpResult<PlanningSessionView>> {
    return this.call('kanban_planning_answer', { session_id: sessionId, step, answer })
  }

  planningRefine(sessionId: string, feedback: string): Promise<McpResult<PlanningSessionView>> {
    return this.call('kanban_planning_refine', { session_id: sessionId, feedback })
  }

  planningRetry(sessionId: string): Promise<McpResult<PlanningSessionView>> {
    return this.call('kanban_planning_retry', { session_id: sessionId })
  }

  planningFinalize(sessionId: string): Promise<McpResult<PlanningFinalizeResult>> {
    return this.call('kanban_planning_finalize', { session_id: sessionId }, { timeoutMs: 30_000 })
  }

  planningCancel(sessionId: string): Promise<McpResult<{ session_id: string; status: string }>> {
    return this.call('kanban_planning_cancel', { session_id: sessionId })
  }

  // ── Execução do sprint workflow ────────────────────────────────────────────

  /** Exige sprint ativa e target_repo definido no projeto — 409/400 senão. */
  workflowStart(sprintId: string): Promise<McpResult<WorkflowRunView>> {
    return this.call('kanban_workflow_start', { sprint_id: sprintId })
  }

  workflowStop(sprintId: string): Promise<McpResult<WorkflowRunView>> {
    return this.call('kanban_workflow_stop', { sprint_id: sprintId })
  }

  workflowStatus(
    sprintId: string,
  ): Promise<McpResult<{ sprint_id: string; run: WorkflowRunView | null }>> {
    return this.call('kanban_workflow_status', { sprint_id: sprintId })
  }

  /**
   * GET /workflow/log segue o modelo do /metrics (rota própria, loopback, sem
   * token). Leitura incremental: devolva `size` como offset da próxima chamada.
   */
  async getWorkflowLog(
    sprintId: string,
    offset = 0,
  ): Promise<McpResult<WorkflowLogResult>> {
    const qs = new URLSearchParams({ sprint_id: sprintId, offset: String(offset) })
    try {
      const res = await fetch(`${this.baseUrl}/workflow/log?${qs.toString()}`)
      return toMcpResult(res.status, await res.json())
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: 'offline',
          message: 'não foi possível ler o log do workflow',
          cause: err instanceof Error ? err.message : String(err),
        },
      }
    }
  }

  // ── Épicos ─────────────────────────────────────────────────────────────────

  createEpic(params: {
    project: string
    name: string
    objective?: string
    sprint_ids?: string[]
  }): Promise<McpResult<{ project: string; epic: Epic }>> {
    return this.call('kanban_create_epic', params)
  }

  listEpics(project: string): Promise<McpResult<{ project: string; epics: Epic[] }>> {
    return this.call('kanban_list_epics', { project })
  }

  updateEpic(params: {
    project: string
    id: string
    name?: string
    objective?: string | null
    status?: 'open' | 'done' | 'dropped'
    sprint_ids?: string[]
  }): Promise<McpResult<{ project: string; epic: Epic }>> {
    return this.call('kanban_update_epic', params)
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
