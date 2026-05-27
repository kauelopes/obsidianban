# Architecture — Sprint 01 Foundation

Reference for maintainers of the foundation layer. Captures what was
built in Sprint 01, why each piece exists, and the invariants future
sprints must preserve. Read this before changing anything in `src/`.

For normative interface contracts, see `docs/design/`. For requirements,
see `docs/prd/`.

---

## 1. Scope

Sprint 01 delivers the **runtime substrate** for the MCP server. No
agent-facing tools yet (those land in Sprint 02). What works today:

- A configured vault layout (`.kanban-data/`, `.kanban/`).
- An atomic write protocol that keeps `.md` and SQLite consistent.
- A file watcher that protects invariants against human edits.
- Startup reconciliation that detects and repairs drift from offline
  edits.
- A token CLI and an HTTP auth middleware tying Bearer tokens to
  `TokenClaims`.
- An idempotency store ready to deduplicate retried requests.
- A `GET /health` endpoint usable by container HEALTHCHECK and the
  Obsidian plugin.

The HTTP transport is up; the stdio MCP transport and the actual tool
handlers are Sprint 02.

---

## 2. Module Map

```
src/
  index.ts                 — Process entry; wires startup sequence (§3).
  config.ts                — Env loading and vault path derivation.

  vault/
    layout.ts              — Directory provisioning, _meta.json bootstrap,
                             orphan .tmp cleanup, project enumeration.

  db/
    schema.ts              — SCHEMA_STATEMENTS (cards + token_log + indexes).
    database.ts            — openDatabase: WAL mode, idempotent schema apply,
                             stale WAL/SHM cleanup when main file is missing.

  cards/
    serialize.ts           — gray-matter wrapper. serializeCard (deterministic
                             frontmatter key order), parseCardFile,
                             cardFromFrontmatter (strict type validation).
    repository.ts          — CardRepository: SQLite CRUD over the cards table.

  writer/
    atomic.ts              — AtomicWriter (.tmp + fsync + rename + upsert).
                             Exports sha256(text) shared by watcher/reconcile.

  watcher/
    file-watcher.ts        — chokidar v4 watcher with per-file debounce,
                             hash-based MCP-originated discriminator,
                             revert-and-log pipeline for human edits.

  startup/
    reconcile.ts           — Hash-based scan, RECONCILED/ORPHAN_REMOVED/
                             SQLITE_REBUILT audit emission.

  audit/
    logger.ts              — Append-only NDJSON writer for audit events.

  auth/
    tokens.ts              — Token generation, agent/manager store I/O,
                             lookup by SHA-256.
    validator.ts           — TokenValidator: Bearer → TokenClaims |
                             {missing, invalid, revoked}.
    cli.ts                 — kanban-token CLI binary.

  server/
    http.ts                — HTTP listener bound to 127.0.0.1; auth +
                             idempotency + (Sprint 02) tool dispatch.
    idempotency.ts         — IdempotencyStore: 24h TTL Map persisted to
                             .kanban/idempotency.json.

  types.ts                 — Local copy of docs/design/interfaces.ts.
```

Each file owns one concern. Inter-module dependencies go one way:
`server → auth → vault`, `watcher → writer → cards → db`. There are no
cycles.

---

## 3. Startup Sequence

`src/index.ts:main()` runs the following ordered steps. The order
matters — each step has a precondition met by the previous ones.

```
1. loadConfig()
     └ VAULT_PATH (required), MCP_HTTP_PORT (default 3000), LOG_LEVEL.

2. ensureLayout(paths)
     └ mkdir .kanban-data/, .kanban/ if missing.

3. cleanupOrphanTmpFiles(paths)
     └ Removes any .tmp left over from a kill during AtomicWriter.write
       (between fs.open and fs.rename). Safe because every legitimate
       .tmp is short-lived.

4. openDatabase(paths.sqlite)
     └ Apply schema (idempotent). createdFromScratch=true is propagated
       to reconciliation for SQLITE_REBUILT.

5. Build state {startedAt, vaultPath, reconciling: true, db}.

6. validator = new TokenValidator(paths)
   idempotency = new IdempotencyStore(...).load()
     └ load() drops entries older than 24h and rewrites the file.

7. httpServer.start()       ← HTTP up BEFORE reconciliation so /health
                              responds 503 during the next step.

8. report = await reconcile(...)
   state.reconciling = false
     └ Scans .kanban-data/*/card-*.md. SHA-256 each file, upsert if
       it differs from SQLite. Remove orphans. Log SQLITE_REBUILT
       if openDatabase reported a fresh DB.

9. watcher.start()
     └ Awaits chokidar's 'ready' event before returning, so the
       "ready" log line really means "watcher armed".

10. Install SIGINT/SIGTERM → graceful shutdown: stop watcher → stop
    http → close db → process.exit(0).
```

