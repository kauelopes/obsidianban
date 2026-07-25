import type { ToolAccess } from './tool-access.js'

/**
 * Single source of truth for the tool catalog: name, access level, category
 * and the description shown to agents. Consumed by src/index.ts (to register
 * the tools) and by scripts/generate-tool-list.ts (to regenerate
 * docs/tool_list.md). Handlers live in src/index.ts, keyed by name.
 */
export type ToolCategory = 'Cards' | 'Workflow' | 'Projetos' | 'Auth' | 'Sprints'

export interface ToolMeta {
  name: string
  access: ToolAccess
  category: ToolCategory
  description: string
}

export const TOOL_CATALOG: ToolMeta[] = [
  // Cards
  { name: 'kanban_list_cards', access: 'all', category: 'Cards', description: 'List cards in the project, with optional filters. DEV AGENTS: always scoped to the active sprint automatically (sprint_id param is ignored).' },
  { name: 'kanban_get_card', access: 'all', category: 'Cards', description: 'Get a card by id including body.' },
  { name: 'kanban_create_card', access: 'pm', category: 'Cards', description: "PM/manager only — create a new card. Required: title, type, sprint_id. body is write-once; use kanban_log_on_card afterwards. IMPORTANT: the response includes file_basename — a URL-style slug derived from the title (lowercase, accents removed, non-alphanumeric sequences replaced by hyphens). Always read file_basename from the response rather than deriving it yourself." },
  { name: 'kanban_bulk_create_cards', access: 'pm', category: 'Cards', description: 'PM/manager only — create up to 100 cards in one call from the cards array (each item like kanban_create_card). Per-item partial success: the response splits into created[] and failed[], each carrying the original array index so you can match and retry only the failures.' },
  { name: 'kanban_update_card', access: 'pm', category: 'Cards', description: "Update fields of a card: title, status, priority, tags, due_date, assigned_to, blocked_by, agent_notes, sprint_id. Requires the card's current version (optimistic locking)." },
  { name: 'kanban_update_spec', access: 'pm', category: 'Cards', description: "PM/manager only — replace the # Spec section (what to do: context, acceptance criteria, constraints). Dev agents are refused: Spec is the instruction, not the workspace. Requires the card's current version (optimistic locking). Leaves # Notes and # Agent Log untouched. Pass an empty string to clear the section." },
  { name: 'kanban_update_notes', access: 'all', category: 'Cards', description: "Replace the # Notes section — agent working memory (approach decisions, links, findings). Replaceable by design, NOT history: use kanban_log_on_card for anything that must survive. Available to all agent types. Requires the card's current version (optimistic locking). Leaves # Spec and # Agent Log untouched." },
  { name: 'kanban_log_on_card', access: 'all', category: 'Cards', description: "Append a timestamped log entry to the # Agent Log section. Available to all agent types (including dev). Supports markdown and mermaid diagrams. DEV AGENT ESCALATION PROTOCOL: if you are blocked or want to propose something (new card, change of scope, etc.), log your reasoning here with log_kind: 'escalate' and then call kanban_move_card to move the card to 'review' — that surfaces the card in the human's escalation inbox and the PM agent will read it and decide. Use log_kind rather than writing [ESCALATE] in the text. PM agents: answer an escalation with log_kind: 'pm_resolved'; prefer kanban_update_card when you need to update other fields at the same time as logging." },
  { name: 'kanban_move_card', access: 'all', category: 'Cards', description: 'Move a card to another column. Default columns: backlog, todo, in_progress, review, done. Pass input_tokens/output_tokens to record cost.' },
  { name: 'kanban_reorder_card', access: 'pm', category: 'Cards', description: 'Reorder a card within its column. WARNING: bumps the version of every other card in the same column — check affected_cards in the response to update cached versions.' },
  { name: 'kanban_delete_card', access: 'pm', category: 'Cards', description: "Delete a card permanently. Requires the card's current version (optimistic locking)." },
  { name: 'kanban_archive_card', access: 'pm', category: 'Cards', description: 'Archive a card so it stops appearing in default listings' },
  { name: 'kanban_unarchive_card', access: 'pm', category: 'Cards', description: 'Restore an archived card to the default listing' },
  { name: 'kanban_get_card_history', access: 'pm', category: 'Cards', description: "Full mutation history of a card, read from the append-only audit log: who changed what and when, with changed_fields, status transitions and recorded token cost. Newest first. Fields other than ts and op are all optional and vary by call site, not just by op: MOVE adds from_status/to_status, UPDATE adds changed_fields, and token fields are present only when the caller reported them. Check for presence rather than inferring the shape from op." },
  { name: 'kanban_list_escalations', access: 'pm', category: 'Cards', description: "Cards whose most recent explicitly-marked Agent Log entry is an escalation — i.e. work that is waiting on a human decision. Returns the escalation timestamp and the entry text, which is the question being asked. Derived from the card files, so an escalation written by hand in Obsidian shows up too. Answer one with kanban_log_on_card using log_kind: 'pm_resolved', which removes it from this list." },
  { name: 'kanban_claim_card', access: 'all', category: 'Cards', description: "Claim a card for yourself — sets assigned_to to your actor (inferred from the token, not a parameter). Idempotent: calling it on a card you already own returns success without changing version. 409 already_claimed if held by another agent. Does NOT change the card status — call kanban_move_card separately if needed." },
  { name: 'kanban_release_card', access: 'all', category: 'Cards', description: "Release a card you own so another agent can claim it. By default moves the card back to 'todo' (revert_to_status) so pick_next can find it — pass revert_to_status: null to keep the current status unchanged." },

  // Workflow
  { name: 'kanban_pick_next', access: 'all', category: 'Workflow', description: "Return the next card ready to work on (no unsatisfied blockers). Only considers cards in 'todo' by default — backlog cards are promoted to todo automatically when the sprint starts. DEV AGENTS: always scoped to the active sprint automatically (sprint_id param is ignored). When card is null, check reason: 'no_active_sprint' = start the sprint first (PM/manager only), 'all_blocked' = all candidates have unmet dependencies, 'empty' = no cards in sprint. The blocked_candidates count tells you how many candidates exist but are gated by unmet dependencies — log this and escalate to a PM agent if it stays > 0." },

  // Projetos
  { name: 'kanban_create_project', access: 'manager', category: 'Projetos', description: 'Create a project folder and mint an initial pm agent token (returned in the response).' },
  { name: 'kanban_list_projects', access: 'manager', category: 'Projetos', description: 'List all projects, with optional archive filters.' },
  { name: 'kanban_archive_project', access: 'manager', category: 'Projetos', description: 'Hide a project from default listings.' },
  { name: 'kanban_unarchive_project', access: 'manager', category: 'Projetos', description: 'Restore a previously archived project to default listings.' },
  { name: 'kanban_delete_project', access: 'manager', category: 'Projetos', description: 'Manager-only — permanently delete a project (requires confirm=<project>)' },
  { name: 'kanban_set_project_repo', access: 'manager', category: 'Projetos', description: 'Set or clear the target_repo path for a project — used as the working directory when launching sprint workflows. Without it, starting a sprint skips the workflow and logs a warning. Pass null to clear.' },

  // Auth
  { name: 'kanban_create_agent_token', access: 'manager', category: 'Auth', description: 'Manager-only — mint a new agent token. agent_type: "pm" = planning + execution (create/update cards, manage sprints, view sprint info); "dev" = execution-only (pick work, claim, log progress, move cards, escalate to review — cannot create cards, manage or query sprints; all tools require an active sprint and list_cards/pick_next auto-scope to it).' },

  // Sprints
  { name: 'kanban_create_sprint', access: 'pm', category: 'Sprints', description: 'Create a sprint in planning state. Manager or pm agent.' },
  { name: 'kanban_start_sprint', access: 'pm', category: 'Sprints', description: 'Activate a planning sprint; refuses if another is already active. Manager or pm agent.' },
  { name: 'kanban_list_sprints', access: 'pm', category: 'Sprints', description: 'PM/manager only — list sprints filtered by status: planning|active|closed|open|all' },
  { name: 'kanban_get_sprint', access: 'pm', category: 'Sprints', description: 'PM/manager only — get a sprint with its full card list plus aggregates: card counts by status (done, in_progress, todo, other) and summed token usage (total_input_tokens, total_output_tokens) across the sprint.' },
  { name: 'kanban_add_to_sprint', access: 'pm', category: 'Sprints', description: 'Attach cards to a sprint; optionally move_to_todo. Manager or pm agent.' },
  { name: 'kanban_move_between_sprints', access: 'pm', category: 'Sprints', description: 'Move cards between sprints in the same project. Manager or pm agent.' },
  { name: 'kanban_close_sprint', access: 'pm', category: 'Sprints', description: "Close a sprint. rollover_to: sprint_id moves unfinished cards to a planning sprint; rollover_to: null keeps them in the closed sprint as history. IMPORTANT: cards in 'done' are automatically archived. Manager or pm agent." },
]
