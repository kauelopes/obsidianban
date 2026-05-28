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

The MCP server exposes the same tool surface over three transports. Pick
based on where your agent runs.

| Transport | Endpoint | When to use |
|---|---|---|
| `stdio` | spawn `node dist/index.js` as child process, framed JSON-RPC on stdin/stdout | Local agents bundled with the MCP (no network hop) |
| `HTTP` | `POST http://127.0.0.1:3000/mcp/tool/<tool_name>` | Remote agents, polyglot stacks, debug tooling |
| `SSE` | `GET http://127.0.0.1:3000/events` | Real-time mutation feed (no polling) |

The HTTP and SSE servers bind to `127.0.0.1` only by default. `GET /metrics`
is loopback-locked at the application layer too, so it never leaves the host.

All examples below use the HTTP transport because it's the easiest to inspect
with `curl`; the JSON payloads are identical across transports.

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
round trip. The response is `{ project, token, token_id, actor, created_at }`
and the raw `token` is only returned this once — the server keeps a SHA-256
hash. Re-calling with the same project name is allowed and additive: the
folder is reused, a new token is appended, prior tokens stay valid until
explicitly revoked via the CLI. Agent tokens calling this tool get `403
forbidden { reason: "manager_required" }`. Project and actor names are
validated against `[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}` (actors also allow
`:` for the conventional `agent:foo` / `human:bar` prefixes).

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
`CARD_HUMAN_EDITED`, `CARD_DELETED`, `CARD_ARCHIVED`, `CARD_UNARCHIVED`.
Pass `Last-Event-ID` on reconnect to replay missed frames (100-event
rolling buffer).

**Card filenames.** Each card lives at
`<vault>/kanban-data/<project>/<file_basename>.md`. The basename derives from
the title but is also exposed as `card.file_basename` in API responses for
clients that need it. Renaming the file in Obsidian is honored; renaming with
a non-existent project folder is rejected by the watcher.

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
