# Kanban MCP — Tool List

> Generated from `packages/server/src/server/tool-catalog.ts` by `pnpm run gen:tools`. Do not edit by hand.
>
> Access levels: **Dev** and **PM** are agent token types. Tools with no check in either column are **manager-only**. Each agent only receives the tools it can call — the list is filtered by token type at connection time.

---

## Cards (18 tools)

| Tool | Description | Dev | PM |
|------|-------------|:---:|:--:|
| `kanban_list_cards` | List cards in the project, with optional filters. DEV AGENTS: always scoped to the active sprint automatically (sprint_id param is ignored). | ✓ | ✓ |
| `kanban_get_card` | Get a card by id including body. | ✓ | ✓ |
| `kanban_create_card` | PM/manager only — create a new card. Required: title, type, sprint_id. body is write-once; use kanban_log_on_card afterwards. IMPORTANT: the response includes file_basename — a URL-style slug derived from the title (lowercase, accents removed, non-alphanumeric sequences replaced by hyphens). Always read file_basename from the response rather than deriving it yourself. |  | ✓ |
| `kanban_bulk_create_cards` | PM/manager only — create up to 100 cards in one call from the cards array (each item like kanban_create_card). Per-item partial success: the response splits into created[] and failed[], each carrying the original array index so you can match and retry only the failures. |  | ✓ |
| `kanban_update_card` | Update fields of a card: title, status, priority, tags, due_date, assigned_to, blocked_by, agent_notes, sprint_id. Requires the card's current version (optimistic locking). |  | ✓ |
| `kanban_update_spec` | PM/manager only — replace the # Spec section (what to do: context, acceptance criteria, constraints). Dev agents are refused: Spec is the instruction, not the workspace. Requires the card's current version (optimistic locking). Leaves # Notes and # Agent Log untouched. Pass an empty string to clear the section. |  | ✓ |
| `kanban_update_notes` | Replace the # Notes section — agent working memory (approach decisions, links, findings). Replaceable by design, NOT history: use kanban_log_on_card for anything that must survive. Available to all agent types. Requires the card's current version (optimistic locking). Leaves # Spec and # Agent Log untouched. | ✓ | ✓ |
| `kanban_log_on_card` | Append a timestamped log entry to the # Agent Log section. Available to all agent types (including dev). Supports markdown and mermaid diagrams. DEV AGENT ESCALATION PROTOCOL: if you are blocked or want to propose something (new card, change of scope, etc.), log your reasoning here with log_kind: 'escalate' and then call kanban_move_card to move the card to 'review' — that surfaces the card in the human's escalation inbox and the PM agent will read it and decide. Use log_kind rather than writing [ESCALATE] in the text. PM agents: answer an escalation with log_kind: 'pm_resolved'; prefer kanban_update_card when you need to update other fields at the same time as logging. | ✓ | ✓ |
| `kanban_move_card` | Move a card to another column. Default columns: backlog, todo, in_progress, review, done. Pass input_tokens/output_tokens to record cost. | ✓ | ✓ |
| `kanban_reorder_card` | Reorder a card within its column. WARNING: bumps the version of every other card in the same column — check affected_cards in the response to update cached versions. |  | ✓ |
| `kanban_delete_card` | Delete a card permanently. Requires the card's current version (optimistic locking). |  | ✓ |
| `kanban_archive_card` | Archive a card so it stops appearing in default listings |  | ✓ |
| `kanban_unarchive_card` | Restore an archived card to the default listing |  | ✓ |
| `kanban_get_card_history` | Full mutation history of a card, read from the append-only audit log: who changed what and when, with changed_fields, status transitions and recorded token cost. Newest first. Fields other than ts and op are all optional and vary by call site, not just by op: MOVE adds from_status/to_status, UPDATE adds changed_fields, and token fields are present only when the caller reported them. Check for presence rather than inferring the shape from op. |  | ✓ |
| `kanban_list_escalations` | Cards whose most recent explicitly-marked Agent Log entry is an escalation — i.e. work that is waiting on a human decision. Returns the escalation timestamp and the entry text, which is the question being asked. Derived from the card files, so an escalation written by hand in Obsidian shows up too. Answer one with kanban_log_on_card using log_kind: 'pm_resolved', which removes it from this list. |  | ✓ |
| `kanban_claim_card` | Claim a card for yourself — sets assigned_to to your actor (inferred from the token, not a parameter). Idempotent: calling it on a card you already own returns success without changing version. 409 already_claimed if held by another agent. Does NOT change the card status — call kanban_move_card separately if needed. | ✓ | ✓ |
| `kanban_release_card` | Release a card you own so another agent can claim it. By default moves the card back to 'todo' (revert_to_status) so pick_next can find it — pass revert_to_status: null to keep the current status unchanged. | ✓ | ✓ |
| `kanban_defer_card` | Defer this card because it depends on another card — including one already sitting in review — rather than needing human judgment of its own. Merges blocked_by, appends log_entry explaining why, releases your claim (assigned_to → null), and returns the card to 'todo' if it was in a started column. Use this instead of moving to 'review' when what you discovered mid-execution is a dependency, not something that needs a human decision. kanban_pick_next skips the card again until every blocker is done, archived, or deleted. | ✓ | ✓ |

## Workflow (5 tools)

