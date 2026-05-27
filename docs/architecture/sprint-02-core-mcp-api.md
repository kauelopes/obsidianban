# Architecture — Sprint 02 Core MCP API

Reference for maintainers of the agent-facing tool layer. This document
covers what Sprint 02 added on top of the Sprint 01 substrate. Read
`sprint-01-foundation.md` first — the substrate concepts (atomic writer,
file watcher, audit log, token validator, idempotency store) are taken
for granted here.

---

## 1. Scope

Sprint 02 delivers the six MCP tools and the two real-time transports:

- `kanban_list_cards`, `kanban_get_card` — reads
- `kanban_create_card`, `kanban_update_card` — mutations with optimistic
  locking and per-role allow-lists
- `kanban_move_card`, `kanban_reorder_card` — column / position
  management with position normalization
- `GET /events` — SSE event stream with `Last-Event-ID` replay
- `--stdio` mode — same tools exposed over MCP stdio via
  `@modelcontextprotocol/sdk`

Everything mutating produces:
1. Atomic write of the `.md` (Sprint 01 invariant)
2. `audit.ndjson` entry
3. `token_log` row in SQLite
4. SSE event

Idempotent retries (same `request_id`) short-circuit at the HTTP layer
and produce **none** of (1)–(4) on the second call.

---

## 2. Module Map (Sprint 02 additions)

```
src/
  services/
    errors.ts              — HttpError + notFound / badRequest / conflict.
                             Service layer never touches the response —
                             throws these and the HTTP dispatcher renders.
    validation.ts          — Field validators shared by all mutations:
                             requireString, requireInt, optTags, optDueDate,
                             optNullableString (present vs. absent vs. null),
                             rejectDisallowed (allow-list), generateCardId.
    query.ts               — QueryService.list (SQLite only — never reads .md).
    card.ts                — CardService.{get, create, update, move, reorder}.
                             Single mutation entry point. Owns optimistic
                             locking, position math, audit + token_log + SSE.

  server/
    sse.ts                 — SSEEventBus: in-memory pub/sub with a 100-event
                             rolling history for Last-Event-ID replay.
    stdio.ts               — StdioMcpServer: thin SDK adapter that re-exposes
                             the same tool handlers over MCP stdio. No own
                             auth — token validated once at process start.
    http.ts                — Extended with GET /events handler and SSE dep.
```

Dependency direction stays one-way: `index → services → cards/writer/db`,
`index → server/http → services`, `server/stdio → services`. SSE is a
leaf utility consumed by both transports and the file watcher.

---

## 3. Service Layer

The HTTP and stdio transports are dumb — they validate auth, route by
name, and call into the same handler functions. All business rules live
in `CardService` and `QueryService`.

```
Transport (HTTP / stdio)
       │
       │  (params: Record<string, unknown>, claims: TokenClaims)
       ▼
   QueryService  ── reads ─────────────►  CardRepository (SQLite only)
   CardService   ── reads ─────────────►  CardRepository + .md
                  ── mutations ─────►    AtomicWriter (Sprint 01)
                  ── audit ─────────►    AuditLogger  (Sprint 01)
                  ── token_log ─────►    CardRepository.logTokens
                  ── events ────────►    SSEEventBus
```

**Why a service layer at all?** Sprint 02 must serve the same tools from
two transports. Putting validation/business logic in `CardService` means
we write it once. The stdio adapter is ~80 lines because it has no
domain knowledge.

### Error contract (services/errors.ts)

`HttpError(status, body)` is the only error type that crosses the
service → transport boundary. The HTTP dispatcher catches it and renders
the matching status code; the stdio adapter catches it and returns a
`CallToolResult` with `isError: true` plus the body as JSON text.

Handlers never set status codes. Helpers:

- `notFound()` — 404 `{ error: 'not_found' }`
- `badRequest(error, extras?)` — 400 with whatever extras the caller wants
- `conflict(body)` — 409 with the full conflict payload (see §5)

### Validation layer (services/validation.ts)

