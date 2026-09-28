import type {
  CardMove,
  HttpMethod,
  LlmCompletion,
  LlmProvider,
  ModuleContext,
  ModuleDataApi,
  ModuleRequest,
  ModuleResponse,
  ProjectInfo,
  RouteAuth,
  RouteHandler,
} from '@obsidiankan/module-sdk'
import type { CardSummary, EscalationItem, FlowMetrics, Metrics, MetricsFilter, Sprint } from '@obsidiankan/types'
import type { PdfRendererLike } from '../../server/pdf.js'

export const COLUMNS = ['backlog', 'todo', 'in_progress', 'review', 'done']

export function sprint(over: Partial<Sprint> = {}): Sprint {
  return {
    id: 'sprint-aaaa0001',
    name: 'S1',
    goal: 'Entregar o login',
    created_at: '2026-07-01T09:00:00.000Z',
    started_at: '2026-07-06T09:00:00.000Z',
    ended_at: '2026-07-10T18:00:00.000Z',
    status: 'closed',
    queued_at: null,
    ...over,
  }
}

export function project(over: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    name: 'alfa',
    archived: false,
    columns: [...COLUMNS],
    created_at: '2026-06-01T00:00:00.000Z',
    target_repo: null,
    sprints: [sprint()],
    goals: [],
    epics: [],
    ...over,
  }
}

export function card(over: Partial<CardSummary> & { id: string }): CardSummary {
  return {
    project: 'alfa',
    title: `Card ${over.id}`,
    status: 'todo',
    type: 'task',
    version: 1,
    position: 0,
    priority: 'medium',
    tags: [],
    due_date: null,
    assigned_to: null,
    owner: null,
    agent_notes: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_creation_tokens: 0,
    total_cost_usd: 0,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    created_by: 'human:x',
    updated_by: 'human:x',
    archived: false,
    sprint_id: 'sprint-aaaa0001',
    blocked_by: [],
    ...over,
  }
}

export function move(card_id: string, from: string, to: string, ts: string, projectName = 'alfa'): CardMove {
  return { ts, project: projectName, card_id, from_status: from, to_status: to, actor: 'agent:dev' }
}

export function emptyMetrics(): Metrics {
  return {
    summary: { total_input_tokens: 0, total_output_tokens: 0, total_cache_read_tokens: 0, total_cache_creation_tokens: 0, total_cost_usd: 0, total_ops: 0 },
    by_type: [],
    by_day: [],
    by_model: [],
    by_agent: [],
    by_role: [],
    by_operation: [],
    by_project: [],
    by_project_day: [],
  }
}

export function emptyFlow(): FlowMetrics {
  const zero = { count: 0, p50: 0, p90: 0, max: 0 }
  return {
    window_from: null,
    window_to: null,
    cycle_time_hours: zero,
    decision_latency_hours: zero,
    rework: { forward: 0, backward: 0, rate: 0, by_transition: [] },
    by_week: [],
    cost_reporting_starts: null,
    audit_truncated: false,
  }
}

export interface FakeDataInit {
  projects?: ProjectInfo[]
  cards?: CardSummary[]
  moves?: CardMove[]
  stalled?: EscalationItem[]
  metrics?: Metrics | ((filter: MetricsFilter) => Metrics)
  flow?: (filter: { project?: string }) => FlowMetrics
}

/** Fachada de dados em memória com a mesma semântica de filtro da real. */
export function fakeData(init: FakeDataInit = {}): ModuleDataApi {
  const projects = init.projects ?? [project()]
  const cards = init.cards ?? []
  const moves = init.moves ?? []
  return {
    metrics: (f = {}) => (typeof init.metrics === 'function' ? init.metrics(f) : (init.metrics ?? emptyMetrics())),
    flow: async (f = {}) => (init.flow ? init.flow(f) : emptyFlow()),
    digest: async () => {
      throw new Error('digest não usado')
    },
    stalledReviews: async (p) => (init.stalled ?? []).filter((s) => !p || s.project === p),
    listProjects: async (o = {}) => projects.filter((p) => o.includeArchived || !p.archived),
    getProject: async (name) => projects.find((p) => p.name === name) ?? null,
    listCards: (f = {}) =>
      cards.filter(
        (c) =>
          (!f.project || c.project === f.project) &&
          (!f.sprintId || c.sprint_id === f.sprintId) &&
          (f.includeArchived || !c.archived),
      ),
    moves: async (f = {}) => {
      const to = f.to_date ? `${f.to_date}T23:59:59.999Z` : null
      return {
        moves: moves.filter(
          (m) =>
            (!f.project || m.project === f.project) &&
            (!f.from_date || m.ts >= f.from_date) &&
            (!to || m.ts <= to),
        ),
        truncated: false,
      }
    },
  }
}

export class FakeLlm implements LlmProvider {
  readonly id = 'fake'
  readonly model = 'fake-1'
  prompts: string[] = []
  constructor(private readonly reply: Partial<LlmCompletion> = {}) {}
  async complete(req: { prompt: string }): Promise<LlmCompletion> {
    this.prompts.push(req.prompt)
    return {
      ok: true,
      text: '### Resumo\n\nTudo certo.\n\n### Destaques\n\n- a\n\n### Riscos\n\n- b\n\n### Recomendações\n\n- c',
      sessionId: null,
      usage: { input: 100, output: 50, usd: 0.01 },
      rateLimited: false,
      error: null,
      ...this.reply,
    }
  }
}

export function fakePdf(available = false): PdfRendererLike & { rendered: number } {
  const r = {
    rendered: 0,
    async status() {
      return { available, python: 'python-fake', reason: available ? null : 'python indisponível (teste)' }
    },
    async render(_doc: unknown, _theme: unknown, outPath: string) {
      if (!available) return { ok: false, error: 'python indisponível (teste)' }
      r.rendered++
      const fs = await import('node:fs/promises')
      await fs.writeFile(outPath, '%PDF-1.7 fake')
      return { ok: true, error: null }
    },
  }
  return r
}

export interface CapturedRoute {
  method: HttpMethod
  pattern: string
  auth: RouteAuth
  handler: RouteHandler
}

/** Contexto de módulo falso: captura rotas e eventos em vez de subir HTTP. */
export function fakeContext(dataDir: string, data: ModuleDataApi, llm: LlmProvider, config: Record<string, unknown> = {}) {
  const routes: CapturedRoute[] = []
  const events: Array<{ event: string; payload: unknown }> = []
  const noop = () => {}
  const ctx: ModuleContext = {
    manifest: { id: 'reports', name: 'Relatórios', version: 't', description: '' },
    logger: { debug: noop, info: noop, warn: noop, error: noop },
    dataDir,
    settings: () => ({ enabled: true, config }),
    data,
    llm,
    env: {},
    routes: { register: (method, pattern, auth, handler) => void routes.push({ method, pattern, auth, handler }) },
    events: { emit: (event, payload) => void events.push({ event, payload }) },
  }
  async function call(method: HttpMethod, pattern: string, req: Partial<ModuleRequest> = {}): Promise<ModuleResponse> {
    const r = routes.find((x) => x.method === method && x.pattern === pattern)
    if (!r) throw new Error(`rota não registrada: ${method} ${pattern}`)
    return r.handler({
      method,
      path: pattern,
      params: {},
      query: new URLSearchParams(),
      body: undefined,
      claims: { role: 'manager', actor: 'human:tester' },
      ...req,
    })
  }
  return { ctx, routes, events, call }
}
