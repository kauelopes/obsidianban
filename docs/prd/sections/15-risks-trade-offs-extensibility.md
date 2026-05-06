# 15. Risks, Trade-offs & Extensibility


### 15.1  Resolved Issues (vs v2.0)
| Issue | Status | Resolution |
| --- | --- | --- |
| Plugin must build custom card editor | RESOLVED | Human edits use Obsidian native editor. File watcher reconciles. |
| In-memory index lost on crash | RESOLVED | SQLite persists. Startup rebuilds from .md if corrupted. |
| O(n) startup scan always required | RESOLVED | Hash-based check skips unchanged files. Only diverged files re-parsed. |
| No query capabilities on index | RESOLVED | SQLite supports indexed queries. list_cards never reads .md files. |

### 15.2  Remaining Risks
| Risk | Detail & Mitigation |
| --- | --- |
| Watcher debounce data loss | If human edits body text and the file is reverted (due to frontmatter corruption) within the 500ms debounce window, body edits are lost. Mitigation: store last-known body text in SQLite for revert operations. |
| Obsidian 'file changed' prompt | When watcher rewrites a file the human has open, Obsidian shows a reload prompt. This is correct behavior but may be surprising. Mitigation: the advisory banner explains this. |
| SQLite file in vault | db.sqlite is inside the vault folder (under .kanban/). Some sync tools may try to sync it. Mitigation: add .kanban/ to Syncthing/Obsidian Sync ignore rules. Document this in setup guide. |
| better-sqlite3 build | better-sqlite3 requires a native Node.js addon. On some platforms (ARM, musl) it needs compilation. Mitigation: pre-built binaries are available for major platforms; document fallback to sql.js (pure JS, slower). |
| MCP single point of failure | Plugin is read-only when MCP is offline. Mitigation: systemd auto-restart, 5s health polling. |

### 15.3  Key Design Decisions
| Decision | Rationale |
| --- | --- |
| SQLite over in-memory index | Persistent, queryable, crash-safe. Zero external dependencies. Startup is O(changed files) not O(all files). Rebuilding from .md is always possible — no data is exclusive to SQLite. |
| File watcher reconciliation over edit prevention | Obsidian cannot practically prevent file edits. Reconciliation is resilient and transparent. Users get the full Obsidian editor experience with a safety net underneath. |
| Debounce at 500ms | Balances responsiveness against version inflation from rapid keystrokes. Configurable via env var WATCHER_DEBOUNCE_MS if needed. |
| Body text not in SQLite | Card body can be large Markdown. Storing it in SQLite would bloat the index without query benefit. get_card reads the .md file directly, which is acceptable for single-card fetches. |
| file_hash in SQLite | SHA-256 of .md content enables O(1) change detection per file during startup reconciliation, avoiding full YAML parse for unchanged files. |

### 15.4  Extensibility Points
- additionalProperties: true in JSON Schema — managers add custom fields freely. Watcher and MCP preserve unknown fields.
- columns array in _meta.json — custom workflow states require only a config edit.
- SQLite indexes — new query patterns (e.g. overdue cards, cards by owner) require only a new index, no schema migration.
- Audit log (NDJSON) — importable into any log aggregator. queryable with jq.
- WATCHER_DEBOUNCE_MS env var — tunable without code changes.
- better-sqlite3 / sql.js swap — pure JS fallback requires only changing the DB driver import.

— End of Document — PRD v3.0 —

