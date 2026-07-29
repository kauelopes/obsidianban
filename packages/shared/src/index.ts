// ─────────────────────────────────────────────────────────────────────────────
// ObsidianKanban MCP — Normative TypeScript Interfaces
//
// Source of truth for the contract between MCP Server, web client and
// agents. Any divergence with PRD §5 (Data Model) or §6 (MCP API) is a
// design bug — fix here first, then propagate to implementation.
//
// Must compile with `tsc --noEmit --strict`.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Domain ──────────────────────────────────────────────────────────────────

export type Priority = 'low' | 'medium' | 'high' | 'critical'

export interface Card {
  id: string                   // card-{nanoid(8)} — immutable
  project: string              // folder name — immutable
  title: string                // max 200 chars
  status: string               // must match _meta.json columns
  type: string                 // immutable after creation
  version: number              // incremented on every write
  position: number             // unique per (project, status)
  priority: Priority
  tags: string[]               // max 20 items, max 50 chars each
  due_date: string | null      // YYYY-MM-DD
  assigned_to: string | null
  owner: string | null         // manager-only write
  agent_notes: string | null   // max 2000 chars
  total_input_tokens: number   // accumulated — never decremented
  total_output_tokens: number  // accumulated — never decremented
  created_at: string           // ISO 8601 — immutable
  updated_at: string           // ISO 8601 — MCP-managed
  created_by: string           // agent:|human:|external:
  updated_by: string           // agent:|human:|external:
  archived: boolean            // hidden from default listings; reversible
  sprint_id: string | null     // membership in a project Sprint
  blocked_by: string[]         // card_ids that must be done before this can advance
  body?: string                // present only in kanban_get_card
  file_basename?: string       // current .md basename (no extension); populated in API responses
}

export interface Sprint {
  id: string                   // sprint-{nanoid(8)}
  name: string                 // human-readable, max 80 chars
  goal: string | null          // sprint goal text, max 1000 chars; null when not provided
  created_at: string           // ISO 8601 — when create_sprint was called
  started_at: string | null    // ISO 8601 — when start_sprint was called (null while planning)
  ended_at: string | null      // null while status!=='closed'
  status: 'planning' | 'active' | 'closed'
}

export type CardSummary = Omit<Card, 'body'>

/**
 * Meta de médio prazo de um projeto. Vive no _meta.json do vault — editável no
 * Obsidian, visível aos agentes via kanban_list_projects. Progresso é humano:
 * status manual + prazo; nenhum % automático.
 */
export interface Goal {
  id: string                   // goal-{nanoid(8)}
  title: string                // max 120 chars
  target_date: string | null   // YYYY-MM-DD
  status: 'open' | 'done' | 'dropped'
  created_at: string           // ISO 8601
  notes?: string               // max 1000 chars
}

/**
 * Épico: agrupamento de sprints com um objetivo comum. Vive no _meta.json ao
 * lado de sprints e goals. O vínculo é épico → sprints (sprint_ids); um sprint
 * pertence a no máximo um épico. Progresso é derivado dos cards das sprints —
 * nenhum contador persistido.
 */
