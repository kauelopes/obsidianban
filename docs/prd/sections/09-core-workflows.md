# 9. Core Workflows


### 9.1  Agent Creates a Card
- Agent calls kanban_create_card.
- MCP validates token, project scope, all field values.
- MCP checks idempotency store.
- MCP generates id, version=1, position, timestamps, created_by.
- Atomic write: .md file + SQLite transaction.
- Audit log: CREATE entry.
- Returns full card object.

```mermaid
sequenceDiagram
    participant Agent
    participant MCP
    participant MD as .md File
    participant DB as SQLite
    participant Audit as audit.ndjson

    Agent->>MCP: kanban_create_card(title, type, tokens, model, ...)
    MCP->>MCP: validate token + project scope
    MCP->>MCP: check idempotency store (request_id)
    MCP->>MCP: generate id, version=1, position, timestamps, created_by
    MCP->>MD: atomic write (.tmp → rename)
    MCP->>DB: INSERT card row + file_hash
    MCP->>Audit: append CREATE entry
    MCP-->>Agent: 201 full card object
```

### 9.2  Agent Updates a Card
- Agent reads card via kanban_get_card. Stores id and version.
- Agent calls kanban_update_card with id, version, target fields only.
- MCP checks idempotency store.
- MCP rejects disallowed fields → 400.
- MCP reads .md file. Version mismatch → 409 with current_card.
- MCP applies partial update, increments version, sets updated_at, updated_by.
- Atomic write: .md + SQLite. Audit log: UPDATE.

```mermaid
sequenceDiagram
    participant Agent
    participant MCP
    participant MD as .md File
    participant DB as SQLite
    participant Audit as audit.ndjson

    Agent->>MCP: kanban_get_card(id)
    MCP->>MD: read .md file (includes body)
    MD-->>MCP: full card content
    MCP-->>Agent: full card (version=N)

    Agent->>MCP: kanban_update_card(id, version=N, fields..., tokens, model)
    MCP->>MCP: check idempotency store
    MCP->>MCP: validate fields — disallowed? → 400
    MCP->>MD: read current .md (version check)

    alt version mismatch (file has version ≠ N)
        MCP-->>Agent: 409 Conflict (current_version, current_card)
        Agent->>Agent: merge changes onto current_card
        Agent->>MCP: retry with new version
    else version matches
        MCP->>MD: atomic write (version=N+1)
        MCP->>DB: UPDATE row + file_hash
        MCP->>Audit: append UPDATE entry
        MCP-->>Agent: 200 updated card (version=N+1)
    end
```

### 9.3  Human Edits Card Directly in Obsidian
- Human opens card .md file in Obsidian editor.
- Plugin shows frontmatter collapsed + advisory banner: 'Managed card — edit body freely. Frontmatter fields are auto-managed.'
- Human edits body text (and optionally mutable frontmatter fields). Saves.
- chokidar fires after 500ms debounce.
- File watcher parses frontmatter. Checks immutable fields against SQLite index.
- If immutable fields altered: reverts those fields. Logs FIELD_REVERTED per field.
- If invalid mutable values: reverts those fields. Logs FIELD_REVERTED.
- Increments version, sets updated_at='now', updated_by='human:manager'.
- Atomic rewrite of file + SQLite update. Audit log: HUMAN_EDIT.

```mermaid
sequenceDiagram
    participant Human
    participant Editor as Obsidian Editor
    participant FW as File Watcher
    participant MD as .md File
    participant DB as SQLite
    participant Audit as audit.ndjson

    Human->>Editor: open card .md (version=N)
    Note over Editor: shows advisory banner\nfrontmatter collapsed
    Human->>Editor: edit body / mutable fields
    Human->>Editor: save

    Editor->>MD: write file
    Note over FW: 500ms debounce
    MD-->>FW: change event (human edit)
    FW->>DB: read current state (version=N)
    FW->>FW: parse frontmatter
    FW->>FW: check immutable fields → revert if changed
    FW->>FW: validate mutable fields → revert invalid only
    FW->>FW: set version=N+1, updated_at=now, updated_by='human:manager'
    FW->>MD: atomic rewrite (.tmp → rename)
    FW->>DB: UPDATE row + file_hash
    FW->>Audit: append HUMAN_EDIT entry
```