| Tool | Description | Dev | PM |
|------|-------------|:---:|:--:|
| `kanban_pick_next` | Return the next card ready to work on (no unsatisfied blockers). Only considers cards in 'todo' by default — backlog cards are promoted to todo automatically when the sprint starts. DEV AGENTS: always scoped to the active sprint automatically (sprint_id param is ignored). When card is null, check reason: 'no_active_sprint' = start the sprint first (PM/manager only), 'all_blocked' = all candidates have unmet dependencies, 'empty' = no cards in sprint. The blocked_candidates count tells you how many candidates exist but are gated by unmet dependencies — log this and escalate to a PM agent if it stays > 0. | ✓ | ✓ |
| `kanban_workflow_start` | Launch the sprint workflow (the agent orchestrator) for an active sprint. Requires the project's target_repo to be set (kanban_set_project_repo) — the pm/dev tokens are read from the repo's .claude/settings.local.json. 409 workflow_already_running if a run for the sprint (or project) is in flight. Progress arrives via SSE (WORKFLOW_STARTED / WORKFLOW_EXITED) and the log via GET /workflow/log. |  | ✓ |
| `kanban_workflow_stop` | Stop a running sprint workflow — SIGTERM to the whole process group, so any dev harness spawned by it dies too. 409 workflow_not_running when there is nothing to stop. |  | ✓ |
| `kanban_workflow_status` | Current state of the sprint workflow run for a sprint: running/exited/failed/stopped, pid, timestamps and exit code. run is null when the server never launched (or lost track of, after a restart) a workflow for that sprint. |  | ✓ |
| `kanban_log_workflow_usage` | Record measured usage for one workflow round (kind 'dev' or 'triage') at sprint level, independent of card attribution: input/output tokens, cache_read/cache_creation tokens (NOT included in input), cost_usd (authoritative, e.g. total_cost_usd from the harness) and turns. This is the no-token-left-behind layer: failed rounds, multi-card drains and triage runs all land in token_log and /metrics even when no card was touched. |  | ✓ |

## Projetos (11 tools)

| Tool | Description | Dev | PM |
|------|-------------|:---:|:--:|
| `kanban_create_project` | Create a project folder and mint an initial pm agent token (returned in the response). Passing target_repo also provisions the sprint workflow for that repo — installs the agent skills, writes .claude/mcp.json and settings.local.json, and mints the pm and dev tokens — and returns the same workflow_readiness report as kanban_set_project_repo. The generated tokens appear once and are not recoverable. |  |  |
| `kanban_list_projects` | List all projects, with optional archive filters. |  |  |
| `kanban_archive_project` | Hide a project from default listings. |  |  |
| `kanban_unarchive_project` | Restore a previously archived project to default listings. |  |  |
| `kanban_delete_project` | Manager-only — permanently delete a project (requires confirm=<project>) |  |  |
| `kanban_set_project_repo` | Set or clear the target_repo path for a project — used as the working directory when launching sprint workflows. Without it, starting a sprint skips the workflow and logs a warning. Pass null to clear. |  |  |
| `kanban_set_goal` | Create or update a medium-term project goal (upsert: omit id to create). Goals live in the project _meta.json and appear in kanban_list_projects. Fields: title (max 120), target_date (YYYY-MM-DD or null), status open\|done\|dropped, notes (max 1000). PM agents operate on their own project; managers pass project explicitly. |  | ✓ |
| `kanban_delete_goal` | Remove a project goal by id. Prefer status=dropped via kanban_set_goal when the goal was abandoned but its history matters. |  | ✓ |
| `kanban_create_epic` | Create an epic — a named grouping of sprints under a common objective. Epics live in the project _meta.json beside sprints and goals. Optionally pass sprint_ids to attach sprints at creation; each sprint may belong to at most one epic (409 sprint_already_in_epic otherwise). PM agents operate on their own project; managers pass project explicitly. |  | ✓ |
| `kanban_list_epics` | List the epics of a project with their sprint_ids. Progress is derived by the caller from the cards of the attached sprints — there is no stored counter. |  | ✓ |
| `kanban_update_epic` | Update an epic: name, objective, status (open\|done\|dropped) and/or sprint_ids (full replacement; each sprint may belong to at most one epic). Prefer status=dropped over removal — epics have no delete tool by design, the history matters. |  | ✓ |

## Planejamento (8 tools)

| Tool | Description | Dev | PM |
|------|-------------|:---:|:--:|
| `kanban_planning_start` | Start a new project-planning wizard session (KAD). Only one active session per server — 409 planning_session_active otherwise. Returns the session with the first screen (identity form). |  |  |
| `kanban_planning_get` | Get the full state of a planning session — current step, screen payload, accumulated KAD documents, usage and status. Poll this while status is "generating"; the SSE event PLANNING_STEP_READY fires when the screen is ready. |  |  |
| `kanban_planning_answer` | Submit the human answer for the current step and advance the wizard. When the next step is LLM-prefilled the call returns immediately with status "generating" — the result arrives via SSE/polling, never synchronously. |  |  |
| `kanban_planning_refine` | Ask the LLM to correct the current step (diagram/confirm screens) with free-text feedback. Stays on the same step; returns "generating" like kanban_planning_answer. |  |  |
| `kanban_planning_retry` | Re-run the last failed turn of a planning session (rate limit, invalid JSON, timeout). Only valid when status is "error". |  |  |
| `kanban_planning_finalize` | Materialize an approved plan: creates the real project (returning the one-time pm token and workflow_readiness like kanban_create_project), the epics, the sprints (in planning state), the cards (bulk, tagged epic:<slug>), the goals, writes the KAD documents to kanban-data/<project>/kad/ and copies them to <target_repo>/docs/kad/. Synchronous and checkpointed: if it fails midway, calling it again resumes without duplicating — but the pm token is only returned by the first pass (token_hint explains the fallback). |  |  |
| `kanban_planning_cancel` | Cancel a planning session: kills any in-flight turn and marks the session cancelled. Not reversible. |  |  |
| `kanban_planning_list` | List planning sessions that are not finished (anything but done/cancelled) — used by the Home to offer "continue planning". |  |  |

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