export interface Epic {
  id: string                   // epic-{nanoid(8)}
  name: string                 // max 120 chars
  objective: string | null     // max 1000 chars
  status: 'open' | 'done' | 'dropped'
  sprint_ids: string[]
  created_at: string           // ISO 8601
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

export interface AgentToken {
  role: 'agent'
  project_id: string
  actor: string
  /** 'pm' can call kanban_update_card; 'dev' is restricted to kanban_log_on_card. Legacy tokens without agent_type are treated as 'pm'. */
  agent_type: 'pm' | 'dev'
}

export interface ManagerToken {
  role: 'manager'
  actor: string
  // no project_id — full vault access
}

export type TokenClaims = AgentToken | ManagerToken

// ─── MCP API params ──────────────────────────────────────────────────────────

export interface TokenFields {
  input_tokens: number
  output_tokens: number
  model: string
}

export interface CreateCardParams extends TokenFields {
  title: string
  type: string
  project?: string          // required for manager, optional for agent (must match claims if sent)
  status?: string
  priority?: Priority
  tags?: string[]
  due_date?: string
  assigned_to?: string
  body?: string
  agent_notes?: string
  blocked_by?: string[]     // predecessor card ids (must be same project; validated server-side)
  sprint_id: string         // REQUIRED — every new card must belong to a planning/active sprint
  request_id?: string
}

export interface UpdateCardParams extends TokenFields {
  id: string
  version: number
  title?: string
  status?: string       // status change applies same position logic as move_card (PRD §5.4)
  priority?: Priority
  tags?: string[]
  due_date?: string | null
  assigned_to?: string | null
  agent_notes?: string
  /** Appends a timestamped entry to the card body. Body is write-once at creation; all subsequent writes must use log_entry. */
  log_entry?: string
  owner?: string        // manager only
  request_id?: string
}

export interface MoveCardParams extends TokenFields {
  id: string
  version: number
  to_status: string
  request_id?: string
}

export interface ReorderCardParams extends TokenFields {
  id: string
  version: number
  after_card_id: string | null
  request_id?: string
}

export interface DeleteCardParams extends TokenFields {
  id: string
  version: number
  request_id?: string
}

export interface ListCardsParams {
  /** Manager filtra qualquer projeto; token de agente já é forçado ao seu. */
  project?: string
  status?: string
  tags?: string[]
  assigned_to?: string
  limit?: number        // default 50, max 200
  offset?: number       // default 0
  order_by?: 'position' | 'updated_at' | 'priority' | 'due_date'
  include_archived?: boolean   // default false — archived cards hidden
  archived_only?: boolean      // default false — overrides include_archived
  include_archived_projects?: boolean  // default false — manager-only cascade opt-out
}

export interface ArchiveCardParams extends TokenFields {
  id: string
  version: number
  request_id?: string
}

export interface ReorderResult {
  card: Card
  affected_cards: Array<{ id: string; new_version: number; new_position: number }>
}

// ─── SSE events ──────────────────────────────────────────────────────────────

export type SSEEventType =
  | 'CARD_CREATED'
  | 'CARD_UPDATED'
  | 'CARD_MOVED'
  | 'CARD_REORDERED'
  | 'CARD_HUMAN_EDITED'
  | 'CARD_DELETED'
  | 'CARD_ARCHIVED'
  | 'CARD_UNARCHIVED'
  | 'PROJECT_ARCHIVED'
  | 'PROJECT_UNARCHIVED'
  | 'PROJECT_DELETED'
  | 'PROJECT_GOALS_UPDATED'
  | 'PROJECT_EPICS_UPDATED'
  | 'SPRINT_CREATED'
  | 'SPRINT_STARTED'
  | 'SPRINT_UPDATED'
  | 'SPRINT_CLOSED'
  | 'PLANNING_STEP_READY'
  | 'PLANNING_ERROR'
  | 'PLANNING_FINALIZED'
  | 'WORKFLOW_STARTED'
  | 'WORKFLOW_EXITED'

export interface CardCreatedPayload     { card_id: string; project: string; status: string; position: number }
export interface CardUpdatedPayload     { card_id: string; project: string; changed_fields: string[] }
export interface CardMovedPayload       { card_id: string; project: string; from_status: string; to_status: string; new_position: number }
export interface CardReorderedPayload   { project: string; status: string; affected_cards: Array<{ id: string; new_position: number }> }
export interface CardHumanEditedPayload { card_id: string; project: string; new_version: number }
export interface CardDeletedPayload     { card_id: string; project: string }
export interface CardArchivedPayload    { card_id: string; project: string }
export interface CardUnarchivedPayload  { card_id: string; project: string }
export interface ProjectArchivedPayload   { project: string }
export interface ProjectUnarchivedPayload { project: string }
export interface ProjectDeletedPayload    { project: string }
export interface ProjectEpicsUpdatedPayload { project: string }
export interface SprintCreatedPayload     { sprint_id: string; project: string }
export interface SprintStartedPayload     { sprint_id: string; project: string }
export interface SprintUpdatedPayload     { sprint_id: string; project: string }
export interface SprintClosedPayload      { sprint_id: string; project: string }
export interface PlanningStepReadyPayload { session_id: string; step_id: string; status: string }
export interface PlanningErrorPayload     { session_id: string; step_id: string; reason: string }
export interface PlanningFinalizedPayload { session_id: string; project: string }
export interface WorkflowStartedPayload  { sprint_id: string; project: string }
export interface WorkflowExitedPayload   { sprint_id: string; project: string; status: string; exit_code: number | null }

export type SSEEventPayload =
  | CardCreatedPayload
  | CardUpdatedPayload
  | CardMovedPayload
  | CardReorderedPayload
  | CardHumanEditedPayload
  | CardDeletedPayload
  | CardArchivedPayload
  | CardUnarchivedPayload
  | ProjectArchivedPayload
  | ProjectUnarchivedPayload
  | ProjectDeletedPayload
  | ProjectEpicsUpdatedPayload
  | SprintCreatedPayload
  | SprintStartedPayload
  | SprintUpdatedPayload
  | SprintClosedPayload
  | PlanningStepReadyPayload
  | PlanningErrorPayload
  | PlanningFinalizedPayload
  | WorkflowStartedPayload
  | WorkflowExitedPayload

export interface SSEEvent {
  type: SSEEventType
  payload: SSEEventPayload
}

export type SSEHandler<T extends SSEEventPayload = SSEEventPayload> = (payload: T) => void

// ─── Audit ───────────────────────────────────────────────────────────────────

export type AuditOp =
  | 'CREATE' | 'UPDATE' | 'MOVE' | 'REORDER' | 'DELETE'
  | 'ARCHIVE' | 'UNARCHIVE'
  | 'CLAIM' | 'RELEASE'
  | 'PROJECT_ARCHIVED' | 'PROJECT_UNARCHIVED' | 'PROJECT_DELETED' | 'PROJECT_REPO_SET'
  | 'GOAL_SET' | 'GOAL_DELETED'
  | 'EPIC_SET'
  | 'SPRINT_CREATED' | 'SPRINT_STARTED' | 'SPRINT_CLOSED'
  | 'WORKFLOW_DEV' | 'WORKFLOW_TRIAGE'
  | 'HUMAN_EDIT' | 'FIELD_REVERTED' | 'PARSE_ERROR'
  | 'RECONCILED' | 'ORPHAN_REMOVED' | 'SQLITE_REBUILT' | 'EXTERNAL_MUTATION'

export interface AuditEntry {
  ts: string
  op: AuditOp
  project?: string
  card_id?: string
  version?: number
  actor?: string
  // present only in mutating MCP ops (CREATE, UPDATE, MOVE, REORDER):
  input_tokens?: number
  output_tokens?: number
  model?: string
  // usage medido do harness — input/output EXCLUEM cache; cost_usd é o
  // total_cost_usd autoritativo (estimativas por token subestimam sem isto):
  cache_read_tokens?: number
  cache_creation_tokens?: number
  cost_usd?: number
  sprint_id?: string          // WORKFLOW_* (registro por round)
  turns?: number              // WORKFLOW_* — turnos do harness no round
  // op-specific:
  changed_fields?: string[]    // UPDATE
  from_status?: string         // MOVE
  to_status?: string           // MOVE
  affected_cards?: string[]    // REORDER
  field?: string               // FIELD_REVERTED
  reason?: string              // FIELD_REVERTED, PARSE_ERROR
  card_count?: number          // SQLITE_REBUILT
}

// ─── Error responses ─────────────────────────────────────────────────────────

export interface ConflictError {
  error: 'conflict'
  message: string
  your_version: number
  current_version: number
  conflicting_fields: string[]
  current_card: Card
}

export interface ValidationError {
  error: 'invalid_fields'
  message: string
  disallowed_fields: string[]
  allowed_fields: string[]
}

// ─── Workflow readiness ───────────────────────────────────────────────────────

export interface SkillFileCheck {
  path: string         // relative to .claude/skills/ (e.g. 'kanban-pm-agent/SKILL.md')
  was_present: boolean
  installed: boolean   // true = copied during this check
}

export interface GeneratedToken {
  token: string
  token_id: string
  actor: string
  agent_type: 'pm' | 'dev'
}

export interface ConfigFileCheck {
  path: string         // relative to target_repo (e.g. '.claude/mcp.json')
  was_present: boolean
  written: boolean     // true = created or updated during this check
  detail?: string      // e.g. 'url corrected'
}

export interface WorkflowReadinessResult {
  target_repo: string
  repo_exists: boolean
  skills: SkillFileCheck[]
  config_files: ConfigFileCheck[]
  tokens: {
    has_pm: boolean
    has_dev: boolean
    generated_pm?: GeneratedToken
    generated_dev?: GeneratedToken
  }
  all_ok: boolean  // true = nothing needed to be installed or generated
}

// ─── Execução do sprint workflow ─────────────────────────────────────────────

export type WorkflowRunStatus = 'running' | 'exited' | 'failed' | 'stopped'

/**
 * Estado de uma execução do sprint workflow (o orquestrador que roda os
 * agentes). Vive em memória no servidor: após um restart, `status` some mas o
 * log em disco continua legível via GET /workflow/log.
 */
export interface WorkflowRunView {
  sprint_id: string
  project: string
  pid: number | null
  status: WorkflowRunStatus
  started_at: string
  ended_at: string | null
  exit_code: number | null
}

export interface WorkflowLogResult {
  sprint_id: string
  run: WorkflowRunView | null
  /** Tamanho total do log em bytes — passe de volta como offset na próxima leitura. */
  size: number
  /** Conteúdo a partir do offset pedido (limitado a um chunk por chamada). */
  data: string
}

// ─── Tool response envelopes ──────────────────────────────────────────────────
//
// Todas as formas abaixo foram capturadas de um servidor rodando e gravadas em
// packages/web/tests/fixtures/. Não derive nenhuma delas "do que parece
// razoável": as três fases anteriores da migração web quebraram exatamente
// assim. Em particular, note que:
//   - add_to_sprint e move_between_sprints NÃO têm a mesma forma;
//   - failed[] carrega objetos, não ids;
//   - target_repo é AUSENTE (não null) quando não está definido.

/** Motivo por card numa operação de lote parcialmente bem-sucedida. */
export interface CardOpFailure {
  card_id: string
  reason: string
}

export interface SprintAggregates {
  cards_total: number
  cards_done: number
  cards_in_progress: number
  cards_todo: number
  cards_other: number
  total_input_tokens: number
  total_output_tokens: number
}

export interface GetSprintResult {
  sprint: Sprint
  project: string
  cards: CardSummary[]
  aggregates: SprintAggregates
}

export interface AddToSprintResult {
  sprint_id: string
  updated: string[]
  added: string[]
  moved_to_todo: string[]
  failed: CardOpFailure[]
}

/** Sem `added`/`moved_to_todo` — a forma difere de AddToSprintResult. */
export interface MoveBetweenSprintsResult {
  sprint_id: string
  target_sprint_id: string
  updated: string[]
  failed: CardOpFailure[]
}

export interface ProjectShapeResult {
  project: string
  columns: string[]
  archived: boolean
  /** Ausente quando não há repo definido — não é null. */
  target_repo?: string
}

/**
 * `kanban_set_project_repo` devolve a forma do projeto MAIS um relatório de
 * prontidão do workflow, e como efeito colateral minta os tokens de pm e dev
 * quando eles ainda não existem. É a única via de UI para os tokens que o
 * sprint workflow precisa.
 */
export interface SetProjectRepoResult extends ProjectShapeResult {
  workflow_readiness?: WorkflowReadinessResult
}

export interface DeleteProjectResult {
  project: string
  cards_deleted: number
}

// ─── Estimativa de custo ──────────────────────────────────────────────────────

/**
 * Preço por token, em USD, por modelo.
 *
 * Isto é uma ESTIMATIVA e a UI tem de rotular como tal. O número autoritativo é
 * o `total_cost_usd` que o harness devolve ao sprint workflow; aqui só há
 * tokens agregados por modelo, então o custo é reconstruído por multiplicação.
 *
 * Tabela de preço envelhece. Quando um valor estiver errado, o lugar de
 * corrigir é aqui e em PRICE, no packages/server/scripts/sprint-workflow.ts.
 * Modelo desconhecido devolve null em vez de zero: "não sei" não é "de graça".
 */
export const MODEL_PRICES_USD_PER_TOKEN: Readonly<
  Record<string, { input: number; output: number }>
> = {
  'claude-opus-4-8': { input: 5 / 1_000_000, output: 25 / 1_000_000 },
  'claude-opus-4-6': { input: 5 / 1_000_000, output: 25 / 1_000_000 },
  'claude-sonnet-4-6': { input: 3 / 1_000_000, output: 15 / 1_000_000 },
  'claude-sonnet-4-5': { input: 3 / 1_000_000, output: 15 / 1_000_000 },
  'claude-haiku-4-5': { input: 1 / 1_000_000, output: 5 / 1_000_000 },
  // OpenAI — ≈ aproximado; conferir contra a tabela pública quando o Codex
  // começar a reportar de verdade.
  'gpt-5.2': { input: 1.25 / 1_000_000, output: 10 / 1_000_000 },
  'gpt-5.1': { input: 1.25 / 1_000_000, output: 10 / 1_000_000 },
  'gpt-5.2-codex': { input: 1.25 / 1_000_000, output: 10 / 1_000_000 },
  'gpt-5.1-codex': { input: 1.25 / 1_000_000, output: 10 / 1_000_000 },
  'gpt-5.1-codex-mini': { input: 0.25 / 1_000_000, output: 2 / 1_000_000 },
  'codex-mini': { input: 0.25 / 1_000_000, output: 2 / 1_000_000 },
}

/**
 * Custo estimado de um par de contagens, ou null quando o modelo não está na
 * tabela — inclusive os pseudo-modelos `human`, `plugin` e `unknown`, que o
 * servidor grava e que não têm preço nenhum.
 */
export function estimateUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = MODEL_PRICES_USD_PER_TOKEN[model]
  if (!price) return null
  return inputTokens * price.input + outputTokens * price.output
}

