/**
 * JSON Schema definitions for every MCP tool.
 * Consumed by StdioMcpServer and McpSseManager to populate ListTools.
 * Proper types prevent MCP clients from serialising integers/arrays as strings.
 */

type Schema = Record<string, unknown>

const TOKEN_FIELDS = {
  input_tokens:  { type: 'integer', minimum: 0, default: 0, description: 'usage.input_tokens from the API response — omit or pass 0 if unavailable' },
  output_tokens: { type: 'integer', minimum: 0, default: 0, description: 'usage.output_tokens from the API response — omit or pass 0 if unavailable' },
  model:         { type: 'string', description: "model identifier — e.g. 'claude-sonnet-4-6'" },
  request_id:    { type: 'string', description: 'idempotency key — safe to retry with the same id' },
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
      sprint_id:   { type: 'string' },
      actor:       { type: 'string' },
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
      ...TOKEN_FIELDS,
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
      id:      { type: 'string' },
      version: { type: 'integer', minimum: 1 },
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

  kanban_create_project: {
    type: 'object',
    required: ['project', 'actor'],
    properties: {
      project: { type: 'string', description: 'letters, numbers, dots, underscores, hyphens — no spaces' },
      actor:   { type: 'string' },
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
    required: ['project', 'name'],
    properties: {
      project: { type: 'string' },
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
    required: ['project'],
    properties: {
      project: { type: 'string', description: 'for agent tokens: always uses the token project — this parameter is accepted but ignored (the response always reflects the token project, never a different project)' },
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
