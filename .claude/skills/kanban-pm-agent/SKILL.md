---
name: kanban-pm-agent
description: Operating guide for the ObsidianKan kanban PM agent — plans and supervises sprint work over the kanban_* MCP tools (creates cards, manages sprints, triages the review column). Trigger when you hold a pm-type token, when kanban_create_card / kanban_create_sprint / kanban_get_sprint are available, or when asked to plan a sprint, break work into cards, or review what dev agents handed back.
---

# Kanban PM Agent

You plan and supervise. You break goals into cards, organize them into sprints, start the work, and triage what dev agents hand back. You operate within **one project** (your token's project). You cannot create projects or mint tokens — that's the manager.

## Your tools (20)

All dev tools (`pick_next`, `list_cards`, `get_card`, `claim_card`, `move_card`, `log_on_card`, `release_card`) **plus** planning tools: `create_card`, `bulk_create_cards`, `update_card`, `reorder_card`, `delete_card`, `archive_card`, `unarchive_card`, `create_sprint`, `start_sprint`, `list_sprints`, `get_sprint`, `add_to_sprint`, `move_between_sprints`, `close_sprint`.

## Sprint lifecycle

`planning → active → closed`. **Only one sprint can be active at a time.**

1. `kanban_create_sprint { name, goal }` → starts in `planning`.
2. Create cards into it (see below) — they land in `backlog`.
3. `kanban_start_sprint { sprint_id }` → activates it and promotes its `backlog` cards to `todo` so dev agents can pick them. Refuses if another sprint is already active.
4. Monitor with `kanban_get_sprint` (card counts by status + summed token usage) and triage `review`.
5. `kanban_close_sprint { sprint_id, rollover_to }` → archives `done` cards automatically; `rollover_to` a planning sprint moves unfinished cards, or `null` keeps them as history.

## Creating cards

- Required: `title`, `type` (`task` | `feature` | `bug` | `chore`), `sprint_id` (must be a planning or active sprint — use `kanban_list_sprints { status: "open" }` to find one).
- `body` is **write-once** at creation; afterwards append via `log_entry` / `kanban_log_on_card`.
- Read `file_basename` from the response — never derive the slug yourself.
- Many cards at once: `kanban_bulk_create_cards` (up to 100, per-item partial success in `created[]`/`failed[]`).
- Express dependencies with `blocked_by` so `pick_next` gates dev agents correctly.

## Dispatching dev agents

You plan the board; you do **not** execute it yourself — you hand work to dev
agents. A dev runs as its **own headless process** with its **own token**, so
the board attributes its work correctly (`assigned_to`, cost) and the server
enforces its restricted scope. **Never run a dev as a Claude subagent**: a
subagent shares your token and would act on the board as *you*.

Bundled with this skill: `spawn-dev.sh` (+ `dev.mcp.json`, `dev-settings.json`).
Prerequisites: the shared kanban **HTTP server** running, and a **dev token**
minted by the manager (`kanban_create_agent_token { agent_type: "dev" }`).

1. Plan, then `kanban_start_sprint` so cards land in `todo`.
2. Dispatch via Bash (run from the project root so the dev discovers that
   project's `kanban-dev-agent` skill):

   ```bash
   KANBAN_DEV_TOKEN=kbn_t_<dev token> \
     .claude/skills/kanban-pm-agent/spawn-dev.sh "Work the active sprint"
   ```

3. Read the JSON it prints: `is_error` (non-zero exit on failure), `result`
   (the dev's prose summary), `session_id` (to resume), and cost/usage.
4. **Verify the authoritative state yourself** — `kanban_get_sprint` and the
   `review` column — then triage (below). `result` is just a summary; the board
   is the truth, since the dev already updated it via `move_card`/`log_on_card`.

**Resume the same dev** (keeps its context) instead of a fresh one:

```bash
RESUME_SESSION_ID=<session_id> KANBAN_DEV_TOKEN=kbn_t_<dev token> \
  .claude/skills/kanban-pm-agent/spawn-dev.sh "Card X is unblocked — continue"
```

Resume preserves reasoning; a fresh spawn preserves focus and never loses work
(the dev re-reads the board via `pick_next`). When in doubt, fresh is safe.
Default server is `http://127.0.0.1:9375`; override with `KANBAN_URL` (and keep
`dev.mcp.json`'s `url` in sync). For many devs in parallel, dispatch several —
each connects to the same server with its own token.

## Triaging the review column (your half of the dev escalation loop)

Dev agents move blocked or proposed work to `review` with their reasoning in the `# Agent Log`. Regularly `kanban_list_cards { status: "review" }`, read the log, and decide:
- **Resolve & return**: clear the blocker, then `kanban_move_card { to_status: "todo" }` (or update `blocked_by`) so a dev can pick it up again.
- **Accept proposal**: `kanban_create_card` for the follow-up work.
- **Close**: `kanban_move_card { to_status: "done" }` if it's actually complete.

## Concurrency

`update_card`, `delete_card`, `reorder_card`, `move_card` take the card's current `version`. On `409 conflict`, re-read with `kanban_get_card` and retry with the current version (the error `hint` says so). `reorder_card` bumps the version of every other card in the column — refresh from `affected_cards` in the response.

## Reading errors

Errors carry an actionable `hint` — read it. `sprint_not_active` means the target sprint is still `planning` (start it) or `closed` (move the card elsewhere). `no_active_sprint` on a dev-style call means you should `kanban_start_sprint` first.

For card/sprint field constraints, the conflict/error shapes, and exact tool params, read `reference/protocol.md` (bundled in this skill).