export type ModelProvider = 'anthropic' | 'openai' | 'other'

/**
 * Provedor inferido do nome do modelo, para a UI agrupar uso e custo. O campo
 * `model` é string livre no protocolo, então isto é heurística de exibição —
 * modelo desconhecido (e os pseudo-modelos human/plugin/unknown) cai em
 * 'other' em vez de ganhar uma bandeira errada.
 */
export function providerOf(model: string): ModelProvider {
  if (model.startsWith('claude-')) return 'anthropic'
  if (model.startsWith('gpt-') || model.startsWith('codex-') || /^o\d+(-|$)/.test(model)) {
    return 'openai'
  }
  return 'other'
}

export interface CardHistoryResult {
  card_id: string
  /**
   * Mais recente primeiro. Além de `ts` e `op`, todo campo é opcional e varia
   * por call site — checar presença, não inferir a forma pelo `op`.
   */
  entries: AuditEntry[]
  truncated: boolean
}

export interface EscalationItem {
  card_id: string
  project: string
  title: string
  status: string
  version: number
  priority: string
  assigned_to: string | null
  updated_at: string
  escalated_at: string | null
  /** O texto da entrada que escalou: é a pergunta esperando decisão. */
  reason: string
}

export interface EscalationsResult {
  escalations: EscalationItem[]
  /** Quantos cards foram varridos, para a UI poder dizer do que fala. */
  scanned: number
}

