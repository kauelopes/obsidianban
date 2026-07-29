# Agent Integration Guide

This guide is for developers integrating an AI agent (or any external service)
against an ObsidianKan MCP server. It covers the wire protocol, auth, the
contract every mutating call must honour, and how to handle conflicts when
two writers race.

The companion example at `scripts/example-agent-integration.ts` is a runnable
end-to-end script that exercises every pattern below — read that for the
exact byte-level shape of each request and response.

---

## 1. Transports

The MCP server exposes the same tool surface over two transports, plus a
read-only event feed and a REST shortcut. Pick based on where your agent runs.

| Channel | Endpoint | When to use |
|---|---|---|
| `stdio` | spawn `node dist/index.js --stdio` as child process, framed JSON-RPC on stdin/stdout | Local agents bundled with the MCP (no network hop). Token via `KANBAN_MCP_TOKEN` env. |
| Streamable HTTP | `POST http://127.0.0.1:9375/mcp` (stateless MCP protocol) | MCP-protocol clients over the network: Claude Code (`--transport http`), MCP-aware IDEs. Token via `Authorization: Bearer`. |
| REST shortcut | `POST http://127.0.0.1:9375/mcp/tool/<tool_name>` | Hand-built agents / polyglot stacks / debug tooling that want plain request→response JSON without speaking the MCP wire protocol. |
| Event feed | `GET http://127.0.0.1:9375/events` (SSE) | Real-time mutation feed for live UIs (the web board). Not a tool-call transport. |

The server binds to `127.0.0.1` only by default. `GET /metrics` is
loopback-locked at the application layer too, so it never leaves the host.

`/mcp` speaks the MCP protocol (initialize → tools/list → tools/call). The
examples below use the **REST shortcut** instead, because it's the easiest to
inspect with `curl`; the tool arguments and result JSON are identical to what a
`tools/call` over `/mcp` carries.

---

## 2. Authentication

Every HTTP request must include a bearer token:

```
Authorization: Bearer <token>
```

Two token roles exist (PRD §3.2). Pick based on what your agent needs:

| Role | Scope | Created with |
|---|---|---|
| `agent` | One project (`claims.project_id`) | `kanban-token create --project <id> --role agent --actor agent:<name>` |
| `manager` | Vault-wide (all projects) | `kanban-token create --role manager --actor human:<name>` |

The CLI prints the raw token once. **Store it immediately** — only the SHA-256
hash is persisted server-side, so a lost token cannot be recovered.

```bash
$ node dist/auth/cli.js create --project marketing --role agent --actor agent:claude
created token tk_abc12345 for agent:claude on project marketing
token:  kbn_t_a1b2c3d4e5f6g7h8i9j0...
```

### project_id is implicit for agent tokens

