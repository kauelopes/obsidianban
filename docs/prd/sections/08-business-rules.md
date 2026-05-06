# 8. Business Rules


### 8.1  Authorization (Agent Writes)
- BR-01: Token authorization validated on every MCP tool call.
- BR-02: project_id from token cannot be overridden by request payload.
- BR-03: Cards in other projects return 404 (not 403).
- BR-04: Manager token is project-unscoped, never shared with agents.
- BR-05: Token revocation takes effect on next call.

### 8.2  Immutable Field Protection (File Watcher)
- BR-06: Agents write exclusively via MCP. No exceptions.
- BR-07: Humans may edit .md files directly. The file watcher is the enforcement layer for human edits.
- BR-08: If a human changes an immutable field (id, project, version, position, created_at, created_by), the file watcher reverts those specific fields to their SQLite-indexed values. Editable fields in the same save are preserved. A FIELD_REVERTED entry is written to the audit log per reverted field.
- BR-09: If frontmatter cannot be parsed (corrupted YAML), the watcher reverts the entire file to the last known good state from SQLite + the last stored body text. Logs PARSE_ERROR.
- BR-10: If a human sets an invalid value for a mutable field (e.g. a status not in columns), the watcher reverts that field only, preserving all other changes. Logs FIELD_REVERTED.

### 8.3  Field Validation
- BR-11: title: non-empty, max 200 chars.
- BR-12: status: must be present in project's columns array.
- BR-13: due_date: YYYY-MM-DD only. Invalid format reverted by watcher or rejected by MCP.
- BR-14: tags: max 20 items, max 50 chars per tag.
- BR-15: agent_notes: max 2000 chars.
- BR-16: Disallowed fields in MCP payload → 400 with disallowed_fields list.

### 8.4  SQLite Consistency
- BR-17: SQLite and .md files must agree on all frontmatter fields after every write.
- BR-18: On startup, MCP computes SHA-256 of each .md file and compares to file_hash in SQLite. Diverged files are re-parsed and SQLite is updated. Missing SQLite entries are created. Orphaned SQLite entries (no .md file) are deleted.
- BR-19: SQLite is never the authority on a conflict with .md files. .md file always wins.