### 9.4  Human Drags Card via Plugin Board
- Manager drags card from 'todo' to 'doing'.
- Plugin calls MCP HTTP: kanban_move_card { id, version (from kanban_list_cards MCP response), to_status: 'doing' }.
- MCP processes as a standard move_card: validates version, writes, logs MOVE.
- Plugin updates board from MCP response. No file watcher involvement (MCP-originated flag suppresses it).

### 9.5  Startup Reconciliation
- MCP opens SQLite. If no DB file: create schema, proceed to full scan.
- MCP scans all .md files in .kanban-data/.
- For each file: compute SHA-256. Compare to file_hash in SQLite.
- If hash matches: skip (no change since last run).
- If hash differs or entry missing: re-parse frontmatter, validate, update SQLite. Log RECONCILED.
- If SQLite has entry with no corresponding .md file: delete SQLite row. Log ORPHAN_REMOVED.
- MCP begins accepting connections.

```mermaid
flowchart TD
    START(["MCP startup"]) --> PTMP["delete orphaned .tmp files"]
    PTMP --> DBCHK{"db.sqlite\nexists?"}
    DBCHK -->|"no"| CREATE["create schema"]
    DBCHK -->|"yes"| SCAN
    CREATE --> SCAN["scan all .md files\nin .kanban-data/"]

    SCAN --> EACH["for each .md file"]
    EACH --> HASH["compute SHA-256"]
    HASH --> MATCH{"hash matches\nSQLite file_hash?"}
    MATCH -->|"yes"| NEXT
    MATCH -->|"no or missing"| REPARSE["re-parse frontmatter\nvalidate\nupdate SQLite + file_hash\nlog RECONCILED"]
    REPARSE --> NEXT

    NEXT{"more files?"}
    NEXT -->|"yes"| EACH
    NEXT -->|"no"| ORPHAN["for each SQLite row\nwith no .md file:\nDELETE row — log ORPHAN_REMOVED"]
    ORPHAN --> READY(["begin accepting connections"])
```

### 9.6  Concurrent Agent Write + Human Edit
- Agent reads card at version 5. Human also has card open in Obsidian.
- Agent writes first (MCP): version 5 → 6. .md file and SQLite updated.
- Human saves file. Watcher fires after debounce.
- Watcher reads file (which has version=5 from human's in-memory state, or version=6 if Obsidian re-read the file).
- Watcher checks: version in file vs SQLite (6). Regardless of which version is in file, watcher always sets version = current SQLite version + 1 = 7.
- Human's content edits are applied on top of the agent's write. Version → 7. Audit: HUMAN_EDIT.

```mermaid
sequenceDiagram
    participant Agent
    participant MCP
    participant FW as File Watcher
    participant MD as .md File
    participant DB as SQLite
    participant Audit as audit.ndjson

    Note over Agent,DB: Card at version 5. Agent and Human both have it open.

    Agent->>MCP: kanban_update_card(id, version=5, ...)
    MCP->>MCP: set MCP-originated flag
    MCP->>MD: atomic write → version 6
    MCP->>DB: UPDATE → version 6
    MCP->>MCP: clear MCP-originated flag
    MCP->>Audit: append UPDATE (version 6)
    MCP-->>Agent: 200 (version=6)

    MD-->>FW: chokidar event (MCP write)
    FW->>FW: MCP-originated? yes → skip

    Note over MD,FW: Human saves (may have version 5 or 6 in memory)
    MD-->>FW: chokidar event (human save) — 500ms debounce
    FW->>FW: MCP-originated? no → process
    FW->>DB: read current version (= 6)
    FW->>FW: apply human content edits\nset version = 6+1 = 7\nupdated_by = 'human:manager'
    FW->>MD: atomic rewrite → version 7
    FW->>DB: UPDATE → version 7
    FW->>Audit: append HUMAN_EDIT (version 7)

    Note over Agent,DB: Human's edits land on top of agent's write. No data lost.
```

