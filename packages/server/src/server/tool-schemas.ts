/**
 * JSON Schema definitions for every MCP tool.
 * Consumed by StdioMcpServer and McpHttpManager to populate ListTools.
 * Proper types prevent MCP clients from serialising integers/arrays as strings.
 */

type Schema = Record<string, unknown>

const TOKEN_FIELDS = {
  input_tokens:  { type: 'integer', minimum: 0, default: 0, description: 'usage.input_tokens from the API response — omit or pass 0 if unavailable. NOTE: excludes cache tokens; report those separately.' },
  output_tokens: { type: 'integer', minimum: 0, default: 0, description: 'usage.output_tokens from the API response — omit or pass 0 if unavailable' },
  cache_read_tokens:     { type: 'integer', minimum: 0, default: 0, description: 'usage.cache_read_input_tokens from the API response — cache tokens are NOT included in input_tokens' },
  cache_creation_tokens: { type: 'integer', minimum: 0, default: 0, description: 'usage.cache_creation_input_tokens from the API response' },
  cost_usd:      { type: 'number', minimum: 0, default: 0, description: 'measured cost in USD (e.g. total_cost_usd from the Claude Code harness) — authoritative over token-derived estimates' },
  model:         { type: 'string', description: "model identifier — e.g. 'claude-sonnet-4-6'" },
  request_id:    { type: 'string', description: 'idempotency key — use a UUID or nanoid generated once per logical operation. Retrying with the same id returns the cached response without side effects. Recommended whenever the network may be unreliable.' },
} as const

const CARD_ITEM_SCHEMA = {
  type: 'object',
  required: ['title', 'type'],
  properties: {
    title:    { type: 'string', maxLength: 200 },
    type:     { type: 'string', enum: ['task', 'feature', 'bug', 'chore'] },
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    status:   { type: 'string', description: "column slug — must match project columns exactly. Default columns: 'backlog', 'todo', 'in_progress', 'review', 'done'" },
    tags:     { type: 'array', items: { type: 'string' }, maxItems: 20 },
    due_date: { type: 'string', description: 'YYYY-MM-DD' },
    assigned_to: { type: 'string' },
    body:     { type: 'string' },
    blocked_by: { type: 'array', items: { type: 'string' } },
    agent_notes: { type: 'string', maxLength: 2000 },
  },
  additionalProperties: false,
}