Every mutation starts with `rejectDisallowed(params, ALLOW_LIST)` — any
key outside the list is a 400 with `disallowed_fields`. This is the
contract that lets us split allow-lists by role (agent vs. manager)
without smuggling permissions inside type checks.

Then field-by-field validators run. They return either the parsed value
or throw `badRequest('invalid_field', { field, ... })`. Important nuance:

- `optString` returns null when the key is absent OR explicitly null.
- `optNullableString` distinguishes the two via `{ present, value }`.
  Used where `field: null` must be treated as "clear this field"
  (`due_date`, `assigned_to`, `owner`) — distinct from "field not in
  payload" which means "leave alone".

### Allow-lists per operation

| Operation | Agent | Manager addition |
|---|---|---|
| `kanban_create_card` | title, type, input_tokens, output_tokens, model, status, priority, tags, due_date, assigned_to, body, agent_notes, request_id | `project` (agent uses claims.project_id; manager must specify) |
| `kanban_update_card` | id, version, input_tokens, output_tokens, model, request_id, title, status, priority, tags, due_date, assigned_to, agent_notes, body | `owner` (manager-only field per PRD §6.5) |
| `kanban_move_card` | id, version, to_status, input_tokens, output_tokens, model, request_id | — |
| `kanban_reorder_card` | id, version, after_card_id, input_tokens, output_tokens, model, request_id | — |

System-generated fields (`id`, `project` for agents, `version`,
`position`, `type` on update, `created_at`, `updated_at`, `created_by`,
`updated_by`, `total_input_tokens`, `total_output_tokens`) are never in
any allow-list. Sending them returns 400 with `disallowed_fields`.

---

## 4. Position Management

**Invariant I-08:** for every `(project, status)` column, `position`
values are positive integers; the column is dense after a reorder
(values `1000, 2000, 3000, ...`); between operations gaps are allowed.

| Operation | Position behavior |
|---|---|
| `create_card` | `(MAX(position WHERE project, status) ?? 0) + 1000` |
| `update_card` with status change | Same as move: `MAX(destination) + 1000`. Source column has a gap; reorder normalizes. |
| `update_card` without status change | Position unchanged. |
| `move_card` | `MAX(to_status) + 1000` |
| `reorder_card` | Rebuild the entire column: target inserted after `after_card_id` (or at top if null), then positions reassigned `1000, 2000, ...` in order. Unchanged neighbours skip the write. |

`CardRepository.maxPosition(project, status)` and `findByColumn(project,
status)` are the SQL primitives. The repository never decides where a
card goes — it just reports.

---

## 5. Optimistic Locking — the 409 contract

The `update`, `move`, and `reorder` flow:

```
1. rejectDisallowed         → 400 disallowed_fields (wins over version)
2. parse + validate params  → 400 invalid_field
3. findById(id)             → 404 if absent or cross-project for agent
4. read body from .md       → 404 if file missing
5. claimedVersion === current.version ?
     no  → 409 conflict
     yes → apply mutation
6. atomic write + repo.upsert
7. token_log + audit + SSE
```

**Why allow-list before version check?** `disallowed_fields` is a
client-side bug (agent code sending a forbidden field); `409` is a
benign race (someone else wrote first). The client must fix the bug
before the race becomes meaningful. Tested in
`smoke-batch5.mjs` Test 8.

### 409 payload

```json
{
  "error": "conflict",
  "message": "Version mismatch: expected 7, found 9",
  "your_version": 7,
  "current_version": 9,
  "conflicting_fields": ["status"],
  "current_card": { …full Card including body… }
}
```

- `current_card.body` is read from `.md` so the retry sees the
  on-disk truth.
- `conflicting_fields` lists only fields the caller tried to change
  that have since drifted. For `move_card` it is `['status']` when
  current.status !== to_status, `[]` otherwise. For `reorder_card`
  it is always `[]` (position is system-managed).

---

## 6. Token Accounting

Every successful mutation:

1. Appends an `audit.ndjson` entry with `input_tokens`, `output_tokens`,
   `model` (and op-specific fields like `changed_fields`,
   `from_status`/`to_status`, `affected_cards`).
2. Inserts a row into `token_log` via `CardRepository.logTokens`.
3. For the target card only: increments `total_input_tokens` and
   `total_output_tokens` in both the frontmatter and the SQLite row.

`reorder_card` accumulates tokens only on the target card. Neighbours
re-positioned by normalization do not receive token deltas — they are
mechanical side-effects, not agent work. Smoke test 12 of batch 5
verifies this for updates; batch 6 verifies reorder.

Idempotent retries (same `request_id`) never reach the handler — the
HTTP layer returns the cached response. Therefore no second
audit/token_log/SSE emission. Tested in batch 5 Test 12.

---

## 7. SSE Event Bus

`SSEEventBus` is an in-memory pub/sub:

```
emit(event)
  ├─ assign monotonically increasing id
  ├─ push to history (cap 100, oldest dropped)
  └─ broadcast to every client.res.write(SSE block)

subscribe(res, lastEventId?)
  ├─ replay history entries with id > lastEventId
  ├─ add client to set
  └─ return unsubscribe()  (called from req.on('close'))
```

**Why 100 events of history?** Sized to cover the typical
plugin-reconnect window (network hiccup, sleep/wake, brief MCP restart).
A flood of edits in a small column can exhaust the buffer; clients with
very stale IDs get only what we still have and the plugin must
reconcile via `kanban_list_cards`. That contract is acceptable for
Sprint 02 — Sprint 03 may add a persistent journal if reconnect drops
become a measured problem.