Do **not** send `project` in a mutating payload as an agent — the server
derives it from your token. If you do, the call fails with HTTP 400
`invalid_fields` listing `project` (or, for `kanban_create_card`, the value
must match your token's project).

Manager tokens have no implicit project, so they **must** send `project` on
create and may pass it as an optional filter on `kanban_list_cards`.

---

## 3. Token tracking fields (mandatory on mutations)

Every mutating tool (`create`, `update`, `move`, `reorder`, `delete`) requires
these three fields in the payload:

```json
{
  "input_tokens":  1234,
  "output_tokens": 567,
  "model":         "claude-opus-4-7"
}
```

The server appends an entry to `token_log` on success and bumps the card's
`total_input_tokens` / `total_output_tokens`. **Idempotent retries with the
same `request_id` do not re-accumulate** — the cached response is replayed
without re-charging tokens.

If you send `0`/`0` (e.g., when retrying a side-effect with no model
involvement), the audit row still records the operation; only the totals
stay unchanged.

---

## 4. `request_id` and idempotent retries

The server keys idempotency on `request_id`. The protocol:

```text
1. Generate a UUID v4 BEFORE any mutating call.
2. Send request_id in the payload.
3. On timeout or network error, retry with the SAME request_id.
4. NEVER reuse a request_id for a different logical operation.
```

The cache TTL is 24h. Within that window, a second call with the same
`request_id` returns the cached response byte-for-byte — including the
HTTP status. Outside it, the call is treated as new.

`request_id` must be a UUID v4. Non-UUID values return `400 invalid_request_id`
without ever reaching the handler.

> **TypeScript:** `import { randomUUID } from 'node:crypto'`
> **Python:** `import uuid; uuid.uuid4().hex`

---

## 5. Conflict handling (`409`)

When you send a mutation with a `version` that no longer matches SQLite, the
server returns:

```json
HTTP/1.1 409 Conflict
{
  "error": "conflict",
  "message": "Version mismatch: expected 3, found 5",
  "your_version": 3,
  "current_version": 5,
  "conflicting_fields": ["title"],
  "current_card": { /* full Card object as it stands now */ }
}
```

`conflicting_fields` lists the fields whose new values differ from what you
were trying to set (so you can detect whether your intended change is still
needed). For `delete` and `reorder`, this array is `[]` — there's no payload
to compare.

Recommended resolution loop:

```text
1. Receive 409.
2. Look at conflicting_fields.
3. Decide:
   a. If your intended change is already in current_card → done, no retry.
   b. If it still applies on top of current_card → retry with:
      • version = current_card.version
      • a NEW request_id (the previous attempt's logical operation has been
        invalidated by the conflict)
      • the same input_tokens/output_tokens/model
4. If you re-retry with the original request_id, you get the original 409
   back from cache — not progress.
```

---

## 6. Other operational concerns

**List pagination.** `kanban_list_cards` defaults to `limit: 50`, max `200`.
Paginate with `offset` until a page returns fewer rows than `limit`.

**Creating new projects.** A manager token can call
`kanban_create_project` with `{ project, actor }` to ensure the project
folder exists under `kanban-data/` *and* mint a fresh agent token in one
round trip. The response is `{ project, token, token_id, actor, created_at }`;
the raw `token` is only returned this once (the server keeps a SHA-256
hash). The project starts empty — under the "every card belongs to a
sprint" rule there is no auto-seeded starter card (there is no sprint to
attach it to yet). The onboarding briefing that used to live in that card
now ships as the `/ajuda` route in the web app, reachable from the board, and
is mirrored in the agent's documentation. Re-calling with the same
project name is additive: the folder is reused, a new token is appended,
and prior tokens stay valid until explicitly revoked. Agent tokens
calling this tool get `403 forbidden { reason: "manager_required" }`.
Project and actor names are validated against
`[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}` (actors also allow `:` for the
conventional `agent:foo` / `human:bar` prefixes).

**Listing projects.** `kanban_list_projects` returns `{ projects:
[{ project, columns, archived }] }`. Agent tokens see only their own
project (so a freshly-minted agent can still render its column layout
before any card exists); manager tokens see every project under
`kanban-data/`. Archived projects are hidden unless `include_archived:
true` is passed, and `archived_only: true` flips it to "only archived".

**Archiving and deleting projects.** Three manager-only tools manage
project lifecycle:

- `kanban_archive_project { project }` — sets `archived: true` in the
  project's `_meta.json`. The project disappears from default
  `kanban_list_projects` listings, and a cascade in `kanban_list_cards`
  also hides cards in archived projects *for manager full-board reads*
  (no `project` filter, no `include_archived_projects: true`). Agent
  tokens continue seeing their own cards regardless. SSE:
  `PROJECT_ARCHIVED`.
- `kanban_unarchive_project { project }` — reverses it. SSE:
  `PROJECT_UNARCHIVED`. Both archive ops are no-op short-circuits if
  the project is already in the target state (no audit row, no SSE).
- `kanban_delete_project { project, confirm }` — hard delete. Removes
  the project folder (folder + card `.md` files + `_meta.json` with all
  tokens) and purges matching SQLite rows. `confirm` must equal the
  project name as a typo guard; mismatched or missing `confirm` returns
  400. Returns `{ project, cards_deleted }`. SSE: `PROJECT_DELETED`.

**Bulk-creating cards.** `kanban_create_card` and `kanban_bulk_create_cards`
are **PM/manager only**. Dev agents cannot create cards — see "Dev agent
escalation" below. When one LLM round produces several cards
(parsing a PRD into a backlog is the canonical case), call
`kanban_bulk_create_cards` instead of looping over `create_card`:

```json
{
  "cards": [
    { "title": "Design login flow", "type": "task", "priority": "high" },
    { "title": "Write auth tests",  "type": "task" },
    { "title": "Doc the new endpoint", "type": "doc", "tags": ["docs","auth"] }
  ],
  "input_tokens": 1200,
  "output_tokens": 350,
  "model": "claude-sonnet-4-6",
  "request_id": "<uuid v4>",
  "project": "marketing",
  "sprint_id": "sprint-abc12345"
}
```

- Limit: 100 entries per call (over → `400 invalid_field max=100`).
- The envelope owns `input_tokens` / `output_tokens` / `model` /
  `request_id` (and optionally a default `project` and `sprint_id`
  that get injected into any entry that omits its own). Including any
  of those four token-tracking fields *per-card* drops that card
  into `failed[]` with `error: "invalid_card"`.
- `sprint_id` is required on every card (mandatory under the "no
  sprintless cards" rule). Setting it on the envelope is the common
  case when parsing a single PRD into one sprint; per-card overrides
  are accepted so a manager can mix sprints in one batch.
- Tokens are prorated evenly across cards; the remainder is added to
  the last card so totals reconcile (`envelope == sum(cards)`).
- Response is `{ created: [{ index, card }], failed: [{ index,
  error, detail }] }`. Indices match the original `cards[]` array,
  so the caller can retry only the failed entries. A partial batch
  still returns HTTP 200 — individual failures are part of the
  contract, not protocol errors. Real protocol errors (envelope
  validation, role gate) still surface as 400/403.
- Idempotency works at the envelope level via the existing
  `request_id` dedupe — a retry returns the cached response (same
  card ids), so it's safe to retry on network blips.
- Each successful card emits a normal `CARD_CREATED` SSE; there is
  no separate "bulk" event type.

**Sprints.** A project can hold any number of `Sprint` entities in its
`_meta.json`, each with `{ id, name, goal, created_at, started_at, ended_at, status }`.
Sprints have a forward-only lifecycle: `planning → active → closed`, with
at most one `active` sprint per project. Sprints are manager-managed and
provide a structured way to group cards that should be worked on together.

**Every card must belong to a sprint.** `kanban_create_card` requires
`sprint_id` and rejects with `400 invalid_field` if it's missing, points
to a closed sprint, or targets a sprint in a different project. There is
no way to mint a sprintless card. Legacy cards from before this rule
(`sprint_id: null` on disk) are grandfathered for reads/edits but no new
card can be created without a sprint.

- `kanban_create_sprint { project, name, goal? }` — declare a sprint in
  `planning`. Manager-only; returns the Sprint object including the
  generated `sprint-<8 char>` id and `created_at`.
- `kanban_start_sprint { sprint_id }` — transition `planning → active`.
  Refuses with `409 another_sprint_active` if the project already has a
  different active sprint. Sets `started_at`.
- `kanban_list_sprints { project, status?: 'planning' | 'active' | 'closed' | 'open' | 'all' }`
  — **PM/manager only.** `open` is sugar for "planning + active" (what the web app and most
  agent flows want). PM agents scoped to their own project; managers can list
  any project.
- `kanban_get_sprint { sprint_id }` — **PM/manager only.** Returns
  `{ sprint, project, cards: CardSummary[], aggregates }` where
  aggregates carries per-status counts and total token spend. Useful
  as the briefing card for an agent: "what's the goal, how many cards
  are done vs todo, how much have we already spent?".
- `kanban_add_to_sprint { sprint_id, card_ids[], move_to_todo?: boolean }`
  — bulk-attach. `move_to_todo: true` also moves the cards to the `todo`
  column in one pass, which is the canonical "start the sprint" gesture.
  Returns `{ updated[], failed[] }`.
- `kanban_move_between_sprints { sprint_id, target_sprint_id, card_ids[] }`
  — bulk-reassign cards from a source sprint to a target sprint in the
  same project. Asserts source membership (cards not in `sprint_id` go
  to `failed[]` with `not_in_source_sprint`). Replaces the old
  `remove_from_sprint`: under the "every card belongs to a sprint" rule
  you cannot strip `sprint_id` back to null — archive the card instead.
- `kanban_close_sprint { sprint_id, rollover_to: string }` — marks
  `status: 'closed'` and `ended_at`. Cards already `done` stay attached
  (for retrospective accounting). Unfinished cards are reassigned to
  `rollover_to`, which **must** point at a `planning` sprint in the same
  project. To discard a card instead of rolling it over, archive it before
  closing. Returns `{ rolled_over[], finished[] }`.

SSE event types: `SPRINT_CREATED`, `SPRINT_STARTED`, `SPRINT_UPDATED`
(membership change), `SPRINT_CLOSED`. Audit ops: `SPRINT_CREATED`,
`SPRINT_STARTED`, `SPRINT_CLOSED`.

**Dependencies (`blocked_by`).** Cards have a `blocked_by: string[]`
field — ids of other cards in the same project that must finish before
this card can advance. Set it via `create_card` or `update_card`. The
server enforces the graph:

- **Validation**: every id must exist, be in the same project, and not
  equal the card's own id. Self-reference, missing card, and
  cross-project ids return `400 invalid_field` with `reason` set.
- **Cycle detection**: the proposed `blocked_by` is walked forward. If
  any path leads back to the card being updated, the call returns
  `400 invalid_field` with `reason: "cycle: <start> → … → <self>"`.
- **Forward-progress guard**: `move_card` and `update_card` refuse to
  advance a card from `backlog`/`todo` into `in-progress`/`review`/
  `done` while it still has unsatisfied blockers. Response is
  `409 { error: "blocked", blockers: [{ id, status }] }`. Sideways
  moves within the unstarted columns are still allowed.
- A blocker is **satisfied** when its card is `done`, archived, or has
  been deleted — an outdated reference never permanently locks a card.

The companion query is `kanban_pick_next { project?, sprint_id?,
assigned_to?, status? }`. It returns the highest-priority card in
`status` (default `todo`) that matches the optional filters and has
all its blockers satisfied. The response also carries
`blocked_candidates: number` so an agent can see whether the queue is
empty or just gated. **For dev agents, `sprint_id` is always set to the
active sprint automatically — passing a different value is ignored.**

**Card ownership (`assigned_to`).** Every card has an `assigned_to`
field that doubles as an ownership claim. Mutations
(`update_card`, `move_card`, `reorder_card`, `archive_card`,
`unarchive_card`, `delete_card`) are gated by it:

- Manager tokens always pass.
- Unassigned cards (`assigned_to == null`) accept any agent in the
  project — the call implicitly claims the card.
- Cards owned by `agent:foo` only accept calls from that actor;
  other agents get `403 forbidden { reason: "not_assigned",
  assigned_to: "agent:foo" }`.

Agents trying to change `assigned_to` via `update_card` can only
claim (set to their own actor) or release (set to `null`).
Cross-agent reassignment returns `403 forbidden { reason:
"cannot_reassign", target }` and is manager-only.

Two sugar tools wrap the common transitions with cleaner errors:

- `kanban_claim_card { id, version, ...tokens }` — claims an
  unassigned card. Returns `409 { error: "already_claimed",
  current_assigned_to }` if another agent already holds it.
  Manager tokens can pass `actor: "agent:foo"` to claim on
  behalf of another agent.
- `kanban_release_card { id, version, ...tokens }` — releases
  your own card so the next agent can claim. No-op (no version
  bump, no audit row) on an already-unassigned card.

Both emit `CARD_UPDATED` SSE with `changed_fields: ["assigned_to"]`
and write `CLAIM` / `RELEASE` audit ops so handoffs are easy to
filter out of the timeline.

- `kanban_defer_card { id, version, blocked_by, log_entry, ...tokens }`
  — dev-safe way to defer a card that turns out to depend on
  **another card**, including one already in `review`. Merges
  `blocked_by` (same validation as `kanban_update_card`: existence,
  same-project, no cycles), appends `log_entry` to `# Agent Log`,
  clears `assigned_to`, and moves the card to `todo` if it was in a
  started column — atomically, avoiding the version-conflict-prone
  sequence of `update_card` + `log_on_card` + `release_card` +
  `move_card`. `kanban_pick_next` skips the card again until every
  blocker is `done`, archived, or deleted.

**Archived cards.** Cards with `archived: true` are hidden from
`kanban_list_cards` by default. Pass `include_archived: true` to fold them
back into the result, or `archived_only: true` to see only archived cards
(takes precedence over `include_archived`). Use `kanban_archive_card` and
`kanban_unarchive_card` (both take `{ id, version, ...tokens }`) to flip
the flag — they obey the same optimistic-locking rules as updates, bump the
version, log `ARCHIVE` / `UNARCHIVE` in the audit log, and emit
`CARD_ARCHIVED` / `CARD_UNARCHIVED` SSE events. Archiving an
already-archived card (or unarchiving an unarchived one) is a no-op: the
server returns the card unchanged without bumping the version.

**SSE events.** `GET /events` is a long-lived stream emitting frames like:

```
event: CARD_UPDATED
id: 42
data: {"type":"CARD_UPDATED","payload":{"card_id":"card-abc","project":"marketing","changed_fields":["title"]}}
```

Event types: `CARD_CREATED`, `CARD_UPDATED`, `CARD_MOVED`, `CARD_REORDERED`,
`CARD_HUMAN_EDITED`, `CARD_DELETED`, `CARD_ARCHIVED`, `CARD_UNARCHIVED`,
`PROJECT_ARCHIVED`, `PROJECT_UNARCHIVED`, `PROJECT_DELETED`. Pass
`Last-Event-ID` on reconnect to replay missed frames (100-event rolling
buffer).

**Card filenames.** Each card lives at
`<vault>/kanban-data/<project>/<file_basename>.md`. The basename derives from
the title but is also exposed as `card.file_basename` in API responses for
clients that need it. Renaming the file in Obsidian is honored; renaming with
a non-existent project folder is rejected by the watcher.

**Dev agent escalation.** Dev agents cannot create cards, update card fields,
manage sprints, or query sprint information. All dev-agent tool calls require an
active sprint — if none exists, the server returns `409 no_active_sprint`.
`kanban_list_cards` and `kanban_pick_next` automatically scope to the active
sprint. When a dev agent is **blocked** or needs to **propose** something
(a new card, change of scope, an impediment), the protocol is:

1. Call `kanban_log_on_card` — document the blockage or proposal clearly
   enough that a PM can act without asking questions.
2. Call `kanban_move_card { to_status: "review" }` — hand the card to the PM.
3. Call `kanban_pick_next` — continue with the next available task.

The PM agent reads cards in `review`, inspects the Agent Log, and decides:
- Move to `done` or archive (task no longer needed).
- Create a new card for the proposed work and return the original to `todo`.
- Resolve the blocker directly and return the card to `todo`.

**Dev agent dependency (not an escalation).** If the blockage is that the
card depends on **another card** — even one already in `review` — that does
not need a human decision and must not go through `review`. Call
`kanban_defer_card { id, version, blocked_by: [<other card id>], log_entry }`
instead: it merges the blocker, logs why, releases the claim, and returns
the card to `todo`, then continue with `kanban_pick_next`. This keeps
`review` reserved for the root card that actually needs judgment, instead of
a cascade of dependents.

**Health.** `GET /health` returns `{"status":"ok"}` without auth — use it as
your reachability probe and to drive an "offline" indicator while the SSE
stream is reconnecting.

**Metrics.** `GET /metrics` (loopback only, no auth) returns token totals and
aggregates by type/model/agent/day/operation. Filter with `?from_date=YYYY-MM-DD&to_date=YYYY-MM-DD`.

---

## 7. End-to-end TypeScript example

See `scripts/example-agent-integration.ts` for the full working flow:

1. Reachability check via `/health`.
2. Create card with a fresh `request_id`.
3. Idempotent retry of the same create (returns cached response).
4. Update with stale version → catch 409 → retry against `current_card.version`.
5. Move card across columns.
6. Subscribe to SSE for live event handling.
7. Delete the card.

Run it against a live MCP with:

```bash
KANBAN_MCP_TOKEN=<agent-token> \
node --import tsx scripts/example-agent-integration.ts
```

The script is intentionally dependency-free (uses `node:http` and the global
`fetch`) so you can copy it into a sandbox or another runtime without
pulling the whole repo.
