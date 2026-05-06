# 4. System Architecture


### 4.1  Component Responsibilities
| Component | Responsibility |
| --- | --- |
| MCP Server | Node.js daemon. Exclusive write path for agents. Owns the SQLite index. Runs the file watcher. Handles audit logging. Exposes stdio (local agents) and HTTP+SSE (remote agents and plugin Kanban board mutations). |
| SQLite Database | Persistent index stored at vault/.kanban/db.sqlite. Mirrors card frontmatter for fast queries. Source of truth remains the .md files — SQLite is a cache. Managed exclusively by MCP. |
| File Watcher | chokidar instance inside MCP. Monitors vault/.kanban-data/**/*.md. On any change: parses frontmatter, validates invariants, reconciles SQLite, reverts illegal field changes, writes audit log. |
| Obsidian Plugin | TypeScript plugin inside Obsidian Desktop. Renders the Kanban board by querying MCP (list/get). Translates board interactions (drag, create) into MCP HTTP calls over localhost. Uses Node.js HTTP APIs — therefore manifest.json must declare isDesktopOnly: true. All Obsidian API interactions follow the binding implementation standards defined in §11.6. |
| Vault (Filesystem) | .kanban-data/ folder hidden from Obsidian file explorer (dot-prefix). .md files are the source of truth. SQLite is derived from them and always reconcilable. |
| Audit Log | Append-only NDJSON at vault/.kanban/audit.ndjson. Written by MCP for every mutation of any origin. |

### 4.2  Write Path Diagram
| AGENT WRITES                         HUMAN WRITES     │                                     │     │  MCP stdio / HTTP+SSE               │  Two sub-paths:     │                                     ├─ Plugin board action     ▼                                     │   └─ HTTP POST → MCP ┌─────────────┐                           └─ Direct Obsidian edit │ MCP Server  │◄──────────────────────────────────────────────┐ │             │  (plugin board actions call MCP over HTTP)    │ └──────┬──────┘                                               │        │  validates + writes atomically                       │        ▼                                                       │   .md file  ──── chokidar detects all changes ───────────────►│        │                  │                         file watcher        │                  ▼                         reconciles        │          SQLite index update               and audits        │          + invariant check        │          + audit log entry        ▼   Audit Log |
| --- |

### 4.3  File Watcher Reconciliation Logic
The file watcher is the central safety mechanism for human direct edits. Its processing pipeline on every file change event:
| File change detected by chokidar   │   ├─ Is this change flagged as MCP-originated?   │   └─ YES → skip (already processed by MCP write path)   │   └─ NO (human direct edit or external sync)         │         ├─ Parse frontmatter         │   └─ FAIL → revert entire file to last good state         │            → log PARSE_ERROR         │         ├─ Compare immutable fields vs SQLite index         │   └─ ANY changed → revert those fields in file         │                  → log FIELD_REVERTED per field         │         ├─ Validate mutable fields (schema rules)         │   └─ INVALID (e.g. bad status) → revert invalid fields only         │                               → log FIELD_REVERTED         │         ├─ Increment version, set updated_at, updated_by='human:manager'         ├─ Write corrected file atomically (.tmp → rename)         ├─ Update SQLite index         └─ Log HUMAN_EDIT to audit log |
| --- |

### 4.4  SQLite vs .md Files — Relationship
| The .md files are the source of truth. SQLite is a derived, always-reconcilable cache.  If SQLite is deleted: MCP rebuilds it from .md files on next startup. If SQLite and .md diverge (e.g. after a crash mid-write): MCP resolves by trusting the .md file. SQLite is never written to without also writing (or having just written) the corresponding .md file. SQLite does not store card body text — only frontmatter fields needed for queries and the board render. |
| --- |

### 4.5  Vault Directory Structure
| vault/   .kanban-data/                    ← Hidden from Obsidian explorer (dot-prefix)     projeto-x/       _meta.json                   ← Project metadata, token hashes, column config       card-abc123.md       card-def456.md     projeto-y/       _meta.json       card-ghi789.md   .kanban/                         ← MCP internal data (hidden)     db.sqlite                      ← SQLite index     audit.ndjson                   ← Append-only audit log     idempotency.json               ← request_id deduplication store   (normal Obsidian notes here...)  ← User's vault, unaffected |
| --- |

