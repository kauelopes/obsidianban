# 13. Roadmap / Milestones


### Milestone 0 — Foundation (Week 1)
- Vault directory structure (.kanban-data/, .kanban/) established.
- SQLite schema created. Atomic writer: .md + SQLite in same logical operation.
- File watcher (chokidar) with 500ms debounce, immutable-field revert logic, FIELD_REVERTED logging.
- Startup reconciliation: hash-based divergence detection, SQLite rebuild path.
- Token provisioning CLI (create, revoke, list) with SHA-256 hashing.
- MCP server scaffold with auth middleware and idempotency store.

### Milestone 1 — Core MCP API (Week 2)
- All 6 tools: list (from SQLite), get (from .md), create, update, move, reorder.
- Field rejection (400) for disallowed fields.
- Full 409 conflict response with current_card and conflicting_fields.
- Idempotency via request_id.
- Complete audit log for all event types.

### Milestone 2 — Obsidian Plugin (Week 3)
- Dedicated test vault created for all plugin development (RULE-10 §11.6).
- manifest.json: isDesktopOnly: true, correct minAppVersion (RULE-01 §11.6).
- Kanban board render via MCP queries (SQLite-backed). Cards ordered by position.
- All board actions (drag, create) call MCP HTTP — zero direct file writes from plugin.
- All event listeners use registerEvent / registerDomEvent / registerInterval (RULE-02 §11.6).
- Vault reads use Vault.process(). Deletions use FileManager.trashFile() (RULE-03 §11.6).
- KanbanView never stored as a Plugin class field — retrieved on demand (RULE-04 §11.6).
- All CSS uses Obsidian CSS variables, scoped to .kanban-mcp-* classes (RULE-07 §11.6).
- Commands follow naming conventions: sentence case, no plugin prefix, no default hotkeys (RULE-08 §11.6).
- All interactive elements keyboard-accessible with aria-labels (RULE-09 §11.6).
- Frontmatter collapse + advisory banner on card files.
- Conflict overlay (409), error toasts (400/500), offline banner.
- Optimistic UI updates with rollback.

### Milestone 3 — Hardening (Week 4)
- External sync simulation tests (Syncthing write → watcher reconciliation → agent 409).
- Startup reconciliation stress test (1000+ cards, SQLite deleted).
- All acceptance tests (§14.3) passing.
- Agent integration guide: stdio + HTTP+SSE, request_id patterns, conflict handling.

### Future (Post V1)
- V2: Webhook event stream for polling-free agent workflows.
- V2: Card templates per project. Read-only agent token type.
- V3: Subtask support (parent_card_id). GitHub Issues bidirectional sync.