export interface CreateAgentTokenResult {
  project: string
  token: string
  token_id: string
  actor: string
  agent_type: 'pm' | 'dev'
  created_at: string
}

// ─── Planejamento (wizard KAD) ───────────────────────────────────────────────

export type PlanningStatus =
  | 'awaiting_user'
  | 'generating'
  | 'materializing'
  | 'done'
  | 'error'
  | 'cancelled'

export type PlanningScreenType = 'form' | 'choice' | 'list' | 'diagram' | 'confirm'

export interface PlanningFormField {
  id: string
  label: string
  help?: string
  value?: string
}
export interface PlanningFormPayload { fields: PlanningFormField[] }
export interface PlanningChoiceOption { id: string; label: string; description?: string }
export interface PlanningChoicePayload {
  question: string
  options: PlanningChoiceOption[]
  suggested?: string
}
export interface PlanningListItem { id: string; title: string; detail?: string }
export interface PlanningListPayload { intro?: string; items: PlanningListItem[] }
export interface PlanningDiagramPayload { mermaid: string; caption?: string }
export interface PlanningConfirmPayload { markdown: string }

/** outputs[step] — o que o servidor guardou para renderizar a tela da etapa. */
export interface PlanningStepOutput {
  screen_payload: unknown
  /** Presente só na etapa sprints_tasks: a estrutura épicos→sprints→tarefas. */
  structure?: unknown
}

