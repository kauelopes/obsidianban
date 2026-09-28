// ─────────────────────────────────────────────────────────────────────────────
// @obsidiankan/module-sdk — contrato entre o core e os módulos opcionais.
//
// Um módulo só enxerga o que está aqui: nada de importar classes do server.
// Os dados chegam por uma fachada somente leitura tipada com os tipos de
// @obsidiankan/types, as rotas ficam sob /modules/<id>/ e os eventos saem
// pelo envelope SSE MODULE_EVENT. O lado web está em `@obsidiankan/module-sdk/web`.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  CardSummary,
  Epic,
  EscalationItem,
  FlowMetrics,
  Goal,
  Metrics,
  MetricsFilter,
  Sprint,
  TokenClaims,
  WeeklyDigest,
} from '@obsidiankan/types'

// ─── Módulo ──────────────────────────────────────────────────────────────────

export interface ModuleManifest {
  /** kebab-case, estável: vira prefixo de rota, pasta de dados e chave no modules.json. */
  id: string
  name: string
  version: string
  description: string
}

export interface ServerModule extends ModuleManifest {
  /**
   * Chamado uma vez no boot, sempre — com o módulo ativo ou não. Ativar e
   * desativar é gate em runtime (rotas respondem 404), sem restart.
   */
  register(ctx: ModuleContext): void | Promise<void>
}

export interface ModuleContext {
  manifest: ModuleManifest
  logger: ModuleLogger
  /** `.kanban/modules/<id>/` — criado antes do register(); é do módulo, o core não lê. */
  dataDir: string
  /** Estado atual no modules.json — lido a cada chamada, reflete toggles em runtime. */
  settings(): ModuleSettings
  data: ModuleDataApi
  llm: LlmProvider
  routes: ModuleRoutes
  events: ModuleEvents
  env: Readonly<Record<string, string | undefined>>
}

export interface ModuleSettings {
  enabled: boolean
  config: Record<string, unknown>
}

/** Subconjunto do pino que o core repassa, já com `module: <id>` no binding. */
export interface ModuleLogger {
  debug(obj: unknown, msg?: string): void
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

// ─── Dados (somente leitura) ─────────────────────────────────────────────────

export interface ProjectInfo {
  name: string
  archived: boolean
  columns: string[]
  created_at: string
  target_repo: string | null
  sprints: Sprint[]
  goals: Goal[]
  epics: Epic[]
}

export interface FlowFilter {
  from_date?: string
  to_date?: string
  project?: string
}

/** Uma transição de status, do audit log — a única fonte com data de cada MOVE. */
export interface CardMove {
  ts: string
  project: string
  card_id: string
  from_status: string
  to_status: string
  actor: string | null
}

export interface ModuleDataApi {
  metrics(filter?: MetricsFilter): Metrics
  flow(filter?: FlowFilter): Promise<FlowMetrics>
  digest(opts: { weekStart: string; tzOffsetMinutes?: number }): Promise<WeeklyDigest>
  /** Cards parados em review agora — estado atual, não histórico. */
  stalledReviews(project?: string): Promise<EscalationItem[]>
  listProjects(opts?: { includeArchived?: boolean }): Promise<ProjectInfo[]>
  getProject(name: string): Promise<ProjectInfo | null>
  listCards(filter?: { project?: string; sprintId?: string; includeArchived?: boolean }): CardSummary[]
  /** MOVEs do audit log na janela (datas YYYY-MM-DD, to_date inclusivo). */
  moves(filter?: FlowFilter): Promise<{ moves: CardMove[]; truncated: boolean }>
}

// ─── LLM ─────────────────────────────────────────────────────────────────────

export interface LlmRequest {
  prompt: string
  /** Continua uma conversa anterior do mesmo provider, quando ele suporta. */
  resumeSessionId?: string | null
  /** Aborta a chamada (o provider mata o processo/requisição em voo). */
  signal?: AbortSignal
}

export interface LlmCompletion {
  ok: boolean
  text: string
  sessionId: string | null
  usage: { input: number; output: number; usd: number }
  rateLimited: boolean
  error: string | null
}

/**
 * LLM generalista. O primeiro adapter é o `claude` headless do harness; um
 * adapter HTTP (OpenAI-compatível) implementa a mesma interface.
 */
export interface LlmProvider {
  /** ex.: 'claude-cli', 'stub' */
  readonly id: string
  /** Modelo explícito, ou null quando herda o default do provider. */
  readonly model: string | null
  complete(req: LlmRequest): Promise<LlmCompletion>
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

/**
 * - `lan`: sem token, só loopback ou LAN privada (mesma postura do /metrics)
 * - `bearer`: qualquer token válido
 * - `pm`: agente pm ou manager
 * - `manager`: só manager (inclui a sessão do navegador)
 */
export type RouteAuth = 'lan' | 'bearer' | 'pm' | 'manager'
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface ModuleRequest {
  method: HttpMethod
  /** Caminho depois de /modules/<id>, sempre começando com '/'. */
  path: string
  /** Segmentos `:nome` do padrão registrado. */
  params: Record<string, string>
  query: URLSearchParams
  /** JSON já parseado em POST/PUT; undefined nos demais. */
  body: unknown
  /** null só em rotas `lan`. */
  claims: TokenClaims | null
}

export type ModuleResponse =
  | { status?: number; json: unknown }
  | { status?: number; file: { data: Uint8Array; contentType: string; filename?: string } }

export type RouteHandler = (req: ModuleRequest) => Promise<ModuleResponse>

export interface ModuleRoutes {
  /** `pattern` relativo ao prefixo do módulo, ex.: '/', '/:id', '/:id/pdf'. */
  register(method: HttpMethod, pattern: string, auth: RouteAuth, handler: RouteHandler): void
}

/** Lançado por um handler para responder com status + corpo JSON. */
export class ModuleHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: Record<string, unknown>,
  ) {
    super(String(body['error'] ?? `http ${status}`))
    this.name = 'ModuleHttpError'
  }
}

// ─── Eventos ─────────────────────────────────────────────────────────────────

export interface ModuleEvents {
  /** Vira SSE `MODULE_EVENT` com `{ module: <id>, event, payload }`. */
  emit(event: string, payload: unknown): void
}