### Why the HTTP server starts before reconciliation

A container HEALTHCHECK or plugin probe that hits `/health` during
reconciliation must get a meaningful answer. Returning `503
{status: 'reconciling'}` is more useful than connection refused — it
distinguishes "MCP is up but warming" from "MCP is down".

---

## 4. Data Model Invariants

These are the rules every subsystem must respect. Breaking any of them
is a bug. They are testable by inspection and by the smoke scripts.

### I-01 — Single writer

All writes to a card go through `AtomicWriter.write()`. The file watcher
does not write files directly — it calls `writer.write()`. The MCP tools
(when they land) will do the same. **There is no other path.**

Where enforced: `src/watcher/file-watcher.ts` only calls `this.writer.write(...)`.
There is no `fs.writeFile` against `.md` files anywhere except in
`AtomicWriter`.

### I-02 — `.md` ↔ SQLite atomicity

After `AtomicWriter.write()` returns, the `.md` content and the SQLite
row are consistent. A crash mid-write leaves at most a stale `.tmp` file
(cleaned up at next startup).

Where enforced: `src/writer/atomic.ts:write()` — the SQLite upsert runs
after the rename succeeds, and `cleanupOrphanTmpFiles` runs before any
read of SQLite at startup.

### I-03 — `file_hash` equals SHA-256 of `.md`

