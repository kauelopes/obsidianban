// ─────────────────────────────────────────────────────────────────────────────
// ObsidianKanban MCP — Normative TypeScript Interfaces
//
// Source of truth for the contract between MCP Server, Obsidian Plugin and
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
  goal: string                 // sprint goal text, max 1000 chars
  created_at: string           // ISO 8601 — when create_sprint was called
  started_at: string | null    // ISO 8601 — when start_sprint was called (null while planning)
  ended_at: string | null      // null while status!=='closed'
  status: 'planning' | 'active' | 'closed'
}

export type CardSummary = Omit<Card, 'body'>

// ─── Tokens ──────────────────────────────────────────────────────────────────

export interface AgentToken {
  role: 'agent'
  project_id: string
  actor: string
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
  body?: string
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
  | 'SPRINT_CREATED'
  | 'SPRINT_STARTED'
  | 'SPRINT_UPDATED'
  | 'SPRINT_CLOSED'

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
export interface SprintCreatedPayload     { sprint_id: string; project: string }
export interface SprintStartedPayload     { sprint_id: string; project: string }
export interface SprintUpdatedPayload     { sprint_id: string; project: string }
export interface SprintClosedPayload      { sprint_id: string; project: string }

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
  | SprintCreatedPayload
  | SprintStartedPayload
  | SprintUpdatedPayload
  | SprintClosedPayload

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
  | 'PROJECT_ARCHIVED' | 'PROJECT_UNARCHIVED' | 'PROJECT_DELETED'
  | 'SPRINT_CREATED' | 'SPRINT_STARTED' | 'SPRINT_CLOSED'
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

// ─── Plugin-specific ─────────────────────────────────────────────────────────

export type Resolution = 'keep-mine' | 'keep-theirs' | 'manual'

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

export interface Metrics {
  summary: { total_input_tokens: number; total_output_tokens: number; total_ops: number }
  by_type: Array<{ type: string; input_tokens: number; output_tokens: number; ops: number }>
  by_day: Array<{ date: string; input_tokens: number; output_tokens: number }>
  by_model: Array<{ model: string; input_tokens: number; output_tokens: number }>
  by_agent: Array<{ actor: string; input_tokens: number; output_tokens: number }>
  by_operation: Array<{ op: string; input_tokens: number; output_tokens: number; count: number }>
}