**Why localhost-only and no auth?** `GET /events` is read-only and the
server is bound to `127.0.0.1`. The threat model is "another local
process snooping" — already covered by file-system permissions on
the vault. Adding token auth here would just push the bearer through
URL params (EventSource doesn't allow headers in the browser anyway)
and accomplish nothing.

### Event emission points

| Event | Emitted by |
|---|---|
| `CARD_CREATED` | `CardService.create` after atomic write + audit |
| `CARD_UPDATED` | `CardService.update` after atomic write + audit |
| `CARD_MOVED` | `CardService.move` after atomic write + audit |
| `CARD_REORDERED` | `CardService.reorder` after all neighbour writes |
| `CARD_HUMAN_EDITED` | `FileWatcher` after revert/merge commit |
| `CARD_DELETED` | _not emitted in Sprint 02 — see §11_ |

Order matters: emit happens **after** the write and audit log so a
listener that triggers a follow-up read always sees the new state.

---

## 8. Stdio Transport

The MCP SDK's stdio transport speaks JSON-RPC on stdin/stdout. We use
the low-level `Server` class (not the high-level `McpServer`) so we
don't pull Zod schemas for each tool — the param object is forwarded
as-is to the same `CardService` validators used by HTTP.

**Mode selection:** the process inspects `process.argv` for `--stdio`.
With the flag:

- HTTP server does **not** start (port stays free, no listener bound).
- File watcher and reconciliation **do** run — these are system
  invariants, not transport features.
- All logs go to **stderr**. Stdout is reserved for JSON-RPC frames.
- Audit log and SSE bus are wired normally. The bus may have zero
  subscribers in stdio mode; that's not an error.

**Authentication:** stdio has no per-request header, so the token is
read once from `KANBAN_MCP_TOKEN` on startup, validated via the same
`TokenValidator`, and the resulting `TokenClaims` is reused for every
tool call in the session. Failed validation → `process.exit(1)` with
a stderr message. Reasoning: the operator launching an agent already
chose which project's data the agent gets to see; rotating mid-process
isn't a meaningful capability.

**Tool registration:** the same `tools` array in `src/index.ts`
populates both transports. There is exactly one source of truth for
tool name → handler.

---

## 9. HTTP Request Flow (updated)

```
POST /mcp/tool/:name
  ├─ authenticate (Sprint 01)
  ├─ parse JSON
  ├─ validate request_id (if present)
  ├─ idempotency.get(request_id) → cached? send 200 cached.response, STOP
  ├─ dispatch to registered handler
  │     ├─ throw HttpError(404 | 400 | 409) → send err.status, err.body
  │     └─ return value → continue
  ├─ idempotency.put(request_id, response) (if request_id present)
  └─ send 200 response

GET /events
  ├─ parse Last-Event-ID header (numeric only — ignore otherwise)
  ├─ set SSE headers + flush
  ├─ subscribe to bus (replays history > lastEventId)
  └─ req.on('close') → unsubscribe
```

The dispatcher catches `HttpError` both at the synchronous `dispatch()`
level (validation errors thrown before the handler runs) and inside
`handleToolCall` (errors from the handler). This redundancy is
intentional: it removes any branch where an `HttpError` could leak to
the 500 catch-all.

---

## 10. Invariants Added in Sprint 02

(Continuing the numbering from `sprint-01-foundation.md`.)

- **I-08 (position density after reorder):** after `kanban_reorder_card`
  completes, every card in the affected column has `position % 1000 ===
  0` and positions are contiguous starting at 1000. Enforced by
  `CardService.reorder`; tested in smoke-batch6 Test 4.

- **I-09 (no double-spend on idempotent retry):** a successful response
  cached by `IdempotencyStore` is replayed verbatim. The handler does
  not run again, so no audit row, token_log row, frontmatter token
  accumulation, or SSE emission can duplicate. Tested in smoke-batch5
  Test 12.

- **I-10 (allow-list before optimistic check):** for any mutating tool,
  a payload with `disallowed_fields` returns 400 even if `version` is
  also stale. The client must repair its payload before it can win the
  race. Smoke-batch5 Test 8.

- **I-11 (single source of tool handlers):** the array in
  `src/index.ts:main()` is the only place tools are enumerated.
  HTTP and stdio iterate the same array. Adding a tool means editing
  exactly one list.

---

## 11. Known Limitations / Sprint 03 Hooks

- **`CARD_DELETED` not emitted.** The file watcher doesn't subscribe to
  `unlink` events (Sprint 01 decision — reconciliation at next startup
  is the only deletion path). PRD §6.10 lists CARD_DELETED for manager
  deletes; Sprint 03 or later must add an `unlink` listener that emits
  this event and writes an audit entry.
- **No upper bound on reorder writes.** A column with N cards may cause
  up to N atomic writes per reorder. No batching, no SQLite
  transaction. Acceptable for the expected card counts (~tens per
  column). Bulk operations would need a transactional path.
- **SSE history is in-memory.** A server restart drops it; reconnecting
  clients with `Last-Event-ID` from before the restart get no replay
  for the missing window and must reconcile via `kanban_list_cards`.
- **Stdio + HTTP simultaneously on the same vault.** SQLite WAL handles
  multi-reader/single-writer; chokidar will fire events twice (once per
  process) and each watcher will revert the other's writes via the
  hash discriminator. Don't run both modes against the same vault until
  this is validated. For now: pick one.
- **No bulk APIs.** `kanban_create_card` is one-card-per-call. Bulk
  import is left as a future tool.

---

## 12. When You Change Things

- Adding a new tool? Append to the `tools` array in `src/index.ts`,
  add the handler to `CardService` (or a new service), and define its
  allow-list. Both transports pick it up automatically.
- Adding a new SSE event type? Update `SSEEventType` in
  `docs/design/interfaces.ts` first, then `src/types.ts`, then emit
  it from the service. The plugin is the consumer — coordinate.
- Changing token accounting? Edit `CardRepository.logTokens` and the
  frontmatter accumulation in `CardService`. Verify smoke-batch5
  Tests 11 and 12 still pass.
- Touching position math? Add a smoke for the new edge case before
  the change. Position bugs are silent and hard to catch from
  end-user behavior.
- Touching SSE buffering? The 100-event window is a contract with
  the plugin; if you shrink it, document it in PRD §6.10 first.