`row.file_hash === sha256(read(card.md))` for every row in `cards`. This
invariant is both used (by the watcher's hash discriminator) and
maintained (by AtomicWriter computing `fileHash` from the same string it
writes).

Where enforced: `src/writer/atomic.ts:write()`. Verified by reconciliation
on every startup.

### I-04 — Hash discriminates MCP-originated writes

When the file watcher receives an event and the file content hashes to
the value stored in SQLite, the write came from MCP (or is a content-
preserving touch). The watcher skips processing.

This **replaces the PRD §7.4 "MCP-originated flag"**. The flag-based
version (a timer-bounded `Set<cardId>`) raced with chokidar's async
event delivery and caused a feedback cascade during the watcher's own
revert writes. The hash approach is race-free and derives from already
persisted state. Same invariant in stronger form.

Where enforced: `src/watcher/file-watcher.ts:process()` early return
when `row.file_hash === sha256(content)`.

### I-05 — Immutable fields

`id`, `project`, `version`, `position`, `created_at`, `created_by` are
never editable by humans through the `.md` file. If a human edit changes
any of them, the watcher reverts that field to the SQLite value and
logs `FIELD_REVERTED`.

Where enforced: `src/watcher/file-watcher.ts:process()`, the
`IMMUTABLE_FIELDS` loop.

### I-06 — Token raw values are never persisted

The CLI prints a raw token exactly once. Only its SHA-256 lives in
`_meta.json.agent_tokens[]` or `.kanban/manager-tokens.json`. The
validator never receives the raw token from disk — it hashes the
incoming Bearer and looks up the hash.

Where enforced: `src/auth/tokens.ts` — `randomBytes` happens in
`generateToken()`; only `{token_id, sha256, ...}` is pushed to storage.

### I-07 — `TokenClaims` is constructed from the token record, not the request payload

Agent tokens carry their `project_id` in their stored record. The HTTP
middleware reads `project_id` from the looked-up record, not from the
request body. A malicious payload claiming `project_id: 'other'` cannot
elevate access.

Where enforced: `src/auth/validator.ts:validate()` returns claims built
from `hit.project_id` (the record's owning project), never from input.

---

## 5. Atomic Write Protocol

```
AtomicWriter.write(card, body):
  filePath = .kanban-data/{project}/{id}.md
  tmpPath  = filePath + ".tmp"
  content  = serializeCard(card, body)        ← deterministic frontmatter
  fileHash = sha256(content)

  mkdir(parentDir, {recursive: true})

  fh = open(tmpPath, "w")
    fh.writeFile(content)
    fh.sync()                                  ← fsync the tmp
  fh.close()

  rename(tmpPath, filePath)                   ← atomic on POSIX
  repo.upsert(card, fileHash)
```

Crash semantics:

| Crash point | State after restart |
|---|---|
| Before open | No tmp, no change. Clean. |
| After open, before rename | `.tmp` orphan; cleaned by `cleanupOrphanTmpFiles`. |
| After rename, before SQLite upsert | `.md` has new content; SQLite has old hash. Reconciliation rehashes and upserts (`RECONCILED`). |
| After SQLite upsert | Consistent. |

There is no "after rename" window where `.md` is corrupted — `rename` is
atomic. A reader of `.md` either sees the old content or the new one,
never a half-written file.

---

## 6. File Watcher Pipeline

```
chokidar event (add | change) on path matching card-*.md
        │
        ├─ schedule(path) — clear existing 500ms timer, set new one
        │
        └─ after 500ms quiet:
              │
              ├─ readFile(path) → content
              │   └─ ENOENT → return (file already gone)
              │
              ├─ row = repo.findById(id)
              │   └─ no row + file present → log EXTERNAL_MUTATION, return
              │      (creation via markdown not supported at runtime)
              │
              ├─ if row.file_hash === sha256(content) → return  ← I-04
              │
              ├─ parseCardFile(content)
              │   └─ throw → revertWholeFile, log PARSE_ERROR
              │
              ├─ cardFromFrontmatter(data)
              │   └─ throw → revertWholeFile, log PARSE_ERROR
              │
              ├─ For each IMMUTABLE_FIELDS: if human ≠ sqlite,
              │   set merged[field] = sqlite[field], record reverted_fields
              │
              ├─ Validate mutable fields:
              │   - status ∈ _meta.json.columns  (else revert)
              │   - due_date matches /^\d{4}-\d{2}-\d{2}$/  (else revert)
              │
              ├─ Emit FIELD_REVERTED per reverted field
              │
              ├─ merged.version = sqlite.version + 1
              │  merged.updated_at = now
              │  merged.updated_by = 'human:manager'
              │
              ├─ writer.write(merged, parsed.body)
              │
              └─ Emit HUMAN_EDIT with changed_fields diff
```

The watcher's own revert write triggers another chokidar event. That
event will see `row.file_hash === sha256(content)` (because the watcher
just upserted that hash) and return immediately at the discriminator
step. No loop.

### What the watcher does NOT do

- **Does not react to file deletion.** Reconciliation handles
  `ORPHAN_REMOVED` at next startup. Restoring the file from SQLite at
  runtime is not in the PRD spec and was removed as out-of-scope code.
- **Does not auto-import new `.md` files** that appear at runtime
  without a SQLite row. Recorded as `EXTERNAL_MUTATION` and ignored.

---

## 7. Reconciliation

Runs once at startup. Two passes:

```
Pass 1 — Filesystem scan:
  for each .kanban-data/{project}/card-*.md:
    compute hash
    parse frontmatter
    if frontmatter.project ≠ {project}  → log PARSE_ERROR, continue
    if hash differs from row.file_hash (or row missing):
      repo.upsert(card, hash)
      log RECONCILED

Pass 2 — Orphan sweep:
  for each id in repo.allIds():
    if id was not seen in pass 1:
      repo.delete(id)
      log ORPHAN_REMOVED

If openDatabase reported createdFromScratch=true:
  log SQLITE_REBUILT { card_count }
```

The reconciler is also the recovery path for these scenarios:

- SQLite file deleted → fresh DB → all rows rebuilt from `.md`.
- MCP killed during a write, then `.md` is the new content but SQLite
  has the old hash → reconciler upserts the new content.
- A `.md` deleted while MCP was offline → orphan removal.

---

## 8. Token Architecture

Two token types, separate stores, separate scopes:

| Type | Stored in | Scope | Identifier |
|---|---|---|---|
| Agent | `.kanban-data/{project}/_meta.json` → `agent_tokens[]` | Single project | `token_id` (first 12 hex of SHA-256) |
| Manager | `.kanban/manager-tokens.json` → `manager_tokens[]` | All projects in vault | `token_id` (first 12 hex of SHA-256) |

Both records share the same `TokenRecord` shape: `{token_id, sha256,
actor, created_at, revoked_at}`. Separating the stores enforces
visibility — `kanban-token list --project P` can never accidentally
expose manager tokens because they live in a different file.

### Validation flow (`TokenValidator.validate`)

```
input: Bearer string (or undefined)

if undefined         → {ok: false, reason: 'missing'}

sha = sha256(bearer)
for project in listProjects():
  if meta.agent_tokens contains sha:
    if revoked_at set → {ok: false, reason: 'revoked'}
    else              → {ok: true, claims: {role:'agent', project_id, actor}}

if manager_tokens contains sha:
  if revoked_at set   → {ok: false, reason: 'revoked'}
  else                → {ok: true, claims: {role:'manager', actor}}

else                  → {ok: false, reason: 'invalid'}
```

The three failure reasons map to distinct error codes in the HTTP
layer (`missing_token`, `invalid_token`, `revoked_token`) so clients
can react differently to "you forgot to send a token" vs "your token
was revoked".

### CLI surface

```
kanban-token create --project P --role agent --actor A
kanban-token create --role manager --actor A
kanban-token list   --project P
kanban-token list   --manager
kanban-token revoke --project P --token-id ID
kanban-token revoke --manager --token-id ID
```

`create` prints the raw token to stdout exactly once with a reminder
that it cannot be recovered. `revoke` sets `revoked_at`; entries are
never deleted (preserves audit lineage).

---

## 9. HTTP Server

`src/server/http.ts` is a thin layer on Node's built-in `http` module.
Bound to `127.0.0.1` only.

### Routes

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| `GET` | `/health` | none | 200 `{status, uptime_s, vault, cards_indexed}`, or 503 `{status: 'reconciling'}` during startup. |
| `POST` | `/mcp/tool/:name` | Bearer | Middleware → idempotency → dispatch (Sprint 02). Today returns 501 `not_implemented` after passing auth and request_id validation. |
| anything else | | | 404. |

### Per-request flow for `/mcp/tool/:name`

```
1. authenticate
   - extract Bearer
   - validator.validate → claims | reason
   - reason → 401 with mapped error code
2. parse JSON body
   - invalid JSON → 400 invalid_json
3. validate request_id (if present)
   - non-UUIDv4 → 400 invalid_request_id
4. idempotency lookup (if request_id)
   - hit → return cached 200 response, skip dispatch
5. lookup handler in tools map
   - missing → 501 not_implemented   ← Sprint 01 state
6. run handler(params, claims)
7. cache response if request_id was present
8. send 200 with handler output
```

Sprint 02 plugs tools in via `httpServer.registerTool(name, handler)`.
Steps 1–4 and 7 already exist and are exercised by the smoke test.

### Why request_id validation precedes idempotency lookup

A malformed `request_id` could otherwise be silently stored or matched
against existing entries. Rejecting it early ensures the cache key
namespace is always valid UUID v4.

---

## 10. Configuration

```
VAULT_PATH       (required)  Absolute path to the Obsidian vault.
MCP_HTTP_PORT    (default 3000)
LOG_LEVEL        (default 'info')
```

`loadConfig()` reads them and derives every other path from `VAULT_PATH`
in `pathsFor(vault)`:

```
.kanban-data/                    cards by project
.kanban/db.sqlite                derived index
.kanban/audit.ndjson             append-only audit log
.kanban/idempotency.json         request_id cache
.kanban/manager-tokens.json      manager token store
```

The dot-prefix hides everything from Obsidian's file explorer.

---

## 11. Testing Strategy

Sprint 01 uses end-to-end smoke scripts under `scripts/`:

- `smoke-batch2.mjs` — atomic write hash consistency, SQLite rebuild,
  immutable-field revert, orphan removal, audit ops emitted.
- `smoke-batch3.mjs` — token CLI, /health payload, auth middleware
  401 reasons, idempotency 400 + 200 caching, revoke takes effect.

Both spawn the real MCP as a subprocess via `node_modules/.bin/tsx`
(direct path, not `npx`, so SIGTERM propagates) and assert against
file system state, SQLite, audit log, and HTTP responses.

There is no unit-test layer yet. Sprint 02/04 may introduce
fast-feedback unit tests around `serialize.ts`, `repository.ts`, and
the watcher pipeline.

Run locally:

```
npx tsx scripts/smoke-batch2.mjs
npx tsx scripts/smoke-batch3.mjs
```

Each script resets its own `/tmp/kanban-smoke-batch{N}` vault, so they
are safe to run repeatedly.

---

## 12. Known Limitations / Sprint 02 Hooks

- **No tools registered.** `POST /mcp/tool/:name` always returns 501.
  Sprint 02 calls `httpServer.registerTool(name, handler)` from
  `index.ts` after the server starts.
- **No stdio MCP transport.** The PRD asks for stdio + HTTP. The
  `@modelcontextprotocol/sdk` integration is deferred to Sprint 02 so
  it lands together with the tools.
- **`/health` during reconciliation.** The state machine is correct
  (`reconciling: true` until `await reconcile(...)` returns) but is
  hard to exercise deterministically without an injected delay.
  Verified by inspection; Sprint 04 hardening can add the
  fault-injection test.
- **Cross-project agent access.** When an agent token from project X
  hits a tool acting on project Y, the spec requires 404 (BR-03).
  This is enforced inside each tool handler against `claims.project_id`
  — added in Sprint 02 when handlers exist.
- **Container/Podman flow** (`./container.sh build/start`) was not
  exercised in this sprint. The Dockerfile builds locally via
  multi-stage TS compile; end-to-end is a Sprint 04 acceptance check.

---

## 13. When You Change Things

Before modifying the foundation, re-read sections **§4 (Invariants)**
and the relevant subsystem section. Specifically:

- Touching `AtomicWriter` → re-verify I-02 and I-03 with `smoke-batch2`.
- Touching `FileWatcher` → re-verify I-04 (hash discriminator) and the
  revert pipeline.
- Touching token storage → re-verify I-06 (raw tokens never persisted).
- Touching the HTTP middleware → re-verify I-07 (`project_id` is
  derived from the token record, never from the payload).

Both smoke scripts should pass before any commit that changes these
files. If you change an invariant intentionally, document the new
invariant here and reference the commit.
