# Dev Agent — Wire Protocol Reference

Runtime detail for the 7 tools a dev token can call. Load this when you need
exact params or hit an error you don't recognize.

## Error envelope

Every failure returns `{ error, reason?, hint?, ... }`. **Always read `hint`** —
it tells you the recovery action. Status codes: `400` bad input, `403`
forbidden (ownership / disallowed field), `404` not found, `409` conflict /
state.

## Optimistic concurrency

Every mutation (`move`, `claim`, `release`, `log`) takes the card's current
`version`. If it's stale you get:

```
409 { error: "conflict",
      message: "Version mismatch: expected 3, found 5",
      your_version, current_version, conflicting_fields,
      current_card,   // the full current card — reuse it, no extra fetch needed
      hint: "...re-read with kanban_get_card and retry with the current version" }
```

Recovery: take `current_card.version` from the response (or re-read via
`kanban_get_card`) and retry with that version.

## Idempotency

Pass `request_id` (a UUID or nanoid, generated once per logical action) on
`move_card` / `log_on_card`. Retrying with the same id returns the cached
result with no duplicate side effect — use it whenever the network may drop.

## Tools

| Tool | Required | Optional | Notes |
|------|----------|----------|-------|
| `kanban_pick_next` | — | — | Auto-scoped to active sprint. Returns `{ card }` or `{ card: null, reason, blocked_candidates }`. |
| `kanban_list_cards` | — | `status`, `assigned_to`, `tags`, `limit`, `offset`, `order_by` | Auto-scoped to active sprint; any `sprint_id` is ignored. |
| `kanban_get_card` | `id` | — | Returns the card incl. `body` and `# Agent Log`. |
| `kanban_claim_card` | `id`, `version` | — | Sets `assigned_to` to your actor (from token). Idempotent if already yours. Does **not** change status. |
| `kanban_move_card` | `id`, `version`, `to_status` | `input_tokens`, `output_tokens`, `model`, `request_id` | `to_status` is a column slug. Pass token usage to record cost. |
| `kanban_log_on_card` | `id`, `version`, `log_entry` | `input_tokens`, `output_tokens`, `model`, `request_id` | Appends a timestamped entry to `# Agent Log`. Markdown + mermaid ok. |
| `kanban_release_card` | `id`, `version` | `revert_to_status` | Defaults to moving the card back to `todo` so `pick_next` sees it; pass `null` to keep status. |

## `pick_next` reasons (when `card` is null)

| reason | meaning | your move |
|--------|---------|-----------|
| `no_active_sprint` | no sprint active | stop and wait — only PM/manager can start one |
| `empty` | sprint has no cards | report idle |
| `no_todo_cards` | nothing in `todo` | report idle |
| `all_blocked` | candidates exist but all have unmet `blocked_by` | if `blocked_candidates` stays > 0, escalate via `review` |

## Errors you'll actually hit

| Error | Cause | Recovery |
|-------|-------|----------|
| `409 no_active_sprint` | no active sprint | wait; you can't start one |
| `409 conflict` | stale `version` | re-read, retry with current version |
| `409 already_claimed` | another agent owns the card | `pick_next` for a different one |
| `403 forbidden` | mutating a card you don't own | `claim` it first (if unassigned) |
| `400 invalid_fields` `disallowed_fields:["project"]` | you sent `project` | drop it — project comes from your token |
| `400 missing_field` `log_entry` | empty log | provide a non-empty `log_entry` |