/**
 * Visão da sessão de planejamento devolvida pelas tools kanban_planning_*.
 * O servidor guarda campos internos a mais (claude_session_id, last_prompt,
 * checkpoint de materialização) — o contrato daqui é o que a web usa.
 */
export interface PlanningSessionView {
  session_id: string
  status: PlanningStatus
  current_step: string
  answers: Record<string, unknown>
  outputs: Record<string, PlanningStepOutput>
  kad: Record<string, string>
  project_name: string | null
  target_repo: string | null
  usage: { input_tokens: number; output_tokens: number; usd: number; turns: number }
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface PlanningFinalizeResult {
  session_id: string
  project: string
  /** Presente só na primeira passada da materialização — não é recuperável. */
  token: string | null
  token_id: string | null
  workflow_readiness?: WorkflowReadinessResult
  token_hint?: string
  epics: number
  sprints: number
  cards_created: number
  cards_failed: Array<{ sprint: string; index: number; error: string }>
  goals: number
  kad_files: string[]
  repo_copy_ok: boolean | null
}

// ─── Client-specific ─────────────────────────────────────────────────────────

export interface BoardData {
  projects: Array<{
    id: string
    columns: string[]
    cards: Record<string, CardSummary[]>  // status → cards ordered by position
  }>
}

export interface OptimisticOp {
  id: string
  type: 'move' | 'create' | 'reorder'
  snapshot: BoardData
}

export interface MetricsFilter {
  from_date?: string
  to_date?: string
}

/**
 * `cost_usd` é a soma do custo MEDIDO (relatado pelas tools) — 0 em linhas
 * antigas/sem medição; `cache_*_tokens` ficam fora de input/output. Quando
 * cost_usd > 0, ele é autoritativo sobre estimativas derivadas de tokens.
 */
export interface Metrics {
  summary: {
    total_input_tokens: number
    total_output_tokens: number
    total_cache_read_tokens: number
    total_cache_creation_tokens: number
    total_cost_usd: number
    total_ops: number
  }
  by_type: Array<{ type: string; input_tokens: number; output_tokens: number; cost_usd: number; ops: number }>
  by_day: Array<{ date: string; input_tokens: number; output_tokens: number; cost_usd: number }>
  by_model: Array<{ model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number; cost_usd: number }>
  by_agent: Array<{ actor: string; input_tokens: number; output_tokens: number; cost_usd: number }>
  by_operation: Array<{ op: string; input_tokens: number; output_tokens: number; cost_usd: number; count: number }>
  by_project: Array<{ project: string; input_tokens: number; output_tokens: number; cost_usd: number; ops: number }>
  /** Cruzamento projeto×dia (datas UTC) — a série que alimenta visões de ritmo. */
  by_project_day: Array<{
    project: string
    date: string
    input_tokens: number
    output_tokens: number
    cost_usd: number
    ops: number
  }>
}

// ─── Activity (GET /activity) ────────────────────────────────────────────────

/** Um dia no fuso do usuário — datas locais, ao contrário do Metrics (UTC). */
export interface ProjectDayActivity {
  date: string      // YYYY-MM-DD no fuso pedido via tz_offset
  card_ops: number  // operações no kanban (token_log), humanas e de agente
  commits: number   // commits no target_repo; 0 quando repo_unavailable
}

export interface ProjectActivity {
  project: string
  /** Janela completa, mais antigo primeiro, dias sem atividade incluídos zerados. */
  days: ProjectDayActivity[]
  /** Sessões (gap 30min) dos últimos 7 dias, ops + commits. Heurística — exibir com ≈. */
  estimated_hours_week: number
  /** target_repo ausente, não-git ou inacessível — sinal, não erro. */
  repo_unavailable?: boolean
}

export interface ActivityResponse {
  window_days: number
  tz_offset_minutes: number
  projects: ProjectActivity[]
}

// ─── Card body zones ─────────────────────────────────────────────────────────
// Lives here rather than in the server so the web app parses card bodies with
// the exact same code the server writes them with — a second implementation
// would drift, and the zone split is a contract, not an implementation detail.
export * from './sections.js'
