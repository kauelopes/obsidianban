# PM Agent — Wire Protocol Reference

Runtime detail for planning + supervision. Load this for exact params, field
constraints, or unfamiliar errors.

## Error envelope

Every failure returns `{ error, reason?, hint?, ... }`. **Always read `hint`** —
it states the recovery. `400` bad input, `403` forbidden, `404` not found,
`409` conflict / state.

## Optimistic concurrency

`update_card`, `move_card`, `delete_card`, `reorder_card` take the card's
current `version`:

```
409 { error: "conflict", your_version, current_version,
      conflicting_fields, current_card,
      hint: "...re-read with kanban_get_card and retry with the current version" }
```

Reuse `current_card` from the response (or re-read) and retry.
`reorder_card` bumps the `version` of **every other card in the column** —
refresh them from `affected_cards` in the response.

## Card fields

| Field | Constraint |
|-------|-----------|
| `title` | required, ≤ 200 chars |
| `type` | required, one of `task` `feature` `bug` `chore` |
| `sprint_id` | required on create — a `planning` or `active` sprint |
| `priority` | `low` `medium` `high` `critical` |
| `status` | column slug; defaults to `backlog` on create |
| `tags` | ≤ 20 |
| `due_date` | `YYYY-MM-DD` (or `null` to clear on update) |
| `blocked_by` | array of card ids — gates `pick_next` for devs |
| `body` | **write-once at creation**; afterwards use `log_entry` / `log_on_card` |
| `agent_notes` | ≤ 2000 chars |

`create_card` response includes `file_basename` (the slug) — read it, never
derive it. `bulk_create_cards` (≤ 100) returns `{ created[], failed[] }`, each
item carrying its original array index; retry only `failed[]`.

## Sprint tools

| Tool | Required | Optional | Notes |
|------|----------|----------|-------|
| `create_sprint` | — | `name`, `goal` | starts in `planning` |
| `start_sprint` | `sprint_id` | — | activates; promotes its `backlog` cards to `todo`; refuses if another sprint is active |
| `list_sprints` | — | `status` ∈ `planning\|active\|closed\|open\|all` | |
| `get_sprint` | `sprint_id` | — | returns cards + aggregates (counts by status, summed tokens) |
| `add_to_sprint` | `sprint_id`, `card_ids` | `move_to_todo` | |
| `move_between_sprints` | `sprint_id`, `target_sprint_id`, `card_ids` | — | same project only |
| `close_sprint` | `sprint_id` | `rollover_to` | archives `done` cards automatically; `rollover_to` a planning sprint moves unfinished cards, `null` keeps them as history |

**One active sprint at a time** per project.

## Errors

| Error | Cause | Recovery |
|-------|-------|----------|
| `409 conflict` | stale `version` | re-read, retry with current version |
| `400 sprint_not_active` | target is `planning` (start it) or `closed` (move card elsewhere) | follow the `hint` |
| `409 no_active_sprint` | dev-style call with no active sprint | `start_sprint` first |
| `403 forbidden` | mutating a card owned by another actor | `claim` it, or leave it to its owner |
| `400 invalid_fields` `disallowed_fields:["project"]` | sent `project` on an agent token | drop it — comes from the token |

For the dev-side loop you supervise (what lands in `review` and why), see the
`kanban-dev-agent` skill.
