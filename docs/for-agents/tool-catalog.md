# Kanban MCP — Tool List

> Generated from `packages/server/src/server/tool-catalog.ts` by `pnpm run gen:tools`. Do not edit by hand.
>
> Access levels: **Dev** and **PM** are agent token types. Tools with no check in either column are **manager-only**. Each agent only receives the tools it can call — the list is filtered by token type at connection time.

---

## Cards (13 tools)

| Tool | Description | Dev | PM |
|------|-------------|:---:|:--:|
| `kanban_list_cards` | List cards in the project, with optional filters. DEV AGENTS: always scoped to the active sprint automatically (sprint_id param is ignored). | ✓ | ✓ |
| `kanban_get_card` | Get a card by id including body. | ✓ | ✓ |
| `kanban_create_card` | PM/manager only — create a new card. Required: title, type, sprint_id. body is write-once; use kanban_log_on_card afterwards. IMPORTANT: the response includes file_basename — a URL-style slug derived from the title (lowercase, accents removed, non-alphanumeric sequences replaced by hyphens). Always read file_basename from the response rather than deriving it yourself. |  | ✓ |
| `kanban_bulk_create_cards` | PM/manager only — create up to 100 cards in one call from the cards array (each item like kanban_create_card). Per-item partial success: the response splits into created[] and failed[], each carrying the original array index so you can match and retry only the failures. |  | ✓ |
| `kanban_update_card` | Update fields of a card: title, status, priority, tags, due_date, assigned_to, blocked_by, agent_notes, sprint_id. Requires the card's current version (optimistic locking). |  | ✓ |
| `kanban_log_on_card` | Append a timestamped log entry to the # Agent Log section. Available to all agent types (including dev). Supports markdown and mermaid diagrams. DEV AGENT ESCALATION PROTOCOL: if you are blocked or want to propose something (new card, change of scope, etc.), log your reasoning here and then call kanban_move_card to move the card to 'review' — the PM agent will read it and decide. PM agents: prefer kanban_update_card when you need to update other fields at the same time as logging. | ✓ | ✓ |
| `kanban_move_card` | Move a card to another column. Default columns: backlog, todo, in_progress, review, done. Pass input_tokens/output_tokens to record cost. | ✓ | ✓ |
| `kanban_reorder_card` | Reorder a card within its column. WARNING: bumps the version of every other card in the same column — check affected_cards in the response to update cached versions. |  | ✓ |
| `kanban_delete_card` | Delete a card permanently. Requires the card's current version (optimistic locking). |  | ✓ |
| `kanban_archive_card` | Archive a card so it stops appearing in default listings |  | ✓ |
| `kanban_unarchive_card` | Restore an archived card to the default listing |  | ✓ |
| `kanban_claim_card` | Claim a card for yourself — sets assigned_to to your actor (inferred from the token, not a parameter). Idempotent: calling it on a card you already own returns success without changing version. 409 already_claimed if held by another agent. Does NOT change the card status — call kanban_move_card separately if needed. | ✓ | ✓ |
| `kanban_release_card` | Release a card you own so another agent can claim it. By default moves the card back to 'todo' (revert_to_status) so pick_next can find it — pass revert_to_status: null to keep the current status unchanged. | ✓ | ✓ |

## Workflow (1 tool)

| Tool | Description | Dev | PM |
|------|-------------|:---:|:--:|
| `kanban_pick_next` | Return the next card ready to work on (no unsatisfied blockers). Only considers cards in 'todo' by default — backlog cards are promoted to todo automatically when the sprint starts. DEV AGENTS: always scoped to the active sprint automatically (sprint_id param is ignored). When card is null, check reason: 'no_active_sprint' = start the sprint first (PM/manager only), 'all_blocked' = all candidates have unmet dependencies, 'empty' = no cards in sprint. The blocked_candidates count tells you how many candidates exist but are gated by unmet dependencies — log this and escalate to a PM agent if it stays > 0. | ✓ | ✓ |

## Projetos (6 tools)

| Tool | Description | Dev | PM |
|------|-------------|:---:|:--:|
| `kanban_create_project` | Create a project folder and mint an initial pm agent token (returned in the response). |  |  |
| `kanban_list_projects` | List all projects, with optional archive filters. |  |  |
| `kanban_archive_project` | Hide a project from default listings. |  |  |
| `kanban_unarchive_project` | Restore a previously archived project to default listings. |  |  |
| `kanban_delete_project` | Manager-only — permanently delete a project (requires confirm=<project>) |  |  |
| `kanban_set_project_repo` | Set or clear the target_repo path for a project — used as the working directory when launching sprint workflows. Without it, starting a sprint skips the workflow and logs a warning. Pass null to clear. |  |  |

## Auth (1 tool)

| Tool | Description | Dev | PM |
|------|-------------|:---:|:--:|
| `kanban_create_agent_token` | Manager-only — mint a new agent token. agent_type: "pm" = planning + execution (create/update cards, manage sprints, view sprint info); "dev" = execution-only (pick work, claim, log progress, move cards, escalate to review — cannot create cards, manage or query sprints; all tools require an active sprint and list_cards/pick_next auto-scope to it). |  |  |

## Sprints (7 tools)

| Tool | Description | Dev | PM |
|------|-------------|:---:|:--:|
| `kanban_create_sprint` | Create a sprint in planning state. Manager or pm agent. |  | ✓ |
| `kanban_start_sprint` | Activate a planning sprint; refuses if another is already active. Manager or pm agent. |  | ✓ |
| `kanban_list_sprints` | PM/manager only — list sprints filtered by status: planning\|active\|closed\|open\|all |  | ✓ |
| `kanban_get_sprint` | PM/manager only — get a sprint with its full card list plus aggregates: card counts by status (done, in_progress, todo, other) and summed token usage (total_input_tokens, total_output_tokens) across the sprint. |  | ✓ |
| `kanban_add_to_sprint` | Attach cards to a sprint; optionally move_to_todo. Manager or pm agent. |  | ✓ |
| `kanban_move_between_sprints` | Move cards between sprints in the same project. Manager or pm agent. |  | ✓ |
| `kanban_close_sprint` | Close a sprint. rollover_to: sprint_id moves unfinished cards to a planning sprint; rollover_to: null keeps them in the closed sprint as history. IMPORTANT: cards in 'done' are automatically archived. Manager or pm agent. |  | ✓ |
