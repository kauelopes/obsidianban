---
name: kanban-dev-agent
description: Operating guide for the ObsidianKan kanban DEV agent — an execution-only agent that pulls work from the active sprint and reports progress over the kanban_* MCP tools. Trigger when you hold a dev-type token, when kanban_pick_next/kanban_claim_card are available but card-creation and sprint tools are not, or when asked to "work the board" / "pick up the next task" as a developer.
---

# Kanban Dev Agent

You execute work that a PM has already planned. You do **not** plan: you cannot create cards, manage sprints, or edit arbitrary card fields. You pull the next ready task, do it, and report back.

## Your tools (7)

`kanban_pick_next`, `kanban_list_cards`, `kanban_get_card`, `kanban_claim_card`, `kanban_move_card`, `kanban_log_on_card`, `kanban_release_card`. The MCP server only shows you these — any other `kanban_*` tool is hidden because your token can't call it.

## Board model

- Columns flow: `backlog → todo → in_progress → review → done`.
- Every card has a `version` (incremented on each change), an `assigned_to` owner, and a `# Agent Log` section you append to.
- A card's `body` is fixed at creation. You communicate **only** through `kanban_log_on_card`.

## Hard rules

1. **Active sprint required.** Every one of your tools returns `409 no_active_sprint` if no sprint is active. You cannot start one — if you hit this, stop and wait; the error `hint` says a PM/manager must start the sprint.
2. **Auto-scoped.** `kanban_list_cards` and `kanban_pick_next` always operate on the active sprint. Any `sprint_id` you pass is ignored.
3. **Ownership.** You can only mutate a card you own. Claim it first; mutating someone else's card returns `403`.
4. **Version on every mutation.** `move`/`claim`/`release`/`log` take the card's current `version`.

## Your work loop

1. `kanban_pick_next` → get the next ready card (no unmet blockers).
2. `kanban_claim_card` → take ownership (idempotent if already yours).
3. `kanban_move_card { to_status: "in_progress" }`.
4. Do the work. Append meaningful progress with `kanban_log_on_card` (markdown + mermaid supported).
5. When done: `kanban_move_card { to_status: "done", input_tokens, output_tokens, model }` to record cost, then loop back to step 1.

If `pick_next` returns `card: null`, branch on `reason`:
- `no_active_sprint` → stop and wait (PM must start the sprint).
- `empty` / `no_todo_cards` → nothing to do; report idle.
- `all_blocked` → every candidate has unmet dependencies. Check `blocked_candidates`; if it stays > 0, escalate (below).

## Escalation protocol (blocked or want to propose work)

You cannot create cards. To raise a blocker or propose new work, hand the card to the PM through `review`:

1. `kanban_log_on_card` — explain clearly: what you tried, what failed, what you recommend.
2. `kanban_move_card { to_status: "review" }` — the PM reads `review` and decides (close, spawn a follow-up, or unblock and return to `todo`).
3. `kanban_pick_next` — continue with the next task; don't stall waiting.

## Reading errors

Errors carry `error`, `reason`, and an actionable `hint` — read them.
- `409 no_active_sprint` → wait; you can't fix this yourself.
- `409 conflict` (version mismatch) → the card changed under you. Re-read with `kanban_get_card`, then retry with the current `version`.
- `409 already_claimed` → someone else owns it. Call `kanban_pick_next` for a different card.

For exact tool params, the conflict/error shapes, and idempotency, read `reference/protocol.md` (bundled in this skill).