export const TOOL_SCHEMAS: Record<string, Schema> = {
  kanban_list_cards: {
    type: 'object',
    properties: {
      project:   { type: 'string' },
      status:    { type: 'string', description: "filter by column slug — e.g. 'backlog', 'todo', 'in_progress', 'review', 'done'" },
      sprint_id: { type: 'string' },
      assigned_to: { type: 'string' },
      tags:      { type: 'array', items: { type: 'string' } },
      limit:     { type: 'integer', minimum: 1, maximum: 200 },
      offset:    { type: 'integer', minimum: 0 },
      order_by:  { type: 'string', enum: ['position', 'updated_at', 'priority', 'due_date'] },
      include_archived:          { type: 'boolean' },
      archived_only:             { type: 'boolean' },
      include_archived_projects: { type: 'boolean' },
    },
    additionalProperties: false,
  },

  kanban_get_card: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
    additionalProperties: false,
  },

  kanban_create_card: {
    type: 'object',
    required: ['title', 'type', 'sprint_id'],
    properties: {
      project:     { type: 'string', description: "required for manager tokens; inferred from token for agent tokens — passing a value different from the token's project returns an error" },
      title:       { type: 'string', maxLength: 200 },
      type:        { type: 'string', enum: ['task', 'feature', 'bug', 'chore'] },
      sprint_id:   { type: 'string' },
      status:      { type: 'string', description: "column slug — defaults to 'backlog'. Default columns: backlog, todo, in_progress, review, done." },
      priority:    { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      tags:        { type: 'array', items: { type: 'string' }, maxItems: 20 },
      due_date:    { type: 'string', description: 'YYYY-MM-DD' },
      assigned_to: { type: 'string' },
      body:        { type: 'string', description: 'write-once at creation; use kanban_log_on_card afterwards' },
      blocked_by:  { type: 'array', items: { type: 'string' } },
      agent_notes: { type: 'string', maxLength: 2000 },
      ...TOKEN_FIELDS,
    },
    additionalProperties: false,
  },

  kanban_bulk_create_cards: {
    type: 'object',
    required: ['cards'],
    properties: {
      project:   { type: 'string', description: "required for manager tokens; for agent tokens this field is optional — passing a value different from the token's project returns an error" },
      sprint_id: { type: 'string', description: 'applied to every card in the batch when set' },
      cards: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: CARD_ITEM_SCHEMA,
      },
      ...TOKEN_FIELDS,
    },
    additionalProperties: false,
  },

  kanban_update_card: {
    type: 'object',
    required: ['id', 'version'],
    properties: {
      id:          { type: 'string' },
      version:     { type: 'integer', minimum: 1 },
      title:       { type: 'string', maxLength: 200 },
      status:      { type: 'string', description: "column slug — e.g. 'in_progress'. Default columns: backlog, todo, in_progress, review, done." },
      priority:    { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      tags:        { type: 'array', items: { type: 'string' }, maxItems: 20 },
      due_date:    { type: ['string', 'null'], description: 'YYYY-MM-DD or null to clear' },
      assigned_to: { type: 'string' },
      blocked_by:  { type: 'array', items: { type: 'string' } },
      agent_notes: { type: 'string', maxLength: 2000 },
      log_entry:   { type: 'string', maxLength: 4000, description: 'appended to # Agent Log with ISO 8601 timestamp. Prefer kanban_log_on_card when the sole purpose is logging; use this field in kanban_update_card when updating other fields at the same time.' },
      log_kind:    { type: 'string', enum: ['progress', 'escalate', 'done', 'pm_resolved'], description: "nature of the log_entry above. Defaults to 'progress'." },
      sprint_id:   { type: 'string' },
      actor:       { type: 'string' },
      ...TOKEN_FIELDS,
    },
    additionalProperties: false,
  },

  kanban_update_spec: {
    type: 'object',
    required: ['id', 'version', 'spec'],
    properties: {
      id:      { type: 'string' },
      version: { type: 'integer', minimum: 1 },
      spec:    { type: 'string', maxLength: 100000, description: 'full replacement text for the # Spec section (markdown; supports mermaid and $...$ math). Empty string clears it.' },
      ...TOKEN_FIELDS,
    },
    additionalProperties: false,
  },

  kanban_update_notes: {
    type: 'object',
    required: ['id', 'version', 'notes'],
    properties: {
      id:      { type: 'string' },
      version: { type: 'integer', minimum: 1 },
      notes:   { type: 'string', maxLength: 100000, description: 'full replacement text for the # Notes section (markdown). Empty string clears it.' },
      ...TOKEN_FIELDS,
    },
    additionalProperties: false,
  },

  kanban_log_on_card: {
    type: 'object',
    required: ['id', 'version', 'log_entry'],
    properties: {
      id:        { type: 'string' },
      version:   { type: 'integer', minimum: 1 },
      log_entry: { type: 'string', maxLength: 4000, description: 'appended to # Agent Log with ISO 8601 timestamp; supports markdown and mermaid diagrams. Use kanban_log_on_card when you ONLY want to log progress without changing other fields; use kanban_update_card when you need to update other fields AND log at the same time.' },
      log_kind: {
        type: 'string',
        enum: ['progress', 'escalate', 'done', 'pm_resolved'],
        description: "nature of this entry. Defaults to 'progress'. Use 'escalate' when you are blocked and need a human decision — this is what puts the card in the human's escalation inbox, so prefer it over writing [ESCALATE] in the text. Use 'pm_resolved' when answering an escalation.",
      },
      ...TOKEN_FIELDS,
    },
    additionalProperties: false,
  },

  kanban_get_card_history: {
    type: 'object',
    required: ['id'],
    properties: {
      id:    { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    },
    additionalProperties: false,
  },

  kanban_list_escalations: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'restrict to one project; omit for the whole vault (managers only — agent tokens are always scoped to their own project)' },
    },
    additionalProperties: false,
  },

  kanban_move_card: {
    type: 'object',
    required: ['id', 'version', 'to_status'],
    properties: {
      id:        { type: 'string' },
      version:   { type: 'integer', minimum: 1 },
      to_status: { type: 'string', description: "column slug — e.g. 'in_progress'. Default columns: backlog, todo, in_progress, review, done." },
      ...TOKEN_FIELDS,
    },
    additionalProperties: false,
  },

  kanban_reorder_card: {
    type: 'object',
    required: ['id', 'version', 'after_card_id'],
    properties: {
      id:            { type: 'string' },
      version:       { type: 'integer', minimum: 1 },
      after_card_id: { type: ['string', 'null'], description: 'id of the card to insert after, or JSON null to move to top. Must be JSON null — the string "null" is not accepted. IMPORTANT: reordering bumps the version of all other cards in the same column (see affected_cards in the response).' },
      ...TOKEN_FIELDS,
    },
    additionalProperties: false,
  },

  kanban_delete_card: {
    type: 'object',
    required: ['id', 'version'],
    properties: {
      id:      { type: 'string' },
      version: { type: 'integer', minimum: 1 },
      ...TOKEN_FIELDS,
    },
    additionalProperties: false,
  },

  kanban_archive_card: {
    type: 'object',
    required: ['id', 'version'],
    properties: {
      id:      { type: 'string' },
      version: { type: 'integer', minimum: 1 },
      ...TOKEN_FIELDS,
    },
    additionalProperties: false,
  },

  kanban_unarchive_card: {
    type: 'object',
    required: ['id', 'version'],
    properties: {
      id:      { type: 'string' },
      version: { type: 'integer', minimum: 1 },
      ...TOKEN_FIELDS,
    },
    additionalProperties: false,
  },

  kanban_claim_card: {
    type: 'object',
    required: ['id', 'version'],
    properties: {
      id:      { type: 'string' },
      version: { type: 'integer', minimum: 1 },
      ...TOKEN_FIELDS,
    },
    additionalProperties: false,
  },

  kanban_release_card: {
    type: 'object',
    required: ['id', 'version'],
    properties: {
      id:               { type: 'string' },
      version:          { type: 'integer', minimum: 1 },
      revert_to_status: { type: ['string', 'null'], description: "column to move the card back to when releasing from a forward status (in_progress, review…). Defaults to 'todo' so the card is immediately visible to pick_next. Pass null to keep the current status unchanged." },
      ...TOKEN_FIELDS,
    },
    additionalProperties: false,
  },

  kanban_defer_card: {
    type: 'object',
    required: ['id', 'version', 'blocked_by', 'log_entry'],
    properties: {
      id:         { type: 'string' },
      version:    { type: 'integer', minimum: 1 },
      blocked_by: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'card id(s) this card depends on — including a card currently in review. Merged with any existing blocked_by, deduped.' },
      log_entry:  { type: 'string', maxLength: 4000, description: 'appended to # Agent Log explaining why the card was deferred.' },
      ...TOKEN_FIELDS,
    },
    additionalProperties: false,
  },

  kanban_pick_next: {
    type: 'object',
    properties: {
      project:     { type: 'string', description: 'for manager tokens: required to scope results; for agent tokens: always uses the token project (this field is ignored)' },
      sprint_id:   { type: 'string' },
      assigned_to: { type: 'string' },
      status:      { type: 'string', description: "column to pick from — defaults to 'todo'. Cards move from backlog to todo automatically when the sprint is started. When card is null, check the 'reason' field: 'no_active_sprint' = backlog has cards but no sprint is active yet (call kanban_start_sprint), 'no_todo_cards' = sprint is active but something else is blocking promotion, 'all_blocked' = all todo cards have unmet dependencies, 'empty' = sprint has no cards." },
    },
    additionalProperties: false,
  },

  kanban_workflow_start: {
    type: 'object',
    required: ['sprint_id'],
    properties: { sprint_id: { type: 'string' } },
    additionalProperties: false,
  },

  kanban_workflow_stop: {
    type: 'object',
    required: ['sprint_id'],
    properties: { sprint_id: { type: 'string' } },
    additionalProperties: false,
  },

  kanban_workflow_status: {
    type: 'object',
    required: ['sprint_id'],
    properties: { sprint_id: { type: 'string' } },
    additionalProperties: false,
  },

  kanban_log_workflow_usage: {
    type: 'object',
    required: ['sprint_id', 'kind'],
    properties: {
      sprint_id: { type: 'string' },
      kind:      { type: 'string', enum: ['dev', 'triage'], description: 'which workflow stage spent the tokens' },
      turns:     { type: 'integer', minimum: 0, default: 0, description: 'harness turns in this round' },
      ...TOKEN_FIELDS,
    },
    additionalProperties: false,
  },

  kanban_create_project: {
    type: 'object',
    required: ['project', 'actor'],
    properties: {
      project:     { type: 'string', description: 'letters, numbers, dots, underscores, hyphens — no spaces' },
      actor:       { type: 'string' },
      target_repo: { type: 'string', description: 'optional absolute path to the git repo used when launching sprint workflows for this project' },
    },
    additionalProperties: false,
  },

  kanban_set_project_repo: {
    type: 'object',
    required: ['project', 'target_repo'],
    properties: {
      project:     { type: 'string' },
      target_repo: { type: ['string', 'null'], description: 'absolute path to the git repo used as cwd for sprint workflow launch, or null to clear. When not set, starting a sprint skips the workflow and logs a warning.' },
    },
    additionalProperties: false,
  },

  kanban_set_goal: {
    type: 'object',
    required: [],
    properties: {
      project:     { type: 'string', description: 'required for managers; pm agents are scoped to their own project' },
      id:          { type: 'string', description: 'goal id to update; omit to create' },
      title:       { type: 'string', description: 'max 120 chars; required on create' },
      target_date: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null to clear' },
      status:      { type: 'string', enum: ['open', 'done', 'dropped'] },
      notes:       { type: 'string', description: 'max 1000 chars' },
    },
    additionalProperties: false,
  },

  kanban_delete_goal: {
    type: 'object',
    required: ['id'],
    properties: {
      project: { type: 'string', description: 'required for managers; pm agents are scoped to their own project' },
      id:      { type: 'string' },
    },
    additionalProperties: false,
  },

  kanban_planning_start: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },

  kanban_planning_get: {
    type: 'object',
    required: ['session_id'],
    properties: { session_id: { type: 'string' } },
    additionalProperties: false,
  },

  kanban_planning_answer: {
    type: 'object',
    required: ['session_id', 'step', 'answer'],
    properties: {
      session_id: { type: 'string' },
      step:       { type: 'string', description: 'must equal the session current_step — 409 step_mismatch otherwise' },
      answer:     { description: 'the human answer; shape depends on the screen: form → {fieldId: value}, choice → {choice}, list → {items}, diagram/confirm → {approved: true}' },
    },
    additionalProperties: false,
  },

  kanban_planning_refine: {
    type: 'object',
    required: ['session_id', 'feedback'],
    properties: {
      session_id: { type: 'string' },
      feedback:   { type: 'string', maxLength: 4000, description: 'what to correct in the current screen' },
    },
    additionalProperties: false,
  },

  kanban_planning_retry: {
    type: 'object',
    required: ['session_id'],
    properties: { session_id: { type: 'string' } },
    additionalProperties: false,
  },

  kanban_planning_finalize: {
    type: 'object',
    required: ['session_id'],
    properties: { session_id: { type: 'string' } },
    additionalProperties: false,
  },

  kanban_planning_cancel: {
    type: 'object',
    required: ['session_id'],
    properties: { session_id: { type: 'string' } },
    additionalProperties: false,
  },

  kanban_planning_list: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },

  kanban_create_epic: {
    type: 'object',
    required: ['name'],
    properties: {
      project:    { type: 'string', description: 'required for managers; pm agents are scoped to their own project' },
      name:       { type: 'string', maxLength: 120 },
      objective:  { type: 'string', maxLength: 1000 },
      sprint_ids: { type: 'array', items: { type: 'string' }, description: 'sprints to attach — each sprint may belong to at most one epic' },
    },
    additionalProperties: false,
  },

  kanban_list_epics: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'required for managers; pm agents are scoped to their own project' },
    },
    additionalProperties: false,
  },

  kanban_update_epic: {
    type: 'object',
    required: ['id'],
    properties: {
      project:    { type: 'string', description: 'required for managers; pm agents are scoped to their own project' },
      id:         { type: 'string' },
      name:       { type: 'string', maxLength: 120 },
      objective:  { type: ['string', 'null'], description: 'max 1000 chars, or null to clear' },
      status:     { type: 'string', enum: ['open', 'done', 'dropped'] },
      sprint_ids: { type: 'array', items: { type: 'string' }, description: 'full replacement of the attached sprints' },
    },
    additionalProperties: false,
  },

  kanban_create_agent_token: {
    type: 'object',
    required: ['project', 'actor'],
    properties: {
      project:    { type: 'string' },
      actor:      { type: 'string' },
      agent_type: { type: 'string', enum: ['pm', 'dev'], description: 'pm = full update access; dev = log-only' },
    },
    additionalProperties: false,
  },

  kanban_list_projects: {
    type: 'object',
    properties: {
      include_archived: { type: 'boolean' },
      archived_only:    { type: 'boolean' },
    },
    additionalProperties: false,
  },

  kanban_archive_project: {
    type: 'object',
    required: ['project'],
    properties: { project: { type: 'string' } },
    additionalProperties: false,
  },

  kanban_unarchive_project: {
    type: 'object',
    required: ['project'],
    properties: { project: { type: 'string' } },
    additionalProperties: false,
  },

  kanban_delete_project: {
    type: 'object',
    required: ['project', 'confirm'],
    properties: {
      project: { type: 'string' },
      confirm: { type: 'string', description: 'must equal the project name to confirm destructive delete' },
    },
    additionalProperties: false,
  },

  kanban_create_sprint: {
    type: 'object',
    required: ['name'],
    properties: {
      project: { type: 'string', description: 'required for manager tokens; omit for agent tokens (project is inferred from the token)' },
      name:    { type: 'string', maxLength: 80 },
      goal:    { type: 'string', maxLength: 1000 },
    },
    additionalProperties: false,
  },

  kanban_start_sprint: {
    type: 'object',
    required: ['sprint_id'],
    properties: { sprint_id: { type: 'string' } },
    additionalProperties: false,
  },

  kanban_list_sprints: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'required for manager tokens; omit for agent tokens (project is inferred from the token)' },
      status:  { type: 'string', enum: ['planning', 'active', 'closed', 'open', 'all'] },
    },
    additionalProperties: false,
  },

  kanban_get_sprint: {
    type: 'object',
    required: ['sprint_id'],
    properties: { sprint_id: { type: 'string' } },
    additionalProperties: false,
  },

  kanban_add_to_sprint: {
    type: 'object',
    required: ['sprint_id', 'card_ids'],
    properties: {
      sprint_id:    { type: 'string' },
      card_ids:     { type: 'array', items: { type: 'string' }, minItems: 1 },
      move_to_todo: { type: 'boolean' },
    },
    additionalProperties: false,
  },

  kanban_move_between_sprints: {
    type: 'object',
    required: ['sprint_id', 'target_sprint_id', 'card_ids'],
    properties: {
      sprint_id:        { type: 'string' },
      target_sprint_id: { type: 'string' },
      card_ids:         { type: 'array', items: { type: 'string' }, minItems: 1 },
    },
    additionalProperties: false,
  },

  kanban_close_sprint: {
    type: 'object',
    required: ['sprint_id'],
    properties: {
      sprint_id:   { type: 'string' },
      rollover_to: { type: ['string', 'null'], description: "sprint_id of a planning sprint to receive unfinished cards, or null to close without moving them (they stay attached to the closed sprint as historical record). IMPORTANT: cards in 'done' status are automatically archived on sprint close — they will appear in 'archived' and 'finished' in the response." },
    },
    additionalProperties: false,
  },
}
